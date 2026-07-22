import type { ExactWorktreeChange } from "../diff/contract.ts";
import type { TaskWorktreeDigest } from "../digest.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import type {
  CommitMessageParseResult,
  CommitSynthesisPolicy,
  ConventionalCommitMessage,
  ConventionalCommitType,
  OwnedPackagePath,
} from "./contract.ts";

export function parseConventionalCommitMessage(
  text: unknown,
): CommitMessageParseResult {
  if (typeof text !== "string" || text.length === 0 || text.includes("\r")) {
    return Object.freeze({ status: "invalid", code: "INVALID_COMMIT_MESSAGE" });
  }
  const sections = text.split("\n\n");
  if (sections.length > 2 || sections.some((section) => section.length === 0)) {
    return Object.freeze({ status: "invalid", code: "INVALID_COMMIT_MESSAGE" });
  }
  const header = sections[0];
  if (header === undefined || header.includes("\n")) {
    return Object.freeze({ status: "invalid", code: "INVALID_COMMIT_MESSAGE" });
  }
  const match =
    /^(build|chore|docs|feat|fix|refactor|test)(?:\(([a-z0-9][a-z0-9-]*)\))?: ([^\n]+)$/u.exec(
      header,
    );
  if (match === null)
    return Object.freeze({ status: "invalid", code: "INVALID_COMMIT_MESSAGE" });
  const type = commitType(match[1]);
  const scope = match[2] ?? "";
  const description = match[3];
  if (
    type === undefined ||
    description === undefined ||
    description.length === 0 ||
    description.trim() !== description ||
    /[\p{Cc}\p{Cf}]/u.test(description) ||
    !/^[a-z]/u.test(description)
  ) {
    return Object.freeze({ status: "invalid", code: "INVALID_COMMIT_MESSAGE" });
  }
  const trailers = parseTrailers(sections[1]);
  if (trailers === undefined)
    return Object.freeze({ status: "invalid", code: "INVALID_COMMIT_MESSAGE" });
  return validMessage(type, scope, description, trailers, text);
}
export function synthesizeMessage(
  changes: readonly ExactWorktreeChange[],
  policy: CommitSynthesisPolicy,
  receiptDigest: TaskWorktreeDigest,
  sliceDigest: TaskWorktreeDigest,
):
  | Readonly<{ status: "ok"; message: ConventionalCommitMessage }>
  | Readonly<{ status: "ambiguous" }>
  | Readonly<{ status: "invalid" }> {
  const scope = inferScope(changes, policy.ownedPackagePaths);
  if (scope === "ambiguous") return Object.freeze({ status: "ambiguous" });
  const type = inferType(changes);
  const verb = changes.every(({ kind }) => kind === "deleted")
    ? "remove"
    : changes.every(({ kind }) => kind === "added")
      ? "add"
      : "update";
  const target = scope ?? "task-worktree";
  const description = `${verb} ${target}`;
  const header = `${type}${scope === undefined ? "" : `(${scope})`}: ${description}`;
  if (header.length > policy.maxSubjectLength)
    return Object.freeze({ status: "invalid" });
  const parsed = parseConventionalCommitMessage(header);
  if (parsed.status !== "valid") {
    return Object.freeze({ status: "invalid" });
  }
  const trailers = Object.freeze([
    Object.freeze({ token: "Diff-Receipt", value: receiptDigest }),
    Object.freeze({ token: "Task-Slice", value: sliceDigest }),
  ]);
  const text = `${header}\n\n${trailers
    .map(({ token, value }) => `${token}: ${value}`)
    .join("\n")}`;
  const complete = parseConventionalCommitMessage(text);
  if (complete.status !== "valid") {
    return Object.freeze({ status: "invalid" });
  }
  return Object.freeze({ status: "ok", message: complete.message });
}

function inferScope(
  changes: readonly ExactWorktreeChange[],
  ownedPackagePaths: readonly OwnedPackagePath[],
): string | "ambiguous" | undefined {
  const scopes = new Set<string>();
  for (const change of changes) {
    const matches = ownedPackagePaths.filter(
      ({ path }) => change.path === path || change.path.startsWith(`${path}/`),
    );
    if (matches.length === 0) continue;
    const depth = Math.max(...matches.map(({ path }) => path.length));
    const deepest = matches.filter(({ path }) => path.length === depth);
    if (new Set(deepest.map(({ scope }) => scope)).size !== 1)
      return "ambiguous";
    const scope = deepest[0]?.scope;
    if (scope !== undefined) scopes.add(scope);
  }
  return scopes.size > 1 ? "ambiguous" : [...scopes][0];
}

function inferType(
  changes: readonly ExactWorktreeChange[],
): ConventionalCommitType {
  const paths = changes.map(({ path }) => path);
  if (
    paths.every((path) => path.endsWith(".test.ts") || path.includes("/test/"))
  )
    return "test";
  if (paths.every((path) => path.endsWith(".md") || path.startsWith("docs/")))
    return "docs";
  if (
    paths.every(
      (path) =>
        path.endsWith(".json") ||
        path.endsWith(".jsonc") ||
        path.endsWith(".toml") ||
        path.endsWith(".yml") ||
        path.endsWith(".yaml"),
    )
  )
    return "chore";
  return changes.some(({ kind }) => kind === "added") ? "feat" : "refactor";
}

export function changesForSlice(
  all: readonly ExactWorktreeChange[],
  paths: readonly string[],
): readonly ExactWorktreeChange[] | undefined {
  if (paths.length === 0) return Object.freeze([]);
  const byPath = new Map(all.map((change) => [change.path, change]));
  const changes: ExactWorktreeChange[] = [];
  for (const path of paths) {
    const change = byPath.get(path);
    if (change === undefined) return;
    changes.push(change);
  }
  return Object.freeze(changes);
}

function parseTrailers(
  input: string | undefined,
): readonly Readonly<{ token: string; value: string }>[] | undefined {
  if (input === undefined) return Object.freeze([]);
  const trailers: Readonly<{ token: string; value: string }>[] = [];
  const tokens = new Set<string>();
  for (const line of input.split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): ([^\n\r]+)$/u.exec(line);
    if (
      match === null ||
      match[1] === undefined ||
      match[2] === undefined ||
      tokens.has(match[1])
    )
      return;
    tokens.add(match[1]);
    trailers.push(Object.freeze({ token: match[1], value: match[2] }));
  }
  return Object.freeze(trailers);
}

function validMessage(
  type: ConventionalCommitType,
  scope: string,
  description: string,
  trailers: readonly Readonly<{ token: string; value: string }>[],
  text: string,
): Readonly<{ status: "valid"; message: ConventionalCommitMessage }> {
  const material = Object.freeze({ type, scope, description, trailers, text });
  return Object.freeze({
    status: "valid",
    message: Object.freeze({
      ...material,
      messageDigest: digestTaskWorktreeValue(material),
    }),
  });
}

function commitType(
  input: string | undefined,
): ConventionalCommitType | undefined {
  if (
    input === "build" ||
    input === "chore" ||
    input === "docs" ||
    input === "feat" ||
    input === "fix" ||
    input === "refactor" ||
    input === "test"
  )
    return input;
  return;
}
