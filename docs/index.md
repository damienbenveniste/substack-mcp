# Substack Draft MCP Server

`substack-mcp` is an open-source, self-hosted Model Context Protocol server for
working with Substack newsletter drafts. It validates rich newsletter content,
previews guarded writes, manages unpublished drafts, and uploads exact image
artifacts without giving an MCP client the ability to publish.

!!! warning "Unofficial Substack API"
    This project uses Substack's unofficial editor and API endpoints. They can
    change without notice. Keep credentials private and review every draft in
    Substack before publishing it manually.

## Safety boundary

The server manages unpublished Substack drafts. It cannot publish, schedule,
delete, email, or create public Substack Notes. Create and update operations
require a short-lived confirmation token produced by a matching preview.

Substack credentials remain on the server. Do not send session cookies, bearer
tokens, preview secrets, or private draft content through issue reports, tool
arguments, chat messages, screenshots, or logs.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_drafts` | List metadata-only summaries of recent drafts. |
| `get_draft` | Read draft metadata and optionally its bounded body. |
| `validate_newsletter_content` | Validate Markdown or structured blocks without writing. |
| `preview_draft` | Preview a create, update, or targeted image replacement and issue a confirmation token. |
| `create_draft` | Create the exact unpublished draft bound to a valid preview token. |
| `update_draft` | Update an unpublished draft or one native image after confirmation. |
| `upload_image` | Normalize and upload an exact local, remote, base64, SVG, or card image source. |

## Quick start

Requirements:

- Node.js 20 or newer
- npm
- a Substack account with access to the target publication

```bash
git clone https://github.com/damienbenveniste/substack-mcp.git
cd substack-mcp
npm ci
npm run auth:setup
npm run dev:http
```

The local Streamable HTTP endpoint is `http://127.0.0.1:8787/mcp` by default.
Use MCP Inspector for the first local test:

```bash
npx @modelcontextprotocol/inspector
```

The [client setup guide](CLIENT_SETUP.md) covers MCP Inspector, stable ngrok
domains, ChatGPT, Claude, Claude Desktop, and Claude Code. It also explains the
stdio transport for local clients and the security differences between local
and remote access.

## Rich content

The server supports Markdown headings, links, lists, blockquotes, native fenced
code blocks, display LaTeX, images, alt text, and native captions. Structured
`blocks_v1` input is available when callers need an explicit JSON format.

Image upload and draft insertion are separate operations. Upload the exact
artifact first, preview the complete draft or targeted replacement, inspect the
returned image manifest, and then perform the confirmed draft write.

## Contributing

Contributions are welcome through forks and pull requests. Review the
[contribution guide](https://github.com/damienbenveniste/substack-mcp/blob/main/CONTRIBUTING.md),
[governance](https://github.com/damienbenveniste/substack-mcp/blob/main/GOVERNANCE.md),
and [security policy](https://github.com/damienbenveniste/substack-mcp/security/policy)
before starting. Every behavior change requires deterministic mocked or
synthetic-fixture tests; normal tests must never use live Substack credentials
or private data.

The source is available under the
[Apache License 2.0](https://github.com/damienbenveniste/substack-mcp/blob/main/LICENSE).
