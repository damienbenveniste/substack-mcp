import { pathToFileURL } from "node:url";
import { writeCloudRunLogsEvidenceArtifact } from "./cloudRunLogsEvidence.js";
import {
  cloudRunLogsVerifyUsage,
  parseCloudRunLogsVerifyArgs,
  readCloudRunLogsFile,
  renderCloudRunLogsVerifyReport,
  verifyCloudRunLogs,
} from "./cloudRunLogsVerifyCore.js";

export function main(args = process.argv.slice(2)): void {
  const options = parseCloudRunLogsVerifyArgs(args);
  if (options.help) {
    console.log(cloudRunLogsVerifyUsage());
    return;
  }

  const logs = readCloudRunLogsFile(options.logsJson);
  const report = verifyCloudRunLogs(logs, options);
  if (options.evidenceArtifact) {
    writeCloudRunLogsEvidenceArtifact({
      cwd: options.artifactRoot,
      artifact: options.evidenceArtifact,
      report,
    });
  }
  process.stdout.write(renderCloudRunLogsVerifyReport(report, options.format));
  if (!report.ok) {
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
