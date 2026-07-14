import { pathToFileURL } from "node:url";

import {
  buildFixtureStatus,
  fixtureStatusUsage,
  parseFixtureStatusArgs,
  renderFixtureStatus,
  shouldFailFixtureStatus,
} from "./fixtureStatusCore.js";

export function main(args = process.argv.slice(2), cwd = process.cwd()): void {
  const options = parseFixtureStatusArgs(args, cwd);
  if (options.help) {
    console.log(fixtureStatusUsage());
    return;
  }

  const status = buildFixtureStatus({ ...options, cwd });
  console.log(renderFixtureStatus(status, options.format).trimEnd());

  if (shouldFailFixtureStatus(status, options)) {
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
