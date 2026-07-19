import { join, resolve } from "node:path";
import {
  compareGenerated,
  fileFact,
  manifestBytes,
  provenanceBytes,
  readManifest,
  rejectMachinePaths,
  validateOutputProvenance,
  verifiedFile,
  verifyFact,
} from "../assets/manifest.ts";
import {
  applyPatchStrict,
  createPatch,
  validatePatch,
} from "../assets/patch.ts";
import { fetchOfficial, networkFetcher } from "../assets/upstream.ts";
import { sha256, validateText } from "../content-integrity.ts";
import { assertNoActiveMutation, withMutationLock } from "../mutation/lock.ts";
import { defaultProcessIdentityProvider } from "../mutation/process-identity.ts";
import {
  assertCanonicalContainment,
  canonicalRepoRoot,
  defaultPromptRepoRoot,
  errorMessage,
  readRequiredFile,
} from "../repository-boundary.ts";
import { parseShippedLanguagePolicy } from "../shipped-language/policy.ts";
import {
  assertNoPendingTransaction,
  commitWriteSet,
  recoverPendingTransaction,
} from "../transaction/commit.ts";
import type {
  GeneratedPrompt,
  MutationOptions,
  PromptFetcher,
  TransactionFault,
} from "./contract.ts";
import {
  BASELINE_PATH,
  LICENSE_PATH,
  MANIFEST_PATH,
  NOTICE_PATH,
  OUTPUT_PATH,
  PATCH_PATH,
  PROVENANCE_PATH,
  PromptLayerError,
  SHIPPED_LANGUAGE_POLICY_PATHS,
  UPSTREAM_PATH,
} from "./contract.ts";
import { type PromptWorkspace, withPromptWorkspace } from "./workspace.ts";

const COMMIT = /^[0-9a-f]{40}$/;

interface AuthorPromptOptions extends MutationOptions {
  transactionFault?: TransactionFault;
}

interface RebasePromptOptions extends AuthorPromptOptions {
  candidatePath?: string;
  fetcher?: PromptFetcher;
}

export async function buildPrompt(
  repoRoot = defaultPromptRepoRoot(),
  options: MutationOptions = {},
): Promise<void> {
  await withPromptWorkspace(options.signal, (workspace) =>
    buildPromptWithWorkspace(repoRoot, options, workspace),
  );
}

async function buildPromptWithWorkspace(
  repoRoot: string,
  options: MutationOptions,
  workspace: PromptWorkspace,
): Promise<void> {
  const root = await canonicalRepoRoot(repoRoot);
  await withMutationLock(root, "build", options, async () => {
    await recoverPendingTransaction(root);
    const generated = await generatePrompt(root, workspace);
    workspace.throwIfAborted();
    await commitWriteSet(root, "build", [
      { path: OUTPUT_PATH, bytes: generated.output },
      { path: PROVENANCE_PATH, bytes: generated.provenance },
    ]);
  });
}

export async function checkPrompt(
  repoRoot = defaultPromptRepoRoot(),
  options: Pick<MutationOptions, "processIdentityProvider" | "signal"> = {},
): Promise<void> {
  await withPromptWorkspace(options.signal, (workspace) =>
    checkPromptWithWorkspace(repoRoot, options, workspace),
  );
}

async function checkPromptWithWorkspace(
  repoRoot: string,
  options: Pick<MutationOptions, "processIdentityProvider" | "signal">,
  workspace: PromptWorkspace,
): Promise<void> {
  const root = await canonicalRepoRoot(repoRoot);
  await assertCanonicalContainment(root);
  await assertNoActiveMutation(
    root,
    options.processIdentityProvider ?? defaultProcessIdentityProvider,
  );
  await assertNoPendingTransaction(root);
  await checkPromptContents(root, workspace);
}

async function checkPromptContents(
  root: string,
  workspace: PromptWorkspace,
): Promise<void> {
  parseShippedLanguagePolicy(
    await readRequiredFile(
      join(root, SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath),
      "shipped-language policy",
    ),
  );
  const generated = await generatePrompt(root, workspace);
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
  repoRoot = defaultPromptRepoRoot(),
  candidatePath?: string,
  options: AuthorPromptOptions = {},
): Promise<void> {
  await withPromptWorkspace(options.signal, (workspace) =>
    authorPromptPatchWithWorkspace(repoRoot, candidatePath, options, workspace),
  );
}

async function authorPromptPatchWithWorkspace(
  repoRoot: string,
  candidatePath: string | undefined,
  options: AuthorPromptOptions,
  workspace: PromptWorkspace,
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
      workspace,
    );
    validatePatch(patch, manifest.upstream.path, baseline);
    const applied = await applyPatchStrict(
      baseline,
      patch,
      manifest.upstream.path,
      workspace,
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
    workspace.throwIfAborted();
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

    const regenerated = await generatePrompt(root, workspace);
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
  options: RebasePromptOptions = {},
): Promise<void> {
  parseImmutableCommit(commit);
  await withPromptWorkspace(options.signal, (workspace) =>
    rebasePromptWithWorkspace(repoRoot, commit, options, workspace),
  );
}

async function rebasePromptWithWorkspace(
  repoRoot: string,
  commit: string,
  options: RebasePromptOptions,
  workspace: PromptWorkspace,
): Promise<void> {
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
      workspace,
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
          workspace,
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
    const patch = await createPatch(
      baseline,
      candidate,
      UPSTREAM_PATH,
      workspace,
    );
    validatePatch(patch, UPSTREAM_PATH, baseline);
    const reapplied = await applyPatchStrict(
      baseline,
      patch,
      UPSTREAM_PATH,
      workspace,
    );
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

    workspace.throwIfAborted();
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
    await checkPromptContents(root, workspace);
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

async function generatePrompt(
  root: string,
  workspace: PromptWorkspace,
): Promise<GeneratedPrompt> {
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
    workspace,
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
