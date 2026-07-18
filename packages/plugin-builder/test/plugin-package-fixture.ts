import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PLUGIN_ROOT_TOKEN = ["$", "{", "PLUGIN_ROOT", "}"].join("");
export const EXTERNAL_ZOD_IMPORT = /(?:from\s+|require\()["']zod["']/;
export const YAML_LAB_ID = /^yaml-/;
export const CLI_SMOKE_TIMEOUT_MS = 3_000;
export const CLI_SMOKE_OUTPUT_LIMIT_BYTES = 16_384;
export const MODEL_CATALOG_USAGE =
  "usage: skizzles-model-catalog <refresh|service|render-launch-agent> [options]";

export function createTestWorkspace(): {
  cleanup: () => Promise<void>;
  fixture: () => Promise<string>;
  temporaryRoots: string[];
} {
  const temporaryRoots: string[] = [];
  return {
    temporaryRoots,
    fixture: () => fixture(temporaryRoots),
    cleanup: async () => {
      await Promise.all(
        temporaryRoots
          .splice(0)
          .map((path) => rm(path, { force: true, recursive: true })),
      );
    },
  };
}

async function fixture(temporaryRoots: string[]): Promise<string> {
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
    "---\nname: example\ndescription: Fixture skill.\n---\n\n# Example\n",
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
          command: `bun "${PLUGIN_ROOT_TOKEN}/hooks/manage-command-output.ts" --plugin-root "${PLUGIN_ROOT_TOKEN}"`,
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
  for (const name of [
    "codex-container-lab",
    "completion-contract",
    "fourth-wall",
  ]) {
    await write(
      root,
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Fixture ${name} skill.\n---\n\n# ${name}\n`,
    );
  }
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
    "skills/fourth-wall/contracts/context-envelope.schema.json",
    "skills/fourth-wall/contracts/handoff-review.schema.json",
    "skills/fourth-wall/fixtures/trust-boundary-incidents.json",
    "skills/completion-contract/contracts/acceptance.schema.json",
    "skills/completion-contract/fixtures/acceptance-incidents.json",
    "packages/prompt-layer/assets/integrations/prompt-policy.json",
    "packages/prompt-layer/assets/evaluations/shipped-language-policy.v1.json",
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

export async function write(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

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

export async function filesUnder(root: string): Promise<string[]> {
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

export function requiredTestRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isTestRecord(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredTestArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value;
}

export function requiredTestString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

export function textOutput(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}
