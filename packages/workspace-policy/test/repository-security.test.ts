// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseActionlintFindings } from "../src/repository-security/actionlint-gate.ts";
import { runBoundedCommand } from "../src/repository-security/bounded-process.ts";
import { validateArchiveMemberPath } from "../src/repository-security/security-tool-contract.ts";
import {
  loadRepositorySecurityToolManifest,
  parseRepositorySecurityToolManifest,
  resolveSecurityToolTarget,
} from "../src/repository-security/security-tool-manifest.ts";
import {
  downloadVerifiedArchive,
  validateArchiveEntries,
} from "../src/repository-security/security-tool-runtime.ts";
import { validateWorkflowActionPins } from "../src/repository-security/workflow-action-pins.ts";

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository security tool manifest", () => {
  it("parses the exact pinned platform and provenance contract", async () => {
    const manifest = await loadRepositorySecurityToolManifest(WORKSPACE_ROOT);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.tools.actionlint.version).toBe("1.7.12");
    expect(manifest.tools.shellcheck.version).toBe("0.11.0");
    expect(manifest.tools.gitleaks.version).toBe("8.30.1");
    expect(Object.keys(manifest.tools.gitleaks.assets).sort()).toEqual([
      "darwin-arm64",
      "linux-x64",
    ]);
  });

  it("rejects unsupported targets, drifted pins, and unknown fields", async () => {
    expect(() => resolveSecurityToolTarget("win32", "x64")).toThrow(
      "do not support platform win32/x64",
    );

    const source = await manifestSource();
    const drifted: unknown = JSON.parse(
      source.replace('"version": "1.7.12"', '"version": "1.7.13"'),
    );
    expect(() => parseRepositorySecurityToolManifest(drifted)).toThrow(
      "must remain pinned to 1.7.12",
    );

    const extra: unknown = JSON.parse(
      source.replace(
        '"version": "1.7.12",',
        '"version": "1.7.12", "ambient": true,',
      ),
    );
    expect(() => parseRepositorySecurityToolManifest(extra)).toThrow(
      "keys must be exactly",
    );
  });

  it("rejects archive escape paths and duplicate executables", () => {
    for (const path of ["../tool", "/tool", "dir\\tool", "dir/./tool"]) {
      expect(() => validateArchiveMemberPath(path, "probe")).toThrow(
        "normalized contained archive path",
      );
    }
    expect(() => validateArchiveEntries("tool\ntool\n", "tool")).toThrow(
      "exactly once",
    );
    expect(() => validateArchiveEntries("../escape\ntool\n", "tool")).toThrow(
      "normalized contained archive path",
    );
  });

  it("refuses a checksum mismatch before writing the archive", async () => {
    const manifest = await loadRepositorySecurityToolManifest(WORKSPACE_ROOT);
    const root = await temporaryRoot();
    const destination = join(root, "archive.tar.gz");
    const fakeFetch = async (): Promise<Response> =>
      new Response("tampered archive", {
        status: 200,
        headers: { "content-length": "16" },
      });

    await expect(
      downloadVerifiedArchive(
        manifest.tools.actionlint.assets["darwin-arm64"],
        destination,
        fakeFetch,
      ),
    ).rejects.toThrow("checksum mismatch");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("repository security process and output contracts", () => {
  it("bounds command output and execution time", async () => {
    await expect(
      runBoundedCommand("yes", ["probe"], {
        label: "output probe",
        outputLimitBytes: 128,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("128-byte output limit");

    await expect(
      runBoundedCommand(
        process.execPath,
        ["--eval", "await Bun.sleep(10000)"],
        {
          label: "timeout probe",
          outputLimitBytes: 128,
          timeoutMs: 25,
        },
      ),
    ).rejects.toThrow("25ms timeout");
  });

  it("parses actionlint JSON arrays and JSON Lines findings", () => {
    expect(
      parseActionlintFindings(
        '[{"filepath":"ci.yml","line":2,"column":3,"message":"bad","kind":"syntax-check"}]\n',
      ),
    ).toEqual([
      {
        filepath: "ci.yml",
        line: 2,
        column: 3,
        message: "bad",
        kind: "syntax-check",
      },
    ]);
    expect(
      parseActionlintFindings(
        '{"filepath":"ci.yml","line":4,"column":5,"message":"bad line","kind":"expression"}\n',
      ),
    ).toHaveLength(1);
    expect(() => parseActionlintFindings("not-json\n")).toThrow("JSON Lines");
    expect(() =>
      parseActionlintFindings('{"message":"missing fields"}\n'),
    ).toThrow("output contract");
  });

  it("requires reviewed full-commit action pins with version comments", async () => {
    const root = await temporaryRoot();
    const workflow = join(root, "ci.yml");
    const valid =
      "jobs:\n" +
      "  check:\n" +
      "    runs-on: ubuntu-latest\n" +
      "    steps:\n" +
      "      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1\n" +
      "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n";
    await writeFile(workflow, valid, { mode: 0o600 });
    await expect(
      validateWorkflowActionPins([workflow]),
    ).resolves.toBeUndefined();

    await writeFile(workflow, valid.replace(/@[a-f0-9]{40}/u, "@v4"), {
      mode: 0o600,
    });
    await expect(validateWorkflowActionPins([workflow])).rejects.toThrow(
      "must use 34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1",
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-security-test-"));
  temporaryRoots.push(root);
  return root;
}

async function manifestSource(): Promise<string> {
  return readFile(
    join(WORKSPACE_ROOT, "config/repository-security-tools.json"),
    "utf8",
  );
}
