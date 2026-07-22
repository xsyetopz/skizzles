import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLabConfig,
  parseLabConfig,
  resolveRepoPath,
} from "../src/config.ts";

const root = "/tmp/example-repository";
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  );
});

describe("parseLabConfig", () => {
  it("normalizes compose mode while preserving file order and applying defaults", () => {
    const config = parseLabConfig(
      `
compose:
  files: [compose.yaml, compose.dev.yaml]
  command_service: api
ports:
  http:
    service: api
    target: 3000
    scheme: http
  dns:
    service: api
    target: 5353
environment: [TERM, DEBUG]
compose_environment: [PROJECT_NAME]
secret_environment: [REGISTRY_TOKEN]
`,
      root,
    );

    expect(config.mode).toEqual({
      kind: "compose",
      files: [`${root}/compose.yaml`, `${root}/compose.dev.yaml`],
      commandService: "api",
    });
    expect(config.runtime).toEqual({
      workspace: "/workspace",
      shell: ["/bin/sh", "-lc"],
    });
    expect(config.ports).toEqual([
      { name: "http", service: "api", target: 3000, scheme: "http" },
      { name: "dns", service: "api", target: 5353 },
    ]);
    expect(config.forwardEnvironment).toEqual(["TERM", "DEBUG"]);
    expect(config.composeEnvironment).toEqual(["PROJECT_NAME"]);
    expect(config.secretEnvironment).toEqual(["REGISTRY_TOKEN"]);
  });

  it("normalizes dockerfile and image shorthand modes", () => {
    const dockerfile = parseLabConfig(
      `
dockerfile:
  path: containers/dev.Dockerfile
  context: .
  service: dev
runtime:
  workspace: /src
  shell: [/bin/bash, -lc]
`,
      root,
    );
    expect(dockerfile.mode).toEqual({
      kind: "dockerfile",
      dockerfile: `${root}/containers/dev.Dockerfile`,
      context: root,
      commandService: "dev",
    });

    const image = parseLabConfig(
      "image: { name: node:24, service: dev }",
      root,
    );
    expect(image.mode).toEqual({
      kind: "image",
      image: "node:24",
      commandService: "dev",
    });
  });

  it("trims service names in record keys like other service fields", () => {
    const config = parseLabConfig(
      `
image: { name: node:24, service: dev }
ports:
  " web ": { service: dev, target: 3000 }
`,
      root,
    );
    expect(config.ports).toEqual([
      {
        name: "web",
        service: "dev",
        target: 3000,
      },
    ]);
  });

  it("requires exactly one mode", () => {
    expect(() => parseLabConfig("runtime: {}", root)).toThrow("exactly one");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
compose: { files: [compose.yaml], command_service: dev }
`,
        root,
      ),
    ).toThrow("exactly one");
  });

  it("rejects unknown keys at every manifest level", () => {
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev, tag: latest }
`,
        root,
      ),
    ).toThrow("image.tag: unknown key");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
runtime: { shell: [/bin/sh, -lc], timeout: 10 }
`,
        root,
      ),
    ).toThrow("runtime.timeout: unknown key");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
unexpected: true
`,
        root,
      ),
    ).toThrow("unexpected: unknown key");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
secret_environments: [TOKEN]
`,
        root,
      ),
    ).toThrow("secret_environments: unknown key");
  });

  it("rejects repository traversal and absolute project paths", () => {
    expect(() =>
      parseLabConfig(
        `
compose: { files: [../compose.yaml], command_service: dev }
`,
        root,
      ),
    ).toThrow("escapes repository");
    expect(() => resolveRepoPath(root, "/etc/passwd")).toThrow(
      "must be relative",
    );
  });

  it("validates runtime paths and environment forwarding names", () => {
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
runtime: { workspace: workspace/, shell: [sh, -lc] }
`,
        root,
      ),
    ).toThrow("normalized absolute");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
environment: [TERM, TERM]
`,
        root,
      ),
    ).toThrow("must be unique");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
environment: [BAD-NAME]
`,
        root,
      ),
    ).toThrow("environment variable name");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
secret_environment: [TOKEN, TOKEN]
`,
        root,
      ),
    ).toThrow("secret environment names must be unique");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
compose_environment: [PROJECT, PROJECT]
`,
        root,
      ),
    ).toThrow("Compose environment names must be unique");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
secret_environment: [BAD-NAME]
`,
        root,
      ),
    ).toThrow("environment variable name");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
environment: [TOKEN]
secret_environment: [TOKEN]
`,
        root,
      ),
    ).toThrow("must not overlap environment: TOKEN");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
compose_environment: [TOKEN]
secret_environment: [TOKEN]
`,
        root,
      ),
    ).toThrow("must not overlap compose_environment: TOKEN");
    for (const field of [
      "environment",
      "compose_environment",
      "secret_environment",
    ]) {
      expect(() =>
        parseLabConfig(
          `image: { name: node:24, service: dev }\n${field}: [COMPOSE_PROJECT_NAME]\n`,
          root,
        ),
      ).toThrow("must not use the reserved COMPOSE_ prefix");
    }
    expect(() =>
      parseLabConfig(
        "image: { name: node:24, service: dev }\nsecret_environment: [HOME]\n",
        root,
      ),
    ).toThrow("must not overlap fixed Docker client environment: HOME");
    expect(() =>
      parseLabConfig(
        `image: { name: node:24, service: dev }
compose_environment: [${Array.from(
          { length: 65 },
          (_, index) => `VALUE_${index}`,
        ).join(", ")}]
`,
        root,
      ),
    ).toThrow("compose_environment: must contain at most 64 items");
    expect(() =>
      parseLabConfig(
        `
image: { name: node:24, service: dev }
ports:
  one: { service: dev, target: 3000 }
  two: { service: dev, target: 3000 }
`,
        root,
      ),
    ).toThrow("service and target pairs must be unique");
  });

  it("validates malformed service, path, shell, and port values", () => {
    expect(() =>
      parseLabConfig('image: { name: node:24, service: "bad service" }', root),
    ).toThrow("image.service: must be a Compose service name");
    expect(() =>
      parseLabConfig("compose: { files: [], command_service: app }", root),
    ).toThrow("compose.files: must contain at least 1 item");
    expect(() =>
      parseLabConfig(
        "image: { name: node:24, service: dev }\nports: { web: { service: dev, target: 70000 } }",
        root,
      ),
    ).toThrow("ports.web.target: must be an integer between 1 and 65535");
    expect(() =>
      parseLabConfig(
        "image: { name: node:24, service: dev }\nruntime: { shell: [] }",
        root,
      ),
    ).toThrow("runtime.shell: must contain at least 1 item");
  });

  it("rejects project paths that escape through symlinks", async () => {
    const repository = await mkdtemp(join(tmpdir(), "container-lab-config-"));
    const outside = await mkdtemp(join(tmpdir(), "container-lab-outside-"));
    temporaryRoots.push(repository, outside);
    await Bun.write(join(outside, "compose.yaml"), "services: {}\n");
    await symlink(
      join(outside, "compose.yaml"),
      join(repository, "compose.yaml"),
    );
    await Bun.write(
      join(repository, ".codex-container-lab.yaml"),
      "compose: { files: [compose.yaml], command_service: app }\n",
    );
    await expect(loadLabConfig(repository)).rejects.toThrow(
      "resolves outside repository",
    );
  });

  it("rejects a manifest symlink resolving outside the repository", async () => {
    const repository = await mkdtemp(join(tmpdir(), "container-lab-manifest-"));
    const outside = await mkdtemp(
      join(tmpdir(), "container-lab-manifest-outside-"),
    );
    temporaryRoots.push(repository, outside);
    const externalManifest = join(outside, ".codex-container-lab.yaml");
    await Bun.write(
      externalManifest,
      "image: { name: node:24, service: dev }\n",
    );
    await symlink(
      externalManifest,
      join(repository, ".codex-container-lab.yaml"),
    );
    await expect(loadLabConfig(repository)).rejects.toThrow(
      "resolves outside repository",
    );
  });

  it("rejects an implicit project .env interpolation source", async () => {
    const repository = await mkdtemp(join(tmpdir(), "container-lab-dotenv-"));
    temporaryRoots.push(repository);
    await Bun.write(
      join(repository, ".codex-container-lab.yaml"),
      "compose: { files: [compose.yaml], command_service: app }\n",
    );
    await Bun.write(
      join(repository, "compose.yaml"),
      "services: { app: { image: node:24 } }\n",
    );

    await Bun.write(join(repository, ".env"), "PROJECT_VALUE=ambient\n");

    await expect(loadLabConfig(repository)).rejects.toThrow(
      "project .env is not supported",
    );
  });
});
