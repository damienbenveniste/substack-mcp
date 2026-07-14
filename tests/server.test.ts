import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createMcpServer } from "../src/server.js";

const config: AppConfig = {
  nodeEnv: "test",
  port: 8787,
  host: "127.0.0.1",
  logLevel: "silent",
  mcpTransport: "http",
  userAgent: "test-agent",
  previewTokenSecret: "test-preview-secret-with-enough-entropy",
  maxBodyBytes: 750_000,
  maxImageBytes: 8_000_000,
  substackRequestTimeoutMs: 30_000,
  confirmationTokenTtlSeconds: 900,
  authMode: "noauth",
  oauthJwtAlgorithms: ["RS256", "ES256"],
};

const expectedAnnotations = {
  list_drafts: { readOnlyHint: true },
  get_draft: { readOnlyHint: true },
  validate_newsletter_content: { readOnlyHint: true },
  preview_draft: { readOnlyHint: true },
  create_draft: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  update_draft: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  upload_image: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
} as const;

const draftWriteSafetyStatement =
  "This tool creates or modifies a Substack draft only. It never publishes, schedules, deletes, emails, or creates public Notes. The user must review and publish manually inside Substack.";
const forbiddenToolNamePattern =
  /(?:^|_)(?:publish|publishing|schedule|scheduled|delete|deleted|note|notes)(?:_|$)/iu;

describe("createMcpServer", () => {
  it("exposes only the V1 draft tools with client-visible annotations", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.listTools();
      const toolsByName = new Map(
        result.tools.map((tool) => [tool.name, tool]),
      );

      expect([...toolsByName.keys()].sort()).toEqual(
        Object.keys(expectedAnnotations).sort(),
      );

      for (const name of toolsByName.keys()) {
        expect(name, `Forbidden V1 tool name: ${name}`).not.toMatch(
          forbiddenToolNamePattern,
        );
      }

      for (const [name, annotations] of Object.entries(expectedAnnotations)) {
        const tool = toolsByName.get(name);
        expect(tool, `Expected ${name} to be registered`).toBeDefined();
        expect(tool?.annotations).toEqual(annotations);
        expect(tool?.description).toContain("never publishes");
        expect(tool?.description).toContain("schedules");
        expect(tool?.description).toContain("deletes");
        expect(tool?.description).toContain("emails");
        expect(tool?.description).toContain("Notes");
        expect(tool?._meta).toEqual({
          securitySchemes: [{ type: "noauth" }],
        });
      }

      expect(toolsByName.get("create_draft")?.description).toContain(
        draftWriteSafetyStatement,
      );
      expect(toolsByName.get("update_draft")?.description).toContain(
        draftWriteSafetyStatement,
      );
      expect(toolsByName.get("upload_image")?.description).toContain(
        "This tool uploads image assets for draft use only.",
      );
      expect(toolsByName.get("upload_image")?.description).toContain(
        "The user must review and publish manually inside Substack.",
      );

      expect(toolsByName.has("publish_post")).toBe(false);
      expect(toolsByName.has("schedule_post")).toBe(false);
      expect(toolsByName.has("delete_post")).toBe(false);
      expect(toolsByName.has("delete_draft")).toBe(false);
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("mirrors OAuth security schemes in tool metadata when OAuth mode is configured", async () => {
    const { client, server } = await createConnectedClient(oauthConfig());

    try {
      const result = await client.listTools();
      const toolsByName = new Map(
        result.tools.map((tool) => [tool.name, tool]),
      );

      expect(toolsByName.get("list_drafts")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["drafts:read"] }],
      });
      expect(toolsByName.get("get_draft")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["drafts:read"] }],
      });
      expect(toolsByName.get("validate_newsletter_content")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["drafts:read"] }],
      });
      expect(toolsByName.get("preview_draft")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["drafts:write"] }],
      });
      expect(toolsByName.get("create_draft")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["drafts:write"] }],
      });
      expect(toolsByName.get("update_draft")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["drafts:write"] }],
      });
      expect(toolsByName.get("upload_image")?._meta).toEqual({
        securitySchemes: [{ type: "oauth2", scopes: ["images:write"] }],
      });
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("blocks OAuth tool calls when the token lacks the required tool scope", async () => {
    const { client, server } = await createConnectedClient(oauthConfig(), {
      principal: {
        userId: "read-only-user",
        scopes: ["drafts:read"],
      },
    });

    try {
      const result = await client.callTool({
        name: "preview_draft",
        arguments: {
          action: "create",
          title: "Not allowed",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          errors: ["Authentication required: missing drafts:write scope."],
          required_scope: "drafts:write",
        },
        content: [
          {
            type: "text",
            text: "Authentication required: missing drafts:write scope.",
          },
        ],
        _meta: {
          "mcp/www_authenticate": [
            'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="drafts:read drafts:write images:write", error="insufficient_scope", error_description="Missing required scope: drafts:write"',
          ],
        },
      });
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("blocks OAuth create, update, and upload calls before validation when scopes are missing", async () => {
    const { client, server } = await createConnectedClient(oauthConfig(), {
      principal: {
        userId: "read-only-user",
        scopes: ["drafts:read"],
      },
    });

    try {
      const [createResult, updateResult, uploadResult] = await Promise.all([
        client.callTool({
          name: "create_draft",
          arguments: {
            title: "Not allowed",
            body_format: "markdown_v1",
            body_markdown: "Hello.",
            confirmation_token: "not-a-token",
          },
        }),
        client.callTool({
          name: "update_draft",
          arguments: {
            draft_id: 1,
            body_format: "markdown_v1",
            body_markdown: "Hello.",
            confirmation_token: "not-a-token",
          },
        }),
        client.callTool({
          name: "upload_image",
          arguments: {},
        }),
      ]);

      expect(createResult.content).toEqual([
        {
          type: "text",
          text: "Authentication required: missing drafts:write scope.",
        },
      ]);
      expect(updateResult.content).toEqual(createResult.content);
      expect(createResult.structuredContent).toEqual({
        ok: false,
        errors: ["Authentication required: missing drafts:write scope."],
        required_scope: "drafts:write",
      });
      expect(updateResult.structuredContent).toEqual(
        createResult.structuredContent,
      );
      expect(uploadResult.content).toEqual([
        {
          type: "text",
          text: "Authentication required: missing images:write scope.",
        },
      ]);
      expect(uploadResult.structuredContent).toEqual({
        ok: false,
        errors: ["Authentication required: missing images:write scope."],
        required_scope: "images:write",
      });
      expect(createResult.isError).toBe(true);
      expect(updateResult.isError).toBe(true);
      expect(uploadResult.isError).toBe(true);
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("blocks OAuth read and validation calls when drafts:read is missing", async () => {
    const { client, server } = await createConnectedClient(oauthConfig(), {
      principal: {
        userId: "image-only-user",
        scopes: ["images:write"],
      },
    });

    try {
      const [listResult, getResult, validateResult] = await Promise.all([
        client.callTool({
          name: "list_drafts",
          arguments: {},
        }),
        client.callTool({
          name: "get_draft",
          arguments: { draft_id: 1 },
        }),
        client.callTool({
          name: "validate_newsletter_content",
          arguments: {
            body_format: "markdown_v1",
            body_markdown: "Hello.",
          },
        }),
      ]);

      const expectedContent = [
        {
          type: "text",
          text: "Authentication required: missing drafts:read scope.",
        },
      ];
      expect(listResult.content).toEqual(expectedContent);
      expect(getResult.content).toEqual(expectedContent);
      expect(validateResult.content).toEqual(expectedContent);
      const expectedStructuredContent = {
        ok: false,
        errors: ["Authentication required: missing drafts:read scope."],
        required_scope: "drafts:read",
      };
      expect(listResult.structuredContent).toEqual(expectedStructuredContent);
      expect(getResult.structuredContent).toEqual(expectedStructuredContent);
      expect(validateResult.structuredContent).toEqual(
        expectedStructuredContent,
      );
      expect(listResult.isError).toBe(true);
      expect(getResult.isError).toBe(true);
      expect(validateResult.isError).toBe(true);
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("runs the MCP preview/create/update flow with injected Substack clients", async () => {
    const createPayloads: unknown[] = [];
    const updatePayloads: unknown[] = [];
    const { client, server } = await createConnectedClient(
      {
        ...config,
        userId: 123,
      },
      {
        toolClients: {
          createDraft: {
            createDraft: async (payload) => {
              createPayloads.push(payload);
              return {
                id: 101,
                title: payload.draft_title,
                url: "https://example.substack.com/p/mcp-created",
                raw: {},
              };
            },
          },
          updateDraft: {
            getDraft: async (draftId) => ({
              id: draftId,
              title: "Created through MCP",
              url: "https://example.substack.com/p/mcp-created",
              is_published: false,
              published_at: null,
              post_date: null,
              raw: {},
            }),
            updateDraft: async (draftId, payload) => {
              updatePayloads.push(payload);
              return {
                id: draftId,
                title: payload.draft_title,
                url: "https://example.substack.com/p/mcp-updated",
                raw: {},
              };
            },
          },
        },
      },
    );

    try {
      const createArgs = {
        action: "create",
        title: "Created through MCP",
        subtitle: "Preview token flow",
        body_format: "markdown_v1",
        body_markdown: "Hello **reader**.",
      };
      const createPreview = await client.callTool({
        name: "preview_draft",
        arguments: createArgs,
      });
      const createToken = readStructuredString(
        createPreview,
        "confirmation_token",
      );

      const created = await client.callTool({
        name: "create_draft",
        arguments: {
          title: createArgs.title,
          subtitle: createArgs.subtitle,
          body_format: createArgs.body_format,
          body_markdown: createArgs.body_markdown,
          confirmation_token: createToken,
        },
      });

      expect(created).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          draft_id: 101,
          draft_title: "Created through MCP",
          draft_url: "https://example.substack.com/p/mcp-created",
        },
      });
      expect(createPayloads).toHaveLength(1);
      expect(createPayloads[0]).toMatchObject({
        draft_title: "Created through MCP",
        draft_subtitle: "Preview token flow",
        draft_bylines: [{ id: 123, is_guest: false }],
        type: "newsletter",
      });

      const updateArgs = {
        action: "update",
        draft_id: 101,
        title: "Updated through MCP",
        body_format: "markdown_v1",
        body_markdown: "Updated **body**.",
      };
      const updatePreview = await client.callTool({
        name: "preview_draft",
        arguments: updateArgs,
      });
      const updateToken = readStructuredString(
        updatePreview,
        "confirmation_token",
      );

      const updated = await client.callTool({
        name: "update_draft",
        arguments: {
          draft_id: updateArgs.draft_id,
          title: updateArgs.title,
          body_format: updateArgs.body_format,
          body_markdown: updateArgs.body_markdown,
          confirmation_token: updateToken,
        },
      });

      expect(updated).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          draft_id: 101,
          draft_title: "Updated through MCP",
          draft_url: "https://example.substack.com/p/mcp-updated",
        },
      });
      expect(updatePayloads).toHaveLength(1);
      expect(updatePayloads[0]).toMatchObject({
        draft_title: "Updated through MCP",
      });
      expect(updatePayloads[0]).not.toHaveProperty("type");
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("runs the MCP list/get/upload flow with injected Substack clients", async () => {
    const listCalls: Array<readonly [number, number]> = [];
    const getCalls: number[] = [];
    const uploadedDataUris: string[] = [];
    const { client, server } = await createConnectedClient(config, {
      toolClients: {
        listDrafts: {
          listDrafts: async (offset, limit) => {
            listCalls.push([offset, limit]);
            return [
              {
                id: 201,
                title: "MCP listed draft",
                subtitle: "Listed subtitle",
                word_count: 120,
                updated_at: "2026-07-08T12:00:00Z",
                url: "https://example.substack.com/p/mcp-listed",
                draft_body: '{"type":"doc"}',
                raw: { id: 201, draft_body: "not exposed" },
              },
            ];
          },
        },
        getDraft: {
          getDraft: async (draftId) => {
            getCalls.push(draftId);
            return {
              id: draftId,
              title: "MCP fetched draft",
              subtitle: "Fetched subtitle",
              draft_body: '{"type":"doc","content":[]}',
              status: "draft",
              draft: true,
              is_draft: true,
              raw: { id: draftId, draft_body: "not exposed" },
            };
          },
        },
        uploadImage: {
          uploadImage: async (dataUri) => {
            uploadedDataUris.push(dataUri);
            return {
              url: "https://substackcdn.com/mcp-upload.png",
            };
          },
        },
      },
    });

    try {
      const listed = await client.callTool({
        name: "list_drafts",
        arguments: {
          offset: 2,
          limit: 3,
        },
      });

      expect(listed).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          offset: 2,
          limit: 3,
          drafts: [
            {
              id: 201,
              title: "MCP listed draft",
              subtitle: "Listed subtitle",
              word_count: 120,
              updated_at: "2026-07-08T12:00:00Z",
              url: "https://example.substack.com/p/mcp-listed",
            },
          ],
        },
      });
      const listedDraft = readStructuredArray(listed, "drafts")[0];
      expect(listedDraft).not.toHaveProperty("draft_body");
      expect(listedDraft).not.toHaveProperty("raw");
      expect(listCalls).toEqual([[2, 3]]);

      const fetched = await client.callTool({
        name: "get_draft",
        arguments: {
          draft_id: 201,
          include_body: true,
        },
      });

      expect(fetched).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          include_body: true,
          draft: {
            id: 201,
            title: "MCP fetched draft",
            subtitle: "Fetched subtitle",
            body: '{"type":"doc","content":[]}',
            status: "draft",
            draft: true,
            is_draft: true,
          },
        },
      });
      expect(readStructuredRecord(fetched, "draft")).not.toHaveProperty("raw");
      expect(getCalls).toEqual([201]);

      const uploaded = await client.callTool({
        name: "upload_image",
        arguments: {
          image_base64: "data:image/png;base64,aGk=",
          alt_text: "MCP alt text",
          caption: "MCP caption",
        },
      });

      expect(uploaded).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          image_url: "https://substackcdn.com/mcp-upload.png",
          alt_text: "MCP alt text",
          caption: "MCP caption",
          message:
            "Uploaded image to Substack: https://substackcdn.com/mcp-upload.png",
        },
      });
      expect(uploadedDataUris).toEqual(["data:image/png;base64,aGk="]);
    } finally {
      await closeConnectedClient(client, server);
    }
  });

  it("wraps every tool response in structured and text content", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const calls = [
        client.callTool({
          name: "list_drafts",
          arguments: {},
        }),
        client.callTool({
          name: "get_draft",
          arguments: { draft_id: 1 },
        }),
        client.callTool({
          name: "validate_newsletter_content",
          arguments: {
            body_format: "markdown_v1",
            body_markdown: "Hello **reader**.",
          },
        }),
        client.callTool({
          name: "preview_draft",
          arguments: {
            action: "create",
            title: "Preview only",
            body_format: "markdown_v1",
            body_markdown: "Hello **reader**.",
          },
        }),
        client.callTool({
          name: "create_draft",
          arguments: {
            title: "Create failure",
            body_format: "markdown_v1",
            body_markdown: "Hello.",
            confirmation_token: "not-a-token",
          },
        }),
        client.callTool({
          name: "update_draft",
          arguments: {
            draft_id: 1,
            body_format: "markdown_v1",
            body_markdown: "Hello.",
            confirmation_token: "not-a-token",
          },
        }),
        client.callTool({
          name: "upload_image",
          arguments: {},
        }),
      ];

      const results = await Promise.all(calls);

      expect(results).toHaveLength(Object.keys(expectedAnnotations).length);
      for (const result of results) {
        expect(result.structuredContent).toMatchObject({
          ok: expect.any(Boolean),
        });
        expect(result.content).toEqual([
          {
            type: "text",
            text: expect.any(String),
          },
        ]);
      }
    } finally {
      await closeConnectedClient(client, server);
    }
  });
});

async function createConnectedClient(
  serverConfig: AppConfig = config,
  options: Parameters<typeof createMcpServer>[1] = {},
): Promise<{
  readonly client: Client;
  readonly server: ReturnType<typeof createMcpServer>;
}> {
  const server = createMcpServer(serverConfig, options);
  const client = new Client({
    name: "substack-mcp-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server };
}

function oauthConfig(): AppConfig {
  return {
    ...config,
    authMode: "oauth",
    publicBaseUrl: "https://mcp.example.test",
    oauthAuthorizationServerUrl: "https://auth.example.test",
    oauthJwksUrl: "https://auth.example.test/jwks.json",
  };
}

async function closeConnectedClient(
  client: Client,
  server: ReturnType<typeof createMcpServer>,
): Promise<void> {
  await client.close();
  await server.close();
}

function readStructuredString(result: unknown, key: string): string {
  const structured = readRecord(readRecord(result).structuredContent);
  const value = structured[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected structuredContent.${key} to be a string.`);
  }

  return value;
}

function readStructuredRecord(
  result: unknown,
  key: string,
): Record<string, unknown> {
  const structured = readRecord(readRecord(result).structuredContent);
  return readRecord(structured[key]);
}

function readStructuredArray(result: unknown, key: string): readonly unknown[] {
  const structured = readRecord(readRecord(result).structuredContent);
  const value = structured[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected structuredContent.${key} to be an array.`);
  }

  return value;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected MCP result to be an object.");
  }

  return value as Record<string, unknown>;
}
