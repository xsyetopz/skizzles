# ADR 0006: Isolate Container Lab process environments

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owner:** `@skizzles/container-lab`
- **Scope:** host Docker Compose and local Git subprocess trust boundaries

## Context

Container Lab previously passed the invoking process environment to Docker Compose and removed only declared secret names from selected operations. Ambient variables could therefore change the Docker endpoint, Compose topology, source interpolation, service environment, or build arguments without appearing in the committed lab manifest. The pre-provision inspection requested an already normalized no-interpolation model, which can erase valueless service environment and build arguments before policy sees their implicit host reads. Secret values were also present during configuration inspection rather than only resource creation.

Validation alone did not bind the validated model. The runtime persisted arguments referencing the original project Compose files, so edits after inspection could change `up` and every later status/log/exec interpretation without another capability or privilege review. Default project `.env` and service `env_file` were additional mutable inputs. In particular, an `env_file` value could interpolate a declared `secret_environment` value during `up`, converting a names-only top-level secret capability into plaintext service environment.

Structural findings also used the raw no-interpolation model. Authorized values could therefore remain strings during inspection even when Compose normalization converted them into booleans, host namespace modes, or structured publications. For example, raw `privileged: ${LAB_PRIVILEGED}` was not reported although the normalized model and `up` used `privileged: true`.

Local Git discovery, identity, clone, checkout, and cleanup-time checks inherited the same process environment. Git documents repository selectors and configuration injection through environment variables, and global/system configuration can define hooks. A caller-controlled environment could therefore redirect repository behavior or execute a hook at the disposable-workspace boundary.

Git path discovery also requires complete output. The host process adapter formerly retained only the configured stdout prefix without reporting overflow. A syntactically complete, NUL-terminated prefix of `git ls-files` output could therefore omit a tracked tail path and make synchronization interpret that omission as a deletion.

Primary contracts support a narrower boundary:

- Docker documents `$VAR`, braced/default/required/alternative/nested interpolation and `$$` literals in the [Compose interpolation specification](https://docs.docker.com/reference/compose-file/interpolation/).
- Docker documents that `compose config` merges and renders the applied model and exposes `--no-interpolate`, `--no-normalize`, `--no-env-resolution`, and JSON output in the [CLI reference](https://docs.docker.com/reference/cli/docker/compose/config/).
- Docker documents valueless service environment entries as host pass-through in the [environment guide](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/).
- Docker documents environment-backed top-level configs as a supported Compose source in the [configs reference](https://docs.docker.com/reference/compose-file/configs/); Container Lab deliberately does not adopt that credential-capable path.
- Git documents `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, environment configuration injection, repository selection, command-scoped `core.hooksPath`, and the executable-or-boolean `core.fsmonitor` setting in the [Git configuration reference](https://git-scm.com/docs/git-config).

Local causal inspection used Docker Compose `v5.1.2` and Git `2.55.0`. The exact raw Compose command preserved nested interpolation, `$$`, null service environment, null build arguments, top-level secret environment sources, and top-level config environment sources in JSON without contacting the daemon. Compose expanded `include` and `extends` into that raw JSON. Explicit `--env-file /dev/null` suppressed default project `.env` discovery. A deeper compact-syntax probe showed that the raw JSON is authorization evidence, not a semantics-preserving lifecycle source: for example, normalizing a raw interpolation placeholder for a compact volume can differ from normalizing the original interpolated volume. Direct normalization of the original source preserved effective compact socket-bind and port structures. Compose `v5.1.2` accepted interpolation for privileged mode, host network mode, volumes, and ports but required `use_api_socket` to be a literal boolean. These installed versions are evidence for the implementation tests, not a new minimum-version declaration.

## Decision

Construct every Docker CLI environment from exact capabilities. The fixed client set includes reviewed path/home, Docker context/host/config/TLS/API/platform/header controls, proxy and CA variables, `SSH_AUTH_SOCK`, temporary-directory variables, locale/no-color settings, and build progress. Prefix matching is forbidden. Ambient `COMPOSE_*` topology controls are absent because persisted absolute source files, project directory, and project name are authoritative.

Add three bounded manifest capabilities:

- `environment` forwards exact non-secret names to the command service;
- `compose_environment` authorizes exact non-secret source interpolation and valueless service-environment/build-argument reads;
- `secret_environment` authorizes required top-level Compose secret sources and is disjoint from both other fields.

The first two may overlap when the project source and command service intentionally need the same non-secret value. All fields contain at most 64 unique environment names and reject the reserved `COMPOSE_` prefix so manifest capabilities cannot reintroduce topology controls. Only names are persisted. Version-1 state missing `composeEnvironment` or `secretEnvironment` normalizes to empty arrays before validation.

Before generated override creation, run the source/base files through:

```sh
docker compose ... config \
  --no-interpolate --no-normalize --no-env-resolution --format json
```

The raw gate validates unbraced, braced, default, alternative, required, and nested interpolation, preserves `$$` literals, and rejects undeclared interpolation plus null service environment and build arguments. `environment` alone does not authorize source reads. Declared secret names may occur only as present top-level secret sources; plaintext service environment use is rejected. Project `.env`, service `env_file`, and top-level `configs.environment` are rejected rather than retaining mutable or second secret paths. Every Compose invocation supplies `--env-file /dev/null`, so a `.env` created after validation cannot re-enter implicitly.

Treat the validated raw document as authorization evidence A, not as the persisted lifecycle source. Under the same Docker-client and manifest-authorized non-secret environment, with no secret values, explicit `/dev/null`, and `--no-env-resolution`, ask Compose to normalize the original source graph directly into document N. Repeat the exact raw command to obtain B and reject creation unless A and B are byte-identical. This stable-read bracket detects ordinary source, include, and extends graph changes during inspection. It is a trusted-project consistency check, not an atomic filesystem snapshot, and does not claim to exclude a hostile same-user ABA rewrite that restores byte-identical raw output around N.

Persist N as private `source.compose.json`. Findings and override generation use this source-only normalized model, so interpolation-dependent compact syntax and effective types remain Compose-authored while the engine's expected workspace bind, labels, init behavior, and random loopback publications are not misreported as project findings. A final normalized N-plus-override model validates command-service composition. `up`, status, logs, attached execution, and termination then use the same materialized source plus override; persisted arguments never reference the original Compose files. The original `--project-directory` remains fixed so relative build contexts, configs, and deliberate bind mounts retain Compose path semantics. Runtime state without `sourceFile` remains readable for version-1 compatibility but every Compose operation fails with an explicit recreate-required error. Exact-label destruction remains independent of Compose arguments and therefore remains available for that legacy state.

Docker config, inspection, information, status, logs, attached execution, termination, cleanup, reaper, and image operations receive no secret values. Only `compose up` adds required `secret_environment` values, and a secret name that collides with a fixed non-secret Docker-client capability fails before up. Every Docker runner `run` and `spawn` call requires an explicit environment; the default runner has no ambient fallback. `ContainerLabService` threads its injected environment through the complete lifecycle.

Run every owned local Git command through one adapter. It supplies only present `PATH` and temporary-directory values, fixed C locale, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, and `GIT_TERMINAL_PROMPT=0`, and adds command-scoped `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, and `-c core.logAllRefUpdates=false`. Ambient repository/worktree/index/object selectors, askpass/SSH/credential controls, configuration injection, trace, pager, and editor variables are absent. Repository-local filesystem-monitor commands are disabled even when configured as absolute executables, and clone reflogs cannot retain the absolute source path. Provisioning requires absolute local source and destination paths, clones the resolved repository using `--local --no-hardlinks --dissociate`, removes its remote, verifies the clone common directory has no alternates file, and checks out the exact recorded commit.

The shared process adapter keeps bounded truncation as the explicit default for diagnostic and summary consumers. Completeness-critical Git path discovery instead enables fail-closed output limits: the first stdout or stderr byte beyond the cap enters the same exact process-group cleanup path as cancellation and rejects before command status or `allowFailure` can be accepted. A complete NUL-terminated prefix is never returned as a manifest.

The executable-configuration audit is scoped to the exact owned Git verbs. `ls-files` can refresh the index and therefore can reach `core.fsmonitor`; detached checkout can reach standard hooks, so both surfaces are disabled for every command rather than only their current callers. The package does not invoke diff/merge, commit/tag/signing, credential, remote transport, garbage collection, trailer, or submodule-update commands, so their external diff/filter/editor/pager/signing/helper/upload-pack/recent-object/trailer/submodule command settings are not reachable. `clone --local` bypasses the normal Git-aware transport and `--no-hardlinks` copies direct source objects. Git also propagates a local source's existing `objects/info/alternates`; `--dissociate` therefore copies borrowed reachable objects into the new workspace, and the postcondition rejects any clone that still has an alternates file. A Git `2.55.0` causal probe confirmed that this combination produces a self-contained clone of a linked worktree backed by a shared repository and that the clone remains `fsck`-clean after both external stores move. The same probe confirmed that local clone does not copy a source repository's filter-driver configuration into the new workspace; checked-in attributes alone therefore do not provide an executable checkout driver. Adding a Git verb or clone mode requires repeating this reachability audit and adding a production-entrypoint sentinel for every newly applicable executable setting.

The host subprocess implementation remains POSIX-only. These controls isolate process inputs for trusted local repositories and trusted project Compose files; they do not turn either tool into a hostile-input sandbox.

## Considered alternatives

- **Inherit the environment and delete known secrets:** rejected. Unknown credentials, Compose topology variables, prefix variants, Git selectors, and future tool controls remain ambient capabilities.
- **Treat `environment` as source authorization:** rejected. Command-service forwarding and project-source interpolation have different reasons to change and different review surfaces.
- **Pass secrets to `compose config`:** rejected. Raw no-env-resolution validation can verify the declared source name without exposing its value; only `up` needs the value.
- **Permit `configs.environment` through `secret_environment`:** rejected. It would add a second secret materialization semantic and broaden retention/output risk without a demonstrated package need.
- **Parse Compose YAML independently:** rejected. Reimplementing merge, include, extension, interpolation, and shorthand behavior would create a divergent parser. Compose owns model construction; Container Lab owns the pre-normalization capability gate.
- **Persist the raw authorization document and normalize it later:** rejected. Raw JSON preserves interpolation evidence but can change the meaning of interpolation-dependent compact syntax when reparsed as a new Compose source. The lifecycle source must be Compose's direct normalization of the original graph.
- **Copy the complete Compose source graph before inspection:** rejected. Reliably discovering and reproducing every Compose-owned include, extends, relative-path, and future source semantic would duplicate the parser boundary and create a much larger file-copy trust surface. The stable-read bracket is the smaller trusted-project control.
- **Hash and revalidate the project source before each operation:** rejected. Correctness would require discovering and hashing the complete include/extends/`.env`/`env_file` graph, still leaves a check-to-read race, repeats expensive parsing for status/logs/exec, and makes safe destruction depend on mutable project files. A one-time pre-up recheck also does not protect post-ready operations.
- **Persist only a source digest and regenerate a temporary model per call:** rejected. Regeneration still consumes mutable dependencies and creates the same race before Docker reads them. Supplying the model over stdin is incompatible with attached exec's stdin transport. One validated private model is the smaller durable boundary.
- **Rely on `env -i` at the CLI entrypoint:** rejected. Library and reaper callers require the same executable boundary, and Docker still needs a reviewed client environment.
- **Trust global/system Git configuration or hooks for developer convenience:** rejected. Disposable cloning must be reproducible and non-interactive. Project content remains intact; host policy does not participate.

## Consequences and limitations

- Existing manifests that relied on ambient source interpolation or valueless pass-through must add `compose_environment`; this is an intentional fail-closed compatibility change.
- Compose-mode repositories with project `.env` or services with `env_file` must move reviewed non-secret values to `compose_environment` and explicit service environment. This intentional compatibility loss prevents unbound source drift and secret-to-plaintext conversion.
- `environment` continues to forward command-service values but no longer silently authorizes source interpolation.
- Missing non-secret names retain Compose's own default/empty/required expression behavior. Missing declared secrets fail before resource creation.
- Older Compose clients lacking any required raw-model flag fail with a fixed configuration error. The package does not silently downgrade to a normalized or YAML fallback.
- The Docker client allowlist is an owned compatibility surface. A future client control requires evidence, tests, and ADR review before admission.
- Original Compose files, including expanded `include` and `extends` inputs, are trusted during the raw-A, normalized-N, raw-B stable-read bracket. Ordinary mutation that changes the raw graph rejects creation, and mutation after a successful bracket cannot alter lifecycle topology. The bracket is not atomic against a hostile same-user ABA rewrite. Intentional build contexts, Dockerfiles, bind-mounted content, file-backed configs/secrets, repository-local Git data, and checked-in attributes remain trusted project/runtime inputs; this decision does not turn project content into a hostile-input sandbox.
- Legacy version-1 runtime state without `sourceFile` must be recreated before status, logs, or attached execution. Its exact ownership labels still permit destruction without consulting Compose source.
- POSIX `/dev/null`, process groups, and local clone semantics remain the supported host boundary. Cross-platform expansion requires a superseding decision and causal parity evidence.

## Fitness checks

```sh
bun test packages/container-lab/test/docker/environment.test.ts \
  packages/container-lab/test/docker/materialization.test.ts \
  packages/container-lab/test/docker/runtime.test.ts \
  packages/container-lab/test/compose/inspection.test.ts \
  packages/container-lab/test/process.test.ts \
  packages/container-lab/test/process/git.test.ts \
  packages/container-lab/test/sync/git-environment.test.ts \
  packages/container-lab/test/lab-service/provisioning.test.ts
bun run --cwd packages/container-lab typecheck
bunx @biomejs/biome@2.5.4 check --config-path biome.jsonc --vcs-root . \
  packages/container-lab docs/decisions/0006-container-process-environment.md \
  skills/codex-container-lab/SKILL.md
bun run workspace:check
bun run security:check
```

Tests bind raw source flags and pre-override ordering; byte-identical raw-A/raw-B drift rejection; exact equality between persisted N and Compose's direct original-source normalization for interpolated compact socket binds and ports; source-only findings for interpolated privileged mode, host namespace, literal engine API access, socket/host binds, and structured fixed/non-loopback ports; exclusion of the generated workspace bind from findings; exact allowlist membership, non-mutation, no prefix admission, and `COMPOSE_*` removal; nested/default/escaped interpolation; null environment/build arguments; forward-only rejection; `.env` and service `env_file` rejection; secret up-only injection and redaction; post-ready source mutation; real daemonless include/extends materialization; legacy recreate-required behavior with retained destruction; v1 empty defaults; explicit Docker run/spawn environments; exact process-group cleanup on complete-output overflow; a 64 MiB NUL-terminated Git prefix followed by a rejected tail; and real production-entrypoint sentinels proving ambient Git configuration, repository selectors, checkout hooks, and an absolute repository-local `core.fsmonitor` command do not execute.

## Review and supersession

Review on a Docker Compose interpolation/model flag change, a new required Docker client control, a missed implicit host read or mutable model dependency, a secret diagnostic incident, a Git environment/configuration or hook bypass, non-POSIX support, or a manifest compatibility change. Supersede this ADR before adding `.env`/`env_file`, another environment-backed secret/config source, permitting ambient topology, removing the raw authorization gate, normalized persistence, or stable-read bracket, broadening Git inputs, or replacing the Docker/Git process adapters. A replacement must preserve causal negative fixtures and document migration and rollback.
