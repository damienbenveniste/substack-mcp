import { describe, expect, it } from "vitest";

import {
  buildCloudRunPlan,
  cloudRunPlanUsage,
  parseCloudRunPlanArgs,
  renderCloudRunPlan,
} from "../../scripts/cloudRunPlanCore.js";

const baseArgs = [
  "--project-id",
  "my-project",
  "--publication-url",
  "https://example.substack.com",
  "--user-id",
  "123456",
] as const;

describe("parseCloudRunPlanArgs", () => {
  it("parses a static-bearer Cloud Run plan with safe defaults", () => {
    const options = parseCloudRunPlanArgs(baseArgs, {});

    expect(options).toMatchObject({
      help: false,
      projectId: "my-project",
      region: "us-central1",
      serviceName: "substack-draft-mcp",
      serviceAccount: "substack-mcp-sa",
      publicationUrl: "https://example.substack.com",
      userId: 123456,
      authMode: "static_bearer",
      substackSessionSecret: "substack-session-token",
      previewTokenSecret: "mcp-preview-token-secret",
      bearerTokenSecret: "mcp-bearer-token",
      maxBodyBytes: 750_000,
      maxImageBytes: 8_000_000,
      substackRequestTimeoutMs: 30_000,
      confirmationTokenTtlSeconds: 900,
    });
    expect(options).not.toHaveProperty("mcpPathSecret");
  });

  it("normalizes copied publication URLs to their origin", () => {
    const options = parseCloudRunPlanArgs(
      [
        "--project-id",
        "my-project",
        "--publication-url",
        "https://example.substack.com/p/a-draft?utm=agent#editor",
        "--user-id",
        "123456",
      ],
      {},
    );

    expect(options).toMatchObject({
      help: false,
      publicationUrl: "https://example.substack.com",
    });
  });

  it("supports env defaults and OAuth-specific options", () => {
    const options = parseCloudRunPlanArgs(
      [
        "--auth-mode",
        "oauth",
        "--public-base-url",
        "https://mcp.example.com/",
        "--oauth-authorization-server-url",
        "https://auth.example.com/",
        "--oauth-jwks-url",
        "https://auth.example.com/jwks.json",
        "--oauth-resource-documentation-url",
        "https://mcp.example.com/docs",
        "--oauth-jwt-algorithms",
        "PS256, EdDSA",
      ],
      {
        GOOGLE_CLOUD_PROJECT: "env-project",
        CLOUD_RUN_REGION: "europe-west1",
        CLOUD_RUN_SERVICE_NAME: "env-service",
        CLOUD_RUN_SERVICE_ACCOUNT: "env-sa",
        SUBSTACK_PUBLICATION_URL: "https://env.substack.com",
        SUBSTACK_USER_ID: "42",
        MCP_PATH_SECRET_NAME: "env-path-secret",
      },
    );

    expect(options).toMatchObject({
      help: false,
      projectId: "env-project",
      region: "europe-west1",
      serviceName: "env-service",
      serviceAccount: "env-sa",
      publicationUrl: "https://env.substack.com",
      userId: 42,
      authMode: "oauth",
      publicBaseUrl: "https://mcp.example.com",
      oauthAuthorizationServerUrl: "https://auth.example.com",
      oauthJwksUrl: "https://auth.example.com/jwks.json",
      oauthResourceDocumentationUrl: "https://mcp.example.com/docs",
      oauthJwtAlgorithms: ["PS256", "EdDSA"],
      mcpPathSecret: "env-path-secret",
    });
  });

  it("parses custom Cloud Run knobs and Secret Manager names", () => {
    const options = parseCloudRunPlanArgs(
      [
        ...baseArgs,
        "--region",
        "asia-northeast1",
        "--service-name",
        "custom-service",
        "--service-account",
        "custom-sa",
        "--substack-session-secret",
        "custom-session",
        "--preview-token-secret",
        "custom-preview",
        "--bearer-token-secret",
        "custom-bearer",
        "--mcp-path-secret",
        "custom-path",
        "--max-body-bytes",
        "123456",
        "--max-image-bytes",
        "654321",
        "--substack-request-timeout-ms",
        "4321",
        "--confirmation-token-ttl-seconds",
        "600",
      ],
      {},
    );

    expect(options).toMatchObject({
      help: false,
      region: "asia-northeast1",
      serviceName: "custom-service",
      serviceAccount: "custom-sa",
      substackSessionSecret: "custom-session",
      previewTokenSecret: "custom-preview",
      bearerTokenSecret: "custom-bearer",
      mcpPathSecret: "custom-path",
      maxBodyBytes: 123_456,
      maxImageBytes: 654_321,
      substackRequestTimeoutMs: 4321,
      confirmationTokenTtlSeconds: 600,
    });
  });

  it("allows help without required deployment inputs", () => {
    expect(parseCloudRunPlanArgs(["--help"], {})).toEqual({ help: true });
    expect(parseCloudRunPlanArgs(["-h"], {})).toEqual({ help: true });
  });

  it("rejects missing and invalid inputs", () => {
    expect(() => parseCloudRunPlanArgs([], {})).toThrow(
      "--project-id is required.",
    );
    expect(() =>
      parseCloudRunPlanArgs(
        ["--project-id", "x", "--publication-url", "ftp://x", "--user-id", "1"],
        {},
      ),
    ).toThrow("--publication-url must use http:// or https://.");
    expect(() =>
      parseCloudRunPlanArgs(
        [
          "--project-id",
          "x",
          "--publication-url",
          "http://example.substack.com",
          "--user-id",
          "1",
        ],
        {},
      ),
    ).toThrow("--publication-url must use https://.");
    expect(() =>
      parseCloudRunPlanArgs(
        [
          "--project-id",
          "x",
          "--publication-url",
          "https://127.0.0.1",
          "--user-id",
          "1",
        ],
        {},
      ),
    ).toThrow(
      "--publication-url must not point to localhost or private network addresses.",
    );
    expect(() =>
      parseCloudRunPlanArgs(
        [
          "--project-id",
          "x",
          "--publication-url",
          "https://x",
          "--user-id",
          "0",
        ],
        {},
      ),
    ).toThrow("--user-id must be a positive integer.");
    expect(() =>
      parseCloudRunPlanArgs(
        [
          "--project-id",
          "x",
          "--publication-url",
          "https://x",
          "--user-id",
          "123abc",
        ],
        {},
      ),
    ).toThrow("--user-id must be a positive integer.");
    expect(() =>
      parseCloudRunPlanArgs([...baseArgs, "--auth-mode", "oauth"], {}),
    ).toThrow("--public-base-url is required.");
    expect(() =>
      parseCloudRunPlanArgs(
        [
          ...baseArgs,
          "--auth-mode",
          "oauth",
          "--public-base-url",
          "http://mcp.example.com",
        ],
        {},
      ),
    ).toThrow("--public-base-url must be an https URL.");
    expect(() =>
      parseCloudRunPlanArgs(
        [...baseArgs, "--oauth-jwt-algorithms", "RS256,HS256"],
        {},
      ),
    ).toThrow(
      "OAUTH_JWT_ALGORITHMS contains unsupported or unsafe algorithm(s): HS256.",
    );
    expect(() =>
      parseCloudRunPlanArgs(
        [
          ...baseArgs,
          "--auth-mode",
          "oauth",
          "--public-base-url",
          "https://mcp.example.com",
          "--oauth-authorization-server-url",
          "https://user:pass@auth.example.com",
          "--oauth-jwks-url",
          "https://auth.example.com/jwks.json",
        ],
        {},
      ),
    ).toThrow(
      "--oauth-authorization-server-url must not include username or password.",
    );
    expect(() =>
      parseCloudRunPlanArgs([...baseArgs, "--auth-mode", "invalid"], {}),
    ).toThrow("--auth-mode must be one of");
    expect(() =>
      parseCloudRunPlanArgs([...baseArgs, "--max-body-bytes", "-1"], {}),
    ).toThrow("--max-body-bytes must be a positive integer.");
    expect(() =>
      parseCloudRunPlanArgs([...baseArgs, "--max-body-bytes", "123kb"], {}),
    ).toThrow("--max-body-bytes must be a positive integer.");
    expect(() =>
      parseCloudRunPlanArgs(
        [...baseArgs, "--substack-request-timeout-ms", "0"],
        {},
      ),
    ).toThrow("--substack-request-timeout-ms must be a positive integer.");
    expect(() =>
      parseCloudRunPlanArgs(
        ["--project-id", "x", "--publication-url", "https://x"],
        {},
      ),
    ).toThrow("--user-id is required.");
    expect(() => parseCloudRunPlanArgs([...baseArgs, "--region"], {})).toThrow(
      "--region requires a value.",
    );
    expect(() =>
      parseCloudRunPlanArgs([...baseArgs, "--service-name", "--region"], {}),
    ).toThrow("--service-name requires a value.");
    expect(() =>
      parseCloudRunPlanArgs([...baseArgs, "--mcp-path-secret"], {}),
    ).toThrow("--mcp-path-secret requires a value.");
    expect(
      parseCloudRunPlanArgs(baseArgs, { MCP_PATH_SECRET_NAME: " " }),
    ).not.toHaveProperty("mcpPathSecret");
    expect(() => parseCloudRunPlanArgs([...baseArgs, "--bogus"], {})).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("buildCloudRunPlan", () => {
  it("builds a no-secret static-bearer command plan", () => {
    const options = parseCloudRunPlanArgs(baseArgs, {});
    if (options.help) {
      throw new Error("Expected runnable Cloud Run plan options.");
    }

    const plan = buildCloudRunPlan(options);

    expect(plan).toMatchObject({
      project_id: "my-project",
      region: "us-central1",
      service_name: "substack-draft-mcp",
      service_account_email:
        "substack-mcp-sa@my-project.iam.gserviceaccount.com",
      auth_mode: "static_bearer",
      secret_names: [
        "substack-session-token",
        "mcp-preview-token-secret",
        "mcp-bearer-token",
      ],
    });
    expect(plan.commands.map((entry) => entry.label)).toContain(
      "Deploy Cloud Run service from source",
    );
    const deploy = plan.commands.find((entry) =>
      entry.label.includes("Deploy"),
    )?.command;
    expect(deploy).toContain("--allow-unauthenticated");
    expect(deploy).toContain("AUTH_MODE=static_bearer");
    expect(deploy).toContain("SUBSTACK_REQUEST_TIMEOUT_MS=30000");
    expect(deploy).toContain("MCP_BEARER_TOKEN=mcp-bearer-token:latest");
    expect(deploy).not.toContain("MCP_PATH_SECRET");
    expect(deploy).not.toContain("replace-me");
    expect(deploy).not.toContain("session-token>");
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Export service JSON",
    );
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Verify exported service configuration and write gate 12 evidence",
    );
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Write gate 13 Secret Manager evidence",
    );
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Check deployed health endpoint",
    );
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Create monthly budget alert",
    );
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Export Cloud Run logs after live acceptance traffic",
    );
    expect(plan.follow_up_commands.map((entry) => entry.label)).toContain(
      "Verify exported Cloud Run logs and write gate 16 evidence",
    );
    const exportJson = plan.follow_up_commands.find((entry) =>
      entry.label.includes("service JSON"),
    )?.command;
    expect(exportJson).toBe(
      "mkdir -p .data && gcloud run services describe 'substack-draft-mcp' --region 'us-central1' --format=json > .data/cloud-run-service.json",
    );
    const verify = plan.follow_up_commands.find((entry) =>
      entry.label.includes("Verify"),
    )?.command;
    expect(verify).toContain("npm run cloud-run:verify");
    expect(verify).toContain("--service-json '.data/cloud-run-service.json'");
    expect(verify).toContain("--auth-mode 'static_bearer'");
    expect(verify).toContain(
      "--service-account-email 'substack-mcp-sa@my-project.iam.gserviceaccount.com'",
    );
    expect(verify).toContain(
      "--publication-url 'https://example.substack.com'",
    );
    expect(verify).toContain("--user-id '123456'");
    expect(verify).toContain("--max-body-bytes '750000'");
    expect(verify).toContain("--max-image-bytes '8000000'");
    expect(verify).toContain("--substack-request-timeout-ms '30000'");
    expect(verify).toContain("--confirmation-token-ttl-seconds '900'");
    expect(verify).toContain(
      "--substack-session-secret 'substack-session-token'",
    );
    expect(verify).toContain(
      "--preview-token-secret 'mcp-preview-token-secret'",
    );
    expect(verify).toContain("--bearer-token-secret 'mcp-bearer-token'");
    expect(verify).toContain(
      "--evidence-artifact '.data/v1/gate-12-cloud-run-deployment.md'",
    );
    expect(verify).not.toContain("--mcp-path-secret");
    const secretEvidence = plan.follow_up_commands.find((entry) =>
      entry.label.includes("gate 13"),
    )?.command;
    expect(secretEvidence).toContain(
      "--evidence-artifact '.data/v1/gate-13-cloud-run-secrets.md'",
    );
    const healthCheck = plan.follow_up_commands.find((entry) =>
      entry.label.includes("health"),
    )?.command;
    expect(healthCheck).toBe('curl --fail --show-error "$SERVICE_URL/healthz"');
    const budgetAlert = plan.follow_up_commands.find((entry) =>
      entry.label.includes("budget"),
    )?.command;
    expect(budgetAlert).toContain("gcloud billing budgets create");
    expect(budgetAlert).toContain(
      ': "$' +
        '{BILLING_ACCOUNT_ID:?Set BILLING_ACCOUNT_ID to the Cloud Billing account id first}"',
    );
    expect(budgetAlert).toContain("--budget-amount 5USD");
    expect(budgetAlert).toContain("--calendar-period month");
    expect(budgetAlert).toContain("--filter-projects 'projects/my-project'");
    expect(budgetAlert).toContain("--threshold-rule percent=0.50");
    expect(budgetAlert).toContain("--threshold-rule percent=0.90");
    expect(budgetAlert).toContain("--threshold-rule percent=1.00");
    const followUp = plan.follow_up_commands.find((entry) =>
      entry.label.includes("remote"),
    )?.command;
    expect(followUp).toContain('MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN"');
    expect(followUp).toContain("npm run smoke:remote");
    expect(followUp).toContain('--url "$SERVICE_URL/mcp"');
    expect(followUp).not.toContain("MCP_PATH_SECRET");
    expect(followUp).toContain(
      "--evidence-artifact '.data/v1/gate-14-static-bearer-remote.md'",
    );
    const logsExport = plan.follow_up_commands.find((entry) =>
      entry.label.includes("Export Cloud Run logs"),
    )?.command;
    expect(logsExport).toContain("mkdir -p .data && gcloud logging read");
    expect(logsExport).toContain('resource.type="cloud_run_revision"');
    expect(logsExport).toContain(
      'resource.labels.service_name="substack-draft-mcp"',
    );
    expect(logsExport).toContain("--format=json");
    expect(logsExport).toContain("--limit=100");
    expect(logsExport).toContain("> .data/cloud-run-logs.json");
    const logsVerify = plan.follow_up_commands.find((entry) =>
      entry.label.includes("gate 16"),
    )?.command;
    expect(logsVerify).toContain("npm run cloud-run:logs:verify");
    expect(logsVerify).toContain("--logs-json '.data/cloud-run-logs.json'");
    expect(logsVerify).toContain("--require-audit-events");
    expect(logsVerify).toContain(
      "--evidence-artifact '.data/v1/gate-16-cloud-run-logs.md'",
    );
  });

  it("omits bearer secret for OAuth and points follow-up to remote OAuth smoke", () => {
    const options = parseCloudRunPlanArgs(
      [
        ...baseArgs,
        "--auth-mode",
        "oauth",
        "--public-base-url",
        "https://mcp.example.com",
        "--oauth-authorization-server-url",
        "https://auth.example.com",
        "--oauth-jwks-url",
        "https://auth.example.com/jwks.json",
        "--oauth-resource-documentation-url",
        "https://mcp.example.com/docs",
        "--oauth-jwt-algorithms",
        "PS256,EdDSA",
      ],
      {},
    );
    if (options.help) {
      throw new Error("Expected runnable Cloud Run plan options.");
    }

    const plan = buildCloudRunPlan(options);
    const deploy = plan.commands.find((entry) =>
      entry.label.includes("Deploy"),
    )?.command;

    expect(plan.secret_names).toEqual([
      "substack-session-token",
      "mcp-preview-token-secret",
    ]);
    expect(deploy).toContain("AUTH_MODE=oauth");
    expect(deploy).toContain("MCP_PUBLIC_BASE_URL=https://mcp.example.com");
    expect(deploy).toContain("OAUTH_JWT_ALGORITHMS=PS256,EdDSA");
    expect(deploy).toContain(
      "OAUTH_RESOURCE_DOCUMENTATION_URL=https://mcp.example.com/docs",
    );
    expect(deploy).not.toContain("MCP_BEARER_TOKEN");
    const followUp = plan.follow_up_commands.find((entry) =>
      entry.label.includes("remote"),
    )?.command;
    expect(followUp).toContain(
      'MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN"',
    );
    expect(followUp).toContain("npm run smoke:remote-oauth");
    expect(followUp).toContain(
      "--evidence-artifact '.data/v1/remote-oauth.md'",
    );
    const verify = plan.follow_up_commands.find((entry) =>
      entry.label.includes("Verify"),
    )?.command;
    expect(verify).toContain("--auth-mode 'oauth'");
    expect(verify).toContain("--public-base-url 'https://mcp.example.com'");
    expect(verify).toContain(
      "--oauth-authorization-server-url 'https://auth.example.com'",
    );
    expect(verify).toContain(
      "--oauth-jwks-url 'https://auth.example.com/jwks.json'",
    );
    expect(verify).toContain(
      "--oauth-resource-documentation-url 'https://mcp.example.com/docs'",
    );
    expect(verify).toContain("--oauth-jwt-algorithms 'PS256,EdDSA'");
    expect(verify).not.toContain("--bearer-token-secret");
    expect(plan.notes.join("\n")).toContain(
      "fill the manual launch-review section in .data/v1/remote-oauth.md",
    );
  });

  it("points noauth follow-up to the noauth remote smoke and warns about exposure", () => {
    const options = parseCloudRunPlanArgs(
      [...baseArgs, "--auth-mode", "noauth"],
      {},
    );
    if (options.help) {
      throw new Error("Expected runnable Cloud Run plan options.");
    }

    const plan = buildCloudRunPlan(options);
    const followUp = plan.follow_up_commands.find((entry) =>
      entry.label.includes("remote"),
    )?.command;
    expect(followUp).toContain("npm run smoke:remote-noauth");
    expect(plan.notes.join("\n")).toContain("AUTH_MODE=noauth");
  });

  it("adds optional MCP path secret Secret Manager wiring and path-aware follow-ups", () => {
    const options = parseCloudRunPlanArgs(
      [...baseArgs, "--mcp-path-secret", "mcp-path-secret"],
      {},
    );
    if (options.help) {
      throw new Error("Expected runnable Cloud Run plan options.");
    }

    const plan = buildCloudRunPlan(options);
    const deploy = plan.commands.find((entry) =>
      entry.label.includes("Deploy"),
    )?.command;
    const createPathSecret = plan.commands.find((entry) =>
      entry.label.includes("MCP path secret"),
    )?.command;
    const verify = plan.follow_up_commands.find((entry) =>
      entry.label.includes("Verify"),
    )?.command;
    const followUp = plan.follow_up_commands.find((entry) =>
      entry.label.includes("remote"),
    )?.command;

    expect(plan.secret_names).toEqual([
      "substack-session-token",
      "mcp-preview-token-secret",
      "mcp-bearer-token",
      "mcp-path-secret",
    ]);
    expect(createPathSecret).toContain(
      "MCP_PATH_SECRET:?Set MCP_PATH_SECRET to one URL-safe path segment first",
    );
    expect(createPathSecret).toContain(
      "gcloud secrets create 'mcp-path-secret'",
    );
    expect(plan.commands.map((entry) => entry.label)).toContain(
      "Grant service account access to mcp-path-secret",
    );
    expect(deploy).toContain("MCP_PATH_SECRET=mcp-path-secret:latest");
    expect(verify).toContain("--mcp-path-secret 'mcp-path-secret'");
    expect(followUp).toContain(
      "MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first",
    );
    expect(followUp).toContain('--url "$SERVICE_URL/mcp/$MCP_PATH_SECRET"');
    expect(plan.notes.join("\n")).toContain(
      "MCP_PATH_SECRET is deployed from Secret Manager",
    );
  });
});

describe("renderCloudRunPlan", () => {
  it("renders commands and notes without secret values", () => {
    const options = parseCloudRunPlanArgs(baseArgs, {});
    if (options.help) {
      throw new Error("Expected runnable Cloud Run plan options.");
    }

    const rendered = renderCloudRunPlan(buildCloudRunPlan(options));

    expect(rendered).toContain("# Cloud Run deployment plan");
    expect(rendered).toContain("gcloud run deploy");
    expect(rendered).toContain("gcloud billing budgets create");
    expect(rendered).toContain("--budget-amount 5USD");
    expect(rendered).toContain("--threshold-rule percent=1.00");
    expect(rendered).toContain("$5 monthly budget");
    expect(rendered).toContain("gcloud logging read");
    expect(rendered).toContain("npm run cloud-run:logs:verify");
    expect(rendered).toContain(
      "--evidence-artifact '.data/v1/gate-16-cloud-run-logs.md'",
    );
    expect(rendered).toContain(
      'curl --fail --show-error "$SERVICE_URL/healthz"',
    );
    expect(rendered).toContain(
      "gcloud run services describe 'substack-draft-mcp' --region 'us-central1' --format=json > .data/cloud-run-service.json",
    );
    expect(rendered).toContain("npm run cloud-run:verify");
    expect(rendered).toContain(
      "--evidence-artifact '.data/v1/gate-12-cloud-run-deployment.md'",
    );
    expect(rendered).toContain(
      "--evidence-artifact '.data/v1/gate-13-cloud-run-secrets.md'",
    );
    expect(rendered).toContain("npm run smoke:remote");
    expect(rendered).toContain("SUBSTACK_SESSION_TOKEN");
    expect(rendered).not.toContain("SUBSTACK_SESSION_TOKEN=replace");
  });

  it("describes CLI usage", () => {
    expect(cloudRunPlanUsage()).toContain("npm run cloud-run:plan");
    expect(cloudRunPlanUsage()).toContain("--auth-mode");
    expect(cloudRunPlanUsage()).toContain("--mcp-path-secret");
  });
});
