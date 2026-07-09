---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
last_updated: 2026-07-09
---

# Decisions

## Decision Log

### Validation reason codes are explicit data, not message parsing
**Date:** 2026-07-09
**Status:** Active
**Decision:** Failure-log reason mapping uses `ValidationError.reasonCode` when present and otherwise reports `unknown_validation_error`; it does not inspect validation message text to derive semantic codes.
**Reasoning:** Message parsing made public telemetry depend on prose that can drift independently from caller contracts. Typed reason ownership belongs at the validation throw site, where the author knows the semantic failure.
**Alternatives considered:** Keep the message fallback as defense in depth (rejected because it silently hides missing structured codes), or centralize message strings and codes together (rejected because it still couples telemetry to copy).
**Consequences:** New semantic validation paths must pass an explicit reason code. Tests should assert both explicit-code preservation and unknown fallback for uncoded validation errors.

### Legacy tool_profile is input-only compatibility
**Date:** 2026-07-09
**Status:** Active
**Decision:** The public request schema still accepts known `tool_profile` values, but validation discards the field and runtime/result/session/failure surfaces no longer carry `toolProfile` or `resolved_tool_profile`.
**Reasoning:** All registered child tools are active, so carrying a resolved profile implied a policy switch that no longer exists. Keeping the input avoids breaking old callers while removing false downstream contract surface.
**Alternatives considered:** Remove the input immediately (rejected as unnecessary caller breakage), keep returning `resolved_tool_profile:"all"` (rejected because it preserves misleading public state), or implement real profiles again (rejected because current child tooling depends on all registered tools being active).
**Consequences:** Child request files omit profile state; failure logs omit profile state; README documents validation-and-ignore behavior; tests prove legacy input acceptance and downstream absence.

### Session failures preserve durable caller context
**Date:** 2026-07-08
**Status:** Active
**Decision:** Terminal failures from durable session tasks log the public entrypoint that created the run, the durable `run_id`, and `task_kind:"session"`; `get_run_contract` exposes session start tools under `tools.session_start` without changing the existing run-only `tools.start` tuple.
**Reasoning:** Session tools create normal durable run-task snapshots, so callers and operators need failure telemetry and adapter contract discovery to line up with the `run_id` they receive from `start_session_run` or `run_subagent_session`. Misattributing async session packet failures to the compatibility wrapper made telemetry ambiguous.
**Alternatives considered:** Only document the caveat (rejected because correlation stayed broken), only add `run_id` to failure records (rejected because the public tool was still wrong), or mutate `tools.start` to include session tools (rejected because adapters may already depend on the existing tuple).
**Consequences:** Observed `full-current` includes `start_session_run` packet-failure telemetry correlation; failure-log tests assert `tool`, `run_id`, and `task_kind` for session packet failures.

### Final-mode success requires a captured final message
**Date:** 2026-07-08
**Status:** Active
**Decision:** Runs that request `output_mode:"final"` fail with `reason_code:"missing_final_output"` when the child process exits cleanly but no final message artifact is captured.
**Reasoning:** A clean process exit only proves the child stopped. It does not prove the caller received the verdict they asked for, and treating a progress transcript as success made unattended campaign episodes look healthy after a child stalled before finalization.
**Alternatives considered:** Add a designer-in-chief-specific smoke check (rejected because the failure is a generic final-output contract breach), keep falling back to transcript success (rejected because it hides missing verdicts), or infer success from side effects/artifacts (rejected because the public contract is the requested output mode).
**Consequences:** Public run results, named-session projections, and failure logs use `missing_final_output`; transcript fallback remains diagnostic output for failures/timeouts/cancellations, not a substitute success path for requested final output.

### Named-session manifest eligibility preflights before durable task registration
**Date:** 2026-07-04
**Status:** Active
**Decision:** Session tools reject deterministic manifest eligibility failures before creating a durable run task when the failure is knowable without launching a child, for example `resume_mode:"require_existing"` with no matching session.
**Reasoning:** These failures are front-door caller errors, not child execution outcomes. Returning a `run_id` and requiring polling was ambiguous because no child started, yet callers could not see `child_started:false`.
**Alternatives considered:** Leave missing sessions as background terminal failures (rejected as caller-hostile), or move all session locking/reconciliation into preflight (rejected because the locked execution path must remain the race authority and preflight should stay read-only).
**Consequences:** Such failures return `kind:"preflight_rejected"`, `child_started:false`, and a typed `reason_code`, and they log one validation failure. The locked session path still repeats checks to handle races and stale state.

### Operation semantic rejections are not preflight rejections
**Date:** 2026-07-01
**Status:** Active
**Decision:** `get_run`, `answer_run_input`, and `cancel_run` ValidationErrors return structured `kind:"operation_rejected"` results with typed `reason_code`; child-invocation validation keeps `kind:"preflight_rejected"` and `child_started:false`.
**Reasoning:** Operation tools often refer to runs that already launched, so reusing `preflight_rejected` would make the child-start claim ambiguous or false. A separate structured rejection keeps caller adapters from parsing MCP text while preserving the exact preflight invariant.
**Alternatives considered:** Leave operation errors as MCP text errors (rejected because callers had to infer reason codes), reuse `preflight_rejected` for all semantic errors (rejected because `child_started:false` is not meaningful for operations), and replace the whole error envelope (rejected as broader than the observed failure).
**Consequences:** Observed campaign probes must require `operation_rejected` for run-operation semantic failures, not text-derived reason-code fallback.

### Required packet failures distinguish not-ready from invalid
**Date:** 2026-07-01
**Status:** Active
**Decision:** Required session packets use `packet_required_not_ready` for parse-valid packets whose verdict/blockers do not satisfy the required policy; malformed packets continue using `packet_required_invalid`, and missing packets use `packet_required_missing`.
**Reasoning:** A valid packet that honestly says "not ready" is different from a malformed packet. Callers need this distinction to decide whether to repair packet shape or continue task work.
**Alternatives considered:** Keep `packet_required_invalid` for all unsatisfied packets (rejected as caller-hostile taxonomy collapse), or add a new packet object state machine (rejected as unnecessary for the observed ambiguity).
**Consequences:** Failure logs, terminal metadata, README, and observed-campaign result matching must stay synchronized with all three packet reason codes.

### Local capacity exhaustion rejects instead of queues
**Date:** 2026-06-30
**Status:** Active
**Decision:** `SUBAGENT007_MAX_ACTIVE_CHILDREN` is an opt-in local launch fuse that rejects before child launch with `local_capacity_exhausted`; it does not queue.
**Reasoning:** The real risk is uncontrolled concurrent child processes on one machine. Queueing would add ordering, durability, cancellation, and fairness semantics that are not needed for a local guard.
**Alternatives considered:** Always-on capacity management (rejected because default behavior should stay unchanged), queueing (rejected as extra semantics), no local fuse (rejected because orphaned/overlapping child work was already a practical risk).
**Consequences:** Callers must retry after active work completes or raise the configured ceiling; tests must preserve `child_started:false` for this rejection.

### Public model input is model_class, not concrete model ids
**Date:** 2026-06-25
**Status:** Active
**Decision:** Callers choose capability classes `A` through `E`; concrete model ids and thinking levels remain internal calibration.
**Reasoning:** Model/provider inventory changes independently of the public API, and class names keep callers from depending on volatile concrete ids.
**Alternatives considered:** Public `model` and `thinking_level` inputs (rejected because they leak calibration and make migrations harder).
**Consequences:** Config migration, model reconciliation, and model-health probing must preserve the class abstraction. Public MCP results, failure logs, session ledgers, observed-campaign summaries, and README should expose model classes and class-level health/migration actions, not concrete model IDs or thinking-level calibration values.

### Durable run snapshots are local filesystem state
**Date:** 2026-06-24
**Status:** Active
**Decision:** Run tasks, input mailbox records, session state, failure logs, and active-child leases use local filesystem paths under the state root.
**Reasoning:** This server is local/private and needs inspectable, restart-tolerant state without operating a database or service.
**Alternatives considered:** Database-backed state or remote worker queues (rejected as operationally heavier than this local MCP boundary needs).
**Consequences:** Runtime readiness and tests must account for local build/source state; restart drift fails closed instead of trying to reattach to unknown old child processes.

### Public event views are sanitized projections
**Date:** 2026-06-24
**Status:** Active
**Decision:** Public run views and transcript-rendered artifacts expose bounded, sanitized progress rather than raw thinking, private tool payloads, answer values, or full composed prompts.
**Reasoning:** Run state must be useful for polling/debugging without leaking private reasoning or sensitive caller input.
**Alternatives considered:** Storing raw child streams directly in public events (rejected because it would conflate auditability with disclosure).
**Consequences:** Changes to transcript, event, and failure-log code need tests for what is omitted as well as what is included.
