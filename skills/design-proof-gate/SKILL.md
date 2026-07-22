---
name: design-proof-gate
description: Require screenshot-backed proof and production UI quality for frontend, product UI, Flutter, web, design-system, and UX work. Use when implementing, reviewing, or accepting visual changes, layout changes, design polish, responsive screens, component styling, empty/loading/error states, or user-facing copy.
---

# Design Proof Gate

Apply this gate to implementation, review, and acceptance of user-visible UI. It is for frontend, product UI, Flutter, web, design-system, and UX work where layout, copy, hierarchy, interaction states, or visual finish changed.

A code diff cannot prove visual quality. Completion requires inspectable screenshots from the relevant runtime, plus evidence that the screen remains truthful and functional.

## Proof contract

Record before or during the work:

- reviewed screen, component, or flow
- primary user job
- scope contract
- content-versus-shell boundary
- fake-data policy
- reference image path, when one exists
- approved design direction or user instruction when no reference exists

Final evidence must include screenshot paths, the capture method, and the viewport or device. Use `$designer-runtime` for iOS Simulator proof. Use the browser or runtime tools available in the session for browser proof. Text-only inspection does not satisfy this gate unless the user explicitly accepts that limit.

## Product truth

Assigned product behavior must not be represented by fake, decorative, placeholder, or non-functional UI.

Controls, inputs, navigation, filters, toggles, copy, loading states, empty states, error states, permission states, unavailable states, saved states, and selected states must work through the intended product path. If the product cannot perform an action, the UI must explain the unavailable state accurately and give useful recovery context.

Mock data is allowed only in a design lab or reference fixture, or when the user explicitly authorizes mocked proof. Screenshots must identify that condition.

## Shared source boundary

When the product and proof surface can share components, they must use the same design-system and source implementation. Do not fork a page body for a better screenshot. A design lab may host proof, but it is not a substitute product.

## Screenshot review

Inspect the rendered result and answer these questions:

- Can a user identify the primary job within three seconds?
- Is one information or action path dominant?
- Did nested cards or boxes create unnecessary hierarchy?
- Did a workflow screen turn into a dashboard without a product reason?
- Are metrics, badges, or analytics panels backed by product truth?
- Is any developer or internal copy visible to users?
- Does prose repeat what the layout already communicates?
- Are borders, shadows, radii, padding, or gutters louder than the content?
- Does every container and sentence serve the user's job?
- Is there clipping, overflow, low contrast, broken focus, missing semantics, or unfinished UI?

Any failed answer is a defect. Fix it, or report the exact blocker and the affected screenshot.

## Design boundaries

- Avoid nested cards and card-inside-card hierarchy.
- Avoid dashboard layouts unless metrics are the user's actual job.
- Keep UUIDs, API paths, enum values, database terms, debug text, fixture names, stack traces, endpoint names, raw booleans, and implementation notes out of user-facing UI.
- Remove marketing filler, repeated helper text, and explanations of obvious layout.
- Show the product's true state. Do not invent a more attractive one for proof.
- Finish the target viewport or device to production quality.

## Completion evidence

Report design work in this order:

1. primary user job
2. what changed
3. how visual hierarchy supports the job
4. copy changes
5. screenshot and runtime evidence
6. remaining risks or blocked states

The evidence must connect each screenshot to its viewport or device and tested flow. A screenshot of an unrelated shell, a static mock, or an unexercised happy path does not prove the requested product state.
