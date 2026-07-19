import { chmod, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cleanupStale, create } from "@skizzles/run-workspace";
import {
  adaptPluginWorkspace,
  type PluginWorkspace,
} from "../../src/plugin/workspace.ts";

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
  temporaryRoot: (purpose: string) => Promise<string>;
  workspace: () => Promise<PluginWorkspace>;
} {
  let active: PluginWorkspace | undefined;
  let sequence = 0;
  const workspace = async (): Promise<PluginWorkspace> => {
    if (active !== undefined) return active;
    const stale = await cleanupStale();
    if (stale.failed.length > 0 || stale.truncated) {
      throw new Error("Test run workspace stale cleanup did not complete.");
    }
    active = adaptPluginWorkspace(await create());
    return active;
  };
  const temporaryRoot = async (purpose: string): Promise<string> => {
    const owned = await workspace();
    const path = owned.path(`${purpose}-${sequence}`);
    sequence += 1;
    await mkdir(path, { mode: 0o700 });
    return path;
  };
  return {
    workspace,
    temporaryRoot,
    fixture: () => fixture(temporaryRoot),
    cleanup: async () => {
      if (active === undefined) return;
      const owned = active;
      active = undefined;
      sequence = 0;
      const report = await owned.close();
      if (report.state === "cleanup-failed") {
        throw new Error(
          `Test run workspace cleanup failed: ${report.error ?? "unknown failure"}.`,
        );
      }
    },
  };
}

async function fixture(
  temporaryRoot: (purpose: string) => Promise<string>,
): Promise<string> {
  const root = await temporaryRoot("fixture");
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
  const installerModules = new Map<string, string>([
    ["cli-arguments.ts", 'export const fixture = "cli-arguments";\n'],
    [
      "codex-config.ts",
      'import "./codex-config/preview.ts";\nimport "./codex-config/private-files.ts";\nimport "./codex-config/rpc-contract.ts";\nimport "./codex-config/rpc.ts";\nimport "./codex-config/values.ts";\nexport const fixture = "codex-config";\n',
    ],
    [
      "codex-config/preview.ts",
      'import "../managed-files.ts";\nimport "./rpc.ts";\nimport "./rpc-contract.ts";\nimport "./values.ts";\nexport const fixture = "preview";\n',
    ],
    [
      "codex-config/private-files.ts",
      'import "../managed-files.ts";\nexport const fixture = "private-files";\n',
    ],
    [
      "codex-config/rpc-contract.ts",
      'export const fixture = "rpc-contract";\n',
    ],
    [
      "codex-config/rpc.ts",
      'import "./rpc-contract.ts";\nexport const fixture = "rpc";\n',
    ],
    ["codex-config/values.ts", 'export const fixture = "values";\n'],
    [
      "config.ts",
      'import "./codex-config.ts";\nimport "./managed-files.ts";\nexport const fixture = "config";\n',
    ],
    [
      "doctor.ts",
      'import "./harness.ts";\nimport "./skills.ts";\nexport const fixture = "doctor";\n',
    ],
    [
      "harness.ts",
      'import "./managed-files.ts";\nimport "./skills.ts";\nexport const fixture = "harness";\n',
    ],
    ["managed-files.ts", 'export const fixture = "managed-files";\n'],
    [
      "prompt-policy.ts",
      'import "./codex-config.ts";\nimport "./managed-files.ts";\nimport "./prompt-policy/lock.ts";\nimport "./prompt-policy/managed-state.ts";\nimport "./prompt-policy/source.ts";\nexport const fixture = "prompt-policy";\n',
    ],
    ["prompt-policy/lock.ts", 'export const fixture = "prompt-policy-lock";\n'],
    [
      "prompt-policy/managed-state.ts",
      'import "../codex-config.ts";\nimport "../managed-files.ts";\nimport "./source.ts";\nexport const fixture = "managed-state";\n',
    ],
    [
      "prompt-policy/source.ts",
      'import "../codex-config.ts";\nimport "../managed-files.ts";\nexport const fixture = "prompt-policy-source";\n',
    ],
    [
      "skills.ts",
      'import "./managed-files.ts";\nexport const fixture = "skills";\n',
    ],
  ]);
  for (const [path, source] of installerModules) {
    await write(root, `packages/installer/src/${path}`, source);
  }
  await write(
    root,
    "packages/installer/src/cli.ts",
    'import "./cli-arguments.ts";\nimport "./config.ts";\nimport "./doctor.ts";\nimport "./harness.ts";\nimport "./prompt-policy.ts";\nimport "./skills.ts";\nif (import.meta.main) {\n  console.error("usage: skizzles-installer <command>");\n  process.exit(2);\n}\n',
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
    'import "./catalog/refresh.ts";\nimport { marker } from "./catalog/schema.ts";\nimport "./cli.ts";\nimport "./launch-agent.ts";\nconsole.log(marker);\n',
  );
  await write(
    root,
    "packages/model-catalog/src/catalog/schema.ts",
    'export const marker = "fixture model catalog";\n',
  );
  await write(
    root,
    "packages/model-catalog/src/catalog/refresh.ts",
    'import "../codex-child.ts";\nimport "./schema.ts";\nimport "./store.ts";\nexport const fixture = "refresh";\n',
  );
  await write(
    root,
    "packages/model-catalog/src/catalog/store.ts",
    'import "./schema.ts";\nexport const fixture = "store";\n',
  );
  await write(
    root,
    "packages/model-catalog/src/cli.ts",
    'import "./catalog/refresh.ts";\nimport "./catalog/store.ts";\nimport "./codex-child.ts";\nimport "./launch-agent.ts";\nexport const fixture = "cli";\n',
  );
  await write(
    root,
    "packages/model-catalog/src/codex-child.ts",
    'import "./catalog/schema.ts";\nexport const fixture = "codex-child";\n',
  );
  await write(
    root,
    "packages/model-catalog/src/launch-agent.ts",
    'export const fixture = "launch-agent";\n',
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
  const canonicalRoot = resolve(import.meta.dir, "../../../..");
  for (const path of [
    "skills/fourth-wall/contracts/context-envelope.schema.json",
    "skills/fourth-wall/contracts/handoff-review.schema.json",
    "skills/fourth-wall/fixtures/trust-boundary-incidents.json",
    "skills/completion-contract/contracts/acceptance.schema.json",
    "skills/completion-contract/fixtures/acceptance-incidents.json",
    "packages/prompt-layer/assets/integrations/prompt-policy.json",
    "packages/prompt-layer/assets/evaluations/shipped-language-policy.v2.json",
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
