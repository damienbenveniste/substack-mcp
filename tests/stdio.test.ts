import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { startStdioServer } from "../src/stdio.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  port: 0,
  host: "127.0.0.1",
  logLevel: "silent",
  mcpTransport: "http",
  userAgent: "test-agent",
  previewTokenSecret: "test-preview-secret-with-enough-entropy",
  maxBodyBytes: 750_000,
  maxImageBytes: 8_000_000,
  imageFileRoots: [],
  substackRequestTimeoutMs: 30_000,
  confirmationTokenTtlSeconds: 900,
  authMode: "noauth",
  oauthJwtAlgorithms: ["RS256", "ES256"],
};

describe("startStdioServer", () => {
  it("rejects startup when MCP_TRANSPORT is not stdio", async () => {
    await expect(startStdioServer(baseConfig)).rejects.toThrow(
      "MCP_TRANSPORT=http cannot be used with the stdio entrypoint.",
    );
  });
});
