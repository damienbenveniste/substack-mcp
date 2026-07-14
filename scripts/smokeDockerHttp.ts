import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { redactSecrets } from "../src/safety/redaction.js";
import {
  type DockerHttpSmokeResult,
  type DockerHttpSmokeRunOptions,
  dockerBuildArgs,
  dockerHttpUsage,
  dockerRunArgs,
  parseDockerHttpArgs,
  withDockerPort,
} from "./smokeDockerHttpCore.js";
import { assertExpectedTools } from "./smokeRemoteHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const parsed = parseDockerHttpArgs(args, env);
  if (parsed.help) {
    console.log(dockerHttpUsage());
    return;
  }

  const options =
    parsed.port === 0
      ? withDockerPort(parsed, await findAvailablePort())
      : parsed;
  const result = await runDockerHttpSmoke(options);
  console.log(JSON.stringify(result, null, 2));
}

export async function runDockerHttpSmoke(
  options: DockerHttpSmokeRunOptions,
): Promise<DockerHttpSmokeResult> {
  if (options.build) {
    await runCommand(
      options.dockerCommand,
      dockerBuildArgs(options),
      options.cwd,
      180_000,
    );
  }

  const containerName = makeContainerName();
  const endpoint = new URL(options.mcpPath, baseUrl(options));
  let containerStarted = false;

  try {
    await runCommand(
      options.dockerCommand,
      dockerRunArgs(options, containerName),
      options.cwd,
      30_000,
    );
    containerStarted = true;

    await waitForHealth(new URL("/healthz", baseUrl(options)));

    const client = new Client({
      name: "substack-mcp-docker-http-smoke",
      version: "0.1.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(endpoint);
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
        transport: "docker-http",
        endpoint: endpoint.toString(),
        image: options.image,
        host_port: options.port,
        container_port: options.containerPort,
        tool_count: tools.length,
        tools,
        validation,
        preview,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    throw containerStarted
      ? await withContainerLogs(error, options, containerName)
      : toError(error);
  } finally {
    if (containerStarted) {
      await stopContainer(options, containerName);
    }
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

async function waitForHealth(healthUrl: URL): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
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
    : new Error("Timed out waiting for Docker HTTP server health check.");
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        stdout: redactOutput(stdout),
        stderr: redactOutput(stderr),
      };
      if (code === 0 && !timedOut) {
        resolve(result);
        return;
      }

      reject(
        commandError(
          command,
          args,
          timedOut
            ? `timed out after ${timeoutMs}ms`
            : `exited with ${code ?? signal ?? "unknown status"}`,
          result,
        ),
      );
    });
  });
}

async function withContainerLogs(
  error: unknown,
  options: DockerHttpSmokeRunOptions,
  containerName: string,
): Promise<Error> {
  const logs = await runCommand(
    options.dockerCommand,
    ["logs", containerName],
    options.cwd,
    10_000,
  ).catch((logError) => ({
    stdout: "",
    stderr: toError(logError).message,
  }));
  const message = toError(error).message;
  const sections = [
    message,
    logs.stdout.trim() ? `Container stdout:\n${logs.stdout}` : "",
    logs.stderr.trim() ? `Container stderr:\n${logs.stderr}` : "",
  ].filter(Boolean);

  return new Error(sections.join("\n"));
}

async function stopContainer(
  options: DockerHttpSmokeRunOptions,
  containerName: string,
): Promise<void> {
  await runCommand(
    options.dockerCommand,
    ["stop", "--time", "2", containerName],
    options.cwd,
    10_000,
  ).catch(() => undefined);
}

function commandError(
  command: string,
  args: readonly string[],
  status: string,
  result: CommandResult,
): Error {
  const sections = [
    `${command} ${redactSecrets(args.join(" "))} ${status}.`,
    result.stdout.trim() ? `stdout:\n${result.stdout}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr}` : "",
  ].filter(Boolean);
  return new Error(sections.join("\n"));
}

function redactOutput(chunks: readonly Buffer[]): string {
  return redactSecrets(Buffer.concat(chunks).toString("utf8"))
    .trim()
    .slice(-4000);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function makeContainerName(): string {
  return `substack-mcp-smoke-${process.pid}-${Date.now()}`;
}

function baseUrl(options: Pick<DockerHttpSmokeRunOptions, "host" | "port">) {
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
