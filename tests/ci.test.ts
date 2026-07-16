import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("CI workflow", () => {
  it("runs the local V1 validation matrix without requiring external acceptance", () => {
    const workflow = readFileSync(
      resolve(projectRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    for (const text of [
      "ScaffoldGuard 0.1.2 expects the generated TypeScript CI token `npm install`",
      "- run: npm ci",
      "- run: npm run format:check",
      "- run: npm run lint",
      "- run: npm run typecheck",
      "- run: npm test",
      "- run: npm run build",
      "- run: npm run validate:v1-local",
      "- run: npm run coverage",
      "- run: scaffold-guard check",
    ]) {
      expect(workflow).toContain(text);
    }

    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const localValidation = manifest.scripts?.["validate:v1-local"];

    for (const command of [
      "npm run create:fixture -- --kind all --dry-run",
      "npm run fixtures:status",
      "npm run v1:preflight -- --json --no-env-file",
      "npm run v1:status -- --json",
      "npm run v1:runbook",
      "npm run build",
      "npm run smoke:docker-http",
      "npm run smoke:http-local",
      "npm run smoke:inspector",
      "npm run smoke:http-static-bearer",
      "npm run smoke:http-oauth",
      "npm run smoke:stdio",
    ]) {
      expect(localValidation).toContain(command);
    }

    expect(workflow).not.toContain("fixtures:status -- --require-all");
    expect(workflow).not.toContain("v1:status -- --require-complete");
    expect(workflow).not.toContain("npm run test:live");
    expect(workflow).not.toContain("npm run smoke:ngrok");
    expect(workflow).not.toContain("npm run cloud-run:");
    expect(workflow).not.toContain("- run: npm install");
  });
});

describe("repository hygiene examples", () => {
  it("keeps AGENTS.md as an operating contract for the draft-only boundary", () => {
    const agents = readFileSync(resolve(projectRoot, "AGENTS.md"), "utf8");

    for (const text of [
      "shared instruction source for coding agents",
      "Keep product scope draft-only unless the user explicitly changes that boundary.",
      "Keep roadmap and milestone material in plan documents or README sections, not in this operating contract.",
      "Use `npm ci` for clean installs from the committed lockfile, including CI and smoke-test preparation.",
      "Use `npm install` only when intentionally changing dependencies, and keep `package-lock.json` synchronized.",
      "Do not document future behavior as if it works today.",
      "Do not add tools or code paths that publish, schedule, delete, email, or create public Substack Notes in V1.",
      "Keep reusable Substack fixture captures body-only and non-raw; raw Substack response inspection belongs under ignored `.data/` files.",
      "Do not log Substack session cookies, bearer tokens, OAuth tokens, preview token secrets, `MCP_PATH_SECRET` values, or draft body contents by default.",
    ]) {
      expect(agents).toContain(text);
    }
  });

  it("keeps required README sections from the implementation plan explicit", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

    for (const text of [
      "This project uses Substack's unofficial/internal API.",
      "## Safety Boundary",
      "It does not publish, schedule, delete, email, or create public Substack Notes.",
      "## Supported Formatting",
      "## Known Limitations",
      "## Quickstart",
      "npm ci",
      "## MCP Inspector",
      "npm run smoke:inspector",
      "## Remote MCP Clients with ngrok",
      "## Cloud Run",
      "## Secret Rotation",
      "Rotate `SUBSTACK_SESSION_TOKEN`",
      "Rotate `PREVIEW_TOKEN_SECRET`",
      "Rotate `MCP_BEARER_TOKEN`",
      "Secret Manager versions",
      "scripts/rotateLocalSecrets.md",
      "## Troubleshooting",
    ]) {
      expect(readme).toContain(text);
    }
  });

  it("keeps SECURITY.md aligned with the implemented auth and logging model", () => {
    const security = readFileSync(resolve(projectRoot, "SECURITY.md"), "utf8");

    for (const text of [
      "uses Substack's unofficial/internal API",
      "The server manages unpublished drafts.",
      "must not publish, schedule, delete, email, or create public Substack Notes",
      "Never commit private `.env` files, Substack session cookies, preview token secrets, bearer tokens, draft bodies from private posts, or Cloud Run secret values.",
      "AUTH_MODE=noauth",
      "The server logs a startup warning in this mode.",
      "AUTH_MODE=static_bearer",
      "AUTH_MODE=oauth",
      "Confirmation tokens from `preview_draft` are write-safety controls, not authentication.",
      "Logs should include request IDs, method, path, and operational errors.",
      "They should not include request bodies, draft body contents, Substack session cookies, bearer tokens, OAuth tokens, preview token secrets, or the `MCP_PATH_SECRET` value.",
      "request and startup logs redact the endpoint as `/mcp/<redacted>`",
      "Audit records must not include titles, subtitles, draft bodies, confirmation tokens, idempotency key values, source image URLs, image payloads, uploaded image URLs, or credentials.",
      "`upload_image` treats file references, URL, base64/data-URI, SVG, and card sources as untrusted input.",
      "converted to sRGB PNG",
      "must resolve only to public addresses before a request is attempted",
      "Local `image_file` paths must be absolute and are disabled unless `IMAGE_FILE_ROOTS` contains an allowed directory.",
      "It never searches by filename, selects a neighboring file, or substitutes another artifact.",
      "Rotate `PREVIEW_TOKEN_SECRET` to invalidate outstanding confirmation tokens.",
      "Rotate `MCP_BEARER_TOKEN` after any remote-client exposure.",
    ]) {
      expect(security).toContain(text);
    }
  });

  it("keeps the local secret rotation runbook actionable", () => {
    const runbook = readFileSync(
      resolve(projectRoot, "scripts/rotateLocalSecrets.md"),
      "utf8",
    );

    for (const text of [
      "# Rotate Local Secrets",
      "## Preview Token Secret",
      "## MCP Bearer Token",
      "## Substack Session Token",
      "Update `PREVIEW_TOKEN_SECRET`",
      "Update `MCP_BEARER_TOKEN`",
      "Update `SUBSTACK_SESSION_TOKEN`",
      "Existing confirmation tokens immediately become invalid.",
      "add a new Secret Manager version",
    ]) {
      expect(runbook).toContain(text);
    }
    expect(runbook.match(/openssl rand -base64 32/g)).toHaveLength(2);
  });

  it("keeps the core package scripts from the implementation plan available", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(manifest.scripts).toMatchObject({
      "dev:http": "tsx src/http.ts",
      "dev:stdio": "tsx src/stdio.ts",
      build: "tsc -p tsconfig.build.json",
      "start:http": "node dist/http.js",
      "start:stdio": "node dist/stdio.js",
      test: "vitest run",
      "test:watch": "vitest",
      "inspect:draft": "tsx scripts/inspectDraft.ts",
      "mcp:preflight": "tsx scripts/v1AcceptancePreflight.ts --local",
      "smoke:inspector": "tsx scripts/smokeLocalHttp.ts --inspector-cli",
      "test:mcp-local":
        "npm run build && npm run smoke:http-local && npm run smoke:stdio",
      "validate:v1-local": expect.stringContaining(
        "npm run v1:status -- --json",
      ),
    });
  });

  it("documents a credential-free local MCP test path", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

    expect(readme).toContain("npm run test:mcp-local");
    expect(readme).toContain("without credentials or Substack network calls");
    expect(readme).toContain(
      "Configure the real Substack credential variables only when you are ready",
    );
  });

  it("keeps the guarded live account flow behind the MCP server boundary", () => {
    const liveTest = readFileSync(
      resolve(projectRoot, "tests/live/substackDraftFlow.test.ts"),
      "utf8",
    );

    for (const text of [
      "RUN_LIVE_SUBSTACK_TESTS",
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk/inMemory.js",
      "loadLocalEnvFiles()",
      "createMcpServer(config)",
      "client.listTools()",
      "client.callTool",
      'name: "list_drafts"',
      'name: "get_draft"',
      'name: "validate_newsletter_content"',
      'name: "preview_draft"',
      'name: "create_draft"',
      'name: "update_draft"',
      'name: "upload_image"',
      "await client.close()",
      "await server.close()",
      "const updatedBodyMarkdown = [",
      "bodyMarkdown,",
    ]) {
      expect(liveTest).toContain(text);
    }

    expect(liveTest).not.toContain('await import("dotenv")');
    expect(liveTest).not.toContain("loadDotenv");

    for (const directToolImport of [
      "src/tools/createDraft.js",
      "src/tools/getDraft.js",
      "src/tools/listDrafts.js",
      "src/tools/previewDraft.js",
      "src/tools/updateDraft.js",
      "src/tools/uploadImage.js",
    ]) {
      expect(liveTest).not.toContain(directToolImport);
    }
  });

  it("declares the Node runtime floor used by the plan and smoke tests", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const lockfile = JSON.parse(
      readFileSync(resolve(projectRoot, "package-lock.json"), "utf8"),
    ) as { packages?: { "": { engines?: { node?: string } } } };
    const workflow = readFileSync(
      resolve(projectRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(manifest.engines?.node).toBe(">=20");
    expect(lockfile.packages?.[""].engines?.node).toBe(">=20");
    expect(workflow).toContain('node-version: "22"');
  });

  it("keeps .env.example aligned with public runtime config without secrets", () => {
    const envExample = readFileSync(
      resolve(projectRoot, ".env.example"),
      "utf8",
    );

    for (const name of [
      "NODE_ENV",
      "PORT",
      "HOST",
      "LOG_LEVEL",
      "MCP_TRANSPORT",
      "MCP_PATH_SECRET",
      "SUBSTACK_PUBLICATION_URL",
      "SUBSTACK_SESSION_TOKEN",
      "SUBSTACK_USER_ID",
      "SUBSTACK_USER_AGENT",
      "PREVIEW_TOKEN_SECRET",
      "MAX_BODY_BYTES",
      "MAX_IMAGE_BYTES",
      "SUBSTACK_REQUEST_TIMEOUT_MS",
      "CONFIRMATION_TOKEN_TTL_SECONDS",
      "AUTH_MODE",
      "MCP_BEARER_TOKEN",
      "MCP_PUBLIC_BASE_URL",
      "OAUTH_AUTHORIZATION_SERVER_URL",
      "OAUTH_RESOURCE_DOCUMENTATION_URL",
      "OAUTH_JWKS_URL",
      "OAUTH_JWT_ALGORITHMS",
      "RUN_LIVE_SUBSTACK_TESTS",
      "SUBSTACK_FIXTURE_DIR",
      "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS",
      "BILLING_ACCOUNT_ID",
    ]) {
      expect(envExample).toMatch(new RegExp(`^${name}=`, "m"));
    }

    expect(envExample).toContain("SUBSTACK_SESSION_TOKEN=\n");
    expect(envExample).toContain("PREVIEW_TOKEN_SECRET=\n");
    expect(envExample).toContain("MCP_BEARER_TOKEN=\n");
    expect(envExample).toContain("BILLING_ACCOUNT_ID=\n");
    expect(envExample).not.toMatch(
      /connect\.sid=|substack\.sid=|sk-[A-Za-z0-9]/,
    );
  });

  it("documents how to collect Substack credentials without committing secrets", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

    for (const text of [
      "## Substack Credentials",
      "Application or Storage",
      "Cookies",
      "connect.sid",
      "substack.sid",
      "Network tab",
      "SUBSTACK_SESSION_TOKEN",
      "SUBSTACK_USER_ID",
      "openssl rand -base64 32",
      "Keep these out of git",
    ]) {
      expect(readme).toContain(text);
    }
  });

  it("keeps Cloud Run live verification commands explicit", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

    for (const text of [
      "SERVICE_URL=$(gcloud run services describe substack-draft-mcp",
      'curl --fail --show-error "$SERVICE_URL/healthz"',
      "MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first",
      "npm run smoke:remote --",
      '--url "$SERVICE_URL/mcp"',
      "Use the `SERVICE_URL` follow-ups to prove the deployed `/healthz` endpoint",
    ]) {
      expect(readme).toContain(text);
    }
  });

  it("keeps remote smoke examples free of inline token placeholders", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

    for (const text of [
      "MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the remote static bearer token first",
      "MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first",
      'MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote --',
      'MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth --',
    ]) {
      expect(readme).toContain(text);
    }
    expect(readme).not.toContain(
      "MCP_BEARER_TOKEN=<token> npm run smoke:remote",
    );
    expect(readme).not.toContain(
      "MCP_OAUTH_BEARER_TOKEN=<access-token> npm run smoke:remote-oauth",
    );
  });

  it("keeps live fixture docs aligned with the gate 7 compatibility test", () => {
    const fixtureReadme = readFileSync(
      resolve(projectRoot, "fixtures/substack/README.md"),
      "utf8",
    );

    for (const text of [
      "npm run fixtures:status -- --require-all",
      "npm test -- tests/content/substackFixtureCompatibility.test.ts",
      "SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts",
      "adapter-incompatible",
    ]) {
      expect(fixtureReadme).toContain(text);
    }
  });

  it("keeps the README gate 7 record example aligned with fixture compatibility proof", () => {
    const readme = readFileSync(resolve(projectRoot, "README.md"), "utf8");

    for (const text of [
      "npm run v1:record -- --gate 7 --fixture-dir fixtures/live",
      "npm run fixtures:status -- --fixture-dir fixtures/live --require-all",
      "SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts",
      "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
      "the gate 7 command also includes the fixture readiness and fixture compatibility test gates",
    ]) {
      expect(readme).toContain(text);
    }
  });

  it("keeps private env files and runtime artifacts ignored while allowing .env.example", () => {
    const gitignore = readFileSync(resolve(projectRoot, ".gitignore"), "utf8");

    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\.env\.\*$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);
    expect(gitignore).toMatch(/^\.data\/$/m);
    expect(gitignore).toMatch(/^dist\/$/m);
    expect(gitignore).toMatch(/^coverage\/$/m);
    expect(gitignore).toMatch(/^node_modules\/$/m);
  });

  it("keeps the Dockerfile reproducible and Cloud Run compatible", () => {
    const dockerfile = readFileSync(resolve(projectRoot, "Dockerfile"), "utf8");

    for (const text of [
      "FROM node:20-slim AS deps",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm ci",
      "FROM deps AS build",
      "COPY tsconfig.json tsconfig.build.json ./",
      "COPY src ./src",
      "RUN npm run build",
      "FROM node:20-slim AS runtime",
      "ENV NODE_ENV=production",
      "RUN npm ci --omit=dev && npm cache clean --force",
      "COPY --from=build /app/dist ./dist",
      "EXPOSE 8080",
      'CMD ["node", "dist/http.js"]',
    ]) {
      expect(dockerfile).toContain(text);
    }

    expect(dockerfile).not.toMatch(/COPY\s+\.env\b|COPY\s+\.data\b/);
  });

  it("keeps Docker build contexts free of secrets and local evidence", () => {
    const dockerignore = readFileSync(
      resolve(projectRoot, ".dockerignore"),
      "utf8",
    );

    expect(dockerignore).toMatch(/^\.env$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^!\.env\.example$/m);
    expect(dockerignore).toMatch(/^\.data\/$/m);
    expect(dockerignore).toMatch(/^dist\/$/m);
    expect(dockerignore).toMatch(/^coverage\/$/m);
    expect(dockerignore).toMatch(/^node_modules\/$/m);
    expect(dockerignore).toMatch(/^\.codex\/$/m);
    expect(dockerignore).toMatch(/^\.scaffold-guard\/$/m);
    expect(dockerignore).toMatch(/^\.DS_Store$/m);
  });
});
