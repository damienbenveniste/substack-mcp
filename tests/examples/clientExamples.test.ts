import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readV1EvidenceFile } from "../../scripts/v1AcceptanceStatusCore.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const SERVER_SIDE_ENV_NAMES = [
  "SUBSTACK_PUBLICATION_URL",
  "SUBSTACK_SESSION_TOKEN",
  "SUBSTACK_USER_ID",
  "PREVIEW_TOKEN_SECRET",
] as const;

describe("client setup examples", () => {
  it("keeps Cursor local stdio config parseable and secret-safe", () => {
    const example = readJsonExample("examples/cursor.local.stdio.json");
    const server = getSubstackDraftsServer(example);

    expect(server.type).toBe("stdio");
    expect(server.command).toBe("node");
    expect(server.args).toEqual([
      "/absolute/path/to/substack-mcp/dist/stdio.js",
    ]);
    expect(server.env).toMatchObject({
      SUBSTACK_PUBLICATION_URL: "https://yourpublication.substack.com",
      SUBSTACK_SESSION_TOKEN: cursorEnv("SUBSTACK_SESSION_TOKEN"),
      SUBSTACK_USER_ID: cursorEnv("SUBSTACK_USER_ID"),
      PREVIEW_TOKEN_SECRET: cursorEnv("PREVIEW_TOKEN_SECRET"),
      AUTH_MODE: "noauth",
    });
  });

  it("keeps Cursor remote HTTP config parseable and header-based", () => {
    const example = readJsonExample("examples/cursor.remote.http.json");
    const server = getSubstackDraftsServer(example);
    const serialized = JSON.stringify(server);

    expect(server.type).toBe("streamable-http");
    expect(server.url).toBe("https://your-cloud-run-url/mcp");
    expect(server.headers).toEqual({
      Authorization: `Bearer ${cursorEnv("MCP_BEARER_TOKEN")}`,
    });
    expectNoServerSideEnv(serialized);
  });

  it("keeps generic remote HTTP config free of Substack server credentials", () => {
    const example = readJsonExample("examples/mcp.remote.http.json");
    const server = getSubstackDraftsServer(example);
    const serialized = JSON.stringify(server);

    expect(server.type).toBe("streamable-http");
    expect(server.url).toBe("https://your-cloud-run-url/mcp");
    expect(server.headers).toEqual({
      Authorization: "Bearer <mcp-bearer-token>",
    });
    expectNoServerSideEnv(serialized);
  });

  it("documents Claude Code local, static bearer, and OAuth setup without literal secrets", () => {
    const markdown = readTextExample("examples/claude-code.md");
    const remoteExamples = markdown.slice(
      markdown.indexOf("Remote HTTP with static bearer auth"),
    );

    expect(markdown).toContain("claude mcp add --transport stdio");
    expect(markdown).toContain("claude mcp add --transport http");
    expect(markdown).toContain("claude mcp login substack-drafts");
    expect(markdown).toContain("$SUBSTACK_SESSION_TOKEN");
    expect(markdown).toContain("$MCP_BEARER_TOKEN");
    expect(remoteExamples).toContain("$MCP_BEARER_TOKEN");
    expectNoServerSideEnv(remoteExamples);
    expect(markdown).not.toMatch(/connect\.sid=|substack\.sid=|sk-[A-Za-z0-9]/);
  });

  it("keeps the V1 acceptance evidence example parseable and secret-safe", () => {
    const example = readV1EvidenceFile(
      resolve(projectRoot, "examples/v1-acceptance-evidence.example.json"),
    );
    const serialized = JSON.stringify(example);

    expect(example.version).toBe(1);
    expect(example.gates.map((gate) => gate.id)).toEqual([
      7, 8, 9, 11, 12, 13, 14, 15, 16,
    ]);
    for (const gate of example.gates) {
      expect(Date.parse(gate.verified_at)).not.toBeNaN();
      expect(gate.evidence.length).toBeGreaterThan(0);
      expect(gate.artifact).toMatch(/^\.data\/v1\/gate-\d{2}-.*\.md$/);
    }
    expect(example.gates.find((gate) => gate.id === 7)?.artifact).toBe(
      ".data/v1/gate-07-rich-draft-live-fixtures.md",
    );
    expect(example.gates.find((gate) => gate.id === 7)?.evidence).toContain(
      "fixture compatibility tests passed",
    );
    expect(example.gates.find((gate) => gate.id === 7)?.command).toContain(
      "npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
    expect(example.gates.find((gate) => gate.id === 8)?.artifact).toBe(
      ".data/v1/gate-08-update-draft-live.md",
    );
    expect(example.gates.find((gate) => gate.id === 8)?.evidence).toContain(
      "title transition",
    );
    expect(example.gates.find((gate) => gate.id === 9)?.artifact).toBe(
      ".data/v1/gate-09-read-drafts-live.md",
    );
    expect(example.gates.find((gate) => gate.id === 9)?.evidence).toContain(
      "body-inclusion decision",
    );
    expect(example.gates.find((gate) => gate.id === 11)?.artifact).toBe(
      ".data/v1/gate-11-chatgpt-ngrok.md",
    );
    expect(example.gates.find((gate) => gate.id === 11)?.evidence).toContain(
      "connector URL",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.artifact).toBe(
      ".data/v1/gate-12-cloud-run-deployment.md",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).toContain(
      "SERVICE_URL=$(gcloud run services describe substack-draft-mcp",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).toContain(
      "--auth-mode noauth",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).toContain(
      "--publication-url https://example.substack.com",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).toContain(
      "--confirmation-token-ttl-seconds 900",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).toContain(
      'curl --fail --show-error "$SERVICE_URL/healthz"',
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).toContain(
      'npm run smoke:remote-noauth -- --url "$SERVICE_URL/mcp"',
    );
    expect(example.gates.find((gate) => gate.id === 12)?.evidence).toContain(
      "project/region/service",
    );
    expect(example.gates.find((gate) => gate.id === 12)?.command).not.toMatch(
      /<service-url>|smoke:remote\.\.\./,
    );
    expect(example.gates.find((gate) => gate.id === 13)?.artifact).toBe(
      ".data/v1/gate-13-cloud-run-secrets.md",
    );
    expect(example.gates.find((gate) => gate.id === 13)?.command).toContain(
      "--publication-url https://example.substack.com",
    );
    expect(example.gates.find((gate) => gate.id === 13)?.evidence).toContain(
      "literal-env review",
    );
    expect(example.gates.find((gate) => gate.id === 14)?.artifact).toBe(
      ".data/v1/gate-14-static-bearer-remote.md",
    );
    expect(example.gates.find((gate) => gate.id === 14)?.evidence).toContain(
      "header-capable client version",
    );
    expect(example.gates.find((gate) => gate.id === 15)?.artifact).toBe(
      ".data/v1/gate-15-stdio-client.md",
    );
    expect(example.gates.find((gate) => gate.id === 15)?.evidence).toContain(
      "client version",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.command).toContain(
      "--evidence-artifact .data/v1/gate-16-cloud-run-logs.md",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "raw-log handling",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "required audit events",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "no cookie/bearer-token/secret-environment/private MCP path leaks",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "no draft content fields",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "metadata-only audit events",
    );
    expect(example.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "without raw log entries or secret values",
    );
    expect(serialized).not.toMatch(
      /connect\.sid=|substack\.sid=|SUBSTACK_SESSION_TOKEN|MCP_BEARER_TOKEN|sk-[A-Za-z0-9]/,
    );
  });
});

interface McpExample {
  readonly mcpServers: {
    readonly "substack-drafts": McpServerExample;
  };
}

interface McpServerExample {
  readonly type?: string | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly url?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

function readJsonExample(path: string): McpExample {
  return JSON.parse(readTextExample(path)) as McpExample;
}

function readTextExample(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

function getSubstackDraftsServer(example: McpExample): McpServerExample {
  return example.mcpServers["substack-drafts"];
}

function cursorEnv(name: string): string {
  return `\${env:${name}}`;
}

function expectNoServerSideEnv(value: string): void {
  for (const name of SERVER_SIDE_ENV_NAMES) {
    expect(value).not.toContain(name);
  }
}
