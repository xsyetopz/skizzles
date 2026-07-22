# Skizzles documentation

Start with the [repository README](../README.md) if you need to install or
develop Skizzles. This directory explains how the workspace is built and why
its boundaries exist.

## Find the right guide

| You want to... | Read... |
| --- | --- |
| understand package ownership and generated output | [Workspace architecture](workspace-architecture.md) |
| understand a design decision | [Decision records](decisions/README.md) |
| inspect Codex-specific implementation notes | [OpenAI notes](openai/) |
| inspect evidence, experiments, and platform work | [Research notes](research/) |
| install an optional host integration | the feature guide linked from the repository README or the owning package README |

## How the documents are organized

`workspace/` decision records describe package boundaries, source ownership,
and repository policy. `orchestration/` records the runtime and agent-routing
decisions. `platform/` records host and process constraints.

The OpenAI notes explain implementation assumptions about Codex surfaces. The
research notes preserve measurements and experiments that support, challenge,
or refine those assumptions. They are evidence, not installation instructions.

Package-level behavior belongs with the package that owns it. Use the package
README for a capability summary and its `docs/` directory for contracts,
safety rules, installation, or completion requirements.
