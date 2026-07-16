# Security

This repository is open source, but each deployed server handles credentials and drafts for a private Substack account. It uses Substack's unofficial/internal API and must be treated as personal automation unless OAuth and a broader security review are completed.

## Supported Versions

Security fixes are applied to the latest code on `main`. Older commits and
unreleased local modifications are not supported. When tagged releases are
introduced, this section will identify any additional supported release lines.

## Product Boundary

The server manages unpublished drafts. It must not publish, schedule, delete, email, or create public Substack Notes. Write tools create or update unpublished drafts, and the user must review and publish manually inside Substack.

## Secrets

Never commit private `.env` files, Substack session cookies, preview token secrets, bearer tokens, draft bodies from private posts, or Cloud Run secret values. `.env.example` is the only committed env template and must stay secret-empty.

For local onboarding, `npm run auth:setup` accepts the publication URL through a short-lived loopback-only form. On macOS, its primary action explicitly authorizes a temporary owner-only copy of the cookie store from Chrome's most recently used profile. Headless Chrome starts with network access disabled, waits for the encrypted cookie store to load, retains cookies only for `substack.com` and the requested publication host, and clears every other copied cookie before network access is restored. It reads the authenticated user ID from the publication dashboard, validates the retained `connect.sid` against the publication administration API, and removes the temporary profile. The setup then generates the preview secret and atomically writes `.data/substack-auth.json` with mode `0600`; it never modifies the source Chrome profile or copies Chrome history and password databases. Isolated Chrome sign-in and a manual form that extracts only `connect.sid` or `substack.sid` remain fallbacks; manual setup also requires an explicit positive user ID. The loopback form uses a random request state, a strict loopback host check, an expected-or-opaque browser origin check, no-store responses, a restrictive content security policy, and a bounded request body. Never pass a Substack cookie through a CLI argument, MCP tool input, chat, log, or evidence artifact. The setup route is not part of MCP OAuth: MCP OAuth protects client access to this server, while the Substack cookie authenticates the server to the single configured upstream account.

Required private values:

- `SUBSTACK_SESSION_TOKEN`: browser session cookie value for the user's own Substack account. Store only the cookie value, not a full `Cookie:` header or `connect.sid=...` pair.
- `PREVIEW_TOKEN_SECRET`: random HMAC secret for write confirmation tokens.
- `MCP_BEARER_TOKEN`: random bearer token when `AUTH_MODE=static_bearer`. Store only the token value, not an `Authorization:` header or `Bearer ...` prefix.
- `MCP_PUBLIC_BASE_URL`: public HTTPS origin used in OAuth protected-resource metadata.
- `OAUTH_AUTHORIZATION_SERVER_URL`: OAuth/OIDC issuer URL used for remote MCP client linking.
- `OAUTH_JWKS_URL`: JWKS endpoint used to verify JWT access-token signatures.

OAuth metadata URLs must be absolute `https://` URLs without embedded usernames/passwords. Startup and preflight reject credentialed OAuth URLs so credentials cannot leak through protected-resource metadata, authorization-server metadata, documentation links, or JWKS fetching. Remote OAuth smoke tests also reject credentialed `authorization_servers` returned by protected-resource metadata.

Remote MCP smoke-test URLs for noauth, static-bearer, and OAuth checks must use HTTPS, must use `/mcp` or `/mcp/<secret>`, and must not include embedded usernames/passwords. Pass bearer or OAuth tokens only through the documented environment variables. Store token values only, not `Authorization:` headers or `Bearer ...` prefixes.

For Cloud Run, store `SUBSTACK_SESSION_TOKEN`, `PREVIEW_TOKEN_SECRET`, `MCP_BEARER_TOKEN`, and `MCP_PATH_SECRET` when configured in Secret Manager. Do not pass them as literal command-line values in durable deployments. Production startup refuses the built-in development preview-token secret.

`SUBSTACK_PUBLICATION_URL` must be a public `https://` publication origin. The runtime and Cloud Run planner reject `http://`, embedded URL usernames/passwords, localhost, and private-network origins so the Substack session cookie is not sent to an unsafe target. Copied Substack post/editor paths, queries, and fragments are discarded before requests are made.

Cookie-authenticated Substack API requests and remote image fetches use a bounded `SUBSTACK_REQUEST_TIMEOUT_MS` timeout so private draft operations do not hang indefinitely on an unresponsive upstream or stalled API response body.

## Auth Modes

- `AUTH_MODE=noauth`: local development, MCP Inspector, or short-lived personal tunnel testing only. The server logs a startup warning in this mode.
- `AUTH_MODE=static_bearer`: private remote HTTP clients that can send `Authorization: Bearer ...` headers.
- `AUTH_MODE=oauth`: verifies JWT bearer tokens through the configured JWKS endpoint, issuer, audience/resource, expiration, and recognized MCP scopes. Tool calls require the per-tool scope advertised in MCP metadata.

Outside production, the HTTP server binds to `127.0.0.1` by default. In production it binds to `0.0.0.0` by default for Cloud Run; override `HOST` only when the deployment environment requires a different bind address.

Confirmation tokens from `preview_draft` are write-safety controls, not authentication. They bind a write request to a recent preview, but caller authentication is still handled by `AUTH_MODE`.

## Logging

Logs should include request IDs, method, path, and operational errors. They should not include request bodies, draft body contents, Substack session cookies, bearer tokens, OAuth tokens, preview token secrets, or the `MCP_PATH_SECRET` value. When `MCP_PATH_SECRET` is configured, request and startup logs redact the endpoint as `/mcp/<redacted>`.

HTTP write and image operations emit audit events with safe metadata only: action, outcome, counts, booleans, draft IDs, audience, idempotency-key presence/replay status, and failure reason. Audit records must not include titles, subtitles, draft bodies, confirmation tokens, idempotency key values, source image URLs, image payloads, uploaded image URLs, or credentials. Runtime log redaction also covers common snake_case and camelCase variants for draft bodies, request/raw bodies, idempotency keys, image URLs, image payloads, confirmation tokens, bearer tokens, session cookies, and private MCP path segments.

Tool errors returned to MCP clients scrub cookies, bearer tokens, env-style secrets, draft/body content fields, confirmation tokens, and image payload fields. Substack API response excerpts are also capped before they are included.

## Remote Image Fetching

`upload_image` treats file references, URL, base64/data-URI, SVG, and card sources as untrusted input. Every accepted source is decoded, dimension-checked, auto-oriented, converted to sRGB PNG, checked against `MAX_IMAGE_BYTES`, reopened, and compared with source metadata before upload. Source dimensions are preserved by default; explicit bounds can resize with a structured warning, while unexpected aspect-ratio and color-to-monochrome changes fail before upload unless explicitly allowed. SVG input is parsed and rejected if it contains scripts, event handlers, external references, foreign content, entities, processing instructions, or unsafe CSS.

Local `image_file` paths must be absolute and are disabled unless `IMAGE_FILE_ROOTS` contains an allowed directory. The resolver canonicalizes both the root and requested path, requires a regular file, checks real-path containment to block traversal and symlink escapes, and reads only the exact requested file. It never searches by filename, selects a neighboring file, or substitutes another artifact. Connector file references must provide a safe downloadable URL or an allowlisted mounted path; opaque references fail closed. Optional source checksums are verified before normalization.

Remote input URLs must use `http://` or `https://`, must not include embedded usernames/passwords, must not identify localhost or private network ranges, and must resolve only to public addresses before a request is attempted. Redirects are rejected. Fetches must complete within `SUBSTACK_REQUEST_TIMEOUT_MS`, return a supported image MIME type, and stay under `MAX_IMAGE_BYTES` by both declared `Content-Length` and streamed bytes. The uploaded URL returned by Substack is also validated as public `http(s)` before it reaches MCP clients.

The DNS check occurs before the HTTP connection but does not pin the verified address to the connection made by the runtime fetch implementation. Production deployments should also enforce outbound network policy that blocks private, loopback, link-local, and metadata-service ranges to defend against DNS rebinding and time-of-check/time-of-use changes. Do not configure broad filesystem roots for a network-exposed server; prefer short-lived connector download URLs and leave `IMAGE_FILE_ROOTS` empty.

## Targeted Native Image Updates

`preview_draft.image_patch` and `update_draft.image_patch` refetch the current unpublished draft, parse its bounded native JSON body, and replace exactly one selected `image2` node. A confirmation token binds the resulting complete `draft_body`; the update refetch rejects the token when the draft changed after preview. Unknown and non-target JSON is preserved, and caption mutation never falls back to inserting an ordinary paragraph.

The unofficial Substack API has not been verified to support an `If-Match` header, ETag, or another atomic conditional update. There is therefore a residual race between the final update-side read and PUT. Keep this private workflow low-concurrency, review the returned draft immediately, and do not edit the same draft concurrently while applying an image patch.

## Rotation

Rotate the Substack session token if an ngrok URL was shared, logs show unexpected access, or a local credential may have leaked. Rotate `PREVIEW_TOKEN_SECRET` to invalidate outstanding confirmation tokens. Rotate `MCP_BEARER_TOKEN` after any remote-client exposure.

## Reporting

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/damienbenveniste/substack-mcp/security/advisories/new).
Do not open a public issue for a vulnerability, suspected credential exposure,
or private-data exposure. Include only the minimum redacted information needed
to reproduce and assess the problem; never submit credentials, session cookies,
tokens, private drafts, or raw responses.

The maintainer will acknowledge a report within seven days and will coordinate
validation, remediation, and disclosure through the private advisory. Ordinary
non-security bugs should use the repository's public bug-report form.
