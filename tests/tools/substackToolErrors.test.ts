import { describe, expect, it } from "vitest";

import { SubstackAuthError } from "../../src/substack/errors.js";
import { summarizeSubstackToolError } from "../../src/tools/substackToolErrors.js";

describe("summarizeSubstackToolError", () => {
  it("summarizes typed Substack API errors with redacted excerpts", () => {
    const result = summarizeSubstackToolError(
      new SubstackAuthError("Substack authentication failed.", {
        status: 401,
        responseBody: JSON.stringify({
          SUBSTACK_SESSION_TOKEN: "secret-session",
          draft_body: { type: "doc", content: [{ text: "private draft" }] },
        }),
        hint: "Check credentials.",
      }),
    );

    expect(result).toContain("Substack authentication failed. (HTTP 401).");
    expect(result).toContain("Check credentials.");
    expect(result).toContain('"draft_body":"[REDACTED]"');
    expect(result).not.toContain("secret-session");
    expect(result).not.toContain("private draft");
  });

  it("redacts draft payload fields from generic errors", () => {
    const result = summarizeSubstackToolError(
      new Error(
        "fetch failed with SUBSTACK_SESSION_TOKEN=secret body_markdown='private body' draft_body=\"private doc\" image_base64=data:image/png;base64,aGk=",
      ),
    );

    expect(result).toBe(
      "fetch failed with SUBSTACK_SESSION_TOKEN=[REDACTED] body_markdown='[REDACTED]' draft_body=\"[REDACTED]\" image_base64=[REDACTED]",
    );
  });

  it("returns a generic message for unknown thrown values", () => {
    expect(summarizeSubstackToolError("not an error")).toBe(
      "Unknown Substack error.",
    );
  });
});
