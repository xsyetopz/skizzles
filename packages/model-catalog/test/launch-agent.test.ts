import { describe, expect, it } from "bun:test";
import { renderLaunchAgent } from "../src/index.ts";

const UNRESOLVED_PLACEHOLDER = /__[A-Z0-9_]+__/u;

describe("model catalog launch agent", () => {
  it("renders absolute escaped paths", () => {
    const template =
      "<array><string>__BUN_ABSOLUTE_PATH__</string><string>__SCRIPT_ABSOLUTE_PATH__</string><string>__CODEX_HOME_ABSOLUTE_PATH__</string><string>__CODEX_BINARY_ABSOLUTE_PATH__</string><string>__MODELS_CACHE_ABSOLUTE_PATH__</string></array>";
    const rendered = renderLaunchAgent(template, {
      bun: "/opt/bun&friends/bun",
      script: "/opt/skizzles/model-catalog.ts",
      codexHome: "/tmp/codex-home",
      codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
    });
    expect(rendered).toContain("/opt/bun&amp;friends/bun");
    expect(rendered).toContain("/tmp/codex-home/models_cache.json");
    expect(rendered).not.toMatch(UNRESOLVED_PLACEHOLDER);
    expect(() =>
      renderLaunchAgent(template, {
        bun: "relative/bun",
        script: "/opt/skizzles/model-catalog.ts",
        codexHome: "/tmp/codex-home",
        codexBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
      }),
    ).toThrow("must be absolute");
  });
});
