# FastMCP Bun template

This template starts a repo-local stdio MCP server with Bun, TypeScript,
FastMCP, and Zod. It is for maintainers who need project-specific Codex tools
that can start from a fresh checkout or linked worktree.

Copy the directory into `.codex/mcp/<server-name>`. Replace the generic package
and server identity, register the server through `src/start.ts`, and keep stdout
reserved for MCP JSON-RPC.

## Commands

```sh
bun install
bun run typecheck
bun test
bun run check
bun run build
bun run validate:stdio
```

`start` installs dependencies before launching the stdio server. It keeps stdout
reserved for MCP JSON-RPC and writes install diagnostics to stderr. Commit the
copied project's generated `bun.lock`; this canonical template intentionally
does not include a nested lockfile.

`check` uses the copied template's `biome.jsonc` and a pinned Biome 2.5.4
command. It does not depend on a parent repository's configuration or VCS root.

## Package boundary

The package exposes `createServer` and `startServer` from its root export, and
the lifecycle API from `codex-fastmcp-template/lifecycle`. The
`codex-fastmcp-template` executable starts the stdio server from source. `build`
produces a separate deterministic Bun-targeted JavaScript artifact in `dist/`.

Do not add secrets, host paths, or parent-repository dependencies to the copied
package. Commit the copied package's generated `bun.lock`; the source template
omits a nested lockfile because the Skizzles workspace owns one root lockfile.

## Verification

Run the commands above in order. `bun run validate:stdio` must complete
unattended and verify `initialize`, `tools/list`, and the `health` tool. After
registration, start a fresh trusted Codex thread, call `health`, and confirm
that no dependency or diagnostic output contaminated stdout.
