// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabMode } from "../src/config.ts";
import { listLabs, readLab, writeLab } from "../src/state/lab/store.ts";
import {
  activityLockPath,
  labLockPath,
  labManifestPath,
  ownerDirectory,
  ownerKey,
  ownerLockPath,
  resolveOwner,
} from "../src/state/layout.ts";
import { ensureOwner } from "../src/state/owner-store.ts";
import type { LabMetadata } from "../src/types.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("owner resolution and durable state", () => {
  test("uses an explicit exact owner before CODEX_THREAD_ID and never invents one", () => {
    expect(
      resolveOwner("explicit/owner", { CODEX_THREAD_ID: "environment" }),
    ).toBe("explicit/owner");
    expect(
      resolveOwner(undefined, { CODEX_THREAD_ID: "environment owner" }),
    ).toBe("environment owner");
    expect(() => resolveOwner(undefined, {})).toThrow("owner is required");
    expect(() => resolveOwner("", {})).toThrow("owner is required");
  });

  test("keys arbitrary exact owners by a collision-resistant hash and persists across readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-"));
    temporary.push(root);
    const owner = "thread/with spaces:and?characters";
    await ensureOwner(root, owner);
    expect(ownerDirectory(root, owner)).toBe(
      join(root, "owners", ownerKey(owner)),
    );
    expect(ownerKey(owner)).toHaveLength(64);
    const lab = fixtureLab(root, owner);
    const roots = { stateRoot: root, runtimeRoot: join(root, "runtime") };
    await writeLab(roots, lab);
    expect(await readLab(roots, owner, lab.id)).toEqual(lab);
    expect(await listLabs(roots, owner)).toEqual([lab]);
  });

  test("creates only the owner and lab state directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-"));
    temporary.push(root);
    const owner = "thread-minimal-state";

    await ensureOwner(root, owner);

    expect((await readdir(ownerDirectory(root, owner))).sort()).toEqual([
      "labs",
      "owner.json",
    ]);
  });

  test("derives owner, lab, and activity locks from the hashed owner boundary", () => {
    const root = "/state";
    const owner = "thread/with spaces";
    const locks = join(ownerDirectory(root, owner), ".locks");

    expect(ownerLockPath(root, owner)).toBe(
      join(root, ".locks", `owner-${ownerKey(owner)}`),
    );
    expect(labLockPath(root, owner, "lab-1")).toBe(join(locks, "lab-lab-1"));
    expect(activityLockPath(root, owner, "lab-1")).toBe(
      join(locks, "activity-lab-1"),
    );
    expect(() => labLockPath(root, owner, "../escaped")).toThrow(
      "Unsafe lab id",
    );
  });

  test("accepts synchronous provisioning manifests without worker identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-"));
    temporary.push(root);
    const owner = "synchronous-provisioning";
    const roots = { stateRoot: root, runtimeRoot: join(root, "runtime") };
    const lab = { ...fixtureLab(root, owner), state: "provisioning" as const };

    await ensureOwner(root, owner);
    await writeLab(roots, lab);
    const persisted = await readLab(roots, owner, lab.id);

    expect(persisted).toEqual(lab);
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(lab).sort());
  });

  test("round-trips validated persisted Compose argument inputs for every lab mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-runtime-"));
    temporary.push(root);
    const owner = "validated-runtime-inputs";
    const roots = { stateRoot: root, runtimeRoot: join(root, "runtime") };
    await ensureOwner(root, owner);

    for (const mode of runtimeModes(join(root, "source"))) {
      const lab = fixtureReadyLab(root, owner, mode);
      await writeLab(roots, lab);
      expect(await readLab(roots, owner, lab.id)).toEqual(lab);
    }
  });

  test("rejects tampered persisted fields used to construct Compose arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-state-tamper-"));
    temporary.push(root);
    const owner = "tampered-runtime-inputs";
    const roots = { stateRoot: root, runtimeRoot: join(root, "runtime") };
    await ensureOwner(root, owner);

    const mutations: Array<{
      message: string;
      mutate: (value: Record<string, unknown>) => void;
    }> = [
      {
        message: "runtime source identity mismatch",
        mutate: (value) => {
          persistedConfig(value)["repoRoot"] = join(root, "different-source");
        },
      },
      {
        message: "runtime mode identity mismatch",
        mutate: (value) => {
          persistedMode(persistedConfig(value))["kind"] = "future-mode";
        },
      },
      {
        message: "invalid Compose source files",
        mutate: (value) => {
          persistedMode(persistedConfig(value))["files"] = [
            join(root, "outside.yaml"),
          ];
        },
      },
      {
        message: "invalid Compose source files",
        mutate: (value) => {
          persistedMode(persistedConfig(value))["futureComposeFiles"] = [
            join(root, "outside.yaml"),
          ];
        },
      },
      {
        message: "invalid declared ports",
        mutate: (value) => {
          Reflect.deleteProperty(persistedConfig(value), "ports");
        },
      },
      {
        message: "runtime source identity mismatch",
        mutate: (value) => {
          persistedConfig(value)["futureConfigField"] = true;
        },
      },
      {
        message: "invalid persisted runtime",
        mutate: (value) => {
          persistedRuntime(value)["futureRuntimeField"] = true;
        },
      },
      {
        message: "invalid container runtime",
        mutate: (value) => {
          const config = persistedConfig(value);
          const runtime = config["runtime"];
          if (!isRecord(runtime)) {
            throw new Error("test fixture has no configured runtime");
          }
          runtime["shell"] = ["relative-shell"];
        },
      },
      {
        message: "invalid Compose project",
        mutate: (value) => {
          value["composeProject"] = "invalid project";
        },
      },
      {
        message: "invalid runtime files or findings",
        mutate: (value) => {
          persistedRuntime(value)["overrideFile"] = join(
            root,
            "outside-override.yaml",
          );
        },
      },
      {
        message: "invalid runtime files or findings",
        mutate: (value) => {
          persistedRuntime(value)["baseFile"] = join(root, "unexpected.yaml");
        },
      },
      {
        message: "invalid Compose arguments",
        mutate: (value) => {
          persistedRuntime(value)["composeArgs"] = ["compose", "tampered"];
        },
      },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const mode = runtimeModes(join(root, "source"))[0];
      if (mode === undefined) {
        throw new Error("missing Compose test mode");
      }
      const lab = fixtureReadyLab(root, owner, mode, `lab-${index + 1}`);
      await writeLab(roots, lab);
      await tamperPersistedLab(root, owner, lab.id, mutation.mutate);

      await expect(readLab(roots, owner, lab.id)).rejects.toThrow(
        `invalid lab manifest: ${lab.id}: ${mutation.message}`,
      );
    }
  });
});

function fixtureReadyLab(
  root: string,
  owner: string,
  mode: LabMode,
  id = `lab-${mode.kind}`,
): LabMetadata {
  const lab = { ...fixtureLab(root, owner), id };
  lab.runtimeRoot = join(root, "runtime", lab.ownerKey, id);
  lab.workspace = join(lab.runtimeRoot, "workspace");
  lab.state = "ready";
  lab.modeKind = mode.kind;
  lab.commandService = mode.commandService;
  const overrideFile = join(lab.runtimeRoot, "override.compose.yaml");
  const baseFile =
    mode.kind === "compose"
      ? undefined
      : join(lab.runtimeRoot, "base.compose.yaml");
  lab.runtime = {
    config: {
      repoRoot: lab.sourceRoot,
      manifestPath: lab.manifestPath,
      mode,
      runtime: { workspace: "/workspace", shell: ["/bin/sh", "-lc"] },
      ports: [],
      forwardEnvironment: [],
      secretEnvironment: [],
    },
    composeArgs: [
      "compose",
      "--project-directory",
      lab.sourceRoot,
      "--project-name",
      lab.composeProject,
      "-f",
      ...(mode.kind === "compose" ? mode.files : [baseFile]),
      "-f",
      overrideFile,
    ].filter((value): value is string => value !== undefined),
    ...(baseFile === undefined ? {} : { baseFile }),
    overrideFile,
    findings: [],
  };
  if (mode.kind === "dockerfile") {
    lab.managedImage = `codex-container-lab:${lab.ownerKey.slice(0, 24)}-${id}`;
  }
  return lab;
}

function runtimeModes(sourceRoot: string): LabMode[] {
  return [
    {
      kind: "compose",
      files: [join(sourceRoot, "compose.yaml")],
      commandService: "dev",
    },
    {
      kind: "dockerfile",
      dockerfile: join(sourceRoot, "Dockerfile"),
      context: sourceRoot,
      commandService: "dev",
    },
    { kind: "image", image: "node:24", commandService: "dev" },
  ];
}

async function tamperPersistedLab(
  stateRoot: string,
  owner: string,
  labId: string,
  mutate: (value: Record<string, unknown>) => void,
): Promise<void> {
  const path = labManifestPath(stateRoot, owner, labId);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error("test fixture is not a persisted lab");
  }
  mutate(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

function persistedRuntime(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const runtime = value["runtime"];
  if (!isRecord(runtime)) {
    throw new Error("test fixture has no persisted runtime");
  }
  return runtime;
}

function persistedConfig(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const config = persistedRuntime(value)["config"];
  if (!isRecord(config)) {
    throw new Error("test fixture has no persisted config");
  }
  return config;
}

function persistedMode(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const mode = config["mode"];
  if (!isRecord(mode)) {
    throw new Error("test fixture has no persisted mode");
  }
  return mode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixtureLab(root: string, owner: string): LabMetadata {
  const key = ownerKey(owner);
  const runtimeRoot = join(root, "runtime", key, "lab-1");
  return {
    version: 1,
    id: "lab-1",
    name: "lab",
    owner,
    ownerKey: key,
    // biome-ignore lint/security/noSecrets: This fixed test/schema token is not a credential.
    repoHash: "123456789abc",
    composeProject: "ccl-test-lab",
    state: "failed",
    sourceRoot: join(root, "source"),
    runtimeRoot,
    workspace: join(runtimeRoot, "workspace"),
    manifestPath: join(root, "source", ".codex-container-lab.yaml"),
    commandService: "dev",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    endpoints: [],
    findings: [],
    secretEnvironment: [],
  };
}
