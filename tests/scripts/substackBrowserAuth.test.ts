import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const playwright = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: {
    launchPersistentContext: playwright.launchPersistentContext,
  },
}));

import {
  type BrowserAuthContext,
  type BrowserAuthRuntime,
  captureSubstackBrowserSession,
  findSessionCookieValues,
  readAuthenticatedDashboardUserId,
  waitForAbortableDelay,
} from "../../scripts/substackBrowserAuth.js";
import { SubstackAuthError } from "../../src/substack/errors.js";

const roots: string[] = [];

afterEach(async () => {
  playwright.launchPersistentContext.mockReset();
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("substackBrowserAuth", () => {
  it("captures and validates an authenticated cookie in an isolated profile", async () => {
    const root = await temporaryRoot();
    const opened: string[] = [];
    const close = vi.fn(async () => undefined);
    const runtime = createRuntime({
      open: async (url) => {
        opened.push(url);
      },
      cookies: async () => [{ name: "connect.sid", value: "private-session" }],
      close,
    });
    const validateSession = vi.fn(async () => ({
      publicationUrl: "https://example.substack.com",
      userId: 123,
    }));

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com/p/editor",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
      runtime,
    });

    expect(result).toEqual({
      sessionToken: "private-session",
      validated: {
        publicationUrl: "https://example.substack.com",
        userId: 123,
      },
    });
    expect(opened).toEqual(["https://example.substack.com/publish/home"]);
    expect(validateSession).toHaveBeenCalledWith({
      publicationUrl: "https://example.substack.com",
      sessionToken: "private-session",
      userId: 123,
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it("waits for an authenticated replacement when the first cookie is anonymous", async () => {
    const root = await temporaryRoot();
    let cookieReads = 0;
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => {
        cookieReads += 1;
        return [
          {
            name: "connect.sid",
            value: cookieReads === 1 ? "anonymous-session" : "private-session",
          },
        ];
      },
      close: async () => undefined,
    });
    const validateSession = vi
      .fn()
      .mockRejectedValueOnce(new SubstackAuthError("not signed in"))
      .mockResolvedValueOnce({
        publicationUrl: "https://example.substack.com",
        userId: 123,
      });

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
      runtime,
    });

    expect(result.sessionToken).toBe("private-session");
    expect(validateSession).toHaveBeenCalledTimes(2);
  });

  it("falls back to substack.sid when the publication connect.sid is rejected", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [
        { name: "connect.sid", value: "custom-domain-session" },
        { name: "substack.sid", value: "authenticated-session" },
      ],
      close: async () => undefined,
    });
    const validateSession = vi.fn(async ({ sessionToken }) => {
      if (sessionToken !== "authenticated-session") {
        throw new SubstackAuthError("not signed in");
      }
      return {
        publicationUrl: "https://newsletter.example.com",
        userId: 123,
      };
    });

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://newsletter.example.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
      runtime,
    });

    expect(result.sessionToken).toBe("authenticated-session");
    expect(validateSession).toHaveBeenCalledTimes(2);
  });

  it("tries the next distinct session candidate after an auth rejection", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [
        { name: "connect.sid", value: "rejected-session" },
        { name: "substack.sid", value: "authenticated-session" },
      ],
      close: async () => undefined,
    });
    const validateSession = vi
      .fn()
      .mockRejectedValueOnce(new SubstackAuthError("not signed in"))
      .mockResolvedValueOnce({
        publicationUrl: "https://example.substack.com",
        userId: 123,
      });

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
      runtime,
    });

    expect(result.sessionToken).toBe("authenticated-session");
    expect(validateSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionToken: "rejected-session" }),
    );
    expect(validateSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionToken: "authenticated-session" }),
    );
  });

  it("fails current-session import immediately when all copied candidates are rejected", async () => {
    const root = await temporaryRoot();
    const cookies = vi.fn(async () => [
      { name: "substack.sid", value: "rejected-session" },
    ]);
    const runtime = createRuntime({
      open: async () => undefined,
      cookies,
      close: async () => undefined,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new SubstackAuthError("not signed in");
        },
        browserSource: "current_chrome",
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The current Chrome profile does not contain a Substack session accepted by this publication.",
    );
    expect(cookies).toHaveBeenCalledOnce();
  });

  it("rejects a copied session that is not signed in to the publication dashboard", async () => {
    const root = await temporaryRoot();
    const validateSession = vi.fn();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [
        { name: "connect.sid", value: "publication-session" },
      ],
      authenticatedUserId: async () => undefined,
      close: async () => undefined,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession,
        browserSource: "current_chrome",
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The current Chrome profile is not signed in as a writer for this publication.",
    );
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("waits for dashboard identity during an isolated sign-in", async () => {
    const root = await temporaryRoot();
    let identityReads = 0;
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [
        { name: "connect.sid", value: "publication-session" },
      ],
      authenticatedUserId: async () => {
        identityReads += 1;
        return identityReads === 1 ? undefined : 123;
      },
      close: async () => undefined,
    });

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession: async (input) => ({
        publicationUrl: input.publicationUrl,
        userId: input.userId,
      }),
      profileRoot: root,
      runtime,
    });

    expect(result.validated.userId).toBe(123);
    expect(identityReads).toBe(2);
  });

  it("reports a closed browser when dashboard identity cannot be read", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [
        { name: "connect.sid", value: "publication-session" },
      ],
      authenticatedUserId: async () => {
        throw new Error("page closed");
      },
      close: async () => undefined,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The guided Chrome sign-in window was closed before authentication completed.",
    );
  });

  it("reports a safe fallback when Chrome cannot launch and removes the profile", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime(undefined, async () => {
      throw new Error("private launch details");
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The guided Chrome sign-in window could not be opened. Use the manual cookie option instead.",
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a current-session fallback when copied Chrome cannot launch", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime(undefined, async () => {
      throw new Error("private launch details");
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The current Chrome session could not be read. Use the temporary sign-in or manual cookie option instead.",
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a safe fallback when the Substack page cannot open", async () => {
    const root = await temporaryRoot();
    const close = vi.fn(async () => undefined);
    const runtime = createRuntime({
      open: async () => {
        throw new Error("private navigation details");
      },
      cookies: async () => [],
      close,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The Substack sign-in page could not be opened. Check the publication URL or use the manual cookie option.",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it("reports when the browser closes before a session is captured", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => {
        throw new Error("browser closed");
      },
      close: async () => undefined,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "The guided Chrome sign-in window was closed before authentication completed.",
    );
  });

  it("times out when no authenticated cookie appears", async () => {
    const root = await temporaryRoot();
    const validateSession = vi.fn();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [],
      close: async () => undefined,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        validateSession,
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow(
      "Substack sign-in timed out. Run auth:setup again when you are ready to sign in.",
    );
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("cancels an aborted sign-in and still closes the browser", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    controller.abort();
    const close = vi.fn(async () => undefined);
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [],
      close,
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: controller.signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow("The guided Substack sign-in was cancelled.");
    expect(close).toHaveBeenCalledOnce();
  });

  it("revalidates an unchanged anonymous cookie after the retry interval", async () => {
    const root = await temporaryRoot();
    const cookies = vi.fn(async () => [
      { name: "connect.sid", value: "same-session" },
    ]);
    const runtime = createRuntime({
      open: async () => undefined,
      cookies,
      close: async () => undefined,
    });
    const validateSession = vi
      .fn()
      .mockRejectedValueOnce(new SubstackAuthError("not signed in"))
      .mockResolvedValueOnce({
        publicationUrl: "https://example.substack.com",
        userId: 123,
      });

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
      runtime,
    });

    expect(result.sessionToken).toBe("same-session");
    expect(validateSession).toHaveBeenCalledTimes(2);
    expect(cookies).toHaveBeenCalledTimes(11);
  });

  it("does not hide unexpected validation or browser cleanup failures", async () => {
    const root = await temporaryRoot();
    const runtime = createRuntime({
      open: async () => undefined,
      cookies: async () => [{ name: "connect.sid", value: "private-session" }],
      close: async () => {
        throw new Error("cleanup failed");
      },
    });

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("unexpected validation failure");
        },
        profileRoot: root,
        runtime,
      }),
    ).rejects.toThrow("unexpected validation failure");
    expect(await readdir(root)).toEqual([]);
  });

  it("uses the default Chrome adapter with an existing or newly created page", async () => {
    const root = await temporaryRoot();
    const firstGoto = vi.fn(async () => undefined);
    const newGoto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => 123);
    const newPage = vi.fn(async () => ({ goto: newGoto, evaluate }));
    const close = vi.fn(async () => undefined);
    playwright.launchPersistentContext
      .mockResolvedValueOnce({
        pages: () => [{ goto: firstGoto, evaluate }],
        newPage,
        cookies: async () => [{ name: "connect.sid", value: "first-session" }],
        close,
      })
      .mockResolvedValueOnce({
        pages: () => [],
        newPage,
        cookies: async () => [{ name: "connect.sid", value: "second-session" }],
        close,
      });
    const validateSession = async () => ({
      publicationUrl: "https://example.substack.com",
      userId: 123,
    });

    const first = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
    });
    const second = await captureSubstackBrowserSession({
      publicationUrl: "https://example.substack.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession,
      profileRoot: root,
    });

    expect(first.sessionToken).toBe("first-session");
    expect(second.sessionToken).toBe("second-session");
    expect(firstGoto).toHaveBeenCalledWith(
      "https://example.substack.com/publish/home",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(newPage).toHaveBeenCalledOnce();
    expect(newGoto).toHaveBeenCalledOnce();
    expect(playwright.launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("imports only Substack-domain cookies from the current Chrome profile", async () => {
    const chromeRoot = await temporaryRoot();
    const profileRoot = await temporaryRoot();
    await mkdir(join(chromeRoot, "Default"), { recursive: true });
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );
    await writeFile(join(chromeRoot, "Default", "Cookies"), "cookie database");
    type TestCookie = {
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Lax";
    };
    let browserCookies: TestCookie[] = [
      testCookie("SID", "google-session", ".google.com"),
      testCookie("substack.sid", "substack-session", ".substack.com"),
      testCookie(
        "connect.sid",
        "publication-session",
        "newsletter.example.com",
      ),
      testCookie("theme", "dark", "newsletter.example.com"),
    ];
    const setOffline = vi.fn(async () => undefined);
    const clearCookies = vi.fn(async () => {
      browserCookies = [];
    });
    const addCookies = vi.fn(async (cookies: readonly TestCookie[]) => {
      browserCookies = [...cookies];
    });
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => 123);
    const close = vi.fn(async () => undefined);
    let cookieReads = 0;
    playwright.launchPersistentContext.mockResolvedValueOnce({
      setOffline,
      clearCookies,
      addCookies,
      cookies: async () => {
        cookieReads += 1;
        return cookieReads === 1
          ? [testCookie("SID", "google-session", ".google.com")]
          : browserCookies;
      },
      pages: () => [{ goto, evaluate }],
      newPage: async () => ({ goto, evaluate }),
      close,
    });

    const result = await captureSubstackBrowserSession({
      publicationUrl: "https://newsletter.example.com",
      userAgent: "test-agent",
      requestTimeoutMs: 1000,
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      validateSession: async ({ sessionToken }) => ({
        publicationUrl: "https://newsletter.example.com",
        userId: sessionToken === "substack-session" ? 123 : 456,
      }),
      browserSource: "current_chrome",
      chromeUserDataRoot: chromeRoot,
      profileRoot,
    });

    expect(result).toMatchObject({
      sessionToken: "publication-session",
      validated: { userId: 456 },
    });
    expect(setOffline).toHaveBeenNthCalledWith(1, true);
    expect(setOffline).toHaveBeenNthCalledWith(2, false);
    expect(clearCookies).toHaveBeenCalledOnce();
    expect(addCookies).toHaveBeenCalledWith([
      expect.objectContaining({ domain: ".substack.com" }),
      expect.objectContaining({ domain: "newsletter.example.com" }),
      expect.objectContaining({ domain: "newsletter.example.com" }),
    ]);
    expect(playwright.launchPersistentContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headless: true,
        ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(cookieReads).toBeGreaterThan(2);
    expect(await readdir(profileRoot)).toEqual([]);
  });

  it("rejects invalid current Chrome profile metadata before launching Chrome", async () => {
    const chromeRoot = await temporaryRoot();
    const profileRoot = await temporaryRoot();
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify({ profile: { last_used: ".." } }),
    );

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        chromeUserDataRoot: chromeRoot,
        profileRoot,
      }),
    ).rejects.toThrow("current Chrome profile metadata was invalid");
    expect(playwright.launchPersistentContext).not.toHaveBeenCalled();
    expect(await readdir(profileRoot)).toEqual([]);
  });

  it("rejects a missing current Chrome profile record", async () => {
    const chromeRoot = await temporaryRoot();
    const profileRoot = await temporaryRoot();

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        chromeUserDataRoot: chromeRoot,
        profileRoot,
      }),
    ).rejects.toThrow("current Chrome profile could not be identified");
    expect(playwright.launchPersistentContext).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { profile: null },
    { profile: { last_used: "" } },
    { profile: { last_used: "." } },
  ])("rejects malformed Chrome profile metadata: %j", async (localState) => {
    const chromeRoot = await temporaryRoot();
    const profileRoot = await temporaryRoot();
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify(localState),
    );

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        chromeUserDataRoot: chromeRoot,
        profileRoot,
      }),
    ).rejects.toThrow("current Chrome profile metadata was invalid");
    expect(playwright.launchPersistentContext).not.toHaveBeenCalled();
  });

  it("rejects a Chrome profile path outside the user-data root", async () => {
    const chromeRoot = await temporaryRoot();
    const profileRoot = await temporaryRoot();
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify({ profile: { last_used: "/tmp/outside-profile" } }),
    );

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        chromeUserDataRoot: chromeRoot,
        profileRoot,
      }),
    ).rejects.toThrow("current Chrome profile path was rejected");
    expect(playwright.launchPersistentContext).not.toHaveBeenCalled();
  });

  it("rejects a Chrome profile without a readable cookie store", async () => {
    const chromeRoot = await temporaryRoot();
    const profileRoot = await temporaryRoot();
    await mkdir(join(chromeRoot, "Default"), { recursive: true });
    await writeFile(
      join(chromeRoot, "Local State"),
      JSON.stringify({ profile: { last_used: "Default" } }),
    );

    await expect(
      captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        chromeUserDataRoot: chromeRoot,
        profileRoot,
      }),
    ).rejects.toThrow("does not have a readable cookie store");
    expect(playwright.launchPersistentContext).not.toHaveBeenCalled();
  });

  it("rejects a loaded Chrome cookie store without a Substack session", async () => {
    vi.useFakeTimers();
    try {
      const chromeRoot = await temporaryRoot();
      const profileRoot = await temporaryRoot();
      await mkdir(join(chromeRoot, "Default"), { recursive: true });
      await writeFile(
        join(chromeRoot, "Local State"),
        JSON.stringify({ profile: { last_used: "Default" } }),
      );
      await writeFile(
        join(chromeRoot, "Default", "Cookies"),
        "cookie database",
      );
      let markCookiesRead: (() => void) | undefined;
      const cookiesRead = new Promise<void>((resolve) => {
        markCookiesRead = resolve;
      });
      const close = vi.fn(async () => {
        throw new Error("cleanup failed");
      });
      playwright.launchPersistentContext.mockResolvedValueOnce({
        setOffline: async () => undefined,
        clearCookies: async () => undefined,
        addCookies: async () => undefined,
        cookies: async () => {
          markCookiesRead?.();
          return [testCookie("SID", "google-session", ".google.com")];
        },
        pages: () => [],
        newPage: async () => {
          throw new Error("should not open a page");
        },
        close,
      });

      const capture = captureSubstackBrowserSession({
        publicationUrl: "https://example.substack.com",
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        validateSession: async () => {
          throw new Error("should not run");
        },
        browserSource: "current_chrome",
        chromeUserDataRoot: chromeRoot,
        profileRoot,
      });
      const expectation = expect(capture).rejects.toThrow(
        "No Substack session was found in the current Chrome profile.",
      );
      await cookiesRead;
      await vi.advanceTimersByTimeAsync(5000);
      await expectation;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the non-macOS fallback before reading a default Chrome profile", async () => {
    const profileRoot = await temporaryRoot();
    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    try {
      await expect(
        captureSubstackBrowserSession({
          publicationUrl: "https://example.substack.com",
          userAgent: "test-agent",
          requestTimeoutMs: 1000,
          timeoutMs: 30_000,
          signal: new AbortController().signal,
          validateSession: async () => {
            throw new Error("should not run");
          },
          browserSource: "current_chrome",
          profileRoot,
        }),
      ).rejects.toThrow("Current Chrome session import is available on macOS");
      expect(playwright.launchPersistentContext).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });

  it("prioritizes connect.sid and returns distinct non-empty session values", () => {
    expect(
      findSessionCookieValues([
        { name: "theme", value: "dark" },
        { name: "substack.sid", value: "substack-session" },
        { name: "connect.sid", value: "connect-session" },
        { name: "connect.sid", value: "substack-session" },
      ]),
    ).toEqual(["connect-session", "substack-session"]);
    expect(findSessionCookieValues([{ name: "theme", value: "dark" }])).toEqual(
      [],
    );
    expect(
      findSessionCookieValues([
        { name: "connect.sid", value: "   " },
        { name: "substack.sid", value: "  fallback-session  " },
      ]),
    ).toEqual(["fallback-session"]);
  });

  it("reads only a positive numeric user id from dashboard preloads", () => {
    const target = globalThis as { _preloads?: unknown };
    const original = target._preloads;
    try {
      for (const preloads of [
        undefined,
        null,
        [],
        {},
        { user: null },
        { user: [] },
        { user: { id: "123" } },
        { user: { id: 0 } },
        { user: { id: Number.MAX_SAFE_INTEGER + 1 } },
      ]) {
        target._preloads = preloads;
        expect(readAuthenticatedDashboardUserId()).toBeUndefined();
      }

      target._preloads = { user: { id: 123 } };
      expect(readAuthenticatedDashboardUserId()).toBe(123);
    } finally {
      target._preloads = original;
    }
  });

  it("completes and cancels abortable browser polling delays", async () => {
    vi.useFakeTimers();
    try {
      const completed = waitForAbortableDelay(
        1000,
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await expect(completed).resolves.toBeUndefined();

      const controller = new AbortController();
      const cancelled = waitForAbortableDelay(1000, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toThrow(
        "The guided Substack sign-in was cancelled.",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "substack-browser-auth-"));
  roots.push(root);
  return root;
}

function createRuntime(
  context:
    | (Omit<BrowserAuthContext, "authenticatedUserId"> &
        Partial<Pick<BrowserAuthContext, "authenticatedUserId">>)
    | undefined,
  launch: BrowserAuthRuntime["launch"] = async () => {
    if (!context) {
      throw new Error("missing test browser context");
    }
    return {
      ...context,
      authenticatedUserId: context.authenticatedUserId ?? (async () => 123),
    };
  },
): BrowserAuthRuntime {
  let now = 0;
  return {
    launch,
    now: () => now,
    sleep: async (milliseconds, signal) => {
      if (signal.aborted) {
        throw new Error("aborted");
      }
      now += milliseconds;
    },
  };
}

function testCookie(
  name: string,
  value: string,
  domain: string,
): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
} {
  return {
    name,
    value,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
}
