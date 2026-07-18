#!/usr/bin/env bun

/**
 * Read-only local usage analysis for Codex rollout files.
 *
 * This intentionally reads only CODEX_HOME sessions, archived_sessions, and
 * the newest optional state_*.sqlite title index. It does not write to them.
 */
import { run } from "./usage-analyzer/app.ts";

run(Bun.argv.slice(2), process.env).catch((error: unknown) => {
  console.error(
    `analyze.ts: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
