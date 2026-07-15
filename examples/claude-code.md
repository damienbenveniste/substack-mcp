# Claude Code MCP Examples

Build and smoke-test the stdio entrypoint before adding the local server:

```bash
npm run build
npm run smoke:stdio
```

Local stdio keeps Substack credentials in the ignored `.data/substack-auth.json`
file created by `npm run auth:setup`. Run this command from any directory after
replacing the repository path:

```bash
claude mcp add --transport stdio \
  --env MCP_TRANSPORT="stdio" \
  --env AUTH_MODE="noauth" \
  substack-drafts \
  -- /bin/sh -c "cd '/absolute/path/to/substack-mcp' && exec node dist/stdio.js"
```

Remote HTTP with static bearer auth keeps Substack credentials on the server and sends only the MCP bearer token to the MCP endpoint:

```bash
claude mcp add --transport http substack-drafts https://your-mcp-host/mcp \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Remote HTTP with OAuth uses the MCP server's OAuth protected-resource metadata and a client login flow:

```bash
claude mcp add --transport http substack-drafts https://your-mcp-host/mcp
```

Open Claude Code, run `/mcp`, and follow the browser authentication flow for
`substack-drafts`.
