import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "node:path";
import { RunWorkspaceAbortedError } from "./aborted.ts";
import { stopChildren } from "./children.ts";
import type {
  ChildCleanup,
  CloseFailureCode,
  CloseReport,
  CreateOptions,
  OwnedChild,
  RunWorkspace,
} from "./contract.ts";
import { RunWorkspaceError } from "./errors.ts";
import {
  type Marker,
  markerPath,
  readMarker,
  safeReason,
  sameFileIdentity,
  serializeMarker,
  verifyMarkedRoot,
} from "./marker.ts";
import {
  managedParent,
  type ProcessIdentity,
  type Runtime,
  systemRuntime,
} from "./platform.ts";
import {
  inspectCanonicalDirectory,
  inspectPrivateDirectory,
} from "./safety.ts";
import { coordinateSignals } from "./signals.ts";

const defaultGracefulStopMs = 5000;
const defaultForceStopMs = 5000;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function duration(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 300_000) {
    throw new RunWorkspaceError(
      "INVALID_OPTION",
      `${name} must be an integer from 0 to 300000`,
    );
  }
  return selected;
}

class OwnedRunWorkspace implements RunWorkspace {
  readonly signal: AbortSignal;
  readonly #runtime: Runtime;
  readonly #runId: string;
  readonly #gracefulStopMs: number;
  readonly #forceStopMs: number;
  readonly #controller = new AbortController();
  readonly #children: OwnedChild[] = [];
  readonly #forceGate: Promise<void>;
  readonly #releaseForceGate: () => void;
  #root: string;
  #marker: Marker;
  #state: "open" | "closing" | "cleanup-failed" | "closed" = "open";
  #preserveReason: string | undefined;
  #preservePromise: Promise<void> | undefined;
  #closePromise: Promise<CloseReport> | undefined;
  #finalReport: CloseReport | undefined;
  #removeSignalCoordination: (() => void) | undefined;
  #removeExternalAbort: (() => void) | undefined;
  #interruptCount = 0;

  constructor(
    root: string,
    marker: Marker,
    runtime: Runtime,
    options: CreateOptions,
  ) {
    this.#root = root;
    this.#marker = marker;
    this.#runtime = runtime;
    this.#runId = marker.runId;
    this.#gracefulStopMs = duration(
      options.gracefulStopMs,
      defaultGracefulStopMs,
      "gracefulStopMs",
    );
    this.#forceStopMs = duration(
      options.forceStopMs,
      defaultForceStopMs,
      "forceStopMs",
    );
    this.signal = this.#controller.signal;
    let releaseForceGate = (): void => undefined;
    this.#forceGate = new Promise((resolveGate) => {
      releaseForceGate = resolveGate;
    });
    this.#releaseForceGate = releaseForceGate;

    if (options.handleSignals === true) {
      this.#removeSignalCoordination = coordinateSignals({
        abort: (error) => this.#interrupt(error),
      });
    }
    if (options.signal !== undefined) {
      const externalSignal = options.signal;
      const abort = (): void => this.#interrupt(new RunWorkspaceAbortedError());
      this.#removeExternalAbort = () =>
        externalSignal.removeEventListener("abort", abort);
      externalSignal.addEventListener("abort", abort, { once: true });
      if (externalSignal.aborted && !this.signal.aborted) {
        this.#interrupt(new RunWorkspaceAbortedError());
      }
    }
  }

  path(...relativeParts: readonly string[]): string {
    if (this.#state !== "open") {
      throw new RunWorkspaceError(
        "WORKSPACE_CLOSED",
        "Run workspace is closing or closed",
      );
    }
    for (const part of relativeParts) {
      const segments = part.split(/[\\/]/u);
      if (
        part.length === 0 ||
        part.includes("\0") ||
        isAbsolute(part) ||
        win32.isAbsolute(part) ||
        segments.some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
      ) {
        throw new RunWorkspaceError(
          "INVALID_PATH",
          "Run workspace paths must be unambiguous relatives",
        );
      }
    }
    const selected = resolve(this.#root, ...relativeParts);
    const fromRoot = relative(this.#root, selected);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new RunWorkspaceError(
        "INVALID_PATH",
        "Run workspace path escapes its root",
      );
    }
    return selected;
  }

  registerChild(child: OwnedChild): void {
    if (this.#state !== "open") {
      throw new RunWorkspaceError(
        "WORKSPACE_CLOSED",
        "Cannot register a child after close begins",
      );
    }
    if (child.label.trim().length === 0) {
      throw new RunWorkspaceError(
        "INVALID_CHILD",
        "Owned child label must not be empty",
      );
    }
    if (
      child.pid !== undefined &&
      (!Number.isSafeInteger(child.pid) || child.pid <= 0)
    ) {
      throw new RunWorkspaceError(
        "INVALID_CHILD",
        "Owned child pid must be a positive integer",
      );
    }
    this.#children.push(child);
  }

  preserve(reason: string): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(
        new RunWorkspaceError(
          "WORKSPACE_CLOSED",
          "Cannot preserve after close begins",
        ),
      );
    }
    const normalized = safeReason(reason);
    if (normalized.length === 0) {
      return Promise.reject(
        new RunWorkspaceError(
          "INVALID_REASON",
          "Preservation requires a non-empty reason",
        ),
      );
    }
    if (this.#preservePromise !== undefined) return this.#preservePromise;
    const active = this.#publishPreservation(normalized);
    this.#preservePromise = active;
    active
      .then(
        () => undefined,
        () => {
          if (this.#preservePromise === active) {
            this.#preservePromise = undefined;
          }
        },
      )
      .catch(() => undefined);
    return active;
  }

  async #publishPreservation(normalized: string): Promise<void> {
    const marker: Marker = {
      ...this.#marker,
      state: "preserved",
      reason: normalized,
    };
    await verifyMarkedRoot(this.#runtime, this.#root, this.#runId);
    await this.#runtime.writeReplace(
      markerPath(this.#root),
      serializeMarker(marker),
    );
    await verifyMarkedRoot(this.#runtime, this.#root, this.#runId);
    this.#marker = marker;
    this.#preserveReason = normalized;
  }

  close(): Promise<CloseReport> {
    if (this.#finalReport !== undefined)
      return Promise.resolve(this.#finalReport);
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    const active = this.#close();
    this.#closePromise = active;
    active
      .then((report) => {
        if (report.state === "cleanup-failed") {
          this.#state = "cleanup-failed";
          this.#closePromise = undefined;
        } else {
          this.#state = "closed";
          this.#finalReport = report;
          this.#removeSignalCoordination?.();
        }
      })
      .catch(() => undefined);
    return active;
  }

  #interrupt(error: RunWorkspaceAbortedError): void {
    this.#interruptCount += 1;
    if (!this.#controller.signal.aborted) this.#controller.abort(error);
    if (this.#interruptCount > 1) this.#releaseForceGate();
    this.close().catch(() => undefined);
  }

  async #markFailure(
    children: readonly ChildCleanup[],
    error: CloseFailureCode,
  ): Promise<CloseReport> {
    const marker: Marker = {
      ...this.#marker,
      root: this.#root,
      state: "cleanup-failed",
      reason: error,
    };
    try {
      await verifyMarkedRoot(
        this.#runtime,
        this.#root,
        this.#runId,
        this.#marker.root,
      );
      await this.#runtime.writeReplace(
        markerPath(this.#root),
        serializeMarker(marker),
      );
      this.#marker = marker;
    } catch {
      // The finite report remains observable if an attacker replaced the root.
    }
    return {
      state: "cleanup-failed",
      runId: this.#runId,
      rootName: basename(this.#root),
      children,
      error,
    };
  }

  async #deleteRoot(): Promise<void> {
    const marker = await verifyMarkedRoot(
      this.#runtime,
      this.#root,
      this.#runId,
      this.#marker.root,
    );
    const source = this.#root;
    const claimed = join(
      managedParent(this.#runtime),
      `reaping-${this.#runId}-${crypto.randomUUID()}`,
    );
    await this.#runtime.rename(source, claimed);
    this.#root = claimed;
    const reapingMarker: Marker = {
      ...marker,
      root: claimed,
      state: "reaping",
    };
    await verifyMarkedRoot(this.#runtime, claimed, this.#runId, source);
    await this.#runtime.writeReplace(
      markerPath(claimed),
      serializeMarker(reapingMarker),
    );
    this.#marker = reapingMarker;
    await verifyMarkedRoot(this.#runtime, claimed, this.#runId);
    await this.#runtime.removeRoot(claimed);
  }

  async #close(): Promise<CloseReport> {
    this.#removeExternalAbort?.();
    const preservation = this.#preservePromise;
    const children = await stopChildren({
      children: this.#children,
      runtime: this.#runtime,
      gracefulStopMs: this.#gracefulStopMs,
      forceStopMs: this.#forceStopMs,
      escalation: this.#forceGate,
    });
    if (preservation !== undefined) {
      try {
        await preservation;
      } catch {
        return this.#markFailure(children, "CLEANUP_FAILED");
      }
    }
    if (
      children.some((child) => !child.stopped) &&
      this.#preserveReason !== undefined
    ) {
      return {
        state: "cleanup-failed",
        runId: this.#runId,
        rootName: basename(this.#root),
        children,
        error: "CHILD_UNCONFIRMED",
      };
    }
    if (children.some((child) => !child.stopped))
      return this.#markFailure(children, "CHILD_UNCONFIRMED");
    if (this.#preserveReason !== undefined) {
      return {
        state: "preserved",
        runId: this.#runId,
        rootName: basename(this.#root),
        children,
      };
    }
    try {
      await this.#deleteRoot();
      return {
        state: "deleted",
        runId: this.#runId,
        rootName: basename(this.#marker.root),
        children,
      };
    } catch {
      return this.#markFailure(children, "CLEANUP_FAILED");
    }
  }
}

async function prepareParent(runtime: Runtime): Promise<string> {
  const parent = managedParent(runtime);
  await runtime.mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await inspectCanonicalDirectory(runtime, parent)) === undefined) {
    throw new RunWorkspaceError(
      "UNSAFE_PARENT",
      "Managed temporary parent is not a real directory",
    );
  }
  await runtime.chmod(parent, 0o700);
  if ((await inspectPrivateDirectory(runtime, parent)) === undefined) {
    throw new RunWorkspaceError(
      "UNSAFE_PARENT",
      "Managed temporary parent is not owner-private",
    );
  }
  return parent;
}

async function hasInitializationAuthority(
  runtime: Runtime,
  root: string,
  marker: Marker | undefined,
  markerPublished: boolean,
): Promise<boolean> {
  if (marker === undefined) return false;
  const inspected = await inspectCanonicalDirectory(runtime, root);
  if (
    inspected === undefined ||
    !sameFileIdentity(inspected.identity, marker.rootIdentity)
  ) {
    return false;
  }
  if (!markerPublished) return true;
  const persisted = await readMarker(runtime, root);
  return (
    persisted !== undefined &&
    persisted.runId === marker.runId &&
    persisted.root === root &&
    sameFileIdentity(persisted.rootIdentity, marker.rootIdentity)
  );
}

export async function createWithRuntime(
  options: CreateOptions,
  runtime: Runtime,
): Promise<RunWorkspace> {
  if (isAborted(options.signal)) throw new RunWorkspaceAbortedError();
  const ownerIdentity: ProcessIdentity | undefined =
    await runtime.processIdentity(runtime.pid);
  if (ownerIdentity === undefined) {
    throw new RunWorkspaceError(
      "UNKNOWN_PROCESS_IDENTITY",
      "Current process start identity is unavailable",
    );
  }
  const parent = await prepareParent(runtime);
  const root = await runtime.mkdtemp(join(parent, "run-"));
  const runId = crypto.randomUUID();
  let marker: Marker | undefined;
  let markerPublished = false;
  let workspace: OwnedRunWorkspace | undefined;
  try {
    const inspected = await inspectCanonicalDirectory(runtime, root);
    if (inspected === undefined) {
      throw new RunWorkspaceError(
        "UNSAFE_ROOT",
        "Created run workspace is not a real directory",
      );
    }
    marker = {
      schema: 1,
      runId,
      root,
      rootIdentity: inspected.identity,
      ownerPid: runtime.pid,
      ownerIdentity,
      createdAtMs: runtime.now(),
      state: "open",
    };
    await runtime.writeExclusive(markerPath(root), serializeMarker(marker));
    markerPublished = true;
    await runtime.chmod(root, 0o700);
    if ((await inspectPrivateDirectory(runtime, root)) === undefined) {
      throw new RunWorkspaceError(
        "UNSAFE_ROOT",
        "Created run workspace is not owner-private",
      );
    }
    if (isAborted(options.signal)) throw new RunWorkspaceAbortedError();
    workspace = new OwnedRunWorkspace(root, marker, runtime, options);
    if (workspace.signal.aborted) {
      const report = await workspace.close();
      if (report.state === "cleanup-failed") {
        throw new RunWorkspaceError(
          "INITIALIZATION_FAILED",
          "Aborted run workspace cleanup must be retried",
        );
      }
      throw new RunWorkspaceAbortedError();
    }
    return workspace;
  } catch (error) {
    if (workspace !== undefined) throw error;
    if (
      !(await hasInitializationAuthority(
        runtime,
        root,
        marker,
        markerPublished,
      ))
    ) {
      throw new RunWorkspaceError(
        "INITIALIZATION_FAILED",
        "Run workspace initialization cleanup authority was lost",
        { cause: error },
      );
    }
    try {
      await runtime.removeRoot(root);
    } catch (removalError) {
      if (
        marker !== undefined &&
        (await hasInitializationAuthority(
          runtime,
          root,
          marker,
          markerPublished,
        ))
      ) {
        const failed: Marker = {
          ...marker,
          state: "cleanup-failed",
          reason: "INITIALIZATION_FAILED",
        };
        await runtime
          .writeReplace(markerPath(root), serializeMarker(failed))
          .catch(() => undefined);
      }
      throw new RunWorkspaceError(
        "INITIALIZATION_FAILED",
        "Run workspace initialization failed and cleanup must be retried",
        { cause: removalError },
      );
    }
    throw error;
  }
}

export function create(options: CreateOptions = {}): Promise<RunWorkspace> {
  return createWithRuntime(options, systemRuntime());
}
