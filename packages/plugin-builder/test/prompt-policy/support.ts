import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { write } from "../plugin/fixture.ts";

export function integrity(content: string): { sha256: string; bytes: number } {
  const bytes = Buffer.from(content);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

export async function coherentlyRewritePromptContract(
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
