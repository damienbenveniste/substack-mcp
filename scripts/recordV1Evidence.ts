import { pathToFileURL } from "node:url";

import {
  parseRecordV1EvidenceArgs,
  recordV1Evidence,
  recordV1EvidenceUsage,
  renderRecordV1EvidenceResult,
} from "./recordV1EvidenceCore.js";

export function main(args = process.argv.slice(2)): void {
  const options = parseRecordV1EvidenceArgs(args);
  if (options.help) {
    console.log(recordV1EvidenceUsage());
    return;
  }

  const result = recordV1Evidence(options);
  process.stdout.write(renderRecordV1EvidenceResult(result, options.format));
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
