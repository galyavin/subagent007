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
last_updated: 2026-07-14
---

# Decisions

## Decision Log

### Complete public transcripts replace raw child spools
**Date:** 2026-07-12
**Status:** Active
**Decision:** Child output is parsed incrementally and written directly to one sanitized public transcript staging file. Canonical transcript files have no per-artifact byte cap; bounded MCP events and excerpts remain separate projections. A protected free-space reserve stops a run cleanly before host exhaustion instead of silently truncating its transcript.
**Reasoning:** The former 256 KiB render cap discarded useful output but did not constrain the unbounded private `combined-output.log` files that exhausted the disk. Removing the redundant raw spool eliminates the dangerous accumulation path and makes backpressure, publication, and cleanup share one observable owner.
**Consequences:** Resource exhaustion is a typed `resource_exhausted` / `disk_reserve_exhausted` failure across run results, sessions, and failure telemetry. Canonical transcripts are durable outputs, not default retention targets. Public partial transcript files are named by run ownership; recovery converges on the same referenced output whether interruption occurs before or after the atomic `.partial` to `.md` rename.

### Build publication keeps runnable entrypoints continuously available
**Date:** 2026-07-12
**Status:** Active
**Decision:** Builds compile into versioned release directories, atomically switch `dist/current`, and keep stable launcher files present. Live server processes lease their release; cleanup removes only inactive unleased releases while retaining the current and immediately previous release.
**Reasoning:** Deleting shared `dist/` before compilation created a caller-visible window where server and child entrypoints did not exist. Versioned publication separates compilation failure from runtime availability and gives release cleanup an observable owner.
**Consequences:** `npm run clean:dist` prunes inactive releases instead of deleting live entrypoints. Runtime code locates the project root independently of its versioned release depth.

### Terminal snapshots own compacted durable run state
**Date:** 2026-07-12
**Status:** Active
**Decision:** Active runs keep append-only public event ledgers and input mailbox files. After terminal input settlement and terminal event projection, the atomically renamed terminal snapshot becomes authoritative for bounded events and settled input views; only then are the redundant event ledger and run mailbox directory removed. Named-session attempt directories are likewise removed after canonical promotion or durable failure telemetry.
**Reasoning:** The previous create-only filesystem lifecycle made successful tests and production terminal state grow monotonically. Snapshot-first compaction preserves restart inspection and input status while assigning cleanup to the owner that can observe safe terminal persistence.
**Consequences:** `get_run` must use terminal snapshot input/event projections rather than treating absent compacted files as empty live state. Active-child leases remain held until that terminal snapshot is durable; a persistence failure retains ownership fail-closed rather than exposing false restart drift. Attempt session ids are historical telemetry, not durable readable paths. Outputs, terminal snapshots, canonical sessions, active runs, and pending inputs are not retention targets.

### Acknowledged input is one version-2 contract
**Date:** 2026-07-10
**Status:** Active
**Decision:** Durable runs expose one caller-input contract at durable-run version 2. `answer_run_input` requires `response_id`; the raw answer is held only in live process memory, crosses the private stdin control channel, and produces a receipt only after the correlated child waiter accepts it. The request/terminal mailbox records persist only safe identifiers, status, and receipt metadata.
**Reasoning:** Bendum needs a dependable governed operator handoff without plaintext operational retention or a public mode decision. Retaining the former dual input paths would preserve incompatible delivery guarantees and unnecessary state.
**Consequences:** Exact live retries return the original receipt without redelivery; changed answer bodies under the same response identity reject. A run-owned mutation queue makes acknowledgment, cancellation, finalization, and pending closure deterministic. Process loss fails the run closed, so no cross-restart answer recovery is promised.

### Validation reason codes are explicit data, not message parsing
**Date:** 2026-07-09
**Status:** Active
**Decision:** Failure-log reason mapping and handler-level preflight retry guidance use `ValidationError.reasonCode` when present and otherwise report no inferred semantic code or guidance; neither inspects validation message text to derive semantics.
**Reasoning:** Message parsing made public telemetry and caller guidance depend on prose that can drift independently from caller contracts. Typed reason ownership belongs at the validation throw site, where the author knows the semantic failure.
**Alternatives considered:** Keep the message fallback as defense in depth (rejected because it silently hides missing structured codes), or centralize message strings and codes together (rejected because it still couples telemetry to copy).
**Consequences:** New semantic validation paths must pass an explicit reason code. New retry guidance must be selected by that code, and tests should assert both explicit-code preservation and unknown fallback for uncoded validation errors.

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

### Local capacity uses bounded top-level admission queueing
**Date:** 2026-07-12
**Status:** Active
**Decision:** `SUBAGENT007_MAX_ACTIVE_CHILDREN` defaults to 24. Top-level `start_run` and `schedule_run` overflow into an owner-scoped metadata-only queue bounded by `SUBAGENT007_MAX_QUEUED_RUNS`, default 96. Queueing can be disabled with `0`. One-shot, named-session, and recursive launches remain fail-fast.
**Reasoning:** Burst demand should retain a durable run identity without increasing concurrent child pressure. Keeping request payloads in owner memory avoids a new raw-prompt retention path, while excluding recursive work prevents all active parents from waiting on descendants that cannot acquire a slot.
**Alternatives considered:** Strict global FIFO (rejected because another server process cannot execute an in-memory request and a stalled owner could block everyone), persisted request payloads (rejected as a new sensitive accumulation path), and queueing every tool (rejected because synchronous and recursive contracts need immediate capacity outcomes).
**Consequences:** Queued views use `status:"working"` and `active_phase:"queued"`; one process-owned pump preserves FIFO per owner with approximate cross-process fairness. Cancellation removes a ticket before launch. Mutable safety preconditions are checked again at promotion, filesystem records publish atomically, unreadable ownership records fail closed, and restart drift never replays an unavailable prompt.

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

### Garbage collection follows observable ownership, not age
**Date:** 2026-07-12
**Status:** Active
**Decision:** Provider-owned snapshot temps, terminal in-memory task objects, child process groups, and raw failure telemetry are reclaimed automatically. Canonical outputs and Pi sessions are not deleted by provider TTL because callers such as Bendum durably retain their paths and session identities.
**Reasoning:** Deterministic cleanup can safely enforce file, process, and byte mechanics it owns. It cannot infer that a caller has consumed a canonical artifact merely from elapsed time or a successful return.
**Alternatives considered:** Blanket TTL deletion (rejected because it breaks Bendum rereads/resume), caller vigilance (rejected because routine manual cleanup is not a systemic fix), and unbounded observability (rejected because raw telemetry caused material disk growth).
**Consequences:** Failure raw storage defaults to 64 MiB and keeps whole newest records; append and archive share one atomically published lock, summaries precede raw pruning, and a bounded unref'ed worker removes telemetry I/O from caller latency. Bridge control EOF terminates the owned group; terminal snapshots survive restart while redundant memory/events/mailboxes do not; future canonical release requires an explicit caller-owned acknowledgment contract.

### Public event views are sanitized projections
**Date:** 2026-06-24
**Status:** Active
**Decision:** Public run views and transcript-rendered artifacts expose bounded, sanitized progress rather than raw thinking, private tool payloads, answer values, or full composed prompts.
**Reasoning:** Run state must be useful for polling/debugging without leaking private reasoning or sensitive caller input.
**Alternatives considered:** Storing raw child streams directly in public events (rejected because it would conflate auditability with disclosure).
**Consequences:** Changes to transcript, event, and failure-log code need tests for what is omitted as well as what is included.
