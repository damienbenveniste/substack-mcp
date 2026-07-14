import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { redactSecrets } from "../src/safety/redaction.js";
import { writeLocalStdioEvidenceArtifact } from "./localStdioEvidence.js";
import {
  type LocalStdioSmokeResult,
  type LocalStdioSmokeRunOptions,
  localStdioUsage,
  parseLocalStdioArgs,
} from "./smokeLocalStdioCore.js";
import { assertExpectedTools } from "./smokeRemoteHttpCore.js";
import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
} from "./smokeValidateTool.js";

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const options = parseLocalStdioArgs(args, env);
  if (options.help) {
    console.log(localStdioUsage());
    return;
  }

  const result = await runLocalStdioSmoke(options);
  if (!options.evidenceArtifact) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const evidence = writeLocalStdioEvidenceArtifact({
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

export async function runLocalStdioSmoke(
  options: LocalStdioSmokeRunOptions,
): Promise<LocalStdioSmokeResult> {
  const client = new Client({
    name: "substack-mcp-stdio-smoke",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: options.env,
    stderr: "pipe",
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  try {
    await client.connect(transport as unknown as Transport);
    const result = await client.listTools();
    const tools = result.tools.map((tool) => tool.name).sort();
    assertExpectedTools(tools);
    const validation = await assertValidateNewsletterContentTool(
      client,
      options.cwd,
    );
    const preview = await assertPreviewDraftTool(client, options.cwd);

    return {
      ok: true,
      transport: "stdio",
      command: options.command,
      args: options.args,
      tool_count: tools.length,
      tools,
      validation,
      preview,
    };
  } catch (error) {
    throw withServerStderr(error, stderrChunks);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function withServerStderr(error: unknown, stderrChunks: readonly Buffer[]) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = redactSecrets(Buffer.concat(stderrChunks).toString("utf8"));
  if (!stderr.trim()) {
    return new Error(message);
  }

  return new Error(
    `${message}\nServer stderr:\n${stderr.trim().slice(0, 2000)}`,
  );
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
