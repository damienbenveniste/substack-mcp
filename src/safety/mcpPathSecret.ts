const MCP_PATH_SECRET_PATTERN = /^[A-Za-z0-9._~-]+$/u;

export const MCP_PATH_SECRET_DESCRIPTION =
  "one URL-safe path segment using only letters, numbers, '.', '_', '~', or '-', and not '.' or '..'";

export function normalizeMcpPathSecret(
  value: string | undefined,
  name = "MCP_PATH_SECRET",
): string | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  if (!MCP_PATH_SECRET_PATTERN.test(raw) || raw === "." || raw === "..") {
    throw new Error(`${name} must be ${MCP_PATH_SECRET_DESCRIPTION}.`);
  }

  return raw;
}

export function normalizeMcpEndpointPath(
  value: string,
  name = "--mcp-path",
): string {
  if (value === "/mcp") {
    return value;
  }
  if (!value.startsWith("/mcp/")) {
    throw new Error(
      `${name} must be /mcp or /mcp/<secret>. <secret> must be ${MCP_PATH_SECRET_DESCRIPTION}.`,
    );
  }

  const secret = normalizeMcpPathSecret(
    value.slice("/mcp/".length),
    "<secret>",
  );
  if (!secret) {
    throw new Error(`<secret> must be ${MCP_PATH_SECRET_DESCRIPTION}.`);
  }

  return value;
}
