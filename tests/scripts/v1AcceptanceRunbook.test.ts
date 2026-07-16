import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildV1AcceptanceRunbook,
  parseV1AcceptanceRunbookArgs,
  renderV1AcceptanceRunbook,
  v1AcceptanceRunbookUsage,
  writeV1AcceptanceRunbook,
} from "../../scripts/v1AcceptanceRunbookCore.js";
import type { V1AcceptanceStatusReport } from "../../scripts/v1AcceptanceStatusCore.js";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("parseV1AcceptanceRunbookArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("uses the current project and stdout by default", () => {
    expect(parseV1AcceptanceRunbookArgs([], cwd)).toEqual({
      help: false,
      cwd,
      fixtureDir: `${cwd}/fixtures/substack`,
      writeArtifacts: false,
    });
  });

  it("parses project-local evidence and output paths", () => {
    expect(
      parseV1AcceptanceRunbookArgs(
        [
          "--evidence-file",
          ".data/v1-acceptance-evidence.json",
          "--fixture-dir",
          "fixtures/live",
          "--output",
          ".data/v1/manual-acceptance-runbook.md",
          "--gate",
          "7",
          "--gate",
          "11",
          "--gate",
          "7",
          "--mcp-path-secret",
          "mcp-path-secret",
          "--write-artifacts",
        ],
        cwd,
      ),
    ).toEqual({
      help: false,
      cwd,
      evidenceFile: `${cwd}/.data/v1-acceptance-evidence.json`,
      fixtureDir: `${cwd}/fixtures/live`,
      output: `${cwd}/.data/v1/manual-acceptance-runbook.md`,
      gateIds: [7, 11],
      mcpPathSecret: "mcp-path-secret",
      writeArtifacts: true,
    });
  });

  it("allows help and rejects invalid arguments", () => {
    expect(parseV1AcceptanceRunbookArgs(["--help"], cwd)).toEqual({
      help: true,
    });
    expect(parseV1AcceptanceRunbookArgs(["-h"], cwd)).toEqual({
      help: true,
    });
    expect(() =>
      parseV1AcceptanceRunbookArgs(["--output", "../runbook.md"], cwd),
    ).toThrow("path must stay inside the project directory.");
    expect(() =>
      parseV1AcceptanceRunbookArgs(["--fixture-dir", "../outside"], cwd),
    ).toThrow("--fixture-dir must stay inside the project directory.");
    expect(() =>
      parseV1AcceptanceRunbookArgs(["--evidence-file"], cwd),
    ).toThrow("--evidence-file requires a value.");
    expect(() => parseV1AcceptanceRunbookArgs(["--gate"], cwd)).toThrow(
      "--gate requires a value.",
    );
    expect(() => parseV1AcceptanceRunbookArgs(["--gate", "18"], cwd)).toThrow(
      "--gate must be an integer from 1 to 17.",
    );
    expect(() =>
      parseV1AcceptanceRunbookArgs(["--mcp-path-secret"], cwd),
    ).toThrow("--mcp-path-secret requires a value.");
    expect(() =>
      parseV1AcceptanceRunbookArgs(["--mcp-path-secret", "   "], cwd),
    ).toThrow("--mcp-path-secret is required.");
    expect(() => parseV1AcceptanceRunbookArgs(["--bogus"], cwd)).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("buildV1AcceptanceRunbook", () => {
  it("renders the current manual/live acceptance checklist", () => {
    const runbook = buildV1AcceptanceRunbook({ cwd: projectRoot });

    expect(runbook.complete).toBe(false);
    expect(runbook.manual_gate_count).toBe(9);
    expect(runbook.artifacts).not.toContainEqual({
      gate_id: 3,
      path: ".data/v1/gate-03-mcp-inspector.md",
      created: false,
    });
    expect(runbook.artifacts).toContainEqual({
      gate_id: 7,
      path: ".data/v1/gate-07-rich-draft-live-fixtures.md",
      created: false,
    });
    expect(runbook.artifacts).toContainEqual({
      gate_id: 16,
      path: ".data/v1/gate-16-cloud-run-logs.md",
      created: false,
    });
    expect(runbook.markdown).toContain("# V1 manual/live acceptance runbook");
    expect(runbook.markdown).toContain(
      "Re-run `npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json --require-complete` before release.",
    );
    expect(runbook.markdown).toContain(
      "### Gate 7: `create_draft` creates a rich Substack draft",
    );
    expect(runbook.markdown).toContain(
      `- Live fixture directory: ${projectRoot}/fixtures/substack`,
    );
    expect(runbook.markdown).not.toContain("### Gate 3:");
    expect(runbook.markdown).not.toContain("npm run smoke:inspector");
    expect(runbook.markdown).toContain(
      "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
    );
    expect(runbook.markdown).toContain("npm run fixtures:status");
    expect(runbook.markdown).toContain(
      "npm run create:fixture -- --kind inline-marks --capture",
    );
    expect(runbook.markdown).toContain(
      "npm run create:fixture -- --kind latex-block --capture",
    );
    expect(runbook.markdown).toContain(
      "# Or capture all four required fixtures in one live run:",
    );
    expect(runbook.markdown).toContain(
      "npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
    expect(runbook.markdown).toContain(
      ".data/v1/gate-07-rich-draft-live-fixtures.md",
    );
    expect(runbook.markdown).toContain("npm run v1:record -- --gate 7");
    expect(runbook.markdown).toContain(
      "complete the update review detail fields in the artifact",
    );
    expect(runbook.markdown).toContain(
      "complete the read review detail fields in the artifact",
    );
    expect(runbook.markdown).toContain(
      "npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
    );
    expect(runbook.markdown).not.toContain(
      "npm run smoke:remote-noauth -- --url https://<subdomain>.ngrok.app/mcp",
    );
    expect(runbook.markdown).toContain(
      "gcloud run services describe substack-draft-mcp --region us-central1 --format=json > .data/cloud-run-service.json",
    );
    expect(runbook.markdown).toContain(
      "SERVICE_URL=$(gcloud run services describe substack-draft-mcp --region us-central1 --format='value(status.url)')",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --evidence-artifact .data/v1/gate-12-cloud-run-deployment.md",
    );
    expect(runbook.markdown).toContain(
      "For OAuth deployments, use the full `cloud-run:plan` generated `cloud-run:verify` command",
    );
    expect(runbook.markdown).not.toContain("--mcp-path-secret");
    expect(runbook.markdown).toContain(
      'curl --fail --show-error "$SERVICE_URL/healthz"',
    );
    expect(runbook.markdown).toContain(
      "Run the auth-mode matching remote smoke from the `cloud-run:plan` follow-up output.",
    );
    expect(runbook.markdown).toContain(
      ': "$' +
        '{MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first}" && MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url "$SERVICE_URL/mcp" --evidence-artifact .data/v1/gate-14-static-bearer-remote.md',
    );
    expect(runbook.markdown).toContain(
      ': "$' +
        '{MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first}" && MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth -- --url "$SERVICE_URL/mcp" --evidence-artifact .data/v1/remote-oauth.md',
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --evidence-artifact .data/v1/gate-13-cloud-run-secrets.md",
    );
    expect(runbook.markdown).toContain(
      "complete the Cloud Run deployment detail fields in the artifact",
    );
    expect(runbook.markdown).toContain(
      "complete the Secret Manager detail fields in the artifact",
    );
    expect(runbook.markdown).toContain(
      "npm run smoke:ngrok-static-bearer -- --bearer-token-env MCP_BEARER_TOKEN --hold-open-seconds 900 --evidence-artifact .data/v1/gate-14-static-bearer-remote.md",
    );
    expect(runbook.markdown).toContain(
      "complete the manual checklist and client-detail fields in the artifact",
    );
    expect(runbook.markdown).not.toContain(
      "npm run smoke:remote -- --url https://<host>/mcp --evidence-artifact .data/v1/gate-14-static-bearer-remote.md",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md",
    );
    expect(runbook.markdown).toContain(
      "Logs were exported after live Cloud Run acceptance traffic.",
    );
    expect(runbook.markdown).toContain(
      "`cloud-run:logs:verify` completed with required audit events.",
    );
    expect(runbook.markdown).toContain(
      "Exported logs contained no cookie, bearer-token, secret-environment, or private MCP path leaks.",
    );
    expect(runbook.markdown).toContain(
      "Evidence was reviewed to confirm no raw log entries or secret values are included.",
    );
    expect(runbook.markdown).toContain(
      "complete the manual log-review detail fields in the artifact",
    );
    expect(runbook.markdown).toContain("mkdir -p .data && gcloud logging read");
    expect(runbook.markdown).toContain(
      "npm run smoke:stdio -- --evidence-artifact .data/v1/gate-15-stdio-client.md",
    );
    expect(runbook.markdown).toContain(
      "complete the manual checklist and client-detail fields in the artifact",
    );
    expect(runbook.markdown).toContain(
      'resource.labels.service_name="substack-draft-mcp"',
    );
    expect(runbook.markdown).not.toContain(
      'resource.labels.service_name="substack-mcp"',
    );
  });

  it("renders optional Cloud Run path-secret commands for gate 12 and 13", () => {
    const runbook = buildV1AcceptanceRunbook({
      cwd: projectRoot,
      gateIds: [12, 13],
      mcpPathSecret: "mcp-path-secret",
    });

    expect(runbook.mcp_path_secret).toBe("mcp-path-secret");
    expect(runbook.markdown).toContain(
      "npm run cloud-run:plan -- --project-id <id> --publication-url <url> --user-id <id> --mcp-path-secret mcp-path-secret",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --mcp-path-secret mcp-path-secret --evidence-artifact .data/v1/gate-12-cloud-run-deployment.md",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --mcp-path-secret mcp-path-secret --evidence-artifact .data/v1/gate-13-cloud-run-secrets.md",
    );
    expect(runbook.markdown).toContain(
      ': "$' +
        '{MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first}" && : "$' +
        '{MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first}" && MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url "$SERVICE_URL/mcp/$MCP_PATH_SECRET"',
    );
    expect(runbook.markdown).toContain(
      '# For noauth testing: : "$' +
        '{MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first}" && npm run smoke:remote-noauth -- --url "$SERVICE_URL/mcp/$MCP_PATH_SECRET"',
    );
    expect(runbook.markdown).toContain(
      '# For OAuth testing: : "$' +
        '{MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first}" && : "$' +
        '{MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first}" && MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth -- --url "$SERVICE_URL/mcp/$MCP_PATH_SECRET"',
    );
    expect(runbook.markdown).not.toContain("MCP_PATH_SECRET=");
  });

  it("filters the runbook and artifact list to selected manual gates", () => {
    const runbook = buildV1AcceptanceRunbook({
      cwd: projectRoot,
      gateIds: [11],
    });

    expect(runbook.manual_gate_count).toBe(1);
    expect(runbook.artifacts).toEqual([
      {
        gate_id: 11,
        path: ".data/v1/gate-11-chatgpt-ngrok.md",
        created: false,
      },
    ]);
    expect(runbook.markdown).toContain("- Selected gates: 11");
    expect(runbook.markdown).toContain(
      "### Gate 11: Local ngrok + ChatGPT connector works.",
    );
    expect(runbook.markdown).toContain(
      "npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
    );
    expect(runbook.markdown).toContain(
      "While the live endpoint notice is displayed, register or refresh the ChatGPT connector and complete the manual flow.",
    );
    expect(runbook.markdown).not.toContain("### Gate 7:");
    expect(runbook.markdown).not.toContain("### Gate 12:");
  });

  it("includes service JSON export in the gate 13 runbook", () => {
    const runbook = buildV1AcceptanceRunbook({
      cwd: projectRoot,
      gateIds: [13],
    });

    expect(runbook.manual_gate_count).toBe(1);
    expect(runbook.artifacts).toEqual([
      {
        gate_id: 13,
        path: ".data/v1/gate-13-cloud-run-secrets.md",
        created: false,
      },
    ]);
    expect(runbook.markdown).toContain(
      "### Gate 13: Cloud Run stores Substack session token",
    );
    expect(runbook.markdown).toContain(
      "mkdir -p .data && gcloud run services describe substack-draft-mcp --region us-central1 --format=json > .data/cloud-run-service.json",
    );
    expect(runbook.markdown).toContain(
      "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --evidence-artifact .data/v1/gate-13-cloud-run-secrets.md",
    );
    expect(runbook.markdown).not.toContain("### Gate 12:");
  });

  it("renders custom fixture directory commands for gate 7", () => {
    const runbook = buildV1AcceptanceRunbook({
      cwd: projectRoot,
      gateIds: [7],
      fixtureDir: resolve(projectRoot, "fixtures", "live captures"),
    });

    expect(runbook.fixture_capture_dir_arg).toBe("fixtures/live captures");
    expect(runbook.markdown).toContain(
      `- Live fixture directory: ${projectRoot}/fixtures/live captures`,
    );
    expect(runbook.markdown).toContain(
      "npm run fixtures:status -- --fixture-dir 'fixtures/live captures'",
    );
    expect(runbook.markdown).toContain(
      "npm run create:fixture -- --kind inline-marks --capture --fixture-dir 'fixtures/live captures'",
    );
    expect(runbook.markdown).toContain(
      "npm run create:fixture -- --kind all --capture --fixture-dir 'fixtures/live captures'",
    );
    expect(runbook.markdown).toContain(
      "npm run fixtures:status -- --fixture-dir 'fixtures/live captures' --require-all",
    );
    expect(runbook.markdown).toContain(
      "SUBSTACK_FIXTURE_DIR='fixtures/live captures' npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
    expect(runbook.markdown).toContain(
      "Re-run `npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json --fixture-dir 'fixtures/live captures' --require-complete` before release.",
    );
    expect(runbook.markdown).toContain(
      "npm run v1:record -- --gate 7 --fixture-dir 'fixtures/live captures'",
    );
  });

  it("can write the runbook to a project-local file", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "v1-runbook-"));
    const output = join(tempRoot, ".data", "v1", "runbook.md");
    try {
      const result = writeV1AcceptanceRunbook({
        help: false,
        cwd: tempRoot,
        output,
        writeArtifacts: false,
      });

      expect(result.output).toBe(output);
      expect(existsSync(output)).toBe(true);
      expect(readFileSync(output, "utf8")).toBe(result.markdown);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes missing suggested evidence artifact templates without overwriting existing files", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "v1-runbook-artifacts-"));
    const existingArtifact = join(
      tempRoot,
      ".data",
      "v1",
      "gate-11-chatgpt-ngrok.md",
    );
    try {
      mkdirSync(join(tempRoot, ".data", "v1"), { recursive: true });
      writeFileSync(
        join(tempRoot, "README.md"),
        "Run @modelcontextprotocol/inspector for local acceptance.",
      );
      mkdirSync(join(tempRoot, "src", "logging"), { recursive: true });
      mkdirSync(join(tempRoot, "tests", "logging"), { recursive: true });
      mkdirSync(join(tempRoot, "tests", "safety"), { recursive: true });
      mkdirSync(join(tempRoot, "tests", "scripts"), { recursive: true });
      mkdirSync(join(tempRoot, "scripts"), { recursive: true });
      writeFileSync(join(tempRoot, "src", "logging", "audit.ts"), "");
      writeFileSync(join(tempRoot, "tests", "logging", "audit.test.ts"), "");
      writeFileSync(join(tempRoot, "tests", "logging", "logger.test.ts"), "");
      writeFileSync(join(tempRoot, "tests", "safety", "redaction.test.ts"), "");
      writeFileSync(join(tempRoot, "scripts", "cloudRunLogsVerify.ts"), "");
      writeFileSync(
        join(tempRoot, "tests", "scripts", "cloudRunLogsVerify.test.ts"),
        "",
      );
      writeFileSync(existingArtifact, "operator notes");

      const result = writeV1AcceptanceRunbook({
        help: false,
        cwd: tempRoot,
        writeArtifacts: true,
      });
      const createdPaths = result.artifacts
        .filter((artifact) => artifact.created)
        .map((artifact) => artifact.path);
      const richDraftTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-07-rich-draft-live-fixtures.md",
      );
      const updateDraftTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-08-update-draft-live.md",
      );
      const readDraftsTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-09-read-drafts-live.md",
      );
      const cloudRunTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-12-cloud-run-deployment.md",
      );
      const cloudRunSecretsTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-13-cloud-run-secrets.md",
      );
      const staticBearerTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-14-static-bearer-remote.md",
      );
      const stdioClientTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-15-stdio-client.md",
      );
      const cloudRunLogsTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-16-cloud-run-logs.md",
      );

      expect(
        result.artifacts.find((artifact) => artifact.gate_id === 11),
      ).toMatchObject({
        path: ".data/v1/gate-11-chatgpt-ngrok.md",
        created: false,
      });
      expect(readFileSync(existingArtifact, "utf8")).toBe("operator notes");
      expect(createdPaths).toContain(
        ".data/v1/gate-07-rich-draft-live-fixtures.md",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "Do not paste Substack session cookies",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "reject unchecked checkboxes and placeholders",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "## Required Evidence Checklist",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "`npm run fixtures:status` was reviewed",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "`npm run fixtures:status -- --require-all` passed",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "`npm test -- tests/content/substackFixtureCompatibility.test.ts` passed",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "npm run create:fixture -- --kind image --capture",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "native LaTeX rendering",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "## Gate 7 Manual Review Details",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "- Fixture directory: fixtures/substack",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "- Fixture provenance review:",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "- Text formatting review:",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "- Substack preview review:",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "- Unpublished status review:",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "Manual Substack review confirmed title, subtitle, text formatting, image rendering, native code block rendering, native LaTeX rendering, preview behavior, unpublished status, and cleanup decision.",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "Gate 7 fixture provenance identifies how each live fixture was captured or manually reviewed so adapter compatibility is not treated as native editor proof by itself.",
      );
      expect(readFileSync(richDraftTemplate, "utf8")).toContain(
        "npm run v1:record -- --gate 7",
      );
      expect(readFileSync(updateDraftTemplate, "utf8")).toContain(
        "## Gate 8 Update Review Details",
      );
      expect(readFileSync(updateDraftTemplate, "utf8")).toContain(
        "- Draft URL or ID: <replace with Substack draft URL or numeric draft ID from the live update flow>",
      );
      expect(readFileSync(updateDraftTemplate, "utf8")).toContain(
        "- Created title before update:",
      );
      expect(readFileSync(updateDraftTemplate, "utf8")).toContain(
        "- Update command: <replace with guarded live run command or explicit live MCP/client update_draft workflow>",
      );
      expect(readFileSync(updateDraftTemplate, "utf8")).toContain(
        "- Post-update `get_draft` review:",
      );
      expect(readFileSync(updateDraftTemplate, "utf8")).toContain(
        "Gate 8 update review details identify the live draft, title transition, update command, field update result, unpublished status, post-update readback, body handling, and cleanup decision without publishing.",
      );
      expect(readFileSync(readDraftsTemplate, "utf8")).toContain(
        "## Gate 9 Read Review Details",
      );
      expect(readFileSync(readDraftsTemplate, "utf8")).toContain(
        "- Draft URL or ID read: <replace with Substack draft URL or numeric draft ID from the live read flow>",
      );
      expect(readFileSync(readDraftsTemplate, "utf8")).toContain(
        "- `list_drafts` result:",
      );
      expect(readFileSync(readDraftsTemplate, "utf8")).toContain(
        "- Body inclusion review:",
      );
      expect(readFileSync(readDraftsTemplate, "utf8")).toContain(
        "- Follow-up action: <replace with no-action reason, cleanup decision, or concrete follow-up>",
      );
      expect(readFileSync(readDraftsTemplate, "utf8")).toContain(
        "Gate 9 read review details identify the draft, list result, get result, metadata reviewed, body-inclusion decision, post-update readback, raw-content handling, and follow-up action.",
      );
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "Exported service JSON was verified with `npm run cloud-run:verify`, including OAuth metadata env when deployed with `AUTH_MODE=oauth`.",
      );
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "Remote `/healthz` and the appropriate remote MCP smoke passed",
      );
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "## Gate 12 Cloud Run Deployment Details",
      );
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "- GCP project/region/service: <replace with non-sensitive project, region, and service reference>",
      );
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "- Path-secret review: <replace with not used or shell-only private path verification without the segment value>",
      );
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "Gate 12 Cloud Run deployment details identify the project/region/service, service URL check, deploy command source, health check, remote smoke, deployed auth mode, budget guard, and path-secret review.",
      );
      expect(readFileSync(cloudRunSecretsTemplate, "utf8")).toContain(
        "## Gate 13 Secret Manager Details",
      );
      expect(readFileSync(cloudRunSecretsTemplate, "utf8")).toContain(
        "- Secret references checked: <replace with Secret Manager reference check summary for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET>",
      );
      expect(readFileSync(cloudRunSecretsTemplate, "utf8")).toContain(
        "- Secret value handling: <replace with confirmation no raw secret values were opened, pasted, exposed, or recorded>",
      );
      expect(readFileSync(cloudRunSecretsTemplate, "utf8")).toContain(
        "Gate 13 Secret Manager details identify the required secret references, secret names, runtime service account, access bindings, version policy, literal-env review, secret-value handling, and rotation follow-up.",
      );
      expect(readFileSync(staticBearerTemplate, "utf8")).toContain(
        "## Gate 14 Header-Capable Client Details",
      );
      expect(readFileSync(staticBearerTemplate, "utf8")).toContain(
        "- Endpoint tested: <replace with public HTTPS /mcp endpoint tested through the header-capable client>",
      );
      expect(readFileSync(staticBearerTemplate, "utf8")).toContain(
        "- Header configuration method: <replace with how Authorization header was configured without the token value>",
      );
      expect(readFileSync(staticBearerTemplate, "utf8")).toContain(
        "- Rejection proof: <replace with missing and wrong bearer 401 rejection command or artifact reference>",
      );
      expect(readFileSync(staticBearerTemplate, "utf8")).toContain(
        "- Token redaction review: <replace with confirmation that no bearer token or token value is included, recorded, printed, pasted, exposed, or logged>",
      );
      expect(readFileSync(staticBearerTemplate, "utf8")).toContain(
        "Gate 14 header-capable client details identify the client version, public HTTPS /mcp endpoint reference, header configuration method, tool-list result, validation result, rejection proof, and token-redaction review.",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "## Gate 15 Manual Client Details",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "- Client tested: <replace with Claude Code or Cursor version>",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "- Config path or add command: <replace with Claude Code/Cursor stdio config path or add command>",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "- Tool-list result: <replace with exact seven V1 draft-workflow tools listed through Claude Code or Cursor>",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "- Validation call result: <replace with validate_newsletter_content success through Claude Code or Cursor>",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "- Credential locality review: <replace with confirmation that Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely>",
      );
      expect(readFileSync(stdioClientTemplate, "utf8")).toContain(
        "Gate 15 manual client details identify the client version, Claude Code/Cursor stdio config path or add command, entrypoint path, tool-list result, validation result, and local-credentials review.",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "## Gate 16 Cloud Run Log Review Details",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "- Log export window: <replace with live Cloud Run log export start/end time or query window>",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "- Cloud Run service/revision: <replace with Cloud Run service name and revision or service URL reference>",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "- Log export command: <replace with gcloud logging read command including Cloud Run resource filter>",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "- Verifier command: <replace with cloud-run:logs:verify command including --logs-json and --require-audit-events>",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "- Finding review: <replace with no findings or sanitized finding-category/count summary>",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "- Raw log handling: <replace with retained/deleted path and access decision>",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "Logs were exported after live Cloud Run acceptance traffic.",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "`cloud-run:logs:verify` completed with required audit events.",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "Exported logs contained no draft content or request/response body fields.",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "Audit events were metadata-only and used the allowed field set.",
      );
      expect(readFileSync(cloudRunLogsTemplate, "utf8")).toContain(
        "Evidence was reviewed to confirm no raw log entries or secret values are included.",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes Cloud Run path-secret evidence templates when requested", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "v1-runbook-path-secret-"));
    try {
      const result = writeV1AcceptanceRunbook({
        help: false,
        cwd: tempRoot,
        gateIds: [12],
        mcpPathSecret: "mcp-path-secret",
        writeArtifacts: true,
      });
      const cloudRunTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-12-cloud-run-deployment.md",
      );
      const template = readFileSync(cloudRunTemplate, "utf8");

      expect(result.mcp_path_secret).toBe("mcp-path-secret");
      expect(template).toContain("--mcp-path-secret mcp-path-secret");
      expect(template).toContain('--url "$SERVICE_URL/mcp/$MCP_PATH_SECRET"');
      expect(template).toContain("`MCP_PATH_SECRET` was kept in the shell");
      expect(template).toContain(
        "`MCP_PATH_SECRET` was kept in the shell and remote smoke used the private `/mcp/<secret>` path without recording the path segment.",
      );
      expect(template).not.toContain("MCP_PATH_SECRET=");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes only selected evidence artifact templates when gates are filtered", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "v1-runbook-filtered-"));
    try {
      mkdirSync(join(tempRoot, ".data", "v1"), { recursive: true });

      const result = writeV1AcceptanceRunbook({
        help: false,
        cwd: tempRoot,
        gateIds: [12],
        writeArtifacts: true,
      });
      const cloudRunTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-12-cloud-run-deployment.md",
      );
      const richDraftTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-07-rich-draft-live-fixtures.md",
      );

      expect(result.artifacts).toEqual([
        {
          gate_id: 12,
          path: ".data/v1/gate-12-cloud-run-deployment.md",
          created: true,
        },
      ]);
      expect(existsSync(cloudRunTemplate)).toBe(true);
      expect(existsSync(richDraftTemplate)).toBe(false);
      expect(readFileSync(cloudRunTemplate, "utf8")).toContain(
        "npm run v1:record -- --gate 12",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes gate 11 evidence templates with ChatGPT connector details", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "v1-runbook-chatgpt-"));
    try {
      const result = writeV1AcceptanceRunbook({
        help: false,
        cwd: tempRoot,
        gateIds: [11],
        writeArtifacts: true,
      });
      const chatgptTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-11-chatgpt-ngrok.md",
      );
      const template = readFileSync(chatgptTemplate, "utf8");

      expect(result.artifacts).toEqual([
        {
          gate_id: 11,
          path: ".data/v1/gate-11-chatgpt-ngrok.md",
          created: true,
        },
      ]);
      expect(template).toContain("## Gate 11 ChatGPT Connector Details");
      expect(template).toContain(
        "- Connector URL: <replace with public HTTPS /mcp URL or screenshot reference>",
      );
      expect(template).toContain(
        "- ChatGPT surface tested: <replace with workspace/account or connector screen reference>",
      );
      expect(template).toContain(
        "- Manual flow result: <replace with ChatGPT validate/preview/create draft summary>",
      );
      expect(template).toContain(
        "- Tool-list result: <replace with exactly seven V1 draft-workflow tools listed through the ChatGPT connector>",
      );
      expect(template).toContain(
        "- Draft or review reference: <replace with non-sensitive Substack draft URL, numeric draft ID, screenshot reference, or manual review reference>",
      );
      expect(template).toContain(
        "- Tunnel exposure window: <replace with bounded start/end time or numeric duration>",
      );
      expect(template).toContain(
        "- Unexpected traffic review: <replace with checked ngrok/local logs and no unexpected traffic or handled findings>",
      );
      expect(template).toContain(
        "Gate 11 ChatGPT connector details identify the public HTTPS /mcp connector URL, ChatGPT surface, exact seven-tool result, manual flow result, non-sensitive draft or review reference, tunnel exposure window, unexpected-traffic review, and rotation decision.",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes gate 7 evidence templates with custom fixture directory commands", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "v1-runbook-custom-fixture-"));
    try {
      const result = writeV1AcceptanceRunbook({
        help: false,
        cwd: tempRoot,
        fixtureDir: join(tempRoot, "fixtures", "live captures"),
        gateIds: [7],
        writeArtifacts: true,
      });
      const richDraftTemplate = join(
        tempRoot,
        ".data",
        "v1",
        "gate-07-rich-draft-live-fixtures.md",
      );
      const template = readFileSync(richDraftTemplate, "utf8");

      expect(result.artifacts).toEqual([
        {
          gate_id: 7,
          path: ".data/v1/gate-07-rich-draft-live-fixtures.md",
          created: true,
        },
      ]);
      expect(template).toContain(
        "npm run fixtures:status -- --fixture-dir 'fixtures/live captures'",
      );
      expect(template).toContain(
        "npm run create:fixture -- --kind image --capture --fixture-dir 'fixtures/live captures'",
      );
      expect(template).toContain(
        "`npm run fixtures:status -- --fixture-dir 'fixtures/live captures' --require-all` passed",
      );
      expect(template).toContain(
        "`SUBSTACK_FIXTURE_DIR='fixtures/live captures' npm test -- tests/content/substackFixtureCompatibility.test.ts` passed",
      );
      expect(template).toContain("- Fixture directory: fixtures/live captures");
      expect(template).toContain(
        "- Fixture readiness command: `npm run fixtures:status -- --fixture-dir 'fixtures/live captures' --require-all`",
      );
      expect(template).toContain(
        "- Fixture compatibility command: `SUBSTACK_FIXTURE_DIR='fixtures/live captures' npm test -- tests/content/substackFixtureCompatibility.test.ts`",
      );
      expect(template).toContain("- Fixture provenance review:");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders a completed status without manual gate sections", () => {
    const markdown = renderV1AcceptanceRunbook(completeStatus());

    expect(markdown).toContain(
      "No manual/live gates currently require evidence",
    );
    expect(markdown).toContain(
      "Run `npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json --require-complete` for the final release gate.",
    );
    expect(markdown).not.toContain("Suggested evidence record:");
  });

  it("renders an empty selected runbook when the selected gate is already local", () => {
    const markdown = renderV1AcceptanceRunbook(completeStatus(), [1]);

    expect(markdown).toContain("- Selected gates: 1");
    expect(markdown).toContain(
      "No selected manual/live gates currently require evidence.",
    );
    expect(markdown).not.toContain("Suggested evidence record:");
  });

  it("prints usage text", () => {
    expect(v1AcceptanceRunbookUsage()).toContain("npm run v1:runbook");
    expect(v1AcceptanceRunbookUsage()).toContain("--fixture-dir");
    expect(v1AcceptanceRunbookUsage()).toContain("--output");
    expect(v1AcceptanceRunbookUsage()).toContain("--gate");
    expect(v1AcceptanceRunbookUsage()).toContain("--mcp-path-secret");
    expect(v1AcceptanceRunbookUsage()).toContain("--write-artifacts");
  });
});

function completeStatus(): V1AcceptanceStatusReport {
  return {
    complete: true,
    fixture_ready: true,
    fixture_present_count: 4,
    fixture_valid_count: 4,
    fixture_compatible_count: 4,
    fixture_required_count: 4,
    summary: {
      total: 1,
      local_evidence_available: 1,
      manual_or_live_evidence_recorded: 0,
      manual_or_live_evidence_required: 0,
      missing_local_artifact: 0,
    },
    gates: [
      {
        id: 1,
        criterion: "`npm test` passes.",
        status: "local_evidence_available",
        evidence: "Tests passed.",
        next_action: "None.",
      },
    ],
  };
}
