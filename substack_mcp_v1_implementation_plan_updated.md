# Substack Draft MCP Server — V1 Implementation Plan

## Current Implementation Target

The active target is a locally testable MCP server, not a hosted deployment. Work should stop after these paths are usable and verified:

- Built stdio transport for local MCP clients.
- Localhost Streamable HTTP transport for MCP Inspector and other local clients.
- Credential-free validation and preview smoke tests against the rich Markdown fixture.
- Optional credentialed testing of the draft-only Substack tools against the user's own account.

Use this local progression: run `npm run auth:setup` to enter the publication URL through a temporary loopback page, explicitly import the publication-scoped Substack session from the most recently used macOS Chrome profile or use an isolated sign-in fallback, derive `SUBSTACK_USER_ID` from the authenticated dashboard, validate access through the publication administration API, generate `PREVIEW_TOKEN_SECRET`, and save private local auth; run `npm run test:mcp-local` for credential-free HTTP and stdio transport checks; run `npm run mcp:preflight` for the focused local Substack credential report; run `npm run mcp:preflight -- --require-live` as the fail-fast gate; then explicitly opt into the account test with `RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live`. Manual cookie entry remains available only as a fallback and requires an explicit numeric user ID. The verified focused preflight excludes Cloud Run, ngrok, Cloud Billing, and release-ready fixture checks. It validates readiness without calling Substack; the guarded live test remains the account-level evidence. The live harness connects an MCP SDK `Client` to the registered server over SDK in-memory transport, lists the exact seven V1 tools, and executes upload/preview/create/list/get/update operations through `client.callTool`, covering MCP schemas, registration, and result wrappers as well as Substack behavior. Deterministic tests cover this MCP-boundary structure and the guarded skip; credentialed account behavior remains unverified until the live test is explicitly run.

The Cloud Run deployment slice and its Secret Manager and hosted-log acceptance gates are deferred. Gates 12, 13, and the Cloud Run-specific portion of gate 16 are not blockers for the current local-testing target. Do not perform additional Cloud Run implementation or deployment work unless that scope is explicitly reopened.

**Date:** 2026-07-08<br>
**Target audience:** coding agent / implementation agent<br>
**Goal:** build a private, single-user MCP server that lets ChatGPT or another MCP-compatible client create and update **Substack newsletter drafts** with rich content: text, images, code blocks, and LaTeX equation blocks.

---

## 1. Executive Summary

Build a TypeScript MCP server that exposes a small, safe tool surface for drafting Substack newsletters. The server must work in two modes:

1. **Local development mode:** run on the user's laptop at `http://localhost:8787/mcp`, then expose it to ChatGPT with `ngrok` at `https://<subdomain>.ngrok.app/mcp`.
2. **Hosted mode:** deploy the same HTTP MCP server to Google Cloud Run and register the Cloud Run HTTPS `/mcp` endpoint in ChatGPT or another MCP client.

The server should only create and update **drafts**. It must not publish, schedule, delete, or send Notes in V1.

The hardest part is not MCP itself. The hard part is preserving Substack formatting. Substack does **not** officially support raw Markdown in the post editor, so the server must treat Markdown as the agent-facing authoring format and convert it to Substack's native draft body format before sending it to Substack.

V1 should support:

- Draft creation.
- Draft update.
- Listing recent drafts.
- Reading an existing draft.
- Uploading images to Substack's image endpoint.
- Converting Markdown or explicit block JSON into Substack draft JSON.
- Text formatting: paragraphs, headings, bold, italic, links, inline code, blockquotes, bullets, numbered lists, and horizontal rules.
- Code blocks with language metadata where Substack accepts it.
- LaTeX equation blocks, discovered from the live Substack draft payload format.
- Safe confirmation-token flow before write tools execute.
- Local testing with MCP Inspector.
- ChatGPT developer-mode testing through ngrok.
- Cloud Run deployment with Secret Manager-backed credentials.
- Compatibility with ChatGPT over HTTPS Streamable HTTP and with Claude Code/Cursor over both local stdio and remote HTTP.
- A staged auth model: noauth for local ChatGPT testing, static bearer for private Claude/Cursor remote HTTP, and OAuth 2.1 for durable ChatGPT/public use.

---

## 2. Source-Backed Constraints the Implementation Must Respect

This plan is based on current public documentation and existing Substack MCP implementations checked on 2026-07-08.

### 2.1 ChatGPT / Apps SDK / MCP constraints

- ChatGPT Apps use MCP servers to expose tools to ChatGPT. A custom UI component is optional; V1 should not build one.
- For ChatGPT local development, expose the local server through a public HTTPS tunnel such as ngrok and register the HTTPS URL ending in `/mcp`.
- The official OpenAI Apps SDK quickstart shows an HTTP MCP server using `StreamableHTTPServerTransport`, `@modelcontextprotocol/sdk`, and a `/mcp` endpoint.
- MCP tool definitions should include explicit tool annotations such as `readOnlyHint`, `destructiveHint`, and `openWorldHint` so clients can render accurate consent prompts.
- Write actions that expose customer-specific data should authenticate users; for local V1 testing, unauthenticated developer-mode connectors can be used only with clear security constraints.

References:

- OpenAI Apps SDK quickstart: https://developers.openai.com/apps-sdk/quickstart
- OpenAI Apps SDK build MCP server guide: https://developers.openai.com/apps-sdk/build/mcp-server
- OpenAI Apps SDK connect from ChatGPT: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- OpenAI Apps SDK authentication: https://developers.openai.com/apps-sdk/build/auth
- OpenAI Apps SDK reference: https://developers.openai.com/apps-sdk/reference
- MCP Streamable HTTP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

### 2.2 Substack constraints

- Substack's official support page says the post editor does not currently support Markdown. Therefore, do **not** send raw Markdown and expect it to render.
- Substack supports code blocks in the editor, including language selection / automatic language detection, and the code block appears in email newsletters, web posts, and the Substack app.
- Substack supports LaTeX equation blocks through the post editor.
- Substack supports image uploads and lists supported image file types: `avif`, `gif`, `jpg`, `jpeg`, `png`, and `webp`.
- Substack says it does not currently support custom CSS or HTML in the post editor. Therefore, do not rely on arbitrary raw HTML insertion for V1.
- Substack has an official MCP server, but it is read-only and cannot publish posts, send Notes, or modify the account. This project needs write access to drafts, so it will use unofficial / internal Substack endpoints.

References:

- Substack Markdown support: https://support.substack.com/hc/en-us/articles/360037463132-Do-you-support-Markdown
- Substack code blocks: https://support.substack.com/hc/en-us/articles/46860260687380-How-do-I-embed-a-code-block-in-a-Substack-post
- Substack LaTeX equations: https://support.substack.com/hc/en-us/articles/12291042958996-How-do-I-add-equations-to-my-Substack-post
- Substack media and images: https://support.substack.com/hc/en-us/articles/360037832971-How-do-I-embed-media-in-my-post-e-g-images-video-GIFs
- Substack official read-only MCP server: https://support.substack.com/hc/en-us/articles/50834026608916-How-to-connect-Substack-to-your-AI-Assistant

### 2.3 Existing unofficial Substack MCP references

Use these as implementation references, not necessarily as direct dependencies.

- `marcomoauro/substack-mcp` exposes a `create_draft_post` tool and uses `SUBSTACK_PUBLICATION_URL`, `SUBSTACK_SESSION_TOKEN`, and `SUBSTACK_USER_ID`.
- `marcomoauro/substack-mcp` uses stdio transport, not HTTP. It posts to a Substack drafts endpoint using a cookie-based session token.
- `conorbronsdon/substack-mcp` is a more recent TypeScript implementation that includes `create_draft`, `update_draft`, `upload_image`, read tools, explicit annotations, a Markdown-to-ProseMirror converter, and safety boundaries around long-form drafts.
- If copying code from either repository, preserve license notices and attribution. Prefer writing original code using the same architectural ideas.

References:

- Marco Moauro repo: https://github.com/marcomoauro/substack-mcp
- Conor Bronsdon repo: https://github.com/conorbronsdon/substack-mcp

### 2.4 Cloud Run constraints

- Cloud Run can deploy directly from source with `gcloud run deploy --source`.
- Cloud Run supports Secret Manager-backed environment variables / secret references.
- Cloud Run request-based billing is the default; keeping `min-instances=0` avoids idle instance billing under request-based billing.
- ChatGPT must be able to reach the endpoint over public HTTPS. Cloud Run IAM-only private services are generally not directly usable from ChatGPT unless an authenticated proxy or OAuth-compatible flow is added.

References:

- Cloud Run source deploy: https://docs.cloud.google.com/run/docs/deploying-source-code
- Cloud Run secrets: https://docs.cloud.google.com/run/docs/configuring/services/secrets
- Cloud Run billing settings: https://docs.cloud.google.com/run/docs/configuring/billing-settings
- Cloud Run minimum instances: https://docs.cloud.google.com/run/docs/configuring/min-instances

---

## 3. Non-Negotiable Product Boundary

V1 is a **drafting tool**, not a publishing tool.

### Must implement

- Create private Substack long-form article drafts.
- Update existing unpublished drafts.
- Upload images for use in drafts.
- Read/list drafts for context.
- Preserve rich formatting as well as possible.
- Return the draft URL / ID so the user can review manually in Substack.

### Must not implement in V1

- No `publish_post` tool.
- No `schedule_post` tool.
- No `delete_post` or `delete_draft` tool.
- No Substack Notes publishing tool.
- No automatic email sending.
- No automatic paid/free audience switching unless explicitly passed as an argument.
- No arbitrary browser automation that clicks Publish.
- No storage of Substack credentials in the repository.
- No logging of session cookies, request cookies, OAuth tokens, or draft body contents by default.

### Safety statement to bake into tool descriptions

Every write tool description must include this meaning:

> This tool creates or modifies a Substack draft only. It never publishes, schedules, deletes, emails, or creates public Notes. The user must review and publish manually inside Substack.

---

## 4. Recommended V1 Architecture

```text
MCP-compatible client
  ├─ ChatGPT developer-mode connector over HTTPS /mcp
  ├─ MCP Inspector over local HTTP /mcp
  └─ Claude/Cursor/Codex-style local stdio client, optional
        │
        ▼
Substack Draft MCP Server
  ├─ Transport layer
  │   ├─ HTTP Streamable MCP endpoint at /mcp
  │   └─ optional stdio entrypoint for local non-ChatGPT clients
  │
  ├─ MCP tool layer
  │   ├─ validate_newsletter_content
  │   ├─ preview_draft
  │   ├─ create_draft
  │   ├─ update_draft
  │   ├─ list_drafts
  │   ├─ get_draft
  │   └─ upload_image
  │
  ├─ Safety layer
  │   ├─ Zod input validation
  │   ├─ confirmation-token generation / verification
  │   ├─ max size limits
  │   ├─ unsupported feature warnings
  │   └─ no publish/delete/schedule code paths
  │
  ├─ Content adapter
  │   ├─ markdown_v1 -> NewsletterBlock[]
  │   ├─ blocks_v1 -> NewsletterBlock[]
  │   └─ NewsletterBlock[] -> Substack draft_body JSON
  │
  ├─ Substack API client
  │   ├─ list drafts
  │   ├─ get draft
  │   ├─ create draft
  │   ├─ update draft
  │   └─ upload image
  │
  └─ Observability
      ├─ structured logs
      ├─ request IDs
      ├─ audit events without secret/body leakage
      └─ health endpoint
        │
        ▼
Substack internal / unofficial API
```

---

## 5. Technology Choices

### Runtime

Use **Node.js 20+** with **TypeScript**.

Reasons:

- Official MCP TypeScript SDK is well-supported.
- OpenAI Apps SDK examples use the Node MCP SDK and `StreamableHTTPServerTransport`.
- Existing Substack MCP examples are TypeScript/JavaScript, which makes endpoint and payload inspection easier.

### Package manager

Use `pnpm` if available; otherwise `npm` is acceptable.

### Core dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.20.2",
    "zod": "^3.25.76",
    "dotenv": "^16.4.7",
    "pino": "^9.5.0",
    "unified": "^11.0.5",
    "remark-parse": "^11.0.0",
    "remark-gfm": "^4.0.0",
    "remark-math": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "nock": "^13.5.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0"
  }
}
```

Notes:

- Use `node:http` directly for the HTTP MCP endpoint, following the OpenAI quickstart pattern. Express is optional but unnecessary for V1.
- Use `unified` + `remark-*` instead of a handwritten Markdown parser. It will handle common Markdown cases more reliably.
- Use Zod for every public tool argument schema.

---

## 6. Repository Layout

Create this repository layout:

```text
substack-draft-mcp/
  README.md
  IMPLEMENTATION_NOTES.md
  SECURITY.md
  package.json
  package-lock.json or pnpm-lock.yaml
  tsconfig.json
  .gitignore
  .env.example
  Dockerfile
  cloudbuild.yaml                  # optional; only if not using --source

  src/
    config.ts
    http.ts                        # HTTP /mcp entrypoint for ChatGPT/ngrok/Cloud Run
    stdio.ts                       # optional stdio entrypoint for Claude Desktop/Cursor
    server.ts                      # createMcpServer() + tool registration

    tools/
      validateNewsletterContent.ts
      previewDraft.ts
      createDraft.ts
      updateDraft.ts
      listDrafts.ts
      getDraft.ts
      uploadImage.ts
      schemas.ts
      annotations.ts

    substack/
      client.ts
      endpoints.ts
      errors.ts
      types.ts
      auth.ts

    content/
      newsletterBlocks.ts          # canonical block model
      parseMarkdown.ts             # markdown_v1 -> NewsletterBlock[]
      parseBlocks.ts               # blocks_v1 validation -> NewsletterBlock[]
      toSubstackProseMirror.ts     # NewsletterBlock[] -> Substack JSON doc
      toPreviewText.ts             # summary / warnings for preview
      latexDiscovery.md            # document discovered LaTeX node shape

    safety/
      confirmationToken.ts
      redaction.ts
      limits.ts
      urlPolicy.ts

    logging/
      logger.ts
      audit.ts

  scripts/
    inspectDraft.ts                # fetch draft JSON for reverse engineering
    createFixtureDraft.ts          # optional: create test draft from fixture
    rotateLocalSecrets.md

  fixtures/
    markdown/
      basic.md
      full-rich-draft.md
    substack/
      basic-draft-body.json
      image-draft-body.json
      code-block-draft-body.json
      latex-block-draft-body.json

  test/
    content/
      parseMarkdown.test.ts
      toSubstackProseMirror.test.ts
    safety/
      confirmationToken.test.ts
    tools/
      previewDraft.test.ts
      createDraft.test.ts
      updateDraft.test.ts
      uploadImage.test.ts
    substack/
      client.test.ts
```

---

## 7. Environment Variables

Create `.env.example`:

```bash
# Server
NODE_ENV=development
PORT=8787
LOG_LEVEL=info

# Transport
# http for ChatGPT/ngrok/Cloud Run; stdio for local MCP clients.
MCP_TRANSPORT=http

# Substack account/publication
SUBSTACK_PUBLICATION_URL=https://yourpublication.substack.com
SUBSTACK_SESSION_TOKEN=replace-me
SUBSTACK_USER_ID=123456

# Optional browser-like UA. Helps avoid custom-domain / Cloudflare issues.
SUBSTACK_USER_AGENT=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36

# Safety
PREVIEW_TOKEN_SECRET=replace-with-32-plus-random-bytes
MAX_BODY_BYTES=750000
MAX_IMAGE_BYTES=8000000
CONFIRMATION_TOKEN_TTL_SECONDS=900

# Auth mode for V1.
# noauth: acceptable only for local ngrok testing or a short-lived personal ChatGPT connector.
# static_bearer: recommended for private remote HTTP use with Claude Code/Cursor/other clients that can send headers.
# oauth: required before public/multi-user ChatGPT use and recommended for durable ChatGPT Cloud Run use.
AUTH_MODE=noauth

# Static bearer auth for remote HTTP clients that support custom headers.
# Do not rely on this for ChatGPT connectors; ChatGPT Apps expect noauth or OAuth, not a user-supplied custom API key header.
MCP_BEARER_TOKEN=

# Optional. If set, expose the MCP endpoint at /mcp/<MCP_PATH_SECRET> instead of /mcp.
# Use only after verifying the target MCP client accepts a custom path. ChatGPT connector URLs usually work best as a normal HTTPS URL ending in /mcp.
MCP_PATH_SECRET=
```

`.gitignore` must include:

```gitignore
.env
.env.*
!.env.example
.data/
dist/
node_modules/
.DS_Store
```

---

## 8. Auth and Security Approach

### 8.1 Important distinction: confirmation tokens are not authentication

The `preview_draft` -> `confirmation_token` -> `create_draft` / `update_draft` flow is required, but it is **not** user authentication. It proves that the write payload matches a recent preview and reduces accidental writes. It does **not** prove who is calling the server.

V1 must support three separate security layers:

1. **Substack authentication:** browser-based local setup accepts `SUBSTACK_PUBLICATION_URL`, imports the publication-scoped `SUBSTACK_SESSION_TOKEN`, derives `SUBSTACK_USER_ID` from the authenticated dashboard, validates administrative access through the publication API, and generates `PREVIEW_TOKEN_SECRET`. Manual fallback accepts the same values explicitly. These process-wide values stay server-side only and are separate from MCP caller OAuth.
2. **MCP caller authentication:** the server authenticates the MCP client/user via `AUTH_MODE`.
3. **Write confirmation:** write tools require an HMAC confirmation token from `preview_draft`.

### 8.2 Required auth modes

Implement `AUTH_MODE` as an actual switch in `src/auth/requireAuth.ts`:

| Mode | Intended use | Supported clients | Behavior |
|---|---|---|---|
| `noauth` | Local dev, MCP Inspector, short-lived ngrok testing, temporary personal ChatGPT connector | ChatGPT, MCP Inspector, any client | No caller identity check. Still requires confirmation tokens for writes. Must log a startup warning. |
| `static_bearer` | Private remote HTTP with clients that can send headers | Claude Code, Cursor, many local MCP clients | Require `Authorization: Bearer ${MCP_BEARER_TOKEN}` on `/mcp`. Reject missing/wrong token with `401`. Do not use this as the ChatGPT auth plan. |
| `oauth` | Durable ChatGPT deployment, public/multi-user deployment, enterprise/team use | ChatGPT, Claude Code, Cursor, other spec-compliant remote clients | Implement MCP OAuth 2.1 resource-server behavior: protected resource metadata, per-tool `securitySchemes`, `WWW-Authenticate` challenges, and access-token verification. |

V1 should implement `noauth` and `static_bearer` fully. V1 should include an `oauthStub.ts` and clear interfaces so OAuth can be added without rewriting tools. If the project goal is a long-lived Cloud Run endpoint used from ChatGPT, OAuth becomes part of launch criteria rather than a later enhancement.

### 8.3 ChatGPT-specific auth rule

For ChatGPT Apps/connectors, do **not** assume ChatGPT can send a custom `X-API-Key` or manually configured bearer token. ChatGPT should be treated as supporting:

- `noauth` for developer testing or intentionally anonymous tools.
- `oauth2` for authenticated tools.

For authenticated ChatGPT tools, implement the MCP authorization flow expected by ChatGPT:

- `GET /.well-known/oauth-protected-resource` on the MCP server.
- An authorization server discovery document such as `/.well-known/oauth-authorization-server` or OIDC discovery on the auth issuer.
- Authorization-code flow with PKCE.
- Tool-level `securitySchemes: [{ type: "oauth2", scopes: [...] }]`.
- `401` responses with a valid `WWW-Authenticate` challenge and tool errors with `_meta["mcp/www_authenticate"]` when triggering linking from a tool call.
- Server-side verification of every bearer token: issuer, audience/resource, expiration, and scopes.

For a single-user private server, OAuth can map every successfully authenticated user to one local principal, but the server must still validate tokens before running draft tools.

### 8.4 Local development security with ngrok

For local development with ngrok:

- Bind the MCP server to localhost.
- Run ngrok only while actively testing.
- Use a random ngrok URL, not a fixed public domain, unless OAuth is implemented.
- Keep V1 tools draft-only.
- Require confirmation tokens for `create_draft` and `update_draft`.
- Do not expose publish/delete/schedule/Notes tools.
- Rotate the Substack session token after testing if the ngrok URL was shared or logs show unexpected access.
- Prefer `AUTH_MODE=noauth` only for ChatGPT local testing. Prefer `AUTH_MODE=static_bearer` for Claude Code/Cursor remote HTTP testing because those clients can send headers.

### 8.5 Cloud Run V1 security

Cloud Run must be reachable over public HTTPS for ChatGPT, Claude Code, Cursor, and other remote MCP clients. Do **not** rely on Cloud Run IAM for ChatGPT/Cursor/Claude Code unless you add a separate proxy/auth flow that those clients can use.

For a private single-user Cloud Run deployment:

- Use `--allow-unauthenticated` at the Cloud Run layer so the public MCP endpoint can be reached, then enforce auth inside the app.
- For Claude Code/Cursor: set `AUTH_MODE=static_bearer` and require `Authorization: Bearer ...`.
- For ChatGPT durable use: set `AUTH_MODE=oauth`, not `static_bearer`.
- If using ChatGPT with `AUTH_MODE=noauth`, treat it as a temporary personal experiment only, keep the URL unadvertised, and rotate the Substack token regularly.
- Set `max-instances=1` initially.
- Do not enable any public publish/delete/schedule tools.
- Use Secret Manager for `SUBSTACK_SESSION_TOKEN`, `PREVIEW_TOKEN_SECRET`, and `MCP_BEARER_TOKEN`.
- Turn on GCP budget alerts.
- Monitor Cloud Run logs for unexpected traffic.
- Prefer a short-lived deployment or rotate secrets frequently until OAuth is implemented.

### 8.6 Production / multi-user security requirement

Before this is used beyond a personal private connector, implement OAuth 2.1 compatible with MCP / ChatGPT Apps SDK. Do not publish this as a public ChatGPT app while it depends only on noauth or static bearer auth.

Create:

```text
src/auth/
  requireAuth.ts
  noAuth.ts
  staticBearerAuth.ts
  oauthStub.ts
  scopes.ts
  principal.ts
```

For V1, `requireAuth` can return a single local principal:

```ts
{
  userId: "local-single-user",
  scopes: ["drafts:read", "drafts:write", "images:write"]
}
```

Never expose Substack session tokens to the MCP client. They stay server-side only.

---

## 9. MCP Tool Design

All tool handlers must return both:

- `structuredContent`: machine-readable JSON.
- `content`: short human-readable text summary.

All write tools must produce clear user-facing summaries.

### 9.1 Tool: `validate_newsletter_content`

Purpose: validate Markdown or block input without writing to Substack.

Annotation:

```ts
{ readOnlyHint: true }
```

Input:

```ts
{
  body_format: "markdown_v1" | "blocks_v1",
  body_markdown?: string,
  blocks?: NewsletterBlock[],
  strict?: boolean
}
```

Output:

```ts
{
  ok: boolean,
  errors: string[],
  warnings: string[],
  stats: {
    characters: number,
    words: number,
    blocks: number,
    images: number,
    code_blocks: number,
    latex_blocks: number,
    links: number
  },
  unsupported_features: string[]
}
```

Behavior:

- Validate size limits.
- Parse Markdown or block JSON.
- Identify unsupported raw HTML, tables, footnotes, task lists, inline math if unsupported, or nested list structures if not implemented.
- Do not call Substack.
- Do not fetch remote images by default.

### 9.2 Tool: `preview_draft`

Purpose: convert a draft input into the internal Substack payload and return a safe preview plus a confirmation token.

Annotation:

```ts
{ readOnlyHint: true }
```

Input:

```ts
{
  action: "create" | "update",
  draft_id?: number,
  title?: string,
  subtitle?: string,
  audience?: "everyone" | "only_paid" | "founding" | "only_free",
  body_format: "markdown_v1" | "blocks_v1",
  body_markdown?: string,
  blocks?: NewsletterBlock[],
  include_payload_debug?: boolean
}
```

Output:

```ts
{
  ok: boolean,
  action: "create" | "update",
  draft_id?: number,
  title?: string,
  subtitle?: string,
  audience: string,
  preview_text: string,
  warnings: string[],
  stats: {
    blocks: number,
    words: number,
    images: number,
    code_blocks: number,
    latex_blocks: number
  },
  confirmation_token: string,
  confirmation_expires_at: string,
  payload_debug?: unknown
}
```

Behavior:

- Generate a token using `PREVIEW_TOKEN_SECRET`.
- Token must bind to:
  - action
  - draft_id if action is `update`
  - normalized title
  - normalized subtitle
  - audience
  - content hash
  - expiry timestamp
- Do not write to Substack.
- If `include_payload_debug` is true, return redacted/minimized payload. Never include secrets.

### 9.3 Tool: `create_draft`

Purpose: create a Substack long-form article draft.

Annotation:

```ts
{
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
}
```

If this tool performs image upload internally in the future, change `openWorldHint` to `true`. For V1, require images to be pre-uploaded with `upload_image` or referenced by already hosted image URLs.

Input:

```ts
{
  title: string,
  subtitle?: string,
  audience?: "everyone" | "only_paid" | "founding" | "only_free",
  body_format: "markdown_v1" | "blocks_v1",
  body_markdown?: string,
  blocks?: NewsletterBlock[],
  confirmation_token: string,
  idempotency_key?: string
}
```

Output:

```ts
{
  ok: boolean,
  draft_id: number,
  draft_title: string,
  draft_url?: string,
  message: string,
  warnings: string[]
}
```

Behavior:

- Validate confirmation token.
- Reject if confirmation token is expired or doesn't match normalized content.
- Convert content to Substack draft body JSON.
- Call Substack create draft endpoint.
- Return draft ID and URL if derivable.
- Write audit event without full body.

### 9.4 Tool: `update_draft`

Purpose: update an existing unpublished Substack draft.

Annotation:

```ts
{
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
}
```

Input:

```ts
{
  draft_id: number,
  title?: string,
  subtitle?: string,
  audience?: "everyone" | "only_paid" | "founding" | "only_free",
  body_format?: "markdown_v1" | "blocks_v1",
  body_markdown?: string,
  blocks?: NewsletterBlock[],
  confirmation_token: string
}
```

Output:

```ts
{
  ok: boolean,
  draft_id: number,
  draft_title?: string,
  draft_url?: string,
  message: string,
  warnings: string[]
}
```

Behavior:

- Validate confirmation token.
- Fetch existing draft first.
- Reject if the fetched object indicates it is not a draft or has already been published.
- Only update fields provided.
- Preserve existing fields not provided.

### 9.5 Tool: `list_drafts`

Purpose: list recent drafts so the agent can choose the correct draft for update.

Annotation:

```ts
{ readOnlyHint: true }
```

Input:

```ts
{
  offset?: number,
  limit?: number
}
```

Output:

```ts
{
  ok: boolean,
  drafts: Array<{
    id: number,
    title?: string,
    subtitle?: string,
    audience?: string,
    word_count?: number,
    created_at?: string,
    updated_at?: string,
    url?: string
  }>
}
```

### 9.6 Tool: `get_draft`

Purpose: fetch a draft body and metadata.

Annotation:

```ts
{ readOnlyHint: true }
```

Input:

```ts
{
  draft_id: number,
  include_body?: boolean
}
```

Output:

```ts
{
  ok: boolean,
  draft: {
    id: number,
    title?: string,
    subtitle?: string,
    audience?: string,
    word_count?: number,
    created_at?: string,
    updated_at?: string,
    body?: unknown
  }
}
```

### 9.7 Tool: `upload_image`

Purpose: upload an image to Substack's image endpoint and return a URL that can be inserted into a draft.

Annotation:

```ts
{
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true
}
```

Reason for `openWorldHint: true`: the uploaded image URL may be publicly fetchable by anyone with the URL, even if it is unlisted.

Input:

```ts
{
  image_url?: string,
  image_base64?: string,
  alt_text?: string,
  caption?: string,
  filename_hint?: string
}
```

Rules:

- Exactly one of `image_url` or `image_base64` must be provided.
- `image_url` must be `https://` or `http://`.
- Fetch max size must respect `MAX_IMAGE_BYTES`.
- Allowed MIME types: `image/avif`, `image/gif`, `image/jpeg`, `image/png`, `image/webp`.
- Convert fetched image to `data:<mime>;base64,<payload>` before calling Substack if Substack's endpoint requires that shape.
- Do not support arbitrary local file paths in HTTP mode. If supporting `file_path` for stdio mode later, restrict it to an allowlisted local directory.

Output:

```ts
{
  ok: boolean,
  image_url: string,
  alt_text?: string,
  caption?: string,
  message: string
}
```

---

## 10. Canonical Content Model

Use a neutral content model so the MCP tools are not tightly coupled to Markdown or Substack's private JSON shape.

Create `src/content/newsletterBlocks.ts`.

### 10.1 Block schema

```ts
export type NewsletterBlock =
  | ParagraphBlock
  | HeadingBlock
  | BlockquoteBlock
  | BulletedListBlock
  | OrderedListBlock
  | HorizontalRuleBlock
  | ImageBlock
  | CodeBlock
  | LatexBlock
  | EmbedUrlBlock;

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  children: InlineSpan[];
}

export interface HeadingBlock {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineSpan[];
}

export interface BlockquoteBlock {
  type: "blockquote";
  children: NewsletterBlock[];
}

export interface BulletedListBlock {
  type: "bulleted_list";
  items: Array<{ children: NewsletterBlock[] }>;
}

export interface OrderedListBlock {
  type: "ordered_list";
  start?: number;
  items: Array<{ children: NewsletterBlock[] }>;
}

export interface HorizontalRuleBlock {
  type: "horizontal_rule";
}

export interface ImageBlock {
  type: "image";
  src: string;
  alt?: string;
  caption?: string;
  title?: string;
  width?: number;
  height?: number;
}

export interface CodeBlock {
  type: "code_block";
  language?: string;
  code: string;
}

export interface LatexBlock {
  type: "latex_block";
  latex: string;
}

export interface EmbedUrlBlock {
  type: "embed_url";
  url: string;
}
```

### 10.2 Markdown input conventions

Support these Markdown conventions:

```md
# Heading 1
## Heading 2

Paragraph with **bold**, *italic*, `inline code`, and [a link](https://example.com).

> Blockquote text.

- Bullet item
- Bullet item

1. Ordered item
2. Ordered item

---

![Alt text](https://example.com/image.png "Optional caption")

```python
from math import sqrt
print(sqrt(2))
```

$$
E = mc^2
$$
```

Also support an explicit directive form for images and LaTeX because agents often produce more reliable structured directives than ambiguous Markdown:

```md
:::image
src: https://substackcdn.com/image/fetch/...
alt: Architecture diagram showing the MCP flow
caption: Local and Cloud Run deployment paths
:::

:::latex
\int_0^1 x^2\,dx = \frac{1}{3}
:::
```

If the Markdown parser cannot support directives in V1, support them in `blocks_v1` instead and document that Markdown image/LaTeX directives are best-effort.

### 10.3 Explicit `blocks_v1` input

Agents should be encouraged to use `blocks_v1` when they need high fidelity.

Example:

```json
{
  "body_format": "blocks_v1",
  "blocks": [
    {
      "type": "heading",
      "level": 1,
      "children": [{ "text": "The Week in AI Agents" }]
    },
    {
      "type": "paragraph",
      "children": [
        { "text": "This week, " },
        { "text": "tool-calling agents", "bold": true },
        { "text": "became much easier to deploy." }
      ]
    },
    {
      "type": "code_block",
      "language": "typescript",
      "code": "console.log('hello from Substack');"
    },
    {
      "type": "latex_block",
      "latex": "E = mc^2"
    },
    {
      "type": "image",
      "src": "https://substackcdn.com/image/fetch/...",
      "alt": "System architecture diagram",
      "caption": "V1 architecture"
    }
  ]
}
```

---

## 11. Substack Draft Body Adapter

### 11.1 Current known shape

Existing unofficial implementations indicate that Substack long-form draft bodies are sent as a JSON-stringified ProseMirror-like document in a field named `draft_body`.

Known examples:

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [{ "type": "text", "text": "Hello" }]
    }
  ]
}
```

`createDraft` payload shape should look roughly like:

```json
{
  "draft_title": "My Title",
  "draft_subtitle": "Optional subtitle",
  "draft_body": "{\"type\":\"doc\",\"content\":[...]}",
  "draft_bylines": [{ "id": 123456, "is_guest": false }],
  "audience": "everyone",
  "type": "newsletter"
}
```

Do not hard-code every field from a guessed schema. Implement minimal fields, then preserve/update any existing draft fields when updating.

### 11.2 Text nodes and marks

Map inline spans to Substack-compatible text marks.

Important: existing implementations differ on mark names: one uses `strong` / `em`, another uses `bold` / `italic`. The coding agent must verify the correct current mark names by fetching a live draft fixture. Implement a compatibility layer and tests.

Recommended discovery process:

1. Manually create a draft in Substack containing bold, italic, link, inline code.
2. Run `scripts/inspectDraft.ts <draft_id>`.
3. Save fetched `draft_body` as `fixtures/substack/inline-marks-draft-body.json`.
4. Update `toSubstackProseMirror.ts` to match the observed node and mark names.
5. Tests must assert exact fixture compatibility.

### 11.3 Code block mapping

Existing code suggests this shape may work:

```json
{
  "type": "code_block",
  "attrs": { "lang": "python" },
  "content": [{ "type": "text", "text": "print('hello')" }]
}
```

But do not assume. Verify with a live fixture:

1. In Substack editor, create a code block.
2. Select a language such as Python.
3. Paste sample code.
4. Save draft.
5. Fetch `/api/v1/drafts/<id>`.
6. Inspect `draft_body`.
7. Save fixture.
8. Implement exact mapping.

Acceptance criterion: a draft created by the MCP server shows as a native Substack code block in web preview, email preview, and editor view.

### 11.4 Image mapping

Existing code suggests this shape may work:

```json
{
  "type": "captionedImage",
  "content": [
    {
      "type": "image2",
      "attrs": {
        "src": "https://...",
        "alt": "Alt text",
        "title": "Optional title",
        "height": 819,
        "width": 1456,
        "resizeWidth": 728,
        "imageSize": "normal",
        "fullscreen": false,
        "belowTheFold": false
      }
    }
  ]
}
```

Again, verify with a live fixture.

Implementation requirements:

- `upload_image` returns a URL.
- The image block should use the returned URL.
- Store alt text when the Substack payload supports it.
- Store caption when the Substack payload supports it.
- If caption storage shape is uncertain, use a following paragraph as a fallback caption and return a warning.

### 11.5 LaTeX block mapping

LaTeX is mandatory for V1, but the node shape must be discovered from Substack because it is not present in the simple existing MCP examples.

Create `scripts/inspectDraft.ts` and follow this required discovery procedure:

1. Open Substack manually.
2. Create a new Article draft.
3. Add a LaTeX block through the editor toolbar.
4. Enter:

   ```latex
   E = mc^2
   ```

5. Save the draft.
6. Run:

   ```bash
   npm run inspect:draft -- <draft_id> > fixtures/substack/latex-block-draft-body.json
   ```

7. Inspect the `draft_body` JSON.
8. Implement `LatexBlock -> Substack PM node` exactly.
9. Add a test that creates a ProseMirror doc from `{ type: "latex_block", latex: "E = mc^2" }` and compares it to the relevant fixture shape.

Do not mark V1 complete until LaTeX fixtures round-trip successfully.

Fallback only for development:

- If LaTeX node shape is unknown, `validate_newsletter_content` should return an error in strict mode.
- Non-strict mode may convert LaTeX to a code block labeled `latex` with a warning, but this does **not** satisfy V1 completion.

### 11.6 Embeds and raw HTML

Substack supports rich media embeds by pasting URLs into the editor. It does not support arbitrary custom CSS/HTML in the post editor.

For V1:

- Support `embed_url` only as a plain paragraph with the URL unless a verified native embed node shape is discovered.
- Reject raw HTML by default.
- Return warnings for tables, iframes, scripts, styles, and arbitrary HTML blocks.

---

## 12. Substack API Client

Create `src/substack/client.ts`.

### 12.1 Configuration

```ts
export interface SubstackClientConfig {
  publicationUrl: string;
  sessionToken: string;
  userId: number;
  userAgent: string;
}
```

Normalize `publicationUrl`:

- Remove trailing slash.
- Prefer canonical `https://<publication>.substack.com` rather than a custom domain if available, because custom domains may introduce Cloudflare redirects or 401/403 issues.

### 12.2 Request headers

Use cookie-based auth:

```ts
const cookie = `connect.sid=${sessionToken}; substack.sid=${sessionToken};`;
```

Use browser-like headers:

```ts
{
  "Cookie": cookie,
  "User-Agent": userAgent,
  "Accept": "application/json, text/plain, */*",
  "Referer": `${publicationUrl}/publish/home`
}
```

Only send `Content-Type: application/json` when the request has a JSON body.

### 12.3 Endpoints

Implement these methods:

```ts
class SubstackClient {
  validateAuth(): Promise<{ id: number; ok: true }>;
  listDrafts(offset: number, limit: number): Promise<SubstackDraftSummary[]>;
  getDraft(draftId: number): Promise<SubstackDraft>;
  createDraft(payload: DraftCreatePayload): Promise<SubstackDraft>;
  updateDraft(draftId: number, payload: DraftUpdatePayload): Promise<SubstackDraft>;
  uploadImage(dataUri: string): Promise<{ url: string }>;
}
```

Likely endpoints based on current unofficial implementations:

```text
GET  /api/v1/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc
GET  /api/v1/drafts/:id
POST /api/v1/drafts
PUT  /api/v1/drafts/:id
POST /api/v1/image
```

Do not rely on these as permanent contracts. Add typed errors and integration tests.

### 12.4 Error handling

Create errors:

```ts
class SubstackApiError extends Error { status?: number; endpoint?: string; }
class SubstackAuthError extends SubstackApiError {}
class SubstackRateLimitError extends SubstackApiError {}
class SubstackValidationError extends SubstackApiError {}
class SubstackNotFoundError extends SubstackApiError {}
class SubstackServerError extends SubstackApiError {}
```

Map:

- 400 -> validation.
- 401/403 -> auth.
- 404 -> not found.
- 429 -> rate limit.
- 5xx -> server.

When returning errors to MCP clients:

- Redact cookies.
- Redact session tokens.
- Cap response body excerpts to 500 chars.
- Include actionable hints: expired token, wrong publication URL, custom domain issue, or rate limit.

---

## 13. Confirmation Token Flow

Write tools must require a confirmation token generated by `preview_draft`.

Create `src/safety/confirmationToken.ts`.

### 13.1 Token payload

```ts
interface ConfirmationTokenPayload {
  version: 1;
  action: "create" | "update";
  draft_id?: number;
  title_hash?: string;
  subtitle_hash?: string;
  audience?: string;
  content_hash?: string;
  issued_at: number;
  expires_at: number;
}
```

### 13.2 Token format

Use an HMAC-signed compact token:

```text
base64url(json_payload).base64url(hmac_sha256(json_payload, PREVIEW_TOKEN_SECRET))
```

### 13.3 Verification

On `create_draft` and `update_draft`:

- Recompute normalized input hashes.
- Verify signature using constant-time compare.
- Verify expiry.
- Verify action.
- Verify draft ID for updates.
- Reject if any value changed since preview.

### 13.4 Why this matters

This prevents an agent from directly calling `create_draft` with arbitrary content without first producing a preview. It also makes the write path safer across MCP clients that may have different confirmation UIs.

---

## 14. HTTP MCP Server Implementation

Create `src/http.ts` using the OpenAI quickstart pattern.

Required behavior:

- Listen on `PORT`, default `8787`.
- Expose `GET /` with a simple text response.
- Expose `GET /healthz` with JSON health.
- Expose MCP at `/mcp` by default.
- Handle `OPTIONS /mcp` for CORS preflight.
- Accept `POST`, `GET`, and `DELETE` on `/mcp` for Streamable HTTP.
- Create a fresh `McpServer` and stateless transport per request unless the SDK docs recommend a different current pattern.
- Set `enableJsonResponse: true`.
- Close transport/server on response close.
- Log request ID and method/path, but not bodies by default.

Skeleton:

```ts
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { loadConfig } from "./config.js";
import { createSubstackClient } from "./substack/client.js";

const config = loadConfig();
const client = createSubstackClient(config);
const MCP_PATH = config.mcpPathSecret ? `/mcp/${config.mcpPathSecret}` : "/mcp";
const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("Substack Draft MCP Server");
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id"
    });
    res.end();
    return;
  }

  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const mcpServer = createMcpServer({ client, config });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      transport.close();
      mcpServer.close();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request failed", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(config.port, () => {
  console.log(`Substack Draft MCP listening on http://localhost:${config.port}${MCP_PATH}`);
});
```

The coding agent must adjust imports and options to match the installed SDK version.

---

## 15. Client Compatibility and stdio Entrypoint

The server must be compatible with ChatGPT **and** local coding-agent clients. That means V1 must not be ChatGPT-only. Implement a shared MCP server factory and two transports:

```text
src/server.ts     # createMcpServer({ client, config }) shared by all transports
src/http.ts       # Streamable HTTP endpoint for ChatGPT/ngrok/Cloud Run/remote clients
src/stdio.ts      # stdio transport for Claude Code/Cursor/local clients
```

### 15.1 Compatibility matrix

| Client / host | Transport to support | Auth plan | Required setup artifact |
|---|---|---|---|
| ChatGPT developer-mode connector | HTTPS Streamable HTTP at `/mcp` through ngrok or Cloud Run | `noauth` for local testing; `oauth` for durable use | ChatGPT connector URL: `https://<host>/mcp` |
| MCP Inspector | Local HTTP and optionally OAuth test flow | `noauth`, `static_bearer`, and eventually `oauth` | `npx @modelcontextprotocol/inspector` command in README |
| Claude Code local | `stdio` | env vars passed to process; no HTTP caller auth needed | `claude mcp add --transport stdio ...` example |
| Claude Code remote | Streamable HTTP | `static_bearer` or `oauth` | `claude mcp add --transport http ...` example |
| Cursor local | `stdio` | env vars or `envFile` in `.cursor/mcp.json` | `.cursor/mcp.json` example |
| Cursor remote | Streamable HTTP URL | static headers or OAuth | `.cursor/mcp.json` remote URL example |
| Claude Desktop / other local clients | `stdio` | env vars | generic MCP JSON example |

### 15.2 Required stdio entrypoint

Although the original architecture marked stdio as optional, V1 should include it because it is the easiest path for Claude Code and Cursor local usage.

Create `src/stdio.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { loadConfig } from "./config/env.js";
import { createSubstackClient } from "./substack/client.js";

async function main() {
  const config = loadConfig({ transport: "stdio" });
  const client = createSubstackClient(config);
  const server = createMcpServer({ client, config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal stdio MCP error", err);
  process.exit(1);
});
```

### 15.3 Claude Code setup examples

Local stdio:

```bash
npm run build
claude mcp add --transport stdio substack-drafts \
  --env SUBSTACK_PUBLICATION_URL="https://yourpublication.substack.com" \
  --env SUBSTACK_SESSION_TOKEN="<session-token>" \
  --env SUBSTACK_USER_ID="<user-id>" \
  --env PREVIEW_TOKEN_SECRET="<32-plus-random-bytes>" \
  -- node /absolute/path/to/substack-draft-mcp/dist/stdio.js
```

Remote HTTP with static bearer auth:

```bash
claude mcp add --transport http substack-drafts https://your-cloud-run-url/mcp \
  --header "Authorization: Bearer <mcp-bearer-token>"
```

Remote HTTP with OAuth after `AUTH_MODE=oauth` is implemented:

```bash
claude mcp add --transport http substack-drafts https://your-cloud-run-url/mcp
claude mcp login substack-drafts
```

### 15.4 Cursor setup examples

Project-local stdio at `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "substack-drafts": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/substack-draft-mcp/dist/stdio.js"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourpublication.substack.com",
        "SUBSTACK_SESSION_TOKEN": "${env:SUBSTACK_SESSION_TOKEN}",
        "SUBSTACK_USER_ID": "${env:SUBSTACK_USER_ID}",
        "PREVIEW_TOKEN_SECRET": "${env:PREVIEW_TOKEN_SECRET}",
        "AUTH_MODE": "noauth"
      }
    }
  }
}
```

Remote HTTP with static bearer auth:

```json
{
  "mcpServers": {
    "substack-drafts": {
      "url": "https://your-cloud-run-url/mcp",
      "headers": {
        "Authorization": "Bearer ${env:MCP_BEARER_TOKEN}"
      }
    }
  }
}
```

Notes for Cursor:

- Use `envFile` only for stdio/local servers.
- For remote HTTP servers, use environment interpolation in `headers` rather than putting secrets in `mcp.json`.
- Keep a project-level `.cursor/mcp.json` out of git if it contains secrets or absolute local paths.

### 15.5 Generic MCP JSON for local clients

Create `examples/mcp.local.stdio.json`:

```json
{
  "mcpServers": {
    "substack-drafts": {
      "command": "node",
      "args": ["/absolute/path/to/substack-draft-mcp/dist/stdio.js"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourpublication.substack.com",
        "SUBSTACK_SESSION_TOKEN": "<session-token>",
        "SUBSTACK_USER_ID": "<user-id>",
        "PREVIEW_TOKEN_SECRET": "<32-plus-random-bytes>",
        "AUTH_MODE": "noauth"
      }
    }
  }
}
```

Create `examples/mcp.remote.http.json`:

```json
{
  "mcpServers": {
    "substack-drafts": {
      "type": "streamable-http",
      "url": "https://your-cloud-run-url/mcp",
      "headers": {
        "Authorization": "Bearer <mcp-bearer-token>"
      }
    }
  }
}
```

### 15.6 Package scripts

Package scripts:

```json
{
  "scripts": {
    "dev:http": "tsx src/http.ts",
    "dev:stdio": "tsx src/stdio.ts",
    "build": "tsc -p tsconfig.json",
    "start:http": "node dist/http.js",
    "start:stdio": "node dist/stdio.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "inspect:draft": "tsx scripts/inspectDraft.ts"
  }
}
```

### 15.7 Compatibility acceptance criteria

The coding agent must not mark V1 complete until all of these pass:

- ChatGPT can list tools and create a draft through ngrok in `AUTH_MODE=noauth`.
- MCP Inspector can list tools against local HTTP.
- Claude Code can list and call `validate_newsletter_content` through stdio.
- Cursor can list and call `validate_newsletter_content` through stdio.
- Remote HTTP returns `401` when `AUTH_MODE=static_bearer` and no bearer token is sent.
- Remote HTTP accepts the correct bearer token for Claude Code/Cursor.
- Write tools still require confirmation tokens regardless of transport or auth mode.
- No client setup requires exposing `SUBSTACK_SESSION_TOKEN` to ChatGPT or any remote MCP host; only local stdio clients receive it as a local process environment variable.

---

## 16. Local Development Plan

### 16.1 Prerequisites

Install:

```bash
node --version   # should be 20+
npm --version
ngrok version
```

### 16.2 Create local env file

```bash
cp .env.example .env.local
```

Fill in:

```bash
SUBSTACK_PUBLICATION_URL=https://yourpublication.substack.com
SUBSTACK_SESSION_TOKEN=<connect.sid value from browser cookies>
SUBSTACK_USER_ID=<your Substack user id>
PREVIEW_TOKEN_SECRET=$(openssl rand -base64 32)
```

### 16.3 Run locally

```bash
npm install
npm run dev:http
```

Expected output:

```text
Substack Draft MCP listening on http://localhost:8787/mcp
```

Check health:

```bash
curl http://localhost:8787/healthz
```

### 16.4 Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest \
  --server-url http://localhost:8787/mcp \
  --transport http
```

Test flow:

1. Run `validate_newsletter_content` with `fixtures/markdown/full-rich-draft.md`.
2. Run `preview_draft` with the same content.
3. Copy the returned `confirmation_token`.
4. Run `create_draft` with the token.
5. Confirm a draft appears in Substack.
6. Open the draft in Substack and verify formatting.

### 16.5 Expose with ngrok

For the automated noauth smoke plus a bounded ChatGPT acceptance window:

```bash
npm run mcp:preflight -- --require-live
npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md
```

Use the live HTTPS `/mcp` endpoint printed before the wait expires. The command closes the server and tunnel automatically when the window ends or on Ctrl-C. Keep this noauth URL private because the explicit local-credential mode is intended only for the guarded manual draft flow.

To manage the tunnel separately instead:

```bash
ngrok http 8787
```

Copy the HTTPS forwarding URL and append `/mcp`:

```text
https://<subdomain>.ngrok.app/mcp
```

### 16.6 Connect from ChatGPT

In ChatGPT developer mode:

1. Go to **Settings → Apps & Connectors → Advanced settings**.
2. Enable developer mode.
3. Go to **Settings → Connectors**.
4. Create a connector.
5. Paste the ngrok MCP URL:

   ```text
   https://<subdomain>.ngrok.app/mcp
   ```

6. Name it `Substack Drafts Local`.
7. Start a new chat.
8. Add the connector through the `+` / tools menu.
9. Test:

   ```text
   Use the Substack Drafts connector to validate a newsletter draft with a heading, an image, a Python code block, and a LaTeX equation. Do not create the draft yet.
   ```

Then:

```text
Now preview the draft and show me the exact title, subtitle, warnings, and confirmation summary before creating it.
```

Then:

```text
Create the draft using the confirmation token from the preview. Do not publish it.
```

---

## 17. GCP / Cloud Run Deployment Plan

### 17.1 Prepare GCP project

Set variables:

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export SERVICE_NAME="substack-draft-mcp"
export SERVICE_ACCOUNT="substack-mcp-sa"

gcloud config set project "$PROJECT_ID"
```

Enable APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com
```

### 17.2 Create service account

```bash
gcloud iam service-accounts create "$SERVICE_ACCOUNT" \
  --display-name="Substack Draft MCP Cloud Run service account"
```

Full service account email:

```bash
export SERVICE_ACCOUNT_EMAIL="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com"
```

### 17.3 Create secrets

```bash
printf "%s" "<your-substack-session-token>" | \
  gcloud secrets create substack-session-token --data-file=-

printf "%s" "$(openssl rand -base64 32)" | \
  gcloud secrets create mcp-preview-token-secret --data-file=-

# Optional, only if deploying with AUTH_MODE=static_bearer for clients that can send headers.
printf "%s" "$(openssl rand -base64 32)" | \
  gcloud secrets create mcp-bearer-token --data-file=-
```

Grant Cloud Run service account access:

```bash
gcloud secrets add-iam-policy-binding substack-session-token \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding mcp-preview-token-secret \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

# Optional, only if using AUTH_MODE=static_bearer.
gcloud secrets add-iam-policy-binding mcp-bearer-token \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/secretmanager.secretAccessor"
```

### 17.4 Deploy from source

From repo root:

```bash
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60 \
  --set-env-vars="NODE_ENV=production,PORT=8080,LOG_LEVEL=info,MCP_TRANSPORT=http,SUBSTACK_PUBLICATION_URL=https://yourpublication.substack.com,SUBSTACK_USER_ID=123456,AUTH_MODE=noauth,MAX_BODY_BYTES=750000,MAX_IMAGE_BYTES=8000000,CONFIRMATION_TOKEN_TTL_SECONDS=900" \
  --set-secrets="SUBSTACK_SESSION_TOKEN=substack-session-token:latest,PREVIEW_TOKEN_SECRET=mcp-preview-token-secret:latest,MCP_BEARER_TOKEN=mcp-bearer-token:latest"
```

If deploying for Claude Code or Cursor over HTTP with `AUTH_MODE=static_bearer`, change the deploy command to include:

```bash
  --set-env-vars="...AUTH_MODE=static_bearer..." \
  --set-secrets="SUBSTACK_SESSION_TOKEN=substack-session-token:latest,PREVIEW_TOKEN_SECRET=mcp-preview-token-secret:latest,MCP_BEARER_TOKEN=mcp-bearer-token:latest"
```

Notes:

- Cloud Run injects the `PORT` env var. The command sets it to `8080`; Cloud Run also uses `8080` by default.
- `--allow-unauthenticated` is necessary for a noauth ChatGPT connector to reach the service. This is acceptable only for private testing and draft-only tooling.
- Set `--max-instances=1` initially to limit abuse impact.
- Keep `--min-instances=0` for cost control.

### 17.5 Get service URL

```bash
gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --format="value(status.url)"
```

MCP endpoint:

```text
https://<cloud-run-service-url>/mcp
```

### 17.6 Connect ChatGPT to Cloud Run endpoint

Use the same connector process as ngrok, but paste:

```text
https://<cloud-run-service-url>/mcp
```

Name it:

```text
Substack Drafts Cloud Run
```

Test with read-only tools first:

```text
Use my Substack Drafts Cloud Run connector to list my five most recent drafts. Do not create or update anything.
```

Then test `preview_draft`, then `create_draft`.

### 17.7 Optional custom domain

After the Cloud Run deployment works, optionally map a custom domain:

```text
https://mcp.yourdomain.com/substack/mcp
```

Do not do this before OAuth unless you are comfortable exposing a stable noauth URL. For private V1, a rotating Cloud Run URL or ngrok URL may actually be safer than a memorable custom domain.

### 17.8 Budget alert

Create a GCP budget alert immediately after deployment. Suggested threshold:

```text
Budget: $5/month
Alerts: 50%, 90%, 100%
```

---

## 18. Dockerfile

Use a simple production Dockerfile, even if deploying with `--source`, so the service is reproducible.

```dockerfile
FROM node:20-slim AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/http.js"]
```

---

## 19. Test Plan

### 19.1 Unit tests

Must include:

- `parseMarkdown.test.ts`
  - headings
  - paragraphs
  - bold/italic/link/inline code
  - lists
  - blockquotes
  - horizontal rules
  - images
  - fenced code blocks
  - `$$` block math
  - `:::latex` directive if implemented

- `toSubstackProseMirror.test.ts`
  - text marks map correctly
  - code block maps to fixture shape
  - image block maps to fixture shape
  - LaTeX block maps to fixture shape
  - empty body produces a valid empty paragraph

- `confirmationToken.test.ts`
  - valid token verifies
  - expired token fails
  - tampered payload fails
  - changed title fails
  - changed body fails
  - update token cannot be reused for create

- `urlPolicy.test.ts`
  - rejects `file://`
  - rejects `data:` for URL fetch path
  - rejects private network URLs if implemented
  - accepts HTTPS image URL

- `redaction.test.ts`
  - redacts `connect.sid`
  - redacts `substack.sid`
  - redacts `SUBSTACK_SESSION_TOKEN`

### 19.2 Mock integration tests

Use `nock` or equivalent to mock Substack endpoints.

Cases:

- `listDrafts` maps response.
- `getDraft` maps response.
- `createDraft` sends correct minimal payload.
- `updateDraft` sends only changed fields.
- `uploadImage` sends expected JSON body.
- 401 maps to `SubstackAuthError`.
- 429 maps to `SubstackRateLimitError`.

### 19.3 Live integration tests

Before using account credentials, follow the local progression:

```bash
npm run auth:setup
npm run test:mcp-local
npm run mcp:preflight
npm run mcp:preflight -- --require-live
RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live
```

The first command runs the loopback Substack onboarding flow, derives the user ID, generates the preview secret, and saves private local auth. The second command verifies credential-free MCP transports. The focused preflight checks local Substack credentials without Cloud Run, ngrok, Cloud Billing, or release-ready fixture gates; `--require-live` makes that check fail fast. The final command remains explicitly guarded because it exercises the user's Substack account. It connects an MCP SDK `Client` to the registered server through SDK in-memory transport, calls `client.listTools()` and requires exactly `validate_newsletter_content`, `preview_draft`, `create_draft`, `update_draft`, `list_drafts`, `get_draft`, and `upload_image`, then invokes upload, preview, create, list, get, update, and post-update get through `client.callTool`. This exercises MCP input schemas, registration, and result wrappers in addition to live Substack behavior. The harness is structurally verified, but its credentialed behavior still requires the explicit live run. Cloud Run remains deferred.

Keep the live test guarded by an env var:

```bash
RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live
```

Live tests should:

- Connect an MCP SDK `Client` to the registered MCP server through SDK in-memory transport.
- List and require exactly `validate_newsletter_content`, `preview_draft`, `create_draft`, `update_draft`, `list_drafts`, `get_draft`, and `upload_image`.
- Invoke upload, preview, create, list, get, update, and post-update get through `client.callTool` so MCP schemas, registration, and result wrappers are exercised.
- Create a draft titled `[MCP TEST] <timestamp>`.
- Include a paragraph, code block, image, and LaTeX block.
- Never publish.
- Print the draft ID and URL.
- Require manual cleanup through Substack.

The MCP Client/in-memory transport structure above has deterministic regression coverage. Do not record live Substack evidence until the credentialed test itself has run successfully and its draft has been manually reviewed.

### 19.4 Manual acceptance draft

Use this Markdown fixture:

````md
# MCP Rich Draft Test

This is a test paragraph with **bold**, *italic*, `inline code`, and [a link](https://example.com).

> This is a blockquote.

- First bullet
- Second bullet

1. First numbered item
2. Second numbered item

---

![A small test image](PASTE_SUBSTACK_UPLOADED_IMAGE_URL_HERE "Test image caption")

```python
def fibonacci(n: int) -> int:
    if n < 2:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(fibonacci(10))
```

$$
E = mc^2
$$
````

Manual acceptance criteria:

- Draft appears in Substack dashboard.
- Title and subtitle are correct.
- Text formatting renders correctly in editor.
- Image appears with alt/caption or documented fallback.
- Code appears as native code block, not plain paragraph.
- LaTeX appears as native equation block, not plain text or screenshot.
- Preview works in Substack.
- Nothing is published.

---

## 20. Coding Agent Milestones

### Milestone 1 — Project scaffold

Tasks:

1. Create TypeScript project.
2. Add package scripts.
3. Add `.env.example` and `.gitignore`.
4. Add `src/config.ts`.
5. Add basic `src/http.ts` with `/`, `/healthz`, and `/mcp`.
6. Add minimal `src/server.ts` with `health_check` or `validate_newsletter_content`.
7. Verify MCP Inspector sees the tool.

Done when:

```bash
npm run dev:http
npx @modelcontextprotocol/inspector@latest --server-url http://localhost:8787/mcp --transport http
```

shows at least one tool.

### Milestone 2 — Content model and Markdown parser

Tasks:

1. Implement `NewsletterBlock` schemas.
2. Implement `parseMarkdown` using `unified`, `remark-parse`, `remark-gfm`, `remark-math`.
3. Implement `validate_newsletter_content`.
4. Add unit tests for supported Markdown.
5. Add warnings for unsupported raw HTML/tables/footnotes/task lists if not supported.

Done when:

```bash
npm test -- parseMarkdown
```

passes and `validate_newsletter_content` returns correct counts for the rich fixture.

### Milestone 3 — Substack body adapter

Tasks:

1. Implement `toSubstackProseMirror` for paragraphs, headings, lists, blockquotes, horizontal rule.
2. Implement inline marks.
3. Add fixture-based tests.
4. Add code block mapping using discovered fixture.
5. Add image mapping using discovered fixture.
6. Add LaTeX mapping using discovered fixture.

Done when:

- All content adapter tests pass.
- A generated body JSON can be copied into a Substack draft API request and render correctly.

### Milestone 4 — Substack API client

Tasks:

1. Implement `SubstackClient`.
2. Implement typed errors.
3. Implement redaction.
4. Add mock integration tests.
5. Add `scripts/inspectDraft.ts` for fixture discovery.

Done when:

- Mock tests pass.
- `npm run inspect:draft -- <draft_id>` can fetch a known draft using `.env.local` credentials.

### Milestone 5 — Tool implementation

Tasks:

1. Implement `preview_draft`.
2. Implement confirmation tokens.
3. Implement `create_draft`.
4. Implement `update_draft`.
5. Implement `list_drafts`.
6. Implement `get_draft`.
7. Implement `upload_image`.
8. Add exact annotations for each tool.
9. Add tests that every registered tool has an annotation.

Done when:

- MCP Inspector can run the preview/create/update flow.
- Write tools reject missing or invalid confirmation tokens.
- Draft appears in Substack and is not published.

### Milestone 6 — Local ChatGPT test through ngrok

Tasks:

1. Run local server.
2. Expose through ngrok.
3. Register connector in ChatGPT developer mode.
4. Verify tool list.
5. Run read-only `list_drafts`.
6. Run `preview_draft` with full rich content.
7. Run `create_draft` only after preview.
8. Manually verify draft in Substack.

Done when:

- ChatGPT can create a draft containing text, image, code block, and LaTeX block.

### Milestone 7 — Cloud Run deployment

Tasks:

1. Add Dockerfile.
2. Verify `npm run build`.
3. Create GCP service account.
4. Create Secret Manager secrets.
5. Deploy with `gcloud run deploy --source`.
6. Verify `/healthz`.
7. Register Cloud Run `/mcp` endpoint in ChatGPT.
8. Repeat local acceptance flow.

Done when:

- ChatGPT can use the Cloud Run connector to create a draft.
- Secrets are not visible in logs.
- `min-instances=0`, `max-instances=1` are configured.

---

## 21. README Requirements

The repository README must include:

1. What the project does.
2. Safety boundary: drafts only, no publish/delete/schedule.
3. Supported formatting.
4. Known limitations.
5. How to get Substack credentials.
6. Local setup.
7. MCP Inspector testing.
8. ngrok + ChatGPT setup.
9. Cloud Run deployment.
10. Secret rotation.
11. Troubleshooting.

### Required warning text

Add this near the top:

> This project uses Substack's unofficial/internal API. It may break if Substack changes its editor or endpoints. Keep credentials private. Use this for personal drafting workflows only unless you add proper OAuth and complete a security review.

---

## 22. Troubleshooting Guide

### ChatGPT shows no tools

Check:

- Server is running.
- URL ends in `/mcp`.
- ngrok tunnel is active.
- ChatGPT connector metadata was refreshed.
- `/mcp` responds to `POST` and `GET` as expected by MCP transport.
- CORS preflight returns allowed methods and headers.

### Substack returns 401/403

Likely causes:

- Expired `connect.sid` token.
- Wrong publication URL.
- Custom domain / Cloudflare issue.
- Missing or non-browser `User-Agent`.
- Missing `Referer`.

Fixes:

- Copy a fresh session token from browser cookies.
- Prefer canonical `*.substack.com` publication URL.
- Use browser-like `SUBSTACK_USER_AGENT`.

### Draft created but formatting is wrong

Likely causes:

- Incorrect ProseMirror node names.
- Incorrect mark names.
- LaTeX shape not discovered.
- Image shape missing caption or attrs.

Fixes:

- Create manual Substack fixture.
- Fetch draft JSON with `inspectDraft.ts`.
- Update `toSubstackProseMirror.ts`.
- Add regression test.

### Image upload fails

Check:

- MIME type is allowed.
- Image is under `MAX_IMAGE_BYTES`.
- Remote URL is reachable by the server.
- Substack session token is still valid.
- Data URI prefix is correct.

### Cloud Run deployment works but ChatGPT fails

Check:

- Service allows unauthenticated requests, or OAuth is correctly configured.
- URL is `https://.../mcp`.
- `/healthz` works.
- Cloud Run logs show incoming requests.
- Timeout is at least 60 seconds.
- Server listens on `process.env.PORT`.

---

## 23. V1 Acceptance Criteria

V1 is complete only when all of these are true:

1. `npm test` passes.
2. `npm run build` passes.
3. MCP Inspector lists all tools.
4. `validate_newsletter_content` handles rich Markdown fixture.
5. `preview_draft` returns a confirmation token and useful warnings.
6. `create_draft` rejects missing/invalid/expired confirmation tokens.
7. `create_draft` creates a Substack draft with:
   - headings
   - rich text
   - links
   - lists
   - blockquote
   - horizontal rule
   - uploaded image
   - native code block
   - native LaTeX block
8. `update_draft` updates an existing unpublished draft.
9. `list_drafts` and `get_draft` work.
10. No publish/delete/schedule/Notes tool exists.
11. Local ngrok + ChatGPT connector works.
12. Cloud Run deployment works.
13. Substack session token, preview token secret, and MCP bearer token are stored in Secret Manager in Cloud Run.
14. `AUTH_MODE=static_bearer` works for at least one HTTP client that supports headers.
15. Claude Code or Cursor can connect through stdio using env-based credentials.
16. No secrets appear in logs.
17. README includes local, Claude Code, Cursor, ChatGPT/ngrok, and Cloud Run instructions.

---

## 24. Suggested First Prompt for the Coding Agent

Use this prompt to start implementation:

```text
You are implementing the repository described in substack_mcp_v1_implementation_plan.md.

Build the V1 Substack Draft MCP Server in TypeScript. Follow the non-negotiable safety boundary: draft creation/update only; no publish, no delete, no schedule, no Notes.

Start with Milestone 1 and Milestone 2:
1. Scaffold the TypeScript project.
2. Implement HTTP MCP endpoint at /mcp using @modelcontextprotocol/sdk StreamableHTTPServerTransport.
3. Implement the NewsletterBlock model and validate_newsletter_content tool.
4. Add tests for Markdown parsing.
5. Do not implement Substack writes until tests are passing.

After each milestone, run npm test and npm run build, then summarize changed files and remaining work.
```

---
## 25. Future V1.1 / V2 Ideas

Do not implement these until V1 is stable:

- OAuth 2.1 for ChatGPT production use.
- Multi-publication support.
- Multiple Substack accounts.
- Draft diffing.
- Rich UI component inside ChatGPT for previewing draft structure.
- Automatic screenshot preview of Substack draft.
- Scheduling flow with explicit human confirmation.
- Publish flow with multi-step out-of-band confirmation.
- Browser automation fallback if Substack internal API breaks.
- Support for tables by rendering them to images or simplified HTML-compatible layouts.
- Asset library / image cache.
- Style presets for a specific newsletter brand.


---
