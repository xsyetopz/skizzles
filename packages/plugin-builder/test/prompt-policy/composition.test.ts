// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PackagingError, stagePlugin } from "../../src/plugin/api.ts";
import { createTestWorkspace, write } from "../plugin/fixture.ts";
import { coherentlyRewritePromptContract, integrity } from "./support.ts";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("prompt-policy packaging", () => {
  it("rejects tampered prompt-policy content, provenance, legal input, and descriptor shape", async () => {
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

  it("rejects an invalid prompt-policy descriptor before replacing staged output", async () => {
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

  it("binds prompt-policy descriptor facts to the exact staged instruction paths", async () => {
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

  it("rejects malformed descriptor and provenance JSON with fixed redacted diagnostics", async () => {
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

  it("rejects coherent prompt and legal rewrites against the pinned manifest before copy", async () => {
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

  it("runs the canonical verifier before staging coherent manifest rewrites with missing or fake patches", async () => {
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

  it("rejects tampered canonical baseline and patch bytes before destination replacement", async () => {
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

  it("enforces exact nested prompt manifest and provenance schemas", async () => {
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

  it("anchors prompt provenance patch facts to the authoritative manifest", async () => {
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
});
