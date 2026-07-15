import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type ConfirmationAction = "create" | "update";

export interface ConfirmationTokenSubject {
  readonly action: ConfirmationAction;
  readonly draft_id?: number | undefined;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: string | undefined;
  readonly content: unknown;
}

export interface ConfirmationTokenPayload {
  readonly version: 1;
  readonly action: ConfirmationAction;
  readonly draft_id?: number | undefined;
  readonly title_hash: string;
  readonly subtitle_hash: string;
  readonly audience?: string | undefined;
  readonly content_hash: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

export interface CreateConfirmationTokenOptions {
  readonly secret: string;
  readonly ttlSeconds: number;
  readonly now?: Date | undefined;
}

export interface ConfirmationTokenResult {
  readonly token: string;
  readonly payload: ConfirmationTokenPayload;
  readonly expiresAt: Date;
}

export type VerifyConfirmationTokenResult =
  | {
      readonly ok: true;
      readonly payload: ConfirmationTokenPayload;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const ConfirmationTokenPayloadSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(["create", "update"]),
    draft_id: z.number().int().positive().optional(),
    title_hash: z.string(),
    subtitle_hash: z.string(),
    audience: z.string().optional(),
    content_hash: z.string(),
    issued_at: z.number().int().nonnegative(),
    expires_at: z.number().int().nonnegative(),
  })
  .strict();

export function createConfirmationToken(
  subject: ConfirmationTokenSubject,
  options: CreateConfirmationTokenOptions,
): ConfirmationTokenResult {
  assertPositiveTtlSeconds(options.ttlSeconds);

  const issuedAt = secondsFromDate(options.now ?? new Date());
  const expiresAt = issuedAt + options.ttlSeconds;
  const payload = createPayload(subject, issuedAt, expiresAt);
  const payloadJson = stableStringify(payload);
  const payloadSegment = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signatureSegment = signPayloadJson(payloadJson, options.secret);

  return {
    token: `${payloadSegment}.${signatureSegment}`,
    payload,
    expiresAt: new Date(expiresAt * 1_000),
  };
}

export function verifyConfirmationToken(
  token: string,
  subject: ConfirmationTokenSubject,
  options: Pick<CreateConfirmationTokenOptions, "secret" | "now">,
): VerifyConfirmationTokenResult {
  const integrity = verifyConfirmationTokenIntegrity(token, options);
  if (!integrity.ok) {
    return integrity;
  }

  const parsedPayload = integrity.payload;
  const expectedPayload = createPayload(
    subject,
    parsedPayload.issued_at,
    parsedPayload.expires_at,
  );

  if (stableStringify(parsedPayload) !== stableStringify(expectedPayload)) {
    return {
      ok: false,
      error: "Confirmation token does not match the current draft input.",
    };
  }

  return integrity;
}

export function verifyConfirmationTokenIntegrity(
  token: string,
  options: Pick<CreateConfirmationTokenOptions, "secret" | "now">,
): VerifyConfirmationTokenResult {
  const [payloadSegment, signatureSegment, extraSegment] = token.split(".");
  if (!payloadSegment || !signatureSegment || extraSegment !== undefined) {
    return { ok: false, error: "Malformed confirmation token." };
  }

  const payloadJson = decodePayloadSegment(payloadSegment);
  /* v8 ignore next */
  if (!payloadJson) {
    return { ok: false, error: "Invalid confirmation token payload." };
  }

  const expectedSignature = signPayloadJson(payloadJson, options.secret);
  if (!safeEqualBase64Url(signatureSegment, expectedSignature)) {
    return { ok: false, error: "Invalid confirmation token signature." };
  }

  const parsedPayload = parsePayload(payloadJson);
  if (!parsedPayload) {
    return { ok: false, error: "Invalid confirmation token payload." };
  }

  const nowSeconds = secondsFromDate(options.now ?? new Date());
  if (parsedPayload.expires_at <= nowSeconds) {
    return { ok: false, error: "Confirmation token has expired." };
  }

  return {
    ok: true,
    payload: parsedPayload,
  };
}

export function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => stableStringifyArrayItem(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);

  return `{${entries.join(",")}}`;
}

function stableStringifyArrayItem(value: unknown): string {
  return value === undefined ? "null" : stableStringify(value);
}

function createPayload(
  subject: ConfirmationTokenSubject,
  issuedAt: number,
  expiresAt: number,
): ConfirmationTokenPayload {
  return {
    version: 1,
    action: subject.action,
    ...(subject.draft_id !== undefined ? { draft_id: subject.draft_id } : {}),
    title_hash: sha256(normalizeText(subject.title)),
    subtitle_hash: sha256(normalizeText(subject.subtitle)),
    ...(subject.audience ? { audience: subject.audience } : {}),
    content_hash: contentHash(subject.content),
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
}

function normalizeText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function secondsFromDate(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

function assertPositiveTtlSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("ttlSeconds must be a positive integer.");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signPayloadJson(payloadJson: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadJson).digest("base64url");
}

function decodePayloadSegment(payloadSegment: string): string | undefined {
  try {
    return Buffer.from(payloadSegment, "base64url").toString("utf8");
    /* v8 ignore next 2 */
  } catch {
    return undefined;
  }
}

function parsePayload(
  payloadJson: string,
): ConfirmationTokenPayload | undefined {
  try {
    const parsed = ConfirmationTokenPayloadSchema.safeParse(
      JSON.parse(payloadJson),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
