---
name: auth-semantics
description: Preserve authentication, authorization, session, permission, access-control, and availability semantics. Use when changing login/session flows, permission checks, API auth errors, gated UI, role-based access, token refresh, logout behavior, unavailable states, or security-sensitive user access paths.
---

# Auth Semantics

Apply this skill when implementation or review can change who may act, how identity is established, or what users and callers learn from an access failure. It is for engineers working across API enforcement, session handling, client gating, navigation, and user-facing state.

The job is to preserve the product's security contract. A passing UI flow is not sufficient if privileges broaden, server enforcement weakens, or distinct failures collapse into one misleading state.

## State model

Classify each path before changing it:

- unauthenticated: no valid identity or session is present
- invalid session: identity was expected, but the token or session is expired, revoked, corrupt, or otherwise unusable
- unauthorized: the identity is valid but lacks permission for the action or resource
- unavailable: a dependency failure prevents the system from determining or serving the state
- invalid request: the caller supplied malformed or unsupported input

Keep these states distinct unless the product contract explicitly combines them. Follow each state from enforcement through error mapping, client behavior, and visible copy.

## Security boundaries

- Never broaden privileges to make a flow pass.
- Do not force logout for a permission denial unless the contract requires it.
- Do not report dependency outages as authorization denials.
- Do not reveal that a sensitive resource exists unless the product contract permits it.
- UI hiding cannot replace server-side enforcement.
- Preserve relevant audit and logging behavior.
- Bound retries and refreshes so they cannot loop forever or hide a denied permission.

Error wording may intentionally conceal resource existence. Preserve that policy while keeping internal state classification and enforcement accurate.

## API and UI contract

APIs must retain the status codes, error variants, response shapes, redirects, and retry behavior their callers depend on. Treat any change to those surfaces as a compatibility decision and inspect affected callers.

The UI must present the state that actually occurred:

- login needed
- access denied
- session expired
- temporarily unavailable
- invalid input

Do not replace one state with a more convenient screen. Navigation, refresh, and recovery behavior must also match the classified state.

## Workflow

1. Map the relevant identities, permissions, sessions, dependencies, and public error surfaces.
2. Trace server, middleware, or guard enforcement before inspecting presentation.
3. Follow token refresh, session invalidation, logout, redirects, and client gating for every affected state.
4. Check error mapping and callers for contract changes.
5. Exercise negative cases as well as the successful path.
6. Inspect logs or audit events when the product records security decisions.

## Completion evidence

Report which states were inspected or exercised, where enforcement occurs, and why the change did not broaden privileges. Evidence should cover the affected subset of:

- server, middleware, or guard checks
- client gating and navigation
- token refresh and session invalidation
- error mapping and API compatibility
- denied, expired, unauthenticated, invalid, and unavailable cases
- logs or audit events

If a state could not be exercised, name the missing environment or dependency and state what source-level evidence was available. Do not describe generic successful tests as auth proof unless they distinguish the relevant states.
