---
name: counterfactual-engineering
description: Apply a coding version of the scientific method when first-answer bias could produce a superficial or inferior result. Use for competing architectures, major refactors, performance work, UI/product alternatives, migrations, risky changes, and bug diagnosis or repair when the cause or durable fix is uncertain, multiple causal paths fit the evidence, recurrence or systemic risk matters, or an earlier fix failed review. Skip only when reproduction and evidence isolate one straightforward mechanical correction.
---

# Counterfactual Engineering

Use this skill when more than one cause or implementation route fits the evidence and choosing the first plausible answer would be risky. It is for engineers investigating uncertain bugs, architecture choices, migrations, performance work, major refactors, or product alternatives.

The output is a selected or synthesized result backed by comparable experiments. Skip this process only when a deterministic reproduction and local evidence isolate one mechanical correction.

## Experiment contract

Give every serious hypothesis the same success criteria and a complete causal loop. Record:

- the proposed mechanism or implementation route
- the evidence it explains
- the observation that would falsify it
- the smallest distinguishing experiment
- the regression oracle used for every candidate

Two renamed versions of the same approach are not competing hypotheses. Compare routes that differ in cause, boundary, architecture, or mechanism.

## Workflow

1. **Observe:** reproduce the current behavior and capture a stable success or failure oracle.
2. **Frame:** define success, constraints, shared validation, and excluded scope.
3. **Research:** inspect local patterns, prior art, dependency capabilities, and existing abstractions.
4. **Hypothesize:** state two or three materially different causal models or implementation routes.
5. **Isolate:** assign one isolated workspace to each serious hypothesis. Start from the same committed checkpoint when results may later be composed.
6. **Experiment:** run a complete reproduce, investigate, implement, and validate loop for each hypothesis.
7. **Compare:** apply the same tests, screenshots, benchmarks, or reproduction oracle to every result.
8. **Select or synthesize:** accept the strongest result, combine independently justified changes, or reject every candidate.
9. **Integrate:** apply selected changes sequentially and validate each addition plus the aggregate.
10. **Report or commit:** leave a clean result with the evidence, rejected paths, and remaining risks.

## Isolation backends

Choose one backend per hypothesis unless a concrete constraint requires both.

### Git worktree

Use a worktree for host-native or repository-only experiments where Docker adds no useful isolation. Create `{REPO_ROOT}/.worktrees/<short-hypothesis-slug>` and name the branch for the hypothesis, such as `codex/cache-boundary`.

### Container lab

Use a container lab when the repository has a reviewed `.codex-container-lab.yaml` and Linux, Docker, Compose services, databases, or environmental isolation affect the result. Follow the `codex-container-lab` skill, create one lab per hypothesis, and use its synchronization or Git patch workflow to extract selected work. The lab's isolated Git workspace replaces a routine worktree for that hypothesis.

Isolation must include mutable dependencies. Shared databases, caches, queues, host-bound volumes, fixed services, and reused credentials can contaminate results even when source trees are separate.

Keep experiments small enough to validate. Remove rejected worktrees or labs unless the user or repository instructions require preservation.

## Investigation and ownership

Triage should return a compact hypothesis set, not only the most likely explanation. Use independent workers when parallel experiments save time or reduce anchoring. Otherwise, one worker may own several isolated experiments.

Each worker owns its hypothesis from reproduction through evidence. The root selects and integrates the result, then uses QA and adversarial review on the integrated state. If review uncovers a materially different causal model, reopen hypothesis work instead of repeatedly patching the same route.

## Selection boundaries

Accept a result only when it satisfies the shared criteria better than its alternatives. Judge correctness, validation, maintainability, repository conventions, reversibility, and Git clarity.

Combine changes only when each has independent evidence or prevents a separate demonstrated failure. Confirm that one patch is not hiding the absence of another. After integration, rerun the original reproduction and all shared validation because individually sound patches can interact.

Stop for user or owner judgment when the evidence exposes a product, architecture, or risk tradeoff with several valid outcomes. Do not multiply experiments for a localized deterministic defect merely to satisfy the workflow.

## Evidence report

Use a comparison table:

```text
| Hypothesis | Approach | Validation | Result | Reason |
| --- | --- | --- | --- | --- |
| ... | ... | ... | Accepted/Rejected | ... |
```

Finish with:

```text
Selected:
Committed:
Rejected experiments:
Remaining risks:
```

If no hypothesis passes, report the failed observations and the next question or dependency needed for a useful experiment.
