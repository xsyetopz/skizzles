# FastMCP Bun template

Portable starting point for a repo-local MCP server using Bun, TypeScript,
FastMCP, and Zod. Copy it into `.codex/mcp/<server-name>`, then replace the
generic package and server identity before committing it.

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

## Package boundary

The package exposes `createServer` and `startServer` from its root export, and
the lifecycle API from `codex-fastmcp-template/lifecycle`. The
`codex-fastmcp-template` executable starts the stdio server from source. `build`
produces a separate deterministic Bun-targeted JavaScript artifact in `dist/`.
