import { pathToFileURL } from "node:url";

import {
  buildV1AcceptanceStatus,
  parseV1AcceptanceStatusArgs,
  renderV1AcceptanceStatus,
  shouldFailV1AcceptanceStatus,
  v1AcceptanceStatusUsage,
} from "./v1AcceptanceStatusCore.js";

export function main(args = process.argv.slice(2)): void {
  const options = parseV1AcceptanceStatusArgs(args);
  if (options.help) {
    console.log(v1AcceptanceStatusUsage());
    return;
  }

  const status = buildV1AcceptanceStatus({
    cwd: options.cwd,
    evidenceFile: options.evidenceFile,
    fixtureDir: options.fixtureDir,
  });
  process.stdout.write(renderV1AcceptanceStatus(status, options.format));

  if (shouldFailV1AcceptanceStatus(status, options)) {
    process.exitCode = 1;
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
