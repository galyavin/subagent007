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
last_updated: 2026-06-30
---

# Decisions

## Decision Log

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
