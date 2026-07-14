# Claude Code MCP Examples

Build and smoke-test the stdio entrypoint before adding the local server:

```bash
npm run build
npm run smoke:stdio
```

Local stdio keeps Substack credentials on your machine:

```bash
claude mcp add --transport stdio substack-drafts \
  --env SUBSTACK_PUBLICATION_URL="https://yourpublication.substack.com" \
  --env SUBSTACK_SESSION_TOKEN="$SUBSTACK_SESSION_TOKEN" \
  --env SUBSTACK_USER_ID="$SUBSTACK_USER_ID" \
  --env PREVIEW_TOKEN_SECRET="$PREVIEW_TOKEN_SECRET" \
  --env AUTH_MODE="noauth" \
  -- node /absolute/path/to/substack-mcp/dist/stdio.js
```

Remote HTTP with static bearer auth keeps Substack credentials on the server and sends only the MCP bearer token to the MCP endpoint:

```bash
claude mcp add --transport http substack-drafts https://your-cloud-run-url/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Remote HTTP with OAuth uses the MCP server's OAuth protected-resource metadata and a client login flow:

```bash
claude mcp add --transport http substack-drafts https://your-cloud-run-url/mcp
claude mcp login substack-drafts
```
