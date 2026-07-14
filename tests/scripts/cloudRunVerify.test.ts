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
  type CloudRunVerifyReport,
  cloudRunVerifyUsage,
  parseCloudRunVerifyArgs,
  readCloudRunServiceJson,
  renderCloudRunVerifyReport,
  verifyCloudRunService,
} from "../../scripts/cloudRunVerifyCore.js";
import {
  renderCloudRunVerifyEvidenceArtifact,
  writeCloudRunVerifyEvidenceArtifact,
} from "../../scripts/cloudRunVerifyEvidence.js";

const serviceAccountEmail =
  "substack-mcp-sa@my-project.iam.gserviceaccount.com";
const oauthRuntimeAssertions = {
  publicBaseUrl: "https://mcp.example.com",
  oauthAuthorizationServerUrl: "https://auth.example.com",
  oauthJwksUrl: "https://auth.example.com/jwks.json",
  oauthResourceDocumentationUrl: "https://mcp.example.com/docs",
} as const;
const oauthRuntimeEnv = [
  { name: "MCP_PUBLIC_BASE_URL", value: "https://mcp.example.com" },
  {
    name: "OAUTH_AUTHORIZATION_SERVER_URL",
    value: "https://auth.example.com",
  },
  { name: "OAUTH_JWKS_URL", value: "https://auth.example.com/jwks.json" },
  {
    name: "OAUTH_RESOURCE_DOCUMENTATION_URL",
    value: "https://mcp.example.com/docs",
  },
  { name: "OAUTH_JWT_ALGORITHMS", value: "RS256,ES256" },
] as const;

describe("parseCloudRunVerifyArgs", () => {
  it("parses verification options with safe defaults", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cloud-run-verify-"));
    const options = parseCloudRunVerifyArgs(
      [
        "--service-json",
        ".data/service.json",
        "--service-account-email",
        serviceAccountEmail,
        "--json",
      ],
      cwd,
      {},
    );

    expect(options).toMatchObject({
      help: false,
      authMode: "static_bearer",
      serviceAccountEmail,
      substackSessionSecret: "substack-session-token",
      previewTokenSecret: "mcp-preview-token-secret",
      bearerTokenSecret: "mcp-bearer-token",
      format: "json",
    });
    expect(options).not.toHaveProperty("mcpPathSecret");
    if (options.help) {
      throw new Error("Expected runnable Cloud Run verify options.");
    }
    expect(options.serviceJson).toBe(join(cwd, ".data/service.json"));
  });

  it("supports a project-local evidence artifact path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cloud-run-verify-artifact-"));
    const options = parseCloudRunVerifyArgs(
      [
        "--service-json",
        ".data/service.json",
        "--evidence-artifact",
        ".data/v1/gate-12-cloud-run-deployment.md",
      ],
      cwd,
      {},
    );

    expect(options).toMatchObject({
      help: false,
      artifactRoot: cwd,
      evidenceArtifact: ".data/v1/gate-12-cloud-run-deployment.md",
    });
  });

  it("supports custom auth mode and secret names", () => {
    const options = parseCloudRunVerifyArgs(
      [
        "--service-json",
        "service.json",
        "--auth-mode",
        "oauth",
        "--substack-session-secret",
        "custom-session",
        "--preview-token-secret",
        "custom-preview",
        "--bearer-token-secret",
        "custom-bearer",
        "--mcp-path-secret",
        "custom-path",
        "--public-base-url",
        "https://mcp.example.com/path?ignored=true",
        "--oauth-authorization-server-url",
        "https://auth.example.com/",
        "--oauth-jwks-url",
        "https://auth.example.com/jwks.json",
        "--oauth-resource-documentation-url",
        "https://mcp.example.com/docs",
        "--format",
        "text",
      ],
      process.cwd(),
      {},
    );

    expect(options).toMatchObject({
      help: false,
      authMode: "oauth",
      substackSessionSecret: "custom-session",
      previewTokenSecret: "custom-preview",
      bearerTokenSecret: "custom-bearer",
      mcpPathSecret: "custom-path",
      ...oauthRuntimeAssertions,
      oauthJwtAlgorithms: ["RS256", "ES256"],
      format: "text",
    });
  });

  it("parses optional runtime environment assertions", () => {
    const options = parseCloudRunVerifyArgs(
      [
        "--service-json",
        "service.json",
        "--publication-url",
        "https://example.substack.com/p/draft?utm=agent#editor",
        "--user-id",
        "123456",
        "--max-body-bytes",
        "750000",
        "--max-image-bytes",
        "8000000",
        "--substack-request-timeout-ms",
        "30000",
        "--confirmation-token-ttl-seconds",
        "900",
      ],
      process.cwd(),
      {},
    );

    expect(options).toMatchObject({
      help: false,
      publicationUrl: "https://example.substack.com",
      userId: 123456,
      maxBodyBytes: 750_000,
      maxImageBytes: 8_000_000,
      substackRequestTimeoutMs: 30_000,
      confirmationTokenTtlSeconds: 900,
    });
  });

  it("uses environment defaults and rejects blank required values", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cloud-run-verify-env-"));
    const options = parseCloudRunVerifyArgs(
      ["--service-json", "service.json"],
      cwd,
      {
        AUTH_MODE: "oauth",
        SUBSTACK_SESSION_SECRET_NAME: "session-from-env",
        PREVIEW_TOKEN_SECRET_NAME: "preview-from-env",
        MCP_BEARER_TOKEN_SECRET_NAME: "bearer-from-env",
        MCP_PATH_SECRET_NAME: "path-from-env",
        MCP_PUBLIC_BASE_URL: "https://mcp.example.com/",
        OAUTH_AUTHORIZATION_SERVER_URL: "https://auth.example.com/",
        OAUTH_JWKS_URL: "https://auth.example.com/jwks.json",
        OAUTH_RESOURCE_DOCUMENTATION_URL: "https://mcp.example.com/docs",
        OAUTH_JWT_ALGORITHMS: "PS256,EdDSA",
      },
    );

    expect(options).toMatchObject({
      help: false,
      authMode: "oauth",
      substackSessionSecret: "session-from-env",
      previewTokenSecret: "preview-from-env",
      bearerTokenSecret: "bearer-from-env",
      mcpPathSecret: "path-from-env",
      ...oauthRuntimeAssertions,
      oauthJwtAlgorithms: ["PS256", "EdDSA"],
    });
    if (options.help) {
      throw new Error("Expected runnable Cloud Run verify options.");
    }
    expect(options.serviceJson).toBe(join(cwd, "service.json"));
    expect(
      parseCloudRunVerifyArgs(["--service-json", "service.json"], cwd, {
        AUTH_MODE: "",
        MCP_PATH_SECRET_NAME: " ",
      }),
    ).toMatchObject({
      help: false,
      authMode: "static_bearer",
    });
    expect(
      parseCloudRunVerifyArgs(["--service-json", "service.json"], cwd, {
        MCP_PATH_SECRET_NAME: " ",
      }),
    ).not.toHaveProperty("mcpPathSecret");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--service-account-email", "   "],
        cwd,
        {},
      ),
    ).toThrow("--service-account-email is required.");
  });

  it("rejects invalid input", () => {
    expect(parseCloudRunVerifyArgs(["--help"], process.cwd(), {})).toEqual({
      help: true,
    });
    expect(parseCloudRunVerifyArgs(["-h"], process.cwd(), {})).toEqual({
      help: true,
    });
    expect(() => parseCloudRunVerifyArgs([], process.cwd(), {})).toThrow(
      "--service-json is required.",
    );
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "../service.json"],
        process.cwd(),
        {},
      ),
    ).toThrow("--service-json must stay inside the project directory.");
    expect(() =>
      parseCloudRunVerifyArgs(["--service-json", "."], process.cwd(), {}),
    ).toThrow("--service-json must stay inside the project directory.");
    expect(() =>
      parseCloudRunVerifyArgs(["--service-json", "--json"], process.cwd(), {}),
    ).toThrow("--service-json requires a value.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--auth-mode", "bad"],
        process.cwd(),
        {},
      ),
    ).toThrow("--auth-mode must be one of");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--auth-mode", "oauth"],
        process.cwd(),
        {},
      ),
    ).toThrow("--public-base-url is required.");
    expect(() =>
      parseCloudRunVerifyArgs(
        [
          "--service-json",
          "service.json",
          "--auth-mode",
          "oauth",
          "--public-base-url",
          "https://mcp.example.com",
          "--oauth-authorization-server-url",
          "https://user:pass@auth.example.com",
          "--oauth-jwks-url",
          "https://auth.example.com/jwks.json",
        ],
        process.cwd(),
        {},
      ),
    ).toThrow(
      "--oauth-authorization-server-url must not include username or password.",
    );
    expect(() =>
      parseCloudRunVerifyArgs(
        [
          "--service-json",
          "service.json",
          "--auth-mode",
          "oauth",
          "--public-base-url",
          "https://mcp.example.com",
          "--oauth-authorization-server-url",
          "https://auth.example.com",
          "--oauth-jwks-url",
          "http://auth.example.com/jwks.json",
        ],
        process.cwd(),
        {},
      ),
    ).toThrow("--oauth-jwks-url must be an https URL.");
    expect(() =>
      parseCloudRunVerifyArgs(
        [
          "--service-json",
          "service.json",
          "--oauth-jwt-algorithms",
          "RS256,none",
        ],
        process.cwd(),
        {},
      ),
    ).toThrow(
      "OAUTH_JWT_ALGORITHMS contains unsupported or unsafe algorithm(s): none.",
    );
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--oauth-jwt-algorithms"],
        process.cwd(),
        {},
      ),
    ).toThrow("--oauth-jwt-algorithms requires a value.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--mcp-path-secret"],
        process.cwd(),
        {},
      ),
    ).toThrow("--mcp-path-secret requires a value.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--format", "yaml"],
        process.cwd(),
        {},
      ),
    ).toThrow("--format must be one of");
    expect(() =>
      parseCloudRunVerifyArgs(["--service-json"], process.cwd(), {}),
    ).toThrow("--service-json requires a value.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--publication-url", "http://x"],
        process.cwd(),
        {},
      ),
    ).toThrow("--publication-url must use https://.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--user-id", "0"],
        process.cwd(),
        {},
      ),
    ).toThrow("--user-id must be a positive integer.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--user-id", "   "],
        process.cwd(),
        {},
      ),
    ).toThrow("--user-id is required.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--max-body-bytes", "100kb"],
        process.cwd(),
        {},
      ),
    ).toThrow("--max-body-bytes must be a positive integer.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--confirmation-token-ttl-seconds"],
        process.cwd(),
        {},
      ),
    ).toThrow("--confirmation-token-ttl-seconds requires a value.");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--evidence-artifact"],
        process.cwd(),
        {},
      ),
    ).toThrow("--evidence-artifact requires a value.");
    expect(() =>
      parseCloudRunVerifyArgs(
        [
          "--service-json",
          "service.json",
          "--evidence-artifact",
          "../outside.md",
        ],
        process.cwd(),
        {},
      ),
    ).toThrow("--evidence-artifact must stay inside the project directory.");
    expect(() =>
      parseCloudRunVerifyArgs(["--bogus"], process.cwd(), {}),
    ).toThrow("Unknown option: --bogus");
    expect(() =>
      parseCloudRunVerifyArgs(
        ["--service-json", "service.json", "--auth-mode", "   "],
        process.cwd(),
        {},
      ),
    ).toThrow("--auth-mode must be one of");
  });
});

describe("verifyCloudRunService", () => {
  it("accepts a Cloud Run v2 static-bearer service with secret references", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "static_bearer" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret:
                        "projects/my-project/secrets/substack-session-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret:
                        "projects/my-project/secrets/mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_BEARER_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "projects/my-project/secrets/mcp-bearer-token",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "static_bearer",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(report.ok).toBe(true);
    expect(report.service_url).toBe(
      "https://substack-draft-mcp-example.run.app",
    );
    expect(report.checks.map((entry) => entry.id)).toContain(
      "secret_mcp_bearer_token",
    );
    expect(
      report.checks.find((entry) => entry.id === "mcp_path_secret_absent"),
    ).toMatchObject({
      ok: true,
    });
  });

  it("checks expected non-secret runtime env values when provided", () => {
    const serviceWithUserId = (userId: string) => ({
      uri: "https://substack-draft-mcp-example.run.app",
      template: {
        serviceAccount: serviceAccountEmail,
        scaling: {
          minInstanceCount: 0,
          maxInstanceCount: 1,
        },
        containers: [
          {
            env: [
              { name: "NODE_ENV", value: "production" },
              { name: "MCP_TRANSPORT", value: "http" },
              { name: "AUTH_MODE", value: "static_bearer" },
              {
                name: "SUBSTACK_PUBLICATION_URL",
                value: "https://example.substack.com",
              },
              { name: "SUBSTACK_USER_ID", value: userId },
              { name: "MAX_BODY_BYTES", value: "750000" },
              { name: "MAX_IMAGE_BYTES", value: "8000000" },
              { name: "SUBSTACK_REQUEST_TIMEOUT_MS", value: "30000" },
              { name: "CONFIRMATION_TOKEN_TTL_SECONDS", value: "900" },
              {
                name: "SUBSTACK_SESSION_TOKEN",
                valueSource: {
                  secretKeyRef: {
                    secret:
                      "projects/my-project/secrets/substack-session-token",
                    version: "latest",
                  },
                },
              },
              {
                name: "PREVIEW_TOKEN_SECRET",
                valueSource: {
                  secretKeyRef: {
                    secret:
                      "projects/my-project/secrets/mcp-preview-token-secret",
                    version: "latest",
                  },
                },
              },
              {
                name: "MCP_BEARER_TOKEN",
                valueSource: {
                  secretKeyRef: {
                    secret: "projects/my-project/secrets/mcp-bearer-token",
                    version: "latest",
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const options = {
      authMode: "static_bearer" as const,
      serviceAccountEmail,
      substackSessionSecret: "substack-session-token",
      previewTokenSecret: "mcp-preview-token-secret",
      bearerTokenSecret: "mcp-bearer-token",
      publicationUrl: "https://example.substack.com",
      userId: 123456,
      maxBodyBytes: 750_000,
      maxImageBytes: 8_000_000,
      substackRequestTimeoutMs: 30_000,
      confirmationTokenTtlSeconds: 900,
    };

    const report = verifyCloudRunService(serviceWithUserId("123456"), options);
    expect(report.ok).toBe(true);
    expect(
      report.checks.find(
        (entry) => entry.id === "env_substack_publication_url",
      ),
    ).toMatchObject({ ok: true });
    expect(
      report.checks.find((entry) => entry.id === "env_substack_user_id"),
    ).toMatchObject({ ok: true });
    expect(
      report.checks.find(
        (entry) => entry.id === "env_substack_request_timeout_ms",
      ),
    ).toMatchObject({ ok: true });

    const mismatch = verifyCloudRunService(
      serviceWithUserId("654321"),
      options,
    );
    expect(mismatch.ok).toBe(false);
    expect(
      mismatch.checks.find((entry) => entry.id === "env_substack_user_id"),
    ).toMatchObject({
      ok: false,
      expected: "SUBSTACK_USER_ID=123456",
      actual: "SUBSTACK_USER_ID=654321",
    });
  });

  it("accepts an optional MCP path secret reference when expected", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "static_bearer" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret:
                        "projects/my-project/secrets/substack-session-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret:
                        "projects/my-project/secrets/mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_BEARER_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "projects/my-project/secrets/mcp-bearer-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_PATH_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "projects/my-project/secrets/mcp-path-secret",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "static_bearer",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
        mcpPathSecret: "mcp-path-secret",
      },
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.find((entry) => entry.id === "secret_mcp_path_secret"),
    ).toMatchObject({
      ok: true,
      actual: "MCP_PATH_SECRET=mcp-path-secret:latest",
    });
  });

  it("accepts a Knative-style OAuth service and requires no bearer secret", () => {
    const report = verifyCloudRunService(
      {
        status: {
          url: "https://substack-draft-mcp-example.run.app",
        },
        spec: {
          template: {
            metadata: {
              annotations: {
                "autoscaling.knative.dev/minScale": "0",
                "autoscaling.knative.dev/maxScale": "1",
              },
            },
            spec: {
              serviceAccountName: serviceAccountEmail,
              containers: [
                {
                  env: [
                    { name: "NODE_ENV", value: "production" },
                    { name: "MCP_TRANSPORT", value: "http" },
                    { name: "AUTH_MODE", value: "oauth" },
                    ...oauthRuntimeEnv,
                    {
                      name: "SUBSTACK_SESSION_TOKEN",
                      valueFrom: {
                        secretKeyRef: {
                          name: "substack-session-token",
                          key: "latest",
                        },
                      },
                    },
                    {
                      name: "PREVIEW_TOKEN_SECRET",
                      valueFrom: {
                        secretKeyRef: {
                          name: "mcp-preview-token-secret",
                          key: "latest",
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      {
        authMode: "oauth",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
        ...oauthRuntimeAssertions,
      },
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.find((entry) => entry.id === "env_mcp_public_base_url"),
    ).toMatchObject({
      ok: true,
      expected: "MCP_PUBLIC_BASE_URL=https://mcp.example.com",
    });
    expect(
      report.checks.find(
        (entry) => entry.id === "env_oauth_authorization_server_url",
      ),
    ).toMatchObject({
      ok: true,
      expected: "OAUTH_AUTHORIZATION_SERVER_URL=https://auth.example.com",
    });
    expect(
      report.checks.find((entry) => entry.id === "env_oauth_jwks_url"),
    ).toMatchObject({
      ok: true,
      expected: "OAUTH_JWKS_URL=https://auth.example.com/jwks.json",
    });
    expect(
      report.checks.find((entry) => entry.id === "mcp_bearer_token_absent"),
    ).toMatchObject({
      ok: true,
    });
  });

  it("accepts metadata annotations, address URLs, and optional service account matching", () => {
    const report = verifyCloudRunService(
      {
        status: {
          address: {
            url: "https://substack-draft-mcp-example.run.app",
          },
        },
        metadata: {
          annotations: {
            "run.googleapis.com/minScale": "0",
            "run.googleapis.com/maxScale": "1",
          },
        },
        template: {
          serviceAccountName: serviceAccountEmail,
          containers: [
            "not-a-container",
            {
              env: [
                null,
                { value: "missing-name" },
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "noauth" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "substack-session-token",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "noauth",
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(report.ok).toBe(true);
    expect(report.service_url).toBe(
      "https://substack-draft-mcp-example.run.app",
    );
    expect(
      report.checks.find(
        (entry) => entry.id === "secret_substack_session_token",
      ),
    ).toMatchObject({
      actual: "SUBSTACK_SESSION_TOKEN=substack-session-token:unknown",
    });
    expect(
      report.checks.find((entry) => entry.id === "service_account"),
    ).toMatchObject({
      ok: true,
      expected: "configured service account",
      actual: serviceAccountEmail,
    });
  });

  it("reports missing secret references and bearer tokens that should be absent", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "oauth" },
                ...oauthRuntimeEnv.filter(
                  (entry) => entry.name !== "OAUTH_JWKS_URL",
                ),
                { name: "SUBSTACK_SESSION_TOKEN" },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_BEARER_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-bearer-token",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "oauth",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
        ...oauthRuntimeAssertions,
      },
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find(
        (entry) => entry.id === "secret_substack_session_token",
      ),
    ).toMatchObject({
      ok: false,
      actual: "SUBSTACK_SESSION_TOKEN=<no-secret-ref>",
    });
    expect(
      report.checks.find((entry) => entry.id === "mcp_bearer_token_absent"),
    ).toMatchObject({
      ok: false,
      actual: "configured",
    });
    expect(
      report.checks.find((entry) => entry.id === "env_oauth_jwks_url"),
    ).toMatchObject({
      ok: false,
      expected: "OAUTH_JWKS_URL=https://auth.example.com/jwks.json",
      actual: "missing",
    });
  });

  it("fails when MCP_PATH_SECRET is configured but not expected", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "noauth" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "substack-session-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_PATH_SECRET",
                  value: "literal-private-path",
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "noauth",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((entry) => entry.id === "mcp_path_secret_absent"),
    ).toMatchObject({
      ok: false,
      actual: "MCP_PATH_SECRET=<literal-value>",
    });
  });

  it("fails when an expected MCP_PATH_SECRET is configured as a literal env value", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "noauth" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "substack-session-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_PATH_SECRET",
                  value: "literal-private-path",
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "noauth",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
        mcpPathSecret: "mcp-path-secret",
      },
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((entry) => entry.id === "secret_mcp_path_secret"),
    ).toMatchObject({
      ok: false,
      actual: "MCP_PATH_SECRET=<literal-value>",
    });
  });

  it("reports missing service details and required static-bearer secrets", () => {
    const report = verifyCloudRunService(
      {
        template: {
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                {
                  name: "NODE_ENV",
                  valueSource: {
                    secretKeyRef: {
                      secret: "node-env",
                      version: "latest",
                    },
                  },
                },
                { name: "AUTH_MODE", value: "static_bearer" },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "static_bearer",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(report.ok).toBe(false);
    expect(report.service_url).toBeUndefined();
    expect(
      report.checks.find((entry) => entry.id === "service_url_https"),
    ).toMatchObject({
      actual: "missing",
    });
    expect(
      report.checks.find((entry) => entry.id === "service_account"),
    ).toMatchObject({
      actual: "missing",
    });
    expect(
      report.checks.find((entry) => entry.id === "env_node_env"),
    ).toMatchObject({
      actual: "NODE_ENV=<secret-ref>",
    });
    expect(
      report.checks.find((entry) => entry.id === "env_mcp_transport"),
    ).toMatchObject({
      actual: "missing",
    });
    expect(
      report.checks.find(
        (entry) => entry.id === "secret_substack_session_token",
      ),
    ).toMatchObject({
      actual: "missing",
    });
    expect(
      report.checks.find((entry) => entry.id === "secret_mcp_bearer_token"),
    ).toMatchObject({
      actual: "missing",
    });
  });

  it("fails when secrets are configured as literal env values", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "static_bearer" },
                { name: "SUBSTACK_SESSION_TOKEN", value: "literal-secret" },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "MCP_BEARER_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-bearer-token",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "static_bearer",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find(
        (entry) => entry.id === "secret_substack_session_token",
      ),
    ).toMatchObject({
      ok: false,
      actual: "SUBSTACK_SESSION_TOKEN=<literal-value>",
    });
  });

  it("fails when required scale settings are missing", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "noauth" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "substack-session-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "noauth",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((entry) => entry.id === "min_instances_zero"),
    ).toMatchObject({
      ok: false,
      actual: "missing",
    });
    expect(
      report.checks.find((entry) => entry.id === "max_instances_one"),
    ).toMatchObject({
      ok: false,
      actual: "missing",
    });
  });
});

describe("Cloud Run verify rendering and file loading", () => {
  it("renders text and JSON reports", () => {
    const report = verifyCloudRunService(
      {
        uri: "https://substack-draft-mcp-example.run.app",
        template: {
          serviceAccount: serviceAccountEmail,
          scaling: {
            minInstanceCount: 0,
            maxInstanceCount: 1,
          },
          containers: [
            {
              env: [
                { name: "NODE_ENV", value: "production" },
                { name: "MCP_TRANSPORT", value: "http" },
                { name: "AUTH_MODE", value: "noauth" },
                {
                  name: "SUBSTACK_SESSION_TOKEN",
                  valueSource: {
                    secretKeyRef: {
                      secret: "substack-session-token",
                      version: "latest",
                    },
                  },
                },
                {
                  name: "PREVIEW_TOKEN_SECRET",
                  valueSource: {
                    secretKeyRef: {
                      secret: "mcp-preview-token-secret",
                      version: "latest",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
      {
        authMode: "noauth",
        serviceAccountEmail,
        substackSessionSecret: "substack-session-token",
        previewTokenSecret: "mcp-preview-token-secret",
        bearerTokenSecret: "mcp-bearer-token",
      },
    );

    expect(renderCloudRunVerifyReport(report, "text")).toContain(
      "# Cloud Run service verification",
    );
    expect(
      JSON.parse(renderCloudRunVerifyReport(report, "json")),
    ).toMatchObject({
      ok: true,
      auth_mode: "noauth",
    });
    expect(cloudRunVerifyUsage()).toContain("cloud-run:verify");
    expect(cloudRunVerifyUsage()).toContain("--evidence-artifact");
    expect(cloudRunVerifyUsage()).toContain("--mcp-path-secret");
  });

  it("reads parseable service JSON and rejects missing or invalid files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cloud-run-verify-json-"));
    const filePath = join(cwd, "service.json");
    writeFileSync(filePath, JSON.stringify({ uri: "https://example.run.app" }));

    expect(readCloudRunServiceJson(filePath)).toEqual({
      uri: "https://example.run.app",
    });
    expect(() => readCloudRunServiceJson(join(cwd, "missing.json"))).toThrow(
      "Cloud Run service JSON does not exist",
    );

    const invalidPath = join(cwd, "invalid.json");
    writeFileSync(invalidPath, "{");
    expect(() => readCloudRunServiceJson(invalidPath)).toThrow(
      "Invalid Cloud Run service JSON",
    );
  });
});

describe("Cloud Run verify evidence artifacts", () => {
  it("renders a sanitized gate 12/13 checklist without env assignment-like secret refs", () => {
    const rendered = renderCloudRunVerifyEvidenceArtifact(
      baseStaticBearerReport,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 Cloud Run Deployment Evidence");
    expect(rendered).toContain("- Complete: yes");
    expect(rendered).toContain("- Auth mode: static_bearer");
    expect(rendered).toContain("secret_mcp_bearer_token");
    expect(rendered).toContain("Cloud Run service URL was checked");
    expect(rendered).toContain("## Gate 12 Deployment Review Details");
    expect(rendered).toContain(
      "- GCP project/region/service: <replace with non-sensitive project, region, and service reference>",
    );
    expect(rendered).toContain(
      "- Remote smoke result: <replace with auth-mode matching remote smoke command and result>",
    );
    expect(rendered).toContain("## Gate 13 Secret Manager Review Details");
    expect(rendered).toContain(
      "- Secret references checked: <replace with Secret Manager reference check summary for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET>",
    );
    expect(rendered).toContain(
      "- Secret value handling: <replace with confirmation no raw secret values were opened, pasted, exposed, or recorded>",
    );
    expect(rendered).toContain("npm run v1:record -- --gate 12");
    expect(rendered).toContain("npm run v1:record -- --gate 13");
    expect(rendered).not.toContain("SUBSTACK_SESSION_TOKEN=");
    expect(rendered).not.toContain("PREVIEW_TOKEN_SECRET=");
    expect(rendered).not.toContain("MCP_BEARER_TOKEN=");
    expect(rendered).not.toContain("draft_body");
  });

  it("redacts MCP_PATH_SECRET assignment-like details in rendered evidence", () => {
    const rendered = renderCloudRunVerifyEvidenceArtifact(
      {
        ...baseStaticBearerReport,
        checks: [
          ...baseStaticBearerReport.checks,
          {
            id: "secret_mcp_path_secret",
            ok: true,
            evidence:
              "Cloud Run env MCP_PATH_SECRET is backed by the expected Secret Manager secret reference.",
            expected: "MCP_PATH_SECRET=mcp-path-secret:latest",
            actual: "MCP_PATH_SECRET=mcp-path-secret:latest",
          },
        ],
      },
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("secret_mcp_path_secret");
    expect(rendered).toContain("MCP_PATH_SECRET reference mcp-path-secret");
    expect(rendered).not.toContain("MCP_PATH_SECRET=");
  });

  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeCloudRunVerifyEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-12-cloud-run-deployment.md",
        report: baseStaticBearerReport,
        verifiedAt: "2026-07-08T12:00:00Z",
      });

      expect(result.artifact).toBe(".data/v1/gate-12-cloud-run-deployment.md");
      expect(existsSync(result.path)).toBe(true);
      const artifact = readFileSync(result.path, "utf8");

      expect(artifact).toContain("V1 Cloud Run Deployment Evidence");
      expect(artifact).toContain(
        "--artifact .data/v1/gate-12-cloud-run-deployment.md",
      );
      expect(artifact).toContain(
        "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json",
      );
      expect(artifact).toContain(
        "--service-account-email substack-mcp-sa@my-project.iam.gserviceaccount.com",
      );
      expect(artifact).toContain(
        "--evidence-artifact .data/v1/gate-12-cloud-run-deployment.md",
      );
      expect(artifact).not.toContain("<this file>");
      expect(artifact).not.toContain("npm run smoke:remote...");
    });
  });

  it("includes runtime assertion flags in suggested record commands when checked", () => {
    const rendered = renderCloudRunVerifyEvidenceArtifact(
      {
        ...baseStaticBearerReport,
        checks: [
          ...baseStaticBearerReport.checks,
          {
            id: "env_substack_publication_url",
            ok: true,
            evidence:
              "Cloud Run runtime env SUBSTACK_PUBLICATION_URL has the expected value.",
            expected: "SUBSTACK_PUBLICATION_URL=https://example.substack.com",
            actual: "SUBSTACK_PUBLICATION_URL=https://example.substack.com",
          },
          {
            id: "env_substack_user_id",
            ok: true,
            evidence:
              "Cloud Run runtime env SUBSTACK_USER_ID has the expected value.",
            expected: "SUBSTACK_USER_ID=123456",
            actual: "SUBSTACK_USER_ID=123456",
          },
          {
            id: "env_max_body_bytes",
            ok: true,
            evidence:
              "Cloud Run runtime env MAX_BODY_BYTES has the expected value.",
            expected: "MAX_BODY_BYTES=750000",
            actual: "MAX_BODY_BYTES=750000",
          },
          {
            id: "env_max_image_bytes",
            ok: true,
            evidence:
              "Cloud Run runtime env MAX_IMAGE_BYTES has the expected value.",
            expected: "MAX_IMAGE_BYTES=8000000",
            actual: "MAX_IMAGE_BYTES=8000000",
          },
          {
            id: "env_substack_request_timeout_ms",
            ok: true,
            evidence:
              "Cloud Run runtime env SUBSTACK_REQUEST_TIMEOUT_MS has the expected value.",
            expected: "SUBSTACK_REQUEST_TIMEOUT_MS=30000",
            actual: "SUBSTACK_REQUEST_TIMEOUT_MS=30000",
          },
          {
            id: "env_confirmation_token_ttl_seconds",
            ok: true,
            evidence:
              "Cloud Run runtime env CONFIRMATION_TOKEN_TTL_SECONDS has the expected value.",
            expected: "CONFIRMATION_TOKEN_TTL_SECONDS=900",
            actual: "CONFIRMATION_TOKEN_TTL_SECONDS=900",
          },
          {
            id: "env_mcp_public_base_url",
            ok: true,
            evidence:
              "Cloud Run runtime env MCP_PUBLIC_BASE_URL has the expected value.",
            expected: "MCP_PUBLIC_BASE_URL=https://mcp.example.com",
            actual: "MCP_PUBLIC_BASE_URL=https://mcp.example.com",
          },
          {
            id: "env_oauth_authorization_server_url",
            ok: true,
            evidence:
              "Cloud Run runtime env OAUTH_AUTHORIZATION_SERVER_URL has the expected value.",
            expected: "OAUTH_AUTHORIZATION_SERVER_URL=https://auth.example.com",
            actual: "OAUTH_AUTHORIZATION_SERVER_URL=https://auth.example.com",
          },
          {
            id: "env_oauth_jwks_url",
            ok: true,
            evidence:
              "Cloud Run runtime env OAUTH_JWKS_URL has the expected value.",
            expected: "OAUTH_JWKS_URL=https://auth.example.com/jwks.json",
            actual: "OAUTH_JWKS_URL=https://auth.example.com/jwks.json",
          },
          {
            id: "env_oauth_resource_documentation_url",
            ok: true,
            evidence:
              "Cloud Run runtime env OAUTH_RESOURCE_DOCUMENTATION_URL has the expected value.",
            expected:
              "OAUTH_RESOURCE_DOCUMENTATION_URL=https://mcp.example.com/docs",
            actual:
              "OAUTH_RESOURCE_DOCUMENTATION_URL=https://mcp.example.com/docs",
          },
          {
            id: "env_oauth_jwt_algorithms",
            ok: true,
            evidence:
              "Cloud Run runtime env OAUTH_JWT_ALGORITHMS has the expected value.",
            expected: "OAUTH_JWT_ALGORITHMS=RS256,ES256",
            actual: "OAUTH_JWT_ALGORITHMS=RS256,ES256",
          },
        ],
      },
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain(
      "--publication-url https://example.substack.com",
    );
    expect(rendered).toContain("--user-id 123456");
    expect(rendered).toContain("--max-body-bytes 750000");
    expect(rendered).toContain("--max-image-bytes 8000000");
    expect(rendered).toContain("--substack-request-timeout-ms 30000");
    expect(rendered).toContain("--confirmation-token-ttl-seconds 900");
    expect(rendered).toContain("--public-base-url https://mcp.example.com");
    expect(rendered).toContain(
      "--oauth-authorization-server-url https://auth.example.com",
    );
    expect(rendered).toContain(
      "--oauth-jwks-url https://auth.example.com/jwks.json",
    );
    expect(rendered).toContain(
      "--oauth-resource-documentation-url https://mcp.example.com/docs",
    );
    expect(rendered).toContain("--oauth-jwt-algorithms RS256,ES256");
  });

  it("omits malformed expected values from suggested verifier flags", () => {
    const rendered = renderCloudRunVerifyEvidenceArtifact(
      {
        ok: true,
        auth_mode: "oauth",
        checks: [
          {
            id: "env_substack_user_id",
            ok: true,
            evidence:
              "Cloud Run runtime env SUBSTACK_USER_ID has the expected value.",
            expected: "unexpected-user-id-format",
            actual: "SUBSTACK_USER_ID=123456",
          },
          {
            id: "env_oauth_jwks_url",
            ok: true,
            evidence:
              "Cloud Run runtime env OAUTH_JWKS_URL has the expected value.",
            expected: "unexpected-jwks-format",
            actual: "OAUTH_JWKS_URL=https://auth.example.com/jwks.json",
          },
        ],
      },
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).not.toContain("--user-id");
    expect(rendered).not.toContain("--oauth-jwks-url");
    expect(rendered).toContain(
      "run the OAuth remote smoke against the deployed service MCP URL with a real access token",
    );
  });

  it("renders checks that do not have optional expected or actual details", () => {
    const rendered = renderCloudRunVerifyEvidenceArtifact(
      {
        ok: false,
        auth_mode: "noauth",
        checks: [
          {
            id: "manual_healthz",
            ok: false,
            evidence: "The deployed /healthz check has not been recorded.",
          },
        ],
      },
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("- Complete: no");
    expect(rendered).toContain("- Auth mode: noauth");
    expect(rendered).toContain("- Service URL: missing");
    expect(rendered).toContain("- [ ] manual_healthz");
    expect(rendered).not.toContain("  - Expected:");
    expect(rendered).not.toContain("  - Actual:");
  });

  it("uses the current timestamp when no verified time is provided", () => {
    withTempProject((cwd) => {
      const result = writeCloudRunVerifyEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-13-cloud-run-secrets.md",
        report: baseStaticBearerReport,
      });

      expect(readFileSync(result.path, "utf8")).toMatch(
        /- Verified at: \d{4}-\d{2}-\d{2}T/,
      );
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeCloudRunVerifyEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          report: baseStaticBearerReport,
        }),
      ).toThrow(
        "V1 Cloud Run verify evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeCloudRunVerifyEvidenceArtifact({
          cwd,
          artifact: ".data/v1/gate-12-cloud-run-deployment.md",
          report: {
            ...baseStaticBearerReport,
            service_url:
              "https://example.run.app Authorization: Bearer abcdefghijklmnop",
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/gate-12-cloud-run-deployment.md contains secret-like content",
      );
    });
  });
});

const baseStaticBearerReport: CloudRunVerifyReport = verifyCloudRunService(
  {
    uri: "https://substack-draft-mcp-example.run.app",
    template: {
      serviceAccount: serviceAccountEmail,
      scaling: {
        minInstanceCount: 0,
        maxInstanceCount: 1,
      },
      containers: [
        {
          env: [
            { name: "NODE_ENV", value: "production" },
            { name: "MCP_TRANSPORT", value: "http" },
            { name: "AUTH_MODE", value: "static_bearer" },
            {
              name: "SUBSTACK_SESSION_TOKEN",
              valueSource: {
                secretKeyRef: {
                  secret: "projects/my-project/secrets/substack-session-token",
                  version: "latest",
                },
              },
            },
            {
              name: "PREVIEW_TOKEN_SECRET",
              valueSource: {
                secretKeyRef: {
                  secret:
                    "projects/my-project/secrets/mcp-preview-token-secret",
                  version: "latest",
                },
              },
            },
            {
              name: "MCP_BEARER_TOKEN",
              valueSource: {
                secretKeyRef: {
                  secret: "projects/my-project/secrets/mcp-bearer-token",
                  version: "latest",
                },
              },
            },
          ],
        },
      ],
    },
  },
  {
    authMode: "static_bearer",
    serviceAccountEmail,
    substackSessionSecret: "substack-session-token",
    previewTokenSecret: "mcp-preview-token-secret",
    bearerTokenSecret: "mcp-bearer-token",
  },
);

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "cloud-run-verify-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
