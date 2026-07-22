set dotenv-load := false

codex := env("CODEX_BIN", "codex")
local_source := justfile_directory()
marketplace := "skizzles"
plugin := "skizzles"

# Show the small set of commands intended for people using this repository.
default:
    @just --list

# Install this checkout as a Codex marketplace and enable its plugin.
plugin-install codex_home source=local_source:
    @case "{{codex_home}}" in /*) ;; *) echo "CODEX_HOME must be an absolute path: {{codex_home}}" >&2; exit 1;; esac
    @test -d "{{codex_home}}" || (echo "CODEX_HOME does not exist: {{codex_home}}" >&2; exit 1)
    @command -v "{{codex}}" >/dev/null || (echo "Codex CLI not found. Set CODEX_BIN or install Codex first." >&2; exit 1)
    @if [ -d "{{source}}" ]; then test -f "{{source}}/.agents/plugins/marketplace.json" || (echo "Marketplace metadata not found under {{source}}" >&2; exit 1); fi
    @CODEX_HOME="{{codex_home}}" "{{codex}}" plugin marketplace add "{{source}}" --json
    @CODEX_HOME="{{codex_home}}" "{{codex}}" plugin add "{{plugin}}@{{marketplace}}" --json
    @echo "Installed {{plugin}}@{{marketplace}}. Start a new Codex task to load it."

# Show the configured marketplace and the plugin's installed/available state.
plugin-status codex_home:
    @case "{{codex_home}}" in /*) ;; *) echo "CODEX_HOME must be an absolute path: {{codex_home}}" >&2; exit 1;; esac
    @test -d "{{codex_home}}" || (echo "CODEX_HOME does not exist: {{codex_home}}" >&2; exit 1)
    @command -v "{{codex}}" >/dev/null || (echo "Codex CLI not found. Set CODEX_BIN or install Codex first." >&2; exit 1)
    @CODEX_HOME="{{codex_home}}" "{{codex}}" plugin marketplace list
    @CODEX_HOME="{{codex_home}}" "{{codex}}" plugin list --marketplace "{{marketplace}}" --available --json

# Remove the installed plugin and then its configured marketplace.
plugin-remove codex_home:
    @case "{{codex_home}}" in /*) ;; *) echo "CODEX_HOME must be an absolute path: {{codex_home}}" >&2; exit 1;; esac
    @test -d "{{codex_home}}" || (echo "CODEX_HOME does not exist: {{codex_home}}" >&2; exit 1)
    @command -v "{{codex}}" >/dev/null || (echo "Codex CLI not found. Set CODEX_BIN or install Codex first." >&2; exit 1)
    @CODEX_HOME="{{codex_home}}" "{{codex}}" plugin remove "{{plugin}}@{{marketplace}}" --json
    @CODEX_HOME="{{codex_home}}" "{{codex}}" plugin marketplace remove "{{marketplace}}" --json

# Install only the public skills, without the plugin hooks or runtime bundles.
skills-install:
    bunx skills add https://github.com/xsyetopz/skizzles --skill install-skizzles

# Install workspace dependencies for source development.
setup:
    bun install --frozen-lockfile

# Rebuild the generated plugin from canonical package inputs.
plugin-build:
    bun run plugin:build

# Check that the generated plugin matches canonical package inputs.
plugin-check:
    bun run plugin:check

# Run the complete local acceptance gate.
verify:
    bun run verify
