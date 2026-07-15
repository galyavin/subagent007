---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-07-15
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State
**Working:**
- Durable runs expose one version-2 acknowledged-input contract: every answer has a response ID, a receipt is created only after the child waiter accepts that response, exact live retries replay safely, and raw answer text remains only on the private live control path/Pi context.
- MCP public tools expose one-shot, durable run, scheduler, named-session, mailbox, contract, readiness, and model-class surfaces.
- Durable runs persist snapshots and public event ledgers, support cancellation and caller input, and fail closed on restart drift.
- Terminal runs compact bounded public events and settled input views into the authoritative snapshot before removing redundant event-ledger/mailbox files and evicting terminal in-memory state; dead-owner snapshot temps recover successor-first. Named-session attempt workspaces are removed after promotion or failure telemetry is durable.
- Child output streams directly into complete sanitized public transcripts with backpressure; no normal raw process-output spool exists. A 5 GiB default disk reserve, 24-child execution ceiling, and bounded metadata-only top-level admission queue protect the host while retaining burst demand; owner-based reconciliation removes only provably abandoned runtime artifacts.
- Builds publish versioned releases through an atomic `dist/current` switch; stable entrypoints remain available and live server release leases prevent cleanup races.
- Model classes, config migration, model-health probes, observed campaign/probe tooling, and bounded raw failure telemetry with retained compact archive summaries are implemented.
- Internal model-class calibration uses the current Pi registry, and the bundled Pi coding-agent dependency is kept new enough to resolve every calibrated class model during child execution.
- Observed campaign tool-listing asserts the exact 12-tool public MCP surface and `skill_name` vs legacy `skill` schema guidance instead of treating `listTools()` as liveness-only.
- Observed campaign coverage is keyed by caller-visible `surfaces` and `result_classes`; retired descriptive `lifecycle_phases` metadata is not part of the coverage contract.
- Observed `full-current` coverage includes single- and two-hop recursive delegate lineage, depth-limit rejection both before launch and after one valid hop, forged-lineage rejection, and private recursive-control leakage checks.
- Observed `full-current` coverage also includes missing-final-output classification, named-session resume and `require_existing` missing-session preflight, `start_session_run` packet-failure telemetry correlation, local queue/cancellation/overflow/promotion/release, exact input retry receipts, and local active-child capacity exhaustion/release.
- Public run views and transcript provenance render a redacted caller-prompt marker instead of raw caller prompt text; observed campaign redaction checks include prompt sentinels in public artifacts/state.
- Public MCP result projection omits backend Pi session IDs and internal input-mailbox paths; callers use `run_id`/`request_id` for input operations. Named-session child launch forwards the standard spawn callback, so `child_started` agrees with lifecycle events.
- Public `get_run` and `cancel_run` descriptions make cancellation eligibility explicit: `working`/`running_silent`, elapsed silence, live heartbeats, and recursive child activity are not staleness or cancellation authority; only explicit user intent or a real caller-owned stop condition is.
- Public MCP result/list/session surfaces, failure logs, and README expose model classes and health/migration guidance without concrete model IDs or thinking-level calibration values; observed campaign result matching asserts absence of forbidden calibration fields and thinking-level field-name variants.
- Session terminal failure telemetry preserves the caller-facing durable context: packet failures from `start_session_run` and `run_subagent_session` log the correct public tool, durable `run_id`, and `task_kind:"session"`.
- The durable-run contract exposes session start tools under `tools.session_start`, while preserving the existing `tools.start` tuple for run-only adapters.
- Skill binding normalization and schema descriptions are centralized in `src/skillBinding.ts`; prompt-level skill invocation syntax is rejected unless the caller binds `skill_name`/legacy `skill`.
- Failure reason codes and handler-level preflight retry guidance come from explicit `ValidationError.reasonCode`; neither failure logging nor guidance infers semantics from message text.
- SAF repairs are in place for provider usage-limit metadata, parent-exit child-process cleanup, finite-by-default active-child launch fusing, structured run-operation semantic rejections, packet-required not-ready taxonomy, public prompt projection, and named-session manifest preflight eligibility.
- Requested `final` output is a hard contract: a clean child exit without a captured final message fails as `missing_final_output` and writes the public transcript only as diagnostic output.
- Server-launched children receive a native `delegate` tool backed by private parent-owned recursive control IPC; recursive descendants are normal durable runs with `parent_run_id`, `root_run_id`, `recursion_depth`, and direct `child_run_ids` in run views.
- Parent run views now also project recursive child lifecycle through sanitized `recursive_child_started` and `recursive_child_finished` public events, including child run id, lineage, terminal status, and success metadata without private recursive-control payloads.
- README runtime facts are checked against source with `npm run docs:check`; full source/test verification is `npm test`.

**Not Built:**
- Admission queueing is limited to top-level `start_run` and `schedule_run`; one-shot, named-session, and recursive launches remain fail-fast at capacity.
- There is no database or remote job manager; state is local filesystem-backed.
- Tool profiles are compatibility inputs only: legacy values are validated, then ignored, and no runtime/result/session/failure surface carries resolved profile state.
- Recursive delegation currently provides one child-facing `delegate` tool and direct lineage metadata only; full descendant-tree management and cascade cancel are not built.

**Known Issues:**
- Local focused test commands that bypass `npm test` do not rebuild `dist/`; run `npm run build` first after source edits.
- Project memory is committed under `.mex/`; keep `mex check` and `mex sync` green when updating it.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create a compact project-specific guide in `patterns/`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` or `mex log "<note>"`.
