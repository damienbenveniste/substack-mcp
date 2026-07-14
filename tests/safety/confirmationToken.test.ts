import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createConfirmationToken,
  stableStringify,
  verifyConfirmationToken,
} from "../../src/safety/confirmationToken.js";

const secret = "test-preview-secret-with-enough-entropy";
const now = new Date("2026-07-08T12:00:00.000Z");

const subject = {
  action: "create" as const,
  title: " My   Draft ",
  subtitle: "Subtitle",
  audience: "everyone",
  content: {
    draft_body: '{"type":"doc","content":[]}',
    type: "newsletter",
  },
};

describe("confirmationToken", () => {
  it("creates and verifies a compact signed token", () => {
    const result = createConfirmationToken(subject, {
      secret,
      ttlSeconds: 900,
      now,
    });

    expect(result.token.split(".")).toHaveLength(2);
    expect(result.expiresAt.toISOString()).toBe("2026-07-08T12:15:00.000Z");
    expect(
      verifyConfirmationToken(result.token, subject, {
        secret,
        now: new Date("2026-07-08T12:05:00.000Z"),
      }),
    ).toMatchObject({ ok: true });
  });

  it("requires a positive integer TTL", () => {
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createConfirmationToken(subject, {
          secret,
          ttlSeconds,
          now,
        }),
      ).toThrow("ttlSeconds must be a positive integer.");
    }
  });

  it("rejects malformed, tampered, expired, and mismatched tokens", () => {
    const result = createConfirmationToken(subject, {
      secret,
      ttlSeconds: 1,
      now,
    });

    expect(
      verifyConfirmationToken("not-a-token", subject, { secret, now }),
    ).toEqual({
      ok: false,
      error: "Malformed confirmation token.",
    });

    expect(verifyConfirmationToken("a.b.c", subject, { secret, now })).toEqual({
      ok: false,
      error: "Malformed confirmation token.",
    });

    expect(
      verifyConfirmationToken(`${result.token}x`, subject, { secret, now }),
    ).toEqual({
      ok: false,
      error: "Invalid confirmation token signature.",
    });

    expect(
      verifyConfirmationToken(result.token, subject, {
        secret,
        now: new Date("2026-07-08T12:00:01.000Z"),
      }),
    ).toEqual({
      ok: false,
      error: "Confirmation token has expired.",
    });

    expect(
      verifyConfirmationToken(
        result.token,
        { ...subject, title: "Changed" },
        { secret, now },
      ),
    ).toEqual({
      ok: false,
      error: "Confirmation token does not match the current draft input.",
    });

    expect(
      verifyConfirmationToken(
        result.token,
        { ...subject, audience: "only_paid" },
        { secret, now },
      ),
    ).toEqual({
      ok: false,
      error: "Confirmation token does not match the current draft input.",
    });
  });

  it("rejects invalid payloads even with a valid signature", () => {
    expect(
      verifyConfirmationToken(signedTokenForPayloadJson("not-json"), subject, {
        secret,
        now,
      }),
    ).toEqual({
      ok: false,
      error: "Invalid confirmation token payload.",
    });

    expect(
      verifyConfirmationToken(signedTokenForPayloadJson("{}"), subject, {
        secret,
        now,
      }),
    ).toEqual({
      ok: false,
      error: "Invalid confirmation token payload.",
    });
  });

  it("stableStringify sorts object keys and omits undefined object fields", () => {
    const sparse = [] as unknown[];
    sparse[1] = 1;

    expect(stableStringify({ b: 2, a: 1, c: undefined })).toBe('{"a":1,"b":2}');
    expect(stableStringify([2, null, "x"])).toBe('[2,null,"x"]');
    expect(stableStringify([undefined, 1])).toBe("[null,1]");
    expect(stableStringify(sparse)).toBe("[null,1]");
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify(null)).toBe("null");
  });

  it("uses current time defaults when now is omitted", () => {
    const result = createConfirmationToken(subject, {
      secret,
      ttlSeconds: 900,
    });

    expect(
      verifyConfirmationToken(result.token, subject, {
        secret,
      }),
    ).toMatchObject({ ok: true });
  });
});

function signedTokenForPayloadJson(payloadJson: string): string {
  const payload = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payloadJson)
    .digest("base64url");

  return `${payload}.${signature}`;
}
