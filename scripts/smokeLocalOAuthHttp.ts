import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

import { authScopes } from "../src/auth/scopes.js";
import { redactSecrets } from "../src/safety/redaction.js";
import { fetchLocalHttpsJsonWithoutCertificateVerification } from "./localHttpsJsonFetch.js";
import {
  type LocalOAuthHttpSmokeResult,
  type LocalOAuthHttpSmokeRunOptions,
  localOAuthHttpUsage,
  oauthJwksUrl,
  oauthResource,
  parseLocalOAuthHttpArgs,
  withOAuthHttpPorts,
} from "./smokeLocalOAuthHttpCore.js";
import { assertExpectedTools } from "./smokeRemoteHttpCore.js";
import {
  authorizationServerDiscoveryCandidates,
  fetchOAuthAuthorizationServerDiscovery,
} from "./smokeRemoteOAuthHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

type SpawnedHttpServer = ChildProcessByStdio<null, Readable, Readable>;

const SMOKE_KEY_ID = "substack-mcp-local-oauth-smoke-key";
const execFileAsync = promisify(execFile);

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const parsed = parseLocalOAuthHttpArgs(args, env);
  if (parsed.help) {
    console.log(localOAuthHttpUsage());
    return;
  }

  const appPort = parsed.port === 0 ? await findAvailablePort() : parsed.port;
  const jwksPort =
    parsed.jwksPort === 0 ? await findAvailablePort() : parsed.jwksPort;
  const options = withOAuthHttpPorts(parsed, appPort, jwksPort);
  const result = await runLocalOAuthHttpSmoke(options);
  console.log(JSON.stringify(result, null, 2));
}

export async function runLocalOAuthHttpSmoke(
  options: LocalOAuthHttpSmokeRunOptions,
): Promise<LocalOAuthHttpSmokeResult> {
  const keyPair = await generateKeyPair("RS256");
  const publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: SMOKE_KEY_ID,
    alg: "RS256",
  } satisfies JWK;
  const certificate = await createTemporaryHttpsCertificate(options.jwksHost);
  const jwksServer = await startJwksServer(options, publicJwk, certificate);
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectOutput(child);

  try {
    const endpoint = new URL(options.mcpPath, baseUrl(options));
    const metadataUrl = new URL(
      "/.well-known/oauth-protected-resource",
      baseUrl(options),
    );

    await waitForHealth(new URL("/healthz", baseUrl(options)), child);
    await assertProtectedResourceMetadata(metadataUrl, options);
    const authorizationServer = await fetchOAuthAuthorizationServerDiscovery(
      [options.issuerUrl],
      fetchLocalHttpsJsonWithoutCertificateVerification,
    );
    await assertUnauthorized(endpoint, options);

    const token = await signAccessToken(options, keyPair.privateKey);
    const client = new Client({
      name: "substack-mcp-local-oauth-http-smoke",
      version: "0.1.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
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
        auth_mode: "oauth",
        endpoint: endpoint.toString(),
        protected_resource_metadata_url: metadataUrl.toString(),
        authorization_server_discovery_url: authorizationServer.discovery_url,
        jwks_url: oauthJwksUrl(options),
        issuer: options.issuerUrl,
        subject: options.subject,
        scopes: options.scopes,
        command: options.command,
        args: options.args,
        missing_bearer_status: 401,
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
    await Promise.all([
      stopChild(child),
      closeServer(jwksServer),
      certificate.cleanup(),
    ]);
  }
}

async function startJwksServer(
  options: LocalOAuthHttpSmokeRunOptions,
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
  options: LocalOAuthHttpSmokeRunOptions,
): Record<string, unknown> {
  return {
    issuer: options.issuerUrl,
    authorization_endpoint: `${options.issuerUrl}/authorize`,
    token_endpoint: `${options.issuerUrl}/token`,
    jwks_uri: oauthJwksUrl(options),
    grant_types_supported: ["authorization_code"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...authScopes],
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
  const directory = await mkdtemp(join(tmpdir(), "substack-mcp-oauth-smoke-"));
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
  options: LocalOAuthHttpSmokeRunOptions,
  privateKey: NonNullable<
    Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
  >,
): Promise<string> {
  return await new SignJWT({ scope: options.scopes.join(" ") })
    .setProtectedHeader({ alg: "RS256", kid: SMOKE_KEY_ID })
    .setIssuer(options.issuerUrl)
    .setAudience(oauthResource(options))
    .setSubject(options.subject)
    .setExpirationTime("10m")
    .sign(privateKey);
}

async function assertProtectedResourceMetadata(
  metadataUrl: URL,
  options: LocalOAuthHttpSmokeRunOptions,
): Promise<void> {
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(
      `Expected OAuth protected-resource metadata, got HTTP ${response.status}.`,
    );
  }

  const metadata = (await response.json()) as Record<string, unknown>;
  const authorizationServers = metadata.authorization_servers;
  const scopesSupported = metadata.scopes_supported;
  if (
    metadata.resource !== oauthResource(options) ||
    !Array.isArray(authorizationServers) ||
    authorizationServers[0] !== options.issuerUrl ||
    !Array.isArray(scopesSupported) ||
    !authScopes.every((scope) => scopesSupported.includes(scope))
  ) {
    throw new Error(
      "OAuth protected-resource metadata did not match smoke configuration.",
    );
  }
}

async function assertUnauthorized(
  endpoint: URL,
  options: LocalOAuthHttpSmokeRunOptions,
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
  if (
    response.status !== 401 ||
    !challenge.startsWith("Bearer ") ||
    !challenge.includes(
      `resource_metadata="${oauthResource(options)}/.well-known/oauth-protected-resource"`,
    )
  ) {
    throw new Error(
      `Expected OAuth rejection to return 401 with resource metadata challenge, got HTTP ${response.status}.`,
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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
  options: Pick<LocalOAuthHttpSmokeRunOptions, "host" | "port">,
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
