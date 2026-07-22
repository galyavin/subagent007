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
last_updated: 2026-07-22
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State
**Working:**
- Opt-in `effect_profile:"workspace_read_only"` constructs Pi with exactly seven read/input/web tools, disables ambient extension discovery and recursive delegation, requires a validated pre-prompt activation receipt, and preserves omitted/legacy `tool_profile` behavior. Neutral `task_root_authoring_v1` exposes only ordered `read`,`write`, requires canonical exact new `allowed_output_paths`, captures the bounded initial task tree as immutable, and permits no undeclared terminal entry; historical `skill_creator_authoring_v1` retains its exact six-tool ceiling. `effect_profile:"researcher_bounded_v1"` and `effect_profile:"assumption_audit_bounded_v1"` retain their six filesystem tools plus web and one fixed `execFile` controller, but every direct/controller mutation is confined to one fresh profile-owned `.subagent007/<profile>` subtree while the initial outside tree stays immutable. Parent/child bind the exact scope in activation receipt v2; all settled child outcomes receive terminal tree/snapshot reinspection. Sparse, oversized, multi-link, symlinked, and special immutable or writable entries fail closed under separate input/output bounds. The enforcement ceiling is Pi tool dispatch/path/controller/terminal observation, not an OS sandbox. All five exclude recursive delegation; bounded profiles support only ephemeral/fresh; named-session schemas reject every effect profile.
- Optional `expected_skill_sha256` on run start surfaces pins canonical `skill_name` content before launch. Pi reads a run-owned read-only snapshot of the verified bytes, and the activation receipt preserves the canonical source path/name/SHA-256.
- Public `verify_skill_bindings` contract version 1 validates a canonical batch of 1–64 name/digest pairs against the launch resolver without model, child, durable state, caches, temporary artifacts, or failure telemetry. Its all-or-nothing point-in-time response binds the complete cwd/request set by count and canonical SHA-256; launch still rechecks for drift.
- Public `resolve_skill_bindings` contract version 1 resolves a canonical batch of 1–64 strictly sorted skill names through the same catalog/read/hash authority. It returns one request-bound all-or-nothing name/path/SHA set without model, child, runtime-readiness dependency, or operational writes; launch still rechecks.
- Canonical complete runtime-bundle digesting covers the exact admitted primary skill instructions, root `license.txt`, scripts, references, assets, templates, and agent metadata. `validate_skill_runtime_bundle` applies it to an exact staging or canonical-source root without catalog lookup; `resolve_skill_runtime_bundles` applies it through one canonical catalog resolution.
- `publish_skill_snapshots` internally materializes immutable content-addressed complete bundles and retained project references. `resolve_retained_skill_snapshot_source` publicly resolves one exact active/closed retained snapshot to its owner-controlled runtime source with no caller-selected path, copy, staging, lock, or state mutation. It is point-in-time source evidence; consumers copy and revalidate under their own transaction. The former caller-path rollback staging operation is retired.
- `skill_snapshot_binding` launches ephemeral, fresh, and raw-resume workers from the recorded snapshot. Parent preflight and Pi child both revalidate before prompt; named sessions reject the binding, and recursive descendants inherit the confirmed binding without widening.
- Durable-run contract v3 preserves the acknowledged-input behavior and v2 launch behavior when `client_start_id` is omitted. Before the authoritative client-key claim, `start_run` fsyncs only a private non-addressable `.prepared` candidate; after the claim, winner or replay atomically promotes it to the canonical run snapshot. Concurrent promotion joins re-resolve the authoritative key/request digest and accept the exact canonical run in its current valid lifecycle, so live-owner replay remains prompt even after child start or terminalization. One shared validator guards current-v3 snapshot publication/readback and replay joins, including typed process-zero contract failures; historical v2 readback remains unchanged. Its owner-terminal path derives declaration-only, observed, and settled phases from existing evidence: pre-child request declarations stay truthful without fabricated receipts, post-prompt observations reuse the exact activation/snapshot/recursive validators, and exactly one matching final settlement event closes the run. Losing/pre-binding candidates are not public runs, changed bodies reject, and post-binding owner loss resolves to the same terminal restart drift without reattachment.
- A cancellation accepted before child launch is always persisted through the existing owner-cancellation envelope: any tentative cancelled process result is discarded before terminal event/snapshot publication. Child-started cancellation remains process-owned.
- MCP public tools expose one-shot, durable run, scheduler, named-session, mailbox, contract, readiness, and model-class surfaces.
- Durable runs persist snapshots and public event ledgers, support cancellation and caller input, and fail closed on restart drift.
- Terminal runs compact bounded public events and settled input views into the authoritative snapshot before removing redundant event-ledger/mailbox files. A server-local task retains only hashed accepted-input identity while needed for exact live retry; process loss still fails closed. Other terminal in-memory state evicts after confirmed capacity release; dead-owner snapshot temps recover successor-first. Named-session attempt workspaces are removed after promotion or failure telemetry is durable.
- Child output streams directly into complete sanitized public transcripts with backpressure; no normal raw process-output spool exists. A 5 GiB default disk reserve, 24-child execution ceiling, and bounded metadata-only top-level admission queue protect the host while retaining burst demand; owner-based reconciliation removes only provably abandoned runtime artifacts.
- Builds publish versioned releases through an atomic `dist/current` switch; stable entrypoints remain available and live server release leases prevent cleanup races. Runtime readiness reports the lease-owned loaded release and current release identities, and fails closed with `loaded_release_mismatch` / `loaded_release_not_current` when a live versioned process is older than `dist/current`.
- Model classes, config migration, model-health probes, observed campaign/probe tooling, and bounded raw failure telemetry with retained compact archive summaries are implemented.
- Model classes A-E remain the primary capability tiers; external expert classes Z1-Z3 are available as separate maximum-difficulty OpenRouter-backed choices.
- Internal model-class calibration uses the current Pi registry; each calibrated model has either a native registry definition or an explicit, source-verified runtime transport fallback for child execution.
- Observed campaign tool-listing asserts the exact 21-tool public MCP surface and `skill_name` vs legacy `skill` schema guidance instead of treating `listTools()` as liveness-only.
- Observed campaign coverage is keyed by caller-visible `surfaces` and `result_classes`; retired descriptive `lifecycle_phases` metadata is not part of the coverage contract.
- Observed `full-current` coverage includes single- and two-hop recursive delegate lineage, depth-limit rejection both before launch and after one valid hop, forged-lineage rejection, and private recursive-control leakage checks.
- Observed `full-current` coverage also includes missing-final-output classification, named-session resume and `require_existing` missing-session preflight, `start_session_run` packet-failure telemetry correlation, local queue/cancellation/overflow/promotion/release, exact input retry receipts, and local active-child capacity exhaustion/release.
- Public run views and transcript provenance render a redacted caller-prompt marker instead of raw caller prompt text; observed campaign redaction checks include prompt sentinels in public artifacts/state.
- Public MCP result projection omits backend Pi session IDs and internal input-mailbox paths; callers use `run_id`/`request_id` for input operations. Named-session child launch forwards the standard spawn callback, so `child_started` agrees with lifecycle events.
- Public `get_run` and `cancel_run` descriptions make cancellation eligibility explicit: `working`/`running_silent`, elapsed silence, live heartbeats, and recursive child activity are not staleness or cancellation authority; only explicit user intent or a real caller-owned stop condition is.
- Public MCP result/list/session surfaces, failure logs, and README expose model classes and health/migration guidance without concrete model IDs or thinking-level calibration values; observed campaign result matching asserts absence of forbidden calibration fields and thinking-level field-name variants.
- Session terminal failure telemetry preserves the caller-facing durable context: packet failures from `start_session_run` and `run_subagent_session` log the correct public tool, durable `run_id`, and `task_kind:"session"`.
- The durable-run contract exposes session start tools under `tools.session_start`, while preserving the existing `tools.start` tuple for run-only adapters.
- Skill binding normalization and schema descriptions are centralized in `src/skillBinding.ts`; canonical catalog resolution remains in `src/skillResources.ts`, and `src/skillVerification.ts` owns the shared read/hash/compare primitive used by batch verification and launch.
- Failure reason codes and handler-level preflight retry guidance come from explicit `ValidationError.reasonCode`; neither failure logging nor guidance infers semantics from message text.
- Named-session locks transfer only after definite local owner death, while successful candidate promotion is recovered through a hash-verified pending commit before its attempt workspace is removed. Active-child leases bind new files to both run and owner; unreadable legacy leases retain capacity but return `run_liveness_unknown` instead of triggering restart drift.
- SAF repairs are in place for provider usage-limit metadata, parent-exit child-process cleanup, finite-by-default active-child launch fusing, structured run-operation semantic rejections, packet-required not-ready taxonomy, public prompt projection, and named-session manifest preflight eligibility.
- Requested `final` output is a hard contract: a clean child exit without a captured final message fails as `missing_final_output` and writes the public transcript only as diagnostic output.
- Recursive delegation is explicitly authorized by `recursive_delegation`; omission is disabled, raw resume requires reauthorization, named sessions reject it, and `workspace_read_only` conflicts with enablement. A pre-prompt receipt proves whether `delegate` is active. Enabled authority is inherited only inside the depth-bounded subtree.
- Root/ancestor run views project ordered `descendant_run_ids`, exact `descendant_terminal_statuses`, and sanitized child lifecycle events. Parent terminal publication waits for all direct children (which recursively wait for theirs) to settle.
- README runtime facts are checked against source with `npm run docs:check`; full source/test verification is `npm test`.

**Not Built:**
- Admission queueing is limited to top-level `start_run` and `schedule_run`; one-shot, named-session, and recursive launches remain fail-fast at capacity.
- There is no database or remote job manager; state is local filesystem-backed.
- Named-session effect profiles or snapshot bindings are not built; named-session tools reject `effect_profile`, `expected_skill_sha256`, and `skill_snapshot_binding`.
- Effect profiles are Pi callable-tool ceilings, not OS sandboxes or hostile-runtime containment boundaries. `skill_creator_authoring_v1` additionally enforces dispatched filesystem paths beneath the exact run cwd.
- Recursive delegation currently provides one child-facing `delegate` tool and direct lineage metadata only; full descendant-tree management and cascade cancel are not built.
- A general Researcher shell profile is intentionally not built in this slice: Researcher/AJ receive only their exact controller-owned capabilities, not ambient shell authority.

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
