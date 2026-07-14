import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildV1AcceptancePreflight,
  parseV1AcceptancePreflightArgs,
  renderV1AcceptancePreflight,
  shouldFailV1AcceptancePreflight,
  v1AcceptancePreflightUsage,
} from "../../scripts/v1AcceptancePreflightCore.js";

describe("parseV1AcceptancePreflightArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("uses text output and env-file loading by default", () => {
    expect(parseV1AcceptancePreflightArgs([], cwd)).toEqual({
      help: false,
      cwd,
      fixtureDir: `${cwd}/fixtures/substack`,
      format: "text",
      requireLive: false,
      loadEnvFile: true,
    });
  });

  it("parses JSON, live requirement, and env-file options", () => {
    expect(
      parseV1AcceptancePreflightArgs(
        ["--json", "--require-live", "--no-env-file"],
        cwd,
      ),
    ).toEqual({
      help: false,
      cwd,
      fixtureDir: `${cwd}/fixtures/substack`,
      format: "json",
      requireLive: true,
      loadEnvFile: false,
    });
    expect(
      parseV1AcceptancePreflightArgs(["--fixture-dir", "fixtures/live"], cwd),
    ).toMatchObject({
      fixtureDir: `${cwd}/fixtures/live`,
    });

    expect(
      parseV1AcceptancePreflightArgs(["--format", "json"], cwd),
    ).toMatchObject({
      format: "json",
    });
    expect(
      parseV1AcceptancePreflightArgs(["--format", "text"], cwd),
    ).toMatchObject({
      format: "text",
    });
    expect(parseV1AcceptancePreflightArgs(["--local"], cwd)).toMatchObject({
      scope: "local",
    });
  });

  it("allows help and rejects invalid arguments", () => {
    expect(parseV1AcceptancePreflightArgs(["--help"], cwd)).toEqual({
      help: true,
    });
    expect(parseV1AcceptancePreflightArgs(["-h"], cwd)).toEqual({
      help: true,
    });
    expect(() =>
      parseV1AcceptancePreflightArgs(["--format", "yaml"], cwd),
    ).toThrow("--format must be one of: text, json.");
    expect(() => parseV1AcceptancePreflightArgs(["--format"], cwd)).toThrow(
      "--format requires a value.",
    );
    expect(() =>
      parseV1AcceptancePreflightArgs(["--fixture-dir", "../outside"], cwd),
    ).toThrow("--fixture-dir must stay inside the project directory.");
    expect(() => parseV1AcceptancePreflightArgs(["--bogus"], cwd)).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("buildV1AcceptancePreflight", () => {
  it("reports local credential readiness without Cloud Run or release-only checks", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        scope: "local",
        nodeVersion: "22.14.0",
        env: {
          SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
          SUBSTACK_SESSION_TOKEN: "super-secret-session",
          SUBSTACK_USER_ID: "123",
          PREVIEW_TOKEN_SECRET: "super-secret-preview",
        },
        commandExists: (command) => command === "npx",
      });
      const ids = report.checks.map((check) => check.id);
      const text = renderV1AcceptancePreflight(report, "text");

      expect(report).toMatchObject({
        scope: "local",
        live_ready: true,
      });
      expect(ids).toEqual([
        "node_version",
        "inspector_node_version",
        "node_engine",
        "local_mcp_scripts",
        "live_substack_env",
        "live_test_opt_in",
        "tool_npx",
      ]);
      expect(ids).not.toContain("billing_account_env");
      expect(ids).not.toContain("fixture_readiness");
      expect(ids).not.toContain("tool_gcloud");
      expect(ids).not.toContain("tool_ngrok");
      expect(text).toContain("# Local MCP test preflight");
      expect(text).toContain("Live-test ready: yes");
      expect(text).not.toContain("Cloud Billing");
      expect(text).not.toContain("fixture_readiness");
      expect(text).not.toContain("super-secret");
    });
  });

  it("fails local readiness only for required local prerequisites", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        scope: "local",
        nodeVersion: "22.14.0",
        env: {},
        commandExists: () => true,
      });

      expect(report.live_ready).toBe(false);
      expect(
        report.checks.find((check) => check.id === "live_substack_env"),
      ).toMatchObject({
        status: "missing",
        next_action: expect.stringContaining(".data/substack-auth.json"),
      });
      expect(
        shouldFailV1AcceptancePreflight(report, { requireLive: true }),
      ).toBe(true);
    });
  });

  it("reports live prerequisite readiness without printing secret values", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.14.0",
        env: {
          SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
          SUBSTACK_SESSION_TOKEN: "super-secret-session",
          SUBSTACK_USER_ID: "123",
          PREVIEW_TOKEN_SECRET: "super-secret-preview",
          MCP_BEARER_TOKEN: "mcp-bearer-secret",
          MCP_REMOTE_URL: "https://remote.example.com/mcp",
          MCP_PATH_SECRET: "mcp-secret",
          BILLING_ACCOUNT_ID: "000000-111111-222222",
          RUN_LIVE_SUBSTACK_TESTS: "1",
        },
        commandExists: (command) => command === "ngrok" || command === "npx",
      });
      const text = renderV1AcceptancePreflight(report, "text");

      expect(report.live_ready).toBe(false);
      expect(
        report.checks.find((check) => check.id === "node_version"),
      ).toMatchObject({
        status: "ok",
      });
      expect(
        report.checks.find((check) => check.id === "inspector_node_version"),
      ).toMatchObject({
        status: "ok",
      });
      expect(
        report.checks.find((check) => check.id === "node_engine"),
      ).toMatchObject({
        status: "ok",
        evidence: "engines.node: >=20",
      });
      expect(
        report.checks.find((check) => check.id === "live_substack_env"),
      ).toMatchObject({
        status: "ok",
      });
      expect(
        report.checks.find((check) => check.id === "live_substack_env")
          ?.evidence,
      ).toContain("invalid: none");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("smoke:docker-http");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("cloud-run:verify");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("smoke:inspector");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("smoke:remote-oauth");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("smoke:ngrok-noauth");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("smoke:ngrok-oauth");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("smoke:ngrok-static-bearer");
      expect(
        report.checks.find((check) => check.id === "v1_scripts")?.evidence,
      ).toContain("validate:v1-local");
      expect(
        report.checks.find((check) => check.id === "tool_npx"),
      ).toMatchObject({
        status: "ok",
      });
      expect(
        report.checks.find((check) => check.id === "tool_ngrok"),
      ).toMatchObject({
        status: "ok",
      });
      expect(
        report.checks.find((check) => check.id === "tool_gcloud"),
      ).toMatchObject({
        status: "warning",
      });
      expect(
        report.checks.find((check) => check.id === "static_bearer_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "present; invalid: none",
      });
      expect(
        report.checks.find((check) => check.id === "remote_mcp_url_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "present; valid HTTPS MCP endpoint path",
      });
      expect(
        report.checks.find((check) => check.id === "mcp_path_secret_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "present; valid single URL-safe path segment",
      });
      expect(
        report.checks.find((check) => check.id === "oauth_remote_env"),
      ).toMatchObject({
        status: "ok",
        evidence:
          "AUTH_MODE=noauth; OAuth metadata is not required for this mode.",
      });
      expect(
        report.checks.find((check) => check.id === "billing_account_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "present",
      });
      expect(
        report.checks.find(
          (check) => check.id === "live_evidence_artifact_env",
        ),
      ).toMatchObject({
        status: "ok",
        evidence:
          "not set; live tests can run without writing evidence artifacts",
      });
      expect(
        report.checks.find((check) => check.id === "substack_fixture_dir_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "not set; compatibility test uses fixtures/substack",
      });
      expect(
        report.checks.find((check) => check.id === "fixture_readiness"),
      ).toMatchObject({
        status: "missing",
        next_action: expect.stringContaining(
          "Run `npm run fixtures:status` for per-fixture capture commands",
        ),
      });
      expect(
        report.checks.find((check) => check.id === "fixture_readiness")
          ?.next_action,
      ).toContain(
        "`npm test -- tests/content/substackFixtureCompatibility.test.ts`",
      );
      expect(text).toContain("Live-ready: no");
      expect(text).toContain("SUBSTACK_SESSION_TOKEN");
      expect(text).not.toContain("super-secret-session");
      expect(text).not.toContain("super-secret-preview");
      expect(text).not.toContain("mcp-bearer-secret");
      expect(text).not.toContain("remote.example.com");
      expect(text).not.toContain("mcp-secret");
      expect(
        shouldFailV1AcceptancePreflight(report, { requireLive: true }),
      ).toBe(true);
      expect(
        shouldFailV1AcceptancePreflight(report, { requireLive: false }),
      ).toBe(false);
    });
  });

  it("warns when the current Node runtime can run the server but not the Inspector CLI helper", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "20.19.0",
        env: {},
        commandExists: () => true,
      });
      const inspectorNode = report.checks.find(
        (check) => check.id === "inspector_node_version",
      );

      expect(
        report.checks.find((check) => check.id === "node_version"),
      ).toMatchObject({
        status: "ok",
      });
      expect(inspectorNode).toMatchObject({
        status: "warning",
        label:
          "Node.js runtime supports the current MCP Inspector CLI gate 3 helper.",
        evidence:
          "node 20.19.0; @modelcontextprotocol/inspector@latest currently requires node >=22.7.5.",
        next_action:
          "Use Node.js 22.7.5+ when running `npm run smoke:inspector`, or use manual MCP Inspector UI verification for gate 3.",
      });
      expect(report.live_ready).toBe(false);
    });
  });

  it("handles exact and unparsable Node versions in the Inspector CLI helper check", () => {
    withTempProject((cwd) => {
      const exactMinimumReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.7.5",
        env: {},
        commandExists: () => true,
      });
      expect(
        exactMinimumReport.checks.find(
          (check) => check.id === "inspector_node_version",
        ),
      ).toMatchObject({
        status: "ok",
      });

      const unparsableReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "nightly",
        env: {},
        commandExists: () => true,
      });
      expect(
        unparsableReport.checks.find(
          (check) => check.id === "inspector_node_version",
        ),
      ).toMatchObject({
        status: "warning",
        evidence:
          "node nightly; @modelcontextprotocol/inspector@latest currently requires node >=22.7.5.",
      });
    });
  });

  it("rejects malformed live env values without printing secrets", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          SUBSTACK_PUBLICATION_URL: "http://127.0.0.1/private",
          SUBSTACK_SESSION_TOKEN:
            "connect.sid=super-secret-session; substack.sid=super-secret-session",
          SUBSTACK_USER_ID: "not-a-number",
          PREVIEW_TOKEN_SECRET:
            "development-only-preview-token-secret-change-me",
          RUN_LIVE_SUBSTACK_TESTS: "1",
        },
        commandExists: () => true,
      });
      const liveEnv = report.checks.find(
        (check) => check.id === "live_substack_env",
      );
      const text = renderV1AcceptancePreflight(report, "text");

      expect(liveEnv).toMatchObject({
        status: "missing",
        next_action: expect.stringContaining("npm run auth:setup"),
      });
      expect(liveEnv?.evidence).toContain("missing: none");
      expect(liveEnv?.evidence).toContain(
        "SUBSTACK_PUBLICATION_URL must not point to localhost or private network addresses.",
      );
      expect(liveEnv?.evidence).toContain(
        "SUBSTACK_USER_ID must be a positive integer.",
      );
      expect(liveEnv?.evidence).toContain(
        "SUBSTACK_SESSION_TOKEN must be the cookie value only, not a Cookie header or name=value pair.",
      );
      expect(liveEnv?.evidence).toContain(
        "PREVIEW_TOKEN_SECRET must not use the development default.",
      );
      expect(report.live_ready).toBe(false);
      expect(text).not.toContain("super-secret-session");
      expect(text).not.toContain("http://127.0.0.1/private");
      expect(text).not.toContain("not-a-number");
    });
  });

  it("warns when the static bearer token env includes an Authorization header", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          MCP_BEARER_TOKEN: "Bearer mcp-secret",
        },
        commandExists: () => true,
      });
      const check = report.checks.find(
        (item) => item.id === "static_bearer_env",
      );
      const text = renderV1AcceptancePreflight(report, "text");

      expect(check).toMatchObject({
        status: "warning",
        next_action: expect.stringContaining("token value only"),
      });
      expect(check?.evidence).toContain(
        "MCP_BEARER_TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
      );
      expect(text).not.toContain("mcp-secret");
    });
  });

  it("checks MCP_REMOTE_URL shape without requiring it or printing it", () => {
    withTempProject((cwd) => {
      const missingReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });
      expect(
        missingReport.checks.find((check) => check.id === "remote_mcp_url_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "not set; remote smoke commands can use --url instead",
      });

      const httpReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          MCP_REMOTE_URL: "http://remote.example.com/mcp",
        },
        commandExists: () => true,
      });
      expect(
        httpReport.checks.find((check) => check.id === "remote_mcp_url_env"),
      ).toMatchObject({
        status: "warning",
        evidence: "present; invalid: Remote MCP URL must use https.",
        next_action: expect.stringContaining("HTTPS /mcp"),
      });
      expect(renderV1AcceptancePreflight(httpReport, "text")).not.toContain(
        "remote.example.com",
      );

      const credentialedReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          MCP_REMOTE_URL: "https://user:pass@remote.example.com/mcp",
        },
        commandExists: () => true,
      });
      expect(
        credentialedReport.checks.find(
          (check) => check.id === "remote_mcp_url_env",
        ),
      ).toMatchObject({
        status: "warning",
        evidence:
          "present; invalid: Remote MCP URL must not include username or password.",
      });
      expect(
        renderV1AcceptancePreflight(credentialedReport, "text"),
      ).not.toContain("user:pass");

      const malformedReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          MCP_REMOTE_URL: "not a url",
        },
        commandExists: () => true,
      });
      expect(
        malformedReport.checks.find(
          (check) => check.id === "remote_mcp_url_env",
        ),
      ).toMatchObject({
        status: "warning",
        evidence:
          "present; invalid: MCP_REMOTE_URL must be a valid absolute URL.",
      });
      expect(
        renderV1AcceptancePreflight(malformedReport, "text"),
      ).not.toContain("not a url");
    });
  });

  it("checks MCP_PATH_SECRET shape without requiring it or printing it", () => {
    withTempProject((cwd) => {
      const missingReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });
      expect(
        missingReport.checks.find(
          (check) => check.id === "mcp_path_secret_env",
        ),
      ).toMatchObject({
        status: "ok",
        evidence: "not set; MCP endpoint remains /mcp",
      });

      const validReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          MCP_PATH_SECRET: "private-path",
        },
        commandExists: () => true,
      });
      expect(
        validReport.checks.find((check) => check.id === "mcp_path_secret_env"),
      ).toMatchObject({
        status: "ok",
        evidence: "present; valid single URL-safe path segment",
      });
      expect(renderV1AcceptancePreflight(validReport, "text")).not.toContain(
        "private-path",
      );

      for (const value of ["secret/path", ".", ".."]) {
        const report = buildV1AcceptancePreflight({
          cwd,
          nodeVersion: "22.1.0",
          env: {
            MCP_PATH_SECRET: value,
          },
          commandExists: () => true,
        });
        expect(
          report.checks.find((check) => check.id === "mcp_path_secret_env"),
        ).toMatchObject({
          status: "warning",
          evidence: expect.stringContaining(
            "MCP_PATH_SECRET must be one URL-safe path segment",
          ),
          next_action: expect.stringContaining("one URL-safe path segment"),
        });
        if (value === "secret/path") {
          expect(renderV1AcceptancePreflight(report, "text")).not.toContain(
            value,
          );
        }
      }
    });
  });

  it("checks live evidence artifact env paths without requiring or printing them", () => {
    withTempProject((cwd) => {
      const missingReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });
      expect(
        missingReport.checks.find(
          (check) => check.id === "live_evidence_artifact_env",
        ),
      ).toMatchObject({
        status: "ok",
        evidence:
          "not set; live tests can run without writing evidence artifacts",
      });

      const validReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS:
            ".data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md",
        },
        commandExists: () => true,
      });
      expect(
        validReport.checks.find(
          (check) => check.id === "live_evidence_artifact_env",
        ),
      ).toMatchObject({
        status: "ok",
        evidence: "configured: 2 project-local artifact path(s)",
      });
      expect(renderV1AcceptancePreflight(validReport, "text")).not.toContain(
        ".data/v1/gate-07-rich-draft-live-fixtures.md",
      );

      const emptyListReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS: ",\n,",
        },
        commandExists: () => true,
      });
      expect(
        emptyListReport.checks.find(
          (check) => check.id === "live_evidence_artifact_env",
        ),
      ).toMatchObject({
        status: "warning",
        evidence: "configured; invalid: no artifact paths configured",
        next_action: expect.stringContaining(
          "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS",
        ),
      });

      const outsideReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACT:
            "../outside-secret-live-evidence.md",
        },
        commandExists: () => true,
      });
      expect(
        outsideReport.checks.find(
          (check) => check.id === "live_evidence_artifact_env",
        ),
      ).toMatchObject({
        status: "warning",
        evidence:
          "configured: 1 artifact path(s); invalid: V1 live evidence artifact must stay inside the project directory.",
        next_action: expect.stringContaining("project-local Markdown paths"),
      });
      expect(renderV1AcceptancePreflight(outsideReport, "text")).not.toContain(
        "outside-secret-live-evidence",
      );
    });
  });

  it("checks SUBSTACK_FIXTURE_DIR without requiring or printing it", () => {
    withTempProject((cwd) => {
      const missingReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });
      expect(
        missingReport.checks.find(
          (check) => check.id === "substack_fixture_dir_env",
        ),
      ).toMatchObject({
        status: "ok",
        evidence: "not set; compatibility test uses fixtures/substack",
      });

      const matchingReport = buildV1AcceptancePreflight({
        cwd,
        fixtureDir: resolve(cwd, "fixtures", "live"),
        nodeVersion: "22.1.0",
        env: {
          SUBSTACK_FIXTURE_DIR: "fixtures/live",
        },
        commandExists: () => true,
      });
      expect(
        matchingReport.checks.find(
          (check) => check.id === "substack_fixture_dir_env",
        ),
      ).toMatchObject({
        status: "ok",
        evidence: "present; matches the preflight fixture directory",
      });

      const mismatchReport = buildV1AcceptancePreflight({
        cwd,
        fixtureDir: resolve(cwd, "fixtures", "live"),
        nodeVersion: "22.1.0",
        env: {
          SUBSTACK_FIXTURE_DIR: "fixtures/other-secret-fixtures",
        },
        commandExists: () => true,
      });
      expect(
        mismatchReport.checks.find(
          (check) => check.id === "substack_fixture_dir_env",
        ),
      ).toMatchObject({
        status: "warning",
        evidence:
          "present; valid project-local fixture directory, but it differs from the preflight fixture directory",
        next_action: expect.stringContaining("same project-local fixture"),
      });
      expect(renderV1AcceptancePreflight(mismatchReport, "text")).not.toContain(
        "other-secret-fixtures",
      );

      const outsideReport = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          SUBSTACK_FIXTURE_DIR: "../outside-secret-fixtures",
        },
        commandExists: () => true,
      });
      expect(
        outsideReport.checks.find(
          (check) => check.id === "substack_fixture_dir_env",
        ),
      ).toMatchObject({
        status: "warning",
        evidence:
          "present; invalid: SUBSTACK_FIXTURE_DIR must stay inside the project directory.",
      });
      expect(renderV1AcceptancePreflight(outsideReport, "text")).not.toContain(
        "outside-secret-fixtures",
      );
    });
  });

  it("warns when the Cloud Billing budget account id is missing", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });
      const check = report.checks.find(
        (item) => item.id === "billing_account_env",
      );

      expect(check).toMatchObject({
        status: "warning",
        evidence: "missing",
        next_action: expect.stringContaining("BILLING_ACCOUNT_ID"),
      });
    });
  });

  it("warns when OAuth mode is selected without valid remote metadata", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          AUTH_MODE: "oauth",
          MCP_PUBLIC_BASE_URL: "http://mcp.example.test",
          OAUTH_AUTHORIZATION_SERVER_URL: "https://auth.example.test",
        },
        commandExists: () => true,
      });
      const check = report.checks.find(
        (item) => item.id === "oauth_remote_env",
      );
      const text = renderV1AcceptancePreflight(report, "text");

      expect(check).toMatchObject({
        status: "warning",
        next_action: expect.stringContaining("MCP_PUBLIC_BASE_URL"),
      });
      expect(check?.evidence).toContain("AUTH_MODE=oauth");
      expect(check?.evidence).toContain(
        "OAUTH_JWKS_URL is required when AUTH_MODE=oauth.",
      );
      expect(text).not.toContain("http://mcp.example.test");
      expect(text).not.toContain("https://auth.example.test");
    });
  });

  it("warns when OAuth metadata URLs include embedded credentials", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          AUTH_MODE: "oauth",
          MCP_PUBLIC_BASE_URL: "https://user:pass@mcp.example.test",
          OAUTH_AUTHORIZATION_SERVER_URL: "https://auth.example.test",
          OAUTH_JWKS_URL: "https://auth.example.test/jwks.json",
        },
        commandExists: () => true,
      });
      const check = report.checks.find(
        (item) => item.id === "oauth_remote_env",
      );
      const text = renderV1AcceptancePreflight(report, "text");

      expect(check).toMatchObject({
        status: "warning",
        evidence:
          "AUTH_MODE=oauth; MCP_PUBLIC_BASE_URL must not include username or password.",
        next_action: expect.stringContaining("without embedded credentials"),
      });
      expect(text).not.toContain("user:pass");
    });
  });

  it("reports OAuth remote metadata readiness without requiring live completion", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          AUTH_MODE: "oauth",
          MCP_PUBLIC_BASE_URL: "https://mcp.example.test",
          OAUTH_AUTHORIZATION_SERVER_URL: "https://auth.example.test",
          OAUTH_RESOURCE_DOCUMENTATION_URL: "https://docs.example.test/mcp",
          OAUTH_JWKS_URL: "https://auth.example.test/jwks.json",
          OAUTH_JWT_ALGORITHMS: "RS256, ES256",
        },
        commandExists: () => true,
      });

      expect(
        report.checks.find((check) => check.id === "oauth_remote_env"),
      ).toMatchObject({
        status: "ok",
        evidence:
          "AUTH_MODE=oauth; required OAuth metadata is present and uses https; algorithms: RS256, ES256",
      });
      expect(report.live_ready).toBe(false);
    });
  });

  it("warns when OAuth mode uses unsafe JWT algorithms", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          AUTH_MODE: "oauth",
          MCP_PUBLIC_BASE_URL: "https://mcp.example.test",
          OAUTH_AUTHORIZATION_SERVER_URL: "https://auth.example.test",
          OAUTH_JWKS_URL: "https://auth.example.test/jwks.json",
          OAUTH_JWT_ALGORITHMS: "RS256,HS256,none",
        },
        commandExists: () => true,
      });

      expect(
        report.checks.find((check) => check.id === "oauth_remote_env"),
      ).toMatchObject({
        status: "warning",
        evidence: expect.stringContaining(
          "unsupported or unsafe algorithm(s): HS256, none",
        ),
      });
    });
  });

  it("warns when AUTH_MODE is not one of the supported modes", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {
          AUTH_MODE: "apikey",
        },
        commandExists: () => true,
      });

      expect(
        report.checks.find((check) => check.id === "oauth_remote_env"),
      ).toMatchObject({
        status: "warning",
        evidence: "AUTH_MODE is invalid.",
        next_action: "Set AUTH_MODE to one of: noauth, static_bearer, oauth.",
      });
    });
  });

  it("reports missing scripts, env names, and old node versions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "v1-preflight-minimal-"));
    try {
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );

      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "18.19.0",
        env: {},
        commandExists: () => false,
      });

      expect(report.live_ready).toBe(false);
      expect(report.summary.missing).toBeGreaterThanOrEqual(3);
      expect(
        report.checks.find((check) => check.id === "node_version"),
      ).toMatchObject({
        status: "missing",
      });
      expect(
        report.checks.find((check) => check.id === "v1_scripts"),
      ).toMatchObject({
        status: "missing",
      });
      expect(
        report.checks.find((check) => check.id === "node_engine"),
      ).toMatchObject({
        status: "missing",
        evidence: "engines.node missing",
      });
      expect(
        report.checks.find((check) => check.id === "live_substack_env"),
      ).toMatchObject({
        status: "missing",
      });
      expect(renderV1AcceptancePreflight(report, "json")).toContain(
        '"live_ready": false',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("reports custom fixture directory readiness commands", () => {
    withTempProject((cwd) => {
      const report = buildV1AcceptancePreflight({
        cwd,
        fixtureDir: resolve(cwd, "fixtures", "live captures"),
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });
      const fixtureCheck = report.checks.find(
        (check) => check.id === "fixture_readiness",
      );

      expect(fixtureCheck).toMatchObject({
        status: "missing",
      });
      expect(fixtureCheck?.evidence).toContain(`${cwd}/fixtures/live captures`);
      expect(fixtureCheck?.next_action).toContain(
        "npm run fixtures:status -- --fixture-dir 'fixtures/live captures'",
      );
      expect(fixtureCheck?.next_action).toContain(
        "npm run fixtures:status -- --fixture-dir 'fixtures/live captures' --require-all",
      );
      expect(fixtureCheck?.next_action).toContain(
        "SUBSTACK_FIXTURE_DIR='fixtures/live captures' npm test -- tests/content/substackFixtureCompatibility.test.ts",
      );
    });
  });

  it("uses the default PATH scanner when no command lookup is injected", () => {
    withTempProject((cwd) => {
      const binDir = resolve(cwd, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "ngrok"), "");
      writeFileSync(join(binDir, "npx"), "");
      const previousPath = process.env.PATH;
      process.env.PATH = binDir;
      try {
        const report = buildV1AcceptancePreflight({
          cwd,
          nodeVersion: "22.1.0",
          env: {
            SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
            SUBSTACK_SESSION_TOKEN: "secret",
            SUBSTACK_USER_ID: "123",
            PREVIEW_TOKEN_SECRET: "secret",
            MCP_BEARER_TOKEN: "secret",
            BILLING_ACCOUNT_ID: "000000-111111-222222",
            RUN_LIVE_SUBSTACK_TESTS: "1",
          },
        });

        expect(
          report.checks.find((check) => check.id === "tool_npx"),
        ).toMatchObject({
          status: "ok",
        });
        expect(
          report.checks.find((check) => check.id === "tool_ngrok"),
        ).toMatchObject({
          status: "ok",
        });
        expect(
          report.checks.find((check) => check.id === "tool_gcloud"),
        ).toMatchObject({
          status: "warning",
        });
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("handles malformed and missing package manifests defensively", () => {
    const missingPackageCwd = mkdtempSync(
      join(tmpdir(), "v1-preflight-missing-"),
    );
    const invalidPackageCwd = mkdtempSync(
      join(tmpdir(), "v1-preflight-invalid-"),
    );
    const primitivePackageCwd = mkdtempSync(
      join(tmpdir(), "v1-preflight-primitive-"),
    );
    try {
      writeFileSync(join(invalidPackageCwd, "package.json"), "{");
      writeFileSync(join(primitivePackageCwd, "package.json"), "false");

      for (const cwd of [
        missingPackageCwd,
        invalidPackageCwd,
        primitivePackageCwd,
      ]) {
        const report = buildV1AcceptancePreflight({
          cwd,
          nodeVersion: "22.1.0",
          env: {},
          commandExists: () => false,
        });

        expect(
          report.checks.find((check) => check.id === "v1_scripts"),
        ).toMatchObject({
          status: "missing",
        });
        expect(
          report.checks.find((check) => check.id === "node_engine"),
        ).toMatchObject({
          status: "missing",
        });
      }
    } finally {
      rmSync(missingPackageCwd, { recursive: true, force: true });
      rmSync(invalidPackageCwd, { recursive: true, force: true });
      rmSync(primitivePackageCwd, { recursive: true, force: true });
    }
  });

  it("requires the package manifest to declare a Node 20 runtime floor", () => {
    withTempProject((cwd) => {
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          engines: {
            node: ">=18",
          },
          scripts: {
            "cloud-run:logs:verify": "tsx scripts/cloudRunLogsVerify.ts",
            "cloud-run:plan": "tsx scripts/cloudRunPlan.ts",
            "cloud-run:verify": "tsx scripts/cloudRunVerify.ts",
            "create:fixture": "tsx scripts/createFixtureDraft.ts",
            "fixtures:status": "tsx scripts/fixtureStatus.ts",
            "inspect:draft": "tsx scripts/inspectDraft.ts",
            "smoke:inspector": "tsx scripts/smokeLocalHttp.ts --inspector-cli",
            "smoke:docker-http": "tsx scripts/smokeDockerHttp.ts",
            "smoke:http-local": "tsx scripts/smokeLocalHttp.ts",
            "smoke:http-oauth": "tsx scripts/smokeLocalOAuthHttp.ts",
            "smoke:http-static-bearer":
              "tsx scripts/smokeLocalStaticBearerHttp.ts",
            "smoke:ngrok-noauth": "tsx scripts/smokeNgrokNoAuthHttp.ts",
            "smoke:ngrok-oauth": "tsx scripts/smokeNgrokOAuthHttp.ts",
            "smoke:ngrok-static-bearer":
              "tsx scripts/smokeNgrokStaticBearerHttp.ts",
            "smoke:remote": "tsx scripts/smokeRemoteHttp.ts",
            "smoke:remote-noauth": "tsx scripts/smokeRemoteNoAuthHttp.ts",
            "smoke:remote-oauth": "tsx scripts/smokeRemoteOAuthHttp.ts",
            "smoke:stdio": "tsx scripts/smokeLocalStdio.ts",
            "test:live": "vitest run tests/live",
            "v1:preflight": "tsx scripts/v1AcceptancePreflight.ts",
            "v1:record": "tsx scripts/recordV1Evidence.ts",
            "v1:runbook": "tsx scripts/v1AcceptanceRunbook.ts",
            "v1:status": "tsx scripts/v1AcceptanceStatus.ts",
            "validate:v1-local": "npm run fixtures:status",
          },
        }),
      );

      const report = buildV1AcceptancePreflight({
        cwd,
        nodeVersion: "22.1.0",
        env: {},
        commandExists: () => true,
      });

      expect(
        report.checks.find((check) => check.id === "node_engine"),
      ).toMatchObject({
        status: "missing",
        evidence: "engines.node: >=18",
        next_action: "Set package.json engines.node to >=20.",
      });
      expect(report.live_ready).toBe(false);
    });
  });

  it("renders a synthetic live-ready report", () => {
    const report = {
      live_ready: true,
      summary: {
        ok: 1,
        missing: 0,
        warning: 0,
      },
      checks: [
        {
          id: "synthetic",
          status: "ok" as const,
          label: "Synthetic check.",
          evidence: "ready",
        },
      ],
    };

    const text = renderV1AcceptancePreflight(report, "text");
    expect(text).toContain("Live-ready: yes");
    expect(text).not.toContain("Next:");
    expect(shouldFailV1AcceptancePreflight(report, { requireLive: true })).toBe(
      false,
    );
  });

  it("prints usage text", () => {
    expect(v1AcceptancePreflightUsage()).toContain("npm run v1:preflight");
    expect(v1AcceptancePreflightUsage()).toContain("--fixture-dir");
    expect(v1AcceptancePreflightUsage()).toContain("--require-live");
    expect(v1AcceptancePreflightUsage()).toContain("--local");
    expect(v1AcceptancePreflightUsage()).toContain("npm run mcp:preflight");
    expect(v1AcceptancePreflightUsage()).toContain("live fixture env");
    expect(v1AcceptancePreflightUsage()).toContain(
      "live evidence artifact env",
    );
    expect(v1AcceptancePreflightUsage()).toContain("remote MCP URL env");
    expect(v1AcceptancePreflightUsage()).toContain("MCP path secret env");
    expect(v1AcceptancePreflightUsage()).toContain("auth-mode");
  });
});

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "v1-preflight-"));
  try {
    mkdirSync(resolve(cwd, "fixtures", "substack"), { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        engines: {
          node: ">=20",
        },
        scripts: {
          "auth:setup": "tsx scripts/substackAuthSetup.ts",
          build: "tsc -p tsconfig.build.json",
          "dev:http": "tsx src/http.ts",
          "dev:stdio": "tsx src/stdio.ts",
          "cloud-run:logs:verify": "tsx scripts/cloudRunLogsVerify.ts",
          "cloud-run:plan": "tsx scripts/cloudRunPlan.ts",
          "cloud-run:verify": "tsx scripts/cloudRunVerify.ts",
          "create:fixture": "tsx scripts/createFixtureDraft.ts",
          "fixtures:status": "tsx scripts/fixtureStatus.ts",
          "inspect:draft": "tsx scripts/inspectDraft.ts",
          "mcp:preflight": "tsx scripts/v1AcceptancePreflight.ts --local",
          "smoke:inspector": "tsx scripts/smokeLocalHttp.ts --inspector-cli",
          "smoke:docker-http": "tsx scripts/smokeDockerHttp.ts",
          "smoke:http-local": "tsx scripts/smokeLocalHttp.ts",
          "smoke:http-oauth": "tsx scripts/smokeLocalOAuthHttp.ts",
          "smoke:http-static-bearer":
            "tsx scripts/smokeLocalStaticBearerHttp.ts",
          "smoke:ngrok-noauth": "tsx scripts/smokeNgrokNoAuthHttp.ts",
          "smoke:ngrok-oauth": "tsx scripts/smokeNgrokOAuthHttp.ts",
          "smoke:ngrok-static-bearer":
            "tsx scripts/smokeNgrokStaticBearerHttp.ts",
          "smoke:remote": "tsx scripts/smokeRemoteHttp.ts",
          "smoke:remote-noauth": "tsx scripts/smokeRemoteNoAuthHttp.ts",
          "smoke:remote-oauth": "tsx scripts/smokeRemoteOAuthHttp.ts",
          "smoke:stdio": "tsx scripts/smokeLocalStdio.ts",
          "test:live": "vitest run tests/live",
          "test:mcp-local":
            "npm run build && npm run smoke:http-local && npm run smoke:stdio",
          "v1:preflight": "tsx scripts/v1AcceptancePreflight.ts",
          "v1:record": "tsx scripts/recordV1Evidence.ts",
          "v1:runbook": "tsx scripts/v1AcceptanceRunbook.ts",
          "v1:status": "tsx scripts/v1AcceptanceStatus.ts",
          "validate:v1-local": "npm run fixtures:status",
        },
      }),
    );
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
