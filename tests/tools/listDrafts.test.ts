import { describe, expect, it } from "vitest";

import { SubstackAuthError } from "../../src/substack/errors.js";
import type { SubstackDraftSummary } from "../../src/substack/types.js";
import { listDrafts, summarizeDraftList } from "../../src/tools/listDrafts.js";

const config = {
  publicationUrl: undefined,
  sessionToken: undefined,
  substackRequestTimeoutMs: 30_000,
  userId: undefined,
  userAgent: "test-agent",
};

describe("listDrafts", () => {
  it("lists drafts with default pagination through an injected client", async () => {
    const calls: Array<readonly [number, number]> = [];
    const result = await listDrafts({}, config, {
      client: {
        listDrafts: async (offset, limit) => {
          calls.push([offset, limit]);
          return [
            {
              id: 1,
              title: "First draft",
              subtitle: "Subtitle",
              word_count: 42,
              updated_at: "2026-07-08T12:00:00Z",
            },
          ];
        },
      },
    });

    expect(calls).toEqual([[0, 10]]);
    expect(result).toEqual({
      ok: true,
      errors: [],
      drafts: [
        {
          id: 1,
          title: "First draft",
          subtitle: "Subtitle",
          word_count: 42,
          updated_at: "2026-07-08T12:00:00Z",
        },
      ],
      offset: 0,
      limit: 10,
    });
    expect(summarizeDraftList(result)).toBe("Found 1 Substack draft(s).");
  });

  it("projects draft summaries to the safe metadata output shape", async () => {
    const result = await listDrafts({}, config, {
      client: {
        listDrafts: async () => [
          {
            id: 1,
            title: "Safe title",
            subtitle: "Safe subtitle",
            audience: "everyone",
            word_count: 42,
            created_at: "2026-07-08T11:00:00Z",
            updated_at: "2026-07-08T12:00:00Z",
            url: "https://example.substack.com/p/safe-title",
            body: "private draft body",
            draft_body: '{"type":"doc"}',
            raw: { id: 1, draft_body: "not exposed" },
          } as SubstackDraftSummary & {
            readonly body: string;
            readonly draft_body: string;
            readonly raw: unknown;
          },
          {
            id: 2,
            title: "Unsafe URL draft",
            url: "http://127.0.0.1/private-draft",
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.drafts).toEqual([
      {
        id: 1,
        title: "Safe title",
        subtitle: "Safe subtitle",
        audience: "everyone",
        word_count: 42,
        created_at: "2026-07-08T11:00:00Z",
        updated_at: "2026-07-08T12:00:00Z",
        url: "https://example.substack.com/p/safe-title",
      },
      {
        id: 2,
        title: "Unsafe URL draft",
      },
    ]);
    expect(result.drafts[0]).not.toHaveProperty("body");
    expect(result.drafts[0]).not.toHaveProperty("draft_body");
    expect(result.drafts[0]).not.toHaveProperty("raw");
  });

  it("passes explicit pagination to the client", async () => {
    const calls: Array<readonly [number, number]> = [];
    const result = await listDrafts(
      {
        offset: 20,
        limit: 5,
      },
      config,
      {
        client: {
          listDrafts: async (offset, limit) => {
            calls.push([offset, limit]);
            return [];
          },
        },
      },
    );

    expect(calls).toEqual([[20, 5]]);
    expect(result.ok).toBe(true);
    expect(result.drafts).toEqual([]);
    expect(summarizeDraftList(result)).toBe("No Substack drafts found.");
  });

  it("returns config errors without throwing", async () => {
    const result = await listDrafts({}, config);

    expect(result.ok).toBe(false);
    expect(result.drafts).toEqual([]);
    expect(result.errors).toEqual(["SUBSTACK_PUBLICATION_URL is required."]);
    expect(summarizeDraftList(result)).toBe(
      "Draft listing failed with 1 error(s).",
    );
  });

  it("returns redacted Substack API errors", async () => {
    const result = await listDrafts({}, config, {
      client: {
        listDrafts: async () => {
          throw new SubstackAuthError("Substack authentication failed.", {
            status: 401,
            responseBody: "connect.sid=secret-session",
            hint: "Check credentials.",
          });
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("HTTP 401");
    expect(result.errors[0]).toContain("[REDACTED]");
    expect(result.errors[0]).not.toContain("secret-session");
  });

  it("returns a generic message for unknown thrown values", async () => {
    const result = await listDrafts({}, config, {
      client: {
        listDrafts: async () => {
          throw "not-an-error";
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Unknown Substack error."]);
  });
});
