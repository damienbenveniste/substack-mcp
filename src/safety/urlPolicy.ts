export type HttpUrlPolicyResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly errors: readonly string[] };

export function parseHttpUrl(
  value: string,
  fieldName = "url",
): HttpUrlPolicyResult {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        errors: [`${fieldName} must use http:// or https://.`],
      };
    }

    if (url.username || url.password) {
      return {
        ok: false,
        errors: [`${fieldName} must not include username or password.`],
      };
    }

    if (isPrivateNetworkHost(url.hostname)) {
      return {
        ok: false,
        errors: [
          `${fieldName} must not point to localhost or private network addresses.`,
        ],
      };
    }

    return { ok: true, url };
  } catch {
    return {
      ok: false,
      errors: [`${fieldName} must be a valid URL.`],
    };
  }
}

export function parsePublicHttpsUrl(
  value: string,
  fieldName = "url",
): HttpUrlPolicyResult {
  const parsed = parseHttpUrl(value, fieldName);
  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.url.protocol !== "https:") {
    return {
      ok: false,
      errors: [`${fieldName} must use https://.`],
    };
  }

  return parsed;
}

function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1")
    .replace(/\.$/, "");

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    return isPrivateIpv4(ipv4);
  }

  return isPrivateIpv6(normalized);
}

function parseIpv4(
  hostname: string,
): readonly [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map((part) =>
    /^\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN,
  );

  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }

  return octets as [number, number, number, number];
}

function isPrivateIpv4(
  octets: readonly [number, number, number, number],
): boolean {
  const [first, second, third] = octets;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) {
    return false;
  }

  return (
    hostname === "::" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89ab]/.test(hostname) ||
    hostname.startsWith("ff") ||
    hostname.startsWith("::ffff:")
  );
}
