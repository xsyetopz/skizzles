# Codex Container Lab

Codex Container Lab is Skizzles' canonical Bun/TypeScript package for disposable Docker Compose development environments. Each Codex thread owns isolated Git workspace clones, guarded synchronization, and exact-label cleanup. There is no MCP execution server or secondary command scheduler.

This directory is the private `@skizzles/container-lab` workspace package. Production code lives in `src/`, tests live in `test/`, install material lives in `install/`, and the package-owned integration descriptor lives in `assets/integrations/container-lab.json`. The repository root `bun.lock` is the only lockfile. The supported package facade is `src/lab/orchestrator.ts`; package scripts execute `src/cli.ts` and `src/reaper-cli.ts` directly. Stable Skizzles plugins carry dependency-self-contained CLI and reaper bundles, and the public skill launcher works before PATH wiring exists.

Project topology belongs to the consuming repository. A committed `.codex-container-lab.yaml` selects existing Compose files and a command service, or uses Dockerfile/image shorthand normalized into the same one-service Compose lifecycle. The engine adds only the isolated workspace mount, exact ownership labels, init behavior, and declared random loopback ports.

Manifests separate `environment` (command-service forwarding), `compose_environment` (non-secret source interpolation and implicit pass-through), and `secret_environment` (top-level secret sources). The validated raw Compose model is materialized once under the private lab runtime; later up, status, logs, and exec operations never reinterpret mutable project Compose files. Docker and Git subprocesses receive constructed environments rather than ambient host state. Secret names are retained for lifecycle bookkeeping; values reach only Compose up and remain outside every generated, diagnostic, public, and durable boundary. See the [manifest contract](docs/manifest.md); bundled examples leave all capabilities empty.

## Quick start

1. From the Skizzles root, run `bun skills/codex-container-lab/scripts/codex-container-lab --help` to use the bundled launcher without PATH wiring. Read [docs/installation.md](docs/installation.md) before optional host wiring.
2. Copy the closest manifest from `examples/compose`, `examples/dockerfile`, or `examples/image` into a consuming Git repository.
3. From a Codex unified shell, run the skill launcher with `health`, then `lab create --name experiment`. `CODEX_THREAD_ID` supplies the exact owner automatically.
4. Run work with the launcher and `run --lab LAB_ID -- COMMAND...`, synchronize through `sync preview`/`sync apply`, then explicitly destroy labs. The command stays attached to Codex's unified shell, which owns backgrounding, polling, stdin, signals, and final status. The periodic archive reaper is a crash/abandonment backstop, not the normal lifecycle.

For manual use outside Codex, every operation requires an explicit owner override; the CLI never invents ownership. See the [CLI architecture](docs/architecture.md), [manifest contract](docs/manifest.md), [safety model](docs/safety.md), and binding [completion contract](docs/completion-contract.md).
