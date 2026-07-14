import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import { redactSecrets } from "../src/safety/redaction.js";
import { fetchLocalHttpsJsonWithoutCertificateVerification } from "./localHttpsJsonFetch.js";
import { writeRemoteOAuthEvidenceArtifact } from "./remoteOAuthEvidence.js";
import {
  localBaseUrl,
  ngrokArgsForPort,
  remoteMcpUrl,
  selectNgrokPublicUrl,
} from "./smokeNgrokNoAuthHttpCore.js";
import {
  type NgrokOAuthSmokeResult,
  type NgrokOAuthSmokeRunOptions,
  ngrokOAuthChildEnv,
  ngrokOAuthJwksUrl,
  ngrokOAuthUsage,
  parseNgrokOAuthArgs,
  withNgrokOAuthJwksPort,
} from "./smokeNgrokOAuthHttpCore.js";
import { assertRemoteHealth } from "./smokeRemoteHttpCore.js";
import { runRemoteOAuthHttpSmoke } from "./smokeRemoteOAuthHttp.js";
import {
  authorizationServerDiscoveryCandidates,
  protectedResourceMetadataUrl,
  summarizeOAuthMetadata,
} from "./smokeRemoteOAuthHttpCore.js";

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

const SMOKE_KEY_ID = "substack-mcp-ngrok-oauth-smoke-key";
const execFileAsync = promisify(execFile);

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const parsed = parseNgrokOAuthArgs(args, env);
  if (parsed.help) {
    console.log(ngrokOAuthUsage());
    return;
  }

  const jwksPort =
    parsed.jwksPort === 0 ? await findAvailablePort() : parsed.jwksPort;
  const options = withNgrokOAuthJwksPort(parsed, jwksPort);
  const result = await runNgrokOAuthSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeRemoteOAuthEvidenceArtifact({
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

export async function runNgrokOAuthSmoke(
  options: NgrokOAuthSmokeRunOptions,
): Promise<NgrokOAuthSmokeResult> {
  const keyPair = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: SMOKE_KEY_ID,
    alg: "RS256",
  } satisfies JWK;
  const certificate = await createTemporaryHttpsCertificate(options.jwksHost);
  const jwksServer = await startJwksServer(options, publicJwk, certificate);
  const ngrokArgs = ngrokArgsForPort(options);
  const ngrok = spawn(options.ngrokCommand, [...ngrokArgs], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ngrokOutput = collectOutput(ngrok);
  let server: ManagedChild | undefined;
  let serverOutput: CapturedOutput | undefined;

  try {
    const publicUrl = await waitForNgrokPublicUrl(options, ngrok);
    const serverEnv = ngrokOAuthChildEnv(options, publicUrl);
    server = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverOutput = collectOutput(server);

    const localHealthUrl = new URL("/healthz", localBaseUrl(options));
    const localHealth = await waitForHealth(localHealthUrl, server);
    const remoteUrl = remoteMcpUrl(publicUrl, options.mcpPath);

    await assertRemoteUnauthorized(remoteUrl, publicUrl.origin);
    const token = await signAccessToken(
      options,
      publicUrl.origin,
      keyPair.privateKey,
    );
    const remote = await runRemoteOAuthHttpSmoke({
      help: false,
      loadEnvFile: false,
      url: remoteUrl,
      bearerToken: token,
      bearerTokenEnvName: "generated-ngrok-oauth-smoke-token",
      artifactRoot: options.artifactRoot,
      evidenceArtifact: options.evidenceArtifact,
      discoveryFetch: fetchLocalHttpsJsonWithoutCertificateVerification,
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
      },
      jwks_url: ngrokOAuthJwksUrl(options),
      issuer: options.issuerUrl,
      subject: options.subject,
      scopes: options.scopes,
      missing_bearer_status: 401,
      remote,
    };
  } catch (error) {
    throw withChildOutput(error, [
      ["ngrok", ngrokOutput],
      ...(serverOutput ? ([["Server", serverOutput]] as const) : []),
    ]);
  } finally {
    await Promise.all([
      server ? stopChild(server) : Promise.resolve(),
      stopChild(ngrok),
      closeServer(jwksServer),
      certificate.cleanup(),
    ]);
  }
}

async function startJwksServer(
  options: NgrokOAuthSmokeRunOptions,
  publicJwk: JWK,
  certificate: TemporaryHttpsCertificate,
): Promise<Server> {
  const server = createHttpsServer(
    {
      key: certificate.key,
      cert: certificate.cert,
    },
    (request, response) => {
      const url = new URL(
        request.url ?? "/",
        `https://${request.headers.host ?? "localhost"}`,
      );
      if (request.method === "GET" && url.pathname === options.jwksPath) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }

      if (
        request.method === "GET" &&
        discoveryPaths(options.issuerUrl).includes(url.pathname)
      ) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(authorizationServerDiscoveryMetadata(options)));
        return;
      }

      response.writeHead(404).end("Not Found");
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.jwksPort, options.jwksHost, resolve);
  });
  return server;
}

function authorizationServerDiscoveryMetadata(
  options: NgrokOAuthSmokeRunOptions,
): Record<string, unknown> {
  return {
    issuer: options.issuerUrl,
    authorization_endpoint: `${options.issuerUrl}/authorize`,
    token_endpoint: `${options.issuerUrl}/token`,
    jwks_uri: ngrokOAuthJwksUrl(options),
    grant_types_supported: ["authorization_code"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...options.scopes],
  };
}

function discoveryPaths(issuerUrl: string): readonly string[] {
  return authorizationServerDiscoveryCandidates(issuerUrl).map(
    (candidate) => candidate.url.pathname,
  );
}

interface TemporaryHttpsCertificate {
  readonly key: string;
  readonly cert: string;
  readonly cleanup: () => Promise<void>;
}

async function createTemporaryHttpsCertificate(
  host: string,
): Promise<TemporaryHttpsCertificate> {
  const directory = await mkdtemp(join(tmpdir(), "substack-mcp-ngrok-oauth-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");

  await execFileAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=${subjectAltName(host)}`,
    ],
    { timeout: 10_000 },
  );

  return {
    key: await readFile(keyPath, "utf8"),
    cert: await readFile(certPath, "utf8"),
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function subjectAltName(host: string): string {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    ? `IP:${host},DNS:localhost`
    : `DNS:${host}`;
}

async function signAccessToken(
  options: NgrokOAuthSmokeRunOptions,
  resource: string,
  privateKey: NonNullable<
    Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
  >,
): Promise<string> {
  return await new SignJWT({ scope: options.scopes.join(" ") })
    .setProtectedHeader({ alg: "RS256", kid: SMOKE_KEY_ID })
    .setIssuer(options.issuerUrl)
    .setAudience(resource)
    .setSubject(options.subject)
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function waitForNgrokPublicUrl(
  options: NgrokOAuthSmokeRunOptions,
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
): Promise<NgrokOAuthSmokeResult["local"]["health"]> {
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

async function assertRemoteUnauthorized(
  endpoint: URL,
  expectedResource: string,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  const challenge = response.headers.get("www-authenticate") ?? "";
  const metadataUrl = protectedResourceMetadataUrl(endpoint);
  if (
    response.status !== 401 ||
    !challenge.startsWith("Bearer ") ||
    !challenge.includes(`resource_metadata="${metadataUrl.toString()}"`)
  ) {
    throw new Error(
      `Expected remote OAuth rejection to return 401 with resource metadata challenge, got HTTP ${response.status}.`,
    );
  }

  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) {
    throw new Error(
      `OAuth protected-resource metadata returned HTTP ${metadataResponse.status}.`,
    );
  }
  summarizeOAuthMetadata(await metadataResponse.json(), expectedResource);
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
