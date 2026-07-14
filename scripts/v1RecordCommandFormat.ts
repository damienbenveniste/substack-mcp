export interface V1RecordCommandParts {
  readonly gateId: number;
  readonly evidence: string;
  readonly command?: string | undefined;
  readonly artifact: string;
}

export function formatV1RecordCommand(parts: V1RecordCommandParts): string {
  const args = [
    "--gate",
    String(parts.gateId),
    "--evidence",
    shellArg(parts.evidence),
    ...(parts.command ? ["--command", shellArg(parts.command)] : []),
    "--artifact",
    shellArg(parts.artifact),
  ];
  return `npm run v1:record -- ${args.join(" ")}`;
}

export function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=,@+-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}
