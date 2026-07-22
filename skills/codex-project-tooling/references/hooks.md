# Codex hooks

Codex hooks run configured commands at tool, prompt, session, compaction, and subagent lifecycle events. This reference is for maintainers adding lightweight policy checks, context injection, or lifecycle automation at repository, user, or plugin scope.

Before authoring a hook, identify the event and matcher, decide whether the hook may block the operation, and define a short timeout. The handler must accept JSON on stdin, reserve stdout for the documented response, remain non-interactive, and be safe to run more than once.

## Workflow

1. Choose the narrowest event and matcher that cover the policy.
2. Define whether the hook injects context, blocks before an operation, responds to an approval request, or rejects a result.
3. Implement a bounded command handler in a stable path such as `.codex/hooks/`.
4. Parse the hook configuration and test the handler with representative stdin.
5. Trigger a safe matching event in a fresh trusted thread.

## Configuration locations

Inline TOML in `.codex/config.toml`:

```toml
[features]
hooks = true

[hooks]

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "python3 .codex/hooks/check-shell.py"
timeout = 5
statusMessage = "checking shell command"
```

JSON in `.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .codex/hooks/check-shell.py",
            "timeout": 5,
            "statusMessage": "checking shell command"
          }
        ]
      }
    ]
  }
}
```

Prefer inline TOML for small project-local hook declarations. Use `hooks.json` when the project already keeps hook config separate or when generated/plugin-style hook config is easier to manage as JSON.

## Event names

Supported hook events:

- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `SessionStart`
- `UserPromptSubmit`
- `SubagentStart`
- `SubagentStop`
- `Stop`

Event tables contain matcher groups. A matcher group has optional `matcher` and a `hooks` array.

## Command handler fields

Command hooks use:

```toml
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "bun .codex/hooks/prompt-context.ts"
commandWindows = "node .codex/hooks/prompt-context.js"
timeout = 10
async = false
statusMessage = "loading project context"
```

Fields:

- `type`: Use `"command"` for executable hooks.
- `command`: Shell command for Unix/macOS.
- `commandWindows`: Optional Windows-specific command.
- `timeout`: Optional timeout in seconds.
- `async`: Optional boolean; use only when the hook should not block the user flow.
- `statusMessage`: Optional UI status text while the hook runs.

`prompt` and `agent` handler types exist in the config shape but are not the normal project-authoring path. Prefer `command` unless the repository already uses another handler type successfully.

## Matchers

Matchers select which occurrences of an event run a hook.

- Omitted matcher, `""`, or `"*"` matches all occurrences.
- Simple ASCII names use exact matching, such as `"Bash"` or `"Edit|Write"`.
- Pipe alternatives match exact candidates.
- Regex is used when the matcher contains regex syntax.
- `UserPromptSubmit` and `Stop` ignore matcher input.
- Tool-related events match tool names and aliases.
- `SubagentStart` and `SubagentStop` match agent type.
- Compact events match compact trigger.

## Input and output

Hooks receive JSON on stdin. Common input fields include:

- `session_id`
- `turn_id` when available
- `transcript_path`
- `cwd`
- `hook_event_name`
- `model`
- `permission_mode`
- `agent_id` and `agent_type` for subagent-aware events

Tool hooks also receive `tool_name`, `tool_input`, and, for post-use hooks, tool output fields. Prompt hooks receive `prompt`. Stop hooks receive the last assistant message when available.

Plain non-empty stdout is usually rendered as hook output or additional model context depending on the event. JSON stdout can express structured decisions.

## Output contracts

Inject context for `SessionStart`, `SubagentStart`, or `UserPromptSubmit`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Project-specific context for the next model turn."
  }
}
```

Block a tool before it runs:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use the project wrapper instead of this raw command."
  }
}
```

Allow or deny an approval request:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Do not push branches from agent sessions."
    }
  }
}
```

Block or reject a result after a tool runs:

```json
{
  "decision": "block",
  "reason": "The generated file contains a local absolute path."
}
```

Stop processing for prompt/session/compact/stop-style hooks:

```json
{
  "continue": false,
  "stopReason": "Required project context is missing."
}
```

## Boundaries

- Use hooks to enforce narrow, observable policy. A hook is not a second agent.
- Avoid network calls unless the hook is explicitly about network-backed validation.
- Avoid long builds in hooks. Use hooks to remind, route, or block; run heavyweight validation as an explicit task.
- Include clear failure messages. A blocked operation should tell the agent what to do instead.
- Keep scripts in a stable repo path such as `.codex/hooks/`.
- Keep raw secrets out of hook output and recorded evidence.

Hook and MCP composition may produce or consume the versioned Fourth Wall [context envelope](../../fourth-wall/contracts/context-envelope.schema.json) and [handoff/review](../../fourth-wall/contracts/handoff-review.schema.json), but the published schemas define only the portable document shape. Repository packaging pins those schema bytes and executes incident fixtures through a strict evaluator. That evaluator still depends on trusted caller-supplied clock, version, digest, and effect facts. Neither layer intercepts native Codex handoffs or enforces host lifecycle. Use references and SHA-256 digests in evidence instead of raw secrets.

## Verification

1. Parse the edited TOML or JSON.
2. Confirm each command and referenced script resolves from its configured scope.
3. Send representative JSON to the handler directly and check its exit status, stdout, and stderr.
4. Use app or CLI hook-listing commands when available.
5. Trigger one safe matching event and one non-matching event in a fresh trusted thread.
