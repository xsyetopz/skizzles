import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PromptLayerError } from "./lifecycle-contract.ts";
import {
  authorPromptPatch,
  buildPrompt,
  checkPrompt,
  rebasePrompt,
} from "./prompt-lifecycle.ts";
import { errorMessage } from "./repository-boundary.ts";

export { validatePatch } from "./assets/patch.ts";
export type {
  FetchResponse,
  MutationLockHooks,
  ProcessIdentityProvider,
  PromptFetcher,
  TransactionFault,
} from "./lifecycle-contract.ts";
export {
  PROMPT_LAYER_ASSET_ROOT,
  PROMPT_LAYER_PACKAGE_FILES,
  PROMPT_LAYER_SOURCE_PATHS,
  PROMPT_POLICY_DESCRIPTOR_PATHS,
  PromptLayerError,
} from "./lifecycle-contract.ts";
export { normalizeDarwinProcessStartOutput } from "./mutation/process-identity.ts";
export {
  authorPromptPatch,
  buildPrompt,
  checkPrompt,
  parseImmutableCommit,
  rebasePrompt,
} from "./prompt-lifecycle.ts";

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
