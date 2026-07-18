import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCHEMA = "skizzles.prompt-layer";
const VERSION = 1;
const OFFICIAL_REPOSITORY = "https://github.com/openai/codex";
const RAW_ORIGIN = "https://raw.githubusercontent.com/openai/codex";
const UPSTREAM_PATH =
  "codex-rs/protocol/src/prompts/base_instructions/default.md";
export const PROMPT_LAYER_ASSET_ROOT = "packages/prompt-layer/assets";
export const PROMPT_LAYER_SOURCE_PATHS = {
  manifest: "packages/prompt-layer/assets/manifest.json",
  baseline: "packages/prompt-layer/assets/upstream/default.md",
  license: "packages/prompt-layer/assets/upstream/LICENSE",
  notice: "packages/prompt-layer/assets/upstream/NOTICE",
  patch: "packages/prompt-layer/assets/skizzles-base.patch",
  applied: "packages/prompt-layer/assets/instructions/skizzles-base.md",
  provenance:
    "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
  developer:
    "packages/prompt-layer/assets/instructions/developer-instructions.md",
  compact: "packages/prompt-layer/assets/instructions/compact-prompt.md",
  descriptor: "packages/prompt-layer/assets/integrations/prompt-policy.json",
} as const;

export const PROMPT_LAYER_PACKAGE_FILES = [
  [PROMPT_LAYER_SOURCE_PATHS.applied, "instructions/skizzles-base.md"],
  [
    PROMPT_LAYER_SOURCE_PATHS.provenance,
    "instructions/skizzles-base.provenance.json",
  ],
  [
    PROMPT_LAYER_SOURCE_PATHS.developer,
    "instructions/developer-instructions.md",
  ],
  [PROMPT_LAYER_SOURCE_PATHS.compact, "instructions/compact-prompt.md"],
  [PROMPT_LAYER_SOURCE_PATHS.descriptor, "integrations/prompt-policy.json"],
  [PROMPT_LAYER_SOURCE_PATHS.license, "third_party/openai-codex/LICENSE"],
  [PROMPT_LAYER_SOURCE_PATHS.notice, "third_party/openai-codex/NOTICE"],
] as const;

const MANIFEST_PATH = PROMPT_LAYER_SOURCE_PATHS.manifest;
const BASELINE_PATH = PROMPT_LAYER_SOURCE_PATHS.baseline;
const LICENSE_PATH = PROMPT_LAYER_SOURCE_PATHS.license;
const NOTICE_PATH = PROMPT_LAYER_SOURCE_PATHS.notice;
const PATCH_PATH = PROMPT_LAYER_SOURCE_PATHS.patch;
const OUTPUT_PATH = PROMPT_LAYER_SOURCE_PATHS.applied;
const PROVENANCE_PATH = PROMPT_LAYER_SOURCE_PATHS.provenance;
const TRANSACTION_PATH = "packages/prompt-layer/assets/.transaction";
const TRANSACTION_JOURNAL_PATH = `${TRANSACTION_PATH}/journal.json`;
const LOCK_PATH = "packages/prompt-layer/assets/.mutation-lock";
const LOCK_OWNER_PATH = `${LOCK_PATH}/owner.json`;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MACHINE_PATH =
  /(?:\/Users\/[A-Za-z0-9._-]+(?:\/|\b)|\/home\/[A-Za-z0-9._-]+(?:\/|\b)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b))/i;
const BINARY_FILES = /^Binary files /m;
const FORBIDDEN_PATCH_METADATA =
  /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) /m;
const SAFE_INDEX = /^index [0-9a-f]{40}\.\.[0-9a-f]{40} 100644$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:/;
const PROVENANCE_MARKER = "Skizzles prompt layer provenance";
const PROVENANCE_FIELD =
  /^[\t ]*(?:Repository|Commit|Path|Baseline role):[\t ]*/m;
const TRANSACTION_VERSION = 1;
const LOCK_VERSION = 1;
const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WHITESPACE = /\s+/;
const ALL_WHITESPACE = /\s+/g;
const LINE_BREAK = /[\r\n]/;
const DARWIN_PS_LSTART =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;
const DARWIN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DARWIN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const TRANSACTION_PATHS = {
  build: [OUTPUT_PATH, PROVENANCE_PATH],
  author: [PATCH_PATH, MANIFEST_PATH, OUTPUT_PATH, PROVENANCE_PATH],
  rebase: [
    BASELINE_PATH,
    LICENSE_PATH,
    NOTICE_PATH,
    PATCH_PATH,
    MANIFEST_PATH,
    OUTPUT_PATH,
    PROVENANCE_PATH,
  ],
} as const;
const CANONICAL_PATHS = TRANSACTION_PATHS.rebase;

interface FileFact {
  path: string;
  sha256: string;
  bytes: number;
}

interface PromptManifest {
  schema: string;
  version: number;
  upstream: {
    repository: string;
    commit: string;
    path: string;
    baseline: FileFact;
    license: FileFact;
    notice: FileFact;
  };
  patch: FileFact;
  output: FileFact;
  provenance: { path: string };
}

interface GeneratedPrompt {
  output: Buffer;
  provenance: Buffer;
}

interface WriteEntry {
  path: string;
  bytes: Buffer;
}

interface TransactionEntry {
  path: string;
  oldPath: string;
  oldSha256: string;
  oldBytes: number;
  newPath: string;
  newSha256: string;
  newBytes: number;
}

interface TransactionJournal {
  version: number;
  operation: TransactionOperation;
  state: "prepared" | "committed";
  entries: TransactionEntry[];
}

type TransactionOperation = keyof typeof TRANSACTION_PATHS;

interface MutationLockOwner {
  version: number;
  operation: TransactionOperation;
  pid: number;
  processStartIdentity: string;
  token: string;
  createdAtUnixMs: number;
}

interface MutationLockHandle {
  root: string;
  owner: MutationLockOwner;
  identity: FileIdentity;
}

interface ReclaimClaim {
  version: number;
  pid: number;
  processStartIdentity: string;
  token: string;
  createdAtUnixMs: number;
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface MutationRuntime {
  hooks: MutationLockHooks | undefined;
  processIdentityProvider: ProcessIdentityProvider;
  incompleteLockGraceMs: number;
}

type TransactionTargetState = "old" | "new" | "both";

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
}

export interface FetchResponse {
  status: number;
  body: Uint8Array;
}

export type PromptFetcher = (url: string) => Promise<FetchResponse>;

export interface TransactionFault {
  promotionIndex: number;
  simulateCrash?: boolean;
}

export interface MutationLockHooks {
  afterAcquire?: () => Promise<void>;
  beforeOwnerWrite?: () => Promise<void>;
  afterStaleQuarantine?: (lockPath: string) => Promise<void>;
  afterReleaseQuarantine?: (releasePath: string) => Promise<void>;
}

export interface ProcessIdentityProvider {
  processStartIdentity(pid: number): Promise<string | undefined>;
}

interface MutationOptions {
  lockHooks?: MutationLockHooks;
  processIdentityProvider?: ProcessIdentityProvider;
  incompleteLockGraceMs?: number;
}

export class PromptLayerError extends Error {}

class SimulatedTransactionCrash extends Error {}

export async function buildPrompt(
  repoRoot = defaultRepoRoot(),
  options: MutationOptions = {},
): Promise<void> {
  const root = await canonicalRepoRoot(repoRoot);
  await withMutationLock(root, "build", options, async () => {
    await recoverPendingTransaction(root);
    const generated = await generatePrompt(root);
    await commitWriteSet(root, "build", [
      { path: OUTPUT_PATH, bytes: generated.output },
      { path: PROVENANCE_PATH, bytes: generated.provenance },
    ]);
  });
}

export async function checkPrompt(
  repoRoot = defaultRepoRoot(),
  options: Pick<MutationOptions, "processIdentityProvider"> = {},
): Promise<void> {
  const root = await canonicalRepoRoot(repoRoot);
  await assertCanonicalContainment(root);
  await assertNoActiveMutation(
    root,
    options.processIdentityProvider ?? defaultProcessIdentityProvider,
  );
  await assertNoPendingTransaction(root);
  await checkPromptContents(root);
}

async function checkPromptContents(root: string): Promise<void> {
  const generated = await generatePrompt(root);
  await compareGenerated(
    join(root, OUTPUT_PATH),
    generated.output,
    "applied prompt",
  );
  await compareGenerated(
    join(root, PROVENANCE_PATH),
    generated.provenance,
    "prompt provenance",
  );
}

export async function authorPromptPatch(
  repoRoot = defaultRepoRoot(),
  candidatePath?: string,
  options: {
    transactionFault?: TransactionFault;
    lockHooks?: MutationLockHooks;
    processIdentityProvider?: ProcessIdentityProvider;
    incompleteLockGraceMs?: number;
  } = {},
): Promise<void> {
  const root = await canonicalRepoRoot(repoRoot);
  await withMutationLock(root, "author", options, async () => {
    await recoverPendingTransaction(root);
    const manifest = await readManifest(root);
    const baseline = await verifiedFile(
      root,
      manifest.upstream.baseline,
      "baseline",
    );
    await verifiedFile(root, manifest.upstream.license, "LICENSE");
    await verifiedFile(root, manifest.upstream.notice, "NOTICE");
    await verifiedFile(root, manifest.patch, "patch");

    const candidate = await readRequiredFile(
      resolve(candidatePath ?? join(root, OUTPUT_PATH)),
      "reviewed prompt candidate",
    );
    validateText(candidate, "reviewed prompt candidate");
    rejectMachinePaths(candidate, "reviewed prompt candidate");
    validateOutputProvenance(
      candidate,
      manifest.upstream.commit,
      manifest.upstream.path,
    );
    const patch = await createPatch(
      baseline,
      candidate,
      manifest.upstream.path,
    );
    validatePatch(patch, manifest.upstream.path, baseline);
    const applied = await applyPatchStrict(
      baseline,
      patch,
      manifest.upstream.path,
    );
    if (!applied.equals(candidate)) {
      throw new PromptLayerError(
        "Generated patch does not reproduce the reviewed prompt candidate exactly.",
      );
    }

    const updated = structuredClone(manifest);
    updated.patch = fileFact(PATCH_PATH, patch);
    updated.output = fileFact(OUTPUT_PATH, candidate);
    const provenance = provenanceBytes(updated);
    await commitWriteSet(
      root,
      "author",
      [
        { path: PATCH_PATH, bytes: patch },
        { path: MANIFEST_PATH, bytes: manifestBytes(updated) },
        { path: OUTPUT_PATH, bytes: candidate },
        { path: PROVENANCE_PATH, bytes: provenance },
      ],
      options.transactionFault,
    );

    const regenerated = await generatePrompt(root);
    if (!regenerated.output.equals(candidate)) {
      throw new PromptLayerError(
        "Authored prompt failed exact replay verification.",
      );
    }
  });
}

export async function rebasePrompt(
  repoRoot: string,
  commit: string,
  options: {
    candidatePath?: string;
    fetcher?: PromptFetcher;
    transactionFault?: TransactionFault;
    lockHooks?: MutationLockHooks;
    processIdentityProvider?: ProcessIdentityProvider;
    incompleteLockGraceMs?: number;
  } = {},
): Promise<void> {
  parseImmutableCommit(commit);
  const root = await canonicalRepoRoot(repoRoot);
  await withMutationLock(root, "rebase", options, async () => {
    await recoverPendingTransaction(root);
    const current = await readManifest(root);
    const currentBaseline = await verifiedFile(
      root,
      current.upstream.baseline,
      "baseline",
    );
    await verifiedFile(root, current.upstream.license, "LICENSE");
    await verifiedFile(root, current.upstream.notice, "NOTICE");
    const existingPatch = await verifiedFile(root, current.patch, "patch");
    validatePatch(existingPatch, current.upstream.path, currentBaseline);
    await applyPatchStrict(
      currentBaseline,
      existingPatch,
      current.upstream.path,
    );

    const fetcher = options.fetcher ?? networkFetcher;
    const [baseline, license, notice] = await Promise.all([
      fetchOfficial(fetcher, commit, UPSTREAM_PATH),
      fetchOfficial(fetcher, commit, "LICENSE"),
      fetchOfficial(fetcher, commit, "NOTICE"),
    ]);
    validateText(baseline, "rebased baseline");
    validateText(license, "rebased LICENSE");
    validateText(notice, "rebased NOTICE");

    if (options.candidatePath === undefined) {
      let replay: string;
      try {
        const attempted = await applyPatchStrict(
          baseline,
          existingPatch,
          UPSTREAM_PATH,
        );
        const digest = sha256(attempted);
        const relation =
          digest === current.output.sha256 ? "matches" : "differs from";
        replay = `old patch output ${digest} ${relation} the current applied output`;
      } catch (error) {
        replay = `old patch strict replay failed: ${errorMessage(error)}`;
      }
      throw new PromptLayerError(
        `Fetched baseline ${sha256(baseline)} at ${commit}; ${replay}. The newly fetched inputs were not applied. Recovery of a valid prior interrupted transaction and mutation-lock cleanup may have occurred; review the fetched baseline and replay with --candidate <path>.`,
      );
    }

    const candidate = await readRequiredFile(
      resolve(options.candidatePath),
      "reviewed rebase candidate",
    );
    validateText(candidate, "reviewed rebase candidate");
    rejectMachinePaths(candidate, "reviewed rebase candidate");
    validateOutputProvenance(candidate, commit, UPSTREAM_PATH);
    const patch = await createPatch(baseline, candidate, UPSTREAM_PATH);
    validatePatch(patch, UPSTREAM_PATH, baseline);
    const reapplied = await applyPatchStrict(baseline, patch, UPSTREAM_PATH);
    if (!reapplied.equals(candidate)) {
      throw new PromptLayerError(
        "Rebased patch does not reproduce the reviewed candidate exactly.",
      );
    }

    const updated = structuredClone(current);
    updated.upstream.commit = commit;
    updated.upstream.baseline = fileFact(BASELINE_PATH, baseline);
    updated.upstream.license = fileFact(LICENSE_PATH, license);
    updated.upstream.notice = fileFact(NOTICE_PATH, notice);
    updated.patch = fileFact(PATCH_PATH, patch);
    updated.output = fileFact(OUTPUT_PATH, candidate);

    await commitWriteSet(
      root,
      "rebase",
      [
        { path: BASELINE_PATH, bytes: baseline },
        { path: LICENSE_PATH, bytes: license },
        { path: NOTICE_PATH, bytes: notice },
        { path: PATCH_PATH, bytes: patch },
        { path: MANIFEST_PATH, bytes: manifestBytes(updated) },
        { path: OUTPUT_PATH, bytes: candidate },
        { path: PROVENANCE_PATH, bytes: provenanceBytes(updated) },
      ],
      options.transactionFault,
    );
    await checkPromptContents(root);
  });
}

export function parseImmutableCommit(value: string): string {
  if (!COMMIT.test(value)) {
    throw new PromptLayerError(
      "Prompt rebase requires one lowercase, immutable 40-hex commit.",
    );
  }
  return value;
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

async function generatePrompt(root: string): Promise<GeneratedPrompt> {
  const manifest = await readManifest(root);
  const baseline = await verifiedFile(
    root,
    manifest.upstream.baseline,
    "baseline",
  );
  await verifiedFile(root, manifest.upstream.license, "LICENSE");
  await verifiedFile(root, manifest.upstream.notice, "NOTICE");
  const patch = await verifiedFile(root, manifest.patch, "patch");
  validatePatch(patch, manifest.upstream.path, baseline);
  const output = await applyPatchStrict(
    baseline,
    patch,
    manifest.upstream.path,
  );
  verifyFact(output, manifest.output, "applied output");
  rejectMachinePaths(output, "applied output");
  validateOutputProvenance(
    output,
    manifest.upstream.commit,
    manifest.upstream.path,
  );
  return { output, provenance: provenanceBytes(manifest) };
}

async function readManifest(root: string): Promise<PromptManifest> {
  const bytes = await readRequiredFile(
    join(root, MANIFEST_PATH),
    "prompt manifest",
  );
  validateText(bytes, "prompt manifest");
  rejectMachinePaths(bytes, "prompt manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt manifest is invalid JSON: ${errorMessage(error)}`,
    );
  }
  const object = record(parsed, "prompt manifest");
  assertKeys(
    object,
    ["schema", "version", "upstream", "patch", "output", "provenance"],
    "prompt manifest",
  );
  const upstream = record(object["upstream"], "manifest upstream");
  assertKeys(
    upstream,
    ["repository", "commit", "path", "baseline", "license", "notice"],
    "manifest upstream",
  );
  const provenance = record(object["provenance"], "manifest provenance");
  assertKeys(provenance, ["path"], "manifest provenance");
  const manifest: PromptManifest = {
    schema: stringValue(object["schema"], "schema"),
    version: numberValue(object["version"], "version"),
    upstream: {
      repository: stringValue(upstream["repository"], "upstream repository"),
      commit: stringValue(upstream["commit"], "upstream commit"),
      path: stringValue(upstream["path"], "upstream path"),
      baseline: fileFactValue(upstream["baseline"], "baseline", BASELINE_PATH),
      license: fileFactValue(upstream["license"], "LICENSE", LICENSE_PATH),
      notice: fileFactValue(upstream["notice"], "NOTICE", NOTICE_PATH),
    },
    patch: fileFactValue(object["patch"], "patch", PATCH_PATH),
    output: fileFactValue(object["output"], "output", OUTPUT_PATH),
    provenance: {
      path: stringValue(provenance["path"], "provenance path"),
    },
  };
  if (manifest.schema !== SCHEMA || manifest.version !== VERSION) {
    throw new PromptLayerError(
      "Unsupported prompt manifest schema or version.",
    );
  }
  if (
    manifest.upstream.repository !== OFFICIAL_REPOSITORY ||
    manifest.upstream.path !== UPSTREAM_PATH ||
    manifest.provenance.path !== PROVENANCE_PATH ||
    !COMMIT.test(manifest.upstream.commit)
  ) {
    throw new PromptLayerError(
      "Prompt manifest contains an invalid ref or path.",
    );
  }
  return manifest;
}

function fileFactValue(
  value: unknown,
  label: string,
  expectedPath: string,
): FileFact {
  const object = record(value, `${label} fact`);
  assertKeys(object, ["path", "sha256", "bytes"], `${label} fact`);
  const fact = {
    path: stringValue(object["path"], `${label} path`),
    sha256: stringValue(object["sha256"], `${label} sha256`),
    bytes: numberValue(object["bytes"], `${label} bytes`),
  };
  if (
    fact.path !== expectedPath ||
    !SHA256.test(fact.sha256) ||
    !Number.isSafeInteger(fact.bytes) ||
    fact.bytes < 1
  ) {
    throw new PromptLayerError(`Prompt manifest has an invalid ${label} fact.`);
  }
  return fact;
}

async function verifiedFile(
  root: string,
  fact: FileFact,
  label: string,
): Promise<Buffer> {
  const bytes = await readRequiredFile(join(root, fact.path), label);
  validateText(bytes, label);
  verifyFact(bytes, fact, label);
  return bytes;
}

function verifyFact(bytes: Buffer, fact: FileFact, label: string): void {
  if (bytes.byteLength !== fact.bytes || sha256(bytes) !== fact.sha256) {
    throw new PromptLayerError(
      `${label} does not match its pinned digest and byte count.`,
    );
  }
}

async function applyPatchStrict(
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

async function createPatch(
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

async function fetchOfficial(
  fetcher: PromptFetcher,
  commit: string,
  path: string,
): Promise<Buffer> {
  const url = `${RAW_ORIGIN}/${commit}/${path}`;
  let response: FetchResponse;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new PromptLayerError(
      `Failed to fetch ${path}: ${errorMessage(error)}`,
    );
  }
  if (response.status !== 200) {
    throw new PromptLayerError(
      `Failed to fetch ${path}: HTTP ${response.status}.`,
    );
  }
  const body = Buffer.from(response.body);
  if (body.byteLength === 0) {
    throw new PromptLayerError(`Failed to fetch ${path}: empty response.`);
  }
  return body;
}

async function networkFetcher(url: string): Promise<FetchResponse> {
  const response = await fetch(url, { redirect: "error" });
  return {
    status: response.status,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

function provenanceBytes(manifest: PromptManifest): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: SCHEMA,
        version: VERSION,
        baselineRole:
          "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline",
        upstream: {
          repository: manifest.upstream.repository,
          commit: manifest.upstream.commit,
          path: manifest.upstream.path,
          sha256: manifest.upstream.baseline.sha256,
          bytes: manifest.upstream.baseline.bytes,
        },
        patch: {
          sha256: manifest.patch.sha256,
          bytes: manifest.patch.bytes,
        },
        output: {
          sha256: manifest.output.sha256,
          bytes: manifest.output.bytes,
        },
        legal: {
          license: {
            sha256: manifest.upstream.license.sha256,
            bytes: manifest.upstream.license.bytes,
          },
          notice: {
            sha256: manifest.upstream.notice.sha256,
            bytes: manifest.upstream.notice.bytes,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function manifestBytes(manifest: PromptManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function fileFact(path: string, bytes: Buffer): FileFact {
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobId(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function validateText(bytes: Buffer, label: string): void {
  if (
    bytes.includes(0) ||
    bytes.includes(13) ||
    bytes.byteLength === 0 ||
    bytes.at(-1) !== 10
  ) {
    throw new PromptLayerError(
      `${label} must be non-empty LF-only text ending in LF.`,
    );
  }
}

function rejectMachinePaths(bytes: Buffer, label: string): void {
  if (MACHINE_PATH.test(bytes.toString("utf8"))) {
    throw new PromptLayerError(`${label} contains a machine-specific path.`);
  }
}

function validateOutputProvenance(
  output: Buffer,
  commit: string,
  upstreamPath: string,
): void {
  const text = output.toString("utf8");
  const header = canonicalProvenanceHeader(commit, upstreamPath);
  if (!text.startsWith(header)) {
    throw new PromptLayerError(
      "Applied prompt must begin at byte zero with the exact canonical generic-baseline provenance header.",
    );
  }
  if (text.split(PROVENANCE_MARKER).length !== 2) {
    throw new PromptLayerError(
      "Applied prompt contains duplicate or contradictory provenance claims.",
    );
  }
  if (PROVENANCE_FIELD.test(text.slice(header.length))) {
    throw new PromptLayerError(
      "Applied prompt contains a later hidden provenance claim.",
    );
  }
}

function canonicalProvenanceHeader(
  commit: string,
  upstreamPath: string,
): string {
  return `<!--\n${PROVENANCE_MARKER}\nRepository: ${OFFICIAL_REPOSITORY}\nCommit: ${commit}\nPath: ${upstreamPath}\nBaseline role: pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline\n-->\n\n`;
}

function validateSafeRelativePath(path: string): void {
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PromptLayerError("Prompt patch path must be safe and relative.");
  }
}

async function compareGenerated(
  path: string,
  expected: Buffer,
  label: string,
): Promise<void> {
  const actual = await readRequiredFile(path, label);
  if (!actual.equals(expected)) {
    throw new PromptLayerError(
      `${label} diverges from the checksum-locked prompt layer; run \`bun run prompt:build\`.`,
    );
  }
}

async function canonicalRepoRoot(repoRoot: string): Promise<string> {
  const absolute = resolve(repoRoot);
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory()) {
    throw new PromptLayerError("Prompt repository root must be a directory.");
  }
  return realpath(absolute);
}

async function assertCanonicalContainment(root: string): Promise<void> {
  for (const path of CANONICAL_PATHS) {
    await assertContainedPath(root, path, true);
  }
  await assertContainedPath(root, TRANSACTION_PATH, false);
  await assertContainedPath(root, LOCK_PATH, false);
}

async function withMutationLock<T>(
  root: string,
  operation: TransactionOperation,
  options: MutationOptions,
  work: () => Promise<T>,
): Promise<T> {
  await assertCanonicalContainment(root);
  const runtime = mutationRuntime(options);
  const lock = await acquireMutationLock(root, operation, runtime);
  try {
    await runtime.hooks?.afterAcquire?.();
    return await work();
  } finally {
    await releaseMutationLock(lock, runtime);
  }
}

async function acquireMutationLock(
  root: string,
  operation: TransactionOperation,
  runtime: MutationRuntime,
): Promise<MutationLockHandle> {
  await cleanupMutationOrphans(root, runtime.processIdentityProvider, true);
  const owner = await newLockOwner(operation, runtime.processIdentityProvider);
  const created = await createMutationLock(root, owner, runtime.hooks);
  if (created !== undefined) {
    return created;
  }
  return reclaimStaleMutationLock(root, owner, runtime);
}

function mutationRuntime(options: MutationOptions): MutationRuntime {
  const grace = options.incompleteLockGraceMs ?? INCOMPLETE_LOCK_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0) {
    throw new PromptLayerError(
      "Prompt mutation incomplete-lock grace must be a non-negative safe integer.",
    );
  }
  return {
    hooks: options.lockHooks,
    processIdentityProvider:
      options.processIdentityProvider ?? defaultProcessIdentityProvider,
    incompleteLockGraceMs: grace,
  };
}

async function newLockOwner(
  operation: TransactionOperation,
  provider: ProcessIdentityProvider,
): Promise<MutationLockOwner> {
  const processStartIdentity = await provider.processStartIdentity(process.pid);
  if (!validProcessStartIdentity(processStartIdentity)) {
    throw new PromptLayerError(
      "Cannot establish the current process start identity; refusing to publish a mutation lock.",
    );
  }
  return {
    version: LOCK_VERSION,
    operation,
    pid: process.pid,
    processStartIdentity,
    token: randomUUID(),
    createdAtUnixMs: Date.now(),
  };
}

async function createMutationLock(
  root: string,
  owner: MutationLockOwner,
  hooks?: MutationLockHooks,
): Promise<MutationLockHandle | undefined> {
  await assertContainedPath(root, LOCK_PATH, false);
  const lockPath = join(root, LOCK_PATH);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return undefined;
    }
    throw error;
  }
  await syncDirectory(dirname(lockPath));
  const identity = fileIdentity(await lstat(lockPath));
  try {
    await hooks?.beforeOwnerWrite?.();
    await assertFilesystemIdentity(
      lockPath,
      identity,
      "Prompt mutation lock changed before owner publication.",
    );
    await assertContainedPath(root, LOCK_OWNER_PATH, false);
    await writeDurably(join(root, LOCK_OWNER_PATH), lockOwnerBytes(owner));
    await verifyOwnedLock(root, identity, owner, "initialization");
  } catch (error) {
    await removeOwnedLockDirectory(root, identity, owner.token);
    throw error;
  }
  return { root, owner, identity };
}

async function reclaimStaleMutationLock(
  root: string,
  replacement: MutationLockOwner,
  runtime: MutationRuntime,
): Promise<MutationLockHandle> {
  await assertContainedPath(root, LOCK_PATH, true);
  const lockMetadata = await lstat(join(root, LOCK_PATH));
  if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) {
    throw new PromptLayerError("Prompt mutation lock is not a safe directory.");
  }
  const identity = fileIdentity(lockMetadata);
  const current = await readExistingLockOwner(
    root,
    lockMetadata.mtimeMs,
    runtime.incompleteLockGraceMs,
  );
  if (current !== undefined) {
    await assertOwnerIsStale(current, runtime.processIdentityProvider);
  }
  const reclaimPath = `${LOCK_PATH}/reclaim.json`;
  await clearStaleReclaimClaim(root, reclaimPath, identity, runtime);
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    identity,
    "Prompt mutation lock changed before reclaim publication.",
  );
  await assertContainedPath(root, reclaimPath, false);
  try {
    await writeDurably(
      join(root, reclaimPath),
      Buffer.from(
        `${JSON.stringify(
          {
            version: LOCK_VERSION,
            pid: process.pid,
            processStartIdentity: replacement.processStartIdentity,
            token: replacement.token,
            createdAtUnixMs: Date.now(),
          },
          null,
          2,
        )}\n`,
      ),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new PromptLayerError(
        "Another process is already reclaiming the stale prompt mutation lock.",
      );
    }
    throw error;
  }
  await verifyReclaimIdentity(root, current, identity, runtime);
  const quarantineToken = current?.token ?? replacement.token;
  const quarantine = `${PROMPT_LAYER_ASSET_ROOT}/.mutation-stale-${quarantineToken}`;
  await assertContainedPath(root, quarantine, false);
  await verifyReclaimIdentity(root, current, identity, runtime);
  await rename(join(root, LOCK_PATH), join(root, quarantine));
  await syncDirectory(dirname(join(root, LOCK_PATH)));
  await assertFilesystemIdentity(
    join(root, quarantine),
    identity,
    "Prompt stale-lock quarantine did not preserve the reclaimed lock identity.",
  );
  await runtime.hooks?.afterStaleQuarantine?.(join(root, LOCK_PATH));
  const acquired = await createMutationLock(root, replacement, runtime.hooks);
  await removeOwnedTree(root, quarantine, identity);
  if (acquired === undefined) {
    throw new PromptLayerError(
      "A replacement prompt mutation owner acquired the lock during stale reclaim; it was preserved.",
    );
  }
  return acquired;
}

async function clearStaleReclaimClaim(
  root: string,
  reclaimPath: string,
  lockIdentity: FileIdentity,
  runtime: MutationRuntime,
): Promise<void> {
  const absolute = join(root, reclaimPath);
  if (!(await pathExists(absolute))) {
    return;
  }
  await assertContainedPath(root, reclaimPath, true);
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    lockIdentity,
    "Prompt mutation lock changed while inspecting its reclaim claim.",
  );
  const claimIdentity = fileIdentity(await lstat(absolute));
  let claim: ReclaimClaim;
  try {
    const bytes = await readRequiredFile(absolute, "prompt lock reclaim claim");
    validateText(bytes, "prompt lock reclaim claim");
    claim = reclaimClaimValue(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    const metadata = await lstat(absolute);
    if (Date.now() - metadata.mtimeMs < runtime.incompleteLockGraceMs) {
      throw new PromptLayerError(
        `Prompt lock reclaim claim is incomplete inside its bounded grace period: ${errorMessage(error)}`,
      );
    }
    await assertFilesystemIdentity(
      absolute,
      claimIdentity,
      "Prompt reclaim claim changed before incomplete-claim cleanup.",
    );
    await assertFilesystemIdentity(
      join(root, LOCK_PATH),
      lockIdentity,
      "Prompt mutation lock changed before incomplete-claim cleanup.",
    );
    await rm(absolute);
    await syncDirectory(dirname(absolute));
    return;
  }
  const state = await processOwnerState(claim, runtime.processIdentityProvider);
  if (state !== "stale") {
    throw new PromptLayerError(
      `Prompt mutation lock reclaim is owned by live pid ${claim.pid}.`,
    );
  }
  await assertFilesystemIdentity(
    absolute,
    claimIdentity,
    "Prompt reclaim claim changed before stale-claim cleanup.",
  );
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    lockIdentity,
    "Prompt mutation lock changed before stale-claim cleanup.",
  );
  await rm(absolute);
  await syncDirectory(dirname(absolute));
}

function reclaimClaimValue(value: unknown): ReclaimClaim {
  const object = record(value, "prompt lock reclaim claim");
  assertKeys(
    object,
    [
      "version",
      "pid",
      "processStartIdentity",
      "token",
      // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
      "createdAtUnixMs",
    ],
    "prompt lock reclaim claim",
  );
  const claim = {
    version: numberValue(object["version"], "reclaim version"),
    pid: numberValue(object["pid"], "reclaim pid"),
    processStartIdentity: stringValue(
      object["processStartIdentity"],
      "reclaim process start identity",
    ),
    token: stringValue(object["token"], "reclaim token"),
    createdAtUnixMs: numberValue(
      // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
      object["createdAtUnixMs"],
      "reclaim creation time",
    ),
  };
  if (
    claim.version !== LOCK_VERSION ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid < 1 ||
    !validProcessStartIdentity(claim.processStartIdentity) ||
    !TOKEN.test(claim.token) ||
    !Number.isSafeInteger(claim.createdAtUnixMs) ||
    claim.createdAtUnixMs < 1
  ) {
    throw new PromptLayerError("Prompt lock reclaim claim is invalid.");
  }
  return claim;
}

async function readExistingLockOwner(
  root: string,
  lockMtimeMs: number,
  graceMs: number,
): Promise<MutationLockOwner | undefined> {
  if (!(await pathExists(join(root, LOCK_OWNER_PATH)))) {
    if (Date.now() - lockMtimeMs < graceMs) {
      throw new PromptLayerError(
        "Prompt mutation lock initialization is incomplete and still inside its bounded grace period.",
      );
    }
    return undefined;
  }
  await assertContainedPath(root, LOCK_OWNER_PATH, true);
  const bytes = await readRequiredFile(
    join(root, LOCK_OWNER_PATH),
    "prompt mutation lock owner",
  );
  validateText(bytes, "prompt mutation lock owner");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt mutation lock owner is invalid: ${errorMessage(error)}`,
    );
  }
  return lockOwnerValue(parsed);
}

function lockOwnerValue(value: unknown): MutationLockOwner {
  const object = record(value, "prompt mutation lock owner");
  assertKeys(
    object,
    [
      "version",
      "operation",
      "pid",
      "processStartIdentity",
      "token",
      // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
      "createdAtUnixMs",
    ],
    "prompt mutation lock owner",
  );
  const version = numberValue(object["version"], "lock version");
  const operation = stringValue(object["operation"], "lock operation");
  const pid = numberValue(object["pid"], "lock pid");
  const processStartIdentity = stringValue(
    object["processStartIdentity"],
    "lock process start identity",
  );
  const token = stringValue(object["token"], "lock token");
  const createdAtUnixMs = numberValue(
    // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
    object["createdAtUnixMs"],
    "lock creation time",
  );
  if (
    version !== LOCK_VERSION ||
    !isTransactionOperation(operation) ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !validProcessStartIdentity(processStartIdentity) ||
    !TOKEN.test(token) ||
    !Number.isSafeInteger(createdAtUnixMs) ||
    createdAtUnixMs < 1
  ) {
    throw new PromptLayerError("Prompt mutation lock owner is invalid.");
  }
  return {
    version,
    operation,
    pid,
    processStartIdentity,
    token,
    createdAtUnixMs,
  };
}

async function verifyReclaimIdentity(
  root: string,
  expected: MutationLockOwner | undefined,
  expectedIdentity: FileIdentity,
  runtime: MutationRuntime,
): Promise<void> {
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    expectedIdentity,
    "Prompt mutation lock changed during stale-owner reclaim.",
  );
  if (expected === undefined) {
    if (await pathExists(join(root, LOCK_OWNER_PATH))) {
      throw new PromptLayerError(
        "Prompt mutation lock acquired an owner during stale reclaim.",
      );
    }
    return;
  }
  const current = await readExistingLockOwner(
    root,
    expected.createdAtUnixMs,
    runtime.incompleteLockGraceMs,
  );
  if (
    current === undefined ||
    current.pid !== expected.pid ||
    current.processStartIdentity !== expected.processStartIdentity ||
    current.token !== expected.token
  ) {
    throw new PromptLayerError(
      "Prompt mutation lock ownership changed during stale reclaim.",
    );
  }
  await assertOwnerIsStale(current, runtime.processIdentityProvider);
}

async function releaseMutationLock(
  lock: MutationLockHandle,
  runtime: MutationRuntime,
): Promise<void> {
  await assertFilesystemIdentity(
    join(lock.root, LOCK_PATH),
    lock.identity,
    "Prompt mutation lock identity changed before release.",
  );
  await assertContainedPath(lock.root, LOCK_OWNER_PATH, true);
  const current = await readExistingLockOwner(
    lock.root,
    lock.owner.createdAtUnixMs,
    runtime.incompleteLockGraceMs,
  );
  if (!sameLockOwner(current, lock.owner)) {
    throw new PromptLayerError(
      "Prompt mutation lock ownership changed before release; refusing deletion.",
    );
  }
  const releasePath = `${PROMPT_LAYER_ASSET_ROOT}/.mutation-release-${lock.owner.token}`;
  await assertContainedPath(lock.root, releasePath, false);
  await verifyOwnedLock(lock.root, lock.identity, lock.owner, "release");
  await rename(join(lock.root, LOCK_PATH), join(lock.root, releasePath));
  await syncDirectory(dirname(join(lock.root, LOCK_PATH)));
  await assertFilesystemIdentity(
    join(lock.root, releasePath),
    lock.identity,
    "Prompt release quarantine did not preserve the acquired lock identity.",
  );
  await runtime.hooks?.afterReleaseQuarantine?.(join(lock.root, releasePath));
  await removeOwnedTree(lock.root, releasePath, lock.identity);
}

async function assertNoActiveMutation(
  root: string,
  provider: ProcessIdentityProvider,
): Promise<void> {
  await cleanupMutationOrphans(root, provider, false);
  await assertContainedPath(root, LOCK_PATH, false);
  if (await pathExists(join(root, LOCK_PATH))) {
    throw new PromptLayerError(
      "A prompt mutation is active; prompt:check refuses to recover or write.",
    );
  }
}

function lockOwnerBytes(owner: MutationLockOwner): Buffer {
  return Buffer.from(`${JSON.stringify(owner, null, 2)}\n`);
}

const defaultProcessIdentityProvider: ProcessIdentityProvider = {
  async processStartIdentity(pid: number): Promise<string | undefined> {
    if (process.platform === "linux") {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        if (commandEnd < 0) {
          return undefined;
        }
        const fields = stat
          .slice(commandEnd + 1)
          .trim()
          .split(WHITESPACE);
        const startTicks = fields[19];
        return startTicks === undefined ? undefined : `linux:${startTicks}`;
      } catch {
        return undefined;
      }
    }
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["/bin/ps", "-o", "lstart=", "-p", String(pid)],
        {
          env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      if (result.exitCode !== 0) {
        return undefined;
      }
      return normalizeDarwinProcessStartOutput(result.stdout.toString());
    }
    return undefined;
  },
};

export function normalizeDarwinProcessStartOutput(
  output: string,
): string | undefined {
  const normalized = output.trim().replace(ALL_WHITESPACE, " ");
  const match = DARWIN_PS_LSTART.exec(normalized);
  if (match === null) {
    return undefined;
  }
  const [
    ,
    weekdayName,
    monthName,
    dayText,
    hourText,
    minuteText,
    secondText,
    yearText,
  ] = match;
  if (
    weekdayName === undefined ||
    monthName === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined ||
    yearText === undefined
  ) {
    return undefined;
  }
  const weekday = DARWIN_WEEKDAYS.indexOf(weekdayName);
  const month = DARWIN_MONTHS.indexOf(monthName);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const year = Number(yearText);
  if (weekday < 0 || month < 0) {
    return undefined;
  }
  const epochMs = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(epochMs);
  if (
    !Number.isFinite(epochMs) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCDay() !== weekday
  ) {
    return undefined;
  }
  return `darwin:${epochMs / 1000}`;
}

function validProcessStartIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !LINE_BREAK.test(value)
  );
}

async function processOwnerState(
  owner: Pick<MutationLockOwner, "pid" | "processStartIdentity">,
  provider: ProcessIdentityProvider,
): Promise<"live" | "stale" | "unknown"> {
  if (!processExists(owner.pid)) {
    return "stale";
  }
  let actual: string | undefined;
  try {
    actual = await provider.processStartIdentity(owner.pid);
  } catch {
    return "unknown";
  }
  if (!validProcessStartIdentity(actual)) {
    return "unknown";
  }
  return actual === owner.processStartIdentity ? "live" : "stale";
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (code === "EPERM") {
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function assertOwnerIsStale(
  owner: MutationLockOwner,
  provider: ProcessIdentityProvider,
): Promise<void> {
  const state = await processOwnerState(owner, provider);
  if (state === "stale") {
    return;
  }
  if (state === "unknown") {
    throw new PromptLayerError(
      `Cannot verify process-start identity for pid ${owner.pid}; refusing stale-lock recovery.`,
    );
  }
  throw new PromptLayerError(
    `Prompt mutation is owned by live pid ${owner.pid} (${owner.operation}); refusing concurrent recovery.`,
  );
}

function fileIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameFilesystemIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertFilesystemIdentity(
  path: string,
  expected: FileIdentity,
  message: string,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new PromptLayerError(message);
  }
  if (!sameFilesystemIdentity(fileIdentity(metadata), expected)) {
    throw new PromptLayerError(message);
  }
}

function sameLockOwner(
  actual: MutationLockOwner | undefined,
  expected: MutationLockOwner,
): boolean {
  return (
    actual !== undefined &&
    actual.version === expected.version &&
    actual.operation === expected.operation &&
    actual.pid === expected.pid &&
    actual.processStartIdentity === expected.processStartIdentity &&
    actual.token === expected.token &&
    actual.createdAtUnixMs === expected.createdAtUnixMs
  );
}

async function verifyOwnedLock(
  root: string,
  identity: FileIdentity,
  expected: MutationLockOwner,
  phase: string,
): Promise<void> {
  await assertFilesystemIdentity(
    join(root, LOCK_PATH),
    identity,
    `Prompt mutation lock identity changed during ${phase}.`,
  );
  const actual = await readOwnerFile(root, LOCK_OWNER_PATH);
  if (!sameLockOwner(actual, expected)) {
    throw new PromptLayerError(
      `Prompt mutation lock ownership changed during ${phase}.`,
    );
  }
}

async function readOwnerFile(
  root: string,
  relativeOwnerPath: string,
): Promise<MutationLockOwner> {
  await assertContainedPath(root, relativeOwnerPath, true);
  const bytes = await readRequiredFile(
    join(root, relativeOwnerPath),
    "prompt mutation lock owner",
  );
  validateText(bytes, "prompt mutation lock owner");
  try {
    return lockOwnerValue(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt mutation lock owner is invalid: ${errorMessage(error)}`,
    );
  }
}

async function removeOwnedLockDirectory(
  root: string,
  identity: FileIdentity,
  token: string,
): Promise<void> {
  const absolute = join(root, LOCK_PATH);
  try {
    await assertFilesystemIdentity(
      absolute,
      identity,
      "Prompt mutation lock changed before failed-initialization cleanup.",
    );
  } catch {
    return;
  }
  if (await pathExists(join(root, LOCK_OWNER_PATH))) {
    let owner: MutationLockOwner;
    try {
      owner = await readOwnerFile(root, LOCK_OWNER_PATH);
    } catch {
      return;
    }
    if (owner.token !== token) {
      return;
    }
  }
  const quarantine = `${PROMPT_LAYER_ASSET_ROOT}/.mutation-release-${token}`;
  if (await pathExists(join(root, quarantine))) {
    return;
  }
  await assertContainedPath(root, quarantine, false);
  await assertFilesystemIdentity(
    absolute,
    identity,
    "Prompt mutation lock changed before failed-initialization quarantine.",
  );
  await rename(absolute, join(root, quarantine));
  await syncDirectory(dirname(absolute));
  await removeOwnedTree(root, quarantine, identity);
}

async function removeOwnedTree(
  root: string,
  relativePath: string,
  identity: FileIdentity,
): Promise<void> {
  await assertContainedPath(root, relativePath, true);
  const absolute = join(root, relativePath);
  await assertFilesystemIdentity(
    absolute,
    identity,
    `Prompt lock artifact ${relativePath} changed before cleanup.`,
  );
  await rm(absolute, { recursive: true });
  await syncDirectory(dirname(absolute));
}

async function cleanupMutationOrphans(
  root: string,
  provider: ProcessIdentityProvider,
  write: boolean,
): Promise<void> {
  const layerPath = join(root, PROMPT_LAYER_ASSET_ROOT);
  const entries = await readdir(layerPath, { withFileTypes: true });
  for (const entry of entries) {
    const kind = mutationOrphanKind(entry.name);
    if (kind === undefined) {
      continue;
    }
    await cleanupMutationOrphan(root, entry, kind, provider, write);
  }
}

function mutationOrphanKind(name: string): "stale" | "release" | undefined {
  if (name.startsWith(".mutation-stale-")) {
    return "stale";
  }
  if (name.startsWith(".mutation-release-")) {
    return "release";
  }
  return undefined;
}

async function cleanupMutationOrphan(
  root: string,
  entry: Dirent,
  kind: "stale" | "release",
  provider: ProcessIdentityProvider,
  write: boolean,
): Promise<void> {
  const prefix = `.mutation-${kind}-`;
  const token = entry.name.slice(prefix.length);
  if (!TOKEN.test(token)) {
    throw new PromptLayerError(
      `Malformed prompt mutation ${kind} quarantine ${entry.name}; refusing cleanup.`,
    );
  }
  const relativePath = `${PROMPT_LAYER_ASSET_ROOT}/${entry.name}`;
  await assertContainedPath(root, relativePath, true);
  const absolute = join(root, relativePath);
  const metadata = await lstat(absolute);
  if (!entry.isDirectory() || metadata.isSymbolicLink()) {
    throw new PromptLayerError(
      `Prompt mutation ${kind} quarantine ${entry.name} is not a safe directory.`,
    );
  }
  const identity = fileIdentity(metadata);
  const owner = await readOwnerFile(root, `${relativePath}/owner.json`);
  if (owner.token !== token) {
    throw new PromptLayerError(
      `Prompt mutation ${kind} quarantine ${entry.name} does not match its owner token.`,
    );
  }
  const state = await processOwnerState(owner, provider);
  if (state !== "stale") {
    const detail = state === "live" ? "live" : "unverifiable";
    throw new PromptLayerError(
      `Prompt mutation ${kind} quarantine ${entry.name} has a ${detail} owner; refusing cleanup.`,
    );
  }
  if (!write) {
    throw new PromptLayerError(
      `A recoverable prompt mutation ${kind} quarantine is pending; prompt:check refuses to write or recover it.`,
    );
  }
  await removeOwnedTree(root, relativePath, identity);
}

/**
 * Containment protects against static symlinks and cooperating Skizzles writers
 * under the identity-bound exclusive lock. Node pathname APIs do not expose
 * dirfd/openat primitives, so this is not a race-free defense against an
 * unrelated malicious local process. Identity is rechecked immediately before
 * destructive pathname syscalls; detectable replacement races fail closed.
 */

async function assertContainedPath(
  root: string,
  relativePath: string,
  mustExist: boolean,
): Promise<void> {
  validateSafeRelativePath(relativePath);
  const absolute = resolve(root, relativePath);
  if (!isWithinRoot(root, absolute)) {
    throw new PromptLayerError(
      `Prompt path ${relativePath} escapes the real repository root.`,
    );
  }
  let current = root;
  for (const component of relativePath.split("/")) {
    current = join(current, component);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && !mustExist) {
        return;
      }
      throw new PromptLayerError(
        `Prompt path ${relativePath} cannot be safely inspected: ${errorMessage(error)}`,
      );
    }
    if (metadata.isSymbolicLink()) {
      throw new PromptLayerError(
        `Prompt path ${relativePath} has a symlinked ancestor or target.`,
      );
    }
    const resolved = await realpath(current);
    if (!isWithinRoot(root, resolved)) {
      throw new PromptLayerError(
        `Prompt path ${relativePath} resolves outside the repository root.`,
      );
    }
  }
}

function isWithinRoot(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) &&
      relation !== ".." &&
      !relation.startsWith(sep))
  );
}

async function commitWriteSet(
  root: string,
  operation: TransactionOperation,
  writes: WriteEntry[],
  fault?: TransactionFault,
): Promise<void> {
  validateWriteSet(operation, writes);
  await assertNoPendingTransaction(root);
  const transactionRoot = join(root, TRANSACTION_PATH);
  await assertCanonicalContainment(root);
  await assertContainedPath(root, TRANSACTION_PATH, false);
  await mkdir(dirname(transactionRoot), { recursive: true });
  await mkdir(transactionRoot);
  await syncDirectory(dirname(transactionRoot));
  let journalWritten = false;
  try {
    const journal = await stageTransaction(
      root,
      transactionRoot,
      operation,
      writes,
    );
    await assertContainedPath(root, TRANSACTION_JOURNAL_PATH, false);
    await writeAtomically(
      join(root, TRANSACTION_JOURNAL_PATH),
      transactionJournalBytes(journal),
    );
    journalWritten = true;
    await promoteTransaction(root, transactionRoot, journal.entries, fault);
    await verifyTransactionTargets(root, journal.entries, "new");
    journal.state = "committed";
    await assertContainedPath(root, TRANSACTION_JOURNAL_PATH, true);
    await writeAtomically(
      join(root, TRANSACTION_JOURNAL_PATH),
      transactionJournalBytes(journal),
    );
    await removeTreeDurably(root, TRANSACTION_PATH);
  } catch (error) {
    await handleTransactionFailure(root, journalWritten, error);
    throw error;
  }
}

async function stageTransaction(
  root: string,
  transactionRoot: string,
  operation: TransactionOperation,
  writes: WriteEntry[],
): Promise<TransactionJournal> {
  const entries: TransactionEntry[] = [];
  for (const [index, write] of writes.entries()) {
    validateText(write.bytes, `transaction target ${write.path}`);
    await assertContainedPath(root, write.path, true);
    const original = await readRequiredFile(
      join(root, write.path),
      `transaction original ${write.path}`,
    );
    const oldPath = `old-${index}`;
    const newPath = `new-${index}`;
    await assertContainedPath(root, `${TRANSACTION_PATH}/${oldPath}`, false);
    await assertContainedPath(root, `${TRANSACTION_PATH}/${newPath}`, false);
    await writeDurably(join(transactionRoot, oldPath), original);
    await writeDurably(join(transactionRoot, newPath), write.bytes);
    entries.push({
      path: write.path,
      oldPath,
      oldSha256: sha256(original),
      oldBytes: original.byteLength,
      newPath,
      newSha256: sha256(write.bytes),
      newBytes: write.bytes.byteLength,
    });
  }
  return {
    version: TRANSACTION_VERSION,
    operation,
    state: "prepared",
    entries,
  };
}

async function promoteTransaction(
  root: string,
  transactionRoot: string,
  entries: TransactionEntry[],
  fault?: TransactionFault,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    throwInjectedPromotionFault(fault, index);
    await assertContainedPath(
      root,
      `${TRANSACTION_PATH}/${entry.newPath}`,
      true,
    );
    await assertContainedPath(root, entry.path, true);
    await rename(join(transactionRoot, entry.newPath), join(root, entry.path));
    await syncDirectory(dirname(join(root, entry.path)));
    await syncDirectory(transactionRoot);
  }
}

function throwInjectedPromotionFault(
  fault: TransactionFault | undefined,
  index: number,
): void {
  if (fault?.promotionIndex !== index) {
    return;
  }
  if (fault.simulateCrash === true) {
    throw new SimulatedTransactionCrash(
      `Simulated transaction crash before promotion ${index}.`,
    );
  }
  throw new PromptLayerError(
    `Injected transaction promotion failure at ${index}.`,
  );
}

async function handleTransactionFailure(
  root: string,
  journalWritten: boolean,
  error: unknown,
): Promise<void> {
  if (error instanceof SimulatedTransactionCrash) {
    throw error;
  }
  if (!journalWritten) {
    await removeTreeDurably(root, TRANSACTION_PATH);
    return;
  }
  try {
    await rollbackPreparedTransaction(root);
  } catch (rollbackError) {
    throw new PromptLayerError(
      `Prompt transaction failed and rollback could not complete safely: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
    );
  }
}

async function recoverPendingTransaction(root: string): Promise<void> {
  const transactionRoot = join(root, TRANSACTION_PATH);
  if (!(await pathExists(transactionRoot))) {
    return;
  }
  const journal = await readTransactionJournal(root);
  if (journal.state === "prepared") {
    await rollbackPreparedTransaction(root, journal);
    return;
  }
  const states = await preflightTransactionTargets(root, journal.entries);
  await preflightTransactionNewArtifacts(root, journal.entries, states);
  if (states.some((state) => state === "old")) {
    throw new PromptLayerError(
      "Committed prompt transaction targets are not all in the journaled new state; refusing cleanup.",
    );
  }
  await verifyTransactionTargets(root, journal.entries, "new");
  await removeTreeDurably(root, TRANSACTION_PATH);
}

async function assertNoPendingTransaction(root: string): Promise<void> {
  if (await pathExists(join(root, TRANSACTION_PATH))) {
    throw new PromptLayerError(
      "A prompt transaction is pending; prompt:check refuses to write or recover it. Run prompt:build to recover safely.",
    );
  }
}

async function rollbackPreparedTransaction(
  root: string,
  supplied?: TransactionJournal,
): Promise<void> {
  const journal = supplied ?? (await readTransactionJournal(root));
  if (journal.state !== "prepared") {
    throw new PromptLayerError(
      "Only a prepared prompt transaction can roll back.",
    );
  }
  const backups = await preflightTransactionBackups(root, journal.entries);
  const states = await preflightTransactionTargets(root, journal.entries);
  await preflightTransactionNewArtifacts(root, journal.entries, states);
  for (const [index, entry] of journal.entries.entries()) {
    if (states[index] === "new") {
      await assertContainedPath(root, entry.path, true);
      const backup = backups[index];
      if (backup === undefined) {
        throw new PromptLayerError(
          "Transaction rollback is missing a validated backup.",
        );
      }
      await writeAtomically(join(root, entry.path), backup);
    }
  }
  await verifyTransactionTargets(root, journal.entries, "old");
  await removeTreeDurably(root, TRANSACTION_PATH);
}

async function preflightTransactionBackups(
  root: string,
  entries: TransactionEntry[],
): Promise<Buffer[]> {
  const backups: Buffer[] = [];
  for (const entry of entries) {
    const backupPath = `${TRANSACTION_PATH}/${entry.oldPath}`;
    await assertContainedPath(root, backupPath, true);
    const original = await readRequiredFile(
      join(root, backupPath),
      `transaction backup ${entry.path}`,
    );
    if (
      original.byteLength !== entry.oldBytes ||
      sha256(original) !== entry.oldSha256
    ) {
      throw new PromptLayerError(
        `Prompt transaction backup for ${entry.path} is invalid; refusing unsafe recovery.`,
      );
    }
    backups.push(original);
  }
  return backups;
}

async function preflightTransactionTargets(
  root: string,
  entries: TransactionEntry[],
): Promise<TransactionTargetState[]> {
  const states: TransactionTargetState[] = [];
  for (const entry of entries) {
    await assertContainedPath(root, entry.path, true);
    const bytes = await readRequiredFile(
      join(root, entry.path),
      `transaction target ${entry.path}`,
    );
    const digest = sha256(bytes);
    const matchesOld =
      bytes.byteLength === entry.oldBytes && digest === entry.oldSha256;
    const matchesNew =
      bytes.byteLength === entry.newBytes && digest === entry.newSha256;
    if (matchesOld && matchesNew) {
      states.push("both");
      continue;
    }
    if (matchesOld) {
      states.push("old");
      continue;
    }
    if (matchesNew) {
      states.push("new");
      continue;
    }
    throw new PromptLayerError(
      `Prompt transaction target ${entry.path} is missing or externally changed; refusing recovery before any write.`,
    );
  }
  return states;
}

async function preflightTransactionNewArtifacts(
  root: string,
  entries: TransactionEntry[],
  states: TransactionTargetState[],
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    const stagedPath = `${TRANSACTION_PATH}/${entry.newPath}`;
    if (!(await pathExists(join(root, stagedPath)))) {
      if (states[index] === "old") {
        throw new PromptLayerError(
          `Prompt transaction staged content for ${entry.path} is missing before promotion.`,
        );
      }
      continue;
    }
    await assertContainedPath(root, stagedPath, true);
    const staged = await readRequiredFile(
      join(root, stagedPath),
      `transaction staged content ${entry.path}`,
    );
    if (
      staged.byteLength !== entry.newBytes ||
      sha256(staged) !== entry.newSha256
    ) {
      throw new PromptLayerError(
        `Prompt transaction staged content for ${entry.path} is invalid; refusing recovery.`,
      );
    }
  }
}

async function readTransactionJournal(
  root: string,
): Promise<TransactionJournal> {
  await assertContainedPath(root, TRANSACTION_JOURNAL_PATH, true);
  const bytes = await readRequiredFile(
    join(root, TRANSACTION_JOURNAL_PATH),
    "prompt transaction journal",
  );
  validateText(bytes, "prompt transaction journal");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt transaction journal is invalid; refusing unsafe recovery: ${errorMessage(error)}`,
    );
  }
  const object = record(parsed, "prompt transaction journal");
  assertKeys(
    object,
    ["version", "operation", "state", "entries"],
    "transaction journal",
  );
  const version = numberValue(object["version"], "transaction version");
  const operation = stringValue(object["operation"], "transaction operation");
  const state = stringValue(object["state"], "transaction state");
  const rawEntries = object["entries"];
  if (
    version !== TRANSACTION_VERSION ||
    !isTransactionOperation(operation) ||
    (state !== "prepared" && state !== "committed") ||
    !Array.isArray(rawEntries) ||
    rawEntries.length === 0
  ) {
    throw new PromptLayerError(
      "Prompt transaction journal has an unsupported shape; refusing unsafe recovery.",
    );
  }
  const entries = rawEntries.map((value, index) =>
    transactionEntryValue(value, index),
  );
  validateWritePaths(
    operation,
    entries.map((entry) => entry.path),
  );
  return { version, operation, state, entries };
}

function transactionEntryValue(
  value: unknown,
  index: number,
): TransactionEntry {
  const object = record(value, `transaction entry ${index}`);
  assertKeys(
    object,
    [
      "path",
      "oldPath",
      "oldSha256",
      "oldBytes",
      "newPath",
      "newSha256",
      "newBytes",
    ],
    `transaction entry ${index}`,
  );
  const entry = {
    path: stringValue(object["path"], "transaction target path"),
    oldPath: stringValue(object["oldPath"], "transaction backup path"),
    oldSha256: stringValue(object["oldSha256"], "transaction old digest"),
    oldBytes: numberValue(object["oldBytes"], "transaction old bytes"),
    newPath: stringValue(object["newPath"], "transaction staged path"),
    newSha256: stringValue(object["newSha256"], "transaction new digest"),
    newBytes: numberValue(object["newBytes"], "transaction new bytes"),
  };
  if (
    entry.oldPath !== `old-${index}` ||
    entry.newPath !== `new-${index}` ||
    !SHA256.test(entry.oldSha256) ||
    !SHA256.test(entry.newSha256) ||
    !Number.isSafeInteger(entry.oldBytes) ||
    !Number.isSafeInteger(entry.newBytes) ||
    entry.oldBytes < 1 ||
    entry.newBytes < 1
  ) {
    throw new PromptLayerError(
      "Prompt transaction entry is invalid; refusing unsafe recovery.",
    );
  }
  return entry;
}

async function verifyTransactionTargets(
  root: string,
  entries: TransactionEntry[],
  version: "old" | "new",
): Promise<void> {
  for (const entry of entries) {
    const bytes = await readRequiredFile(
      join(root, entry.path),
      `transaction target ${entry.path}`,
    );
    const expectedBytes = version === "old" ? entry.oldBytes : entry.newBytes;
    const expectedSha = version === "old" ? entry.oldSha256 : entry.newSha256;
    if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha) {
      throw new PromptLayerError(
        `Prompt transaction ${version} state for ${entry.path} cannot be verified.`,
      );
    }
  }
}

function validateWriteSet(
  operation: TransactionOperation,
  writes: WriteEntry[],
): void {
  validateWritePaths(
    operation,
    writes.map((write) => write.path),
  );
}

function validateWritePaths(
  operation: TransactionOperation,
  paths: string[],
): void {
  const expected = TRANSACTION_PATHS[operation];
  if (
    paths.length !== expected.length ||
    paths.some((path, index) => path !== expected[index])
  ) {
    throw new PromptLayerError(
      `Prompt ${operation} transaction does not match its exact ordered write set.`,
    );
  }
}

function isTransactionOperation(value: string): value is TransactionOperation {
  return value === "build" || value === "author" || value === "rebase";
}

function transactionJournalBytes(journal: TransactionJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}

async function writeDurably(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeAtomically(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    if (await pathExists(temporary)) {
      await rm(temporary, { force: true });
      await syncDirectory(dirname(path));
    }
  }
}

async function removeTreeDurably(
  root: string,
  relativePath: string,
): Promise<void> {
  await assertContainedPath(root, relativePath, true);
  const absolute = join(root, relativePath);
  await rm(absolute, { force: true, recursive: true });
  await syncDirectory(dirname(absolute));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readRequiredFile(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new PromptLayerError(`Cannot read ${label}: ${errorMessage(error)}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PromptLayerError(`${label} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertKeys(
  object: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new PromptLayerError(`${label} has missing or unsupported fields.`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PromptLayerError(`${label} must be a string.`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new PromptLayerError(`${label} must be a number.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function runCli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const root = defaultRepoRoot();
  switch (command) {
    case "build":
      if (args.length > 0) {
        throw new PromptLayerError("Usage: prompt:build");
      }
      await buildPrompt(root);
      break;
    case "check":
      if (args.length > 0) {
        throw new PromptLayerError("Usage: prompt:check");
      }
      await checkPrompt(root);
      break;
    case "patch":
      if (args.length > 1) {
        throw new PromptLayerError("Usage: prompt:patch -- [candidate-path]");
      }
      await authorPromptPatch(root, args[0]);
      break;
    case "rebase":
      await runRebaseCli(root, args);
      break;
    default:
      throw new PromptLayerError(
        // biome-ignore lint/security/noSecrets: This is the public CLI usage string, not a credential.
        "Usage: skizzles-prompt-layer <build|check|patch|rebase>",
      );
  }
}

async function runRebaseCli(root: string, args: string[]): Promise<void> {
  const commit = args[0];
  if (commit === undefined) {
    throw new PromptLayerError(
      "Usage: prompt:rebase -- <40-hex-commit> [--candidate <path>]",
    );
  }
  if (args.length === 1) {
    await rebasePrompt(root, commit);
    return;
  }
  if (args.length === 3 && args[1] === "--candidate" && args[2] !== undefined) {
    await rebasePrompt(root, commit, { candidatePath: args[2] });
    return;
  }
  throw new PromptLayerError(
    "Usage: prompt:rebase -- <40-hex-commit> [--candidate <path>]",
  );
}

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
