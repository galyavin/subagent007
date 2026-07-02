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
last_updated: 2026-07-01
---

# Decisions

## Decision Log

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
**Consequences:** Config migration, model reconciliation, and model-health probing must preserve the class abstraction.

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
