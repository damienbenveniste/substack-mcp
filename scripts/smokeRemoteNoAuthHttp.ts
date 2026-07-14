import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { loadLocalEnvFiles } from "../src/config.js";
import { writeRemoteNoAuthEvidenceArtifact } from "./remoteNoAuthEvidence.js";
import {
  assertExpectedTools,
  assertRemoteHealth,
} from "./smokeRemoteHttpCore.js";
import {
  isNoAuthHelp,
  noAuthUsage,
  parseNoAuthArgs,
  type RemoteNoAuthSmokeResult,
  type RemoteNoAuthSmokeRunOptions,
  redactNoAuthRemoteUrl,
  shouldLoadNoAuthEnvFile,
} from "./smokeRemoteNoAuthHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  if (isNoAuthHelp(args)) {
    console.log(noAuthUsage());
    return;
  }

  if (shouldLoadNoAuthEnvFile(args)) {
    loadLocalEnvFiles();
  }

  const options = parseNoAuthArgs(args, env);
  if (options.help) {
    console.log(noAuthUsage());
    return;
  }

  const result = await runRemoteNoAuthHttpSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeRemoteNoAuthEvidenceArtifact({
    cwd: options.artifactRoot,
    artifact: options.evidenceArtifact,
    result,
  });
  console.log(
    JSON.stringify(
      {
        ...result,
        evidence_artifact: evidence.artifact,
      },
      null,
      2,
    ),
  );
}

export async function runRemoteNoAuthHttpSmoke(
  options: RemoteNoAuthSmokeRunOptions,
): Promise<RemoteNoAuthSmokeResult> {
  const client = new Client({
    name: "substack-mcp-remote-noauth-smoke",
    version: "0.1.0",
  });

  try {
    const health = await assertRemoteHealth(options.url);
    const transport = new StreamableHTTPClientTransport(options.url);

    await client.connect(transport as unknown as Transport);
    const result = await client.listTools();
    const tools = result.tools.map((tool) => tool.name).sort();
    assertExpectedTools(tools);
    const validation = await assertValidateNewsletterContentTool(client);
    const preview = await assertPreviewDraftTool(client);

    return {
      ok: true,
      auth_mode: "noauth",
      endpoint: redactNoAuthRemoteUrl(options.url),
      health,
      tool_count: tools.length,
      tools,
      validation,
      preview,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
