# Consuming repository manifest

A consuming Git repository commits `.codex-container-lab.yaml`. Exactly one lifecycle mode is required.

## Compose mode

```yaml
compose:
  files:
    - compose.yaml
    - compose.dev.yaml
  command_service: app
runtime:
  workspace: /workspace
  shell: [/bin/bash, -lc]
ports:
  web:
    service: app
    target: 3000
    scheme: http
environment:
  - OPTIONAL_PUBLIC_REGISTRY
compose_environment:
  - PROJECT_VARIANT
secret_environment: []
```

`files` are passed to Compose in order during one raw-model construction rooted at the consuming repository. Compose expands merge, `include`, and `extends` semantics; the exact resulting JSON becomes the private runtime's sole lifecycle source, so later project-file edits do not change the stack topology. Relative build contexts, configs, and bind mounts retain the original project-directory basis. Service `env_file` and project `.env` are unsupported because they are mutable interpolation sources outside that snapshot. The command service must already be long-running. The generated override mounts the isolated clone at `runtime.workspace`, sets `init`, adds management labels, and adds random `127.0.0.1` publications for declared ports.

### Environment capabilities

`environment` is the explicit command-service forwarding allowlist. Its list-form names are passed to Compose as-is, so Compose resolves each name from the invoking CLI process environment when the service starts. It is not a general-purpose project environment block, and the values are not written to the lab manifest or other durable state.

`compose_environment` is the explicit non-secret project-input allowlist. It authorizes source Compose interpolation (`$NAME`, `${NAME}`, defaults, alternatives, required expressions, and nested expressions) and implicit host reads represented by valueless service `environment` or build `args` entries. Declared values are supplied to Compose only when present in the invoking CLI environment. `$$` remains a literal dollar escape. `environment` alone does not grant this source authorization; list a name in both fields when the project source and the command service intentionally require the same non-secret value.

`secret_environment` is a separate, optional allowlist for project-owned Compose top-level secret sources. The lab does not generate secret definitions; the project's Compose model may define a source with the shape `{ environment: VAR }`:

```yaml
environment:
  - OPTIONAL_PUBLIC_REGISTRY
compose_environment:
  - PROJECT_VARIANT
secret_environment:
  - OPTIONAL_DATABASE_URL
```

At create/provision time, every secret name must be present in the invoking CLI environment and must be used by a project-owned top-level secret source. Secret names, not values, are persisted. Values are injected only for `docker compose up`; configuration, inspection, status, logs, attached execution, termination, cleanup, and image operations never receive them. A secret name cannot occur in `environment`, `compose_environment`, or the fixed non-secret Docker-client environment; overlaps are rejected. Plaintext service environment use of a declared secret name is rejected.

Before writing the generated override or creating resources, the engine reads only the project/base files with `docker compose --env-file /dev/null ... config --no-interpolate --no-normalize --no-env-resolution --format json`. This raw gate preserves valueless service environment and build arguments and validates all interpolation before normalization can erase the evidence. Undeclared reads fail even when a same-named variable such as `HOME` is present in the reviewed Docker-client environment. Project `.env`, service `env_file`, and top-level `configs.environment` are unsupported and fail closed; use `compose_environment`, explicit service values, project-owned config content, or a reviewed top-level secret source instead. After validation the exact raw JSON is written to `source.compose.json`; every normalized check and lifecycle operation uses only that file plus the generated override. Compose diagnostics stay behind fixed redacted errors.

## Dockerfile shorthand

```yaml
dockerfile:
  path: Dockerfile
  context: .
  service: lab
runtime:
  workspace: /workspace
  shell: [/bin/bash, -lc]
ports: {}
environment: []
compose_environment: []
secret_environment: []
```

The engine generates one internal Compose service with the build definition and a durable foreground command, then applies the same override/lifecycle path as Compose mode.

## Image shorthand

```yaml
image:
  name: ubuntu:24.04
  service: lab
runtime:
  workspace: /workspace
  shell: [/bin/bash, -lc]
ports: {}
environment: []
compose_environment: []
secret_environment: []
```

The selected image must satisfy the compatibility contract: a normal distro, configured shell, `setsid`, writable workspace, and usable long-running command service. Distroless images do not satisfy this contract.

All project paths must be relative and remain inside the repository. Container workspace and shell executable paths must be normalized absolute paths. All three environment fields accept at most 64 unique variable names and reject the reserved `COMPOSE_` prefix so manifest data cannot reintroduce ambient topology controls. `environment` forwards names to the command service, `compose_environment` authorizes non-secret source reads, and `secret_environment` authorizes required top-level secret sources. Only names are persisted; values are never persisted in lab metadata.
