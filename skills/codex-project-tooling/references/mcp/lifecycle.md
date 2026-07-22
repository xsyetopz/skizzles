# MCP-managed environment stacks

Tie a disposable local environment stack to the lifetime of a stdio MCP process. This reference is for maintainers whose MCP server starts, inspects, restarts, or removes local Compose services or similar infrastructure.

Use this pattern only when the stack is disposable, local, and owned by one MCP process. Define deterministic resource names, cleanup labels, startup failure behavior, and short shutdown timeouts before implementation.

## Lifecycle

For disposable local stacks, the MCP process can own stack lifetime:

1. MCP starts.
2. Server initialization starts or attaches to a named stack.
3. Tools operate against that stack.
4. MCP process receives shutdown or is dropped.
5. Cleanup runs idempotently.

This works best for local stdio MCPs because Codex launches and terminates the process group.

## Naming

Use deterministic names so cleanup can find the resources:

- include repo slug
- include MCP server slug
- include a session or thread slug when available
- add labels for cleanup, such as `managed-by=codex-mcp`

For Docker Compose, prefer a project name:

```sh
COMPOSE_PROJECT_NAME="codex-${REPO_SLUG}-${SERVER_SLUG}-${SESSION_SLUG}"
docker compose up -d
```

Do not assume `CODEX_THREAD_ID` is present inside every MCP process unless the config explicitly passes it through with `env_vars`.

## Cleanup rules

- Cleanup must be idempotent.
- Cleanup should tolerate partially started stacks.
- Cleanup should use labels or deterministic names, not broad destructive commands.
- Cleanup should run on `SIGINT`, `SIGTERM`, `beforeExit`, and explicit lifecycle shutdown paths where possible.
- Write cleanup logs to stderr.
- Do not block forever during shutdown; use short timeouts.

## Tool surface

Useful stack tools:

- `health`: compact MCP process and stack health.
- `stack_status`: read-only stack inventory.
- `stack_logs`: bounded recent logs, with line limits.
- `restart_stack`: mutating; usually prompt for approval.
- `cleanup_stack`: mutating; usually prompt for approval.

Keep build/test commands out of lifecycle startup unless the stack is unusable without them. Long-running validation belongs in explicit tools or normal shell commands.

## Boundaries

Avoid MCP-owned stacks when:

- the resource must outlive Codex sessions
- multiple top-level agents must share one long-lived stack
- production credentials or production infrastructure are involved
- cleanup failure would destroy valuable data

In those cases, use ordinary project scripts plus conservative MCP inspection tools.

## Verification

1. Start the MCP and confirm it creates or attaches only to the expected named resources.
2. Interrupt startup at a partial state and run cleanup twice; both cleanup attempts must be safe.
3. Exercise `SIGINT`, `SIGTERM`, `beforeExit`, and the explicit shutdown path where the runtime supports them.
4. Confirm cleanup selects resources by deterministic names or labels and never by a broad destructive command.
5. Verify startup, tool, and cleanup diagnostics stay on stderr so stdout remains valid MCP JSON-RPC.
6. Terminate the Codex MCP client and confirm the disposable stack is removed within the configured timeout.
