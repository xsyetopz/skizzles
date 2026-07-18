// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
import { parseLabManifest } from "../src/lab-manifest.ts";

describe("parseLabManifest", () => {
  test("preserves schema diagnostic ordering across manifest domains", () => {
    expect(() =>
      parseLabManifest(
        `
unexpected: true
compose:
  files: []
  command_service: "bad service"
  extra: true
image: { name: "", service: "bad service" }
runtime: { workspace: relative, shell: [] }
ports:
  one: { service: dev, target: 3000 }
  two: { service: dev, target: 3000 }
environment: [TOKEN, TOKEN]
secret_environment: [TOKEN, TOKEN]
`,
        "/tmp/project/custom-lab.yaml",
      ),
    ).toThrow(
      "invalid .codex-container-lab.yaml: unexpected: unknown key; compose.extra: unknown key; compose.files: must contain at least 1 item; compose.command_service: must be a Compose service name; image.name: must be a non-empty string; image.service: must be a Compose service name; exactly one of compose, dockerfile, or image must be configured; runtime.shell: must contain at least 1 item; runtime.workspace: must be a normalized absolute container path other than /; runtime.shell: first argv item must be a normalized absolute executable path; environment: environment forwarding names must be unique; secret_environment: secret environment names must be unique; secret_environment: must not overlap environment: TOKEN, TOKEN; ports: service and target pairs must be unique",
    );
  });

  test("attributes YAML syntax errors to the caller-provided source path", () => {
    expect(() =>
      parseLabManifest("image: [", "/tmp/project/custom-lab.yaml"),
    ).toThrow("invalid YAML in /tmp/project/custom-lab.yaml:");
  });
});
