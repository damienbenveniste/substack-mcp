import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  buildOAuthProtectedResourceMetadata,
  oauthProtectedResourcePath,
} from "./auth/oauth.js";
import {
  type AuthFailure,
  assertHttpAuthConfig,
  requireAuth,
} from "./auth/requireAuth.js";
import {
  type AppConfig,
  assertMcpTransportConfig,
  assertRuntimeSecretConfig,
  getMcpPath,
  loadConfig,
} from "./config.js";
import type { AuditLogger } from "./logging/audit.js";
import { createLogger } from "./logging/logger.js";
import { createMcpServer } from "./server.js";

const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
const CORS_ALLOW_HEADERS =
  "content-type, mcp-session-id, last-event-id, mcp-protocol-version, authorization";
const CORS_EXPOSE_HEADERS =
  "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, X-Request-Id";
const STATELESS_TRANSPORT_OPTIONS = {
  // Omitting sessionIdGenerator is the SDK's stateless Streamable HTTP mode.
  enableJsonResponse: true,
} as const;

export interface HttpServerLogger {
  readonly info: (fields: unknown, message?: string) => void;
  readonly warn: (fields: unknown, message?: string) => void;
  readonly error: (fields: unknown, message?: string) => void;
}

export interface StartHttpServerOptions {
  readonly logger?: HttpServerLogger | undefined;
}

export function startHttpServer(
  config: AppConfig = loadConfig(),
  options: StartHttpServerOptions = {},
) {
  const logger = options.logger ?? createLogger(config);
  const mcpPath = getMcpPath(config);
  const loggedMcpPath = redactMcpPath(mcpPath);

  assertMcpTransportConfig(config, "http");
  assertRuntimeSecretConfig(config);
  assertHttpAuthConfig(config);

  if (config.authMode === "noauth") {
    logger.warn(
      "AUTH_MODE=noauth is intended only for local development, MCP Inspector, and short-lived personal tunnels.",
    );
  }

  const httpServer = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );

    logger.info(
      {
        requestId,
        method: req.method,
        path: redactRequestPath(url.pathname, mcpPath),
      },
      "request",
    );

    if (req.method === "GET" && url.pathname === "/") {
      res
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end("Substack Draft MCP Server");
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, service: "substack-draft-mcp" }));
      return;
    }

    if (
      config.authMode === "oauth" &&
      url.pathname === oauthProtectedResourcePath
    ) {
      if (req.method === "OPTIONS") {
        writeCorsPreflight(res);
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(404).end("Not Found");
        return;
      }

      setCorsHeaders(res);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(buildOAuthProtectedResourceMetadata(config)));
      return;
    }

    if (req.method === "OPTIONS" && url.pathname === mcpPath) {
      writeCorsPreflight(res);
      return;
    }

    if (url.pathname === mcpPath && req.method && MCP_METHODS.has(req.method)) {
      const authResult = await requireAuth(
        { authorizationHeader: req.headers.authorization },
        config,
      );
      if (!authResult.ok) {
        writeAuthFailure(res, authResult);
        return;
      }

      setCorsHeaders(res);

      const mcpServer = createMcpServer(config, {
        auditLogger: auditLoggerWithRequestId(logger, requestId),
        principal: authResult.principal,
      });
      const transport = new StreamableHTTPServerTransport(
        STATELESS_TRANSPORT_OPTIONS,
      );

      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });

      try {
        // SDK 1.29's transport declarations conflict with exactOptionalPropertyTypes.
        await mcpServer.connect(transport as unknown as Transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        logger.error({ requestId, error }, "MCP request failed");
        if (!res.headersSent) {
          res.writeHead(500).end("Internal server error");
        }
      }

      return;
    }

    res.writeHead(404).end("Not Found");
  });

  httpServer.listen(config.port, config.host, () => {
    logger.info(
      { host: config.host, port: config.port, mcpPath: loggedMcpPath },
      `Substack Draft MCP listening on http://${formatHostForLog(config.host)}:${config.port}${loggedMcpPath}`,
    );
  });

  return httpServer;
}

function writeAuthFailure(res: ServerResponse, failure: AuthFailure): void {
  setCorsHeaders(res);
  res
    .writeHead(failure.status, {
      "content-type": "text/plain; charset=utf-8",
      ...failure.headers,
    })
    .end(failure.body);
}

function writeCorsPreflight(res: ServerResponse): void {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
  });
  res.end();
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
}

function auditLoggerWithRequestId(
  logger: Pick<HttpServerLogger, "info" | "warn">,
  requestId: string,
): AuditLogger {
  return {
    info: (fields, message) => {
      logger.info({ ...fields, requestId }, message);
    },
    warn: (fields, message) => {
      logger.warn({ ...fields, requestId }, message);
    },
  };
}

function redactMcpPath(mcpPath: string): string {
  return mcpPath === "/mcp" ? mcpPath : "/mcp/<redacted>";
}

function redactRequestPath(pathname: string, mcpPath: string): string {
  if (mcpPath === "/mcp") {
    return pathname;
  }

  if (pathname === mcpPath) {
    return redactMcpPath(mcpPath);
  }

  const secretPrefix = `${mcpPath}/`;
  if (pathname.startsWith(secretPrefix)) {
    return `${redactMcpPath(mcpPath)}${pathname.slice(mcpPath.length)}`;
  }

  return pathname;
}

function formatHostForLog(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startHttpServer();
}
