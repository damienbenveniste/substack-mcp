export const MAX_NGROK_HOLD_OPEN_SECONDS = 3600;

type NgrokHoldOpenAuth =
  | { readonly mode: "noauth" }
  | {
      readonly mode: "static_bearer";
      readonly bearerTokenEnvName: string;
    };

export interface NgrokHoldOpenOptions {
  readonly endpoint: URL;
  readonly seconds: number;
  readonly auth: NgrokHoldOpenAuth;
  readonly write?: ((message: string) => void) | undefined;
  readonly wait?: ((milliseconds: number) => Promise<void>) | undefined;
}

export function parseNgrokHoldOpenSeconds(
  value: string,
  label: string,
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${label} must be an integer from 0 to ${MAX_NGROK_HOLD_OPEN_SECONDS}.`,
    );
  }

  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > MAX_NGROK_HOLD_OPEN_SECONDS
  ) {
    throw new Error(
      `${label} must be an integer from 0 to ${MAX_NGROK_HOLD_OPEN_SECONDS}.`,
    );
  }
  return seconds;
}

export async function holdOpenNgrokTunnel(
  options: NgrokHoldOpenOptions,
): Promise<void> {
  if (options.seconds === 0) {
    return;
  }

  const authLine =
    options.auth.mode === "static_bearer"
      ? `Authentication: static bearer from ${options.auth.bearerTokenEnvName}; the token value is not printed.`
      : "Authentication: noauth; keep this short-lived endpoint private.";
  const write = options.write ?? console.error;
  write(
    [
      "Remote smoke passed. The ngrok tunnel is live for manual client acceptance.",
      `MCP endpoint: ${options.endpoint.toString()}`,
      authLine,
      `Hold-open window: ${options.seconds} seconds. Press Ctrl-C to close it early.`,
    ].join("\n"),
  );

  await (options.wait ?? waitForWindow)(options.seconds * 1000);
}

async function waitForWindow(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const finish = (): void => {
      clearTimeout(timer);
      for (const signal of signals) {
        process.off(signal, finish);
      }
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    for (const signal of signals) {
      process.once(signal, finish);
    }
  });
}
