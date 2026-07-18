import { join, resolve } from "node:path";
import {
  assertRealDirectoryInside,
  assertRealFileInside,
  type ExactDirectoryChainOptions,
  exactDirectoryChain as inspectExactDirectoryChain,
  realDirectory,
} from "../trusted-filesystem.ts";
import type { LabMetadata } from "./lab/contract.ts";
import { expectedLabRuntimeRoot, ownerKey, type StateRoots } from "./layout.ts";

export async function exactDirectoryChain(
  root: string,
  segments: readonly string[],
  label: string,
  options: ExactDirectoryChainOptions = {},
): Promise<boolean> {
  return await inspectExactDirectoryChain(root, segments, label, options);
}

export async function assertOwnerStateDirectory(
  stateRoot: string,
  ownerKey: string,
  missingMessage: string,
  options: ExactDirectoryChainOptions = {},
): Promise<void> {
  if (
    !(await exactDirectoryChain(
      stateRoot,
      ["owners", ownerKey],
      "owner state directory",
      options,
    ))
  ) {
    throw new Error(missingMessage);
  }
}

type TrustedLabRuntimeOptions = ExactDirectoryChainOptions & {
  expectedOwner?: string;
  expectedOwnerKey?: string;
  containmentMessage?: string;
};

export function assertTrustedLabRuntimeIdentity(
  roots: StateRoots,
  lab: LabMetadata,
  options: TrustedLabRuntimeOptions = {},
): void {
  const expectedOwner = options.expectedOwner ?? lab.owner;
  const expectedOwnerKey = options.expectedOwnerKey ?? ownerKey(expectedOwner);
  const expectedRuntime = expectedLabRuntimeRoot(roots, expectedOwner, lab.id);
  if (
    lab.owner !== expectedOwner ||
    lab.ownerKey !== expectedOwnerKey ||
    resolve(lab.runtimeRoot) !== expectedRuntime ||
    resolve(lab.workspace) !== join(expectedRuntime, "workspace")
  ) {
    throw new Error(
      options.containmentMessage ?? "lab runtime containment is invalid",
    );
  }
}

export async function inspectTrustedLabRuntimeDirectories(
  roots: StateRoots,
  lab: LabMetadata,
  options: TrustedLabRuntimeOptions & { inspectWorkspace?: boolean } = {},
): Promise<boolean> {
  assertTrustedLabRuntimeIdentity(roots, lab, options);
  const expectedOwner = options.expectedOwner ?? lab.owner;
  const expectedOwnerKey = options.expectedOwnerKey ?? ownerKey(expectedOwner);
  const chainOptions: ExactDirectoryChainOptions = {
    ...(options.canonicalMismatch === undefined
      ? {}
      : { canonicalMismatch: options.canonicalMismatch }),
  };
  const runtimePresent = await exactDirectoryChain(
    roots.runtimeRoot,
    [expectedOwnerKey, lab.id],
    "lab runtime directory",
    chainOptions,
  );
  if (runtimePresent && options.inspectWorkspace !== false) {
    await exactDirectoryChain(
      roots.runtimeRoot,
      [expectedOwnerKey, lab.id, "workspace"],
      "lab workspace",
      chainOptions,
    );
  }
  return runtimePresent;
}

export async function assertReadyLabFilesystem(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<void> {
  if (lab.state !== "ready" || !lab.runtime) {
    throw new Error(`lab is not ready: ${lab.state}`);
  }
  const configuredRuntime = await realDirectory(
    roots.runtimeRoot,
    "configured runtime root",
  );
  const ownerRuntime = await realDirectory(
    join(roots.runtimeRoot, lab.ownerKey),
    "owner runtime root",
  );
  const runtime = await realDirectory(lab.runtimeRoot, "lab runtime root");
  const workspace = await realDirectory(lab.workspace, "lab workspace");
  if (
    ownerRuntime !== join(configuredRuntime, lab.ownerKey) ||
    runtime !== join(ownerRuntime, lab.id) ||
    workspace !== join(runtime, "workspace")
  ) {
    throw new Error(
      "runtime or workspace resolved outside the configured runtime root",
    );
  }
  const source = await realDirectory(lab.sourceRoot, "lab source root");
  await assertRealFileInside(source, lab.manifestPath, "lab manifest");
  await assertRealFileInside(
    runtime,
    lab.runtime.overrideFile,
    "Compose override",
  );
  if (lab.runtime.baseFile) {
    await assertRealFileInside(
      runtime,
      lab.runtime.baseFile,
      "internal Compose base",
    );
  }
  const mode = lab.runtime.config.mode;
  if (mode.kind === "compose") {
    for (const path of mode.files) {
      await assertRealFileInside(source, path, "project Compose file");
    }
  } else if (mode.kind === "dockerfile") {
    await assertRealFileInside(source, mode.dockerfile, "project Dockerfile");
    await assertRealDirectoryInside(source, mode.context, "Dockerfile context");
  }
}
