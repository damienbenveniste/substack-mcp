import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderRemoteStaticBearerEvidenceArtifact,
  writeRemoteStaticBearerEvidenceArtifact,
} from "../../scripts/remoteStaticBearerEvidence.js";
import {
  assertExpectedTools,
  assertRemoteHealth,
  assertRemoteStaticBearerRejected,
  DEFAULT_REMOTE_WRONG_BEARER_TOKEN,
  EXPECTED_TOOL_NAMES,
  isHelp,
  parseArgs,
  type RemoteSmokeResult,
  redactRemoteUrl,
  remoteHealthUrl,
  shouldLoadEnvFile,
  usage,
} from "../../scripts/smokeRemoteHttpCore.js";

describe("parseArgs", () => {
  it("uses MCP_REMOTE_URL and MCP_BEARER_TOKEN by default", () => {
    const options = parseArgs([], {
      MCP_REMOTE_URL: "https://example.com/mcp",
      MCP_BEARER_TOKEN: " token ",
    });

    expect(options).toMatchObject({
      help: false,
      loadEnvFile: true,
      bearerToken: "token",
      wrongBearerToken: DEFAULT_REMOTE_WRONG_BEARER_TOKEN,
      artifactRoot: process.cwd(),
    });
    if (options.help) {
      throw new Error("Expected runnable smoke-test options.");
    }
    expect(options.url.href).toBe("https://example.com/mcp");
  });

  it("supports explicit URL, custom token env var, evidence artifact, and disabling env files", () => {
    const options = parseArgs(
      [
        "--url",
        "https://example.com/mcp/private-path",
        "--bearer-token-env",
        "REMOTE_TEST_TOKEN",
        "--wrong-bearer-token-env",
        "REMOTE_WRONG_TOKEN",
        "--evidence-artifact",
        ".data/v1/gate-14-static-bearer-remote.md",
        "--no-env-file",
      ],
      {
        MCP_REMOTE_URL: "https://ignored.example/mcp",
        MCP_BEARER_TOKEN: "ignored",
        REMOTE_TEST_TOKEN: "custom-token",
        REMOTE_WRONG_TOKEN: "wrong-token",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      loadEnvFile: false,
      bearerToken: "custom-token",
      wrongBearerToken: "wrong-token",
      artifactRoot: "/repo",
      evidenceArtifact: ".data/v1/gate-14-static-bearer-remote.md",
    });
    if (options.help) {
      throw new Error("Expected runnable smoke-test options.");
    }
    expect(options.url.href).toBe("https://example.com/mcp/private-path");
  });

  it("rejects missing URL, wrong path, missing token, and unknown options", () => {
    expect(() => parseArgs([], { MCP_BEARER_TOKEN: "token" })).toThrow(
      "MCP_REMOTE_URL or --url is required.",
    );
    expect(() =>
      parseArgs(["--url", "ftp://example.com/mcp"], {
        MCP_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL must use https.");
    expect(() =>
      parseArgs(["--url", "http://example.com/mcp"], {
        MCP_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL must use https.");
    expect(() =>
      parseArgs(["--url", "https://user:pass@example.com/mcp"], {
        MCP_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL must not include username or password.");
    expect(() =>
      parseArgs(["--url", "https://example.com/not-mcp"], {
        MCP_BEARER_TOKEN: "token",
      }),
    ).toThrow("Remote MCP URL path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseArgs(["--url", "https://example.com/mcp/private/nested"], {
        MCP_BEARER_TOKEN: "token",
      }),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() => parseArgs(["--url", "https://example.com/mcp"], {})).toThrow(
      "MCP_BEARER_TOKEN must be set",
    );
    expect(() =>
      parseArgs(["--url", "https://example.com/mcp"], {
        MCP_BEARER_TOKEN: "Bearer token",
      }),
    ).toThrow(
      "MCP_BEARER_TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );
    expect(() => parseArgs(["--url"], { MCP_BEARER_TOKEN: "token" })).toThrow(
      "--url requires a value.",
    );
    expect(() =>
      parseArgs(["--bearer-token-env", "--no-env-file"], {
        MCP_BEARER_TOKEN: "token",
      }),
    ).toThrow("--bearer-token-env requires a value.");
    expect(() =>
      parseArgs(
        ["--url", "https://example.com/mcp", "--wrong-bearer-token-env"],
        { MCP_BEARER_TOKEN: "token" },
      ),
    ).toThrow("--wrong-bearer-token-env requires a value.");
    expect(() =>
      parseArgs(
        [
          "--url",
          "https://example.com/mcp",
          "--wrong-bearer-token-env",
          "MISSING",
        ],
        { MCP_BEARER_TOKEN: "token" },
      ),
    ).toThrow("MISSING must be set to a non-empty bearer token.");
    expect(() =>
      parseArgs(
        [
          "--url",
          "https://example.com/mcp",
          "--wrong-bearer-token-env",
          "WRONG_TOKEN",
        ],
        { MCP_BEARER_TOKEN: "same-token", WRONG_TOKEN: "same-token" },
      ),
    ).toThrow(
      "--wrong-bearer-token-env must resolve to a token different from the valid bearer token.",
    );
    expect(() =>
      parseArgs(["--evidence-artifact"], { MCP_BEARER_TOKEN: "token" }),
    ).toThrow("--evidence-artifact requires a value.");
    expect(() =>
      parseArgs(
        [
          "--url",
          "https://example.com/mcp",
          "--evidence-artifact",
          "../outside.md",
        ],
        { MCP_BEARER_TOKEN: "token" },
        "/repo",
      ),
    ).toThrow(
      "remote static-bearer evidence artifact must stay inside the project directory.",
    );
    expect(() => parseArgs(["--bogus"], { MCP_BEARER_TOKEN: "token" })).toThrow(
      "Unknown option: --bogus",
    );
  });

  it("allows help without URL or token configuration", () => {
    expect(parseArgs(["--help"], {})).toEqual({
      help: true,
      loadEnvFile: true,
    });
    expect(parseArgs(["--no-env-file", "-h"], {})).toEqual({
      help: true,
      loadEnvFile: false,
    });
  });
});

describe("remote static-bearer rejection helper", () => {
  it("accepts 401 responses with a Bearer challenge", async () => {
    let requestedUrl: string | undefined;
    let requestedInit: RequestInit | undefined;

    await expect(
      assertRemoteStaticBearerRejected(
        new URL("https://example.com/mcp"),
        "wrong-token",
        async (input, init) => {
          requestedUrl = input.toString();
          requestedInit = init;
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "www-authenticate": 'Bearer realm="mcp"',
            },
          });
        },
      ),
    ).resolves.toBe(401);

    expect(requestedUrl).toBe("https://example.com/mcp");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.body).toContain('"method":"tools/list"');
    expect(requestedInit?.headers).toMatchObject({
      Authorization: "Bearer wrong-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    });
  });

  it("omits Authorization for missing-token rejection checks", async () => {
    let requestedInit: RequestInit | undefined;

    await assertRemoteStaticBearerRejected(
      new URL("https://example.com/mcp"),
      undefined,
      async (_input, init) => {
        requestedInit = init;
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="mcp"',
          },
        });
      },
    );

    expect(requestedInit?.headers).not.toMatchObject({
      Authorization: expect.any(String),
    });
  });

  it("rejects responses that do not prove static-bearer auth enforcement", async () => {
    await expect(
      assertRemoteStaticBearerRejected(
        new URL("https://example.com/mcp"),
        "wrong-token",
        async () => new Response("ok", { status: 200 }),
      ),
    ).rejects.toThrow(
      "Expected remote static bearer rejection to return 401 with Bearer challenge, got HTTP 200.",
    );
    await expect(
      assertRemoteStaticBearerRejected(
        new URL("https://example.com/mcp"),
        "wrong-token",
        async () => new Response("unauthorized", { status: 401 }),
      ),
    ).rejects.toThrow(
      "Expected remote static bearer rejection to return 401 with Bearer challenge, got HTTP 401.",
    );
  });
});

describe("assertExpectedTools", () => {
  it("accepts the V1 draft-only tool surface in any order", () => {
    expect(() =>
      assertExpectedTools([...EXPECTED_TOOL_NAMES].reverse()),
    ).not.toThrow();
  });

  it("rejects missing or extra remote tools", () => {
    expect(() => assertExpectedTools(["list_drafts", "publish_post"])).toThrow(
      "Unexpected remote MCP tool surface.",
    );
  });
});

describe("remote health helpers", () => {
  it("derives the health URL from the remote MCP origin", () => {
    expect(
      remoteHealthUrl(new URL("https://example.com/mcp/private")).toString(),
    ).toBe("https://example.com/healthz");
  });

  it("reports a successful remote health check", async () => {
    await expect(
      assertRemoteHealth(new URL("https://example.com/mcp"), async (url) => {
        expect(url.toString()).toBe("https://example.com/healthz");
        return { ok: true, status: 200 };
      }),
    ).resolves.toEqual({
      url: "https://example.com/healthz",
      status: 200,
    });
  });

  it("fails on unhealthy remote health responses", async () => {
    await expect(
      assertRemoteHealth(new URL("https://example.com/mcp"), async () => ({
        ok: false,
        status: 503,
      })),
    ).rejects.toThrow(
      "Remote health check https://example.com/healthz returned HTTP 503.",
    );
  });
});

describe("redactRemoteUrl", () => {
  it("redacts custom MCP path suffixes from smoke-test output", () => {
    expect(redactRemoteUrl(new URL("https://example.com/mcp"))).toBe(
      "https://example.com/mcp",
    );
    expect(redactRemoteUrl(new URL("https://example.com/mcp/secret"))).toBe(
      "https://example.com/mcp/<redacted>",
    );
    expect(redactRemoteUrl(new URL("https://example.com/status"))).toBe(
      "https://example.com/status",
    );
  });
});

describe("usage helpers", () => {
  it("detects help and env-loading flags", () => {
    expect(isHelp(["--help"])).toBe(true);
    expect(isHelp(["-h"])).toBe(true);
    expect(isHelp([])).toBe(false);
    expect(shouldLoadEnvFile([])).toBe(true);
    expect(shouldLoadEnvFile(["--no-env-file"])).toBe(false);
  });

  it("describes the remote smoke command without embedding secrets", () => {
    expect(usage()).toContain("npm run smoke:remote");
    expect(usage()).toContain("checks /healthz");
    expect(usage()).toContain("MCP_BEARER_TOKEN");
    expect(usage()).toContain("--evidence-artifact");
  });
});

describe("renderRemoteStaticBearerEvidenceArtifact", () => {
  it("renders sanitized static-bearer smoke metadata and client checklist", () => {
    const rendered = renderRemoteStaticBearerEvidenceArtifact(
      baseRemoteSmokeResult,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 Static Bearer Remote Evidence");
    expect(rendered).toContain("- Auth mode: static_bearer");
    expect(rendered).toContain("- Health status: 200");
    expect(rendered).toContain("- Missing bearer status: 401");
    expect(rendered).toContain("- Wrong bearer status: 401");
    expect(rendered).toContain("validate_newsletter_content");
    expect(rendered).toContain(
      "At least one real HTTP client that supports headers was configured with the bearer token.",
    );
    expect(rendered).toContain(
      "- [x] Missing bearer token was rejected with HTTP 401.",
    );
    expect(rendered).toContain(
      "- [x] Wrong bearer token was rejected with HTTP 401.",
    );
    expect(rendered).toContain("## Manual Header-Capable Client Acceptance");
    expect(rendered).toContain(
      "- Client tested: <replace with real header-capable HTTP client name and version>",
    );
    expect(rendered).toContain(
      "- Endpoint tested: <replace with public HTTPS /mcp endpoint tested through the header-capable client>",
    );
    expect(rendered).toContain(
      "- Header configuration method: <replace with how Authorization header was configured without the token value>",
    );
    expect(rendered).toContain(
      "- Tool-list result: <replace with exact seven V1 draft-only tools listed through the client>",
    );
    expect(rendered).toContain(
      "- Validation call result: <replace with validate_newsletter_content success through the client>",
    );
    expect(rendered).toContain(
      "- Rejection proof: <replace with missing and wrong bearer 401 rejection command or artifact reference>",
    );
    expect(rendered).toContain(
      "- Token redaction review: <replace with confirmation that no bearer token or token value is included, recorded, printed, pasted, exposed, or logged>",
    );
    expect(rendered).toContain("npm run v1:record -- --gate 14");
    expect(rendered).toContain(
      "npm run smoke:remote -- --url https://example.com/mcp",
    );
    expect(rendered).not.toContain("draft_body");
    expect(rendered).not.toContain("body_markdown");
    expect(rendered).not.toContain("MCP_BEARER_TOKEN=");
  });
});

describe("writeRemoteStaticBearerEvidenceArtifact", () => {
  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeRemoteStaticBearerEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-14-static-bearer-remote.md",
        result: baseRemoteSmokeResult,
        verifiedAt: "2026-07-08T12:00:00Z",
      });

      expect(result.artifact).toBe(".data/v1/gate-14-static-bearer-remote.md");
      expect(existsSync(result.path)).toBe(true);
      const artifact = readFileSync(result.path, "utf8");

      expect(artifact).toContain("V1 Static Bearer Remote Evidence");
      expect(artifact).toContain(
        "--artifact .data/v1/gate-14-static-bearer-remote.md",
      );
      expect(artifact).not.toContain("<this file>");
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeRemoteStaticBearerEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          result: baseRemoteSmokeResult,
        }),
      ).toThrow(
        "V1 remote static-bearer evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeRemoteStaticBearerEvidenceArtifact({
          cwd,
          artifact: ".data/v1/gate-14-static-bearer-remote.md",
          result: {
            ...baseRemoteSmokeResult,
            endpoint:
              "https://example.com/mcp Authorization: Bearer abcdefghijklmnop",
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/gate-14-static-bearer-remote.md contains secret-like content",
      );
    });
  });
});

const baseRemoteSmokeResult: RemoteSmokeResult = {
  ok: true,
  auth_mode: "static_bearer",
  endpoint: "https://example.com/mcp",
  health: {
    url: "https://example.com/healthz",
    status: 200,
  },
  missing_bearer_status: 401,
  wrong_bearer_status: 401,
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
    blocks: 16,
    words: 100,
    images: 1,
    code_blocks: 1,
    latex_blocks: 1,
    links: 1,
    warning_count: 1,
    unsupported_features: ["table"],
  },
  preview: {
    ok: true,
    fixture: "fixtures/markdown/full-rich-draft.md",
    action: "create",
    title: "[MCP SMOKE] Rich Draft Preview",
    blocks: 16,
    words: 100,
    images: 1,
    code_blocks: 1,
    latex_blocks: 1,
    warning_count: 1,
    confirmation_token_parts: 2,
    confirmation_expires_at: "2026-07-08T13:00:00Z",
    preview_text_chars: 500,
    payload_debug_doc_type: "doc",
    payload_debug_top_level_nodes: 16,
  },
};

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "remote-static-bearer-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
