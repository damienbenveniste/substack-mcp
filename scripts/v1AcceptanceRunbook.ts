import { pathToFileURL } from "node:url";

import {
  parseV1AcceptanceRunbookArgs,
  v1AcceptanceRunbookUsage,
  writeV1AcceptanceRunbook,
} from "./v1AcceptanceRunbookCore.js";

export function main(args = process.argv.slice(2)): void {
  const options = parseV1AcceptanceRunbookArgs(args);
  if (options.help) {
    console.log(v1AcceptanceRunbookUsage());
    return;
  }

  const result = writeV1AcceptanceRunbook(options);
  if (result.output) {
    console.log(`Wrote V1 acceptance runbook: ${result.output}`);
    printArtifactSummary(result.artifacts);
    return;
  }

  console.log(result.markdown.trimEnd());
  printArtifactSummary(result.artifacts);
}

function printArtifactSummary(
  artifacts: readonly { readonly path: string; readonly created: boolean }[],
): void {
  const created = artifacts.filter((artifact) => artifact.created);
  if (created.length === 0) {
    return;
  }

  console.log("");
  console.log(`Wrote V1 evidence templates: ${created.length}`);
  for (const artifact of created) {
    console.log(`- ${artifact.path}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
