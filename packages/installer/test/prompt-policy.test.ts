import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  type ConfigEdit,
  type ConfigRpc,
  ConfigRpcError,
  type JsonValue,
} from "../src/codex-config.ts";
import { normalizeDarwinProcessStart } from "../src/prompt-policy/lock.ts";
import {
  applyPromptPolicy,
  promptPolicyManagedPath,
  promptPolicyReceiptPath,
  promptPolicySummary,
  restorePromptPolicy,
} from "../src/prompt-policy.ts";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dir, "../../..");

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

    expect(params.expectedVersion).toBe(this.version);

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

describe("prompt-policy lifecycle", () => {
  test("normalizes one- and two-digit Darwin process start days strictly", () => {
    expect(normalizeDarwinProcessStart("Fri Jul  8 12:34:56 2022\n")).toBe(
      `darwin:${Date.UTC(2022, 6, 8, 12, 34, 56) / 1000}`,
    );
    expect(normalizeDarwinProcessStart("Mon Jul 18 12:34:56 2022")).toBe(
      `darwin:${Date.UTC(2022, 6, 18, 12, 34, 56) / 1000}`,
    );
    for (const malformed of [
      "Sat Jul 8 12:34:56 2022",
      "Wed Feb 30 12:34:56 2022",
      "Fri Jul 008 12:34:56 2022",
      "Fri Jul 0 12:34:56 2022",
      "Fri Jul 8 12:34:56 2022 trailing",
    ]) {
      expect(normalizeDarwinProcessStart(malformed)).toBeUndefined();
    }
  });

  test("atomically replaces exactly three whole values and restores present and absent values", async () => {
    const f = fixture({
      model: "preserved",
      model_instructions_file: "/personal/base.md",
      developer_instructions: "private prior developer text",
    });
    const applied = await applyPromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
    });

    expect(f.rpc.lastEdits.map(({ keyPath }) => keyPath)).toEqual([
      "model_instructions_file",
      "developer_instructions",
      "compact_prompt",
    ]);
    expect(f.rpc.config["model"]).toBe("preserved");
    expect(f.rpc.config["model_instructions_file"]).toBe(
      promptPolicyManagedPath(f.codexHome),
    );
    const developerInstructions = f.rpc.config["developer_instructions"];
    if (typeof developerInstructions !== "string") {
      throw new TypeError("developer instructions must be a string");
    }
    expect(developerInstructions).toStartWith("# Skizzles Developer Policy\n");
    const compactPrompt = f.rpc.config["compact_prompt"];
    if (typeof compactPrompt !== "string") {
      throw new TypeError("compact prompt must be a string");
    }
    expect(compactPrompt).toContain("local history compaction only");
    expect(
      applied.receipt.values.map(({ beforePresent }) => beforePresent),
    ).toEqual([true, true, false]);
    expect(statSync(promptPolicyReceiptPath(f.codexHome)).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(promptPolicyManagedPath(f.codexHome)).mode & 0o777).toBe(
      0o600,
    );
    expect(
      statSync(dirname(promptPolicyManagedPath(f.codexHome))).mode & 0o777,
    ).toBe(0o700);

    await restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    expect(f.rpc.config).toEqual({
      model: "preserved",
      model_instructions_file: "/personal/base.md",
      developer_instructions: "private prior developer text",
    });
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(false);
    expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(false);
  });

  test("dry-run writes nothing and summary redacts prior and replacement prompt bodies", async () => {
    const secret = "DO-NOT-PRINT-private-instructions";
    const f = fixture({ developer_instructions: secret });
    const outcome = await applyPromptPolicy({
      ...f,
      dryRun: true,
      rpcFactory: rpcFactory(f.rpc),
    });
    const rendered = JSON.stringify(promptPolicySummary(outcome, true));
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(join(f.codexHome, ".skizzles"))).toBe(false);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("# Skizzles Developer Policy");
    expect(rendered).toContain("beforePresent");
    expect(rendered).toContain("new-managed-copy");
  });

  test("cleans newly owned files when the atomic batch is rejected", async () => {
    const f = fixture();
    f.rpc.rejectWrite = true;
    await expect(
      applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
    ).rejects.toThrow("Codex config version conflict");
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(false);
    expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(false);
  });

  test("never deletes a managed target replaced during rejected batch cleanup", async () => {
    const f = fixture();
    const target = promptPolicyManagedPath(f.codexHome);
    f.rpc.rejectWrite = true;
    f.rpc.beforeWrite = () => {
      rmSync(target);
      writeFileSync(target, "foreign replacement\n", { mode: 0o600 });
    };
    await expect(
      applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
    ).rejects.toThrow("refusing to clean replaced prompt-policy owned file");
    expect(readFileSync(target, "utf8")).toBe("foreign replacement\n");
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(true);
  });

  test("retains pending evidence when transport fails after commit and recovers by inspection", async () => {
    const f = fixture({ developer_instructions: "prior" });
    f.rpc.commitThenThrow = true;
    let message = "";
    try {
      await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("outcome is ambiguous");
    expect(message).not.toContain("DO-NOT-LEAK-TRANSPORT-SECRET");
    expect(
      JSON.parse(readFileSync(promptPolicyReceiptPath(f.codexHome), "utf8"))
        .state,
    ).toBe("pending");
    expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(true);
    expect(f.rpc.config["model_instructions_file"]).toBe(
      promptPolicyManagedPath(f.codexHome),
    );

    f.rpc.commitThenThrow = false;
    const writes = f.rpc.writes;
    const recovered = await applyPromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
    });
    expect(recovered.action).toBe("activate-recovered");
    expect(f.rpc.writes).toBe(writes);
    await restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    expect(f.rpc.config["developer_instructions"]).toBe("prior");
  });

  test("retains restoring evidence when transport fails after restore commit", async () => {
    const f = fixture({ compact_prompt: "prior compact" });
    await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    f.rpc.commitThenThrow = true;
    await expect(
      restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(
      JSON.parse(readFileSync(promptPolicyReceiptPath(f.codexHome), "utf8"))
        .state,
    ).toBe("restoring");
    expect(f.rpc.config["compact_prompt"]).toBe("prior compact");
    f.rpc.commitThenThrow = false;
    const recovered = await restorePromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
    });
    expect(recovered.action).toBe("finish-restore");
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(false);
  });

  test("recovers pending apply and restoring cleanup after post-write crashes", async () => {
    const f = fixture({ developer_instructions: "prior" });
    await expect(
      applyPromptPolicy({
        ...f,
        rpcFactory: rpcFactory(f.rpc),
        afterBatchWrite: () => {
          throw new Error("simulated post-write crash");
        },
      }),
    ).rejects.toThrow("simulated post-write crash");
    expect(
      JSON.parse(readFileSync(promptPolicyReceiptPath(f.codexHome), "utf8"))
        .state,
    ).toBe("pending");

    const resumed = await applyPromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
    });
    expect(resumed.action).toBe("activate-recovered");
    expect(f.rpc.writes).toBe(1);

    await expect(
      restorePromptPolicy({
        ...f,
        rpcFactory: rpcFactory(f.rpc),
        afterBatchWrite: () => {
          throw new Error("simulated restore cleanup crash");
        },
      }),
    ).rejects.toThrow("simulated restore cleanup crash");
    expect(
      JSON.parse(readFileSync(promptPolicyReceiptPath(f.codexHome), "utf8"))
        .state,
    ).toBe("restoring");
    // A crash can happen after the managed file was removed but before the
    // restoring receipt was cleaned. The before-config state is sufficient to
    // finish only that validated cleanup.
    rmSync(promptPolicyManagedPath(f.codexHome));
    const finished = await restorePromptPolicy({
      ...f,
      rpcFactory: rpcFactory(f.rpc),
    });
    expect(finished.action).toBe("finish-restore");
    expect(f.rpc.config["developer_instructions"]).toBe("prior");
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(false);
  });

  test("resumes a pending receipt from the exact before state and can discard an unapplied pending policy", async () => {
    const resume = fixture({ developer_instructions: "resume-prior" });
    await expect(
      applyPromptPolicy({
        ...resume,
        rpcFactory: rpcFactory(resume.rpc),
        afterBatchWrite: () => {
          throw new Error("leave pending");
        },
      }),
    ).rejects.toThrow("leave pending");
    resume.rpc.config = { developer_instructions: "resume-prior" };
    resume.rpc.version = "sha256:external-before";
    const resumed = await applyPromptPolicy({
      ...resume,
      rpcFactory: rpcFactory(resume.rpc),
    });
    expect(resumed.action).toBe("resume-apply");
    expect(resume.rpc.writes).toBe(2);

    const discard = fixture();
    await expect(
      applyPromptPolicy({
        ...discard,
        rpcFactory: rpcFactory(discard.rpc),
        afterBatchWrite: () => {
          throw new Error("leave pending");
        },
      }),
    ).rejects.toThrow("leave pending");
    discard.rpc.config = {};
    discard.rpc.version = "sha256:external-before";
    const writes = discard.rpc.writes;
    const discarded = await restorePromptPolicy({
      ...discard,
      rpcFactory: rpcFactory(discard.rpc),
    });
    expect(discarded.action).toBe("discard-pending");
    expect(discard.rpc.writes).toBe(writes);
    expect(existsSync(promptPolicyReceiptPath(discard.codexHome))).toBe(false);
  });

  test("restore dry-run is non-writing and redacts exact prior prompt values", async () => {
    const secret = "DO-NOT-PRINT-RESTORE-SECRET";
    const f = fixture({ compact_prompt: secret });
    await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    const writes = f.rpc.writes;
    const outcome = await restorePromptPolicy({
      ...f,
      dryRun: true,
      rpcFactory: rpcFactory(f.rpc),
    });
    const output = JSON.stringify(promptPolicySummary(outcome, true));
    expect(output).not.toContain(secret);
    expect(output).not.toContain(
      "This prompt governs local history compaction only",
    );
    expect(f.rpc.writes).toBe(writes);
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(true);
  });

  test("malformed private receipt errors do not echo receipt content", async () => {
    const secret = "DO-NOT-LEAK-MALFORMED-RECEIPT-PROMPT";
    const f = fixture({ developer_instructions: "prior" });
    await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    const receiptPath = promptPolicyReceiptPath(f.codexHome);
    writeFileSync(receiptPath, `{"developer_instructions":"${secret}",`);
    const writes = f.rpc.writes;
    let message = "";
    try {
      await restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("invalid Skizzles prompt-policy receipt");
    expect(message).not.toContain(secret);
    expect(f.rpc.writes).toBe(writes);
    expect(existsSync(receiptPath)).toBe(true);
    expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(true);
  });

  test("rejects malformed receipt scalar and path fields with controlled diagnostics", async () => {
    const cases: {
      label: string;
      mutate: (receipt: Record<string, unknown>) => void;
      message: string;
    }[] = [
      {
        label: "Codex binary",
        mutate: (receipt) => {
          receipt["codexBinary"] = 7;
        },
        message: "receipt Codex binary must be a non-empty string",
      },
      {
        label: "config path",
        mutate: (receipt) => {
          receipt["configPath"] = false;
        },
        message: "receipt config path must be a non-empty string",
      },
      {
        label: "managed target path",
        mutate: (receipt) => {
          const target = receipt["managedTarget"] as Record<string, unknown>;
          target["path"] = null;
        },
        message: "receipt managed target path must be a non-empty string",
      },
      {
        label: "descriptor path",
        mutate: (receipt) => {
          const policy = receipt["policy"] as Record<string, unknown>;
          const descriptor = policy["descriptor"] as Record<string, unknown>;
          descriptor["path"] = 1;
        },
        message: "receipt descriptor path must be a non-empty string",
      },
      {
        label: "upstream path",
        mutate: (receipt) => {
          const policy = receipt["policy"] as Record<string, unknown>;
          const upstream = policy["upstream"] as Record<string, unknown>;
          upstream["path"] = {};
        },
        message: "upstream path must be a non-empty string",
      },
      {
        label: "legal source path",
        mutate: (receipt) => {
          const policy = receipt["policy"] as Record<string, unknown>;
          const license = policy["license"] as Record<string, unknown>;
          license["sourcePath"] = [];
        },
        message: "receipt LICENSE sourcePath must be a non-empty string",
      },
      {
        label: "model instructions value",
        mutate: (receipt) => {
          const values = receipt["values"] as Record<string, unknown>[];
          const value = values[0];
          if (value) {
            value["after"] = 42;
          }
        },
        message: "receipt model instructions target must be a string",
      },
    ];

    for (const testCase of cases) {
      const f = fixture();
      await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
      const receiptPath = promptPolicyReceiptPath(f.codexHome);
      const parsed: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("test receipt must be an object");
      }
      testCase.mutate(parsed as Record<string, unknown>);
      writeFileSync(receiptPath, `${JSON.stringify(parsed, null, 2)}\n`, {
        mode: 0o600,
      });
      const writes = f.rpc.writes;
      await expect(
        restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
        testCase.label,
      ).rejects.toThrow(testCase.message);
      expect(f.rpc.writes).toBe(writes);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(true);
    }
  });

  test("refuses duplicate ownership and reports config drift without secret content", async () => {
    const f = fixture();
    await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    await expect(
      applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
    ).rejects.toThrow("already active");
    setValue(f.rpc.config, "compact_prompt", "foreign private compact text");
    let message = "";
    try {
      await restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("compact_prompt");
    expect(message).not.toContain("foreign private compact text");
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(true);
  });

  test("refuses managed prompt content and permission drift without config mutation", async () => {
    for (const mutation of [
      "content",
      "file-mode",
      "directory-mode",
    ] as const) {
      const f = fixture();
      await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
      if (mutation === "content") {
        writeFileSync(promptPolicyManagedPath(f.codexHome), "tampered\n");
      } else if (mutation === "file-mode") {
        chmodSync(promptPolicyManagedPath(f.codexHome), 0o644);
      } else {
        chmodSync(dirname(promptPolicyManagedPath(f.codexHome)), 0o755);
      }
      const writes = f.rpc.writes;
      await expect(
        restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
      ).rejects.toThrow();
      expect(f.rpc.writes).toBe(writes);
      expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(true);
    }
  });

  test("refuses an orphan managed target without creating a receipt", async () => {
    const f = fixture();
    mkdirSync(dirname(promptPolicyManagedPath(f.codexHome)), {
      recursive: true,
    });
    writeFileSync(promptPolicyManagedPath(f.codexHome), "foreign\n");
    await expect(
      applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
    ).rejects.toThrow("ownership is incomplete");
    expect(f.rpc.writes).toBe(0);
  });

  test("preserves an orphan receipt as foreign evidence", async () => {
    const f = fixture();
    const receipt = promptPolicyReceiptPath(f.codexHome);
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, '{"foreign":true}\n', { mode: 0o600 });
    await expect(
      applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
    ).rejects.toThrow("ownership is incomplete");
    expect(readFileSync(receipt, "utf8")).toBe('{"foreign":true}\n');
    expect(f.rpc.writes).toBe(0);
  });

  test("rejects wrong binary, escaped config path, swapped target, and insecure receipt mode", async () => {
    for (const mutation of ["binary", "config", "target", "mode"] as const) {
      const f = fixture();
      await applyPromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) });
      const receiptPath = promptPolicyReceiptPath(f.codexHome);
      if (mutation === "mode") {
        chmodSync(receiptPath, 0o644);
      } else {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        if (mutation === "binary") {
          receipt.codexBinary = join(f.root, "other-codex");
        }
        if (mutation === "config") {
          receipt.configPath = join(f.root, "escaped.toml");
        }
        if (mutation === "target") {
          receipt.managedTarget.path = join(
            f.codexHome,
            ".skizzles",
            "other.md",
          );
        }
        writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
          mode: 0o600,
        });
        chmodSync(receiptPath, 0o600);
      }
      const writes = f.rpc.writes;
      await expect(
        restorePromptPolicy({ ...f, rpcFactory: rpcFactory(f.rpc) }),
      ).rejects.toThrow();
      expect(f.rpc.writes).toBe(writes);
      expect(existsSync(receiptPath)).toBe(true);
    }
  });
});
