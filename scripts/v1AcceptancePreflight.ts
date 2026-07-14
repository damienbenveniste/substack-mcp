import { pathToFileURL } from "node:url";

import { loadLocalEnvFiles } from "../src/config.js";
import {
  buildV1AcceptancePreflight,
  parseV1AcceptancePreflightArgs,
  renderV1AcceptancePreflight,
  shouldFailV1AcceptancePreflight,
  v1AcceptancePreflightUsage,
} from "./v1AcceptancePreflightCore.js";

export function main(args = process.argv.slice(2)): void {
  const options = parseV1AcceptancePreflightArgs(args);
  if (options.help) {
    console.log(v1AcceptancePreflightUsage());
    return;
  }

  if (options.loadEnvFile) {
    loadLocalEnvFiles();
  }

  const report = buildV1AcceptancePreflight({
    cwd: options.cwd,
    fixtureDir: options.fixtureDir,
    env: process.env,
    scope: options.scope,
  });
  process.stdout.write(renderV1AcceptancePreflight(report, options.format));

  if (shouldFailV1AcceptancePreflight(report, options)) {
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
