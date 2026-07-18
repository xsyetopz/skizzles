import { isAbsolute, join, resolve } from "node:path";

const UNRESOLVED_PLACEHOLDER = /__[A-Z0-9_]+__/;

export interface LaunchAgentValues {
  bun: string;
  script: string;
  codexHome: string;
  codexBinary: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent(
  template: string,
  values: LaunchAgentValues,
): string {
  const replacements: Record<string, string> = {
    __BUN_ABSOLUTE_PATH__: values.bun,
    __SCRIPT_ABSOLUTE_PATH__: values.script,
    __CODEX_HOME_ABSOLUTE_PATH__: values.codexHome,
    __CODEX_BINARY_ABSOLUTE_PATH__: values.codexBinary,
    __MODELS_CACHE_ABSOLUTE_PATH__: join(values.codexHome, "models_cache.json"),
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!isAbsolute(value)) {
      throw new Error(`${placeholder} must be absolute`);
    }
    rendered = rendered.replaceAll(placeholder, xml(resolve(value)));
  }
  if (UNRESOLVED_PLACEHOLDER.test(rendered)) {
    throw new Error("launch agent template contains unresolved placeholders");
  }
  return rendered;
}
