// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { PROMPT_POLICY_DESCRIPTOR_PATHS } from "@skizzles/prompt-layer";
import {
  type ConfigEdit,
  type ConfigRpc,
  ConfigRpcError,
  type JsonValue,
} from "../../src/codex-config.ts";
import { promptPolicyLockPath } from "../../src/prompt-policy/lock.ts";
import {
  applyPromptPolicy,
  promptPolicyManagedPath,
  promptPolicyReceiptPath,
  restorePromptPolicy,
} from "../../src/prompt-policy.ts";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dir, "../../../..");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(initial: JsonValue = {}): {
  root: string;
  codexHome: string;
  codexBinary: string;
  sourceRoot: string;
  rpc: FakeRpc;
} {
  const root = join(
    process.env["TMPDIR"] ?? "/tmp",
    `skizzles-policy-${crypto.randomUUID()}`,
  );
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "# fake native config\n");
  return {
    root,
    codexHome,
    codexBinary: process.execPath,
    sourceRoot: repoRoot,
    rpc: new FakeRpc(codexHome, initial),
  };
}

function setValue(
  root: Record<string, JsonValue>,
  keyPath: string,
  value: JsonValue,
): void {
  const segments = keyPath.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || Array.isArray(child) || typeof child !== "object") {
      current[segment] = {};
    }
    current = current[segment] as Record<string, JsonValue>;
  }
  const final = segments.at(-1);
  if (!final) {
    throw new Error("test key path must be non-empty");
  }
  if (value === null) {
    delete current[final];
  } else {
    current[final] = structuredClone(value);
  }
}

class FakeRpc implements ConfigRpc {
  readonly codexHome: string;
  config: Record<string, JsonValue>;
  version = "sha256:1";
  writes = 0;
  closed = false;
  rejectWrite = false;
  commitThenThrow = false;
  beforeWrite: (() => void) | undefined;
  lastEdits: ConfigEdit[] = [];

  constructor(codexHome: string, initial: JsonValue) {
    this.codexHome = codexHome;
    this.config = structuredClone(initial) as Record<string, JsonValue>;
  }

  async read() {
    await Promise.resolve();
    return {
      layers: [
        {
          name: {
            type: "user",
            file: join(this.codexHome, "config.toml"),
            profile: null,
          },
          version: this.version,
          config: structuredClone(this.config),
        },
      ],
    };
  }

  async batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }) {
    await Promise.resolve();
    this.beforeWrite?.();
    if (this.rejectWrite) {
      throw new ConfigRpcError(
        "conflict",
        "Codex config version conflict",
        "configVersionConflict",
      );
    }
    // biome-ignore lint/suspicious/noMisplacedAssertion: This RPC double centralizes protocol assertions for tests.
    expect(params.expectedVersion).toBe(this.version);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This RPC double centralizes protocol assertions for tests.
    expect(params.reloadUserConfig).toBe(true);
    this.lastEdits = structuredClone(params.edits);
    for (const edit of params.edits) {
      setValue(this.config, edit.keyPath, edit.value);
    }
    this.writes += 1;
    this.version = `sha256:${this.writes + 1}`;
    if (this.commitThenThrow) {
      throw new Error("ambiguous transport DO-NOT-LEAK-TRANSPORT-SECRET");
    }
    return { status: "ok", version: this.version, filePath: params.filePath };
  }

  async close() {
    await Promise.resolve();
    this.closed = true;
  }
}

const rpcFactory = (rpc: FakeRpc) => async () => rpc;

describe("prompt-policy source and lock boundaries", () => {
  test("rejects source hash, provenance relationship, and legal drift before config mutation", async () => {
    for (const mutation of ["prompt", "provenance", "license"] as const) {
      const f = fixture();
      f.sourceRoot = copyPolicySource(f.root);
      if (mutation === "prompt") {
        writeFileSync(
          join(
            f.sourceRoot,
            "packages/prompt-layer/assets/instructions/skizzles-base.md",
          ),
          "tampered\n",
        );
      } else if (mutation === "license") {
        writeFileSync(
          join(f.sourceRoot, "packages/prompt-layer/assets/upstream/LICENSE"),
          "tampered\n",
        );
      } else {
        const path = join(
          f.sourceRoot,
          "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
        );
        const provenance = JSON.parse(readFileSync(path, "utf8"));
        provenance.baselineRole = "swapped provenance role";
        const bytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
        writeFileSync(path, bytes);
        const descriptorPath = join(
          f.sourceRoot,
          "packages/prompt-layer/assets/integrations/prompt-policy.json",
        );
        const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
        descriptor.base.provenance.sha256 = new Bun.CryptoHasher("sha256")
          .update(bytes)
          .digest("hex");
        descriptor.base.provenance.bytes = bytes.length;
        writeFileSync(
          descriptorPath,
          `${JSON.stringify(descriptor, null, 2)}\n`,
        );
      }
      await expect(
        applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
      ).rejects.toThrow();
      expect(f.rpc.writes).toBe(0);
      expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(false);
    }
  });

  test("rejects renamed, swapped, and duplicate legal descriptor mappings", async () => {
    for (const mutation of [
      "renamed-source",
      "alternate-package",
      "swapped",
      "duplicate",
    ] as const) {
      const f = fixture();
      f.sourceRoot = copyPolicySource(f.root);
      const descriptorPath = join(
        f.sourceRoot,
        "packages/prompt-layer/assets/integrations/prompt-policy.json",
      );
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      if (mutation === "renamed-source") {
        descriptor.base.legal.license.sourcePath =
          "packages/prompt-layer/assets/upstream/COPYING";
      } else if (mutation === "alternate-package") {
        descriptor.base.legal.notice.packagedPath =
          "third_party/openai-codex/NOTICE.txt";
      } else if (mutation === "swapped") {
        [descriptor.base.legal.license, descriptor.base.legal.notice] = [
          descriptor.base.legal.notice,
          descriptor.base.legal.license,
        ];
      } else {
        descriptor.base.legal.notice = structuredClone(
          descriptor.base.legal.license,
        );
      }
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
      await expect(
        applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
      ).rejects.toThrow("exact canonical LICENSE and NOTICE mappings");
      expect(f.rpc.writes).toBe(0);
    }
  });

  test("rejects symlinked source roots and source files", async () => {
    const f = fixture();
    const copied = copyPolicySource(f.root);
    const linkedRoot = join(f.root, "linked-source");
    symlinkSync(copied, linkedRoot, "dir");
    await expect(
      applyPromptPolicy({
        ...f,
        sourceRoot: linkedRoot,
        rpcFactory: rpcFactory(f.rpc),
      }),
    ).rejects.toThrow("symlinked parents");

    const prompt = join(
      copied,
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
    );
    rmSync(prompt);
    symlinkSync(
      join(
        repoRoot,
        "packages/prompt-layer/assets/instructions/skizzles-base.md",
      ),
      prompt,
    );
    await expect(
      applyPromptPolicy({
        ...f,
        sourceRoot: copied,
        rpcFactory: rpcFactory(f.rpc),
      }),
    ).rejects.toThrow("uses a symlink");
    expect(f.rpc.writes).toBe(0);
  });

  test("serializes concurrent apply and restore preflights with one lifecycle lock", async () => {
    const f = fixture();
    const lockParent = join(f.root, "locks");
    mkdirSync(lockParent, { mode: 0o700 });
    let signalAcquired: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const acquired = new Promise<void>((resolvePromise) => {
      signalAcquired = resolvePromise;
    });
    const gate = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const lockOptions = {
      lockParent,
      processStartIdentity: () => "test-current-process",
    };
    const first = applyPromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
      lockOptions,
      afterPendingReceipt: async () => {
        signalAcquired?.();
        await gate;
      },
    });
    await acquired;
    await expect(
      restorePromptPolicy({
        ...f,
        dryRun: true,
        rpcFactory: rpcFactory(f.rpc),
        lockOptions,
      }),
    ).rejects.toThrow("owned by live pid");
    releaseFirst?.();
    const applied = await first;
    expect(applied.receipt.state).toBe("active");
    expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(true);
    await restorePromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
      lockOptions,
    });
    expect(existsSync(lockParent)).toBe(false);
  });

  test("reclaims identity-checked stale and orphan lifecycle locks", async () => {
    for (const kind of ["stale-owner", "orphan"] as const) {
      const f = fixture();
      const lockParent = join(f.root, `locks-${kind}`);
      const lockPath = promptPolicyLockPath(f.codexHome, lockParent);
      mkdirSync(lockPath, { recursive: true, mode: 0o700 });
      if (kind === "stale-owner") {
        writeFileSync(
          join(lockPath, "owner.json"),
          `${JSON.stringify(
            {
              schema: "skizzles.prompt-policy-lock",
              version: 1,
              operation: "apply",
              pid: 2_147_483_647,
              processStartIdentity: "stale-process",
              token: crypto.randomUUID(),
              createdAtUnixMs: 1,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      } else {
        utimesSync(lockPath, new Date(0), new Date(0));
      }
      const outcome = await applyPromptPolicy({
        ...f,
        dryRun: true,
        rpcFactory: rpcFactory(f.rpc),
        lockOptions: {
          lockParent,
          incompleteGraceMs: 0,
          processStartIdentity: () => "test-current-process",
        },
      });
      expect(outcome.action).toBe("apply");
      expect(existsSync(lockParent)).toBe(false);
    }
  });

  test("preserves replacement lock artifacts during stale reclaim and release", async () => {
    const stale = fixture();
    const staleParent = join(stale.root, "stale-locks");
    const stalePath = promptPolicyLockPath(stale.codexHome, staleParent);
    mkdirSync(stalePath, { recursive: true, mode: 0o700 });
    utimesSync(stalePath, new Date(0), new Date(0));
    await expect(
      applyPromptPolicy({
        ...stale,
        dryRun: true,
        rpcFactory: rpcFactory(stale.rpc),
        lockOptions: {
          lockParent: staleParent,
          incompleteGraceMs: 0,
          processStartIdentity: () => "test-current-process",
          beforeStaleQuarantine: (path) => replaceLockWithMarker(path),
        },
      }),
    ).rejects.toThrow("changed during stale reclaim");
    expect(readFileSync(join(stalePath, "foreign-marker"), "utf8")).toBe(
      "foreign\n",
    );

    const release = fixture();
    const releaseParent = join(release.root, "release-locks");
    await expect(
      applyPromptPolicy({
        ...release,
        dryRun: true,
        rpcFactory: rpcFactory(release.rpc),
        lockOptions: {
          lockParent: releaseParent,
          processStartIdentity: () => "test-current-process",
          beforeRelease: (path) => replaceLockWithMarker(path),
        },
      }),
    ).rejects.toThrow("changed during release");
    const releasePath = promptPolicyLockPath(release.codexHome, releaseParent);
    expect(readFileSync(join(releasePath, "foreign-marker"), "utf8")).toBe(
      "foreign\n",
    );
  });

  test("recovers stale lock quarantines and preserves malformed replacements", async () => {
    const recovered = fixture();
    const recoveredParent = join(recovered.root, "orphan-locks");
    const recoveredBase = promptPolicyLockPath(
      recovered.codexHome,
      recoveredParent,
    );
    const recoveredOrphan = `${recoveredBase}.stale-${crypto.randomUUID()}`;
    mkdirSync(recoveredOrphan, { recursive: true, mode: 0o700 });
    writeStaleLockOwner(recoveredOrphan);
    const outcome = await applyPromptPolicy({
      ...recovered,
      dryRun: true,
      rpcFactory: rpcFactory(recovered.rpc),
      lockOptions: {
        lockParent: recoveredParent,
        processStartIdentity: () => "test-current-process",
      },
    });
    expect(outcome.action).toBe("apply");
    expect(existsSync(recoveredParent)).toBe(false);

    const replaced = fixture();
    const replacedParent = join(replaced.root, "replaced-orphan-locks");
    const replacedBase = promptPolicyLockPath(
      replaced.codexHome,
      replacedParent,
    );
    const replacedOrphan = `${replacedBase}.release-${crypto.randomUUID()}`;
    mkdirSync(replacedOrphan, { recursive: true, mode: 0o700 });
    writeFileSync(join(replacedOrphan, "foreign-marker"), "foreign\n");
    await expect(
      applyPromptPolicy({
        ...replaced,
        dryRun: true,
        rpcFactory: rpcFactory(replaced.rpc),
        lockOptions: {
          lockParent: replacedParent,
          processStartIdentity: () => "test-current-process",
        },
      }),
    ).rejects.toThrow("orphan contains unexpected entries");
    expect(readFileSync(join(replacedOrphan, "foreign-marker"), "utf8")).toBe(
      "foreign\n",
    );
  });

  test("accepts the packaged third-party legal layout without maintainer-only sources", async () => {
    const f = fixture();
    f.sourceRoot = copyPackagedPolicySource(f.root);
    const outcome = await applyPromptPolicy({
      ...f,
      dryRun: true,
      rpcFactory: rpcFactory(f.rpc),
    });
    expect(outcome.action).toBe("apply");
    expect(f.rpc.writes).toBe(0);
  });

  test("rejects descriptor locations outside the provider-owned contract", async () => {
    const f = fixture();
    await expect(
      applyPromptPolicy({
        ...f,
        sourceDescriptor: { descriptorPath: "alternate/policy.json" },
        dryRun: true,
        rpcFactory: rpcFactory(f.rpc),
      }),
    ).rejects.toThrow(
      `prompt-policy descriptor path must end in ${PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath}`,
    );
    expect(f.rpc.writes).toBe(0);
  });
});

function copyPolicySource(root: string): string {
  const source = join(root, "policy-source");
  for (const path of [
    "packages/prompt-layer/assets/integrations/prompt-policy.json",
    "packages/prompt-layer/assets/instructions/skizzles-base.md",
    "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    "packages/prompt-layer/assets/instructions/developer-instructions.md",
    "packages/prompt-layer/assets/instructions/compact-prompt.md",
    "packages/prompt-layer/assets/upstream/LICENSE",
    "packages/prompt-layer/assets/upstream/NOTICE",
  ]) {
    const destination = join(source, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repoRoot, path), destination);
  }
  return source;
}

function copyPackagedPolicySource(root: string): string {
  const source = join(root, "packaged-policy-source");
  const mappings = [
    [
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
      "integrations/prompt-policy.json",
    ],
    [
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
      "instructions/skizzles-base.md",
    ],
    [
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
      "instructions/skizzles-base.provenance.json",
    ],
    [
      "packages/prompt-layer/assets/instructions/developer-instructions.md",
      "instructions/developer-instructions.md",
    ],
    [
      "packages/prompt-layer/assets/instructions/compact-prompt.md",
      "instructions/compact-prompt.md",
    ],
    [
      "packages/prompt-layer/assets/upstream/LICENSE",
      "third_party/openai-codex/LICENSE",
    ],
    [
      "packages/prompt-layer/assets/upstream/NOTICE",
      "third_party/openai-codex/NOTICE",
    ],
  ] as const;
  for (const [from, to] of mappings) {
    const destination = join(source, to);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(repoRoot, from), destination);
  }
  return source;
}

function replaceLockWithMarker(path: string): void {
  rmSync(path, { recursive: true });
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, "foreign-marker"), "foreign\n");
}

function writeStaleLockOwner(path: string): void {
  writeFileSync(
    join(path, "owner.json"),
    `${JSON.stringify(
      {
        schema: "skizzles.prompt-policy-lock",
        version: 1,
        operation: "apply",
        pid: 2_147_483_647,
        processStartIdentity: "stale-process",
        token: crypto.randomUUID(),
        createdAtUnixMs: 1,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
