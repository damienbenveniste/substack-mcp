import { redactResponseBodyText } from "../safety/redaction.js";

export const SUBSTACK_RESPONSE_BODY_EXCERPT_CHARS = 500;

export interface SubstackApiErrorOptions {
  readonly status?: number | undefined;
  readonly endpoint?: string | undefined;
  readonly responseBody?: string | undefined;
  readonly hint?: string | undefined;
}

export class SubstackApiError extends Error {
  readonly status?: number | undefined;
  readonly endpoint?: string | undefined;
  readonly responseBody?: string | undefined;
  readonly hint?: string | undefined;

  constructor(message: string, options: SubstackApiErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.status = options.status;
    this.endpoint = options.endpoint;
    this.responseBody = options.responseBody
      ? redactResponseBodyText(options.responseBody).slice(
          0,
          SUBSTACK_RESPONSE_BODY_EXCERPT_CHARS,
        )
      : undefined;
    this.hint = options.hint;
  }
}

export class SubstackAuthError extends SubstackApiError {}
export class SubstackRateLimitError extends SubstackApiError {}
export class SubstackValidationError extends SubstackApiError {}
export class SubstackNotFoundError extends SubstackApiError {}
export class SubstackServerError extends SubstackApiError {}
export class SubstackTimeoutError extends SubstackApiError {}

export function createSubstackError(
  status: number,
  endpoint: string,
  responseBody: string,
): SubstackApiError {
  const options = {
    status,
    endpoint,
    responseBody,
    hint: hintForStatus(status),
  };

  if (status === 400) {
    return new SubstackValidationError(
      "Substack rejected the request payload.",
      options,
    );
  }
  if (status === 401 || status === 403) {
    return new SubstackAuthError("Substack authentication failed.", options);
  }
  if (status === 404) {
    return new SubstackNotFoundError(
      "Substack resource was not found.",
      options,
    );
  }
  if (status === 429) {
    return new SubstackRateLimitError("Substack rate limit exceeded.", options);
  }
  if (status >= 500) {
    return new SubstackServerError(
      "Substack returned a server error.",
      options,
    );
  }

  return new SubstackApiError("Substack API request failed.", options);
}

function hintForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Check for an expired Substack session token, wrong publication URL, custom-domain issue, or missing browser-like user agent.";
  }
  if (status === 429) {
    return "Wait before retrying; Substack is rate limiting this session or IP.";
  }
  if (status === 400) {
    return "Check the draft payload shape against a live Substack fixture.";
  }
  if (status === 404) {
    return "Check the draft ID and publication URL.";
  }

  return "Inspect the redacted response body and retry later if this is transient.";
}
