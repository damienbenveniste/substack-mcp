import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { loadLocalEnvFiles } from "../src/config.js";
import { redactSecrets } from "../src/safety/redaction.js";
import { holdOpenNgrokTunnel } from "./ngrokHoldOpen.js";
import { writeRemoteNoAuthEvidenceArtifact } from "./remoteNoAuthEvidence.js";
import {
  localBaseUrl,
  type NgrokNoAuthSmokeResult,
  type NgrokNoAuthSmokeRunOptions,
  ngrokArgsForPort,
  ngrokNoAuthUsage,
  parseNgrokNoAuthArgs,
  remoteMcpUrl,
  selectNgrokPublicUrl,
} from "./smokeNgrokNoAuthHttpCore.js";
import { assertRemoteHealth } from "./smokeRemoteHttpCore.js";
import { runRemoteNoAuthHttpSmoke } from "./smokeRemoteNoAuthHttp.js";

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  if (args.includes("--use-local-credentials")) {
    loadLocalEnvFiles();
  }
  const options = parseNgrokNoAuthArgs(args, env);
  if (options.help) {
    console.log(ngrokNoAuthUsage());
    return;
  }

  const result = await runNgrokNoAuthSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeRemoteNoAuthEvidenceArtifact({
    cwd: options.artifactRoot,
    artifact: options.evidenceArtifact,
    result: result.remote,
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

export async function runNgrokNoAuthSmoke(
  options: NgrokNoAuthSmokeRunOptions,
): Promise<NgrokNoAuthSmokeResult> {
  const server = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverOutput = collectOutput(server);
  let ngrok: ManagedChild | undefined;
  let ngrokOutput: CapturedOutput | undefined;

  try {
    const localHealthUrl = new URL("/healthz", localBaseUrl(options));
    const localHealth = await waitForHealth(localHealthUrl, server);
    const ngrokArgs = ngrokArgsForPort(options);
    ngrok = spawn(options.ngrokCommand, [...ngrokArgs], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ngrokOutput = collectOutput(ngrok);
    const publicUrl = await waitForNgrokPublicUrl(options, ngrok);
    const remoteUrl = remoteMcpUrl(publicUrl, options.mcpPath);
    const remote = await runRemoteNoAuthHttpSmoke({
      help: false,
      loadEnvFile: false,
      url: remoteUrl,
      artifactRoot: options.artifactRoot,
      evidenceArtifact: options.evidenceArtifact,
    });
    await holdOpenNgrokTunnel({
      endpoint: remoteUrl,
      seconds: options.holdOpenSeconds,
      auth: { mode: "noauth" },
    });

    return {
      ok: true,
      local: {
        endpoint: new URL(options.mcpPath, localBaseUrl(options)).toString(),
        health: localHealth,
        command: options.command,
        args: options.args,
      },
      ngrok: {
        command: options.ngrokCommand,
        args: ngrokArgs,
        api_url: options.ngrokApiUrl.toString(),
        public_url: publicUrl.toString(),
        hold_open_seconds: options.holdOpenSeconds,
      },
      remote,
    };
  } catch (error) {
    throw withChildOutput(error, [
      ["Server", serverOutput],
      ...(ngrokOutput ? ([["ngrok", ngrokOutput]] as const) : []),
    ]);
  } finally {
    if (ngrok) {
      await stopChild(ngrok);
    }
    await stopChild(server);
  }
}

async function waitForNgrokPublicUrl(
  options: NgrokNoAuthSmokeRunOptions,
  child: ManagedChild,
): Promise<URL> {
  const deadline = Date.now() + options.tunnelTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `ngrok exited before tunnel readiness: ${child.exitCode}`,
      );
    }

    try {
      const response = await fetch(options.ngrokApiUrl);
      if (response.ok) {
        const publicUrl = selectNgrokPublicUrl(
          (await response.json()) as unknown,
          options.port,
        );
        if (publicUrl) {
          return publicUrl;
        }
      } else {
        lastError = new Error(
          `ngrok API returned HTTP ${response.status} at ${options.ngrokApiUrl.toString()}.`,
        );
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for ngrok HTTPS tunnel.");
}

async function waitForHealth(
  healthUrl: URL,
  child: ManagedChild,
): Promise<NgrokNoAuthSmokeResult["local"]["health"]> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited before readiness: ${child.exitCode}`);
    }

    try {
      const health = await assertRemoteHealth(
        new URL("/mcp", healthUrl.origin),
      );
      return {
        url: health.url,
        status: health.status,
      };
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

function collectOutput(child: ManagedChild): CapturedOutput {
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

async function stopChild(child: ManagedChild): Promise<void> {
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

function withChildOutput(
  error: unknown,
  outputs: readonly (readonly [string, CapturedOutput])[],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sections = [message];
  for (const [label, output] of outputs) {
    const stdout = redactOutput(output.stdout);
    const stderr = redactOutput(output.stderr);
    if (stdout.trim()) {
      sections.push(`${label} stdout:\n${stdout}`);
    }
    if (stderr.trim()) {
      sections.push(`${label} stderr:\n${stderr}`);
    }
  }
  return new Error(sections.join("\n"));
}

function redactOutput(chunks: readonly Buffer[]): string {
  return redactSecrets(Buffer.concat(chunks).toString("utf8"))
    .trim()
    .slice(0, 2000);
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
