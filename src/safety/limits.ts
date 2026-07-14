export interface SizeLimitResult {
  readonly ok: boolean;
  readonly bytes: number;
  readonly maxBytes: number;
}

export function checkUtf8ByteLimit(
  value: string,
  maxBytes: number,
): SizeLimitResult {
  const bytes = Buffer.byteLength(value, "utf8");
  return {
    ok: bytes <= maxBytes,
    bytes,
    maxBytes,
  };
}

export function checkJsonUtf8ByteLimit(
  value: unknown,
  maxBytes: number,
): SizeLimitResult | undefined {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? undefined
    : checkUtf8ByteLimit(serialized, maxBytes);
}
