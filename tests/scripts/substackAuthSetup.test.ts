import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  main,
  parseSessionCookieInput,
  parseSubstackAuthSetupArgs,
  type SubstackAuthSetupHandle,
  startSubstackAuthSetup,
  substackAuthSetupUsage,
  writeSubstackAuthFile,
} from "../../scripts/substackAuthSetup.js";
import {
  SubstackAuthError,
  SubstackTimeoutError,
} from "../../src/substack/errors.js";

const handles: SubstackAuthSetupHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    void handle.completion.catch(() => undefined);
    await handle.close().catch(() => undefined);
  }
});

describe("substackAuthSetup", () => {
  it("parses only non-secret setup arguments", () => {
    expect(
      parseSubstackAuthSetupArgs([
        "--no-open",
        "--port",
        "4321",
        "--timeout-seconds",
        "30",
      ]),
    ).toEqual({
      help: false,
      openBrowser: false,
      port: 4321,
      timeoutMs: 30_000,
    });
    expect(parseSubstackAuthSetupArgs(["--help"]).help).toBe(true);
    expect(parseSubstackAuthSetupArgs(["-h"]).help).toBe(true);
    expect(() =>
      parseSubstackAuthSetupArgs(["--session-token", "must-not-be-accepted"]),
    ).toThrow("Unknown argument: --session-token");
    expect(substackAuthSetupUsage()).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });

  it("rejects invalid and incomplete setup arguments", () => {
    for (const value of ["-1", "65536", "not-a-number"]) {
      expect(() => parseSubstackAuthSetupArgs(["--port", value])).toThrow(
        "port must be an integer from 0 through 65535.",
      );
    }
    expect(() =>
      parseSubstackAuthSetupArgs(["--timeout-seconds", "0"]),
    ).toThrow("--timeout-seconds must be a positive integer.");
    expect(() => parseSubstackAuthSetupArgs(["--port"])).toThrow(
      "--port requires a value.",
    );
    expect(() => parseSubstackAuthSetupArgs(["--port", "--no-open"])).toThrow(
      "--port requires a value.",
    );
    expect(() =>
      parseSubstackAuthSetupArgs([undefined as unknown as string]),
    ).toThrow("Unknown argument: ");
  });

  it("accepts practical manual cookie copy formats without weakening env parsing", () => {
    expect(parseSessionCookieInput("private-session")).toBe("private-session");
    expect(parseSessionCookieInput("connect.sid=private-session")).toBe(
      "private-session",
    );
    expect(
      parseSessionCookieInput(
        "Cookie: other=value; substack.sid=private-session; theme=dark",
      ),
    ).toBe("private-session");
    expect(parseSessionCookieInput(undefined)).toBeUndefined();
    expect(() => parseSessionCookieInput("other=value; theme=dark")).toThrow(
      "single cookie value",
    );
  });

  it("renders CLI help without starting a server", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await main(["--help"], {});

    expect(log).toHaveBeenCalledWith(substackAuthSetupUsage());
    log.mockRestore();
  });

  it("runs the no-open CLI flow without logging generated secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "substack-auth-main-"));
    const previousCwd = process.cwd();
    const nativeFetch = globalThis.fetch;
    let resolveSetupUrl: ((url: string) => void) | undefined;
    const setupUrl = new Promise<string>((resolve) => {
      resolveSetupUrl = resolve;
    });
    const log = vi.spyOn(console, "log").mockImplementation((value) => {
      if (
        typeof value === "string" &&
        value.startsWith("Substack authentication URL: ")
      ) {
        resolveSetupUrl?.(value.slice("Substack authentication URL: ".length));
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ id: 123 }), { status: 200 }),
      ),
    );

    try {
      process.chdir(root);
      const run = main(["--no-open", "--timeout-seconds", "30"], {
        SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
        SUBSTACK_USER_AGENT: "custom-agent",
      });
      const url = await setupUrl;
      const page = await nativeFetch(url);
      const html = await page.text();
      const state = html.match(/name="state" value="([^"]+)"/)?.[1];
      expect(state).toBeTruthy();

      const response = await nativeFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: url,
        },
        body: new URLSearchParams({
          state: state ?? "",
          publicationUrl: "https://example.substack.com",
          sessionToken: "private-session",
          userId: "123",
        }),
      });
      expect(response.status).toBe(200);
      await run;

      const output = log.mock.calls.flat().join("\n");
      expect(output).not.toContain("private-session");
      const auth = JSON.parse(
        await readFile(join(root, ".data", "substack-auth.json"), "utf8"),
      ) as Record<string, string>;
      expect(auth).toMatchObject({
        SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
        SUBSTACK_SESSION_TOKEN: "private-session",
        SUBSTACK_USER_ID: "123",
      });
      expect(auth.PREVIEW_TOKEN_SECRET).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    } finally {
      process.chdir(previousCwd);
      vi.unstubAllGlobals();
      log.mockRestore();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("starts with generated defaults and can close before authentication", async () => {
    const handle = await startSubstackAuthSetup();
    handles.push(handle);
    const completion = handle.completion.catch((error: unknown) => error);

    await handle.close();

    await expect(completion).resolves.toMatchObject({
      message: "Substack authentication setup closed.",
    });
  });

  it("rejects invalid server options", async () => {
    await expect(startSubstackAuthSetup({ timeoutMs: 0 })).rejects.toThrow(
      "setup timeout must be a positive integer.",
    );
    await expect(
      startSubstackAuthSetup({ requestTimeoutMs: 0 }),
    ).rejects.toThrow("Substack request timeout must be a positive integer.");
    await expect(startSubstackAuthSetup({ port: -1 })).rejects.toThrow(
      "port must be an integer from 0 through 65535.",
    );
  });

  it("writes the generated auth file atomically with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "substack-auth-"));
    const path = join(root, "nested", "auth.json");

    await writeSubstackAuthFile(path, {
      publicationUrl: "https://example.substack.com",
      sessionToken: "private-session",
      userId: 123,
      previewTokenSecret: "private-preview",
    });

    await expect(readFile(path, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
          SUBSTACK_SESSION_TOKEN: "private-session",
          SUBSTACK_USER_ID: "123",
          PREVIEW_TOKEN_SECRET: "private-preview",
        },
        null,
        2,
      )}\n`,
    );
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("serves a protected local form and saves authentication values", async () => {
    const validateSession = vi.fn(async (input) => {
      expect(input).toMatchObject({
        publicationUrl: "https://example.substack.com/p/editor",
        sessionToken: "private-session",
        userId: 123,
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
      });
      return {
        publicationUrl: "https://example.substack.com",
        userId: 123,
      };
    });
    const persistAuth = vi.fn(async () => undefined);
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      previewTokenSecret: "generated-preview",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      validateSession,
      persistAuth,
    });
    handles.push(handle);

    expect(handle.url).not.toContain("fixed-state");
    const formResponse = await fetch(handle.url);
    const form = await formResponse.text();
    expect(formResponse.status).toBe(200);
    expect(formResponse.headers.get("cache-control")).toBe("no-store");
    expect(formResponse.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    expect(formResponse.headers.get("referrer-policy")).toBe("same-origin");
    expect(form).toContain('name="state" value="fixed-state"');
    expect(form).toContain('name="mode" value="current_chrome"');
    expect(form).toContain('name="mode" value="browser"');
    expect(form).toContain("Use current Chrome session");
    expect(form).toContain("Sign in with a temporary Chrome window");
    expect(form).toContain("Use a session cookie manually");
    expect(form).toContain('type="password" name="sessionToken"');
    expect(form).toContain('type="number" name="userId"');

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: handle.url,
      },
      body: new URLSearchParams({
        state: "fixed-state",
        mode: "manual",
        publicationUrl: "https://example.substack.com/p/editor",
        sessionToken: "private-session",
        userId: "123",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Substack connected");
    await expect(handle.completion).resolves.toMatchObject({
      publicationUrl: "https://example.substack.com",
      userId: 123,
    });
    expect(validateSession).toHaveBeenCalledOnce();
    expect(persistAuth).toHaveBeenCalledWith(expect.any(String), {
      publicationUrl: "https://example.substack.com",
      sessionToken: "private-session",
      userId: 123,
      previewTokenSecret: "generated-preview",
    });
  });

  it("captures authentication through the guided browser flow", async () => {
    const captureBrowserSession = vi.fn(async (input) => {
      expect(input).toMatchObject({
        publicationUrl: "https://example.substack.com/p/editor",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        browserSource: "isolated",
      });
      expect(input.signal.aborted).toBe(false);
      return {
        sessionToken: "private-browser-session",
        validated: {
          publicationUrl: "https://example.substack.com",
          userId: 321,
        },
      };
    });
    const persistAuth = vi.fn(async () => undefined);
    const validateSession = vi.fn(async () => {
      throw new Error("manual validation should not run");
    });
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      previewTokenSecret: "generated-preview",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      captureBrowserSession,
      validateSession,
      persistAuth,
    });
    handles.push(handle);

    const response = await submitSetupForm(handle, {
      state: "fixed-state",
      mode: "browser",
      publicationUrl: "https://example.substack.com/p/editor",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Substack connected");
    await expect(handle.completion).resolves.toMatchObject({ userId: 321 });
    expect(captureBrowserSession).toHaveBeenCalledOnce();
    expect(validateSession).not.toHaveBeenCalled();
    expect(persistAuth).toHaveBeenCalledWith(expect.any(String), {
      publicationUrl: "https://example.substack.com",
      sessionToken: "private-browser-session",
      userId: 321,
      previewTokenSecret: "generated-preview",
    });
  });

  it("imports authentication from the current Chrome session", async () => {
    const captureBrowserSession = vi.fn(async (input) => {
      expect(input.browserSource).toBe("current_chrome");
      return {
        sessionToken: "private-browser-session",
        validated: {
          publicationUrl: "https://example.substack.com",
          userId: 321,
        },
      };
    });
    const persistAuth = vi.fn(async () => undefined);
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      previewTokenSecret: "generated-preview",
      timeoutMs: 30_000,
      captureBrowserSession,
      persistAuth,
    });
    handles.push(handle);

    const response = await submitSetupForm(handle, {
      state: "fixed-state",
      mode: "current_chrome",
      publicationUrl: "https://example.substack.com",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Substack connected");
    await expect(handle.completion).resolves.toMatchObject({ userId: 321 });
    expect(captureBrowserSession).toHaveBeenCalledOnce();
    expect(persistAuth).toHaveBeenCalledOnce();
  });

  it("accepts a null Origin only with same-origin browser navigation metadata", async () => {
    const validateSession = vi.fn(async () => {
      throw new SubstackAuthError("not authenticated");
    });
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession,
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "null",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
      body: new URLSearchParams(validSetupFields()),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Substack rejected the session.");
    expect(validateSession).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin and invalid-state submissions without exposing secrets", async () => {
    const validateSession = vi.fn(async () => {
      throw new Error("should not run");
    });
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession,
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const crossOrigin = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://attacker.example",
      },
      body: new URLSearchParams({
        state: "fixed-state",
        publicationUrl: "https://example.substack.com",
        sessionToken: "private-session",
      }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.text()).not.toContain("private-session");

    const invalidState = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: handle.url,
      },
      body: new URLSearchParams({
        state: "wrong-state",
        publicationUrl: "https://example.substack.com",
        sessionToken: "another-private-session",
      }),
    });
    expect(invalidState.status).toBe(403);
    expect(await invalidState.text()).not.toContain("another-private-session");
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("rejects unsupported local HTTP requests before authentication", async () => {
    const validateSession = vi.fn(async () => ({
      publicationUrl: "https://example.substack.com",
      userId: 123,
    }));
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession,
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const notFound = await fetch(`${handle.url}/missing`);
    expect(notFound.status).toBe(404);

    const method = await fetch(handle.url, { method: "PUT" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, POST");

    const wrongEncoding = await fetch(handle.url, {
      method: "POST",
      headers: { Origin: handle.url, "Content-Type": "text/plain" },
      body: "not-form-data",
    });
    expect(wrongEncoding.status).toBe(415);

    expect(await requestWithHost(handle.url, "attacker.example")).toBe(403);
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("rejects missing fields and oversized forms without retaining secrets", async () => {
    const validateSession = vi.fn(async (input) => {
      if (!input.publicationUrl) {
        throw new Error("SUBSTACK_PUBLICATION_URL is required.");
      }
      return {
        publicationUrl: "https://example.substack.com",
        userId: 123,
      };
    });
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession,
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const missingToken = await submitSetupForm(handle, {
      state: "fixed-state",
      publicationUrl: "https://example.substack.com",
    });
    expect(missingToken.status).toBe(400);
    expect(await missingToken.text()).toContain(
      "SUBSTACK_SESSION_TOKEN is required.",
    );

    const missingState = await submitSetupForm(handle, {
      publicationUrl: "https://example.substack.com",
      sessionToken: "private-session",
    });
    expect(missingState.status).toBe(403);

    const missingPublication = await submitSetupForm(handle, {
      state: "fixed-state",
      sessionToken: "private-session",
      userId: "123",
    });
    expect(missingPublication.status).toBe(400);
    expect(validateSession).toHaveBeenCalledWith(
      expect.objectContaining({ publicationUrl: "" }),
    );

    const oversized = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: handle.url,
      },
      body: `state=fixed-state&padding=${"x".repeat(17_000)}`,
    });
    expect(oversized.status).toBe(413);
    expect(validateSession).toHaveBeenCalledOnce();
  });

  it("rejects an invalid manual user id before validating the session", async () => {
    const validateSession = vi.fn();
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession,
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const response = await submitSetupForm(handle, {
      state: "fixed-state",
      mode: "manual",
      publicationUrl: "https://example.substack.com",
      sessionToken: "private-session",
      userId: "0",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "SUBSTACK_USER_ID must be a positive integer.",
    );
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("returns a conflict while an authentication request is in flight", async () => {
    let releaseValidation: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const validationReleased = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      previewTokenSecret: "generated-preview",
      timeoutMs: 30_000,
      validateSession: async () => {
        markStarted?.();
        await validationReleased;
        return {
          publicationUrl: "https://example.substack.com",
          userId: 123,
        };
      },
      persistAuth: async () => undefined,
    });
    handles.push(handle);

    const first = submitSetupForm(handle, validSetupFields());
    await started;
    const second = await submitSetupForm(handle, validSetupFields());
    expect(second.status).toBe(409);
    expect(await second.text()).toContain(
      "Authentication is already being processed.",
    );

    releaseValidation?.();
    expect((await first).status).toBe(200);
    await expect(handle.completion).resolves.toMatchObject({ userId: 123 });
  });

  it("renders known Substack authentication errors safely", async () => {
    const errors = [
      new SubstackAuthError("Substack authentication failed."),
      new SubstackTimeoutError("Substack request timed out."),
      new Error(
        "Substack authentication response did not include a positive numeric user id.",
      ),
    ];
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession: async () => {
        throw errors.shift();
      },
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const authFailure = await submitSetupForm(handle, validSetupFields());
    expect(await authFailure.text()).toContain(
      "Substack rejected the session.",
    );

    const timeout = await submitSetupForm(handle, validSetupFields());
    expect(await timeout.text()).toContain(
      "Substack authentication timed out.",
    );

    const missingId = await submitSetupForm(handle, validSetupFields());
    expect(await missingId.text()).toContain(
      "Substack authentication response did not include a positive numeric user id.",
    );
  });

  it("times out without a wall-clock delay under fake timers", async () => {
    vi.useFakeTimers();
    try {
      const handle = await startSubstackAuthSetup({ timeoutMs: 1000 });
      handles.push(handle);

      const completion = handle.completion.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(completion).resolves.toMatchObject({
        message: "Substack authentication setup timed out.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes validation errors rendered by the form", async () => {
    const sessionToken = "private-session";
    const handle = await startSubstackAuthSetup({
      state: "fixed-state",
      timeoutMs: 30_000,
      validateSession: async () => {
        throw new Error(`upstream echoed ${sessionToken}`);
      },
      persistAuth: async () => undefined,
    });
    handles.push(handle);
    void handle.completion.catch(() => undefined);

    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: handle.url,
      },
      body: new URLSearchParams({
        state: "fixed-state",
        publicationUrl: "https://example.substack.com",
        sessionToken,
        userId: "123",
      }),
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("Substack authentication could not be completed.");
    expect(html).not.toContain(sessionToken);
  });
});

function validSetupFields(): Record<string, string> {
  return {
    state: "fixed-state",
    publicationUrl: "https://example.substack.com",
    sessionToken: "private-session",
    userId: "123",
  };
}

function submitSetupForm(
  handle: SubstackAuthSetupHandle,
  fields: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(handle.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: handle.url,
    },
    body: new URLSearchParams(fields),
  });
}

function requestWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { headers: { Host: host } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}
