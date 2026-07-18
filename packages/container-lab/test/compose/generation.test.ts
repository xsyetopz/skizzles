// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not follow yaml's package exports; yaml is a declared runtime dependency.
import { parse as parseYaml } from "yaml";
import type { ComposeModel } from "../../src/compose/contract.ts";
import {
  composeCommandArgs,
  generateBaseCompose,
  generateOverrideCompose,
} from "../../src/compose/generation.ts";
import { parseLabConfig } from "../../src/config.ts";

const repoRoot = "/tmp/example-repository";

describe("Compose generation", () => {
  test("builds one internal service for image and dockerfile shorthand", () => {
    const imageConfig = parseLabConfig(
      `
image: { name: node:24, service: dev }
runtime: { workspace: /src, shell: [/bin/bash, -lc] }
`,
      repoRoot,
    );
    const imageBase = generateBaseCompose(imageConfig);
    expect(imageBase).toBeDefined();
    expect(parseYaml(imageBase ?? "")).toEqual({
      services: {
        dev: {
          working_dir: "/src",
          command: ["/bin/bash", "-lc", "while :; do sleep 2147483647; done"],
          image: "node:24",
        },
      },
    });

    const dockerfileConfig = parseLabConfig(
      `
dockerfile: { path: Dockerfile.dev, context: ., service: dev }
`,
      repoRoot,
    );
    const dockerfileBase = generateBaseCompose(dockerfileConfig);
    expect(dockerfileBase).toBeDefined();
    const base = parseYaml(dockerfileBase ?? "");
    expect(base.services.dev.build).toEqual({
      context: repoRoot,
      dockerfile: `${repoRoot}/Dockerfile.dev`,
    });
    const override = parseYaml(
      generateOverrideCompose(
        dockerfileConfig,
        { services: { dev: {} } },
        {
          workspaceHostPath: "/tmp/workspace",
          owner: "thread",
          ownerKey: "a".repeat(64),
          labId: "lab",
        },
      ),
    );
    expect(override.services.dev.image).toBe(
      `codex-container-lab:${"a".repeat(24)}-lab`,
    );
    expect(override.services.dev.build.labels).toEqual({
      "io.openai.codex-container-lab.managed": "true",
      "io.openai.codex-container-lab.owner": "thread",
      "io.openai.codex-container-lab.lab": "lab",
    });
  });

  test("generates managed overrides across normalized resources", () => {
    const config = parseLabConfig(
      `
compose: { files: [compose.yaml], command_service: api }
runtime: { workspace: /src, shell: [/bin/sh, -lc] }
ports:
  web: { service: api, target: 8080, scheme: http }
  metrics: { service: database, target: 9187 }
environment: [TERM]
`,
      repoRoot,
    );
    const model: ComposeModel = {
      services: { api: {}, database: {} },
      volumes: { data: {}, host_data: { external: true } },
      networks: {
        backend: {},
        shared: { external: { name: "shared-network" } },
      },
    };
    const override = parseYaml(
      generateOverrideCompose(config, model, {
        workspaceHostPath: "/tmp/lab/workspace",
        owner: "thread-1",
        ownerKey: "a".repeat(64),
        labId: "lab-2",
      }),
    );

    const labels = {
      "io.openai.codex-container-lab.managed": "true",
      "io.openai.codex-container-lab.owner": "thread-1",
      "io.openai.codex-container-lab.lab": "lab-2",
    };
    expect(override.services.database).toEqual({
      labels,
      ports: ["127.0.0.1::9187"],
    });
    expect(override.services.api).toEqual({
      labels,
      init: true,
      working_dir: "/src",
      volumes: [{ type: "bind", source: "/tmp/lab/workspace", target: "/src" }],
      ports: ["127.0.0.1::8080"],
      environment: ["TERM"],
    });
    expect(override.volumes.data).toEqual({ labels });
    expect(override.networks.backend).toEqual({ labels });
    expect(override.volumes.host_data).toBeUndefined();
    expect(override.networks.shared).toBeUndefined();
  });

  test("requires the configured command service", () => {
    const config = parseLabConfig(
      "image: { name: node:24, service: dev }",
      repoRoot,
    );
    expect(() =>
      generateOverrideCompose(
        config,
        { services: { other: {} } },
        {
          workspaceHostPath: "/tmp/workspace",
          owner: "thread",
          ownerKey: "a".repeat(64),
          labId: "l",
        },
      ),
    ).toThrow("command service is absent from normalized Compose model: dev");
  });

  test("requires each declared port service in the normalized model", () => {
    const config = parseLabConfig(
      `
image: { name: node:24, service: dev }
ports:
  web: { service: missing, target: 8080 }
`,
      repoRoot,
    );
    expect(() =>
      generateOverrideCompose(
        config,
        { services: { dev: {} } },
        {
          workspaceHostPath: "/tmp/workspace",
          owner: "thread",
          ownerKey: "a".repeat(64),
          labId: "l",
        },
      ),
    ).toThrow("declared port web references absent service: missing");
  });

  test("rejects a declared target already published by project Compose", () => {
    const config = parseLabConfig(
      `
image: { name: node:24, service: dev }
ports:
  web: { service: dev, target: 8080 }
`,
      repoRoot,
    );
    expect(() =>
      generateOverrideCompose(
        config,
        {
          services: { dev: { ports: [{ target: 8080, published: "8080" }] } },
        },
        {
          workspaceHostPath: "/tmp/workspace",
          owner: "thread",
          ownerKey: "a".repeat(64),
          labId: "l",
        },
      ),
    ).toThrow("declared port web overlaps a project publication for dev:8080");
  });

  test("preserves project directory and source Compose file order", () => {
    const config = parseLabConfig(
      `
compose:
  files: [compose.yaml, compose.local.yaml]
  command_service: api
`,
      repoRoot,
    );
    expect(
      composeCommandArgs(config, {
        projectName: "ccl-session-lab",
        overrideFile: "/tmp/lab/override.yaml",
      }),
    ).toEqual([
      "compose",
      "--project-directory",
      repoRoot,
      "--project-name",
      "ccl-session-lab",
      "-f",
      `${repoRoot}/compose.yaml`,
      "-f",
      `${repoRoot}/compose.local.yaml`,
      "-f",
      "/tmp/lab/override.yaml",
    ]);
  });
});
