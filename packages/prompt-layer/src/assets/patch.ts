import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { PromptLayerError } from "../lifecycle-contract.ts";
import {
  readRequiredFile,
  validateSafeRelativePath,
} from "../repository-boundary.ts";
import { gitBlobId, validateText } from "./manifest.ts";

const BINARY_FILES = /^Binary files /mu;
const FORBIDDEN_PATCH_METADATA =
  /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /mu;
const SAFE_INDEX = /^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$/u;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
}

export function validatePatch(
  patch: Buffer,
  expectedPath: string,
  baseline: Buffer,
): Buffer {
  validateText(patch, "prompt patch");
  validateText(baseline, "patch baseline");
  const text = patch.toString("utf8");
  const lines = text.split("\n");
  const index = validatePatchEnvelope(text, lines, expectedPath);
  const output = validatePatchHunks(lines, baseline);
  if (index.old !== gitBlobId(baseline) || index.new !== gitBlobId(output)) {
    throw new PromptLayerError(
      "Prompt patch index identities do not match the exact baseline and reconstructed output.",
    );
  }
  return output;
}

function validatePatchEnvelope(
  text: string,
  lines: string[],
  expectedPath: string,
): { old: string; new: string } {
  const diffHeaders = lines.filter((line) => line.startsWith("diff --git "));
  const expectedDiff = `diff --git a/${expectedPath} b/${expectedPath}`;
  if (diffHeaders.length !== 1 || diffHeaders[0] !== expectedDiff) {
    throw new PromptLayerError(
      "Prompt patch must modify exactly the pinned relative upstream path.",
    );
  }
  validateSafeRelativePath(expectedPath);
  if (
    text.includes("GIT binary patch") ||
    BINARY_FILES.test(text) ||
    FORBIDDEN_PATCH_METADATA.test(text)
  ) {
    throw new PromptLayerError(
      "Prompt patch may not create, delete, rename, copy, change modes, or contain binary hunks.",
    );
  }

  const oldHeaders = lines.filter((line) => line.startsWith("--- "));
  const newHeaders = lines.filter((line) => line.startsWith("+++ "));
  if (
    oldHeaders.length !== 1 ||
    newHeaders.length !== 1 ||
    oldHeaders[0] !== `--- a/${expectedPath}` ||
    newHeaders[0] !== `+++ b/${expectedPath}`
  ) {
    throw new PromptLayerError("Prompt patch has malformed or changed paths.");
  }
  const indexLines = lines.filter((line) => line.startsWith("index "));
  if (indexLines.length !== 1 || !SAFE_INDEX.test(indexLines[0] ?? "")) {
    throw new PromptLayerError(
      "Prompt patch must describe one safe regular textual file mode.",
    );
  }
  const identity = SAFE_INDEX.exec(indexLines[0] ?? "");
  if (identity === null) {
    throw new PromptLayerError("Prompt patch index identities are malformed.");
  }
  const [old, next] = (indexLines[0] ?? "")
    .slice("index ".length, -" 100644".length)
    .split("..");
  if (old === undefined || next === undefined) {
    throw new PromptLayerError("Prompt patch index identities are malformed.");
  }
  return { old, new: next };
}

function validatePatchHunks(lines: string[], baseline: Buffer): Buffer {
  const baselineLines = baseline.toString("utf8").split("\n").slice(0, -1);
  const outputLines: string[] = [];
  let oldCursor = 0;
  for (const hunk of parseHunks(lines)) {
    outputLines.push(...baselineLines.slice(oldCursor, hunk.oldStart));
    oldCursor = applyHunkAtDeclaredPosition(
      hunk,
      baselineLines,
      outputLines,
      oldCursor,
    );
  }
  outputLines.push(...baselineLines.slice(oldCursor));
  return Buffer.from(`${outputLines.join("\n")}\n`);
}

function parseHunks(lines: string[]): ParsedHunk[] {
  const hunkIndexes = lines
    .map((line, index) => (line.startsWith("@@ ") ? index : -1))
    .filter((index) => index >= 0);
  if (hunkIndexes.length === 0) {
    throw new PromptLayerError("Prompt patch must contain textual hunks.");
  }
  return hunkIndexes.map((start, position) => {
    const end = hunkIndexes[position + 1] ?? lines.length - 1;
    return parseHunk(lines[start] ?? "", lines.slice(start + 1, end));
  });
}

function parseHunk(header: string, body: string[]): ParsedHunk {
  const match = HUNK_HEADER.exec(header);
  if (match === null) {
    throw new PromptLayerError(
      "Prompt patch contains a malformed hunk header.",
    );
  }
  const oldCount = Number(match[2] ?? "1");
  const newCount = Number(match[4] ?? "1");
  if (oldCount < 1 || newCount < 1) {
    throw new PromptLayerError(
      "Prompt patch may not contain create/delete hunks.",
    );
  }
  if (!body.some((line) => line.startsWith(" "))) {
    throw new PromptLayerError("Zero-context prompt patches are forbidden.");
  }
  if (body.some((line) => !isHunkLine(line))) {
    throw new PromptLayerError("Prompt patch contains malformed hunk content.");
  }
  return {
    oldStart: Number(match[1]) - 1,
    oldCount,
    newStart: Number(match[3]) - 1,
    newCount,
    body,
  };
}

function isHunkLine(line: string): boolean {
  return (
    line.length > 0 &&
    (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
  );
}

function applyHunkAtDeclaredPosition(
  hunk: ParsedHunk,
  baselineLines: string[],
  outputLines: string[],
  oldCursor: number,
): number {
  if (hunk.oldStart < oldCursor || hunk.oldStart > baselineLines.length) {
    throw new PromptLayerError(
      "Prompt patch hunks overlap or declare an invalid old position.",
    );
  }
  if (hunk.newStart !== outputLines.length) {
    throw new PromptLayerError(
      "Prompt patch hunk declares an inexact new position.",
    );
  }
  const counts = applyHunkLines(hunk, baselineLines, outputLines);
  if (counts.old !== hunk.oldCount || counts.new !== hunk.newCount) {
    throw new PromptLayerError(
      "Prompt patch hunk line counts do not match its declared counts.",
    );
  }
  return hunk.oldStart + counts.old;
}

function applyHunkLines(
  hunk: ParsedHunk,
  baselineLines: string[],
  outputLines: string[],
): { old: number; new: number } {
  let oldConsumed = 0;
  let newConsumed = 0;
  for (const line of hunk.body) {
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix !== "+") {
      if (baselineLines[hunk.oldStart + oldConsumed] !== content) {
        throw new PromptLayerError(
          "Prompt patch old/context lines do not match the exact declared baseline position.",
        );
      }
      oldConsumed += 1;
    }
    if (prefix !== "-") {
      outputLines.push(content);
      newConsumed += 1;
    }
  }
  return { old: oldConsumed, new: newConsumed };
}

export async function applyPatchStrict(
  baseline: Buffer,
  patch: Buffer,
  upstreamPath: string,
): Promise<Buffer> {
  const reconstructed = validatePatch(patch, upstreamPath, baseline);
  const root = await mkdtemp(join(tmpdir(), "skizzles-prompt-apply-"));
  try {
    const target = join(root, upstreamPath);
    const patchPath = join(root, "prompt.patch");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, baseline);
    await writeFile(patchPath, patch);
    git(root, ["init", "-q"]);
    git(root, ["apply", "--check", "--whitespace=error-all", patchPath]);
    git(root, ["apply", "--whitespace=error-all", patchPath]);
    const output = await readRequiredFile(target, "strictly applied prompt");
    validateText(output, "strictly applied prompt");
    if (!output.equals(reconstructed)) {
      throw new PromptLayerError(
        "git apply output differs from exact-position patch reconstruction.",
      );
    }
    return output;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export async function createPatch(
  baseline: Buffer,
  candidate: Buffer,
  upstreamPath: string,
): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-prompt-author-"));
  try {
    const target = join(root, upstreamPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, baseline);
    git(root, ["init", "-q"]);
    git(root, ["add", "--", upstreamPath]);
    await writeFile(target, candidate);
    const patch = git(root, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-renames",
      "--full-index",
      "--",
      upstreamPath,
    ]);
    if (patch.byteLength === 0) {
      throw new PromptLayerError(
        "Reviewed candidate must modify the pinned baseline.",
      );
    }
    return patch;
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function git(cwd: string, args: string[]): Buffer {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
      LANG: "C",
      PATH: process.env["PATH"] ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new PromptLayerError(
      `git ${args[0] ?? "command"} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return Buffer.from(result.stdout);
}
