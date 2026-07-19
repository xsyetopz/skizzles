// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PackagingError, stagePlugin } from "../../src/plugin/api.ts";
import {
  PromptPolicyPackageError,
  stagePromptPolicyPackage,
} from "../../src/prompt-policy/composition.ts";
import { createTestWorkspace, filesUnder, write } from "../plugin/fixture.ts";
import { integrity } from "./support.ts";

const { cleanup, fixture, temporaryRoots } = createTestWorkspace();
afterEach(cleanup);

describe("prompt-policy containment boundaries", () => {
  it("closed prompt staging rejects forged source paths and destination symlink escapes", async () => {
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

  it("rejects non-canonical prompt-policy legal mappings before staging", async () => {
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

  it("rejects symlinked prompt-policy inputs before staging", async () => {
    const root = await fixture();
    const prompt = join(
      root,
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
    );
    await rm(prompt);
    await symlink(
      join(
        resolve(import.meta.dir, "../../../.."),
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
      join(resolve(import.meta.dir, "../../../.."), instructionRoot),
      join(parentRoot, instructionRoot),
    );
    await expect(
      stagePlugin(parentRoot, join(parentRoot, "stage")),
    ).rejects.toThrow("Canonical prompt-layer verification failed.");
  });
});
