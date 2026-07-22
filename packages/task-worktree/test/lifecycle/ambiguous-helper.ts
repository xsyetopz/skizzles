import { readdir } from "node:fs/promises";
import {
  createAuthority,
  prepareInput,
  runGit,
  worktreeAllocation,
  worktreePaths,
} from "./support.ts";

const [root, repository, worktreeParent] = Bun.argv.slice(2);
if (
  root === undefined ||
  repository === undefined ||
  worktreeParent === undefined
) {
  throw new Error("fixture paths are required");
}
const fixture = Object.freeze({ root, repository, worktreeParent });
const authority = createAuthority(fixture);
const prepared = await authority.prepare(prepareInput("ambiguous-add"));
if (prepared.status !== "cleanup-pending") {
  throw new Error(`expected cleanup-pending, received ${prepared.status}`);
}
const allocation = worktreeAllocation(repository);
const retained = worktreePaths(repository);
const pending = await authority.retryCleanup(
  Object.freeze({ version: 1 as const, handle: prepared.handle }),
);
runGit(repository, ["worktree", "unlock", allocation.root]);
runGit(repository, ["worktree", "remove", "--force", allocation.root]);
runGit(repository, ["branch", "-D", allocation.branch]);
const cleaned = await authority.retryCleanup(
  Object.freeze({ version: 1 as const, handle: prepared.handle }),
);
console.log(
  JSON.stringify({
    prepared: prepared.status,
    outcome: prepared.outcome,
    pending,
    retained,
    cleaned,
    paths: worktreePaths(repository),
    entries: await readdir(worktreeParent),
  }),
);
