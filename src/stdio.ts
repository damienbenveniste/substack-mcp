import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  type AppConfig,
  assertMcpTransportConfig,
  assertRuntimeSecretConfig,
  loadConfig,
} from "./config.js";
import { createMcpServer } from "./server.js";

export async function startStdioServer(
  config: AppConfig = loadConfig(),
): Promise<void> {
  assertMcpTransportConfig(config, "stdio");
  assertRuntimeSecretConfig(config);
  const server = createMcpServer(config);
  const transport = new StdioServerTransport();
  // SDK 1.29's transport declarations conflict with exactOptionalPropertyTypes.
  await server.connect(transport as unknown as Transport);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await startStdioServer();
}
