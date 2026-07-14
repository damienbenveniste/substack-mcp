import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { loadLocalEnvFiles } from "../src/config.js";
import { writeRemoteOAuthEvidenceArtifact } from "./remoteOAuthEvidence.js";
import {
  assertExpectedTools,
  assertRemoteHealth,
} from "./smokeRemoteHttpCore.js";
import {
  assertOAuthMetadataCors,
  fetchOAuthAuthorizationServerDiscovery,
  isOAuthHelp,
  oauthUsage,
  parseOAuthArgs,
  protectedResourceMetadataUrl,
  type RemoteOAuthSmokeResult,
  type RemoteOAuthSmokeRunOptions,
  redactOAuthRemoteUrl,
  shouldLoadOAuthEnvFile,
  summarizeOAuthMetadata,
} from "./smokeRemoteOAuthHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  if (isOAuthHelp(args)) {
    console.log(oauthUsage());
    return;
  }

  if (shouldLoadOAuthEnvFile(args)) {
    loadLocalEnvFiles();
  }

  const options = parseOAuthArgs(args, env);
  if (options.help) {
    console.log(oauthUsage());
    return;
  }

  const result = await runRemoteOAuthHttpSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeRemoteOAuthEvidenceArtifact({
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

export async function runRemoteOAuthHttpSmoke(
  options: RemoteOAuthSmokeRunOptions,
): Promise<RemoteOAuthSmokeResult> {
  const health = await assertRemoteHealth(options.url);
  const metadataUrl = protectedResourceMetadataUrl(options.url);
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) {
    throw new Error(
      `OAuth protected-resource metadata returned HTTP ${metadataResponse.status}.`,
    );
  }
  const metadataCors = await assertOAuthMetadataCors(
    metadataUrl,
    metadataResponse,
  );
  const metadata = summarizeOAuthMetadata(
    await metadataResponse.json(),
    options.url.origin,
  );
  const authorizationServer = await fetchOAuthAuthorizationServerDiscovery(
    metadata.authorization_servers,
    options.discoveryFetch,
  );

  const client = new Client({
    name: "substack-mcp-remote-oauth-smoke",
    version: "0.1.0",
  });

  try {
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
      auth_mode: "oauth",
      endpoint: redactOAuthRemoteUrl(options.url),
      health,
      protected_resource_metadata_url: metadataUrl.toString(),
      metadata,
      metadata_cors: metadataCors,
      authorization_server: authorizationServer,
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
