import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { redactSecrets } from "../src/safety/redaction.js";
import { writeLocalHttpEvidenceArtifact } from "./localHttpEvidence.js";
import {
  type LocalHttpInspectorResult,
  type LocalHttpSmokeResult,
  type LocalHttpSmokeRunOptions,
  localHttpUsage,
  parseLocalHttpArgs,
  withPort,
} from "./smokeLocalHttpCore.js";
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
  const parsed = parseLocalHttpArgs(args, env);
  if (parsed.help) {
    console.log(localHttpUsage());
    return;
  }

  const options =
    parsed.port === 0 ? withPort(parsed, await findAvailablePort()) : parsed;
  const result = await runLocalHttpSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeLocalHttpEvidenceArtifact({
    cwd: options.artifactRoot,
    artifact: options.evidenceArtifact,
    result,
  });
  console.log(
    JSON.stringify(
      {
        ...result,
        evidence_artifact: evidence.artifact,
      },
      null,
      2,
    ),
  );
}

export async function runLocalHttpSmoke(
  options: LocalHttpSmokeRunOptions,
): Promise<LocalHttpSmokeResult> {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);

  try {
    const endpoint = new URL(options.mcpPath, baseUrl(options));
    const health = await waitForHealth(
      new URL("/healthz", baseUrl(options)),
      child,
    );

    const client = new Client({
      name: "substack-mcp-local-http-smoke",
      version: "0.1.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(endpoint);
      await client.connect(transport as unknown as Transport);
      const result = await client.listTools();
      const tools = result.tools.map((tool) => tool.name).sort();
      assertExpectedTools(tools);
      const inspector = options.runInspectorCli
        ? await runInspectorCli(options, endpoint)
        : undefined;
      const validation = await assertValidateNewsletterContentTool(
        client,
        options.cwd,
      );
      const preview = await assertPreviewDraftTool(client, options.cwd);

      return {
        ok: true,
        transport: "http",
        endpoint: endpoint.toString(),
        health,
        command: options.command,
        args: options.args,
        tool_count: tools.length,
        tools,
        ...(inspector ? { inspector } : {}),
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

async function runInspectorCli(
  options: LocalHttpSmokeRunOptions,
  endpoint: URL,
): Promise<LocalHttpInspectorResult> {
  const args = [
    ...options.inspectorArgs,
    "--cli",
    endpoint.toString(),
    "--method",
    "tools/list",
    "--transport",
    "http",
  ];
  const child = spawn(options.inspectorCommand, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  const exitCode = await waitForExit(child);
  const stdout = redactSecrets(Buffer.concat(output.stdout).toString("utf8"));
  const stderr = redactOutput(output.stderr);

  if (exitCode !== 0) {
    throw new Error(
      [
        `MCP Inspector CLI exited with code ${exitCode}.`,
        stdout.trim()
          ? `Inspector stdout:\n${stdout.trim().slice(0, 2000)}`
          : "",
        stderr.trim() ? `Inspector stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const tools = parseInspectorTools(stdout).sort();
  assertExpectedTools(tools);
  return {
    ok: true,
    command: options.inspectorCommand,
    args,
    method: "tools/list",
    tool_count: tools.length,
    tools,
  };
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
): Promise<LocalHttpSmokeResult["health"]> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited before readiness: ${child.exitCode}`);
    }

    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return {
          url: healthUrl.toString(),
          status: response.status,
        };
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

async function waitForExit(child: SpawnedHttpServer): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
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

function parseInspectorTools(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Could not parse MCP Inspector CLI JSON output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error("MCP Inspector CLI output did not contain a tools array.");
  }

  return value.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      throw new Error(
        "MCP Inspector CLI output contained a tool without a string name.",
      );
    }
    return tool.name;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function redactOutput(chunks: readonly Buffer[]): string {
  return redactSecrets(Buffer.concat(chunks).toString("utf8"))
    .trim()
    .slice(0, 2000);
}

function baseUrl(options: Pick<LocalHttpSmokeRunOptions, "host" | "port">) {
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
