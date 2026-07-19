// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  exactFilesystemMetadataMatches,
  readContainedJsonAsset,
} from "../../src/agent-contract/filesystem/asset.ts";
import {
  validateCanonicalAgentContracts,
  validateStagedAgentContracts,
} from "../../src/agent-contract/validation.ts";
import { stagePlugin } from "../../src/plugin/api.ts";
import { createTestWorkspace } from "../plugin/fixture.ts";
import { rejectionMessage } from "./publication-support.ts";

const CONTEXT_SCHEMA =
  "skills/fourth-wall/contracts/context-envelope.schema.json";
const HANDOFF_SCHEMA =
  "skills/fourth-wall/contracts/handoff-review.schema.json";
const TRUST_CORPUS =
  "skills/fourth-wall/fixtures/trust-boundary-incidents.json";
const ACCEPTANCE_CORPUS =
  "skills/completion-contract/fixtures/acceptance-incidents.json";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("agent contract filesystem boundary", () => {
  it("compares filesystem identities without narrowing high bigint values", () => {
    const base = {
      dev: 9_007_199_254_740_993n,
      ino: 18_446_744_073_709_551_615n,
      nlink: 1n,
      size: 1024n,
      mtimeNs: 9_007_199_254_740_997n,
      ctimeNs: 9_007_199_254_740_999n,
    };
    expect(exactFilesystemMetadataMatches(base, { ...base })).toBe(true);
    expect(
      exactFilesystemMetadataMatches(base, {
        ...base,
        ino: 18_446_744_073_709_551_614n,
      }),
    ).toBe(false);
    expect(
      exactFilesystemMetadataMatches(base, {
        ...base,
        mtimeNs: 9_007_199_254_740_996n,
      }),
    ).toBe(false);
  });
  it("rejects a canonical asset symlink before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await rm(join(root, CONTEXT_SCHEMA));
    await symlink(join(root, HANDOFF_SCHEMA), join(root, CONTEXT_SCHEMA));

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall schema uses a symlinked path",
    );
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "is an unsupported symlink",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects a canonical parent symlink before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    const contracts = dirname(join(root, CONTEXT_SCHEMA));
    const realContracts = `${contracts}-real`;
    await rename(contracts, realContracts);
    await symlink(realContracts, contracts);

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall schema uses a symlinked path",
    );
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "is an unsupported symlink",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects a staged symlink to its canonical asset", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const stagedSchema = join(destination, HANDOFF_SCHEMA);
    await rm(stagedSchema);
    await symlink(join(root, HANDOFF_SCHEMA), stagedSchema);

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow("staged Fourth Wall schema uses a symlinked path");
  });

  it("rejects a canonical asset hardlink before destination mutation", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await link(
      join(root, CONTEXT_SCHEMA),
      join(root, `${CONTEXT_SCHEMA}.link`),
    );

    await expect(validateCanonicalAgentContracts(root)).rejects.toThrow(
      "canonical Fourth Wall schema uses a hardlinked file",
    );
    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "must be a contained non-symlink regular file",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects a staged asset hardlink without mutating the stage", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const marker = join(destination, "preserved.txt");
    await Bun.write(marker, "preserved\n");
    await link(
      join(destination, ACCEPTANCE_CORPUS),
      join(destination, `${ACCEPTANCE_CORPUS}.link`),
    );

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow(
      "staged Completion Contract corpus uses a hardlinked file",
    );
    expect(await readFile(marker, "utf8")).toBe("preserved\n");
  });

  it("rejects byte drift after safe staged reads", async () => {
    const root = await fixture();
    const destination = join(root, "stage");
    await stagePlugin(root, destination);
    const stagedCorpus = join(destination, TRUST_CORPUS);
    await writeFile(stagedCorpus, `${await readFile(stagedCorpus, "utf8")}\n`);

    await expect(
      validateStagedAgentContracts(root, destination),
    ).rejects.toThrow("diverges from its canonical owner");
  });

  it("redacts missing-file paths and operating-system errors", async () => {
    const root = await fixture();
    await rm(join(root, HANDOFF_SCHEMA));

    const message = await rejectionMessage(
      validateCanonicalAgentContracts(root),
    );
    expect(message).toBe(
      "canonical Fourth Wall schema is missing or inaccessible.",
    );
    expect(message).not.toContain(root);
    expect(message).not.toContain("ENOENT");
  });

  it("rejects an ancestor replacement race after identity-bound open", async () => {
    const root = await fixture();
    const contracts = dirname(join(root, CONTEXT_SCHEMA));
    const displaced = `${contracts}-displaced`;

    await expect(
      readContainedJsonAsset(root, CONTEXT_SCHEMA, "race asset", async () => {
        await rename(contracts, displaced);
        await mkdir(contracts, { recursive: true });
      }),
    ).rejects.toThrow("race asset ancestor identity changed during validation");
  });

  it("rejects transient link-write-unlink mutation of the opened inode", async () => {
    const root = await fixture();
    const target = join(root, CONTEXT_SCHEMA);
    const alias = `${target}.transient-link`;
    const message = await rejectionMessage(
      readContainedJsonAsset(
        root,
        CONTEXT_SCHEMA,
        "transient asset",
        async () => {
          await link(target, alias);
          await writeFile(alias, '{"changed":true}\n');
          await rm(alias);
        },
      ).then(() => undefined),
    );
    expect(message).toBe(
      "transient asset changed identity or uses a hardlinked file.",
    );
    expect(message).not.toContain(root);
  });

  it("rejects an in-place rewrite between bounded descriptor reads", async () => {
    const root = await fixture();
    const target = join(root, HANDOFF_SCHEMA);
    const message = await rejectionMessage(
      readContainedJsonAsset(
        root,
        HANDOFF_SCHEMA,
        "rewritten asset",
        undefined,
        async () => {
          await writeFile(target, '{"changed":true}\n');
        },
      ).then(() => undefined),
    );
    expect(message).toBe(
      "rewritten asset changed identity or uses a hardlinked file.",
    );
    expect(message).not.toContain(root);
  });

  it("rejects same-inode rewrite between target snapshot and open", async () => {
    const root = await fixture();
    const target = join(root, CONTEXT_SCHEMA);
    const message = await rejectionMessage(
      readContainedJsonAsset(
        root,
        CONTEXT_SCHEMA,
        "pre-open rewritten asset",
        undefined,
        undefined,
        async () => {
          await writeFile(target, '{"changed":true}\n');
        },
      ).then(() => undefined),
    );
    expect(message).toBe(
      "pre-open rewritten asset changed identity or uses a hardlinked file.",
    );
    expect(message).not.toContain(root);
  });

  it("rejects oversized contract assets before allocation", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ACCEPTANCE_CORPUS),
      Buffer.alloc(32 * 1024 * 1024, 0x20),
    );
    const message = await rejectionMessage(
      validateCanonicalAgentContracts(root),
    );
    expect(message).toBe(
      "canonical Completion Contract corpus exceeds the bounded contract asset size.",
    );
    expect(message).not.toContain(root);
  });

  it("rejects contract asset size growth after open", async () => {
    const root = await fixture();
    const target = join(root, HANDOFF_SCHEMA);
    const message = await rejectionMessage(
      readContainedJsonAsset(root, HANDOFF_SCHEMA, "grown asset", async () => {
        await appendFile(target, " ");
      }).then(() => undefined),
    );
    expect(message).toBe(
      "grown asset changed identity or uses a hardlinked file.",
    );
    expect(message).not.toContain(root);
  });
});
