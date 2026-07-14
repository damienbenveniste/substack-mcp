import { describe, expect, it } from "vitest";

const runLive = process.env.RUN_LIVE_SUBSTACK_TESTS === "1";
const describeLive = runLive ? describe : describe.skip;
const EXPECTED_TOOLS = [
  "create_draft",
  "get_draft",
  "list_drafts",
  "preview_draft",
  "update_draft",
  "upload_image",
  "validate_newsletter_content",
] as const;

describeLive("live Substack draft flow", () => {
  it("runs the rich draft flow through the registered MCP server without publishing it", async () => {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const { loadConfig, loadLocalEnvFiles } = await import(
      "../../src/config.js"
    );
    const { createMcpServer } = await import("../../src/server.js");

    loadLocalEnvFiles();

    const config = loadConfig(process.env, { loadEnvFile: false });
    assertLiveConfig(config);
    const server = createMcpServer(config);
    const client = new Client({
      name: "substack-mcp-live-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = (await client.listTools()).tools
        .map((tool) => tool.name)
        .sort();
      expect(tools).toEqual([...EXPECTED_TOOLS]);

      const timestamp = new Date().toISOString();
      const title = `[MCP TEST] Rich draft ${timestamp}`;
      const subtitle = "Created by the guarded live Substack MCP test.";

      const image = readSuccessfulToolResult(
        await client.callTool({
          name: "upload_image",
          arguments: {
            image_base64:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lJ2n4QAAAABJRU5ErkJggg==",
            alt_text: "One pixel test image",
            caption: "Live MCP test image",
            filename_hint: "mcp-test.png",
          },
        }),
        "upload_image",
      );
      const imageUrl = readString(image.image_url, "upload_image.image_url");
      expect(imageUrl).toMatch(/^https?:\/\//);

      const bodyMarkdown = [
        "# MCP Rich Draft Test",
        "",
        "This is a test paragraph with **bold**, *italic*, `inline code`, and [a link](https://example.com).",
        "",
        "> This is a blockquote.",
        "",
        "- First bullet",
        "- Second bullet",
        "",
        "1. First numbered item",
        "2. Second numbered item",
        "",
        "---",
        "",
        `![One pixel test image](${imageUrl} "Live MCP test image")`,
        "",
        "```python",
        "def fibonacci(n: int) -> int:",
        "    if n < 2:",
        "        return n",
        "    return fibonacci(n - 1) + fibonacci(n - 2)",
        "",
        "print(fibonacci(10))",
        "```",
        "",
        "$$",
        "E = mc^2",
        "$$",
      ].join("\n");

      const validation = readSuccessfulToolResult(
        await client.callTool({
          name: "validate_newsletter_content",
          arguments: {
            body_format: "markdown_v1",
            body_markdown: bodyMarkdown,
          },
        }),
        "validate_newsletter_content",
      );
      expect(validation.stats).toMatchObject({
        images: 1,
        code_blocks: 1,
        latex_blocks: 1,
      });

      const preview = readSuccessfulToolResult(
        await client.callTool({
          name: "preview_draft",
          arguments: {
            action: "create",
            title,
            subtitle,
            body_format: "markdown_v1",
            body_markdown: bodyMarkdown,
            include_payload_debug: true,
          },
        }),
        "preview_draft",
      );
      const createConfirmationToken = readString(
        preview.confirmation_token,
        "preview_draft.confirmation_token",
      );
      expect(preview.stats).toMatchObject({
        images: 1,
        code_blocks: 1,
        latex_blocks: 1,
      });

      const created = readSuccessfulToolResult(
        await client.callTool({
          name: "create_draft",
          arguments: {
            title,
            subtitle,
            body_format: "markdown_v1",
            body_markdown: bodyMarkdown,
            confirmation_token: createConfirmationToken,
          },
        }),
        "create_draft",
      );
      const draftId = readNumber(created.draft_id, "create_draft.draft_id");
      const createdDraftUrl = readOptionalString(created.draft_url);

      const listed = readSuccessfulToolResult(
        await client.callTool({
          name: "list_drafts",
          arguments: { limit: 10 },
        }),
        "list_drafts",
      );
      const listedDrafts = readRecordArray(listed.drafts, "list_drafts.drafts");
      const listVerified = listedDrafts.some((draft) => draft.id === draftId);
      expect(listVerified).toBe(true);

      const fetchedCreated = readSuccessfulToolResult(
        await client.callTool({
          name: "get_draft",
          arguments: {
            draft_id: draftId,
            include_body: true,
          },
        }),
        "get_draft",
      );
      const fetchedCreatedDraft = readRecord(
        fetchedCreated.draft,
        "get_draft.draft",
      );
      const getVerified = fetchedCreatedDraft.id === draftId;
      expect(getVerified).toBe(true);

      const updatedTitle = `${title} updated`;
      const updatedSubtitle = `${subtitle} Updated by the guarded live test.`;
      const updatedBodyMarkdown = [
        bodyMarkdown,
        "",
        "## Update Verification",
        "",
        "This paragraph was written by the guarded live update test.",
      ].join("\n");

      const updatePreview = readSuccessfulToolResult(
        await client.callTool({
          name: "preview_draft",
          arguments: {
            action: "update",
            draft_id: draftId,
            title: updatedTitle,
            subtitle: updatedSubtitle,
            body_format: "markdown_v1",
            body_markdown: updatedBodyMarkdown,
            include_payload_debug: true,
          },
        }),
        "preview_draft",
      );
      const updateConfirmationToken = readString(
        updatePreview.confirmation_token,
        "preview_draft.confirmation_token",
      );
      expect(updatePreview.stats).toMatchObject({
        code_blocks: 1,
        images: 1,
        latex_blocks: 1,
      });

      const updated = readSuccessfulToolResult(
        await client.callTool({
          name: "update_draft",
          arguments: {
            draft_id: draftId,
            title: updatedTitle,
            subtitle: updatedSubtitle,
            body_format: "markdown_v1",
            body_markdown: updatedBodyMarkdown,
            confirmation_token: updateConfirmationToken,
          },
        }),
        "update_draft",
      );
      expect(updated.draft_id).toBe(draftId);
      const updatedDraftUrl = readOptionalString(updated.draft_url);

      const fetchedUpdated = readSuccessfulToolResult(
        await client.callTool({
          name: "get_draft",
          arguments: {
            draft_id: draftId,
            include_body: true,
          },
        }),
        "get_draft",
      );
      const fetchedUpdatedDraft = readRecord(
        fetchedUpdated.draft,
        "get_draft.draft",
      );
      const postUpdateGetVerified = fetchedUpdatedDraft.id === draftId;
      expect(postUpdateGetVerified).toBe(true);
      if (fetchedUpdatedDraft.title !== undefined) {
        expect(fetchedUpdatedDraft.title).toBe(updatedTitle);
      }

      const evidence = {
        verified_at: new Date().toISOString(),
        draft_id: draftId,
        draft_url: updatedDraftUrl ?? createdDraftUrl,
        created_title: title,
        updated_title: updatedTitle,
        image_upload_verified: true,
        create_verified: true,
        list_verified: listVerified,
        get_verified: getVerified,
        update_verified: updated.draft_id === draftId,
        post_update_get_verified: postUpdateGetVerified,
      };
      const { parseLiveSubstackEvidenceArtifacts } = await import(
        "../../scripts/liveSubstackEvidence.js"
      );
      const evidenceArtifacts = parseLiveSubstackEvidenceArtifacts(process.env);
      if (evidenceArtifacts.length > 0) {
        const { writeLiveSubstackEvidenceArtifacts } = await import(
          "../../scripts/liveSubstackEvidence.js"
        );
        const written = writeLiveSubstackEvidenceArtifacts({
          cwd: process.cwd(),
          artifacts: evidenceArtifacts,
          fixtureDir: process.env.SUBSTACK_FIXTURE_DIR,
          evidence,
        });
        console.info(
          JSON.stringify(
            {
              message:
                "Sanitized live Substack evidence artifact written. Complete the manual checklist before recording V1 gate evidence.",
              artifacts: written.map((artifact) => artifact.artifact),
            },
            null,
            2,
          ),
        );
      }

      console.info(
        JSON.stringify(
          {
            message:
              "Live Substack draft created and updated through the MCP server. Review formatting and manually delete or keep the draft in Substack.",
            draft_id: draftId,
            draft_url: updatedDraftUrl ?? createdDraftUrl,
            tool_count: tools.length,
            list_verified: true,
            get_verified: true,
            created_title: title,
            updated_title: updatedTitle,
          },
          null,
          2,
        ),
      );
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);
});

function assertLiveConfig(config: {
  readonly publicationUrl?: string | undefined;
  readonly sessionToken?: string | undefined;
  readonly userId?: number | undefined;
}): void {
  const missing = [
    ["SUBSTACK_PUBLICATION_URL", config.publicationUrl],
    ["SUBSTACK_SESSION_TOKEN", config.sessionToken],
    ["SUBSTACK_USER_ID", config.userId],
  ]
    .filter(([, value]) => value === undefined || value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing live Substack test configuration: ${missing.join(", ")}.`,
    );
  }
}

function readSuccessfulToolResult(
  result: unknown,
  toolName: string,
): Record<string, unknown> {
  const response = readRecord(result, `${toolName} response`);
  const structured = readRecord(
    response.structuredContent,
    `${toolName}.structuredContent`,
  );
  if (response.isError === true || structured.ok !== true) {
    const errors = Array.isArray(structured.errors)
      ? structured.errors.filter((value) => typeof value === "string")
      : [];
    throw new Error(
      `${toolName} failed${errors.length > 0 ? `: ${errors.join(" ")}` : "."}`,
    );
  }

  return structured;
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${name} must be an object.`);
}

function readRecordArray(
  value: unknown,
  name: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }

  return value.map((entry, index) => readRecord(entry, `${name}[${index}]`));
}

function readString(value: unknown, name: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`${name} must be a non-empty string.`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`${name} must be a number.`);
}
