import { pathToFileURL } from "node:url";

import {
  buildCloudRunPlan,
  cloudRunPlanUsage,
  parseCloudRunPlanArgs,
  renderCloudRunPlan,
} from "./cloudRunPlanCore.js";

export async function main(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const options = parseCloudRunPlanArgs(args, env);
  if (options.help) {
    console.log(cloudRunPlanUsage());
    return;
  }

  console.log(renderCloudRunPlan(buildCloudRunPlan(options)).trimEnd());
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
