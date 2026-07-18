// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  buildPlugin,
  checkPlugin,
  compareTrees,
  PackagingError,
  stagePlugin,
} from "../src/plugin-package.ts";
import {
  PromptPolicyPackageError,
  stagePromptPolicyPackage,
} from "../src/prompt-policy-package.ts";

const temporaryRoots: string[] = [];
const PLUGIN_ROOT_TOKEN = ["$", "{", "PLUGIN_ROOT", "}"].join("");
const EXTERNAL_ZOD_IMPORT = /(?:from\s+|require\()["']zod["']/;
const YAML_LAB_ID = /^yaml-/;
const CLI_SMOKE_TIMEOUT_MS = 3_000;
const CLI_SMOKE_OUTPUT_LIMIT_BYTES = 16_384;
const MODEL_CATALOG_USAGE =
  "usage: skizzles-model-catalog <refresh|service|render-launch-agent> [options]";

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("deterministic plugin packaging", () => {
  test("uses the root lockfile for the Container Lab workspace", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const rootPackage = (await Bun.file(
      join(repoRoot, "package.json"),
    ).json()) as { workspaces?: unknown };
    expect(rootPackage.workspaces).toContain("packages/*");
    expect(
      await Bun.file(
        join(repoRoot, "packages/container-lab/bun.lock"),
      ).exists(),
    ).toBe(false);
    expect(await readFile(join(repoRoot, "bun.lock"), "utf8")).toContain(
      '"@skizzles/container-lab@workspace:packages/container-lab"',
    );
  });

  test("canonical hook discovery contract uses plugin-root commands", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const hooks = await Bun.file(
      join(repoRoot, "packages/command-hook/assets/hooks.json"),
    ).json();

    expect(hooks).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `bun "${PLUGIN_ROOT_TOKEN}/hooks/manage-command-output.ts"`,
                timeout: 3,
                statusMessage: "checking command output management",
              },
            ],
          },
        ],
      },
    });
  });

  test("plugin manifest uses the authoritative repository origin", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const manifest = await Bun.file(
      join(
        repoRoot,
        "packages/plugin-builder/template/.codex-plugin/plugin.json",
      ),
    ).json();
    expect(manifest.homepage).toBe("https://github.com/xsyetopz/skizzles");
    expect(manifest.repository).toBe("https://github.com/xsyetopz/skizzles");
    expect(manifest.author).toEqual({ name: "Robert Sale" });
  });

  test("stages only allowlisted canonical inputs deterministically", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/SKILL.md",
      "---\nname: example\ndescription: Example skill.\n---\n",
    );
    await write(root, "skills/example/dist/build.js", "build residue\n");
    await write(root, "README.md", "must not be packaged\n");

    const first = join(root, "stage-one");
    const second = join(root, "stage-two");
    await stagePlugin(root, first);
    await stagePlugin(root, second);

    expect(await compareTrees(first, second)).toEqual([]);
    expect(
      await readFile(join(first, "runtime/codex-command.ts"), "utf8"),
    ).toContain("fixture supervisor");
    expect(
      await readFile(join(first, "runtime/model-catalog.ts"), "utf8"),
    ).toContain("fixture model catalog");
    expect(await readFile(join(first, "scripts/analyze.ts"), "utf8")).toContain(
      "fixture usage analyzer",
    );
    expect(
      await readFile(join(first, "hooks/manage-command-output.ts"), "utf8"),
    ).toContain("fixture command hook");
    expect(
      await Bun.file(join(first, "skills/example/dist/build.js")).exists(),
    ).toBe(false);
    for (const legacyPath of [
      "hooks/manage-command-output",
      "runtime/codex-command",
      "runtime/model-catalog",
      "scripts/usage-analyzer",
    ]) {
      expect(await Bun.file(join(first, legacyPath)).exists()).toBe(false);
    }
    const installer = await readFile(
      join(first, "packages/installer/src/cli.ts"),
      "utf8",
    );
    expect(installer).toContain("usage: skizzles-installer ");
    expect(installer).not.toContain("usage: bun packages/installer/src/cli.ts");
    expect(await Bun.file(join(first, "README.md")).exists()).toBe(false);
    expect(await filesUnder(join(first, "instructions"))).toEqual([
      "compact-prompt.md",
      "developer-instructions.md",
      "skizzles-base.md",
      "skizzles-base.provenance.json",
    ]);
    expect(await filesUnder(join(first, "third_party/openai-codex"))).toEqual([
      "LICENSE",
      "NOTICE",
    ]);
    expect(
      await Bun.file(
        join(first, "packages/prompt-layer/assets/upstream/default.md"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/prompt-layer/assets/skizzles-base.patch"),
      ).exists(),
    ).toBe(false);
    expect(
      await Bun.file(
        join(first, "packages/prompt-layer/assets/manifest.json"),
      ).exists(),
    ).toBe(false);
    expect(await filesUnder(join(first, "packages/installer"))).toEqual([
      "package.json",
      "src/cli.ts",
    ]);
  });

  test("rejects template-injected prompt baselines, patches, tooling, and transaction artifacts", async () => {
    for (const path of [
      "packages/prompt-layer/assets/upstream/default.md",
      "packages/prompt-layer/assets/skizzles-base.patch",
      "packages/prompt-layer/assets/.transaction/journal.json",
      "packages/prompt-layer/src/prompt-layer.ts",
      "packages/prompt-layer/test/prompt-layer.test.ts",
    ] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/plugin-builder/template/${path}`,
        "template-injected maintainer artifact\n",
      );
      const reportedPath = path.startsWith("packages/prompt-layer/assets/")
        ? "packages/prompt-layer/assets"
        : path;

      await expect(stagePlugin(root, join(root, "stage"))).rejects.toEqual(
        new PackagingError(
          `Packaged plugin contains maintainer-only prompt-layer artifact ${reportedPath}.`,
        ),
      );
    }

    const emptyDirectoryRoot = await fixture();
    await mkdir(
      join(
        emptyDirectoryRoot,
        "packages/plugin-builder/template/packages/prompt-layer/assets",
      ),
      { recursive: true },
    );
    await expect(
      stagePlugin(emptyDirectoryRoot, join(emptyDirectoryRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError(
        "Packaged plugin contains maintainer-only prompt-layer artifact packages/prompt-layer/assets.",
      ),
    );
  });

  test("rejects extra files in controlled prompt and OpenAI legal roots", async () => {
    for (const injection of [
      {
        path: "instructions/unexpected.md",
        message:
          "packaged prompt instructions must contain exactly compact-prompt.md, developer-instructions.md, skizzles-base.md, skizzles-base.provenance.json.",
      },
      {
        path: "third_party/openai-codex/COPYING",
        message:
          "packaged OpenAI Codex legal directory must contain exactly LICENSE, NOTICE.",
      },
    ] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/plugin-builder/template/${injection.path}`,
        "unexpected controlled-root file\n",
      );

      await expect(stagePlugin(root, join(root, "stage"))).rejects.toEqual(
        new PackagingError(injection.message),
      );
    }
  });

  test("preserves legitimate non-prompt template content", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/plugin-builder/template/docs/template-note.md",
      "# Legitimate plugin documentation\n",
    );
    const destination = join(root, "stage");

    await stagePlugin(root, destination);

    expect(
      await readFile(join(destination, "docs/template-note.md"), "utf8"),
    ).toBe("# Legitimate plugin documentation\n");
  });

  test("rejects missing staged installer runtime imports while excluding test-only imports", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/test/not-packaged.test.ts",
      'import "./test-helper-that-is-not-packaged.ts";\n',
    );
    await stagePlugin(root, join(root, "stage-with-test-only-import"));

    await write(
      root,
      "packages/installer/src/managed-files.ts",
      'import "./runtime-helper-that-is-not-packaged.ts";\n',
    );
    await expect(
      stagePlugin(root, join(root, "stage-with-missing-runtime-import")),
    ).rejects.toThrow(
      "Unable to create the dependency-self-contained installer bundle",
    );
  });

  test("rejects Bun-resolved installer imports outside the staged installer root", async () => {
    const root = await fixture();
    await write(root, "runtime/outside.ts", "export const outside = true;\n");
    await write(
      root,
      "packages/installer/src/managed-files.ts",
      'import "../../../runtime/outside.ts";\n',
    );

    await expect(
      stagePlugin(root, join(root, "stage-with-escaped-installer-import")),
    ).rejects.toThrow("Resolved package import escapes its source root.");
  });

  test("requires public staged installer usage without canonical source paths", async () => {
    const root = await fixture();
    await stagePlugin(root, join(root, "stage-with-loadable-installer-cli"));

    for (const usage of [
      "usage: bun packages/installer/src/cli.ts <command>",
      "usage: skizzles-installer <command> (packages/installer/src/cli.ts)",
    ]) {
      const invalidRoot = await fixture();
      await write(
        invalidRoot,
        "packages/installer/src/cli.ts",
        `if (import.meta.main) {
  console.error(${JSON.stringify(usage)});
  process.exit(2);
}
`,
      );

      await expect(
        stagePlugin(
          invalidRoot,
          join(invalidRoot, "stage-with-internal-installer-usage"),
        ),
      ).rejects.toThrow("Packaged installer runtime validation failed.");
    }
  });

  test("bounds a staged CLI that ignores termination and keeps output pipes open", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/src/cli.ts",
      `if (import.meta.main) {
  process.on("SIGTERM", () => {});
  Bun.spawn([
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
  ], { stdout: "inherit", stderr: "inherit" });
  setInterval(() => {}, 1_000);
}
`,
    );

    const startedAt = performance.now();
    await expect(
      stagePlugin(root, join(root, "stage-with-hung-installer-cli")),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("rejects every staged installer runtime extension outside .ts", async () => {
    for (const extension of ["js", "tsx", "cjs", "json"] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/plugin-builder/template/packages/installer/src/unsupported.${extension}`,
        "export {};\n",
      );
      await expect(
        stagePlugin(root, join(root, `stage-with-unsupported-${extension}`)),
      ).rejects.toThrow(
        "Packaged installer runtime must contain exactly package.json and src/cli.ts.",
      );
    }
  });

  test("rejects tampered prompt-policy content, provenance, legal input, and descriptor shape", async () => {
    for (const mutation of [
      "prompt",
      "provenance",
      "legal",
      "descriptor",
    ] as const) {
      const root = await fixture();
      if (mutation === "prompt") {
        await write(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.md",
          "tampered\n",
        );
      } else if (mutation === "provenance") {
        await write(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
          "{}\n",
        );
      } else if (mutation === "legal") {
        await write(
          root,
          "packages/prompt-layer/assets/upstream/NOTICE",
          "tampered\n",
        );
      } else {
        const path = join(
          root,
          "packages/prompt-layer/assets/integrations/prompt-policy.json",
        );
        const descriptor = JSON.parse(await readFile(path, "utf8"));
        descriptor.unexpected = true;
        await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`);
      }
      await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow();
    }
  });

  test("rejects an invalid prompt-policy descriptor before replacing staged output", async () => {
    const root = await fixture();
    const destination = join(root, "existing-stage");
    await write(root, "existing-stage/preserved.txt", "preserved\n");
    const descriptorPath = join(
      root,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.unexpected = true;
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(stagePlugin(root, destination)).rejects.toEqual(
      new PackagingError(
        "prompt-policy descriptor has unexpected or missing fields.",
      ),
    );
    expect(await readFile(join(destination, "preserved.txt"), "utf8")).toBe(
      "preserved\n",
    );
  });

  test("binds prompt-policy descriptor facts to the exact staged instruction paths", async () => {
    const root = await fixture();
    const destination = join(root, "existing-stage");
    await write(root, "existing-stage/preserved.txt", "preserved\n");
    const descriptorPath = join(
      root,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.developerInstructions = descriptor.compactPrompt;
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(stagePlugin(root, destination)).rejects.toEqual(
      new PackagingError(
        "Prompt-policy descriptor does not match the pinned prompt-layer manifest.",
      ),
    );
    expect(await readFile(join(destination, "preserved.txt"), "utf8")).toBe(
      "preserved\n",
    );
  });

  test("rejects malformed descriptor and provenance JSON with fixed redacted diagnostics", async () => {
    const manifestRoot = await fixture();
    await write(
      manifestRoot,
      "packages/prompt-layer/assets/manifest.json",
      '{"personal":"manifest-secret"\n',
    );
    await expect(
      stagePlugin(manifestRoot, join(manifestRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError("Canonical prompt-layer verification failed."),
    );

    const descriptorRoot = await fixture();
    await write(
      descriptorRoot,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
      '{"personal":"descriptor-secret"\n',
    );
    await expect(
      stagePlugin(descriptorRoot, join(descriptorRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError("prompt-policy descriptor is not valid JSON."),
    );

    const provenanceRoot = await fixture();
    const malformed = '{"personal":"provenance-secret"\n';
    await write(
      provenanceRoot,
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
      malformed,
    );
    const descriptorPath = join(
      provenanceRoot,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.base.provenance = {
      path: "instructions/skizzles-base.provenance.json",
      ...integrity(malformed),
    };
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(
      stagePlugin(provenanceRoot, join(provenanceRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError("Canonical prompt-layer verification failed."),
    );
  });

  test("rejects coherent prompt and legal rewrites against the pinned manifest before copy", async () => {
    for (const mutation of ["prompt", "legal"] as const) {
      const root = await fixture();
      const destination = join(root, "existing-stage");
      await write(root, "existing-stage/preserved.txt", "preserved\n");
      const descriptorPath = join(
        root,
        "packages/prompt-layer/assets/integrations/prompt-policy.json",
      );
      const provenancePath = join(
        root,
        "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
      );
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
      const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
      if (mutation === "prompt") {
        const rewritten = "coherently rewritten prompt\n";
        await write(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.md",
          rewritten,
        );
        const fact = integrity(rewritten);
        descriptor.base.applied = {
          path: "instructions/skizzles-base.md",
          ...fact,
        };
        provenance.output = fact;
      } else {
        const rewritten = "coherently rewritten notice\n";
        await write(
          root,
          "packages/prompt-layer/assets/upstream/NOTICE",
          rewritten,
        );
        const fact = integrity(rewritten);
        Object.assign(descriptor.base.legal.notice, fact);
        provenance.legal.notice = fact;
      }
      const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
      await writeFile(provenancePath, provenanceText);
      descriptor.base.provenance = {
        path: "instructions/skizzles-base.provenance.json",
        ...integrity(provenanceText),
      };
      await writeFile(
        descriptorPath,
        `${JSON.stringify(descriptor, null, 2)}\n`,
      );

      await expect(stagePlugin(root, destination)).rejects.toEqual(
        new PackagingError("Canonical prompt-layer verification failed."),
      );
      expect(await readFile(join(destination, "preserved.txt"), "utf8")).toBe(
        "preserved\n",
      );
    }
  });

  test("runs the canonical verifier before staging coherent manifest rewrites with missing or fake patches", async () => {
    for (const patchMode of ["missing", "fake"] as const) {
      const root = await fixture();
      const destination = join(root, "existing-stage");
      await write(root, "existing-stage/preserved.txt", "preserved\n");
      await coherentlyRewritePromptContract(root, patchMode);

      await expect(stagePlugin(root, destination)).rejects.toEqual(
        new PackagingError("Canonical prompt-layer verification failed."),
      );
      expect(await readFile(join(destination, "preserved.txt"), "utf8")).toBe(
        "preserved\n",
      );
      expect(
        await readFile(
          join(
            root,
            "packages/prompt-layer/assets/instructions/skizzles-base.md",
          ),
          "utf8",
        ),
      ).toBe("coherently rewritten applied prompt\n");
      expect(
        await readFile(
          join(root, "packages/prompt-layer/assets/upstream/NOTICE"),
          "utf8",
        ),
      ).toBe("coherently rewritten legal notice\n");
      const patchPath = join(
        root,
        "packages/prompt-layer/assets/skizzles-base.patch",
      );
      if (patchMode === "missing") {
        expect(await Bun.file(patchPath).exists()).toBe(false);
      } else {
        expect(await readFile(patchPath, "utf8")).toBe(
          "not a valid Git patch\n",
        );
      }
    }
  });

  test("rejects tampered canonical baseline and patch bytes before destination replacement", async () => {
    for (const mutation of ["baseline", "patch"] as const) {
      const root = await fixture();
      const destination = join(root, "existing-stage");
      await write(root, "existing-stage/preserved.txt", "preserved\n");
      const sourcePath =
        mutation === "baseline"
          ? "packages/prompt-layer/assets/upstream/default.md"
          : "packages/prompt-layer/assets/skizzles-base.patch";
      await write(root, sourcePath, `tampered ${mutation}\n`);

      await expect(stagePlugin(root, destination)).rejects.toEqual(
        new PackagingError("Canonical prompt-layer verification failed."),
      );
      expect(await readFile(join(destination, "preserved.txt"), "utf8")).toBe(
        "preserved\n",
      );
      expect(await readFile(join(root, sourcePath), "utf8")).toBe(
        `tampered ${mutation}\n`,
      );
    }
  });

  test("enforces exact nested prompt manifest and provenance schemas", async () => {
    const provenanceRoot = await fixture();
    const provenancePath = join(
      provenanceRoot,
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    );
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.output.unexpected = true;
    const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
    await writeFile(provenancePath, provenanceText);
    const descriptorPath = join(
      provenanceRoot,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.base.provenance = {
      path: "instructions/skizzles-base.provenance.json",
      ...integrity(provenanceText),
    };
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    await expect(
      stagePlugin(provenanceRoot, join(provenanceRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError("Canonical prompt-layer verification failed."),
    );

    const manifestRoot = await fixture();
    const manifestPath = join(
      manifestRoot,
      "packages/prompt-layer/assets/manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.upstream.baseline.unexpected = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(
      stagePlugin(manifestRoot, join(manifestRoot, "stage")),
    ).rejects.toEqual(
      new PackagingError("Canonical prompt-layer verification failed."),
    );
  });

  test("anchors prompt provenance patch facts to the authoritative manifest", async () => {
    const root = await fixture();
    const provenancePath = join(
      root,
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    );
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    provenance.patch.sha256 = "0".repeat(64);
    const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
    await writeFile(provenancePath, provenanceText);
    const descriptorPath = join(
      root,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.base.provenance = {
      path: "instructions/skizzles-base.provenance.json",
      ...integrity(provenanceText),
    };
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(stagePlugin(root, join(root, "stage"))).rejects.toEqual(
      new PackagingError("Canonical prompt-layer verification failed."),
    );
  });

  test("closed prompt staging rejects forged source paths and destination symlink escapes", async () => {
    const forgedRoot = await fixture();
    const forgedDestination = join(forgedRoot, "direct-stage");
    const forgedOutside = await mkdtemp(
      join(tmpdir(), "prompt-policy-forged-source-"),
    );
    temporaryRoots.push(forgedOutside);
    const outsideContent = "outside source must not be trusted\n";
    await write(forgedOutside, "outside-secret", outsideContent);
    await mkdir(forgedDestination);
    await write(forgedRoot, "direct-stage/preserved.txt", "preserved\n");
    const forgedDescriptorPath = join(
      forgedRoot,
      "packages/prompt-layer/assets/integrations/prompt-policy.json",
    );
    const forgedDescriptor = JSON.parse(
      await readFile(forgedDescriptorPath, "utf8"),
    );
    forgedDescriptor.developerInstructions = {
      path: `../${basename(forgedOutside)}/outside-secret`,
      ...integrity(outsideContent),
    };
    await writeFile(
      forgedDescriptorPath,
      `${JSON.stringify(forgedDescriptor, null, 2)}\n`,
    );
    await expect(
      stagePromptPolicyPackage(forgedRoot, forgedDestination),
    ).rejects.toEqual(
      new PromptPolicyPackageError(
        "developer instructions path must be a portable path.",
      ),
    );
    expect(
      await readFile(join(forgedDestination, "preserved.txt"), "utf8"),
    ).toBe("preserved\n");
    expect(await filesUnder(forgedOutside)).toEqual(["outside-secret"]);
    expect(await readFile(join(forgedOutside, "outside-secret"), "utf8")).toBe(
      outsideContent,
    );

    const symlinkRoot = await fixture();
    const symlinkDestination = join(symlinkRoot, "direct-stage");
    const outside = await mkdtemp(join(tmpdir(), "prompt-policy-outside-"));
    temporaryRoots.push(outside);
    await write(outside, "preserved.txt", "outside preserved\n");
    await mkdir(symlinkDestination);
    await symlink(outside, join(symlinkDestination, "instructions"));
    await expect(
      stagePromptPolicyPackage(symlinkRoot, symlinkDestination),
    ).rejects.toEqual(
      new PromptPolicyPackageError(
        "Prompt-policy destination uses an unsafe path.",
      ),
    );
    expect(await filesUnder(outside)).toEqual(["preserved.txt"]);
    expect(await readFile(join(outside, "preserved.txt"), "utf8")).toBe(
      "outside preserved\n",
    );
  });

  test("rejects non-canonical prompt-policy legal mappings before staging", async () => {
    for (const mutation of [
      "license-source",
      "notice-packaged",
      "swapped",
      "duplicate-source",
      "duplicate-packaged",
    ] as const) {
      const root = await fixture();
      const path = join(
        root,
        "packages/prompt-layer/assets/integrations/prompt-policy.json",
      );
      const descriptor = JSON.parse(await readFile(path, "utf8"));
      const legal = descriptor.base.legal;
      if (mutation === "license-source") {
        legal.license.sourcePath =
          "packages/prompt-layer/assets/upstream/RENAMED-LICENSE";
      } else if (mutation === "notice-packaged") {
        legal.notice.packagedPath = "third_party/other/NOTICE";
      } else if (mutation === "swapped") {
        [legal.license.sourcePath, legal.notice.sourcePath] = [
          legal.notice.sourcePath,
          legal.license.sourcePath,
        ];
        [legal.license.packagedPath, legal.notice.packagedPath] = [
          legal.notice.packagedPath,
          legal.license.packagedPath,
        ];
      } else if (mutation === "duplicate-source") {
        legal.notice.sourcePath = legal.license.sourcePath;
      } else {
        legal.notice.packagedPath = legal.license.packagedPath;
      }
      await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`);
      await expect(
        stagePlugin(root, join(root, "stage")),
      ).rejects.toBeInstanceOf(PackagingError);
    }
  });

  test("rejects symlinked prompt-policy inputs before staging", async () => {
    const root = await fixture();
    const prompt = join(
      root,
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
    );
    await rm(prompt);
    await symlink(
      join(
        resolve(import.meta.dir, "../../.."),
        "packages/prompt-layer/assets/instructions/skizzles-base.md",
      ),
      prompt,
    );
    await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Canonical prompt-layer verification failed.",
    );

    const parentRoot = await fixture();
    const instructionRoot = "packages/prompt-layer/assets/instructions";
    await rm(join(parentRoot, instructionRoot), { recursive: true });
    await symlink(
      join(resolve(import.meta.dir, "../../.."), instructionRoot),
      join(parentRoot, instructionRoot),
    );
    await expect(
      stagePlugin(parentRoot, join(parentRoot, "stage")),
    ).rejects.toThrow("Canonical prompt-layer verification failed.");
  });

  test("check reports generated drift", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await checkPlugin(root);
    await write(root, "plugins/skizzles/unexpected.txt", "drift\n");

    expect(checkPlugin(root)).rejects.toThrow("unexpected unexpected.txt");
  });

  test("check reports generated executable-mode drift", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/plugin-builder/template/runtime/executable.ts",
      "console.log('ok');\n",
    );
    await chmod(
      join(root, "packages/plugin-builder/template/runtime/executable.ts"),
      0o755,
    );
    await buildPlugin(root);
    await chmod(join(root, "plugins/skizzles/runtime/executable.ts"), 0o644);

    expect(checkPlugin(root)).rejects.toThrow(
      "changed mode runtime/executable.ts",
    );
  });

  test("check reports drift in the bundled Container Lab runtime", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(
      root,
      "packages/container-lab/src/cli.ts",
      "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ help: 'changed' }));\n",
    );

    expect(checkPlugin(root)).rejects.toThrow(
      "changed packages/container-lab/src/cli.ts",
    );
  });

  test("ships runnable dependency-self-contained Container Lab bundles", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-container-lab-plugin-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "staged");
    const isolatedPlugin = join(temporaryRoot, "isolated");
    await stagePlugin(repoRoot, stagedPlugin);
    await cp(stagedPlugin, isolatedPlugin, { recursive: true });

    const runtimeRoot = join(isolatedPlugin, "packages/container-lab");
    expect(await filesUnder(runtimeRoot)).toEqual([
      "LICENSE",
      "docs/architecture.md",
      "docs/completion-contract.md",
      "docs/installation.md",
      "docs/manifest.md",
      "docs/safety.md",
      "install/com.openai.codex-container-lab-reaper.plist",
      "src/cli.ts",
      "src/reaper-cli.ts",
    ]);

    for (const entrypoint of ["src/cli.ts", "src/reaper-cli.ts"]) {
      const path = join(runtimeRoot, entrypoint);
      expect((await stat(path)).mode & 0o111).not.toBe(0);
      const result = Bun.spawnSync(["bun", path, "--help"], {
        cwd: isolatedPlugin,
        env: { PATH: process.env["PATH"] ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const response = JSON.parse(result.stdout.toString()) as {
        help?: unknown;
      };
      expect(typeof response.help).toBe("string");
      expect(result.stderr.toString()).toBe("");
    }
  });

  test("bundles executable workspace packages at only stable public entrypoints", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-workspace-bundles-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "staged");
    await stagePlugin(repoRoot, stagedPlugin);

    for (const path of [
      "hooks/manage-command-output.ts",
      "runtime/codex-command.ts",
      "runtime/model-catalog.ts",
      "scripts/analyze.ts",
      "packages/installer/src/cli.ts",
    ]) {
      const contents = await readFile(join(stagedPlugin, path), "utf8");
      expect(contents.length).toBeGreaterThan(0);
      expect(contents).not.toMatch(EXTERNAL_ZOD_IMPORT);
    }
    for (const path of [
      "hooks/manage-command-output",
      "runtime/codex-command",
      "runtime/model-catalog",
      "scripts/usage-analyzer",
    ]) {
      expect(await Bun.file(join(stagedPlugin, path)).exists()).toBe(false);
    }
    expect(await filesUnder(join(stagedPlugin, "packages/installer"))).toEqual([
      "package.json",
      "src/cli.ts",
    ]);
  });

  test("initializes the bundled Model Catalog and reaches its CLI usage contract", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "skizzles-model-catalog-bundle-"),
    );
    temporaryRoots.push(temporaryRoot);
    const stagedPlugin = join(temporaryRoot, "plugin");
    await stagePlugin(repoRoot, stagedPlugin);

    const result = Bun.spawnSync(
      [process.execPath, join(stagedPlugin, "runtime/model-catalog.ts")],
      {
        cwd: stagedPlugin,
        env: { PATH: process.env["PATH"] ?? "" },
        killSignal: "SIGKILL",
        maxBuffer: CLI_SMOKE_OUTPUT_LIMIT_BYTES,
        stderr: "pipe",
        stdout: "pipe",
        timeout: CLI_SMOKE_TIMEOUT_MS,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(`${MODEL_CATALOG_USAGE}\n`);
  });

  test("exercises bundled YAML manifest configuration with a fake Docker binary", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const root = await mkdtemp(
      join(tmpdir(), "skizzles-container-lab-bundle-config-"),
    );
    temporaryRoots.push(root);
    const plugin = join(root, "plugin");
    const source = join(root, "source");
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const bin = join(root, "bin");
    await stagePlugin(repoRoot, plugin);
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("config")) console.log(JSON.stringify({ services: { lab: { image: "ubuntu:24.04" } } }));\nprocess.exit(0);\n`,
    );
    await chmod(join(bin, "docker"), 0o755);
    await mkdir(source);
    await writeFile(
      join(source, ".codex-container-lab.yaml"),
      "image: { name: ubuntu:24.04, service: lab }\nruntime: { workspace: /workspace, shell: [/bin/sh, -lc] }\n",
    );
    Bun.spawnSync(["git", "init", "-q", source]);
    Bun.spawnSync(["git", "-C", source, "add", "."]);
    Bun.spawnSync([
      "git",
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);

    const result = Bun.spawnSync(
      [
        "bun",
        join(plugin, "packages/container-lab/src/cli.ts"),
        "--owner",
        "bundle-yaml",
        "--state-root",
        stateRoot,
        "--runtime-root",
        runtimeRoot,
        "lab",
        "create",
        "--name",
        "yaml",
        "--source",
        source,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const response = JSON.parse(result.stdout.toString()) as {
      labId: string;
      state: string;
    };
    if (response.state !== "ready") {
      const stateFiles = await filesUnder(stateRoot);
      const state = await Promise.all(
        stateFiles.map(
          async (path) =>
            `${path}: ${await readFile(join(stateRoot, path), "utf8")}`,
        ),
      );
      throw new Error(
        `bundled configuration fixture failed: ${state.join("\\n")}`,
      );
    }
    expect(response).toMatchObject({
      labId: expect.stringMatching(YAML_LAB_ID),
      state: "ready",
    });
  });

  test("rejects stale Container Lab descriptor metadata before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(
      root,
      "packages/container-lab/assets/integrations/container-lab.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.configuredRuntime = "9.9.9";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
    await expect(
      stagePlugin(root, join(root, "stage-error-type")),
    ).rejects.toBeInstanceOf(PackagingError);
  });

  test("rejects stale Container Lab provenance and canonical ownership paths before staging", async () => {
    const root = await fixture();
    const descriptorPath = join(
      root,
      "packages/container-lab/assets/integrations/container-lab.json",
    );
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    descriptor.ownership.provenanceCommit =
      "0000000000000000000000000000000000000000";
    descriptor.ownership.canonicalSource = "packages/other-container-lab";
    await writeFile(descriptorPath, JSON.stringify(descriptor));

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs",
    );
  });

  test("rejects Finder metadata in canonical package inputs", async () => {
    const root = await fixture();
    await write(root, "skills/.DS_Store", "local metadata");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "skills/.DS_Store looks like local or live state",
    );
  });

  test("rejects Finder metadata in generated output", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(root, "plugins/skizzles/.DS_Store", "local metadata");

    expect(checkPlugin(root)).rejects.toThrow(
      "generated plugin contains forbidden Finder metadata at .DS_Store",
    );
  });

  test("rejects machine-specific paths in distributable output", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/machine-path.md",
      "export const path = '/Users/alice/.codex';\n",
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "contains machine-specific path /Users/alice/",
    );
  });

  test("rejects environment and credential artifacts", async () => {
    const root = await fixture();
    // biome-ignore lint/security/noSecrets: Deliberate fake credential content exercises rejection.
    await write(root, "skills/example/.env.production", "TOKEN=secret\n");
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "looks like local or live state",
    );
  });

  test("validates creator-required manifest metadata", async () => {
    const root = await fixture();
    const manifestPath = join(
      root,
      "packages/plugin-builder/template/.codex-plugin/plugin.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "not-semver";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "skizzles", version: "not-semver" }),
    );
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "strict semver",
    );
  });

  test("rejects hooks that bypass PLUGIN_ROOT", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/command-hook/assets/hooks.json",
      JSON.stringify({ hooks: [{ command: "bun runtime/hook.ts" }] }),
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      `must resolve bundled commands through ${PLUGIN_ROOT_TOKEN}`,
    );
  });

  test("rejects live-state artifacts", async () => {
    const root = await fixture();
    await write(root, "skills/example/session.sqlite", "state");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toBeInstanceOf(
      PackagingError,
    );
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-package-test-"));
  temporaryRoots.push(root);
  await write(
    root,
    "package.json",
    JSON.stringify(
      { name: "skizzles", version: "0.1.0", private: true },
      null,
      2,
    ),
  );
  await write(
    root,
    "skills/example/SKILL.md",
    "---\nname: example\ndescription: Fixture skill.\n---\n",
  );
  await write(
    root,
    "packages/plugin-builder/template/.codex-plugin/plugin.json",
    JSON.stringify(
      {
        name: "skizzles",
        version: "0.1.0",
        description: "fixture",
        author: { name: "Fixture" },
        homepage: "https://github.com/xsyetopz/skizzles",
        repository: "https://github.com/xsyetopz/skizzles",
        skills: "./skills/",
        interface: {
          displayName: "Skizzles",
          shortDescription: "fixture",
          longDescription: "fixture",
          developerName: "Fixture",
          category: "Developer Tools",
          capabilities: [],
          defaultPrompt: ["Use fixture"],
        },
      },
      null,
      2,
    ),
  );
  await write(
    root,
    ".agents/plugins/marketplace.json",
    JSON.stringify(
      {
        name: "skizzles",
        plugins: [
          {
            name: "skizzles",
            source: { source: "local", path: "./plugins/skizzles" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Developer Tools",
          },
        ],
      },
      null,
      2,
    ),
  );
  await write(
    root,
    "packages/container-lab/src/cli.ts",
    "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture cli' }));\n",
  );
  for (const path of [
    "codex-config.ts",
    "config.ts",
    "core.ts",
    "doctor.ts",
    "harness.ts",
    "managed-files.ts",
    "prompt-policy-lock.ts",
    "prompt-policy.ts",
  ]) {
    await write(
      root,
      `packages/installer/src/${path}`,
      path === "codex-config.ts"
        ? 'export { fixture } from "./managed-files.ts";\n'
        : `export const fixture = "${path}";\n`,
    );
  }
  await write(
    root,
    "packages/installer/src/cli.ts",
    'import "./managed-files.ts";\nif (import.meta.main) {\n  console.error("usage: skizzles-installer <command>");\n  process.exit(2);\n}\n',
  );
  await write(
    root,
    "packages/installer/package.json",
    JSON.stringify({
      name: "@skizzles/installer",
      version: "0.1.0",
      private: true,
      type: "module",
    }),
  );
  await write(
    root,
    "packages/command-hook/assets/hooks.json",
    JSON.stringify({
      hooks: [
        {
          command: `bun "${PLUGIN_ROOT_TOKEN}/hooks/manage-command-output.ts"`,
        },
      ],
    }),
  );
  await write(
    root,
    "packages/command-hook/src/manage-command-output.ts",
    'import { marker } from "./manage-command-output/policy.ts";\nconsole.log(marker);\n',
  );
  await write(
    root,
    "packages/command-hook/src/manage-command-output/policy.ts",
    'export const marker = "fixture command hook";\n',
  );
  await write(
    root,
    "packages/command-supervisor/src/codex-command.ts",
    'import { marker } from "./codex-command/cli.ts";\nconsole.log(marker);\n',
  );
  await write(
    root,
    "packages/command-supervisor/src/codex-command/cli.ts",
    'export const marker = "fixture supervisor";\n',
  );
  await write(
    root,
    "packages/model-catalog/src/index.ts",
    'import { marker } from "./catalog-schema.ts";\nconsole.log(marker);\n',
  );
  await write(
    root,
    "packages/model-catalog/src/catalog-schema.ts",
    'export const marker = "fixture model catalog";\n',
  );
  await write(
    root,
    "packages/model-catalog/assets/com.openai.skizzles-model-catalog.plist",
    "<plist/>\n",
  );
  await write(
    root,
    "packages/model-catalog/docs/installation.md",
    "# Fixture model catalog installation\n",
  );
  await write(
    root,
    "packages/usage-analyzer/src/main.ts",
    'import { marker } from "./usage.ts";\nconsole.log(marker);\n',
  );
  await write(
    root,
    "packages/usage-analyzer/src/usage.ts",
    'export const marker = "fixture usage analyzer";\n',
  );
  await write(
    root,
    "packages/container-lab/src/reaper-cli.ts",
    "#!/usr/bin/env bun\nif (import.meta.main) console.log(JSON.stringify({ help: 'fixture reaper' }));\n",
  );
  await write(
    root,
    "packages/container-lab/package.json",
    JSON.stringify({
      name: "@skizzles/container-lab",
      version: "0.1.0",
      type: "module",
    }),
  );
  await write(
    root,
    "packages/container-lab/install/com.openai.codex-container-lab-reaper.plist",
    '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n',
  );
  await write(root, "packages/container-lab/LICENSE", "fixture license\n");
  for (const document of [
    "architecture",
    "completion-contract",
    "installation",
    "manifest",
    "safety",
  ]) {
    await write(
      root,
      `packages/container-lab/docs/${document}.md`,
      `# ${document}\n`,
    );
  }
  await write(
    root,
    "skills/codex-container-lab/scripts/codex-container-lab",
    "#!/usr/bin/env bun\nconsole.log('fixture');\n",
  );
  await chmod(
    join(root, "skills/codex-container-lab/scripts/codex-container-lab"),
    0o755,
  );
  await write(
    root,
    "packages/container-lab/assets/integrations/container-lab.json",
    JSON.stringify({
      configuredRuntime: "0.1.0",
      ownership: {
        runtimeOwner: "skizzles",
        canonicalSource: "packages/container-lab",
        // biome-ignore lint/security/noSecrets: This is a public source-provenance commit digest.
        provenanceCommit: "a2f44416ef467d9f54b3cb228e3bd050987a3c4c",
      },
      bundled: {
        operationalEntrypoint: "packages/container-lab/src/cli.ts",
        reaperEntrypoint: "packages/container-lab/src/reaper-cli.ts",
        launcher: "skills/codex-container-lab/scripts/codex-container-lab",
        launchAgentTemplate:
          "packages/container-lab/install/com.openai.codex-container-lab-reaper.plist",
        documentation: [
          "packages/container-lab/docs/architecture.md",
          "packages/container-lab/docs/completion-contract.md",
          "packages/container-lab/docs/installation.md",
          "packages/container-lab/docs/manifest.md",
          "packages/container-lab/docs/safety.md",
        ],
      },
    }),
  );
  const canonicalRoot = resolve(import.meta.dir, "../../..");
  for (const path of [
    "packages/prompt-layer/assets/integrations/prompt-policy.json",
    "packages/prompt-layer/assets/instructions/skizzles-base.md",
    "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    "packages/prompt-layer/assets/instructions/developer-instructions.md",
    "packages/prompt-layer/assets/instructions/compact-prompt.md",
    "packages/prompt-layer/assets/manifest.json",
    "packages/prompt-layer/assets/skizzles-base.patch",
    "packages/prompt-layer/assets/upstream/default.md",
    "packages/prompt-layer/assets/upstream/LICENSE",
    "packages/prompt-layer/assets/upstream/NOTICE",
  ]) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(canonicalRoot, path), destination);
  }
  return root;
}

async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function integrity(content: string): { sha256: string; bytes: number } {
  const bytes = Buffer.from(content);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

async function coherentlyRewritePromptContract(
  root: string,
  patchMode: "missing" | "fake",
): Promise<void> {
  const manifestPath = join(root, "packages/prompt-layer/assets/manifest.json");
  const descriptorPath = join(
    root,
    "packages/prompt-layer/assets/integrations/prompt-policy.json",
  );
  const provenancePath = join(
    root,
    "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
  );
  const patchPath = join(
    root,
    "packages/prompt-layer/assets/skizzles-base.patch",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));

  const prompt = "coherently rewritten applied prompt\n";
  const promptFact = integrity(prompt);
  await write(
    root,
    "packages/prompt-layer/assets/instructions/skizzles-base.md",
    prompt,
  );
  manifest.output = {
    path: "instructions/skizzles-base.md",
    ...promptFact,
  };
  descriptor.base.applied = {
    path: "instructions/skizzles-base.md",
    ...promptFact,
  };
  provenance.output = promptFact;

  const notice = "coherently rewritten legal notice\n";
  const noticeFact = integrity(notice);
  await write(root, "packages/prompt-layer/assets/upstream/NOTICE", notice);
  manifest.upstream.notice = {
    path: "packages/prompt-layer/assets/upstream/NOTICE",
    ...noticeFact,
  };
  Object.assign(descriptor.base.legal.notice, noticeFact);
  provenance.legal.notice = noticeFact;

  if (patchMode === "missing") {
    await rm(patchPath);
  } else {
    const patch = "not a valid Git patch\n";
    const patchFact = integrity(patch);
    await writeFile(patchPath, patch);
    manifest.patch = {
      path: "packages/prompt-layer/assets/skizzles-base.patch",
      ...patchFact,
    };
    provenance.patch = patchFact;
  }

  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  await writeFile(provenancePath, provenanceText);
  descriptor.base.provenance = {
    path: "instructions/skizzles-base.provenance.json",
    ...integrity(provenanceText),
  };
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }
  await visit(root);
  return files.sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
