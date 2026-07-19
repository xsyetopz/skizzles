import { mkdir } from "node:fs/promises";
import {
  type CloseReport,
  cleanupStale,
  create,
  type RunWorkspace,
} from "@skizzles/run-workspace";
import { PromptLayerError } from "./contract.ts";

type PromptWorkspacePurpose = "apply" | "author" | "test";

interface PromptWorkspace {
  readonly signal: AbortSignal;
  directory: (purpose: PromptWorkspacePurpose) => Promise<string>;
  throwIfAborted: () => void;
}

interface WorkspaceOwner {
  readonly signal: AbortSignal;
  readonly close: () => Promise<CloseReport>;
  readonly path: (...relativeParts: readonly string[]) => string;
}

interface PromptWorkspaceLifecycle {
  readonly cleanupStale: () => Promise<void>;
  readonly create: (signal: AbortSignal | undefined) => Promise<WorkspaceOwner>;
}

class OwnedPromptWorkspace implements PromptWorkspace {
  readonly signal: AbortSignal;
  readonly #workspace: WorkspaceOwner;
  #sequence = 0;

  constructor(workspace: WorkspaceOwner) {
    this.#workspace = workspace;
    this.signal = workspace.signal;
  }

  async directory(purpose: PromptWorkspacePurpose): Promise<string> {
    this.throwIfAborted();
    const sequence = this.#sequence;
    this.#sequence += 1;
    const path = this.#workspace.path(`${purpose}-${sequence}`);
    await mkdir(path, { recursive: false, mode: 0o700 });
    this.throwIfAborted();
    return path;
  }

  throwIfAborted(): void {
    this.signal.throwIfAborted();
  }
}

function withPromptWorkspace<T>(
  signal: AbortSignal | undefined,
  operation: (workspace: PromptWorkspace) => Promise<T>,
): Promise<T> {
  return withPromptWorkspaceUsing(signal, operation, systemLifecycle);
}

async function withPromptWorkspaceUsing<T>(
  signal: AbortSignal | undefined,
  operation: (workspace: PromptWorkspace) => Promise<T>,
  lifecycle: PromptWorkspaceLifecycle,
): Promise<T> {
  await lifecycle.cleanupStale();
  const owned = await lifecycle.create(signal);
  const workspace = new OwnedPromptWorkspace(owned);
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly error: unknown; readonly ok: false };
  try {
    outcome = { ok: true, value: await operation(workspace) };
  } catch (error) {
    outcome = { error, ok: false };
  }
  const report = await owned.close();
  if (report.state === "cleanup-failed") {
    const message = `Prompt run workspace cleanup failed: ${report.error ?? "unknown failure"}.`;
    if (outcome.ok) {
      throw new PromptLayerError(message);
    }
    throw new PromptLayerError(message, { cause: outcome.error });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

const systemLifecycle: PromptWorkspaceLifecycle = {
  cleanupStale: async () => {
    await cleanupStale();
  },
  create: async (signal: AbortSignal | undefined) => {
    let workspace: RunWorkspace;
    if (signal === undefined) {
      workspace = await create();
    } else {
      workspace = await create({ signal });
    }
    return workspace;
  },
};

export type {
  PromptWorkspace,
  PromptWorkspaceLifecycle,
  PromptWorkspacePurpose,
};
export { withPromptWorkspace, withPromptWorkspaceUsing };
