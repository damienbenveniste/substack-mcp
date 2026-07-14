import { redactLogSensitiveText } from "../safety/redaction.js";
import { SubstackApiError } from "../substack/errors.js";

export function summarizeSubstackToolError(error: unknown): string {
  if (error instanceof SubstackApiError) {
    const status = error.status ? ` (HTTP ${error.status})` : "";
    const hint = error.hint ? ` ${error.hint}` : "";
    const response = error.responseBody
      ? ` Redacted response: ${error.responseBody}`
      : "";

    return `${error.message}${status}.${hint}${response}`.trim();
  }

  if (error instanceof Error) {
    return redactLogSensitiveText(error.message);
  }

  return "Unknown Substack error.";
}
