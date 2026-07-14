import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { loadConfig, loadLocalEnvFiles } from "../src/config.js";
import { createSubstackClient } from "../src/substack/client.js";
import {
  buildInspectDraftWriteResult,
  buildInspectedDraftOutput,
  inspectDraftUsage,
  outputDirectory,
  parseInspectDraftArgs,
} from "./inspectDraftCore.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseInspectDraftArgs(args);
  if (options.help) {
    console.log(inspectDraftUsage());
    return;
  }

  if (options.loadEnvFile) {
    loadLocalEnvFiles();
  }

  const config = loadConfig(process.env, { loadEnvFile: false });
  const client = createSubstackClient(config);
  const draft = await client.getDraft(options.draftId);
  const inspected = buildInspectedDraftOutput(draft, options);
  const json = `${JSON.stringify(inspected, null, 2)}\n`;

  const outputPath = options.outputPath;
  if (outputPath) {
    await mkdir(outputDirectory(outputPath), { recursive: true });
    await writeFile(outputPath, json, "utf8");
    console.log(
      JSON.stringify(
        buildInspectDraftWriteResult({
          draftId: options.draftId,
          includeRaw: options.includeRaw,
          outputPath,
        }),
        null,
        2,
      ),
    );
    return;
  }

  console.log(json.trimEnd());
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
