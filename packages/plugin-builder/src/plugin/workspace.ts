import { mkdir } from "node:fs/promises";
import type { PromptWorkspace } from "@skizzles/prompt-layer";
import {
  type CloseReport,
  cleanupStale,
  create,
  type RunWorkspace,
} from "@skizzles/run-workspace";
import { PackagingError } from "./contract.ts";

interface PluginWorkspaceLifecycle {
  cleanupStale: () => Promise<void>;
  create: () => Promise<RunWorkspace>;
}

interface PluginWorkspace extends RunWorkspace {
  readonly prompt: PromptWorkspace;
}

class OwnedPromptWorkspace implements PromptWorkspace {
  readonly signal: AbortSignal;
  readonly #workspace: RunWorkspace;
  #sequence = 0;

  constructor(workspace: RunWorkspace) {
    this.#workspace = workspace;
    this.signal = workspace.signal;
  }

  async directory(purpose: "apply" | "author" | "test"): Promise<string> {
    this.throwIfAborted();
    const path = this.#workspace.path("prompt", `${purpose}-${this.#sequence}`);
    this.#sequence += 1;
    await mkdir(path, { mode: 0o700, recursive: true });
    this.throwIfAborted();
    return path;
  }

  throwIfAborted(): void {
    this.signal.throwIfAborted();
  }
}

class OwnedPluginWorkspace implements PluginWorkspace {
  readonly prompt: PromptWorkspace;
  readonly signal: AbortSignal;
  readonly #workspace: RunWorkspace;

  constructor(workspace: RunWorkspace) {
    this.#workspace = workspace;
    this.signal = workspace.signal;
    this.prompt = new OwnedPromptWorkspace(workspace);
  }

  path(...relativeParts: readonly string[]): string {
    return this.#workspace.path(...relativeParts);
  }

  inspectUsage(limits: unknown): ReturnType<RunWorkspace["inspectUsage"]> {
    return this.#workspace.inspectUsage(limits);
  }

  registerChild(child: Parameters<RunWorkspace["registerChild"]>[0]): void {
    this.#workspace.registerChild(child);
  }

  preserve(reason: string): Promise<void> {
    return this.#workspace.preserve(reason);
  }

  close(): Promise<CloseReport> {
    return this.#workspace.close();
  }
}

function withPluginWorkspace<T>(
  operation: (workspace: PluginWorkspace) => Promise<T>,
): Promise<T> {
  return withPluginWorkspaceUsing(operation, systemLifecycle);
}

async function withPluginWorkspaceUsing<T>(
  operation: (workspace: PluginWorkspace) => Promise<T>,
  lifecycle: PluginWorkspaceLifecycle,
): Promise<T> {
  await lifecycle.cleanupStale();
  const owned = await lifecycle.create();
  const workspace = adaptPluginWorkspace(owned);
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly error: unknown; readonly ok: false };
  try {
    outcome = { ok: true, value: await operation(workspace) };
  } catch (error) {
    outcome = { error, ok: false };
  }
  let report: CloseReport;
  try {
    report = await workspace.close();
  } catch (closeError) {
    const message = "Plugin run workspace cleanup failed: close rejected.";
    if (outcome.ok) {
      throw new PackagingError(message, { cause: closeError });
    }
    throw new PackagingError(message, {
      cause: new AggregateError(
        [closeError, outcome.error],
        "Workspace close and plugin operation both failed.",
      ),
    });
  }
  if (report.state === "cleanup-failed") {
    const message = `Plugin run workspace cleanup failed: ${report.error ?? "unknown failure"}.`;
    if (outcome.ok) {
      throw new PackagingError(message);
    }
    throw new PackagingError(message, { cause: outcome.error });
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

const systemLifecycle: PluginWorkspaceLifecycle = {
  cleanupStale: async () => {
    const report = await cleanupStale();
    if (report.failed.length > 0 || report.truncated) {
      throw new PackagingError(
        "Plugin run workspace stale cleanup did not complete.",
      );
    }
  },
  create,
};

function adaptPluginWorkspace(workspace: RunWorkspace): PluginWorkspace {
  return new OwnedPluginWorkspace(workspace);
}

export type { PluginWorkspace, PluginWorkspaceLifecycle };
export { adaptPluginWorkspace, withPluginWorkspace, withPluginWorkspaceUsing };
