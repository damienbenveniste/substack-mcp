import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium } from "playwright-core";

import { normalizePublicationUrl } from "../src/substack/auth.js";
import { SubstackAuthError } from "../src/substack/errors.js";
import type { ValidatedSubstackSession } from "../src/substack/sessionAuth.js";

const AUTH_COOKIE_NAMES = ["connect.sid", "substack.sid"] as const;
const COOKIE_RECHECK_MS = 1000;
const REVALIDATE_MS = 10_000;
const IMPORTED_COOKIE_LOAD_TIMEOUT_MS = 5000;
const IMPORTED_COOKIE_RECHECK_MS = 100;

export interface CapturedBrowserSession {
  readonly sessionToken: string;
  readonly validated: ValidatedSubstackSession;
}

export interface BrowserAuthCookie {
  readonly name: string;
  readonly value: string;
}

export interface BrowserAuthContext {
  open(url: string): Promise<void>;
  cookies(): Promise<readonly BrowserAuthCookie[]>;
  authenticatedUserId(): Promise<number | undefined>;
  close(): Promise<void>;
}

export interface BrowserAuthRuntime {
  launch(profileDirectory: string): Promise<BrowserAuthContext>;
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface CaptureSubstackBrowserSessionInput {
  readonly publicationUrl: string;
  readonly userAgent: string;
  readonly requestTimeoutMs: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly validateSession: (input: {
    readonly publicationUrl: string;
    readonly sessionToken: string;
    readonly userId: number;
    readonly userAgent: string;
    readonly requestTimeoutMs: number;
  }) => Promise<ValidatedSubstackSession>;
  readonly profileRoot?: string | undefined;
  readonly browserSource?: "isolated" | "current_chrome" | undefined;
  readonly chromeUserDataRoot?: string | undefined;
  readonly runtime?: BrowserAuthRuntime | undefined;
}

export class GuidedBrowserAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidedBrowserAuthError";
  }
}

/** Opens an isolated Chrome profile and captures its authenticated Substack session. */
export async function captureSubstackBrowserSession(
  input: CaptureSubstackBrowserSessionInput,
): Promise<CapturedBrowserSession> {
  const publicationUrl = normalizePublicationUrl(input.publicationUrl);
  const profileRoot = resolve(input.profileRoot ?? ".data");
  const browserSource = input.browserSource ?? "isolated";
  const runtime =
    input.runtime ??
    createDefaultBrowserAuthRuntime({
      browserSource,
      chromeUserDataRoot: input.chromeUserDataRoot,
      publicationUrl,
    });
  const deadline = runtime.now() + input.timeoutMs;
  let context: BrowserAuthContext | undefined;

  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const profileDirectory = await mkdtemp(
    join(profileRoot, "substack-auth-browser-"),
  );
  await chmod(profileDirectory, 0o700);

  try {
    try {
      context = await runtime.launch(profileDirectory);
    } catch (error) {
      if (error instanceof GuidedBrowserAuthError) {
        throw error;
      }
      throw new GuidedBrowserAuthError(
        browserSource === "current_chrome"
          ? "The current Chrome session could not be read. Use the temporary sign-in or manual cookie option instead."
          : "The guided Chrome sign-in window could not be opened. Use the manual cookie option instead.",
      );
    }

    try {
      await context.open(new URL("/publish/home", publicationUrl).href);
    } catch {
      throw new GuidedBrowserAuthError(
        "The Substack sign-in page could not be opened. Check the publication URL or use the manual cookie option.",
      );
    }

    const nextValidationAtByToken = new Map<string, number>();
    while (runtime.now() < deadline) {
      assertNotAborted(input.signal);
      let cookies: readonly BrowserAuthCookie[];
      try {
        cookies = await context.cookies();
      } catch {
        throw new GuidedBrowserAuthError(
          "The guided Chrome sign-in window was closed before authentication completed.",
        );
      }

      const now = runtime.now();
      const sessionTokens = findSessionCookieValues(cookies);
      const userId = await readAuthenticatedUserId(context);
      if (userId === undefined) {
        if (browserSource === "current_chrome" && sessionTokens.length > 0) {
          throw new GuidedBrowserAuthError(
            "The current Chrome profile is not signed in as a writer for this publication. Open its dashboard in normal Chrome, then retry.",
          );
        }
        await runtime.sleep(COOKIE_RECHECK_MS, input.signal);
        continue;
      }
      let rejectedCandidates = 0;
      for (const sessionToken of sessionTokens) {
        const nextValidationAt = nextValidationAtByToken.get(sessionToken) ?? 0;
        if (now < nextValidationAt) {
          continue;
        }
        nextValidationAtByToken.set(sessionToken, now + REVALIDATE_MS);
        try {
          const validated = await input.validateSession({
            publicationUrl,
            sessionToken,
            userId,
            userAgent: input.userAgent,
            requestTimeoutMs: input.requestTimeoutMs,
          });
          return { sessionToken, validated };
        } catch (error) {
          if (!(error instanceof SubstackAuthError)) {
            throw error;
          }
          rejectedCandidates += 1;
        }
      }

      if (
        browserSource === "current_chrome" &&
        sessionTokens.length > 0 &&
        rejectedCandidates === sessionTokens.length
      ) {
        throw new GuidedBrowserAuthError(
          "The current Chrome profile does not contain a Substack session accepted by this publication. Sign in to the publication in your normal Chrome window, then retry.",
        );
      }

      await runtime.sleep(COOKIE_RECHECK_MS, input.signal);
    }

    throw new GuidedBrowserAuthError(
      "Substack sign-in timed out. Run auth:setup again when you are ready to sign in.",
    );
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

export function findSessionCookieValues(
  cookies: readonly BrowserAuthCookie[],
): readonly string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const name of AUTH_COOKIE_NAMES) {
    for (const cookie of cookies) {
      const value = cookie.value.trim();
      if (cookie.name !== name || !value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

interface DefaultBrowserAuthRuntimeInput {
  readonly browserSource: "isolated" | "current_chrome";
  readonly chromeUserDataRoot?: string | undefined;
  readonly publicationUrl: string;
}

function createDefaultBrowserAuthRuntime(
  input: DefaultBrowserAuthRuntimeInput,
): BrowserAuthRuntime {
  return {
    async launch(profileDirectory) {
      if (input.browserSource === "current_chrome") {
        return launchCurrentChromeSession(
          profileDirectory,
          input.publicationUrl,
          input.chromeUserDataRoot,
        );
      }
      return launchIsolatedChromeSession(profileDirectory);
    },
    now: () => Date.now(),
    sleep: waitForAbortableDelay,
  };
}

async function launchIsolatedChromeSession(
  profileDirectory: string,
): Promise<BrowserAuthContext> {
  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  return wrapPlaywrightContext(context);
}

async function launchCurrentChromeSession(
  profileDirectory: string,
  publicationUrl: string,
  configuredChromeUserDataRoot: string | undefined,
): Promise<BrowserAuthContext> {
  const source = await resolveCurrentChromeProfile(
    configuredChromeUserDataRoot,
  );
  const targetCookieDatabase = join(
    profileDirectory,
    "Default",
    source.cookieDatabaseRelativePath,
  );
  await mkdir(dirname(targetCookieDatabase), { recursive: true, mode: 0o700 });
  await copyFile(source.cookieDatabase, targetCookieDatabase);
  await chmod(targetCookieDatabase, 0o600);

  const context = await chromium.launchPersistentContext(profileDirectory, {
    channel: "chrome",
    headless: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--profile-directory=Default",
    ],
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  });

  try {
    await context.setOffline(true);
    const retainedCookies = await waitForImportedSubstackCookies(
      context,
      publicationUrl,
    );
    if (findSessionCookieValues(retainedCookies).length === 0) {
      throw new GuidedBrowserAuthError(
        "No Substack session was found in the current Chrome profile. Sign in to the publication in normal Chrome, then retry.",
      );
    }
    await context.clearCookies();
    await context.addCookies(retainedCookies);
    await context.setOffline(false);
    return wrapPlaywrightContext(context);
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

interface CurrentChromeProfile {
  readonly cookieDatabase: string;
  readonly cookieDatabaseRelativePath: string;
}

async function resolveCurrentChromeProfile(
  configuredChromeUserDataRoot: string | undefined,
): Promise<CurrentChromeProfile> {
  if (process.platform !== "darwin" && !configuredChromeUserDataRoot) {
    throw new GuidedBrowserAuthError(
      "Current Chrome session import is available on macOS. Use the temporary sign-in or manual cookie option instead.",
    );
  }
  const chromeUserDataRoot = resolve(
    configuredChromeUserDataRoot ??
      join(homedir(), "Library", "Application Support", "Google", "Chrome"),
  );
  let localState: unknown;
  try {
    localState = JSON.parse(
      await readFile(join(chromeUserDataRoot, "Local State"), "utf8"),
    ) as unknown;
  } catch {
    throw new GuidedBrowserAuthError(
      "The current Chrome profile could not be identified. Use the temporary sign-in or manual cookie option instead.",
    );
  }
  const profileDirectoryName = readLastUsedChromeProfile(localState);
  const profileDirectory = resolve(chromeUserDataRoot, profileDirectoryName);
  if (
    profileDirectory === chromeUserDataRoot ||
    !profileDirectory.startsWith(`${chromeUserDataRoot}/`)
  ) {
    throw new GuidedBrowserAuthError(
      "The current Chrome profile path was rejected. Use the temporary sign-in or manual cookie option instead.",
    );
  }

  for (const relativePath of ["Cookies", join("Network", "Cookies")]) {
    const cookieDatabase = join(profileDirectory, relativePath);
    try {
      await access(cookieDatabase);
      return {
        cookieDatabase,
        cookieDatabaseRelativePath: relativePath,
      };
    } catch {
      // Chrome has used both cookie database locations across versions.
    }
  }
  throw new GuidedBrowserAuthError(
    "The current Chrome profile does not have a readable cookie store. Use the temporary sign-in or manual cookie option instead.",
  );
}

function readLastUsedChromeProfile(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GuidedBrowserAuthError(
      "The current Chrome profile metadata was invalid. Use the temporary sign-in or manual cookie option instead.",
    );
  }
  const profile = (value as Readonly<Record<string, unknown>>).profile;
  if (
    typeof profile !== "object" ||
    profile === null ||
    Array.isArray(profile)
  ) {
    throw new GuidedBrowserAuthError(
      "The current Chrome profile metadata was invalid. Use the temporary sign-in or manual cookie option instead.",
    );
  }
  const lastUsed = (profile as Readonly<Record<string, unknown>>).last_used;
  if (
    typeof lastUsed !== "string" ||
    !lastUsed.trim() ||
    lastUsed === "." ||
    lastUsed === ".."
  ) {
    throw new GuidedBrowserAuthError(
      "The current Chrome profile metadata was invalid. Use the temporary sign-in or manual cookie option instead.",
    );
  }
  return lastUsed;
}

function filterSubstackCookies<
  T extends BrowserAuthCookie & { readonly domain: string },
>(cookies: readonly T[], publicationUrl: string): T[] {
  const publicationHost = new URL(publicationUrl).hostname.toLowerCase();
  return cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
    return domain === "substack.com" || domain === publicationHost;
  });
}

async function waitForImportedSubstackCookies(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  publicationUrl: string,
): Promise<ReturnType<typeof filterSubstackCookies>> {
  const deadline = Date.now() + IMPORTED_COOKIE_LOAD_TIMEOUT_MS;
  let retainedCookies = filterSubstackCookies(
    await context.cookies(),
    publicationUrl,
  );
  while (
    findSessionCookieValues(retainedCookies).length === 0 &&
    Date.now() < deadline
  ) {
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, IMPORTED_COOKIE_RECHECK_MS),
    );
    retainedCookies = filterSubstackCookies(
      await context.cookies(),
      publicationUrl,
    );
  }
  return retainedCookies;
}

function wrapPlaywrightContext(
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
): BrowserAuthContext {
  let activePage = context.pages()[0];
  const getPage = async () => {
    activePage ??= await context.newPage();
    return activePage;
  };
  return {
    async open(url) {
      const page = await getPage();
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    },
    async cookies() {
      return context.cookies();
    },
    async authenticatedUserId() {
      const page = await getPage();
      return page.evaluate(readAuthenticatedDashboardUserId);
    },
    async close() {
      await context.close();
    },
  };
}

export function readAuthenticatedDashboardUserId(): number | undefined {
  const preloads = (globalThis as { _preloads?: unknown })._preloads;
  if (
    typeof preloads !== "object" ||
    preloads === null ||
    Array.isArray(preloads)
  ) {
    return undefined;
  }
  const user = (preloads as Readonly<Record<string, unknown>>).user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return undefined;
  }
  const id = (user as Readonly<Record<string, unknown>>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : undefined;
}

async function readAuthenticatedUserId(
  context: BrowserAuthContext,
): Promise<number | undefined> {
  try {
    return await context.authenticatedUserId();
  } catch {
    throw new GuidedBrowserAuthError(
      "The guided Chrome sign-in window was closed before authentication completed.",
    );
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GuidedBrowserAuthError(
      "The guided Substack sign-in was cancelled.",
    );
  }
}

export async function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(
        new GuidedBrowserAuthError(
          "The guided Substack sign-in was cancelled.",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
