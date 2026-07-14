# Rotate Local Secrets

Use this after ngrok exposure, unexpected traffic, or any suspected local credential leak.

## Preview Token Secret

Generate a new local preview token secret:

```bash
openssl rand -base64 32
```

Update `PREVIEW_TOKEN_SECRET` in your local `.env` or `.env.local`. Existing confirmation tokens immediately become invalid.

## MCP Bearer Token

Generate a new static bearer token:

```bash
openssl rand -base64 32
```

Update `MCP_BEARER_TOKEN` wherever the server runs and update any private remote MCP client that sends the bearer header.

## Substack Session Token

Log out of Substack or invalidate the browser session if available, then copy a fresh session cookie value from a new browser session for your own account. Update `SUBSTACK_SESSION_TOKEN` in local env or Secret Manager.

For Cloud Run, add a new Secret Manager version and redeploy or restart the service so the latest version is loaded.
