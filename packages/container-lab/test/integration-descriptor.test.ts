// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { expect, it } from "bun:test";
import descriptor from "../assets/integrations/container-lab.json" with {
  type: "json",
};
import manifest from "../package.json" with { type: "json" };

it("exports the stable installer integration descriptor", () => {
  expect(manifest.exports["./integration-descriptor"]).toBe(
    "./assets/integrations/container-lab.json",
  );
  expect(descriptor).toMatchObject({
    id: "codex-container-lab",
    integrationContract: 1,
    locations: {
      canonicalWorkspace:
        "packages/container-lab/assets/integrations/container-lab.json",
      packagedPlugin: "integrations/container-lab.json",
    },
    ownership: {
      runtimeOwner: "skizzles",
      canonicalSource: "packages/container-lab",
    },
    binaries: {
      operational: "codex-container-lab",
      reaper: "codex-container-lab-reaper",
    },
    execution: {
      adminProtocol: "single-json-v1",
      adminMaxBytes: 16_384,
    },
  });
  expect(descriptor.configuredRuntime).toBe("0.1.0");
  expect(descriptor.bundled.documentation).not.toHaveLength(0);
});
