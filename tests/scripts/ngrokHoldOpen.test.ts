import { describe, expect, it, vi } from "vitest";

import {
  holdOpenNgrokTunnel,
  parseNgrokHoldOpenSeconds,
} from "../../scripts/ngrokHoldOpen.js";

describe("ngrok hold-open workflow", () => {
  it("does nothing when the hold-open window is disabled", async () => {
    const write = vi.fn();
    const wait = vi.fn(async () => undefined);

    await holdOpenNgrokTunnel({
      endpoint: new URL("https://example.ngrok.app/mcp"),
      seconds: 0,
      auth: { mode: "noauth" },
      write,
      wait,
    });

    expect(write).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("prints the live noauth endpoint before waiting", async () => {
    const messages: string[] = [];
    const wait = vi.fn(async () => undefined);

    await holdOpenNgrokTunnel({
      endpoint: new URL("https://example.ngrok.app/mcp"),
      seconds: 900,
      auth: { mode: "noauth" },
      write: (message) => messages.push(message),
      wait,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("https://example.ngrok.app/mcp");
    expect(messages[0]).toContain("Authentication: noauth");
    expect(messages[0]).toContain("900 seconds");
    expect(wait).toHaveBeenCalledWith(900_000);
  });

  it("names the static-bearer env source without printing its value", async () => {
    const messages: string[] = [];

    await holdOpenNgrokTunnel({
      endpoint: new URL("https://example.ngrok.app/mcp"),
      seconds: 60,
      auth: {
        mode: "static_bearer",
        bearerTokenEnvName: "MCP_BEARER_TOKEN",
      },
      write: (message) => messages.push(message),
      wait: async () => undefined,
    });

    expect(messages[0]).toContain("static bearer from MCP_BEARER_TOKEN");
    expect(messages[0]).not.toContain("secret-token-value");
  });

  it("parses only bounded whole-second windows", () => {
    expect(parseNgrokHoldOpenSeconds("0", "--hold-open-seconds")).toBe(0);
    expect(parseNgrokHoldOpenSeconds("3600", "--hold-open-seconds")).toBe(3600);
    expect(() =>
      parseNgrokHoldOpenSeconds("1.5", "--hold-open-seconds"),
    ).toThrow("--hold-open-seconds must be an integer from 0 to 3600.");
  });
});
