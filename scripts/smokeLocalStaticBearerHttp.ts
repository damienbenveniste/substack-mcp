import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { redactSecrets } from "../src/safety/redaction.js";
import {
  type LocalStaticBearerHttpSmokeResult,
  type LocalStaticBearerHttpSmokeRunOptions,
  localStaticBearerHttpUsage,
  parseLocalStaticBearerHttpArgs,
  withStaticBearerHttpPort,
} from "./smokeLocalStaticBearerHttpCore.js";
import { assertExpectedTools } from "./smokeRemoteHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

type SpawnedHttpServer = ChildProcessByStdio<null, Readable, Readable>;

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const parsed = parseLocalStaticBearerHttpArgs(args, env);
  if (parsed.help) {
    console.log(localStaticBearerHttpUsage());
    return;
  }

  const options =
    parsed.port === 0
      ? withStaticBearerHttpPort(parsed, await findAvailablePort())
      : parsed;
  const result = await runLocalStaticBearerHttpSmoke(options);
  console.log(JSON.stringify(result, null, 2));
}

export async function runLocalStaticBearerHttpSmoke(
  options: LocalStaticBearerHttpSmokeRunOptions,
): Promise<LocalStaticBearerHttpSmokeResult> {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);

  try {
    const endpoint = new URL(options.mcpPath, baseUrl(options));
    await waitForHealth(new URL("/healthz", baseUrl(options)), child);

    await assertUnauthorized(endpoint, undefined);
    await assertUnauthorized(endpoint, options.wrongBearerToken);

    const client = new Client({
      name: "substack-mcp-local-static-bearer-http-smoke",
      version: "0.1.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${options.bearerToken}`,
          },
        },
      });
      await client.connect(transport as unknown as Transport);
      const result = await client.listTools();
      const tools = result.tools.map((tool) => tool.name).sort();
      assertExpectedTools(tools);
      const validation = await assertValidateNewsletterContentTool(
        client,
        options.cwd,
      );
      const preview = await assertPreviewDraftTool(client, options.cwd);

      return {
        ok: true,
        transport: "http",
        auth_mode: "static_bearer",
        endpoint: endpoint.toString(),
        command: options.command,
        args: options.args,
        missing_bearer_status: 401,
        wrong_bearer_status: 401,
        tool_count: tools.length,
        tools,
        validation,
        preview,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    throw withServerOutput(error, output);
  } finally {
    await stopChild(child);
  }
}

async function assertUnauthorized(
  endpoint: URL,
  bearerToken: string | undefined,
): Promise<void> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });

  const challenge = response.headers.get("www-authenticate") ?? "";
  if (response.status !== 401 || !challenge.startsWith("Bearer ")) {
    throw new Error(
      `Expected static bearer rejection to return 401 with Bearer challenge, got HTTP ${response.status}.`,
    );
  }
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("Could not allocate a local TCP port.");
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHealth(
  healthUrl: URL,
  child: SpawnedHttpServer,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited before readiness: ${child.exitCode}`);
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for local HTTP server health check.");
}

interface CapturedOutput {
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
}

function collectOutput(child: SpawnedHttpServer): CapturedOutput {
  const output: CapturedOutput = {
    stdout: [],
    stderr: [],
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    output.stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    output.stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return output;
}

async function stopChild(child: SpawnedHttpServer): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited) {
    child.kill("SIGKILL");
  }
}

function withServerOutput(error: unknown, output: CapturedOutput): Error {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = redactOutput(output.stdout);
  const stderr = redactOutput(output.stderr);
  const sections = [
    message,
    stdout.trim() ? `Server stdout:\n${stdout}` : "",
    stderr.trim() ? `Server stderr:\n${stderr}` : "",
  ].filter(Boolean);

  return new Error(sections.join("\n"));
}

function redactOutput(chunks: readonly Buffer[]): string {
  return redactSecrets(Buffer.concat(chunks).toString("utf8"))
    .trim()
    .slice(0, 2000);
}

function baseUrl(
  options: Pick<LocalStaticBearerHttpSmokeRunOptions, "host" | "port">,
) {
  return `http://${options.host}:${options.port}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
