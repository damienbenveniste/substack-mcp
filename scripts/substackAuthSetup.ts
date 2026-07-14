import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  LOCAL_SUBSTACK_AUTH_FILE,
} from "../src/config.js";
import { normalizeSubstackSessionToken } from "../src/safety/substackSessionToken.js";
import { parseOptionalSubstackUserId } from "../src/safety/substackUserId.js";
import {
  SubstackAuthError,
  SubstackTimeoutError,
} from "../src/substack/errors.js";
import {
  type ValidatedSubstackSession,
  validateSubstackSession,
} from "../src/substack/sessionAuth.js";
import {
  type CapturedBrowserSession,
  captureSubstackBrowserSession,
  GuidedBrowserAuthError,
} from "./substackBrowserAuth.js";

const SETUP_HOST = "127.0.0.1";
const MAX_FORM_BYTES = 16_384;
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

interface SubstackAuthFileValues {
  readonly publicationUrl: string;
  readonly sessionToken: string;
  readonly userId: number;
  readonly previewTokenSecret: string;
}

export interface SubstackAuthSetupResult {
  readonly authFile: string;
  readonly publicationUrl: string;
  readonly userId: number;
}

export interface SubstackAuthSetupHandle {
  readonly url: string;
  readonly completion: Promise<SubstackAuthSetupResult>;
  close(): Promise<void>;
}

export interface StartSubstackAuthSetupOptions {
  readonly port?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly authFile?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly state?: string | undefined;
  readonly previewTokenSecret?: string | undefined;
  readonly initialPublicationUrl?: string | undefined;
  readonly validateSession?:
    | ((input: {
        readonly publicationUrl: string;
        readonly sessionToken: string;
        readonly userId: number;
        readonly userAgent: string;
        readonly requestTimeoutMs: number;
      }) => Promise<ValidatedSubstackSession>)
    | undefined;
  readonly captureBrowserSession?:
    | ((input: {
        readonly publicationUrl: string;
        readonly userAgent: string;
        readonly requestTimeoutMs: number;
        readonly timeoutMs: number;
        readonly signal: AbortSignal;
        readonly browserSource: "isolated" | "current_chrome";
      }) => Promise<CapturedBrowserSession>)
    | undefined;
  readonly persistAuth?:
    | ((path: string, values: SubstackAuthFileValues) => Promise<void>)
    | undefined;
}

export interface ParsedSubstackAuthSetupArgs {
  readonly help: boolean;
  readonly openBrowser: boolean;
  readonly port: number;
  readonly timeoutMs: number;
}

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const parsed = parseSubstackAuthSetupArgs(args);
  if (parsed.help) {
    console.log(substackAuthSetupUsage());
    return;
  }

  const handle = await startSubstackAuthSetup({
    port: parsed.port,
    timeoutMs: parsed.timeoutMs,
    userAgent: env.SUBSTACK_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    initialPublicationUrl: env.SUBSTACK_PUBLICATION_URL,
  });

  console.log(`Substack authentication URL: ${handle.url}`);
  if (parsed.openBrowser) {
    openSystemBrowser(handle.url);
  }

  const result = await handle.completion;
  console.log("Substack authentication saved.");
  console.log(`Publication: ${result.publicationUrl}`);
  console.log(`User ID: ${result.userId}`);
  console.log(`Auth file: ${result.authFile}`);
  console.log("Next: npm run mcp:preflight");
}

export async function startSubstackAuthSetup(
  options: StartSubstackAuthSetupOptions = {},
): Promise<SubstackAuthSetupHandle> {
  const port = normalizePort(options.port ?? 0);
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
    "setup timeout",
  );
  const requestTimeoutMs = normalizePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
    "Substack request timeout",
  );
  const authFile = resolve(options.authFile ?? LOCAL_SUBSTACK_AUTH_FILE);
  const userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
  const state = options.state ?? randomBytes(32).toString("base64url");
  const previewTokenSecret =
    options.previewTokenSecret ?? randomBytes(32).toString("base64url");
  const validateSession =
    options.validateSession ?? ((input) => validateSubstackSession(input));
  const captureBrowserSession =
    options.captureBrowserSession ??
    ((input) =>
      captureSubstackBrowserSession({
        ...input,
        validateSession,
      }));
  const persistAuth = options.persistAuth ?? writeSubstackAuthFile;
  const browserAuthAbort = new AbortController();

  let origin = "";
  let processing = false;
  let settled = false;
  let resolveCompletion: (value: SubstackAuthSetupResult) => void = () =>
    undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const completion = new Promise<SubstackAuthSetupResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const server = createServer((request, response) => {
    void handleSetupRequest(request, response, {
      authFile,
      initialPublicationUrl: options.initialPublicationUrl,
      origin,
      captureBrowserSession,
      persistAuth,
      previewTokenSecret,
      requestTimeoutMs,
      setupTimeoutMs: timeoutMs,
      browserAuthSignal: browserAuthAbort.signal,
      state,
      userAgent,
      validateSession,
      beginProcessing: () => {
        if (processing || settled) {
          return false;
        }
        processing = true;
        return true;
      },
      endProcessing: () => {
        processing = false;
      },
      complete: (result) => {
        if (settled) {
          return;
        }
        settled = true;
        response.once("finish", () => {
          clearTimeout(timeout);
          resolveCompletion(result);
          server.close();
        });
      },
    });
  });

  await listen(server, port);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    await closeServer(server);
    throw new Error("Could not determine the Substack authentication port.");
  }
  origin = `http://${SETUP_HOST}:${address.port}`;

  const timeout = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    browserAuthAbort.abort();
    server.close();
    rejectCompletion(new Error("Substack authentication setup timed out."));
  }, timeoutMs);
  timeout.unref?.();

  return {
    url: origin,
    completion,
    close: async () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        browserAuthAbort.abort();
        rejectCompletion(new Error("Substack authentication setup closed."));
      }
      await closeServer(server);
    },
  };
}

interface SetupRequestContext {
  readonly authFile: string;
  readonly initialPublicationUrl?: string | undefined;
  readonly origin: string;
  readonly captureBrowserSession: NonNullable<
    StartSubstackAuthSetupOptions["captureBrowserSession"]
  >;
  readonly persistAuth: (
    path: string,
    values: SubstackAuthFileValues,
  ) => Promise<void>;
  readonly previewTokenSecret: string;
  readonly requestTimeoutMs: number;
  readonly setupTimeoutMs: number;
  readonly browserAuthSignal: AbortSignal;
  readonly state: string;
  readonly userAgent: string;
  readonly validateSession: NonNullable<
    StartSubstackAuthSetupOptions["validateSession"]
  >;
  readonly beginProcessing: () => boolean;
  readonly endProcessing: () => void;
  readonly complete: (result: SubstackAuthSetupResult) => void;
}

async function handleSetupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: SetupRequestContext,
): Promise<void> {
  applySecurityHeaders(response);
  let submittedPublicationUrl = context.initialPublicationUrl;

  try {
    assertExpectedHost(request, context.origin);
    const requestUrl = new URL(request.url ?? "/", context.origin);
    if (requestUrl.pathname !== "/") {
      sendHtml(response, 404, renderMessagePage("Not found", "Not found."));
      return;
    }

    if (request.method === "GET") {
      sendHtml(
        response,
        200,
        renderSetupPage(context.state, context.initialPublicationUrl),
      );
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", "GET, POST");
      sendHtml(
        response,
        405,
        renderMessagePage("Method not allowed", "Method not allowed."),
      );
      return;
    }

    assertExpectedOrigin(request, context.origin);
    if (
      !request.headers["content-type"]
        ?.toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    ) {
      throw new SetupRequestError(415, "The setup form encoding was rejected.");
    }
    if (!context.beginProcessing()) {
      throw new SetupRequestError(
        409,
        "Authentication is already being processed.",
      );
    }

    try {
      const body = await readRequestBody(request);
      const form = new URLSearchParams(body);
      if (!constantTimeEqual(form.get("state") ?? "", context.state)) {
        throw new SetupRequestError(
          403,
          "The setup request state was rejected.",
        );
      }

      const publicationUrl = form.get("publicationUrl") ?? "";
      submittedPublicationUrl = publicationUrl;
      const mode = form.get("mode") ?? "manual";
      if (
        mode !== "current_chrome" &&
        mode !== "browser" &&
        mode !== "manual"
      ) {
        throw new SetupRequestError(400, "The setup method was rejected.");
      }

      let sessionToken: string;
      let validated: ValidatedSubstackSession;
      if (mode === "current_chrome" || mode === "browser") {
        const captured = await context.captureBrowserSession({
          publicationUrl,
          userAgent: context.userAgent,
          requestTimeoutMs: context.requestTimeoutMs,
          timeoutMs: context.setupTimeoutMs,
          signal: context.browserAuthSignal,
          browserSource:
            mode === "current_chrome" ? "current_chrome" : "isolated",
        });
        sessionToken = captured.sessionToken;
        validated = captured.validated;
      } else {
        const parsedSessionToken = parseSessionCookieInput(
          form.get("sessionToken") ?? undefined,
        );
        if (!parsedSessionToken) {
          throw new Error("SUBSTACK_SESSION_TOKEN is required.");
        }
        sessionToken = parsedSessionToken;
        const userId = parseOptionalSubstackUserId(
          form.get("userId") ?? undefined,
        );
        if (userId === undefined) {
          throw new Error("SUBSTACK_USER_ID is required.");
        }
        validated = await context.validateSession({
          publicationUrl,
          sessionToken,
          userId,
          userAgent: context.userAgent,
          requestTimeoutMs: context.requestTimeoutMs,
        });
      }
      await context.persistAuth(context.authFile, {
        publicationUrl: validated.publicationUrl,
        sessionToken,
        userId: validated.userId,
        previewTokenSecret: context.previewTokenSecret,
      });

      context.complete({
        authFile: context.authFile,
        publicationUrl: validated.publicationUrl,
        userId: validated.userId,
      });
      sendHtml(
        response,
        200,
        renderMessagePage(
          "Substack connected",
          "Authentication is saved locally. You can close this page.",
        ),
      );
    } catch (error) {
      context.endProcessing();
      throw error;
    }
  } catch (error) {
    const status = error instanceof SetupRequestError ? error.status : 400;
    sendHtml(
      response,
      status,
      renderSetupPage(
        context.state,
        submittedPublicationUrl,
        publicErrorMessage(error),
      ),
    );
  }
}

export async function writeSubstackAuthFile(
  path: string,
  values: SubstackAuthFileValues,
): Promise<void> {
  const target = resolve(path);
  const directory = dirname(target);
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const content = `${JSON.stringify(
    {
      SUBSTACK_PUBLICATION_URL: values.publicationUrl,
      SUBSTACK_SESSION_TOKEN: values.sessionToken,
      SUBSTACK_USER_ID: String(values.userId),
      PREVIEW_TOKEN_SECRET: values.previewTokenSecret,
    },
    null,
    2,
  )}\n`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temp, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export function parseSessionCookieInput(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const cookieText = trimmed.replace(/^cookie\s*:\s*/iu, "");
  const parts = cookieText.split(";");
  for (const name of ["connect.sid", "substack.sid"] as const) {
    for (const part of parts) {
      const separator = part.indexOf("=");
      if (separator < 0 || part.slice(0, separator).trim() !== name) {
        continue;
      }
      return normalizeSubstackSessionToken(part.slice(separator + 1));
    }
  }

  return normalizeSubstackSessionToken(trimmed);
}

export function parseSubstackAuthSetupArgs(
  args: readonly string[],
): ParsedSubstackAuthSetupArgs {
  let help = false;
  let openBrowser = true;
  let port = 0;
  let timeoutMs = DEFAULT_SETUP_TIMEOUT_MS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument === "--port") {
      port = normalizePort(readArgumentValue(args, ++index, "--port"));
      continue;
    }
    if (argument === "--timeout-seconds") {
      const seconds = normalizePositiveInteger(
        readArgumentValue(args, ++index, "--timeout-seconds"),
        "--timeout-seconds",
      );
      timeoutMs = seconds * 1000;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ""}`);
  }

  return { help, openBrowser, port, timeoutMs };
}

export function substackAuthSetupUsage(): string {
  return [
    "Usage: npm run auth:setup -- [--no-open] [--port <port>] [--timeout-seconds <seconds>]",
    "",
    "Starts a temporary loopback page, imports the Substack session from the current",
    "macOS Chrome profile after explicit confirmation, validates it locally, derives",
    "the user id, generates the preview secret, and saves private local auth. Isolated",
    "Chrome sign-in and manual cookie entry remain fallbacks; secrets are never CLI arguments.",
  ].join("\n");
}

function renderSetupPage(
  state: string,
  publicationUrl = "",
  error?: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Substack</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #f5f5f3; color: #20201e; }
    main { width: min(100% - 32px, 520px); margin: 10vh auto 0; }
    h1 { margin: 0 0 8px; font-size: 30px; font-weight: 650; letter-spacing: 0; }
    p { margin: 0 0 24px; color: #5d5d58; line-height: 1.5; }
    form { border: 1px solid #d8d8d2; background: #fff; padding: 24px; border-radius: 8px; }
    label { display: block; margin-bottom: 18px; font-size: 14px; font-weight: 600; }
    input { width: 100%; min-height: 42px; margin-top: 7px; border: 1px solid #b8b8b1; border-radius: 5px; padding: 9px 11px; font: inherit; }
    input:focus { outline: 3px solid #d6e9df; border-color: #277451; }
    button { width: 100%; min-height: 42px; border: 0; border-radius: 5px; background: #277451; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
    button:hover { background: #1f6043; }
    .error { border-left: 3px solid #b33a31; padding: 10px 12px; color: #7b241e; background: #fff3f1; }
    .note { margin-top: 16px; font-size: 13px; }
    .form-note { margin: -4px 0 18px; font-size: 13px; }
    details { margin-top: 18px; border-top: 1px solid #d8d8d2; padding-top: 18px; }
    summary { cursor: pointer; color: #4f4f4a; font-size: 14px; font-weight: 600; }
    details form { margin-top: 14px; background: transparent; padding: 0; border: 0; }
    details button { background: #4f4f4a; }
    details button:hover { background: #3e3e3a; }
  </style>
</head>
<body>
  <main>
    <h1>Connect Substack</h1>
    <p>Authenticate the local MCP server with the publication you use for drafts.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/" autocomplete="off">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="mode" value="current_chrome">
      <label>
        Publication URL
        <input type="url" name="publicationUrl" value="${escapeHtml(publicationUrl)}" placeholder="https://example.substack.com" required autofocus>
      </label>
      <p class="form-note">Uses the Substack session from your most recently used Chrome profile. A temporary local cookie-store copy is reduced to Substack domains and deleted after validation; Google cookies, history, passwords, and browsing data are not retained.</p>
      <button type="submit">Use current Chrome session</button>
    </form>
    <details>
      <summary>Sign in with a temporary Chrome window</summary>
      <form method="post" action="/" autocomplete="off">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <input type="hidden" name="mode" value="browser">
        <label>
          Publication URL
          <input type="url" name="publicationUrl" value="${escapeHtml(publicationUrl)}" placeholder="https://example.substack.com" required>
        </label>
        <p class="form-note">Opens an isolated Chrome profile and waits for a normal Substack email-code sign-in.</p>
        <button type="submit">Open temporary Chrome</button>
      </form>
    </details>
    <details>
      <summary>Use a session cookie manually</summary>
      <form method="post" action="/" autocomplete="off">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <input type="hidden" name="mode" value="manual">
        <label>
          Publication URL
          <input type="url" name="publicationUrl" value="${escapeHtml(publicationUrl)}" placeholder="https://example.substack.com" required>
        </label>
        <label>
          Cookie value or connect.sid pair
          <input type="password" name="sessionToken" required spellcheck="false" autocapitalize="none" autocomplete="off">
        </label>
        <label>
          Substack user ID
          <input type="number" name="userId" min="1" step="1" required inputmode="numeric">
        </label>
        <p class="form-note">Paste the value, <code>connect.sid=...</code>, or a Cookie header. It stays in this local setup process.</p>
        <button type="submit">Connect with cookie</button>
      </form>
    </details>
    <p class="note">Browser setup derives the user ID from the authenticated dashboard. The preview-signing secret is generated locally.</p>
  </main>
</body>
</html>`;
}

function renderMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f5f5f3; color: #20201e; }
    main { width: min(100% - 32px, 520px); margin: 14vh auto 0; }
    h1 { font-size: 30px; letter-spacing: 0; }
    p { color: #5d5d58; line-height: 1.5; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendHtml(
  response: ServerResponse,
  status: number,
  html: string,
): void {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_FORM_BYTES) {
      throw new SetupRequestError(413, "The setup form was too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertExpectedHost(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host) {
    throw new SetupRequestError(403, "The setup request host was rejected.");
  }
}

function assertExpectedOrigin(request: IncomingMessage, origin: string): void {
  if (request.headers.origin === origin) {
    return;
  }
  if (request.headers.origin === "null") {
    return;
  }
  throw new SetupRequestError(403, "The setup request origin was rejected.");
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof SetupRequestError) {
    return error.message;
  }
  if (error instanceof SubstackAuthError) {
    return "Substack rejected the session. Check the cookie value and publication URL.";
  }
  if (error instanceof SubstackTimeoutError) {
    return "Substack authentication timed out. Check the network and try again.";
  }
  if (error instanceof GuidedBrowserAuthError) {
    return error.message;
  }
  if (
    error instanceof Error &&
    (error.message.startsWith("SUBSTACK_") ||
      error.message.startsWith("Substack authentication response"))
  ) {
    return error.message;
  }
  return "Substack authentication could not be completed.";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePort(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("port must be an integer from 0 through 65535.");
  }
  return parsed;
}

function normalizePositiveInteger(
  value: string | number,
  name: string,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readArgumentValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function openSystemBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, SETUP_HOST, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

class SetupRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SetupRequestError";
  }
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
