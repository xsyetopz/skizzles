// biome-ignore-all lint/security/noSecrets: Public upstream commits and release digests are test fixtures.
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const WORKSPACE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const ACTIONLINT_COMMIT = "914e7df21a07ef503a81201c76d2b11c789d3fca";
const ACTIONLINT_LINUX_SHA256 =
  "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8";
// Independent v1 acceptance evidence reviewed against ADR 0005 and the pinned GitHub release API records.
const REPOSITORY_SECURITY_MANIFEST_V1_SHA256 =
  "7bf3c403b36cc9cd83bc1340a8ec6ce438888c30abc162eec0232aa6484dc1fe";
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
    expect(manifest.tools.shellcheck.license).toBe("GPL-3.0-or-later");
    expect(manifest.tools.gitleaks.version).toBe("8.30.1");
    expect(Object.keys(manifest.tools.gitleaks.assets).sort()).toEqual([
      "darwin-arm64",
      "linux-x64",
    ]);
  });

  it("matches the independently reviewed complete v1 manifest", async () => {
    const source = await manifestSource();
    const digest = createHash("sha256").update(source).digest("hex");

    expect(digest).toBe(REPOSITORY_SECURITY_MANIFEST_V1_SHA256);
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

    for (const replacement of ["0".repeat(40), "1".repeat(40)]) {
      const provenance: unknown = JSON.parse(
        source.replace(ACTIONLINT_COMMIT, replacement),
      );
      expect(() => parseRepositorySecurityToolManifest(provenance)).toThrow(
        "does not match the pinned upstream release",
      );
    }

    for (const [expected, replacement] of [
      ["rhysd/actionlint", "attacker/actionlint"],
      ["v1.7.12", "v1.7.13"],
    ]) {
      const provenance: unknown = JSON.parse(
        source.replace(`"${expected}"`, `"${replacement}"`),
      );
      expect(() => parseRepositorySecurityToolManifest(provenance)).toThrow(
        "does not match the pinned upstream release",
      );
    }

    const assetIdentity: unknown = JSON.parse(
      source.replace('"assetId": 384924896', '"assetId": 384924897'),
    );
    expect(() => parseRepositorySecurityToolManifest(assetIdentity)).toThrow(
      "does not match pinned primary API evidence",
    );
  });

  it("rejects internally consistent drift in every immutable tool field", async () => {
    const source = await manifestSource();
    const replacementDigest = "0".repeat(64);
    const mutations = [
      source.replaceAll(ACTIONLINT_LINUX_SHA256, replacementDigest),
      source.replace(
        "actionlint_1.7.12_linux_amd64.tar.gz",
        "actionlint_1.7.12_linux_x64.tar.gz",
      ),
      source.replace(
        '"executablePath": "actionlint"',
        '"executablePath": "bin/actionlint"',
      ),
      source.replace('"bytes": 2353908', '"bytes": 2353909'),
      source.replace(
        '"updatedAt": "2026-03-30T17:49:19Z"',
        '"updatedAt": "2026-03-30T17:49:20Z"',
      ),
      source.replace(
        '"versionCommand": ["-version"]',
        '"versionCommand": ["--version"]',
      ),
      source.replace(
        '"versionOutputPattern": "^1\\\\.7\\\\.12(?:\\\\r?\\\\n|$)"',
        '"versionOutputPattern": "^1\\\\.7\\\\.12$"',
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source);
      const input: unknown = JSON.parse(mutation);
      expect(() => parseRepositorySecurityToolManifest(input)).toThrow();
    }
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
    const original = manifest.tools.actionlint.assets["darwin-arm64"];
    const tamperedBytes = new Uint8Array(16);
    const fakeFetch = async (): Promise<Response> =>
      new Response(tamperedBytes, {
        status: 200,
        headers: { "content-length": String(tamperedBytes.byteLength) },
      });
    const asset = {
      ...original,
      githubReleaseAsset: {
        ...original.githubReleaseAsset,
        bytes: tamperedBytes.byteLength,
      },
    };

    await expect(
      downloadVerifiedArchive(asset, destination, fakeFetch),
    ).rejects.toThrow("checksum mismatch");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe, missing, looping, and excessive redirect chains", async () => {
    const manifest = await loadRepositorySecurityToolManifest(WORKSPACE_ROOT);
    const asset = manifest.tools.actionlint.assets["darwin-arm64"];
    const root = await temporaryRoot();

    let calls = 0;
    const evilRedirect = async (_input: string, init: RequestInit) => {
      calls += 1;
      expect(init.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "//evil.example/archive" },
      });
    };
    await expect(
      downloadVerifiedArchive(asset, join(root, "evil"), evilRedirect),
    ).rejects.toThrow("unapproved URL");
    expect(calls).toBe(1);

    const missingLocation = async (): Promise<Response> =>
      new Response(null, { status: 302 });
    await expect(
      downloadVerifiedArchive(asset, join(root, "missing"), missingLocation),
    ).rejects.toThrow("omitted its location");

    const loop = async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { location: asset.url },
      });
    await expect(
      downloadVerifiedArchive(asset, join(root, "loop"), loop),
    ).rejects.toThrow("redirect loop");

    let hop = 0;
    const excessive = async (): Promise<Response> => {
      hop += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/approved-hop/${hop}` },
      });
    };
    await expect(
      downloadVerifiedArchive(asset, join(root, "excessive"), excessive),
    ).rejects.toThrow("redirect limit");
  });

  it("accepts a safe relative redirect and verifies the final bytes", async () => {
    const manifest = await loadRepositorySecurityToolManifest(WORKSPACE_ROOT);
    const original = manifest.tools.actionlint.assets["darwin-arm64"];
    const root = await temporaryRoot();
    const destination = join(root, "archive.tar.gz");
    const bytes = new TextEncoder().encode("verified archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset = {
      ...original,
      sha256,
      githubReleaseAsset: {
        ...original.githubReleaseAsset,
        bytes: bytes.byteLength,
        digest: `sha256:${sha256}`,
      },
    };
    let request = 0;
    const redirected = async (): Promise<Response> => {
      request += 1;
      if (request === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/approved/final.tar.gz" },
        });
      }
      return new Response(bytes, { status: 200 });
    };

    await downloadVerifiedArchive(asset, destination, redirected);
    expect(await readFile(destination)).toEqual(Buffer.from(bytes));
    expect(request).toBe(2);
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
