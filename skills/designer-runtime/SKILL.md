---
name: designer-runtime
description: Pilot local iOS Simulators for UI/design/QA work on macOS, especially Flutter or native iOS visual verification. Use explicitly when Codex needs to list booted simulators, launch or stop a simulator app, run or hot reload Flutter through a background unified_exec terminal, inspect accessibility hierarchy with idb, tap/type/swipe, capture screenshots, crop screenshots, or provide visual proof from an iOS Simulator.
---

# Designer Runtime

Use this skill when a Designer or QA agent must pilot an existing local iOS Simulator and collect visual or interaction evidence. It covers native iOS and Flutter loops on macOS. It does not install host tools, change simulator configuration, or replace product-level design review.

The expected result is a tested flow with absolute screenshot or log paths, or a precise prerequisite or product blocker.

## Prerequisites

Run only on macOS with Xcode command-line tools and an iOS Simulator runtime already available. Confirm each tool needed by the planned flow:

- `xcrun` for simulator discovery and application launch
- `idb` for accessibility hierarchy and interaction commands
- ImageMagick's `magick` for selector and manual crops
- `flutter` for Flutter run and hot-reload loops

If a required tool is missing, stop and report how it blocks the requested proof. Do not install software or mutate host configuration.

Prefer existing XcodeBuildMCP simulator tools for native iOS applications when they are available. Use a background shell session for long-running Flutter or development-server processes. Use the bundled `designer-sim` script for direct `idb` interaction, screenshots, and crop evidence.

## Runtime boundaries

- Use one simulator for each active loop and execute interactions sequentially.
- Do not erase, delete, shut down, or recreate simulators.
- Do not kill Simulator, CoreSimulator, or CoreSimulator services.
- Avoid project-wide build, analyze, test, or format commands while parallel edits remain active unless the parent declares a verification sync point.
- Keep the application process in one background terminal session. Poll that session instead of wrapping it in tmux.
- Capture screenshots or logs for product blockers and report absolute paths.
- Prefer selector-based taps and crops when accessibility labels or identifiers exist. Use coordinates only when the hierarchy cannot identify the target.

## Command surface

The script lives in this skill's `scripts/` directory. Invoke it by absolute path when `designer-sim` is not on `PATH`.

```sh
designer-sim devices
designer-sim hierarchy --device-id <UDID>
designer-sim screenshot --device-id <UDID> --out /tmp/proof.png
designer-sim screenshot --device-id <UDID> --selector '{"text":"Continue"}' --out /tmp/continue.png
designer-sim tap-on --device-id <UDID> --selector '{"text":"Continue"}'
designer-sim tap --device-id <UDID> --x 120 --y 240
designer-sim text --device-id <UDID> --text "hello"
designer-sim swipe --device-id <UDID> --from 180,700 --to 180,220
designer-sim launch --device-id <UDID> --bundle-id com.example.app
designer-sim terminate --device-id <UDID> --bundle-id com.example.app
designer-sim open-url --device-id <UDID> --url myapp://debug
```

## Flutter workflow

1. From the application worktree, start Flutter in a background terminal session:

   ```sh
   flutter run -d <UDID>
   ```

2. Poll the same session until Flutter reports that the application is running or returns a concrete failure.
3. Inspect the current state with `designer-sim hierarchy` or `designer-sim screenshot`.
4. Perform one interaction at a time with `designer-sim tap-on`, `tap`, `text`, or `swipe`.
5. After code changes, send `r` to the existing session and poll for the hot-reload result.
6. Capture final evidence with `designer-sim screenshot --out <absolute-path>`.
7. Send `q` or Ctrl-C to the same session when the loop is complete.

Do not use tmux unless the user requests it or background shell sessions are unavailable.

## Selector JSON

Selectors are small JSON objects. Common keys are:

```json
{"text":"Continue"}
{"label":"Settings"}
{"id":"save-button"}
{"name":"Close"}
{"value":"Selected"}
```

Matching uses case-insensitive exact text by default. Add `"contains": true` for substring matching:

```json
{"text":"continue", "contains": true}
```

## Evidence report

Store screenshots under `/tmp/codex-designer-runtime/` or another absolute path. Report:

- device UDID or simulator name
- command or user flow tested
- screenshot or log path
- observed result
- blocker and last successful step, when the flow did not complete

The report should distinguish runtime proof from source inspection. A launch log alone does not prove a visual state when a screenshot and interaction were required.
