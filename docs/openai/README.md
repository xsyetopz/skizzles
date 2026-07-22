# OpenAI integration notes

These notes explain the OpenAI API features used or referenced by this
workspace. They preserve the technical claims and source links captured here;
model availability, beta APIs, pricing, and retention details can change.
Confirm the linked OpenAI documentation before making a production decision.

Read [Using GPT-5.6](model-guidance.md) first for model selection, migration,
and prompting. Then choose the guide that matches the workflow:

- [Reasoning models](reasoning-models.md): reasoning effort and mode, context, continuations, summaries, and assistant phases.
- [Prompt caching](prompt-caching.md): repeated prompt prefixes, cache keys, breakpoints, retention, and cache usage.
- [Programmatic tool calling](tool-calling.md): model-generated JavaScript for bounded, predictable tool stages.
- [Multi-agent](multi-agent.md): beta root-and-subagent orchestration for independent parallel tasks.
- [Safety](safety.md): production safety controls, moderation, identifiers, and key handling.

A typical reading path is model selection, reasoning state, then safety. Add
prompt caching when the application repeats large prefixes. Choose Programmatic
Tool Calling for predictable tool pipelines, or Multi-agent when a root agent
can delegate independent workstreams. Both approaches still need explicit
authorization and application-side permission checks.
