import { pathToFileURL } from "node:url";

import {
  cloudRunVerifyUsage,
  parseCloudRunVerifyArgs,
  readCloudRunServiceJson,
  renderCloudRunVerifyReport,
  verifyCloudRunService,
} from "./cloudRunVerifyCore.js";
import { writeCloudRunVerifyEvidenceArtifact } from "./cloudRunVerifyEvidence.js";

async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseCloudRunVerifyArgs(args);
  if (options.help) {
    console.log(cloudRunVerifyUsage());
    return;
  }

  const service = readCloudRunServiceJson(options.serviceJson);
  const report = verifyCloudRunService(service, options);
  if (options.evidenceArtifact) {
    writeCloudRunVerifyEvidenceArtifact({
      cwd: options.artifactRoot,
      artifact: options.evidenceArtifact,
      report,
    });
  }
  console.log(renderCloudRunVerifyReport(report, options.format));
  if (!report.ok) {
    process.exitCode = 1;
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
