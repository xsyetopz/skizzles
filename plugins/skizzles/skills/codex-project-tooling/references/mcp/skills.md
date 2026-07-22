# Companion skills for MCP servers

Add a repo-local skill when an MCP server exposes a workflow that tool schemas cannot explain on their own. This reference is for maintainers documenting when to call the server, operation order, result interpretation, validation, and cleanup.

Before writing the skill, confirm the MCP server name, visible tool names, approval boundaries, failure states, and cleanup contract. A single obvious utility usually does not need a companion skill.

## Purpose

MCP tool descriptions explain callable functions, but they usually do not provide enough context for:

- when to use the server
- expected workflow order
- project-specific assumptions
- interpretation of compact outputs
- validation and cleanup expectations
- dangerous operations that should stay rare

Create a companion skill when the MCP supports a workflow rather than a single obvious utility.

## Placement

For repo-local MCPs, prefer:

```text
.codex/
  config.toml
  mcp/<server-name>/
  skills/<skill-name>/SKILL.md
```

The skill should point to the MCP server by name and explain the workflow. Keep implementation details in the MCP source and only include the operational knowledge agents need.

## Required contents

Include:

- Trigger description: when this skill should be used.
- MCP server name and expected tool names.
- Safe default workflow.
- Output interpretation rules.
- Validation steps.
- Failure and cleanup guidance.

Avoid:

- Repeating every tool schema.
- Large logs or generated tool output examples.
- Secrets, local-only paths, or personal machine details in committed project skills.

## Minimal pattern

```md
---
name: project-env
description: Use when starting, inspecting, or resetting the repo-local development environment through the project_env MCP server.
---

# Project Environment

Use the `project_env` MCP server for environment stack operations.

Workflow:

1. Call `health` or `stack_status` before changing anything.
2. Prefer read-only inspection unless the user asked for environment changes.
3. Use reset or cleanup tools only when the current stack is known to be disposable.
4. After changes, call `stack_status` and report the compact result.
```

## Boundaries

- Keep implementation details in the MCP package and operational guidance in the skill.
- Do not copy every tool schema into `SKILL.md`.
- Do not commit secrets, machine-specific paths, large logs, or generated tool output examples.
- Make destructive and cleanup tools rare, explicit, and conditional on disposable state.

## Verification

After adding a paired skill:

- Confirm its frontmatter is valid YAML.
- Confirm the skill name and MCP server name are not accidentally different unless intentional.
- Start a new Codex thread or reload skill discovery if available.
- Ask the agent to use the skill on a harmless status prompt.
