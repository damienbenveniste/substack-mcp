import { describe, expect, it, vi } from "vitest";

import {
  SubstackApiError,
  SubstackAuthError,
  SubstackTimeoutError,
} from "../../src/substack/errors.js";
import { validateSubstackSession } from "../../src/substack/sessionAuth.js";
import type { FetchLike } from "../../src/substack/types.js";

describe("validateSubstackSession", () => {
  it("validates publication access and preserves the authenticated user id", async () => {
    const fetchFn = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ id: 123 }), { status: 200 }),
    );

    const result = await validateSubstackSession(
      {
        publicationUrl: "https://example.substack.com/p/draft?ignored=true",
        sessionToken: "session-token",
        userId: 123,
        userAgent: "test-agent",
        requestTimeoutMs: 1000,
      },
      { fetchFn },
    );

    expect(result).toEqual({
      publicationUrl: "https://example.substack.com",
      userId: 123,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url?.toString()).toBe(
      "https://example.substack.com/api/v1/publication",
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe(
      "connect.sid=session-token; substack.sid=session-token;",
    );
    expect(headers.get("referer")).toBe(
      "https://example.substack.com/publish/home",
    );
    expect(headers.get("user-agent")).toBe("test-agent");
  });

  it("rejects successful publication responses without a positive numeric id", async () => {
    await expect(
      validateSubstackSession(
        {
          publicationUrl: "https://example.substack.com",
          sessionToken: "session-token",
          userId: 123,
          userAgent: "test-agent",
        },
        {
          fetchFn: async () =>
            new Response(JSON.stringify({ id: 0 }), { status: 200 }),
        },
      ),
    ).rejects.toThrow(
      "Substack authentication response did not include a positive numeric publication id.",
    );
  });

  it("maps authentication failures without exposing the session token", async () => {
    const sessionToken = "private-session-token";
    let caught: unknown;
    try {
      await validateSubstackSession(
        {
          publicationUrl: "https://example.substack.com",
          sessionToken,
          userId: 123,
          userAgent: "test-agent",
        },
        {
          fetchFn: async () =>
            new Response(`denied SUBSTACK_SESSION_TOKEN=${sessionToken}`, {
              status: 401,
            }),
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SubstackAuthError);
    expect(caught).toMatchObject({
      message: "Substack authentication failed.",
      responseBody: "denied SUBSTACK_SESSION_TOKEN=[REDACTED]",
    });
    expect(JSON.stringify(caught)).not.toContain(sessionToken);
  });

  it("rejects non-JSON authentication responses without retaining the body", async () => {
    let caught: unknown;
    try {
      await validateSubstackSession(
        {
          publicationUrl: "https://example.substack.com",
          sessionToken: "session-token",
          userId: 123,
          userAgent: "test-agent",
        },
        {
          fetchFn: async () => new Response("not-json", { status: 200 }),
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SubstackApiError);
    expect(caught).toMatchObject({
      message: "Substack authentication response was not valid JSON.",
      responseBody: undefined,
    });
  });

  it("requires a session token, user id, and positive request timeout", async () => {
    await expect(
      validateSubstackSession({
        publicationUrl: "https://example.substack.com",
        sessionToken: " ",
        userId: 123,
        userAgent: "test-agent",
      }),
    ).rejects.toThrow("SUBSTACK_SESSION_TOKEN is required.");

    await expect(
      validateSubstackSession({
        publicationUrl: "https://example.substack.com",
        sessionToken: "session-token",
        userId: undefined as unknown as number,
        userAgent: "test-agent",
      }),
    ).rejects.toThrow("SUBSTACK_USER_ID is required.");

    await expect(
      validateSubstackSession({
        publicationUrl: "https://example.substack.com",
        sessionToken: "session-token",
        userId: 123,
        userAgent: "test-agent",
        requestTimeoutMs: 0,
      }),
    ).rejects.toThrow(
      "SUBSTACK_REQUEST_TIMEOUT_MS must be a positive integer.",
    );
  });

  it("uses the global fetch implementation when no override is supplied", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ id: 123 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchFn);
    try {
      await expect(
        validateSubstackSession({
          publicationUrl: "https://example.substack.com",
          sessionToken: "session-token",
          userId: 123,
          userAgent: "test-agent",
        }),
      ).resolves.toMatchObject({ userId: 123 });
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps aborted authentication requests to a timeout error", async () => {
    const fetchFn: FetchLike = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });

    vi.useFakeTimers();
    try {
      const validation = validateSubstackSession(
        {
          publicationUrl: "https://example.substack.com",
          sessionToken: "session-token",
          userId: 123,
          userAgent: "test-agent",
          requestTimeoutMs: 1,
        },
        { fetchFn },
      );
      const expectation =
        expect(validation).rejects.toBeInstanceOf(SubstackTimeoutError);
      await vi.advanceTimersByTimeAsync(1);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps an upstream AbortError and preserves unrelated network errors", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    await expect(
      validateSubstackSession(
        {
          publicationUrl: "https://example.substack.com",
          sessionToken: "session-token",
          userId: 123,
          userAgent: "test-agent",
        },
        { fetchFn: async () => Promise.reject(abortError) },
      ),
    ).rejects.toBeInstanceOf(SubstackTimeoutError);

    const networkError = new Error("network unavailable");
    await expect(
      validateSubstackSession(
        {
          publicationUrl: "https://example.substack.com",
          sessionToken: "session-token",
          userId: 123,
          userAgent: "test-agent",
        },
        { fetchFn: async () => Promise.reject(networkError) },
      ),
    ).rejects.toBe(networkError);
  });
});
