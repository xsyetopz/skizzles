---
name: rinf-boundary
description: Preserve Flutter Rinf architecture boundaries in projects that use Rinf. Use when changing Flutter UI, Dart state, Rust backend logic, signals/messages, generated Rinf files, networking, persistence, or cross-boundary data flow in a Rinf-based app.
---

# Rinf boundary

Preserve the Dart-to-Rust ownership boundary in Flutter applications built with Rinf. Use this skill when a change touches UI state, Rust domain logic, networking, persistence, signals, events, or generated bindings.

The project must already use Rinf for the affected domain. Dart sends user intents through Rinf signals; Rust returns authoritative results through Rinf event streams. If the project does not use Rinf, do not introduce it only to satisfy this skill.

## Before editing

- Find the source signal definitions and the project's sanctioned generation command.
- Trace the affected Dart sender, Rust handler, result event, and UI subscriber.
- Identify which side owns networking, persistence, and domain state.
- Check whether generated Dart and Rust files are committed as part of the repository contract.

## Ownership rules

- Do not add ordinary Dart networking for product data when the project uses Rinf for that domain.
- Do not create parallel Dart global state or persistence for data that should hydrate through Rust/Rinf.
- Do not bypass Rust-side source of truth with frontend-only state.
- Keep request/response semantics on the intended signal/event path.
- Client-device preferences such as theme or text size may stay local when the project already treats them as local preferences.

## Workflow for signal changes

When changing Rinf signals or messages:

- update the source signal definitions
- regenerate generated Dart/Rust bindings through the project's sanctioned command
- keep generated files when they are part of the repo contract
- do not discard generated changes as noisy
- inspect call sites on both sides of the boundary

## Verification

Before reporting completion, verify:

- Dart sends intents rather than direct product networking
- Rust owns product data fetching, persistence, or domain authority where expected
- event streams hydrate UI state
- loading/error/empty states map from real Rinf results
- generated files match the source definitions
- focused tests or manual proof cover both sides when practical

Report the source signal changes, regenerated files, Dart and Rust call sites, and the proof used to exercise the full intent-to-event path. If one side cannot be exercised locally, name the missing boundary and the evidence still available.
