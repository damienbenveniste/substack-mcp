# Substack Draft MCP Server

[![CI](https://github.com/damienbenveniste/substack-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/damienbenveniste/substack-mcp/actions/workflows/ci.yml)
[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-0969da)](https://damienbenveniste.github.io/substack-mcp/)
[![License](https://img.shields.io/github/license/damienbenveniste/substack-mcp)](LICENSE)

Open-source, self-hosted MCP server for validating, previewing, creating, and updating Substack newsletter drafts through an MCP-compatible client.

> This project uses Substack's unofficial/internal API. It may break if Substack changes its editor or endpoints. Keep credentials private. Use this for personal drafting workflows only unless you add proper OAuth and complete a security review.

## Safety Boundary

This project manages unpublished Substack drafts. It does not publish, schedule, delete, email, or create public Substack Notes. Users review and publish manually inside Substack.

## What It Does

- Exposes seven MCP tools for Substack draft workflows over Streamable HTTP or stdio: `list_drafts`, `get_draft`, `validate_newsletter_content`, `preview_draft`, `create_draft`, `update_draft`, and `upload_image`.
- Converts Markdown or structured blocks into Substack's editor format, including native code blocks, display LaTeX, images, alt text, and captions.
- Requires a matching `preview_draft` confirmation token before creating or updating a draft.
- Accepts exact image artifacts, public image URLs, base64/data URIs, SVG, or generated cards and reports source and processed fingerprints.
- Keeps Substack credentials server-side and redacts secrets and draft content from normal logs and client-visible errors.

Start with [Quickstart](#quickstart), then follow the [client setup guide](docs/CLIENT_SETUP.md) for a stable ngrok URL, ChatGPT, Claude, Claude Desktop, or Claude Code. The published documentation is available on [GitHub Pages](https://damienbenveniste.github.io/substack-mcp/).

## Supported Formatting

The `markdown_v1` path supports headings, paragraphs, bold, italic, links, inline code, blockquotes, ordered and unordered lists, horizontal rules, images, fenced code blocks, LaTeX blocks, and explicit `:::image` / `:::latex` directives. The `blocks_v1` path supports structured newsletter blocks for callers that prefer JSON over Markdown.

Provide only the body field that matches `body_format`: `body_markdown` for `markdown_v1`, or `blocks` for `blocks_v1`. Mixed body payloads are rejected before preview-token generation.

Markdown and `blocks_v1` URLs must be public `http(s)` URLs. Unsafe links and images are dropped or rejected before they can reach Substack.

## Known Limitations

- Substack's draft API and editor document shape are unofficial and may change without notice.
- Images and native captions use the current `captionedImage`/`image2` editor shape, but still require a real captured draft-body fixture and manual rendering review before their provisional mapping can be called complete. Native highlighted-code and LaTeX mappings have the same live-verification boundary.
- Live hosted deployment, real OAuth login, and acceptance in third-party MCP clients remain manual V1 gates.
- This server creates and updates unpublished drafts. Publishing, scheduling, deleting, emailing, and public Substack Notes are intentionally out of scope for V1.

## Tool Flow

Use `list_drafts` to find recent draft IDs from metadata-only summaries and `get_draft` to fetch draft metadata. `get_draft` omits the draft body by default; pass `include_body: true` when body inspection is needed. The native `draft_body` response field is authoritative, with `body` used only as a compatibility fallback. When the selected body is recognized as native Substack JSON, the response also includes `body_format: "substack_native_v1"`, a `body_sha256`, and a one-based `images` manifest. Requested draft bodies are checked against `MAX_BODY_BYTES` before they are returned.

Draft URLs returned by `list_drafts`, `get_draft`, `create_draft`, and `update_draft` are filtered before reaching MCP clients. URLs with unsupported protocols, embedded usernames/passwords, localhost hosts, or private-network hosts are omitted; write tools include a warning when they omit a candidate draft URL.

Use `upload_image` before referencing a new image in draft content. When the image was generated or uploaded in the current conversation, pass that exact artifact through `image_file`. Never redraw, recreate, simplify, or substitute another image merely to satisfy the schema. Use `image_url` only for an existing remote image and `image_base64` only when neither file nor URL input is available. Existing URL and base64 calls remain compatible.

Legacy `svg` and `card` sources remain available only when the user explicitly requests that exact server-rendered source. They must never be used as a fallback for an unavailable generated or uploaded artifact.

`image_file` accepts either the complete file object supplied by an MCP client or an absolute mounted local path. Remote file objects must include a downloadable URL; opaque placeholders are rejected with `SOURCE_ARTIFACT_UNAVAILABLE` rather than being replaced. Local paths are disabled by default and must resolve inside one of the comma-separated `IMAGE_FILE_ROOTS` directories. The resolver uses the exact path, verifies real-path containment, and never searches neighboring files or selects the most recent image.

All accepted sources pass through decode, validation, auto-orientation, visual-fidelity comparison, sRGB PNG encoding, reopen verification, checksum, and upload. Source dimensions are preserved by default unless explicit bounds require resizing. Successful results include `source` and `processed` metadata with filename, detected format, MIME type, dimensions, color mode, byte size, and SHA-256; file inputs also include a source artifact identifier. `preview_url` is the exact uploaded URL. Structured `warning_details` report format conversion, resizing, aspect-ratio change, large size reduction, color-mode change, transparency removal, stripped metadata, and suspicious output; the legacy `warnings` string list remains for compatibility. `allow_resize: false` rejects a required resize, and unexpected aspect-ratio or color-to-monochrome changes fail before upload unless explicitly allowed.

Image operations are deliberately separate: `upload_image` uploads media only, `preview_draft` previews insertion or a targeted replacement and lists every exact image URL plus its dimensions, alt text, caption, and title, and `create_draft` or `update_draft` performs the confirmed draft write. `alt_text` is accessibility text. `caption` is visible newsletter text represented by the native Substack caption child; `title` is separate image metadata. Neither is inserted by `upload_image` alone.

To replace one image in an existing rich draft without reconstructing its body:

1. Call `upload_image` and retain its exact uploaded `image_url`.
2. Call `get_draft` with `include_body: true`, then select either the current image URL or the one-based `native_index` from `draft.images`.
3. Call `preview_draft` with `action: "update"`, the `draft_id`, and `image_patch`. Provide exactly one selector: `match_image_url` or `image_index`.
4. Review the returned complete image manifest and patch hashes, then call `update_draft` with the identical `draft_id`, `image_patch`, and `confirmation_token`.

```json
{
  "action": "update",
  "draft_id": 123,
  "image_patch": {
    "image_index": 2,
    "replacement_image_url": "https://substackcdn.com/image/fetch/...",
    "alt_text": "Architecture diagram",
    "caption": "Updated platform architecture"
  }
}
```

Omit `alt_text`, `caption`, `title`, `width`, or `height` to preserve its current value; pass `null` to remove it explicitly. Do not combine `image_patch` with body or metadata fields. The server fetches the authoritative native body, changes exactly one `image2` node, preserves all other JSON fields, and binds the patched body to the confirmation token. If the body changes between preview and the update check, the token is rejected as stale. Caption changes require an existing native `captionedImage` container; the server never inserts a paragraph fallback.

Exact local file source:

```json
{
  "source_type": "file",
  "image_file": "/absolute/allowlisted/path/architecture-diagram.png",
  "alt_text": "Architecture diagram for the multi-tenant platform",
  "caption": "Multi-tenant AI platform reference architecture."
}
```

SVG source:

```json
{
  "source_type": "svg",
  "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"800\" height=\"400\"><rect width=\"800\" height=\"400\" fill=\"#ffffff\"/><text x=\"40\" y=\"210\" font-size=\"48\">Hello</text></svg>",
  "filename_hint": "hello.png"
}
```

Generated card source:

```json
{
  "source_type": "card",
  "card": {
    "width": 1200,
    "height": 630,
    "title": "Scaled dot-product attention",
    "subtitle": "A visual guide",
    "footer": "The AI Edge"
  },
  "alt_text": "Article title card"
}
```

Remote URLs must be public `http(s)` URLs without embedded credentials. The tool rejects private or localhost hosts and private DNS resolutions, does not follow redirects, bounds downloads with `SUBSTACK_REQUEST_TIMEOUT_MS`, and enforces `MAX_IMAGE_BYTES` against declared, streamed, and normalized bytes. SVG input is parsed as untrusted data and rejects scripts, event handlers, external references, foreign content, entities, processing instructions, and unsafe CSS. Local `image_file` paths require the explicit `IMAGE_FILE_ROOTS` allowlist and are intended for local or mounted stdio/server deployments; they do not grant a remote server access to files on the caller's machine.

Use `validate_newsletter_content` to check Markdown or `blocks_v1` content without generating a write token. Markdown links and image/directive URLs must be public `http(s)` URLs to become clickable or image nodes; unsafe Markdown URLs are reported as unsupported features. Explicit `blocks_v1` `href`, `src`, and `url` fields fail validation unless they are public `http(s)` URLs.

For agent-generated Markdown, standalone directives are supported when explicit structure is more reliable than Markdown shorthand:

```md
:::image
src: https://substackcdn.com/image/fetch/...
alt: Architecture diagram
caption: Local and hosted MCP paths
:::

:::latex
\int_0^1 x^2\,dx = \frac{1}{3}
:::
```

A fenced block whose language is exactly `latex` is also treated as display math rather than highlighted source code:

````md
```latex
\operatorname{Attention}(Q,K,V)=\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
```
````

Other fenced languages, including `python`, remain native highlighted-code blocks.

Use `preview_draft` before any future write action. It returns:

- A short `preview_text`.
- Formatting and fidelity warnings.
- Draft stats.
- An `images` manifest containing every exact URL to be inserted and any supplied dimensions, format, alt text, caption, and title.
- A `confirmation_token` bound to the action, draft id, title, subtitle, audience, and generated draft payload.
- A `confirmation_expires_at` timestamp.

The token is not authentication. It is a write-safety guard for `create_draft` and `update_draft`. Those tools recompute the draft payload and reject missing, expired, malformed, or mismatched tokens before writing to Substack. `confirmation_expires_at` is exclusive; tokens are invalid at that timestamp.

Title and subtitle metadata are trimmed and whitespace-collapsed before confirmation-token matching and before sending draft payloads to Substack. Draft body content is not whitespace-normalized.

`create_draft` sends an `audience` value only when the caller explicitly provides one. If omitted, the server leaves audience selection to Substack's draft defaults instead of forcing `everyone`, `only_free`, `only_paid`, or `founding`.

`create_draft` also accepts an optional `idempotency_key` to reduce accidental duplicate draft creation. Successful creates are remembered in memory for the preview-token TTL. A repeat call with the same key and same generated draft payload returns the original draft result without another Substack create call; reusing the same key for different draft input is rejected. This cache is per running process only and is not durable across restarts, redeployments, or multiple Cloud Run instances.

`update_draft` updates only fields provided by the caller. It can update the body plus metadata, metadata only, or one native image through `image_patch`. Ordinary body input is a full replacement and must contain everything the caller wants to preserve; the targeted image path instead patches the fetched native JSON and sends only `draft_body`. Update payloads omit create-only fields such as `type`. If no audience is provided, it preserves the current audience instead of defaulting to `everyone`. It refuses to update drafts that Substack does not report as plain unpublished drafts. A fetched draft must include a positive draft/unpublished marker such as `status: "draft"`, `status: "unpublished"`, `draft: true`, `is_draft: true`, or `is_published: false`; explicit non-draft `status`, `draft: false`, `is_draft: false`, `is_published`, `published_at`, or `post_date` markers still block the update.

Use `npm run inspect:draft -- <draft_id>` only when you have local Substack credentials configured and need to inspect a live draft payload. Configuration loads `.env.local` first, then `.data/substack-auth.json`, then `.env`, without replacing values already present in the process. The script prints a JSON payload with the parsed `draft_body` when possible. It omits the full raw Substack response unless `--include-raw` is passed. Raw response inclusion is allowed only for stdout or an explicit `--output .data/<file>.json` private inspection file; `--fixture` captures always stay compact, non-raw, and body-only by writing the parsed `draft_body` without draft title, subtitle, audience, or raw metadata. To write one of the expected adapter fixtures directly, use `npm run inspect:draft -- <draft_id> --fixture latex-block`, replacing `latex-block` with `inline-marks`, `image`, or `code-block` as needed. Pass `--fixture-dir <project-local-dir>` when the target fixture set is outside `fixtures/substack/`.

Use `npm run create:fixture -- --dry-run` to validate the rich Markdown fixture without network calls. To create one of the exact fixture drafts expected by the adapter tests, pass `--kind inline-marks`, `--kind image`, `--kind code-block`, or `--kind latex-block`; pass `--kind all` to dry-run or create all four required fixture drafts in one command. When Substack credentials are configured, run the same command without `--dry-run` to upload a tiny test image when a fixture contains one, create `[MCP FIXTURE]` drafts, and print each matching `inspect:draft --fixture <kind>` command for fixture capture. If `--fixture-dir <project-local-dir>` is set, the printed inspect commands include the same fixture directory. To create and capture all four required fixture files in one live run, use `npm run create:fixture -- --kind all --capture`; this writes inspected body-only, non-raw fixture JSON under `fixtures/substack/`. Pass `--fixture-dir <project-local-dir>` to write capture output somewhere else, then check that same directory with `npm run fixtures:status -- --fixture-dir <project-local-dir>`. The script output includes per-fixture `provenance_review` strings, and `--kind all` also emits `gate_7_fixture_provenance_review`; copy that safe summary into the gate 7 evidence artifact after manual editor review. Dry-run provenance is intentionally rejected by `v1:record` for gate 7 because it does not prove live fixture capture.

Use `npm run fixtures:status` to see which required live fixture files are still missing, invalid, or incompatible with the current adapter output. The status check requires parseable Substack draft-body JSON, rejects reusable fixture files that include top-level draft metadata or raw response fields, requires the expected feature-specific shape for each fixture, and requires exact round-trip compatibility through `toSubstackProseMirror`; incompatible fixtures report a safe first structural difference plus node/mark summaries without printing draft text or URLs. The command also prints the exact per-fixture capture or recapture command to run next. Once all four fixtures are expected to be present, use `npm run fixtures:status -- --require-all` and `npm test -- tests/content/substackFixtureCompatibility.test.ts` as local release gates before calling V1 complete. For a non-default fixture directory, run the test with `SUBSTACK_FIXTURE_DIR=<project-local-dir>`; the compatibility test rejects values that resolve outside the project.

When running the guarded live Substack test for acceptance evidence, set `V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS` to write sanitized project-local Markdown artifacts with draft metadata, automated live-flow proof, and manual review checklists for gates 7, 8, and 9 in one live run. `npm run v1:preflight` checks configured artifact env paths before the live test runs and reports unsafe paths without printing the raw path values. Generated plural artifacts include gate-specific `v1:record` commands that point gate 7, 8, and 9 at their corresponding artifact paths; the gate 7 command also includes the fixture readiness and fixture compatibility test gates that must pass before recording rich-draft formatting evidence, and the artifact includes structured gate 7 detail fields for fixture readiness, compatibility, provenance, formatting review, unpublished status, and cleanup. If live fixture capture is staged outside `fixtures/substack/`, set `SUBSTACK_FIXTURE_DIR=<project-local-dir>` in the same shell so the generated gate 7 record command and detail fields preserve that directory. The older singular `V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACT` is still supported for one artifact path.

```bash
V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live
```

Use `npm run v1:preflight` to check local prerequisites for the remaining live/manual gates without printing secret values. It reports whether the current Node runtime and package engine contract meet the Node 20+ floor, whether the current runtime can also run the `@modelcontextprotocol/inspector@latest` CLI used by `npm run smoke:inspector`, whether required V1 helper scripts are present, whether required env names are present, whether live fixtures are ready, whether `SUBSTACK_FIXTURE_DIR` is project-local and matches the preflight fixture directory when set, whether optional `V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACT` and `V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS` paths stay project-local when set, whether `MCP_REMOTE_URL` is safe when set for remote smoke commands, whether `MCP_PATH_SECRET` is a valid single URL-safe path segment when set, whether OAuth remote metadata is configured when `AUTH_MODE=oauth`, whether `BILLING_ACCOUNT_ID` is set for the Cloud Run budget-alert follow-up, and whether local tools such as `npx`, `ngrok`, `gcloud`, and `docker` are available. When fixtures are not ready, run `npm run fixtures:status` first; it prints the per-fixture capture or recapture command, and preflight also prints the matching fixture compatibility test command. If live fixture capture is staged outside `fixtures/substack/`, pass the same `--fixture-dir <project-local-dir>` to `v1:preflight`, `v1:status`, and `v1:runbook` so gate 7 readiness and suggested commands reference that directory; if `SUBSTACK_FIXTURE_DIR` is set for the compatibility test, use the same path there. Add `--require-live` when you want the command to fail unless required live prerequisites are ready.

Use `npm run v1:status` to see all 17 V1 acceptance criteria in one report, including live fixture present, valid, and adapter-compatible counts. The command does not run tests, deploy Cloud Run, call Substack, or prove manual client acceptance. After you complete manual/live gates, keep a local ignored evidence file such as `.data/v1-acceptance-evidence.json` using `examples/v1-acceptance-evidence.example.json` as a template for all recordable manual/live gates; `v1:status` automatically reads that default file when it exists, and `--evidence-file` can still point at a custom file. `v1:record` only accepts manual/live gates 7, 8, 9, 11, 12, 13, 14, 15, and 16; repo-local gates are proved by the listed commands and validation artifacts. If live fixtures are staged outside `fixtures/substack/`, pass the same `--fixture-dir <project-local-dir>` to `v1:record` so its printed status and release-gate commands preserve that context. Notes-only records are allowed for drafting, but `v1:status` only counts a recorded gate complete when the record includes an existing scanned artifact:

```bash
npm run v1:preflight
npm run v1:preflight -- --fixture-dir fixtures/live
npm run v1:preflight -- --require-live
npm run v1:runbook -- --gate 7
npm run v1:runbook -- --gate 7 --fixture-dir fixtures/live
npm run v1:runbook -- --gate 12 --mcp-path-secret mcp-path-secret
npm run v1:runbook -- --output .data/v1/manual-acceptance-runbook.md
npm run v1:runbook -- --write-artifacts
npm run v1:runbook -- --gate 7 --write-artifacts
npm run v1:record -- --gate 11 --evidence "ChatGPT connector listed tools and completed the manual ngrok flow" --command "npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md; ChatGPT connector manual workflow during bounded tunnel window" --artifact .data/v1/gate-11-chatgpt-ngrok.md
npm run v1:record -- --gate 7 --fixture-dir fixtures/live --evidence "Live fixture-backed draft formatting passed" --command "npm run fixtures:status -- --fixture-dir fixtures/live --require-all; SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts; V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live" --artifact .data/v1/gate-07-rich-draft-live-fixtures.md
npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json
npm run v1:status -- --fixture-dir fixtures/live
npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json --require-complete
```

`v1:runbook` renders the current manual/live gate checklist with suggested commands, artifact paths, and `v1:record` examples. Add `--gate <id>` one or more times to focus the runbook and artifact templates on selected manual/live gates. Add `--write-artifacts` to create missing Markdown evidence templates at the suggested `.data/v1/` paths without overwriting existing notes.

Those templates include gate-specific evidence checklists. Gate 7 also includes explicit manual review fields for fixture readiness, fixture compatibility, fixture provenance, text formatting, image rendering, native code block rendering, native LaTeX rendering, preview behavior, unpublished status, and cleanup. The provenance field must identify how the live fixtures were captured or manually reviewed, so adapter compatibility is not treated as native editor proof by itself; `v1:record` rejects gate 7 artifacts unless the readiness field shows `fixtures:status -- --require-all`, the compatibility field shows the Substack fixture compatibility test command, the draft reference is a Substack draft URL or numeric draft ID, the title/subtitle review confirms expected values, the rich-rendering review fields affirmatively identify the reviewed feature and successful rendering without vague, failed, missing, fallback, raw, plain, or unreviewed output, the unpublished-status field explicitly confirms the created item remained unpublished without contradictory published/public/live wording, and the cleanup decision records whether the live draft was kept, deleted, or left for further review without publishing. Gate 8 includes explicit update review fields for draft reference, title transition, update command, field update result, unpublished status, post-update readback, body handling, and cleanup decision; `v1:record` rejects gate 8 artifacts whose draft reference is not a Substack draft URL or numeric draft ID, whose title fields do not show a changed draft title, whose update-command field does not identify the guarded live run or an explicit live `update_draft` MCP/client workflow, whose field-update review does not confirm a successful change, whose post-update readback does not confirm the updated draft was read back, whose draft-body handling does not confirm raw body/content stayed out of evidence, whose unpublished-status-after-update field does not explicitly confirm the updated item remained unpublished, whose status wording contradicts that with published/public/live evidence, or whose cleanup decision does not record kept/deleted/left-for-review without publishing. Gate 9 includes explicit read review fields for draft reference, list result, get result, metadata reviewed, body-inclusion decision, post-update readback, raw-content handling, and follow-up action; `v1:record` rejects gate 9 artifacts whose draft reference is not a Substack draft URL or numeric draft ID, whose list result does not confirm the expected draft was listed, whose get result does not confirm expected draft metadata was fetched, whose metadata review does not name id/title plus url or status, whose body-inclusion review does not confirm body/content stayed unrequested or metadata-only, whose post-update readback does not confirm the updated draft was read back, whose raw body/content handling field does not confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence, or whose follow-up action does not record no-action reasoning, cleanup, or a concrete follow-up after the live read review. Gate 11 includes explicit ChatGPT connector fields for connector URL, ChatGPT surface, tool-list result, manual flow result, draft or review reference, tunnel exposure window, unexpected-traffic review, and rotation decision; `v1:record` rejects gate 11 artifacts whose connector URL does not identify the public HTTPS `/mcp` endpoint or a URL-proving reference, whose ChatGPT surface field does not name ChatGPT, whose tool-list field does not confirm exactly seven V1 draft-workflow tools through the ChatGPT connector, or whose draft/reference field does not provide a non-sensitive draft URL, numeric ID, screenshot reference, or manual review reference.

Gate 12 includes explicit Cloud Run deployment fields for project/region/service, service URL check, deploy command source, health check, remote smoke, deployed auth mode, budget guard, and path-secret review; `v1:record` rejects gate 12 artifacts whose deployment details do not identify the project, region, and Cloud Run service, include a deployed HTTPS service URL, cite `cloud-run:plan` or `gcloud run deploy` provenance, confirm `/healthz` success, confirm auth-mode matching remote MCP smoke success with auth-mode evidence, name `noauth`, `static_bearer`, or `oauth`, confirm a Cloud Billing budget alert command/result or explicit budget-alert follow-up decision, and state that `MCP_PATH_SECRET` was not used or that the private path segment was verified without recording its value. Generic "remote smoke passed" wording does not satisfy gate 12, and contradictory path-secret wording that claims non-use or shell-only handling while also saying the segment value was copied, pasted, recorded, logged, stored, or exposed does not satisfy gate 12. Gate 13 includes explicit Secret Manager fields for required references, secret names, runtime service account, access bindings, version policy, literal-env review, secret-value handling, and rotation follow-up; `v1:record` rejects gate 13 artifacts whose literal-env review does not confirm secrets are Secret Manager references instead of literal environment values, whose secret-value handling does not confirm raw secret values were not opened, pasted, exposed, or recorded, or whose no-action/no-rotation follow-up says credential/token/secret/cookie exposure or unresolved unexpected traffic occurred. Gate 14 includes explicit header-capable client fields for client version, public HTTPS `/mcp` endpoint reference, header configuration method, tool-list result, validation result, bearer-rejection proof, and token-redaction review; `v1:record` rejects gate 14 artifacts whose endpoint field does not identify the public HTTPS `/mcp` endpoint or whose header configuration method does not describe an Authorization header. Gate 15 includes explicit manual client fields for Claude Code/Cursor version, Claude Code/Cursor stdio config path or add command, stdio entrypoint path, tool-list result, validation result, and local-credentials review; `v1:record` rejects gate 15 artifacts whose client-tested field does not name Claude Code or Cursor or whose config field does not identify the stdio config path or add command. Gate 16 includes the same required Cloud Run log-review checklist items enforced for generated log evidence, plus explicit fields for export window, service/revision, live traffic exercised, export command, verifier command, audit event review, finding review, raw-log handling, and follow-up action; `v1:record` rejects gate 16 artifacts whose log window, Cloud Run target, export command, verifier command, finding review, live-traffic, audit-event review, raw-log handling, or follow-up action fields do not provide the required Cloud Run log-safety provenance.

For gate 11, `v1:record` also rejects weak ChatGPT/ngrok evidence unless the manual fields confirm an actual ChatGPT surface, the public HTTPS `/mcp` connector URL, exact seven-tool ChatGPT connector listing, ChatGPT validate/preview/create draft flow, non-sensitive draft or review reference, bounded tunnel window with start/end or duration evidence, reviewed ngrok or local traffic logs with no unresolved unexpected access, and a tunnel or credential rotation decision with a reason. Wording that says the flow was not ChatGPT, only a local or remote smoke, or still pending does not satisfy gate 11; the traffic review must identify reviewed ngrok/local/server logs, not just assert that no unexpected requests occurred; no-rotation wording does not satisfy the rotation field when the reason says a credential, token, secret, cookie, or unresolved unexpected traffic was exposed.

For gate 13, `v1:record` also rejects weak Secret Manager evidence unless the manual fields confirm Secret Manager references for `SUBSTACK_SESSION_TOKEN` and `PREVIEW_TOKEN_SECRET`, list the corresponding Secret Manager resource names without values, identify the deployed runtime service account, confirm Secret Manager Secret Accessor bindings for that service account, record latest/pinned version policy with rotation notes, confirm no literal secret env values, confirm raw secret values were not opened or recorded, and record no-action reasoning or a rotation/redeploy follow-up. Negated, missing, or pending Secret Accessor binding wording does not satisfy gate 13, and contradictory secret-value handling that claims omission while also saying raw secret values were copied, pasted, recorded, logged, exposed, or placed in notes does not satisfy gate 13.

For gate 14, `v1:record` also rejects weak static-bearer evidence unless the manual fields name a real header-capable HTTP client, identify the public HTTPS `/mcp` endpoint tested through that client, describe the Authorization header setup without the token value, confirm exactly seven V1 draft-workflow tools were listed through that client, confirm `validate_newsletter_content` succeeded, prove missing and wrong bearer credentials were rejected with `401` or unauthorized responses, and confirm no bearer token or token value was included, recorded, printed, pasted, exposed, or logged. Negated, token-free, smoke-only, pending Authorization-header wording, or contradictory token-redaction wording that later says a token value was copied, pasted, recorded, logged, stored, or exposed does not satisfy gate 14.

For gate 15, `v1:record` also rejects weak Claude Code/Cursor stdio evidence unless the manual fields name a real Claude Code or Cursor client, identify the Claude Code/Cursor stdio config path or add command, identify an absolute `dist/stdio.js` entrypoint path, confirm exactly seven V1 draft-workflow tools were listed through that client, confirm `validate_newsletter_content` succeeded, and confirm Substack credentials came from local environment variables without being recorded, committed, pasted into client config, or exposed remotely. Negated, MCP-Inspector-only, smoke-only, pending Claude Code/Cursor wording, or contradictory credential-locality wording that later says credential values were pasted, copied, committed, logged, exposed, or placed in client configuration does not satisfy gate 15.

For gate 11, gate 14, gate 15, and remote OAuth launch review, weak tool-list wording that only says seven tools were listed without identifying the V1 draft-workflow surface does not satisfy the tool-list field. Contradictory tool-list wording that claims exactly seven V1 draft-workflow tools while also saying another tool count was listed, visible, returned, or shown also does not satisfy the tool-list field.

For gate 16, `v1:record` also rejects weak Cloud Run log evidence unless the manual fields identify the live log export window, Cloud Run service/revision or service URL, live Cloud Run acceptance traffic, `gcloud logging read` command with a Cloud Run resource filter, `cloud-run:logs:verify` command with `--logs-json` and `--require-audit-events`, metadata-only audit review, no-findings or sanitized finding summary, raw-log exclusion from evidence, and a rotation/redeploy/deletion or no-action decision with a reason. Local-only, dry-run, no-deployed-request, or other negated live-traffic wording does not satisfy gate 16; negated metadata-only audit wording or audit events with raw request/body/secret fields also fail; category-specific "no secret findings" wording is too narrow unless recorded as a sanitized finding summary; contradictory raw-log wording such as excluding logs but copying them into notes also fails; no-action/no-rotation decisions do not satisfy the follow-up field when the reason describes unresolved exposure or findings.

The evidence file is an operator-supplied record for review. Gate 7 still requires live Substack fixture readiness from `npm run fixtures:status -- --require-all` plus the fixture compatibility test; the runbook now starts that gate with `npm run fixtures:status` so individual missing or stale fixtures can be captured before running the all-fixtures release gate and compatibility test. Gate 12 commands define `SERVICE_URL` from the deployed Cloud Run service, reuse it for `/healthz` and remote MCP smoke checks, and guard auth-mode smoke commands on the required bearer-token env values. If the Cloud Run deployment used a private MCP path segment, pass `--mcp-path-secret <secret-name>` to `v1:runbook`; gate 12/13 commands then include the matching `cloud-run:plan` and `cloud-run:verify` flags plus shell-only `MCP_PATH_SECRET` guards for remote smoke URLs. With `--fixture-dir <project-local-dir>`, `v1:runbook` also writes gate 7 suggested commands, evidence templates, `v1:record` examples, and final `v1:status --require-complete` instructions that include the matching fixture directory. Recorded evidence alone does not satisfy missing, invalid, or adapter-incompatible fixture captures. Gate 16 requires an exported live Cloud Run log pass from `npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md`.
When using `--artifact`, pass a project-local file path that already exists. `v1:record` rejects future `verified_at` timestamps and scans evidence text, command text, and text artifacts for secret-like values, draft-body fields, unchecked checklist items, unfilled placeholders, missing gate-specific detail sections, and missing or empty gate-specific detail fields before writing the evidence JSON. Generated live Substack artifacts for gates 7/8/9 must include current automated proof from `test:live` for the relevant create, update, or read flow, gate 7/8 artifacts must explicitly confirm the created or updated item remained unpublished, and gate 9 artifacts must explicitly confirm raw draft body/content was not recorded in evidence. Generated Cloud Run verifier artifacts for gates 12/13 must show `Complete: yes`, generated auth-mode proof, passing runtime-env check IDs emitted by the current `cloud-run:plan` follow-up, and completed deployment or Secret Manager checklist items for the recorded gate. Generated gate 11 ChatGPT/ngrok artifacts must include current noauth remote-smoke proof for `/healthz`, the seven-tool surface, `validate_newsletter_content`, and `preview_draft` from `smoke:remote-noauth` or `smoke:ngrok-noauth`, and the manual ChatGPT surface field must name ChatGPT. Generated gate 14 static-bearer remote artifacts must include the current missing-token and wrong-token `401` rejection proof from `smoke:remote` or `smoke:ngrok-static-bearer`, identify the public HTTPS `/mcp` endpoint, and the manual header configuration field must describe an Authorization header. Generated gate 15 stdio client artifacts must include current local stdio smoke proof for the seven-tool surface, `validate_newsletter_content`, and `preview_draft` from `smoke:stdio`, plus the Claude Code/Cursor stdio config path or add command. Generated Cloud Run log artifacts for gate 16 must show `Complete: yes`, at least one audit event, all verifier checks passing, completed log-review checklist items, and manual details proving the log export window, Cloud Run service/revision, export command, verifier command, live traffic, metadata-only audit events, finding review, raw-log exclusion, and follow-up decision. Generated remote OAuth artifacts are not numbered `v1:record` gates, but when scanned for durable/public ChatGPT launch review they must include current OAuth smoke proof, authorization-server discovery proof with authorization-code and PKCE S256 support, a completed launch checklist, and manual OAuth launch-review fields confirming the intended authorization server, ChatGPT connector/client, browser authorization-code + PKCE login, connector registration, protected-resource metadata/CORS/challenge review, issuer/audience-or-resource/expiry/scope token validation, exact seven-tool listing, validation and preview calls, token error-path rejection, token/code/credential redaction, and a durable ChatGPT OAuth launch decision; contradictory OAuth redaction wording that claims token/code/credential omission while also saying a value was copied, pasted, recorded, logged, stored, or exposed does not satisfy the launch review. Binary artifacts are allowed for screenshots, but review them manually because the scanner cannot inspect image contents. `v1:status` rejects hand-edited evidence entries for repo-local gates, reruns the same timestamp and text safety checks for hand-edited or older evidence files, and only counts recorded evidence with an artifact while that artifact remains available as a file and passes the current scan.

Generated gate 11 artifacts must pair the current noauth smoke proof with completed ChatGPT manual fields for validate, preview, and draft creation; bounded tunnel exposure; traffic-log review; and tunnel shutdown, credential rotation, revocation, or an intentional no-rotation reason.

Generated gate 13 artifacts must pair the current Cloud Run verifier proof with completed manual fields for Secret Manager env references, secret resource names, runtime service account, Secret Accessor IAM bindings, version policy, secret-value handling, and rotation/redeploy follow-up.

Generated gate 14 artifacts must pair the current static-bearer smoke proof with completed manual fields for the real header-capable HTTP client, public HTTPS `/mcp` endpoint, exact seven-tool listing, validation success, missing/wrong bearer rejection, and bearer-token redaction review.

Generated gate 15 artifacts must pair the current local stdio smoke proof with completed manual fields for the real Claude Code/Cursor client, stdio config path or add command, absolute built stdio entrypoint path, exact seven-tool listing, validation success, and local environment credential handling.

## Quickstart

Verify both local MCP transports without credentials or Substack network calls:

```bash
npm ci
npm run test:mcp-local
```

This builds the package, starts the built HTTP and stdio entrypoints in turn, verifies the exact seven-tool draft-workflow surface, and calls `validate_newsletter_content` plus `preview_draft` with the rich Markdown fixture. It does not call Substack or run write tools.

The local credentialed sequence is:

```bash
npm run mcp:preflight
npm run mcp:preflight -- --require-live
RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live
```

`npm run mcp:preflight` reports local Substack credential readiness without requiring Cloud Run, ngrok, Cloud Billing, or release-ready fixture checks. Add `-- --require-live` for the fail-fast credential gate before opting into the guarded account test. The preflight command is verified with missing and valid-shaped local configuration; the real account test still requires your credentials and explicit opt-in. The live harness connects an MCP SDK `Client` to the registered server through the SDK in-memory transport, verifies the exact seven-tool surface (`validate_newsletter_content`, `preview_draft`, `create_draft`, `update_draft`, `list_drafts`, `get_draft`, and `upload_image`), and invokes upload, preview, create, list, get, update, and post-update get through `client.callTool`. That exercises MCP input schemas, server registration, and result wrappers in addition to the underlying Substack behavior. The harness structure and guarded skip are covered by deterministic tests; the real-account path has not been run without local credentials. Cloud Run deployment remains deferred.

To exercise MCP Inspector CLI as well, use Node 22.7.5 or newer and run:

```bash
npm run smoke:inspector
```

For an interactive local HTTP server, create the development environment file and start the server:

```bash
cp .env.example .env
npm run dev:http
```

The copied defaults are enough to connect a local client and test `validate_newsletter_content` and `preview_draft`. Configure the real Substack credential variables only when you are ready to test `list_drafts`, `get_draft`, `upload_image`, `create_draft`, or `update_draft` against your own account.

The local HTTP MCP endpoint defaults to:

```text
http://localhost:8787/mcp
```

Health check:

```bash
curl http://localhost:8787/healthz
```

The individual local HTTP checks are also available:

```bash
npm run smoke:docker-http
npm run smoke:http-local
npm run smoke:inspector
npm run smoke:http-static-bearer
npm run smoke:http-oauth
```

To run the full repo-local V1 acceptance matrix in one command, including the fixture draft dry-run, status reports, runbook render, Docker smoke, local HTTP smoke, MCP Inspector CLI smoke, local static-bearer/OAuth HTTP smokes, and stdio smoke:

```bash
npm run validate:v1-local
```

This command intentionally does not use `fixtures:status -- --require-all`, `v1:status -- --require-complete`, `npm run test:live`, ngrok, ChatGPT, Cloud Run, or remote client acceptance. Those remain manual/live V1 gates.

`npm run smoke:docker-http` builds the Docker image, starts the HTTP MCP server in a local container, waits for `/healthz`, lists tools over Streamable HTTP, verifies the exact V1 draft-workflow tool surface, and calls `validate_newsletter_content` plus `preview_draft` with the rich fixture. It uses safe container env defaults and does not call Substack or run write tools.

`npm run smoke:http-local` launches `node dist/http.js` on a temporary localhost port, waits for `/healthz`, lists tools over Streamable HTTP, verifies the exact V1 draft-workflow tool surface, and calls `validate_newsletter_content` plus `preview_draft` with `fixtures/markdown/full-rich-draft.md`. It uses safe local smoke-test env defaults and does not call Substack or run write tools.

`npm run smoke:inspector` runs the same local HTTP smoke with MCP Inspector CLI `tools/list` enabled against the same endpoint. The server runtime floor remains Node 20+, but the current `@modelcontextprotocol/inspector@latest` package requires Node 22.7.5 or newer for this helper. Add `--evidence-artifact .data/v1/gate-03-mcp-inspector.md` to write a sanitized Markdown artifact for gate 3.

`npm run smoke:http-static-bearer` launches the same built HTTP entrypoint in `AUTH_MODE=static_bearer`, verifies missing and wrong bearer tokens return `401` with a bearer challenge, then lists tools and calls `validate_newsletter_content` plus `preview_draft` with the correct local smoke token. It does not call Substack or run write tools.

`npm run smoke:http-oauth` launches the built HTTP entrypoint in `AUTH_MODE=oauth`, starts a local HTTPS authorization server with discovery metadata plus a JWKS endpoint backed by a throwaway signing key, verifies protected-resource metadata, authorization-server discovery, and missing bearer-token challenges, then lists tools and calls `validate_newsletter_content` plus `preview_draft` with a signed JWT. It disables TLS verification only around the generated self-signed local authorization server/JWKS calls used by the smoke test; it does not call Substack or run write tools.

## MCP Inspector

Run the local HTTP server:

```bash
npm run dev:http
```

In another shell:

```bash
npx @modelcontextprotocol/inspector@latest --server-url http://localhost:8787/mcp --transport http
```

The inspector should list `list_drafts`, `get_draft`, `validate_newsletter_content`, `preview_draft`, `create_draft`, `update_draft`, and `upload_image`.

For non-interactive V1 gate evidence, run the local smoke artifact helper with Inspector CLI enabled:

```bash
npm run build
npm run smoke:inspector -- --evidence-artifact .data/v1/gate-03-mcp-inspector.md
```

## Substack Credentials

Use credentials only for your own Substack account/publication. Run:

```bash
npm run auth:setup
```

This opens a temporary page bound to `127.0.0.1`. On macOS, enter the publication URL and select **Use current Chrome session**. After that explicit action, setup copies the cookie store from Chrome's most recently used profile into a temporary owner-only directory, launches headless Chrome with network access disabled, waits for the encrypted cookie store to load, removes every cookie outside `substack.com` and the requested publication domain, and re-enables network access. It then reads `SUBSTACK_USER_ID` from the authenticated publication dashboard, validates administrative access through Substack's publication API, removes the temporary profile, generates `PREVIEW_TOKEN_SECRET`, and saves the four runtime values in `.data/substack-auth.json`. It does not copy Chrome history or password databases. The auth file is ignored by git and written with owner-only permissions. It is loaded after `.env.local` and before `.env`; explicit process or `.env.local` values retain precedence.

The current-session flow requires Google Chrome on macOS and may trigger a macOS Keychain confirmation so the temporary Chrome process can decrypt its local cookie-store copy. It never modifies the normal Chrome profile. If the most recently used Chrome profile is not the one signed in to Substack, expand **Sign in with a temporary Chrome window**. Manual cookie entry remains the final fallback and does not require browser developer tools beyond locating the cookie.

The four runtime values are:

- `SUBSTACK_PUBLICATION_URL`: public `https://` publication origin, preferably the canonical `https://<publication>.substack.com` origin. Copied Substack post/editor paths, queries, and fragments are normalized to the origin.
- `SUBSTACK_SESSION_TOKEN`: the relevant browser session cookie value for your own account. The saved auth file and environment variable contain only the value.
- `SUBSTACK_USER_ID`: positive numeric Substack user id derived by the setup flow.
- `PREVIEW_TOKEN_SECRET`: locally generated HMAC key for write-confirmation tokens.

The manual fallback accepts a bare cookie value, `connect.sid=...`, `substack.sid=...`, or a copied `Cookie:` header and extracts only the session value locally. Because it does not load an authenticated dashboard, it also requires the numeric Substack user ID:

1. Sign in to Substack in a browser and open the publication dashboard, preferably at the canonical `https://<publication>.substack.com/publish/home` origin.
2. Open browser developer tools, then Application or Storage, then Cookies for that publication origin. Copy the `connect.sid` or `substack.sid` row or value.
3. Expand the manual option on the loopback setup page, paste the cookie, and enter the numeric user ID. Do not put the cookie in a command-line argument, MCP tool call, chat, log, or evidence artifact.

With either browser option, you do not need to inspect the Network tab for a user ID; setup reads it from the authenticated dashboard.

The Substack setup flow is separate from `AUTH_MODE=oauth`. MCP OAuth authenticates an MCP client to this server; it does not authenticate this server to Substack. The setup flow remains single-account, process-wide configuration and is intentionally not exposed as an MCP tool.

For manual or automated environments, the same values can still be supplied through process environment variables or `.env.local`. Keep these out of git. Cloud Run configuration remains deferred for the current local-testing target.

After setting local credentials, run `npm run mcp:preflight`; use `npm run mcp:preflight -- --require-live` when missing or invalid live prerequisites must fail fast. This verified local check deliberately excludes Cloud Run, ngrok, Cloud Billing, and release-ready fixture requirements. The guarded account test is `RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live`; it uses an MCP SDK Client over in-memory transport to exercise the registered server. It must only create and update an unpublished draft, and the printed draft ID/URL still requires manual review and cleanup in Substack. Cloud Run remains deferred for the current local-testing target.

## Local MCP Clients

Build first:

```bash
npm run build
npm run smoke:stdio
npm run smoke:stdio -- --evidence-artifact .data/v1/gate-15-stdio-client.md
```

Generic stdio config is in `examples/mcp.local.stdio.json`. Replace the repository path in its shell command. The command changes into this checkout so the server can read the ignored `.data/substack-auth.json` file without copying Substack secrets into the MCP client configuration.

Step-by-step Claude Desktop and Claude Code instructions are in the [client setup guide](docs/CLIENT_SETUP.md#connect-a-local-stdio-client).

`npm run smoke:stdio` launches `node dist/stdio.js`, lists tools over MCP stdio, verifies the exact V1 draft-workflow tool surface, and calls `validate_newsletter_content` plus `preview_draft` with the rich fixture. It uses safe local smoke-test env defaults and does not call Substack or run write tools. Add `--evidence-artifact .data/v1/gate-15-stdio-client.md` to write a sanitized Markdown artifact with current local stdio smoke proof, the remaining Claude Code/Cursor manual checklist, and structured fields for the tested client version, Claude Code/Cursor stdio config path or add command, stdio entrypoint path, tool-list result, validation result, and local-credentials review.

Remote HTTP config with static bearer auth is in `examples/mcp.remote.http.json`.

Claude Code setup examples are in `examples/claude-code.md`. The local stdio example changes into this checkout and reads the ignored local auth file; it does not persist Substack credentials in Claude Code configuration. The remote HTTP examples keep Substack credentials on the server and use either a client bearer header for `AUTH_MODE=static_bearer` or an OAuth login flow for `AUTH_MODE=oauth`.

Cursor examples are split by transport:

- `examples/cursor.local.stdio.json` for a local stdio `.cursor/mcp.json`.
- `examples/cursor.remote.http.json` for a remote HTTP `.cursor/mcp.json`.

The real `.cursor/mcp.json` file is ignored by git because it can contain machine-local paths or environment wiring. The built stdio entrypoint is locally smoke-tested; real Claude Code/Cursor acceptance is still a manual V1 gate.

To smoke-test a remote HTTP endpoint that uses `AUTH_MODE=static_bearer`, keep the bearer token in the environment, prove missing/wrong bearer tokens are rejected, list tools, and call the read-only validation and preview tools:

```bash
: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the remote static bearer token first}" && \
  MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url https://<host>/mcp
: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the remote static bearer token first}" && \
  MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url https://<host>/mcp --evidence-artifact .data/v1/gate-14-static-bearer-remote.md
```

Remote smoke URLs must use HTTPS, must use `/mcp` or `/mcp/<secret>`, and must not include embedded usernames/passwords. Keep authentication in the documented environment variables, not in the URL.

The smoke test checks `/healthz` on the same origin, verifies that missing and wrong bearer-token requests return `401` with a Bearer challenge, verifies that the server exposes exactly the V1 draft-workflow tools, and can call `validate_newsletter_content` plus `preview_draft` with the rich fixture. It does not call Substack and does not run write tools. Add `--evidence-artifact .data/v1/gate-14-static-bearer-remote.md` to write a sanitized Markdown artifact with the remote smoke result, the remaining header-capable client checklist, and structured fields for the tested client version, public HTTPS `/mcp` endpoint reference, header configuration method, tool-list result, validation result, bearer-rejection proof, and token-redaction review.

For short-lived static-bearer tunnel testing, build and run the combined local HTTP/ngrok/static-bearer smoke:

```bash
npm run build
npm run smoke:ngrok-static-bearer
npm run smoke:ngrok-static-bearer -- --evidence-artifact .data/v1/gate-14-static-bearer-remote.md
: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to a local test token first}"
npm run smoke:ngrok-static-bearer -- --bearer-token-env MCP_BEARER_TOKEN --hold-open-seconds 900 --evidence-artifact .data/v1/gate-14-static-bearer-remote.md
```

The command uses a fake local bearer token by default, launches `node dist/http.js` in `AUTH_MODE=static_bearer`, starts `ngrok http 8787`, discovers the HTTPS forwarding URL from the local ngrok API, verifies remote missing and wrong bearer tokens are rejected, checks remote `/healthz`, lists the exact V1 draft-workflow tools, and calls the read-only validation and preview tools with the rich fixture. It does not call Substack or run write tools. To use a real header-capable client, keep a test token in the environment, pass its variable name through `--bearer-token-env`, and add `--hold-open-seconds <0-3600>`. The command prints the live endpoint before waiting, never prints the token value, and shuts the server and tunnel down when the bounded window ends or you press Ctrl-C.

To smoke-test a remote HTTP endpoint that uses `AUTH_MODE=oauth`, first complete the OAuth login or token acquisition flow outside this script, keep the access token value in an environment variable, then verify metadata, tools, and read-only validation. Store only the token value, not an `Authorization:` header or `Bearer ...` prefix:

```bash
: "${MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first}" && \
  MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth -- --url https://<host>/mcp --evidence-artifact .data/v1/remote-oauth.md
```

The OAuth remote smoke checks `/healthz` on the same origin, fetches `/.well-known/oauth-protected-resource` from the MCP origin, checks metadata CORS/preflight headers, checks the resource, required V1 scopes, and HTTPS authorization-server URLs without embedded usernames/passwords, fetches OAuth authorization-server metadata or OIDC discovery from the advertised issuer, verifies authorization-code, code-response, JWKS, and PKCE S256 support, sends the access token as a bearer token, lists the exact V1 draft-workflow tools, and calls `validate_newsletter_content` plus `preview_draft` with the rich fixture. It does not call Substack and does not run write tools. Add `--evidence-artifact .data/v1/remote-oauth.md` to write a sanitized Markdown artifact with the remote smoke result, the remaining real-login/ChatGPT OAuth checklist, and structured fields for the authorization server, OAuth client, browser authorization-code login, connector registration, protected-resource metadata, token validation, tool-list, validation, preview, error-path checks, token-redaction review, and launch decision. This artifact supports durable/public ChatGPT launch review; it is not a numbered `v1:record` gate artifact. If you treat it as launch evidence, the scanner rejects stale or incomplete artifacts that lack current OAuth smoke proof, authorization-server discovery proof, completed launch checklist items, or filled manual OAuth review fields.

For short-lived public-origin OAuth smoke testing without a real authorization server, build and run the combined local HTTP/ngrok/OAuth smoke:

```bash
npm run build
npm run smoke:ngrok-oauth
npm run smoke:ngrok-oauth -- --evidence-artifact .data/v1/remote-oauth.md
```

The command starts ngrok, serves local HTTPS authorization-server discovery and JWKS metadata with a throwaway key, launches `node dist/http.js` in `AUTH_MODE=oauth` with the ngrok origin as `MCP_PUBLIC_BASE_URL`, signs a JWT for that public resource, checks remote `/healthz`, verifies OAuth protected-resource metadata, authorization-server discovery, and metadata CORS/preflight behavior from the public origin, lists the exact V1 draft-workflow tools, and calls the read-only validation and preview tools with the rich fixture. It does not call Substack, run write tools, or complete a browser authorization-code flow; real ChatGPT OAuth acceptance still requires an intended authorization server and connector login. When `--evidence-artifact .data/v1/remote-oauth.md` is supplied, fill the manual launch-review section after that real login flow rather than treating the generated JWT smoke as launch proof; the launch checklist must be fully checked before the artifact can pass the evidence scanner.

## Remote MCP Clients with ngrok

ChatGPT and Claude remote connectors need a public HTTPS endpoint. An ngrok account includes an automatically assigned Dev Domain that stays the same across tunnel restarts, so the connector URL does not need to change every time.

1. Create an account at [ngrok](https://dashboard.ngrok.com/signup) and install the ngrok agent.
2. Copy the authtoken from the ngrok dashboard and add it once:

   ```bash
   ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
   ```

3. Find the assigned `*.ngrok-free.dev` hostname in **Domains** in the ngrok dashboard.
4. Start the built MCP server in one terminal:

   ```bash
   npm run build
   npm run mcp:preflight -- --require-live
   AUTH_MODE=noauth HOST=127.0.0.1 PORT=8787 npm run start:http
   ```

5. Start the tunnel with that exact hostname in another terminal:

   ```bash
   ngrok http --url YOUR_ASSIGNED_DOMAIN.ngrok-free.dev 8787
   ```

6. Verify the public endpoint before adding it to a client:

   ```bash
   npm run smoke:remote-noauth -- \
     --url https://YOUR_ASSIGNED_DOMAIN.ngrok-free.dev/mcp
   ```

Register `https://YOUR_ASSIGNED_DOMAIN.ngrok-free.dev/mcp` in the remote MCP client. The hostname is stable, but the endpoint is online only while both the local server and ngrok process are running.

### ChatGPT

Enable developer mode, create a custom plugin in **Settings > Plugins**, and use the stable HTTPS `/mcp` URL with no authentication for this short-lived local flow. Availability and workspace controls vary by plan. See the complete [ChatGPT tutorial](docs/CLIENT_SETUP.md#chatgpt-remote) and [OpenAI's current setup guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

### Claude

Add the same HTTPS `/mcp` URL as a custom connector, then enable it for the conversation. Organization-managed plans may require an owner to add the connector first. Claude Desktop and Claude Code can also run the local stdio transport without ngrok. See the [Claude tutorials](docs/CLIENT_SETUP.md#claude-remote) and [Anthropic's remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

`AUTH_MODE=noauth` is for short-lived personal testing only. Anyone who discovers the live endpoint can call it while the tunnel is running. Keep the URL private, stop both processes after testing, review ngrok traffic, and rotate `SUBSTACK_SESSION_TOKEN` if the URL was shared or unexpected traffic appears. Use `AUTH_MODE=oauth` for a durable public deployment, or `AUTH_MODE=static_bearer` for private clients that can set an `Authorization` header.

The automated bounded-window alternative remains available:

```bash
npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900
```

That helper uses a temporary ngrok URL unless you supply ngrok domain arguments. The full guide covers stable-domain startup, client refresh behavior, local Claude configuration, and troubleshooting.

## Cloud Run

The included `Dockerfile` runs the HTTP server with `node dist/http.js` and listens on Cloud Run's `PORT`.

Before deploying, Docker users can verify the container entrypoint locally:

```bash
npm run smoke:docker-http
```

The smoke builds `substack-mcp:smoke`, runs it with safe fake/non-secret configuration on a temporary localhost port, checks `/healthz`, lists tools at `/mcp`, calls `validate_newsletter_content` plus `preview_draft` with the rich fixture, and stops the container. It does not read `.env` files, call Substack, or run write tools.

Generate a no-secret deployment command plan:

```bash
npm run cloud-run:plan -- \
  --project-id your-gcp-project-id \
  --publication-url https://yourpublication.substack.com \
  --user-id 123456 \
  --auth-mode static_bearer
```

To deploy a private MCP path segment at `/mcp/<secret>`, add `--mcp-path-secret mcp-path-secret`. The generated plan creates the `MCP_PATH_SECRET` value from the shell, injects it through Secret Manager, passes the same secret name to `cloud-run:verify`, and runs remote smoke commands against `"$SERVICE_URL/mcp/$MCP_PATH_SECRET"` without printing the path segment.

For OAuth deployments, include the public Cloud Run/custom-domain origin and OAuth issuer/JWKS URLs:

```bash
npm run cloud-run:plan -- \
  --project-id your-gcp-project-id \
  --publication-url https://yourpublication.substack.com \
  --user-id 123456 \
  --auth-mode oauth \
  --public-base-url https://your-mcp.example.com \
  --oauth-authorization-server-url https://auth.example.com \
  --oauth-jwks-url https://auth.example.com/.well-known/jwks.json \
  --oauth-jwt-algorithms RS256,ES256
```

The planner does not run `gcloud`, create resources, deploy, or read secret values. It prints commands for enabling APIs, creating the service account, creating Secret Manager placeholders, optional `MCP_PATH_SECRET` Secret Manager wiring, granting secret access, deploying from source, exporting and verifying the deployed service JSON, writing gate 12/13 evidence artifacts, checking the deployed `/healthz` endpoint, creating a project-scoped $5/month Cloud Billing budget alert with 50%, 90%, and 100% thresholds, running the correct remote smoke for the selected auth mode, and exporting/verifying Cloud Run logs for gate 16 after live acceptance traffic.

After deployment, export the service description and verify the deployed configuration without exposing secret values:

```bash
SERVICE_URL=$(gcloud run services describe substack-draft-mcp \
  --region us-central1 \
  --format='value(status.url)')

mkdir -p .data && gcloud run services describe substack-draft-mcp \
  --region us-central1 \
  --format=json > .data/cloud-run-service.json

npm run cloud-run:verify -- \
  --service-json .data/cloud-run-service.json \
  --auth-mode static_bearer \
  --service-account-email substack-mcp-sa@your-gcp-project-id.iam.gserviceaccount.com \
  --evidence-artifact .data/v1/gate-12-cloud-run-deployment.md

curl --fail --show-error "$SERVICE_URL/healthz"

: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first}" && \
  MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- \
  --url "$SERVICE_URL/mcp" \
  --evidence-artifact .data/v1/gate-14-static-bearer-remote.md
```

If the service was deployed with `--mcp-path-secret`, pass the same secret name to verification and keep the path segment in the shell for remote smoke:

```bash
npm run cloud-run:verify -- \
  --service-json .data/cloud-run-service.json \
  --auth-mode static_bearer \
  --service-account-email substack-mcp-sa@your-gcp-project-id.iam.gserviceaccount.com \
  --mcp-path-secret mcp-path-secret

: "${MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first}" && \
  : "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first}" && \
  MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- \
  --url "$SERVICE_URL/mcp/$MCP_PATH_SECRET" \
  --evidence-artifact .data/v1/gate-14-static-bearer-remote.md
```

The verifier does not run `gcloud`, call Cloud Run, read Secret Manager values, or prove live reachability. It checks the exported JSON for the HTTPS service URL, `min-instances=0`, `max-instances=1`, service account, production HTTP runtime env, exact non-secret runtime values when provided with `--publication-url`, `--user-id`, `--max-body-bytes`, `--max-image-bytes`, `--substack-request-timeout-ms`, and `--confirmation-token-ttl-seconds`, OAuth `MCP_PUBLIC_BASE_URL`, authorization-server URL, JWKS URL, optional documentation URL, and JWT algorithm configuration when `AUTH_MODE=oauth`, and Secret Manager-backed `SUBSTACK_SESSION_TOKEN`, `PREVIEW_TOKEN_SECRET`, optional `MCP_PATH_SECRET` when `--mcp-path-secret` is provided, and, for `AUTH_MODE=static_bearer`, `MCP_BEARER_TOKEN`. The generated `cloud-run:plan` follow-up passes the planned values to `cloud-run:verify`. When `--mcp-path-secret` is not provided, it verifies `MCP_PATH_SECRET` is absent from the deployment. Use the `SERVICE_URL` follow-ups to prove the deployed `/healthz` endpoint and auth-mode matching remote MCP smoke before recording gate 12. Add `--evidence-artifact .data/v1/gate-12-cloud-run-deployment.md` or `--evidence-artifact .data/v1/gate-13-cloud-run-secrets.md` to write a sanitized Markdown artifact with the verification result and the remaining Cloud Run manual checklist for gates 12 and 13.

The generated budget-alert follow-up requires `BILLING_ACCOUNT_ID` in the shell and creates a monthly `5USD` budget scoped to `projects/<project-id>`. This is an operator command helper, not a server runtime secret:

```bash
BILLING_ACCOUNT_ID=<billing-account-id> gcloud billing budgets create \
  --billing-account "$BILLING_ACCOUNT_ID" \
  --display-name "substack-draft-mcp monthly budget" \
  --budget-amount 5USD \
  --calendar-period month \
  --filter-projects projects/your-gcp-project-id \
  --threshold-rule percent=0.50 \
  --threshold-rule percent=0.90 \
  --threshold-rule percent=1.00
```

After live Cloud Run acceptance traffic, export recent logs and scan them before recording gate 16 evidence:

```bash
mkdir -p .data && gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="substack-draft-mcp"' --format=json --limit=100 > .data/cloud-run-logs.json
npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md
```

The log verifier reads exported JSON or newline-delimited JSON only. It does not call Cloud Run, read Secret Manager values, or print log entry contents. It fails if it sees cookie/bearer/secret-env patterns, private `/mcp/<secret>` path segments, sensitive auth field names, draft body/content fields, or `mcp_audit` objects with fields outside the allowed safe metadata set. Add `--evidence-artifact .data/v1/gate-16-cloud-run-logs.md` to write a sanitized Markdown artifact that summarizes counts, checks, finding categories, and structured manual log-review fields without raw log entries.

The default Secret Manager secret names are:

- `substack-session-token`
- `mcp-preview-token-secret`
- `mcp-bearer-token` when using `AUTH_MODE=static_bearer`
- `mcp-path-secret` when `--mcp-path-secret mcp-path-secret` is used

The generated deploy command follows this shape:

```bash
gcloud run deploy substack-draft-mcp \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60 \
  --set-env-vars="NODE_ENV=production,PORT=8080,LOG_LEVEL=info,MCP_TRANSPORT=http,SUBSTACK_PUBLICATION_URL=https://yourpublication.substack.com,SUBSTACK_USER_ID=123456,AUTH_MODE=static_bearer,MAX_BODY_BYTES=750000,MAX_IMAGE_BYTES=8000000,SUBSTACK_REQUEST_TIMEOUT_MS=30000,CONFIRMATION_TOKEN_TTL_SECONDS=900" \
  --set-secrets="SUBSTACK_SESSION_TOKEN=substack-session-token:latest,PREVIEW_TOKEN_SECRET=mcp-preview-token-secret:latest,MCP_BEARER_TOKEN=mcp-bearer-token:latest"
```

With `--mcp-path-secret mcp-path-secret`, the generated deploy command also adds `MCP_PATH_SECRET=mcp-path-secret:latest` to `--set-secrets`; do not put the path segment in `--set-env-vars`, docs, logs, or evidence.

Use `AUTH_MODE=noauth` on Cloud Run only for short-lived personal experiments. Durable ChatGPT use should use `AUTH_MODE=oauth` with a real OAuth/OIDC issuer and JWKS endpoint.

## Environment

Run `npm run auth:setup` for local Substack authentication. Copy `.env.example` to `.env` only when you need to customize other settings or provide variables manually. Keep `.env`, `.env.local`, and `.data/substack-auth.json` private.

Important variables:

- `PORT`: HTTP port, default `8787`.
- `HOST`: HTTP bind host. Defaults to `127.0.0.1` outside production and `0.0.0.0` when `NODE_ENV=production`.
- `MCP_TRANSPORT`: must match the entrypoint: `http` for `dev:http` / `start:http`, `stdio` for `dev:stdio` / `start:stdio`.
- `MCP_PATH_SECRET`: optional single URL-safe path segment that moves the HTTP MCP endpoint from `/mcp` to `/mcp/<secret>`. Slashes, spaces, `.`, and `..` are rejected. Request and startup logs redact the configured secret segment as `/mcp/<redacted>`.
- `AUTH_MODE`: `noauth` for local testing, `static_bearer` for clients that can send a bearer token, or `oauth` for JWT bearer-token verification.
- `MCP_BEARER_TOKEN`: required when `AUTH_MODE=static_bearer`. Store the token value only, not an `Authorization:` header or `Bearer ...` prefix.
- `MCP_PUBLIC_BASE_URL`: required when `AUTH_MODE=oauth`; public HTTPS origin of this MCP server. Embedded URL usernames/passwords are rejected.
- `OAUTH_AUTHORIZATION_SERVER_URL`: required when `AUTH_MODE=oauth`; issuer URL that publishes OAuth or OIDC discovery metadata. Embedded URL usernames/passwords are rejected.
- `OAUTH_JWKS_URL`: required when `AUTH_MODE=oauth`; JWKS endpoint used to verify JWT access-token signatures. Embedded URL usernames/passwords are rejected.
- `OAUTH_JWT_ALGORITHMS`: optional comma-separated asymmetric JWT signing algorithms; defaults to `RS256,ES256`. Symmetric `HS*` algorithms and `none` are rejected.
- `OAUTH_RESOURCE_DOCUMENTATION_URL`: optional documentation URL included in OAuth protected-resource metadata. Embedded URL usernames/passwords are rejected.
- `MAX_BODY_BYTES`: max accepted body size for Markdown text, serialized `blocks_v1` input, and requested `get_draft` body output.
- `MAX_IMAGE_BYTES`: max accepted downloaded/decoded source size and final normalized PNG size before upload.
- `SUBSTACK_REQUEST_TIMEOUT_MS`: positive timeout in milliseconds for outbound Substack API requests, including response body reads, and remote image fetches. Defaults to `30000`.
- `PREVIEW_TOKEN_SECRET`: HMAC secret for confirmation tokens. `auth:setup` generates it locally. Production startup rejects the built-in development default.
- `CONFIRMATION_TOKEN_TTL_SECONDS`: positive confirmation token lifetime in seconds.
- `SUBSTACK_PUBLICATION_URL`: public `https://` publication origin used by the Substack API client and inspection script. Copied Substack post/editor paths, queries, and fragments are normalized to the origin.
- `SUBSTACK_SESSION_TOKEN`: private Substack session cookie value only, not a full `Cookie:` header or `connect.sid=...` pair.
- `SUBSTACK_USER_ID`: positive numeric user id for draft bylines. Browser-based `auth:setup` derives it from the authenticated publication dashboard; manual setup requires it as an explicit field.
- `SUBSTACK_USER_AGENT`: optional browser-like user agent for Substack requests.

The validation and preview MCP tools do not call Substack. `list_drafts`, `get_draft`, `create_draft`, `update_draft`, `upload_image`, the inspection script, and the reusable API client do. `AUTH_MODE=oauth` exposes `/.well-known/oauth-protected-resource`, verifies JWT access tokens through JWKS, checks issuer/audience/expiry/scopes, and returns OAuth bearer challenges when authentication or tool scope checks fail.

## Commands

```bash
npm run dev:http
MCP_TRANSPORT=stdio npm run dev:stdio
npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json
npm run cloud-run:plan -- --project-id <id> --publication-url <url> --user-id <id>
npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --evidence-artifact .data/v1/gate-12-cloud-run-deployment.md
npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode <mode> --publication-url <url> --user-id <id> --max-body-bytes 750000 --max-image-bytes 8000000 --substack-request-timeout-ms 30000 --confirmation-token-ttl-seconds 900 --evidence-artifact .data/v1/gate-13-cloud-run-secrets.md
npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode oauth --public-base-url <https://service-origin> --oauth-authorization-server-url <https://auth-origin> --oauth-jwks-url <https://auth-origin/jwks.json> --oauth-jwt-algorithms RS256,ES256 --evidence-artifact .data/v1/gate-12-cloud-run-deployment.md
npm run create:fixture -- --dry-run
npm run create:fixture -- --kind all --dry-run
npm run create:fixture -- --kind all --capture
npm run create:fixture -- --kind all --capture --fixture-dir fixtures/substack
npm run fixtures:status
npm run inspect:draft -- <draft_id>
npm run inspect:draft -- <draft_id> --include-raw --output .data/inspect-draft.json
npm run inspect:draft -- <draft_id> --fixture image --fixture-dir fixtures/substack
npm run smoke:docker-http
npm run smoke:http-local
npm run smoke:inspector
npm run smoke:http-oauth
npm run smoke:http-static-bearer
npm run smoke:stdio
: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the remote static bearer token first}" && MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url https://<host>/mcp --evidence-artifact .data/v1/gate-14-static-bearer-remote.md
npm run smoke:ngrok-noauth
npm run smoke:ngrok-oauth
npm run smoke:ngrok-static-bearer
npm run smoke:remote-noauth -- --url https://<host>/mcp
: "${MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first}" && MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth -- --url https://<host>/mcp
npm run v1:preflight
npm run v1:preflight -- --json
npm run v1:preflight -- --fixture-dir fixtures/live
npm run v1:record -- --gate <id> --evidence <text>
npm run v1:record -- --gate <id> --fixture-dir fixtures/live --evidence <text>
npm run v1:runbook
npm run v1:runbook -- --gate 7
npm run v1:runbook -- --gate 7 --fixture-dir fixtures/live
npm run v1:runbook -- --gate 12 --mcp-path-secret mcp-path-secret
npm run v1:runbook -- --output .data/v1/manual-acceptance-runbook.md
npm run v1:runbook -- --write-artifacts
npm run v1:status
npm run v1:status -- --fixture-dir fixtures/live
npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json
npm run validate:v1-local
npm run start:http
MCP_TRANSPORT=stdio npm run start:stdio
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:watch
npm run mcp:preflight
npm run mcp:preflight -- --require-live
RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live
npm run build
npm run coverage
```

The two `mcp:preflight` entries above are the verified focused local credential check. They do not replace the broader `v1:preflight` acceptance workflow. `npm run test:live` is guarded. Without `RUN_LIVE_SUBSTACK_TESTS=1`, the live suite is skipped; when enabled, it requires valid credentials from `.env.local`, `.data/substack-auth.json`, `.env`, or the current shell. The harness connects an MCP SDK `Client` to the registered MCP server through the SDK in-memory transport, calls `client.listTools()` and requires exactly `validate_newsletter_content`, `preview_draft`, `create_draft`, `update_draft`, `list_drafts`, `get_draft`, and `upload_image`, then invokes upload, preview, create, list, get, update, and post-update get through `client.callTool`. This covers MCP schemas, tool registration, and MCP result wrappers as well as real Substack behavior. It uploads a tiny image, creates an `[MCP TEST]` rich draft, keeps it unpublished, reads and updates that same draft without removing its rich content, and prints its ID/URL for manual Substack review and cleanup. Deterministic tests verify the MCP-boundary structure, shared local-auth loading, rich-content preservation, and guarded skip; the credentialed account flow remains unrun until local credentials are supplied. HTTP and stdio process transports are covered separately by `npm run test:mcp-local`. Cloud Run remains deferred.

## Project Layout

- `src/` contains TypeScript source.
- `tests/` contains Vitest tests.
- `fixtures/` contains deterministic Markdown fixtures.
- `fixtures/substack/` is reserved for live draft-body fixtures from non-sensitive Substack test drafts.
- `docs/` contains the client setup and stable-endpoint guide.
- `examples/` contains MCP client configuration templates.
- `AGENTS.md` contains shared coding-agent instructions.

## Secret Rotation

Rotate secrets after any ngrok exposure, unexpected traffic, shared tunnel URL, remote-client exposure, or suspected local credential leak.

- Rotate `SUBSTACK_SESSION_TOKEN` by invalidating or logging out of the browser session when possible, then copying a fresh `connect.sid` or `substack.sid` cookie value from a new browser session.
- Rotate `PREVIEW_TOKEN_SECRET` with `openssl rand -base64 32`; this invalidates outstanding preview confirmation tokens immediately.
- Rotate `MCP_BEARER_TOKEN` with `openssl rand -base64 32`, update any private remote MCP client that sends the bearer header, and remove the old value.
- For Cloud Run, add new Secret Manager versions and redeploy or restart the service so the latest versions are loaded.

See `SECURITY.md` for the auth boundary and `scripts/rotateLocalSecrets.md` for the step-by-step local rotation runbook.

## Troubleshooting

- ChatGPT shows no tools: check that the URL ends in `/mcp`, the server is running, the ngrok tunnel is active, the client sends `Accept: application/json, text/event-stream`, CORS preflight allows `authorization` and `mcp-protocol-version`, and auth failures expose `WWW-Authenticate`.
- Substack returns 401 or 403: refresh `SUBSTACK_SESSION_TOKEN`, prefer the canonical `*.substack.com` publication origin, and keep the browser-like `SUBSTACK_USER_AGENT`.
- Draft formatting is wrong: capture a live draft with `npm run inspect:draft -- <draft_id>` and update the adapter fixture tests.
- Image upload fails: inspect the returned error `code` and `stage`; then check source validity, `MAX_IMAGE_BYTES`, `SUBSTACK_REQUEST_TIMEOUT_MS`, remote public URL/DNS reachability, SVG safety restrictions, and Substack auth.

## ScaffoldGuard

When available locally, run:

```bash
scaffold-guard check
scaffold-guard inspect-diff
scaffold-guard validate
```

## Contributing

Contributions are welcome through fork-based pull requests. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before starting, and use the issue forms for
bugs and feature proposals. Security vulnerabilities must be reported privately
as described in [SECURITY.md](SECURITY.md).

Project decisions and merge authority are documented in
[GOVERNANCE.md](GOVERNANCE.md). All participants must follow the
[Code of Conduct](CODE_OF_CONDUCT.md). The project is licensed under
[Apache License 2.0](LICENSE).
