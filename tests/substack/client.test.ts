import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../src/safety/redaction.js";
import {
  buildSubstackHeaders,
  normalizePublicationUrl,
  substackCookie,
} from "../../src/substack/auth.js";
import {
  createSubstackClient,
  SubstackClient,
} from "../../src/substack/client.js";
import {
  createSubstackError,
  SUBSTACK_RESPONSE_BODY_EXCERPT_CHARS,
  SubstackApiError,
  SubstackAuthError,
  SubstackNotFoundError,
  SubstackRateLimitError,
  SubstackServerError,
  SubstackTimeoutError,
  SubstackValidationError,
} from "../../src/substack/errors.js";
import type {
  FetchLike,
  SubstackClientConfig,
} from "../../src/substack/types.js";

const config: SubstackClientConfig = {
  publicationUrl: "https://example.substack.com/",
  sessionToken: "secret-session",
  userId: 123,
  userAgent: "test-agent",
};

describe("Substack auth helpers", () => {
  it("normalizes publication URLs and builds browser-like headers", () => {
    expect(normalizePublicationUrl("https://example.substack.com///")).toBe(
      "https://example.substack.com",
    );
    expect(
      normalizePublicationUrl(
        "https://example.substack.com/p/a-draft?utm=agent#editor",
      ),
    ).toBe("https://example.substack.com");
    expect(() => normalizePublicationUrl("ftp://example.com")).toThrow(
      "SUBSTACK_PUBLICATION_URL must use http:// or https://.",
    );
    expect(() => normalizePublicationUrl("http://example.com")).toThrow(
      "SUBSTACK_PUBLICATION_URL must use https://.",
    );
    expect(() => normalizePublicationUrl("https://127.0.0.1")).toThrow(
      "SUBSTACK_PUBLICATION_URL must not point to localhost or private network addresses.",
    );
    expect(() => normalizePublicationUrl("   ")).toThrow(
      "SUBSTACK_PUBLICATION_URL is required.",
    );
    expect(substackCookie("secret")).toBe(
      "connect.sid=secret; substack.sid=secret;",
    );
    expect(() => substackCookie("connect.sid=secret")).toThrow(
      "SUBSTACK_SESSION_TOKEN must be the cookie value only, not a Cookie header or name=value pair.",
    );

    const headers = buildSubstackHeaders(
      {
        publicationUrl: "https://example.substack.com/p/source",
        sessionToken: "secret",
        userAgent: "agent",
      },
      true,
    );

    expect(headers.get("Cookie")).toBe(
      "connect.sid=secret; substack.sid=secret;",
    );
    expect(headers.get("User-Agent")).toBe("agent");
    expect(headers.get("Referer")).toBe(
      "https://example.substack.com/publish/home",
    );
    expect(headers.get("Content-Type")).toBe("application/json");

    const getHeaders = buildSubstackHeaders(
      {
        publicationUrl: "https://example.substack.com",
        sessionToken: "secret",
        userAgent: "agent",
      },
      false,
    );
    expect(getHeaders.has("Content-Type")).toBe(false);
  });
});

describe("SubstackClient", () => {
  it("lists and normalizes draft summaries", async () => {
    const fetch = fakeFetch([
      jsonResponse({
        drafts: [
          {
            id: 10,
            draft_title: "Title",
            draft_subtitle: "Subtitle",
            draft_word_count: 12,
            draft_created_at: "2026-07-08T01:00:00Z",
            draft_updated_at: "2026-07-08T02:00:00Z",
            canonical_url: "https://example.substack.com/p/title",
          },
        ],
      }),
    ]);
    const client = new SubstackClient(config, { fetchFn: fetch.fn });

    await expect(client.listDrafts(5, 10)).resolves.toEqual([
      {
        id: 10,
        title: "Title",
        subtitle: "Subtitle",
        audience: undefined,
        word_count: 12,
        created_at: "2026-07-08T01:00:00Z",
        updated_at: "2026-07-08T02:00:00Z",
        url: "https://example.substack.com/p/title",
      },
    ]);
    expect(fetch.calls[0]?.url).toBe(
      "https://example.substack.com/api/v1/post_management/drafts?offset=5&limit=10&order_by=draft_updated_at&order_direction=desc",
    );
    expect(fetch.calls[0]?.init.method).toBe("GET");
    expect(fetch.calls[0]?.init.body).toBeUndefined();
    expect(fetch.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts raw draft arrays and post fallback arrays", async () => {
    const fetch = fakeFetch([
      jsonResponse([{ id: 11, title: "Raw response" }]),
      jsonResponse({
        drafts: "not-array",
        posts: [
          { id: 12, title: "Posts response" },
          null,
          ["ignored"],
          "ignored",
        ],
      }),
    ]);
    const client = new SubstackClient(config, { fetchFn: fetch.fn });

    await expect(client.listDrafts(0, 1)).resolves.toEqual([
      {
        id: 11,
        title: "Raw response",
        subtitle: undefined,
        audience: undefined,
        word_count: undefined,
        created_at: undefined,
        updated_at: undefined,
        url: undefined,
      },
    ]);
    await expect(client.listDrafts(0, 1)).resolves.toEqual([
      {
        id: 12,
        title: "Posts response",
        subtitle: undefined,
        audience: undefined,
        word_count: undefined,
        created_at: undefined,
        updated_at: undefined,
        url: undefined,
      },
    ]);
  });

  it("gets, creates, updates drafts, validates auth, and uploads images", async () => {
    const fetch = fakeFetch([
      jsonResponse({ id: 123 }),
      jsonResponse({
        id: 20,
        title: "Existing",
        draft_body: '{"type":"doc"}',
        status: "draft",
        draft: true,
        is_draft: true,
        post_date: null,
        published_at: "2026-07-08T03:00:00Z",
        is_published: false,
      }),
      jsonResponse({ id: 21, draft_title: "Created" }),
      jsonResponse({ id: 21, draft_title: "Updated", audience: "everyone" }),
      jsonResponse({ image_url: "https://substackcdn.com/image.png" }),
    ]);
    const client = new SubstackClient(config, { fetchFn: fetch.fn });

    await expect(client.validateAuth()).resolves.toEqual({ id: 123, ok: true });
    await expect(client.getDraft(20)).resolves.toMatchObject({
      id: 20,
      title: "Existing",
      draft_body: '{"type":"doc"}',
      status: "draft",
      draft: true,
      is_draft: true,
      post_date: null,
      published_at: "2026-07-08T03:00:00Z",
      is_published: false,
    });
    await expect(
      client.createDraft({
        draft_title: "Created",
        draft_body: "{}",
        draft_bylines: [{ id: 123, is_guest: false }],
        type: "newsletter",
      }),
    ).resolves.toMatchObject({ id: 21, title: "Created" });
    await expect(
      client.updateDraft(21, {
        draft_title: "Updated",
        audience: "everyone",
      }),
    ).resolves.toMatchObject({
      id: 21,
      title: "Updated",
      audience: "everyone",
    });
    await expect(
      client.uploadImage("data:image/png;base64,abc"),
    ).resolves.toEqual({
      url: "https://substackcdn.com/image.png",
    });

    expect(fetch.calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "https://example.substack.com/api/v1/publication"],
      ["GET", "https://example.substack.com/api/v1/drafts/20"],
      ["POST", "https://example.substack.com/api/v1/drafts"],
      ["PUT", "https://example.substack.com/api/v1/drafts/21"],
      ["POST", "https://example.substack.com/api/v1/image"],
    ]);
    expect(fetch.calls[2]?.init.body).toContain('"draft_title":"Created"');
    expect(fetch.calls[4]?.init.body).toContain("data:image/png;base64,abc");
  });

  it("maps API failures to typed errors with redacted response excerpts", async () => {
    const statuses = [
      [400, SubstackValidationError],
      [401, SubstackAuthError],
      [403, SubstackAuthError],
      [404, SubstackNotFoundError],
      [429, SubstackRateLimitError],
      [500, SubstackServerError],
      [418, SubstackApiError],
    ] as const;

    for (const [status, ErrorClass] of statuses) {
      const fetch = fakeFetch([
        new Response(
          `connect.sid=secret-session; SUBSTACK_SESSION_TOKEN=secret-session status ${status}`,
          { status },
        ),
      ]);
      const client = new SubstackClient(config, { fetchFn: fetch.fn });

      try {
        await client.getDraft(1);
        throw new Error("Expected getDraft to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(ErrorClass);
        expect(error).toBeInstanceOf(SubstackApiError);
        expect((error as SubstackApiError).responseBody).not.toContain(
          "secret-session",
        );
      }
    }
  });

  it("redacts private draft fields from API error response excerpts", async () => {
    const fetch = fakeFetch([
      new Response(
        JSON.stringify({
          error: "payload rejected",
          draft_body: { type: "doc", content: [{ text: "private draft" }] },
          body: "private body",
          nested: { body_markdown: "private markdown" },
          safe: "visible",
        }),
        { status: 400 },
      ),
    ]);
    const client = new SubstackClient(config, { fetchFn: fetch.fn });

    try {
      await client.createDraft({
        draft_title: "Created",
        draft_body: "{}",
        draft_bylines: [{ id: 123, is_guest: false }],
        type: "newsletter",
      });
      throw new Error("Expected createDraft to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(SubstackValidationError);
      expect((error as SubstackApiError).responseBody).toContain(
        '"safe":"visible"',
      );
      expect((error as SubstackApiError).responseBody).toContain(
        '"draft_body":"[REDACTED]"',
      );
      expect((error as SubstackApiError).responseBody).not.toContain("private");
    }
  });

  it("caps response excerpts and keeps status hints actionable", () => {
    const authError = createSubstackError(
      401,
      "/api/v1/drafts",
      `SUBSTACK_SESSION_TOKEN=secret-session ${"x".repeat(600)}`,
    );

    expect(authError).toBeInstanceOf(SubstackAuthError);
    expect(authError.responseBody).toHaveLength(
      SUBSTACK_RESPONSE_BODY_EXCERPT_CHARS,
    );
    expect(authError.responseBody).not.toContain("secret-session");
    expect(authError.hint).toContain("expired Substack session token");
    expect(authError.hint).toContain("custom-domain issue");

    expect(createSubstackError(400, "/api/v1/drafts", "bad").hint).toContain(
      "draft payload shape",
    );
    expect(createSubstackError(404, "/api/v1/drafts/1", "nope").hint).toContain(
      "draft ID",
    );
    expect(createSubstackError(429, "/api/v1/drafts", "wait").hint).toContain(
      "rate limiting",
    );
    expect(createSubstackError(500, "/api/v1/drafts", "oops").hint).toContain(
      "retry later",
    );
  });

  it("maps timed-out Substack requests to safe typed errors", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchFn: FetchLike = async (_input, init = {}) => {
      capturedSignal = init.signal;
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    };
    const client = new SubstackClient(
      { ...config, requestTimeoutMs: 1 },
      { fetchFn },
    );

    try {
      await client.getDraft(99);
      throw new Error("Expected getDraft to time out.");
    } catch (error) {
      expect(error).toBeInstanceOf(SubstackTimeoutError);
      expect(error).toBeInstanceOf(SubstackApiError);
      expect((error as SubstackApiError).endpoint).toBe("/api/v1/drafts/99");
      expect((error as Error).message).toBe(
        "Substack request timed out after 1 ms",
      );
      expect((error as SubstackApiError).hint).toContain(
        "Substack availability",
      );
    }

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("maps timed-out Substack response body reads to safe typed errors", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchFn: FetchLike = async (_input, init = {}) => {
      capturedSignal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener(
            "abort",
            () => {
              controller.error(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            },
            { once: true },
          );

          const fallback = setTimeout(() => {
            if (!init.signal?.aborted) {
              controller.error(
                new Error("Body was not aborted by request timeout."),
              );
            }
          }, 20);
          fallback.unref?.();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new SubstackClient(
      { ...config, requestTimeoutMs: 1 },
      { fetchFn },
    );

    try {
      await client.getDraft(100);
      throw new Error("Expected getDraft body read to time out.");
    } catch (error) {
      expect(error).toBeInstanceOf(SubstackTimeoutError);
      expect(error).toBeInstanceOf(SubstackApiError);
      expect((error as SubstackApiError).endpoint).toBe("/api/v1/drafts/100");
      expect((error as Error).message).toBe(
        "Substack request timed out after 1 ms",
      );
    }

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("maps fetch AbortError failures to typed timeout errors", async () => {
    const client = new SubstackClient(
      { ...config, requestTimeoutMs: 10_000 },
      {
        fetchFn: async () => {
          throw new DOMException("The operation was aborted.", "AbortError");
        },
      },
    );

    await expect(client.getDraft(100)).rejects.toBeInstanceOf(
      SubstackTimeoutError,
    );
  });

  it("preserves non-timeout fetch failures", async () => {
    const networkError = new Error("Network unavailable.");
    const client = new SubstackClient(config, {
      fetchFn: async () => {
        throw networkError;
      },
    });

    await expect(client.getDraft(101)).rejects.toBe(networkError);
  });

  it("throws on invalid JSON and malformed successful payloads", async () => {
    const invalidJsonClient = new SubstackClient(config, {
      fetchFn: fakeFetch([new Response("not-json", { status: 200 })]).fn,
    });
    await expect(invalidJsonClient.getDraft(1)).rejects.toThrow(
      "Substack response was not valid JSON.",
    );

    const missingIdClient = new SubstackClient(config, {
      fetchFn: fakeFetch([jsonResponse({ title: "No id" })]).fn,
    });
    await expect(missingIdClient.getDraft(1)).rejects.toThrow(
      "Substack draft response did not include an ID.",
    );

    const missingImageClient = new SubstackClient(config, {
      fetchFn: fakeFetch([jsonResponse({})]).fn,
    });
    await expect(
      missingImageClient.uploadImage("data:image/png;base64,abc"),
    ).rejects.toThrow("Substack image response did not include a URL.");

    const invalidImageUrlClient = new SubstackClient(config, {
      fetchFn: fakeFetch([jsonResponse({ image_url: "data:image/png,abc" })])
        .fn,
    });
    await expect(
      invalidImageUrlClient.uploadImage("data:image/png;base64,abc"),
    ).rejects.toThrow(
      "Substack image response URL must use http:// or https://.",
    );

    const credentialedImageUrlClient = new SubstackClient(config, {
      fetchFn: fakeFetch([
        jsonResponse({
          image_url: "https://user:password@substackcdn.com/a.png",
        }),
      ]).fn,
    });
    await expect(
      credentialedImageUrlClient.uploadImage("data:image/png;base64,abc"),
    ).rejects.toThrow(
      "Substack image response URL must not include username or password.",
    );

    const privateImageUrlClient = new SubstackClient(config, {
      fetchFn: fakeFetch([
        jsonResponse({ image_url: "http://127.0.0.1/a.png" }),
      ]).fn,
    });
    await expect(
      privateImageUrlClient.uploadImage("data:image/png;base64,abc"),
    ).rejects.toThrow(
      "Substack image response URL must not point to localhost or private network addresses.",
    );

    const emptyImageClient = new SubstackClient(config, {
      fetchFn: fakeFetch([new Response("", { status: 200 })]).fn,
    });
    await expect(
      emptyImageClient.uploadImage("data:image/png;base64,abc"),
    ).rejects.toThrow("Substack image response did not include a URL.");
  });

  it("requires config fields when creating from app config", () => {
    expect(
      createSubstackClient({
        publicationUrl: "https://example.substack.com/",
        sessionToken: "secret",
        userId: 1,
        userAgent: "agent",
      }),
    ).toBeInstanceOf(SubstackClient);

    expect(() =>
      createSubstackClient({
        publicationUrl: undefined,
        sessionToken: "secret",
        userId: 1,
        userAgent: "agent",
      }),
    ).toThrow("SUBSTACK_PUBLICATION_URL is required.");
    expect(() =>
      createSubstackClient({
        publicationUrl: "https://example.substack.com",
        sessionToken: undefined,
        userId: 1,
        userAgent: "agent",
      }),
    ).toThrow("SUBSTACK_SESSION_TOKEN is required.");
    expect(() =>
      createSubstackClient({
        publicationUrl: "https://example.substack.com",
        sessionToken: "connect.sid=secret; substack.sid=secret",
        userId: 1,
        userAgent: "agent",
      }),
    ).toThrow(
      "SUBSTACK_SESSION_TOKEN must be the cookie value only, not a Cookie header or name=value pair.",
    );
    expect(() =>
      createSubstackClient({
        publicationUrl: "https://example.substack.com",
        sessionToken: "secret",
        userId: undefined,
        userAgent: "agent",
      }),
    ).toThrow("SUBSTACK_USER_ID is required.");
    expect(() =>
      createSubstackClient({
        publicationUrl: "https://example.substack.com",
        sessionToken: "secret",
        userId: 0,
        userAgent: "agent",
      }),
    ).toThrow("SUBSTACK_USER_ID must be a positive integer.");
    expect(
      () =>
        new SubstackClient({
          ...config,
          requestTimeoutMs: 0,
        }),
    ).toThrow("SUBSTACK_REQUEST_TIMEOUT_MS must be a positive integer.");
    expect(
      () =>
        new SubstackClient({
          ...config,
          sessionToken: "",
        }),
    ).toThrow("SUBSTACK_SESSION_TOKEN is required.");
    expect(
      () =>
        new SubstackClient({
          ...config,
          userId: 0,
        }),
    ).toThrow("SUBSTACK_USER_ID must be a positive integer.");
  });
});

describe("redactSecrets", () => {
  it("redacts cookies, bearer tokens, and env-style secrets", () => {
    expect(
      redactSecrets(
        "connect.sid=abc; substack.sid=def; Authorization: Bearer token PREVIEW_TOKEN_SECRET=secret MCP_BEARER_TOKEN=secret",
      ),
    ).toBe(
      "[REDACTED]; [REDACTED]; Authorization: [REDACTED] PREVIEW_TOKEN_SECRET=[REDACTED] MCP_BEARER_TOKEN=[REDACTED]",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  readonly url: string;
  readonly init: {
    readonly method?: string;
    readonly headers?: Headers | Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  };
}

function fakeFetch(responses: readonly Response[]): {
  readonly calls: FetchCall[];
  readonly fn: FetchLike;
} {
  const calls: FetchCall[] = [];
  let index = 0;

  return {
    calls,
    fn: async (input, init = {}) => {
      calls.push({
        url: input.toString(),
        init,
      });

      const response = responses[index];
      index += 1;
      if (!response) {
        throw new Error("Unexpected fetch call.");
      }

      return response.clone();
    },
  };
}
