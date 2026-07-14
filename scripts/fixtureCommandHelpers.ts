import { isAbsolute, relative, resolve } from "node:path";

import type { SubstackFixtureKind } from "./inspectDraftCore.js";

export type FixtureInspectKind = "rich" | SubstackFixtureKind;

export function buildFixtureInspectCommand(
  draftId: number,
  kind: FixtureInspectKind,
  fixtureDir = resolve("fixtures", "substack"),
  cwd = process.cwd(),
): string {
  const baseCommand = `npm run inspect:draft -- ${draftId}`;
  if (kind === "rich") {
    return baseCommand;
  }

  const fixtureDirArg = fixtureDirCommandArg(cwd, fixtureDir);
  const fixtureCommand = `${baseCommand} --fixture ${kind}`;
  if (!fixtureDirArg) {
    return fixtureCommand;
  }

  return `${fixtureCommand} --fixture-dir ${shellArg(fixtureDirArg)}`;
}

function fixtureDirCommandArg(
  cwd: string,
  fixtureDir: string,
): string | undefined {
  const root = resolve(cwd);
  const resolvedFixtureDir = resolve(fixtureDir);
  if (resolvedFixtureDir === resolve(root, "fixtures", "substack")) {
    return undefined;
  }

  const relativePath = relative(root, resolvedFixtureDir);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return relativePath;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}
