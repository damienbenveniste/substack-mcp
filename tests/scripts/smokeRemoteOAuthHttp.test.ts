import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderRemoteOAuthEvidenceArtifact,
  writeRemoteOAuthEvidenceArtifact,
} from "../../scripts/remoteOAuthEvidence.js";
import {
  assertOAuthMetadataCors,
  authorizationServerDiscoveryCandidates,
  DEFAULT_OAUTH_BEARER_TOKEN_ENV,
  fetchOAuthAuthorizationServerDiscovery,
  isOAuthHelp,
  oauthUsage,
  parseOAuthArgs,
  protectedResourceMetadataUrl,
  type RemoteOAuthSmokeResult,
  redactOAuthRemoteUrl,
  shouldLoadOAuthEnvFile,
  summarizeOAuthAuthorizationServerDiscovery,
  summarizeOAuthMetadata,
} from "../../scripts/smokeRemoteOAuthHttpCore.js";
import { authScopes } from "../../src/auth/scopes.js";

describe("parseOAuthArgs", () => {
  it("uses MCP_REMOTE_URL and MCP_OAUTH_BEARER_TOKEN by default", () => {
    const options = parseOAuthArgs([], {
      MCP_REMOTE_URL: "https://example.com/mcp",
      MCP_OAUTH_BEARER_TOKEN: " oauth-token ",
      MCP_BEARER_TOKEN: "ignored-static-token",
    });

    expect(options).toMatchObject({
      help: false,
      loadEnvFile: true,
      bearerToken: "oauth-token",
      bearerTokenEnvName: DEFAULT_OAUTH_BEARER_TOKEN_ENV,
      artifactRoot: process.cwd(),
      evidenceArtifact: undefined,
    });
    if (options.help) {
      throw new Error("Expected runnable remote OAuth smoke-test options.");
    }
    expect(options.url.href).toBe("https://example.com/mcp");
  });

  it("supports a project-local evidence artifact path", () => {
    const options = parseOAuthArgs(
      [
        "--url",
        "https://example.com/mcp",
        "--evidence-artifact",
        ".data/v1/remote-oauth.md",
      ],
      {
        MCP_OAUTH_BEARER_TOKEN: "oauth-token",
      },
      "/repo/substack-mcp",
    );

    expect(options).toMatchObject({
      help: false,
      artifactRoot: "/repo/substack-mcp",
      evidenceArtifact: ".data/v1/remote-oauth.md",
    });
  });

  it("supports explicit URL, custom token env var, and disabling env files", () => {
    const options = parseOAuthArgs(
      [
        "--url",
        "https://example.com/mcp/private-path",
        "--bearer-token-env",
        "CHATGPT_ACCESS_TOKEN",
        "--no-env-file",
      ],
      {
        MCP_REMOTE_URL: "https://ignored.example/mcp",
        MCP_OAUTH_BEARER_TOKEN: "ignored",
        CHATGPT_ACCESS_TOKEN: "custom-oauth-token",
      },
    );

    expect(options).toMatchObject({
      help: false,
      loadEnvFile: false,
      bearerToken: "custom-oauth-token",
      bearerTokenEnvName: "CHATGPT_ACCESS_TOKEN",
    });
    if (options.help) {
      throw new Error("Expected runnable remote OAuth smoke-test options.");
    }
    expect(options.url.href).toBe("https://example.com/mcp/private-path");
  });

  it("rejects missing URL, wrong URL shape, missing token, missing option values, and unknown options", () => {
    expect(() =>
      parseOAuthArgs([], { MCP_OAUTH_BEARER_TOKEN: "token" }),
    ).toThrow("MCP_REMOTE_URL or --url is required.");
    expect(() =>
      parseOAuthArgs(["--url", "ftp://example.com/mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL must use https.");
    expect(() =>
      parseOAuthArgs(["--url", "https://user:pass@example.com/mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL must not include username or password.");
    expect(() =>
      parseOAuthArgs(["--url", "http://example.com/mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL must use https.");
    expect(() =>
      parseOAuthArgs(["--url", "https://example.com/not-mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseOAuthArgs(["--url", "https://example.com/mcp/private/nested"], {
        MCP_OAUTH_BEARER_TOKEN: "token",
      }),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() =>
      parseOAuthArgs(["--url", "https://example.com/mcp"], {}),
    ).toThrow("MCP_OAUTH_BEARER_TOKEN must be set");
    expect(() =>
      parseOAuthArgs(["--url", "https://example.com/mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "Bearer oauth-token",
      }),
    ).toThrow(
      "MCP_OAUTH_BEARER_TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );
    expect(() =>
      parseOAuthArgs(["--url", "https://example.com/mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "Authorization: Bearer oauth-token",
      }),
    ).toThrow(
      "MCP_OAUTH_BEARER_TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );
    expect(() =>
      parseOAuthArgs(["--url", "https://example.com/mcp"], {
        MCP_OAUTH_BEARER_TOKEN: "oauth token",
      }),
    ).toThrow(
      "MCP_OAUTH_BEARER_TOKEN must be a single bearer token value without whitespace.",
    );
    expect(() =>
      parseOAuthArgs(["--url"], { MCP_OAUTH_BEARER_TOKEN: "token" }),
    ).toThrow("--url requires a value.");
    expect(() =>
      parseOAuthArgs(["--bearer-token-env", "--no-env-file"], {
        MCP_OAUTH_BEARER_TOKEN: "token",
      }),
    ).toThrow("--bearer-token-env requires a value.");
    expect(() =>
      parseOAuthArgs(
        ["--url", "https://example.com/mcp", "--evidence-artifact"],
        { MCP_OAUTH_BEARER_TOKEN: "token" },
      ),
    ).toThrow("--evidence-artifact requires a value.");
    expect(() =>
      parseOAuthArgs(
        [
          "--url",
          "https://example.com/mcp",
          "--evidence-artifact",
          "../outside.md",
        ],
        { MCP_OAUTH_BEARER_TOKEN: "token" },
        "/repo/substack-mcp",
      ),
    ).toThrow(
      "remote OAuth evidence artifact must stay inside the project directory.",
    );
    expect(() =>
      parseOAuthArgs(["--bogus"], { MCP_OAUTH_BEARER_TOKEN: "token" }),
    ).toThrow("Unknown option: --bogus");
  });

  it("allows help without URL or token configuration", () => {
    expect(parseOAuthArgs(["--help"], {})).toEqual({
      help: true,
      loadEnvFile: true,
    });
    expect(parseOAuthArgs(["--no-env-file", "-h"], {})).toEqual({
      help: true,
      loadEnvFile: false,
    });
  });
});

describe("remote OAuth metadata helpers", () => {
  it("builds the protected-resource metadata URL from the MCP origin", () => {
    expect(
      protectedResourceMetadataUrl(
        new URL("https://example.com/mcp/private"),
      ).toString(),
    ).toBe("https://example.com/.well-known/oauth-protected-resource");
  });

  it("summarizes valid metadata while keeping only recognized auth scopes", () => {
    expect(
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: ["https://issuer.example.com"],
          scopes_supported: [...authScopes, "profile"],
        },
        "https://example.com",
      ),
    ).toEqual({
      resource: "https://example.com",
      authorization_servers: ["https://issuer.example.com"],
      scopes_supported: [...authScopes],
    });
  });

  it("verifies OAuth metadata CORS headers and preflight behavior", async () => {
    await expect(
      assertOAuthMetadataCors(
        new URL("https://example.com/.well-known/oauth-protected-resource"),
        responseWithHeaders({
          "access-control-allow-origin": "*",
        }),
        async (url, init) => {
          expect(url.toString()).toBe(
            "https://example.com/.well-known/oauth-protected-resource",
          );
          expect(init).toEqual({ method: "OPTIONS" });
          return responseWithHeaders(
            {
              "access-control-allow-origin": "*",
              "access-control-allow-headers":
                "content-type, authorization, mcp-protocol-version",
              "access-control-expose-headers":
                "Mcp-Protocol-Version, WWW-Authenticate",
            },
            204,
          );
        },
      ),
    ).resolves.toEqual({
      metadata_allow_origin: "*",
      preflight_status: 204,
      preflight_allow_origin: "*",
      preflight_allows_authorization: true,
      preflight_exposes_www_authenticate: true,
    });
  });

  it("rejects OAuth metadata responses without browser-readable CORS support", async () => {
    const metadataUrl = new URL(
      "https://example.com/.well-known/oauth-protected-resource",
    );

    await expect(
      assertOAuthMetadataCors(metadataUrl, responseWithHeaders({}), async () =>
        responseWithHeaders({}, 204),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata response did not include access-control-allow-origin.",
    );

    await expect(
      assertOAuthMetadataCors(
        metadataUrl,
        responseWithHeaders({
          "access-control-allow-origin": "https://client.example.com",
        }),
        async () => responseWithHeaders({}, 204),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata must allow browser CORS reads with Access-Control-Allow-Origin: *.",
    );

    await expect(
      assertOAuthMetadataCors(
        metadataUrl,
        responseWithHeaders({
          "access-control-allow-origin": "*",
        }),
        async () => responseWithHeaders({}, 200),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata preflight returned HTTP 200; expected 204.",
    );

    await expect(
      assertOAuthMetadataCors(
        metadataUrl,
        responseWithHeaders({
          "access-control-allow-origin": "*",
        }),
        async () =>
          responseWithHeaders(
            {
              "access-control-allow-origin": "https://client.example.com",
              "access-control-allow-headers": "authorization",
              "access-control-expose-headers": "WWW-Authenticate",
            },
            204,
          ),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata preflight must allow browser CORS reads with Access-Control-Allow-Origin: *.",
    );

    await expect(
      assertOAuthMetadataCors(
        metadataUrl,
        responseWithHeaders({
          "access-control-allow-origin": "*",
        }),
        async () =>
          responseWithHeaders(
            {
              "access-control-allow-origin": "*",
              "access-control-allow-headers": "content-type",
              "access-control-expose-headers": "mcp-protocol-version",
            },
            204,
          ),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata preflight must allow the authorization header.",
    );

    await expect(
      assertOAuthMetadataCors(
        metadataUrl,
        responseWithHeaders({
          "access-control-allow-origin": "*",
        }),
        async () =>
          responseWithHeaders(
            {
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "WWW-Authenticate",
            },
            204,
          ),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata preflight must allow the authorization header.",
    );

    await expect(
      assertOAuthMetadataCors(
        metadataUrl,
        responseWithHeaders({
          "access-control-allow-origin": "*",
        }),
        async () =>
          responseWithHeaders(
            {
              "access-control-allow-origin": "*",
              "access-control-allow-headers": "authorization",
              "access-control-expose-headers": "mcp-protocol-version",
            },
            204,
          ),
      ),
    ).rejects.toThrow(
      "OAuth protected-resource metadata preflight must expose WWW-Authenticate.",
    );
  });

  it("rejects metadata with wrong resource, missing issuer, or incomplete scopes", () => {
    expect(() => summarizeOAuthMetadata(null, "https://example.com")).toThrow(
      "OAuth protected-resource metadata resource mismatch.",
    );

    expect(() => summarizeOAuthMetadata([], "https://example.com")).toThrow(
      "OAuth protected-resource metadata resource mismatch.",
    );

    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://wrong.example.com",
          authorization_servers: ["https://issuer.example.com"],
          scopes_supported: [...authScopes],
        },
        "https://example.com",
      ),
    ).toThrow("OAuth protected-resource metadata resource mismatch.");

    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: "https://issuer.example.com",
          scopes_supported: [...authScopes],
        },
        "https://example.com",
      ),
    ).toThrow("authorization_servers");

    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: [],
          scopes_supported: [...authScopes],
        },
        "https://example.com",
      ),
    ).toThrow("authorization_servers");

    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: ["https://issuer.example.com"],
          scopes_supported: ["drafts:read"],
        },
        "https://example.com",
      ),
    ).toThrow("did not include all required scopes");
  });

  it("requires OAuth authorization servers to be valid HTTPS URLs", () => {
    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: ["http://issuer.example.com"],
          scopes_supported: [...authScopes],
        },
        "https://example.com",
      ),
    ).toThrow("authorization_servers must contain only https URLs");

    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: ["https://user:pass@issuer.example.com"],
          scopes_supported: [...authScopes],
        },
        "https://example.com",
      ),
    ).toThrow("authorization_servers must not include username or password");

    expect(() =>
      summarizeOAuthMetadata(
        {
          resource: "https://example.com",
          authorization_servers: ["not a url"],
          scopes_supported: [...authScopes],
        },
        "https://example.com",
      ),
    ).toThrow("authorization_servers must contain valid absolute URLs");
  });

  it("builds authorization-server and OIDC discovery candidates", () => {
    expect(
      authorizationServerDiscoveryCandidates("https://issuer.example.com").map(
        (candidate) => ({
          type: candidate.type,
          url: candidate.url.toString(),
        }),
      ),
    ).toEqual([
      {
        type: "oauth-authorization-server",
        url: "https://issuer.example.com/.well-known/oauth-authorization-server",
      },
      {
        type: "openid-configuration",
        url: "https://issuer.example.com/.well-known/openid-configuration",
      },
    ]);

    expect(
      authorizationServerDiscoveryCandidates(
        "https://issuer.example.com/team-a",
      ).map((candidate) => candidate.url.toString()),
    ).toEqual([
      "https://issuer.example.com/.well-known/oauth-authorization-server/team-a",
      "https://issuer.example.com/team-a/.well-known/openid-configuration",
    ]);
  });

  it("summarizes authorization-server discovery with authorization-code PKCE support", () => {
    expect(
      summarizeOAuthAuthorizationServerDiscovery(
        authorizationServerDiscoveryDocument,
        "https://issuer.example.com",
        new URL(
          "https://issuer.example.com/.well-known/oauth-authorization-server",
        ),
        "oauth-authorization-server",
      ),
    ).toEqual({
      discovery_url:
        "https://issuer.example.com/.well-known/oauth-authorization-server",
      discovery_type: "oauth-authorization-server",
      issuer: "https://issuer.example.com",
      authorization_endpoint: "https://issuer.example.com/authorize",
      token_endpoint: "https://issuer.example.com/token",
      jwks_uri: "https://issuer.example.com/jwks.json",
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("rejects incomplete authorization-server discovery metadata", () => {
    expect(() =>
      summarizeOAuthAuthorizationServerDiscovery(
        {
          ...authorizationServerDiscoveryDocument,
          issuer: "https://wrong.example.com",
        },
        "https://issuer.example.com",
        new URL(
          "https://issuer.example.com/.well-known/oauth-authorization-server",
        ),
        "oauth-authorization-server",
      ),
    ).toThrow("issuer mismatch");

    expect(() =>
      summarizeOAuthAuthorizationServerDiscovery(
        {
          ...authorizationServerDiscoveryDocument,
          token_endpoint: "http://issuer.example.com/token",
        },
        "https://issuer.example.com",
        new URL(
          "https://issuer.example.com/.well-known/oauth-authorization-server",
        ),
        "oauth-authorization-server",
      ),
    ).toThrow("token_endpoint must contain only https URLs");

    expect(() =>
      summarizeOAuthAuthorizationServerDiscovery(
        {
          ...authorizationServerDiscoveryDocument,
          grant_types_supported: ["client_credentials"],
        },
        "https://issuer.example.com",
        new URL(
          "https://issuer.example.com/.well-known/oauth-authorization-server",
        ),
        "oauth-authorization-server",
      ),
    ).toThrow("authorization_code grant support");

    expect(() =>
      summarizeOAuthAuthorizationServerDiscovery(
        {
          ...authorizationServerDiscoveryDocument,
          response_types_supported: ["token"],
        },
        "https://issuer.example.com",
        new URL(
          "https://issuer.example.com/.well-known/oauth-authorization-server",
        ),
        "oauth-authorization-server",
      ),
    ).toThrow("code response support");

    expect(() =>
      summarizeOAuthAuthorizationServerDiscovery(
        {
          ...authorizationServerDiscoveryDocument,
          code_challenge_methods_supported: ["plain"],
        },
        "https://issuer.example.com",
        new URL(
          "https://issuer.example.com/.well-known/oauth-authorization-server",
        ),
        "oauth-authorization-server",
      ),
    ).toThrow("PKCE S256 support");
  });

  it("fetches authorization-server discovery with OIDC fallback", async () => {
    const fetched: string[] = [];
    const discovery = await fetchOAuthAuthorizationServerDiscovery(
      ["https://issuer.example.com"],
      async (url) => {
        fetched.push(url.toString());
        if (url.pathname.includes("oauth-authorization-server")) {
          return responseWithJson({}, 404);
        }
        return responseWithJson(authorizationServerDiscoveryDocument);
      },
    );

    expect(fetched).toEqual([
      "https://issuer.example.com/.well-known/oauth-authorization-server",
      "https://issuer.example.com/.well-known/openid-configuration",
    ]);
    expect(discovery.discovery_type).toBe("openid-configuration");
  });

  it("redacts custom MCP path suffixes from output", () => {
    expect(redactOAuthRemoteUrl(new URL("https://example.com/mcp"))).toBe(
      "https://example.com/mcp",
    );
    expect(
      redactOAuthRemoteUrl(new URL("https://example.com/mcp/private")),
    ).toBe("https://example.com/mcp/<redacted>");
  });

  it("detects help and env-loading flags", () => {
    expect(isOAuthHelp(["--help"])).toBe(true);
    expect(isOAuthHelp(["-h"])).toBe(true);
    expect(isOAuthHelp([])).toBe(false);
    expect(shouldLoadOAuthEnvFile([])).toBe(true);
    expect(shouldLoadOAuthEnvFile(["--no-env-file"])).toBe(false);
  });

  it("describes OAuth remote smoke without embedding bearer tokens", () => {
    expect(oauthUsage()).toContain("npm run smoke:remote-oauth");
    expect(oauthUsage()).toContain("checks /healthz");
    expect(oauthUsage()).toContain("MCP_OAUTH_BEARER_TOKEN");
    expect(oauthUsage()).toContain("--evidence-artifact");
    expect(oauthUsage()).not.toContain("MCP_BEARER_TOKEN");
    expect(oauthUsage()).not.toContain("Bearer ");
  });
});

describe("remote OAuth evidence artifacts", () => {
  it("renders sanitized OAuth metadata and manual launch checklist", () => {
    const rendered = renderRemoteOAuthEvidenceArtifact(
      baseOAuthSmokeResult,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 Remote OAuth Evidence");
    expect(rendered).toContain("- Auth mode: oauth");
    expect(rendered).toContain("OAuth protected-resource metadata");
    expect(rendered).toContain("- Metadata CORS allow-origin: *");
    expect(rendered).toContain(
      "- Authorization server discovery type: oauth-authorization-server",
    );
    expect(rendered).toContain(
      "- Authorization endpoint: https://issuer.example.com/authorize",
    );
    expect(rendered).toContain("- PKCE methods: S256");
    expect(rendered).toContain(
      "- Metadata CORS preflight exposes WWW-Authenticate: yes",
    );
    expect(rendered).toContain("ChatGPT connector completed the OAuth login");
    expect(rendered).toContain("## Manual OAuth Launch Review");
    expect(rendered).toContain(
      "- Browser login result: <replace with authorization-code + PKCE browser login completion summary>",
    );
    expect(rendered).toContain(
      "- Token validation result: <replace with issuer, audience/resource, expiry, and scope checks summary>",
    );
    expect(rendered).toContain(
      "This artifact is not a numbered V1 gate record.",
    );
    expect(rendered).toContain("drafts:read");
    expect(rendered).toContain("create_draft");
    expect(rendered).not.toContain("oauth-token");
    expect(rendered).not.toContain("Authorization: Bearer");
    expect(rendered).not.toContain("draft_body");
  });

  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeRemoteOAuthEvidenceArtifact({
        cwd,
        artifact: ".data/v1/remote-oauth.md",
        result: baseOAuthSmokeResult,
        verifiedAt: "2026-07-08T12:00:00Z",
      });

      expect(result.artifact).toBe(".data/v1/remote-oauth.md");
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path, "utf8")).toContain(
        "V1 Remote OAuth Evidence",
      );
      expect(readFileSync(result.path, "utf8")).toContain(
        "- Evidence artifact: .data/v1/remote-oauth.md",
      );
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeRemoteOAuthEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          result: baseOAuthSmokeResult,
        }),
      ).toThrow(
        "V1 remote OAuth evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeRemoteOAuthEvidenceArtifact({
          cwd,
          artifact: ".data/v1/remote-oauth.md",
          result: {
            ...baseOAuthSmokeResult,
            metadata: {
              ...baseOAuthSmokeResult.metadata,
              authorization_servers: [
                "https://issuer.example.com Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
              ],
            },
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/remote-oauth.md contains secret-like content",
      );
    });
  });
});

const baseOAuthSmokeResult: RemoteOAuthSmokeResult = {
  ok: true,
  auth_mode: "oauth",
  endpoint: "https://example.com/mcp",
  health: {
    url: "https://example.com/healthz",
    status: 200,
  },
  protected_resource_metadata_url:
    "https://example.com/.well-known/oauth-protected-resource",
  metadata: {
    resource: "https://example.com",
    authorization_servers: ["https://issuer.example.com"],
    scopes_supported: [...authScopes],
  },
  metadata_cors: {
    metadata_allow_origin: "*",
    preflight_status: 204,
    preflight_allow_origin: "*",
    preflight_allows_authorization: true,
    preflight_exposes_www_authenticate: true,
  },
  authorization_server: {
    discovery_url:
      "https://issuer.example.com/.well-known/oauth-authorization-server",
    discovery_type: "oauth-authorization-server",
    issuer: "https://issuer.example.com",
    authorization_endpoint: "https://issuer.example.com/authorize",
    token_endpoint: "https://issuer.example.com/token",
    jwks_uri: "https://issuer.example.com/jwks.json",
    grant_types_supported: ["authorization_code"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  },
  tool_count: 7,
  tools: [
    "create_draft",
    "get_draft",
    "list_drafts",
    "preview_draft",
    "update_draft",
    "upload_image",
    "validate_newsletter_content",
  ],
  validation: {
    ok: true,
    fixture: "fixtures/markdown/full-rich-draft.md",
    blocks: 8,
    words: 120,
    images: 1,
    code_blocks: 1,
    latex_blocks: 1,
    links: 1,
    warning_count: 0,
    unsupported_features: [],
  },
  preview: {
    ok: true,
    fixture: "fixtures/markdown/full-rich-draft.md",
    action: "create",
    title: "Rich draft",
    blocks: 8,
    words: 120,
    images: 1,
    code_blocks: 1,
    latex_blocks: 1,
    warning_count: 0,
    confirmation_token_parts: 3,
    confirmation_expires_at: "2026-07-08T13:00:00Z",
    preview_text_chars: 240,
    payload_debug_doc_type: "doc",
    payload_debug_top_level_nodes: 8,
  },
};

const authorizationServerDiscoveryDocument = {
  issuer: "https://issuer.example.com",
  authorization_endpoint: "https://issuer.example.com/authorize",
  token_endpoint: "https://issuer.example.com/token",
  jwks_uri: "https://issuer.example.com/jwks.json",
  grant_types_supported: ["authorization_code", "refresh_token"],
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

function responseWithHeaders(
  headers: Record<string, string>,
  status = 200,
): Pick<Response, "headers" | "status"> {
  return {
    headers: new Headers(headers),
    status,
  };
}

function responseWithJson(
  body: unknown,
  status = 200,
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "remote-oauth-evidence-"));
  try {
    writeFileSync(join(cwd, ".keep"), "");
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
