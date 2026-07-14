import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { loadLocalEnvFiles } from "../src/config.js";
import { writeRemoteStaticBearerEvidenceArtifact } from "./remoteStaticBearerEvidence.js";
import {
  assertExpectedTools,
  assertRemoteHealth,
  assertRemoteStaticBearerRejected,
  isHelp,
  parseArgs,
  type RemoteSmokeResult,
  type RemoteSmokeRunOptions,
  redactRemoteUrl,
  shouldLoadEnvFile,
  usage,
} from "./smokeRemoteHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  if (isHelp(args)) {
    console.log(usage());
    return;
  }

  if (shouldLoadEnvFile(args)) {
    loadLocalEnvFiles();
  }

  const options = parseArgs(args, env);
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await runRemoteHttpSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeRemoteStaticBearerEvidenceArtifact({
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

export async function runRemoteHttpSmoke(
  options: RemoteSmokeRunOptions,
): Promise<RemoteSmokeResult> {
  const client = new Client({
    name: "substack-mcp-remote-smoke",
    version: "0.1.0",
  });

  try {
    const health = await assertRemoteHealth(options.url);
    const missingBearerStatus = await assertRemoteStaticBearerRejected(
      options.url,
      undefined,
    );
    const wrongBearerStatus = await assertRemoteStaticBearerRejected(
      options.url,
      options.wrongBearerToken,
    );
    const transport = new StreamableHTTPClientTransport(options.url, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${options.bearerToken}`,
        },
      },
    });

    await client.connect(transport as unknown as Transport);
    const result = await client.listTools();
    const tools = result.tools.map((tool) => tool.name).sort();
    assertExpectedTools(tools);
    const validation = await assertValidateNewsletterContentTool(client);
    const preview = await assertPreviewDraftTool(client);

    return {
      ok: true,
      auth_mode: "static_bearer",
      endpoint: redactRemoteUrl(options.url),
      health,
      missing_bearer_status: missingBearerStatus,
      wrong_bearer_status: wrongBearerStatus,
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
