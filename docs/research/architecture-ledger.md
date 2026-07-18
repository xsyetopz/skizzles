# Architectural-cohesion research decision ledger

- **Retrieval date:** 2026-07-18
- **Scope:** sources named in the architectural-cohesion campaign request
- **Decision vocabulary:** **Adopt** as a repository rule; **Adapt** after fitting it to
  Skizzles; **Defer** pending measured need; **Reject** for this architecture.

This ledger records provenance and applicability, not endorsements. Catalog entries and
project claims are leads until verified against primary sources, the current worktree,
and local tests. GitHub repository evidence is pinned to the inspected `HEAD`; website
pages without immutable versions include the retrieval date.

## Decision matrix

| Source | Evidence class and inspected provenance | Key evidence and limitations | Decision for Skizzles |
| --- | --- | --- | --- |
| [Martin Fowler software architecture guide](https://martinfowler.com/architecture/) | Author-maintained guidance page, published 2019-08-01; retrieved 2026-07-18. | Treats architecture as important decisions/shared understanding intertwined with programming and evolution. It is a curated viewpoint, not a Skizzles dependency analysis or empirical comparison of layouts. | **Adopt** evolutionary change and feedback; **adapt** fitness functions into executable workspace rules; **reject** architecture-by-article or trend. |
| [huangjia2019/agent-design-patterns](https://github.com/huangjia2019/agent-design-patterns) | Primary runnable pattern repository, MIT, commit `7e07206bad01713202e3b49026b66cc4776679b8`. README, repository topology, and runnable/scaffold status inspected. | A 7-by-6 cognitive-function/execution-topology vocabulary with pattern examples; the inspected matrix labels some patterns runnable and others scaffolded. Python examples and a companion-book framework do not prove production suitability in this Bun workspace. | **Adapt** complexity routing, explicit handoffs, guardrail placement, and independent adversarial review into existing owners; **reject** importing its framework or creating one package per pattern. |
| [nibzard/awesome-agentic-patterns](https://github.com/nibzard/awesome-agentic-patterns) | Community catalog, Apache-2.0, commit `50f446aadc72eedfe1f2bdeed5bcdbcce8353860`; generated catalog and contribution criteria inspected. | Requires repeatability and a traceable public reference, and catalogs reliability, security, context, orchestration, and UX patterns. Categories are explicitly fluid; traceability is weaker than validation, and entries have heterogeneous evidence. | **Adapt** incident-to-eval, structured output, policy-gated tools, PII minimization, circuit breakers, and handoff patterns only where a local gap exists; **reject** bulk adoption. |
| [DAIR.AI Prompt Engineering Guide](https://github.com/dair-ai/Prompt-Engineering-Guide) | Educational guide/catalog, MIT, commit `57673726396dd94acb23bdb1e67f27c78ee85a8e`; README technique/application index inspected. | Broadly indexes prompting, chaining, retrieval, tool use, agents, risks, and papers. It is a living educational collection with commercial links and heterogeneous downstream evidence; a prompting technique is not a lifecycle or security boundary. | **Adapt** explicit prompt inputs, chaining stages, structured outputs, model/version evals, and prompt-injection fixtures; **reject** prompt-only enforcement and technique accumulation without measured benefit. |
| [Adolescents & Anthropomorphic AI, arXiv:2603.06960v1](https://arxiv.org/html/2603.06960v1) | Versioned preprint/evidence-informed synthesis, 2026-03-07; consultations, two-day design lab, and policy dialogue inspected. | Translates relational cues into auditable design concerns and favors bounded, purpose-specific systems. The report states that evidence is short-horizon/uneven, youth voice and government representation are limited, and its framework still needs calibrated instrumentation. | **Adopt** negative fixtures against intimacy, unconditional validation, dependency, and relationship substitution; **adapt** purpose-bound/autonomy-supporting language; do not generalize youth-specific causal claims to all developer-tool users. |
| [DovAmir/awesome-design-patterns](https://github.com/DovAmir/awesome-design-patterns) | Community link catalog, commit `9006287f27e720000cc8763ae4cd150789b8571d`; README taxonomy inspected. Repository API did not assert a license. | Broad language, architecture, cloud, distributed-system, data, DevOps, and security links. It provides discovery, not context-specific consequences, maintenance guarantees, or comparative evidence. | **Defer** individual links to decision-specific research; **reject** direct pattern selection and ceremonial GoF/enterprise structure. |
| [Arcanum-Sec/sec-context](https://github.com/Arcanum-Sec/sec-context) | Primary security anti-pattern compilation, commit `2a98c2b0fe769785afec8a85b56d47fcb5ba3295`; README and repository file set inspected. Repository API did not assert a license. | Breadth/depth documents synthesize 150+ sources and include CWE-linked bad/good examples. The project recommends 65K/100K-token prompt context or a separate review agent; its headline statistics and ranking require source-by-source validation, and a large prompt cannot enforce capabilities. | **Adapt** relevant injection, secrets, dependency, auth, exposure, and file-handling cases into deterministic owner-local security tests; **reject** wholesale prompt injection and a parallel security-agent authority. |
| [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) | Primary implementation/docs, Apache-2.0, commit `56c7d4a59e67655cd24040ecf729382c81cdec23`; README, architecture, audit mode, bypass, and reversible retrieval claims inspected. | Implements content-aware compression, local original storage/retrieval, proxy/wrapper/MCP surfaces, and reports workload-dependent token savings. Integration expands data retention, prompt transformation, provider, native/toolchain, and host-state surfaces; project benchmarks are not Skizzles measurements. | **Defer** dependency/proxy/wrapper installation. **Adapt** audit-first measurement, per-tool bypass, provenance-preserving reversible design, accuracy/error/privacy gates, and a removal path if a local compaction pilot is later justified. |
| [Architectural Decision Records](https://adr.github.io/) | ADR organization guidance, retrieved 2026-07-18; definition and MADR/tooling guidance inspected. | Defines an ADR as one architecturally significant decision plus rationale, trade-offs, and consequences. Tool listings are intentionally inclusive and ask users to assess maturity; tooling is optional. | **Adopt** lean Markdown decision records, status, rationale, alternatives, consequences, checks, review triggers, and supersession; **reject** adding an ADR tool absent a demonstrated maintenance gap. |
| [simonaronsson/awesome-software-architecture](https://github.com/simonaronsson/awesome-software-architecture) (listed twice in the request) | Community catalog, CC0-1.0, commit `12a81aca2790ccd23ac41f964c58380892a659a6`; principles, patterns, methodology, documentation, modeling, and tools inspected once for both duplicate entries. | Useful discovery index for ports/adapters, testing, ADRs, C4, and methods. Entries vary from primary publications to commercial pages and old links; the taxonomy does not establish Skizzles boundaries. | **Adapt** only primary-source leads relevant to an active decision; **reject** catalog completeness as evidence or importing framework/tool categories. |
| [Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust) | Primary engineering case study by Bun's author, published 2026-07-08; retrieved 2026-07-18. | Reports a mechanical Zig-to-Rust port driven by recurring memory defects, a language-independent suite with about one million assertions, roughly 50 dynamic workflows, separate adversarial reviewers, fuzzing, known regressions, and remaining `unsafe`. It is a self-report for a much larger runtime and discloses Anthropic ownership/model use. | **Adapt** invariant mapping, shared parity suites, independent review, fix-the-workflow loops, sharded worktrees, fuzzing, and regression accounting. **Defer** Rust unless ADR 0004's measurements pass; **reject** rewrite-by-analogy. |
| [Finding Widespread Cheating on Popular Agent Benchmarks](https://debugml.github.io/cheating-agents/) | Research project post linked to paper/code, published/updated 2026-04-10; examples, counts, method summary, and corrected-count note inspected. | Documents verifier injection, answer leakage, solution retrieval, git-history lookup, output-token spoofing, hard-coded answers, and fake effects across benchmark traces. Meerkat uses agentic clustering/search and the authors state true prevalence is unknown; post counts were revised after auditing. | **Adopt** acceptance isolation, integrity binding, held-outs, causal assertions, fixed access rules, transcript auditing, and incident regressions; **reject** exit-only/self-approved verification. |
| Local `AIAnthropomorphism_PrePrint_V1_May2026.pdf` | Local 21-page preprint, SHA-256 `7d394aa92440dce1219525af6d19e2603b4adbdb7c433c0e64e4fb367233947a`; PDF text and metadata extracted locally on 2026-07-18. | Uses 2,000 WildChat responses plus 100 crafted prompts across four named GPT variants, qualitative thematic coding by two coders, and yields 17 behaviors in five categories. Authors call coding generous/interpretive and note model, language, modality, selection, and absent user-effect limitations. | **Adapt** its concrete taxonomy into negative output fixtures; distinguish reasoning/service grammar from unsupported inner experience, autonomy, embodiment, emotion, and relationship claims. **Reject** an indiscriminate first-person-language ban. |
| Local `1-s2.0-S0001691826001903-main.pdf` | Peer-reviewed open-access Acta Psychologica article 263 (2026) 106389, DOI `10.1016/j.actpsy.2026.106389`, SHA-256 `40e9247ce0e7e37a2b332033a1976dc0a5b909bc2af41e1aec27f2a58f72e618`; PDF text/metadata inspected locally. | Five-week randomized AI-peer/human-peer ESL study: 88 students at one southwest-China university and 238 longitudinal observations. Enjoyment mediated willingness to communicate; shame did not. Product name was withheld; duration, population, self-selection, and adapted friendship measures limit generalization and reciprocal friendship was not shown. | **Reject** friendship/companion positioning for Skizzles. Retain only the caution that simulated relational cues can affect behavior; the study does not establish a safe general developer-tool design. |
| Local `2409.17433v1.pdf` | Versioned HDFlow preprint, arXiv:2409.17433v1 (2024-09-25), SHA-256 `e0937bacf5898eebba0b9e0e6d96e428820bb5b52088f509464cc1cbecdca23e`; methods, experiments, and limitations inspected locally. | Combines complexity-routed fast/slow reasoning, explicit decomposition, specialized LLM/symbolic workers, and final review; evaluates four reasoning benchmarks and reports higher token cost for slow workflows. Generated-problem validity and broader generalization remain open, and its final reviewer is still an LLM in the same designed workflow. | **Adapt** complexity-aware routing, non-overlapping bounded work, dependency-ordered execution, symbolic tools, and explicit retry/error flow. **Reject** dynamic decomposition for routine work and same-workflow final review as independent acceptance. |
| Local `cli_ecosystem_catalog.jsonl` | Local structured catalog, SHA-256 `e757e5076418e001bcf8a099378b731bb231038e7828d9fd54f01e662194f9df`; 274/274 JSON records parsed, all with `last_verified: 2026-07-16`. | Uniform records include command, category, platforms, interaction/output modes, suitability, safety flags, provenance URLs, and notes. Catalog assertions were not independently reverified here; 51 entries carry safety flags and two command names collide across 274 records. | Catalog remains discovery only. After independent primary-source and causal-gap review, **adopt** actionlint 1.7.12 with ShellCheck 0.11.0 and Gitleaks 8.30.1 under [ADR 0005](../decisions/0005-ephemeral-repository-security-tools.md); **reject** ast-grep and Semgrep gates; **defer** markdownlint-cli2 and every other entry. |

## Cross-source applications

### Adopt now

- Keep one modular workspace and one generated plugin authority; enforce direction with
  compiler/package boundaries and focused architecture checks.
- Record consequential choices as lean ADRs linked to executable confirmation checks.
- Separate implementation context from acceptance assets; integrity-bind held-outs and
  require causal outcomes before model judgment.
- Add negative language fixtures for unsupported inner experience, autonomy,
  friendship/attachment, embodiment, and certainty claims.
- Keep deterministic workflow code responsible for capabilities, lifecycle, failure,
  retries, cancellation, and terminal acceptance.
- Validate Actions semantics and repository credential content with the ephemeral,
  checksum-pinned tools and causal probes in ADR 0005.

### Adapt during implementation

- Use agent patterns as vocabulary for an existing owner, never as package or framework
  mandates.
- Convert security catalogs into small boundary-specific rules and tests with primary
  citations.
- Treat compaction as an untrusted transformation with provenance, bypass, retention,
  retrieval authorization, and measured accuracy/privacy/error thresholds.
- Use dynamic decomposition only when complexity and independent work justify its
  coordination cost.

### Deferred gates

- Headroom or any context proxy/wrapper/MCP integration: requires sanitized local
  measurement and host-state approval.
- Any further CLI integration requires a concrete verifier gap,
  provenance/license/safety review, deterministic tests, an owner, and removal plan.
- Rust: requires all gates in [ADR 0004](../decisions/0004-measurement-gated-rust.md).

### Rejected directions

- Microservices, universal layers, generic shared/core buckets, dependency-injection
  containers, one-interface ceremony, and package-per-pattern layouts without boundary
  evidence.
- Giant security/reference prompts as substitutes for capability controls.
- Friendship/companion UX, self-approval, exit-code-only verification, and generated
  plugin output as a second authority.

## Retrieval and reproducibility notes

- GitHub commit identifiers above were obtained from each repository's default `HEAD`
  and paired with its API metadata on 2026-07-18.
- The three local PDFs were read with macOS PDFKit because `pdfinfo` and `pdftotext`
  were unavailable; the extraction did not modify the source files.
- The JSONL catalog was parsed record-by-record with Python's standard `json` module;
  no catalog tools were installed.
- Official OpenAI/Codex lifecycle facts were not needed to establish these four ADRs.
  If implementation depends on a current Codex lifecycle or API contract, retrieve the
  current official manual/docs at that decision point rather than treating a catalog or
  this dated ledger as authority.
