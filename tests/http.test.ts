import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { DEFAULT_PREVIEW_TOKEN_SECRET } from "../src/config.js";
import { type HttpServerLogger, startHttpServer } from "../src/http.js";

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
  authMode: "static_bearer",
  staticBearerToken: "correct-token",
  oauthJwtAlgorithms: ["RS256", "ES256"],
};
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("HTTP MCP auth", () => {
  it("logs a startup warning when AUTH_MODE=noauth is used", async () => {
    const logger = createMemoryLogger();
    const server = await listen(
      {
        ...baseConfig,
        authMode: "noauth",
        staticBearerToken: undefined,
      },
      { logger },
    );

    try {
      expect(logger.messages("warn")).toContain(
        "AUTH_MODE=noauth is intended only for local development, MCP Inspector, and short-lived personal tunnels.",
      );
    } finally {
      await close(server);
    }
  });

  it("rejects production startup with the development preview token secret", () => {
    expect(() =>
      startHttpServer({
        ...baseConfig,
        nodeEnv: "production",
        previewTokenSecret: DEFAULT_PREVIEW_TOKEN_SECRET,
      }),
    ).toThrow("PREVIEW_TOKEN_SECRET is required when NODE_ENV=production.");
  });

  it("rejects startup when MCP_TRANSPORT is not http", () => {
    expect(() =>
      startHttpServer({
        ...baseConfig,
        mcpTransport: "stdio",
      }),
    ).toThrow("MCP_TRANSPORT=stdio cannot be used with the http entrypoint.");
  });

  it("serves basic local HTTP routes and CORS preflight", async () => {
    const server = await listen({
      ...baseConfig,
      authMode: "noauth",
      staticBearerToken: undefined,
      mcpPathSecret: "secret",
    });

    try {
      const root = await fetch(`${baseUrl(server)}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      expect(root.headers.get("content-type")).toContain("text/plain");
      await expect(root.text()).resolves.toBe("Substack Draft MCP Server");

      const health = await fetch(`${baseUrl(server)}/healthz`);
      expect(health.status).toBe(200);
      expect(health.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      await expect(health.json()).resolves.toEqual({
        ok: true,
        service: "substack-draft-mcp",
      });

      const preflight = await fetch(`${baseUrl(server)}/mcp/secret`, {
        method: "OPTIONS",
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      expect(preflight.headers.get("access-control-allow-methods")).toBe(
        "POST, GET, DELETE, OPTIONS",
      );
      expect(preflight.headers.get("access-control-allow-headers")).toContain(
        "authorization",
      );
      expect(preflight.headers.get("access-control-allow-headers")).toContain(
        "mcp-protocol-version",
      );
      expect(preflight.headers.get("access-control-allow-headers")).toContain(
        "last-event-id",
      );
      expect(preflight.headers.get("access-control-expose-headers")).toContain(
        "WWW-Authenticate",
      );
      expect(preflight.headers.get("access-control-expose-headers")).toContain(
        "X-Request-Id",
      );
      expect(preflight.headers.get("access-control-expose-headers")).toContain(
        "Mcp-Protocol-Version",
      );

      const missing = await fetch(`${baseUrl(server)}/missing`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      await expect(missing.text()).resolves.toBe("Not Found");
    } finally {
      await close(server);
    }
  });

  it("redacts MCP path secrets from startup and request logs", async () => {
    const logger = createMemoryLogger();
    const server = await listen(
      {
        ...baseConfig,
        authMode: "noauth",
        staticBearerToken: undefined,
        mcpPathSecret: "secret-path",
      },
      { logger },
    );

    try {
      const response = await fetch(`${baseUrl(server)}/mcp/secret-path`, {
        method: "OPTIONS",
      });
      expect(response.status).toBe(204);
      const responseRequestId = response.headers.get("x-request-id");
      expect(responseRequestId).toMatch(REQUEST_ID_PATTERN);

      const logs = logger.serializedEntries();
      expect(logs).toContain("/mcp/<redacted>");
      expect(logs).not.toContain("secret-path");
      expect(logger.fields("info")).toContainEqual(
        expect.objectContaining({ mcpPath: "/mcp/<redacted>" }),
      );
      expect(logger.fields("info")).toContainEqual(
        expect.objectContaining({ path: "/mcp/<redacted>" }),
      );
      expect(logger.fields("info")).toContainEqual(
        expect.objectContaining({ requestId: responseRequestId }),
      );
      expect(logger.messages("info")).toContain(
        "Substack Draft MCP listening on http://127.0.0.1:0/mcp/<redacted>",
      );
    } finally {
      await close(server);
    }
  });

  it("uses stateless Streamable HTTP without issuing an MCP session id", async () => {
    const server = await listen({
      ...baseConfig,
      authMode: "noauth",
      staticBearerToken: undefined,
    });

    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: {
              name: "substack-mcp-http-stateless-test",
              version: "0.1.0",
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeNull();
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: {
          serverInfo: {
            name: "substack-draft-mcp",
            version: "0.1.0",
          },
        },
      });
    } finally {
      await close(server);
    }
  });

  it("rejects remote HTTP without the configured static bearer token", async () => {
    const server = await listen(baseConfig);

    try {
      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "POST",
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="substack-draft-mcp"',
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-expose-headers")).toContain(
        "WWW-Authenticate",
      );
      expect(response.headers.get("access-control-expose-headers")).toContain(
        "X-Request-Id",
      );
      await expect(response.text()).resolves.toBe("Unauthorized");
    } finally {
      await close(server);
    }
  });

  it("allows a Streamable HTTP client with the configured static bearer token", async () => {
    const server = await listen(baseConfig);
    const client = new Client({
      name: "substack-mcp-http-test-client",
      version: "0.1.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${baseUrl(server)}/mcp`),
        {
          requestInit: {
            headers: {
              Authorization: "Bearer correct-token",
            },
          },
        },
      );

      await client.connect(transport as unknown as Transport);
      const result = await client.listTools();

      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        "create_draft",
        "get_draft",
        "list_drafts",
        "preview_draft",
        "update_draft",
        "upload_image",
        "validate_newsletter_content",
      ]);
    } finally {
      await client.close();
      await close(server);
    }
  });

  it("correlates HTTP audit events with request IDs", async () => {
    const logger = createMemoryLogger();
    const server = await listen(
      {
        ...baseConfig,
        authMode: "noauth",
        staticBearerToken: undefined,
      },
      { logger },
    );
    const client = new Client({
      name: "substack-mcp-http-audit-test-client",
      version: "0.1.0",
    });

    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${baseUrl(server)}/mcp`),
      );
      await client.connect(transport as unknown as Transport);

      await client.callTool({
        name: "create_draft",
        arguments: {
          title: "Request ID audit test",
          body_format: "markdown_v1",
          body_markdown: "This should fail before Substack.",
          confirmation_token: "invalid-confirmation-token",
        },
      });

      const requestIds = new Set(
        logger
          .fields("info")
          .filter((fields) => fields.method !== undefined)
          .map((fields) => fields.requestId)
          .filter(
            (requestId): requestId is string => typeof requestId === "string",
          ),
      );
      const auditEntries = logger
        .fields("warn")
        .filter((fields) => isMcpAuditLog(fields));

      expect(auditEntries).toHaveLength(1);
      const auditEntry = auditEntries[0];
      if (!auditEntry) {
        throw new Error("Expected an audit log entry.");
      }

      expect(auditEntry).toEqual(
        expect.objectContaining({
          requestId: expect.stringMatching(REQUEST_ID_PATTERN),
          audit: expect.objectContaining({
            event_type: "mcp_audit",
            action: "create_draft",
            outcome: "failure",
            reason: "validation",
          }),
        }),
      );
      const auditRequestId = auditEntry.requestId;
      if (typeof auditRequestId !== "string") {
        throw new Error("Expected audit log requestId to be a string.");
      }
      expect(requestIds.has(auditRequestId)).toBe(true);
    } finally {
      await client.close();
      await close(server);
    }
  });

  it("serves OAuth protected-resource metadata and bearer challenges", async () => {
    const server = await listen({
      ...baseConfig,
      authMode: "oauth",
      publicBaseUrl: "https://mcp.example.test",
      oauthAuthorizationServerUrl: "https://auth.example.test",
      oauthResourceDocumentationUrl: "https://docs.example.test/substack-mcp",
      oauthJwksUrl: "https://auth.example.test/jwks.json",
    });

    try {
      const metadata = await fetch(
        `${baseUrl(server)}/.well-known/oauth-protected-resource`,
      );
      expect(metadata.status).toBe(200);
      expect(metadata.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      expect(metadata.headers.get("access-control-allow-origin")).toBe("*");
      await expect(metadata.json()).resolves.toEqual({
        resource: "https://mcp.example.test",
        authorization_servers: ["https://auth.example.test"],
        scopes_supported: ["drafts:read", "drafts:write", "images:write"],
        resource_documentation: "https://docs.example.test/substack-mcp",
      });

      const metadataPreflight = await fetch(
        `${baseUrl(server)}/.well-known/oauth-protected-resource`,
        { method: "OPTIONS" },
      );
      expect(metadataPreflight.status).toBe(204);
      expect(
        metadataPreflight.headers.get("access-control-allow-headers"),
      ).toContain("authorization");
      expect(
        metadataPreflight.headers.get("access-control-expose-headers"),
      ).toContain("WWW-Authenticate");

      const response = await fetch(`${baseUrl(server)}/mcp`, {
        method: "POST",
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("x-request-id")).toMatch(REQUEST_ID_PATTERN);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="drafts:read drafts:write images:write"',
      );
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-expose-headers")).toContain(
        "WWW-Authenticate",
      );
      await expect(response.text()).resolves.toBe("Unauthorized");
    } finally {
      await close(server);
    }
  });
});

async function listen(
  config: AppConfig,
  options?: Parameters<typeof startHttpServer>[1],
): Promise<Server> {
  const server = startHttpServer(config, options);
  await once(server, "listening");
  return server;
}

function createMemoryLogger(): HttpServerLogger & {
  readonly fields: (
    level: "error" | "info" | "warn",
  ) => readonly Record<string, unknown>[];
  readonly messages: (level: "error" | "info" | "warn") => readonly string[];
  readonly serializedEntries: () => string;
} {
  const entries: Array<{
    readonly level: "error" | "info" | "warn";
    readonly fields: unknown;
    readonly message: string;
  }> = [];
  const record =
    (level: "error" | "info" | "warn") =>
    (fields: unknown, message?: string): void => {
      entries.push({
        level,
        fields,
        message: message ?? (typeof fields === "string" ? fields : ""),
      });
    };

  return {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fields: (level) =>
      entries
        .filter((entry) => entry.level === level)
        .map((entry) =>
          typeof entry.fields === "object" &&
          entry.fields !== null &&
          !Array.isArray(entry.fields)
            ? (entry.fields as Record<string, unknown>)
            : {},
        ),
    messages: (level) =>
      entries
        .filter((entry) => entry.level === level)
        .map((entry) => entry.message),
    serializedEntries: () => JSON.stringify(entries),
  };
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected HTTP server to listen on a TCP port.");
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function isMcpAuditLog(fields: Record<string, unknown>): boolean {
  const audit = fields.audit;
  return (
    typeof audit === "object" &&
    audit !== null &&
    !Array.isArray(audit) &&
    (audit as Record<string, unknown>).event_type === "mcp_audit"
  );
}
