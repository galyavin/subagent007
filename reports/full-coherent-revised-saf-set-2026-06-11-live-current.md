# Full Coherent Revised SAF Set - 2026-06-11 Live Current

Inputs:

- `reports/observed-real-use-horc-saf-campaign-2026-06-11-live-current.md`
- `reports/saf-adversarial-stress-test-2026-06-11-live-current.md`

Purpose: repair the SAF set after adversarial stress testing. This document replaces the overgenerous prior selections with a coherent set of root-cause corrections. Each selected SAF is stated as the smallest complete repair for the revised HORC framing, not merely a useful patch.

## Revision Principles

1. Do not call a fix a SAF if it only makes the observed report greener.
2. Split HORCs when one statement mixes a present incoherence with an optional future capability.
3. Prefer invariants over enumerated cleanup when the defect can recur by adding new data.
4. Prefer one authority per lifecycle, context, or attribution primitive.
5. Keep transcript/artifact compatibility unless compatibility itself is the root defect.

## Revised SAF Set

| ID | Repaired HORC | Selected SAF | Status |
| --- | --- | --- | --- |
| R1 | Public terminal lifecycle has two authorities. | Make `runTask` the sole public terminal lifecycle authority; raw process timeout/cancel markers remain transcript diagnostics only. | True SAF |
| R2 | Run-scoped operations lack a resolved operation context at the handler boundary. | Introduce one run-scoped operation-context wrapper used by `get_run`, `answer_run_input`, and `cancel_run`; handlers and failure logging consume the same resolved context. | True SAF |
| R3 | Coverage profiles can require surfaces that no selected executable scenario can satisfy. | Add manifest-level profile satisfiability validation, then add the minimal missing scenarios needed for `full-current` to pass that invariant. | True SAF |
| R4 | Live campaign evidence has no first-class isolated server instance primitive. | Make live campaigns launch and drive an isolated MCP server instance under the campaign harness; installed-server calls remain explicitly production-state observations. | True SAF |
| R5a | Public docs imply stronger input-answer confidentiality than the system provides. | Clarify the public contract: answer values are omitted from mailbox/input events, but child-generated output is public unless explicitly governed by a sensitivity feature. | True SAF |
| R5b | The system does not offer nonpublic caller-input dataflow redaction. | Declare nonpublic input redaction out of scope unless a new explicit sensitivity-labeled input/output policy is introduced; do not imply confidentiality from structural redaction. | True SAF |
| R6 | Active run liveness has no explicit post-spawn phase state. | Persist `active_phase:"awaiting_child_event"` and `last_phase_at` immediately after child spawn, then update phase on first child event, input, timeout, cancellation, or terminal result. | True SAF |

## R1: Terminal Lifecycle Authority

### Repaired HORC

Public terminal lifecycle state is authored by two mechanisms:

- `publicMarkerLine` maps raw `[subagent007 timeout]` and `[subagent007 cancelled]` transcript markers into public terminal events.
- `appendTerminalEvent` appends normalized terminal lifecycle events from the settled run result.

This produces duplicate terminal events and mixed text vocabularies.

### Intraframe Candidate

Change the public event projection so raw process timeout/cancel markers are not terminal lifecycle events. They can be omitted from `recent_events` or projected as non-terminal process diagnostics. Keep them in Markdown output artifacts for backwards transcript fidelity.

### Transframe Candidate

Replace transcript-line lifecycle inference with a typed process event channel emitted by `runChildProcess`, and reserve lifecycle event authoring for the task state machine.

### Selected SAF

Intraframe: make `runTask` the sole public terminal lifecycle authority; raw process timeout/cancel markers are diagnostics only.

### Why This Is True

The root contradiction is duplicate authority inside one public channel. The selected fix removes exactly one authority from that channel and leaves artifact compatibility intact. A typed process event bus is cleaner long term, but not required to eliminate the contradiction.

### Acceptance Criteria

- Timeout `get_run.recent_events` contains one lifecycle `event:"timeout"` terminal event.
- Cancellation `get_run.recent_events` contains one lifecycle `event:"cancellation_settled"` terminal event.
- Markdown transcripts still contain `[subagent007 timeout]` / `[subagent007 cancelled]` when those markers occur.
- Tests assert no duplicate public terminal lifecycle events for timeout and cancellation.

## R2: Run Operation Context

### Repaired HORC

Run-scoped tools accept `run_id`, but failure logging and reason classification operate on the raw tool request. That loses cwd/session/task context and maps expected state errors to generic validation reasons.

### Intraframe Candidate

Add a small resolver inside each run-scoped handler that fetches a run snapshot, derives cwd/session/task context, and logs precise run-state validation errors.

### Transframe Candidate

Introduce a first-class `RunOperationContext` wrapper for run-scoped tools. The wrapper resolves the run once, passes the same context to the handler, and passes it to failure logging on success or failure.

### Selected SAF

Transframe within the handler layer: introduce one run-scoped operation-context wrapper used by `get_run`, `answer_run_input`, and `cancel_run`.

### Why This Is True

The asymptotic patch was "resolve context when possible." The true root fix is that run-scoped operations must begin with a run context, not rediscover it after something fails. One wrapper is the smallest complete place to enforce that invariant across all run-scoped tools.

### Acceptance Criteria

- Late `answer_run_input` rejection logs a precise reason such as `run_not_accepting_input` or `input_request_already_answered`.
- Failure records for valid run ids include `run_id`, `task_kind`, and derived cwd; session tasks also include `session_key` when present.
- Invalid or unknown run ids still log a precise `run_not_found` class/reason without pretending cwd is known.
- Handler code for `get_run`, `answer_run_input`, and `cancel_run` uses the same wrapper instead of parallel ad hoc logging.

## R3: Coverage Profile Satisfiability

### Repaired HORC

The coverage manifest can define a profile whose `required_surfaces` cannot be satisfied by its selected scenarios. `full-current` currently requires more surfaces than its scenario list can cover, so it is an inventory assertion rather than an executable campaign.

### Intraframe Candidate

Add the currently missing scenarios to `full-current`.

### Transframe Candidate

Turn coverage into a persistent database that can merge deterministic, live, and production-state evidence across multiple runs.

### Selected SAF

Intraframe with invariant: add manifest-level profile satisfiability validation, then add the minimal missing executable scenarios needed for `full-current` to satisfy the invariant.

### Why This Is True

Adding only today's scenarios is incomplete because the defect can recur on the next surface addition. The irreducible correction is the invariant: a profile cannot require a surface unless at least one selected scenario can satisfy it under a compatible evidence class. Scenario additions are then just data needed to make the current manifest valid.

### Acceptance Criteria

- Manifest validation fails before execution if any profile has a required surface not covered by one of its scenarios.
- Validation accounts for evidence class compatibility, not just surface name overlap.
- `full-current` includes executable scenarios for:
  - `run_subagent-timeout-recovery`
  - `start_run-async-polling`
  - `answer_run_input-caller-input`
  - `cancel_run-cancellation-settlement`
  - `run_subagent_session-valid-packet-closure`
  - `run_subagent_session-invalid-packet-closure`
  - `installed-pi-integration` or an explicit live-only scenario that covers it
- `protocol-core` remains deterministic and does not claim live-only coverage.

## R4: Live Campaign Server Instance

### Repaired HORC

Campaign isolation is process-scoped, while live installed MCP calls use an already-running server. The missing primitive is not "make the existing installed server magically campaign-scoped"; it is "a live campaign must own the server process it is measuring."

### Intraframe Candidate

Document that live campaigns must restart MCP under the campaign environment.

### Transframe Candidate

Add request-scoped campaign metadata to MCP calls and thread it through every output, session, input, and failure path.

### Selected SAF

Introduce a first-class live campaign runner mode that launches a fresh MCP server under `scripts/run-observed-campaign.mjs` and drives live-model scenarios through that server. Installed-server observations remain production-state evidence by definition.

### Why This Is True

The prior "process-scoped env" framing made this look like only request-scoped metadata could be true. After removing that false immutability assumption, a campaign-scoped server instance is the smaller coherent primitive. A campaign is a process boundary. The true fix is to make that boundary explicit and executable.

Request-scoped campaign metadata is more general, but it is not necessary for observed trial campaigns and would expand public contracts and trust semantics.

### Acceptance Criteria

- A documented command can run live-model `full-current` scenarios against a newly launched server with isolated state paths.
- The harness summary records state root, runs dir, run-tasks dir, input dir, sessions dir, raw sessions dir, failure log, campaign ledger, and model health path.
- Reports generated from installed-server calls must label them production-state observations unless the server process was launched by the campaign runner.
- No public tool inputs need a campaign id.

## R5a: Input Confidentiality Documentation Boundary

### Repaired HORC

The public contract can be read as implying that `answer_run_input.answer` will never appear in public artifacts. The implementation only guarantees that answer values are omitted from mailbox/input events; the child may still include the value in assistant output.

### Intraframe Candidate

Clarify README and tool docs.

### Transframe Candidate

Introduce dataflow-aware sensitivity labels and redaction.

### Selected SAF

Intraframe: clarify the public contract precisely.

### Why This Is True

For the documentation-boundary HORC, text is the primitive that is malformed. The implementation is behaving as designed; the smallest complete fix is to state the guarantee exactly.

### Acceptance Criteria

- README says answer text is stored in local mailbox records and omitted from input/public event records.
- README also says child-generated output is public transcript material and can include answer-derived text if the prompt/tool flow causes that.
- Tool docs avoid implying confidentiality beyond event-level omission.

## R5b: Nonpublic Caller-Input Redaction Capability

### Repaired HORC

The system does not provide a nonpublic caller-input dataflow policy. Structural redaction of packets and omission of answer events is not equivalent to dataflow-aware confidentiality.

### Intraframe Candidate

Do nothing beyond documentation and declare this out of scope.

### Transframe Candidate

Add sensitivity-labeled caller input and output policy. For example: `answer_run_input` can mark an answer as `public`, `local_only`, or `redact_exact`, and transcript projection applies the declared policy to public events and artifacts.

### Selected SAF

Declare nonpublic input redaction out of scope unless and until an explicit sensitivity-labeled input/output policy is introduced. Do not advertise or imply stronger confidentiality from current structural redaction.

### Why This Is True

The prior single HORC falsely demanded a privacy feature from a system that only implements structural event redaction. The coherent fix is a boundary decision: either scope it out explicitly or introduce the real policy primitive. Since no current requirement demands nonpublic answers, explicit out-of-scope declaration is the least-motion complete correction.

### Acceptance Criteria

- Docs explicitly state there is no dataflow confidentiality guarantee for caller answers.
- Tests continue to prove answer text is omitted from input/public event records.
- No test claims assistant output redacts answer-derived content.
- If future requirements need nonpublic answers, the work starts from a sensitivity policy design rather than regex redaction.

## R6: Active Run Phase State

### Repaired HORC

After child spawn, active run state has no explicit phase until a heartbeat or public child event occurs. Short effective timeouts and slow model startups therefore look like static `child process starting` states.

### Intraframe Candidate

Add several liveness fields: `child_started`, `awaiting_child_event`, `last_output_at`, and an immediate heartbeat snapshot.

### Transframe Candidate

Expose a full typed runtime state machine with provider/model/tool phases.

### Selected SAF

Persist a single explicit phase transition immediately after child spawn:

- `active_phase:"awaiting_child_event"`
- `last_phase_at:<timestamp>`

Then update `active_phase` on first public child event, input request, timeout, cancellation, or terminal result.

### Why This Is True

The asymptotic fix bundled too many fields. The atomic defect is absence of a persisted post-spawn phase. One phase field plus timestamp is the smallest complete correction for "looks stalled before first event" without pretending to know provider internals.

### Acceptance Criteria

- Immediately after child spawn, `get_run` exposes `active_phase:"awaiting_child_event"` and `last_phase_at`.
- A run that times out before heartbeat still has a phase history showing it reached the child-awaiting phase.
- Input request, cancellation, timeout, and terminal completion update the active phase consistently.
- No global heartbeat interval reduction is required.

## Coherent Implementation Order

1. R1 first: it cleans the public event stream and reduces confusion for later progress/phase assertions.
2. R6 second: it adds the active phase vocabulary while the event model is fresh.
3. R2 third: it improves run-scoped error telemetry for the same tools used by R6 verification.
4. R3 fourth: it makes coverage profiles structurally honest.
5. R4 fifth: it gives R3's live scenarios an isolated execution primitive.
6. R5a/R5b last: they are documentation and scope-boundary corrections, low risk and independent of runtime mechanics.

## Rejected Pseudo-SAFs

- Rename duplicate timeout/cancel labels while still emitting duplicate terminal events.
- Add only a generic `answer_run_input_failed` reason code without run context.
- Remove missing surfaces from `full-current`.
- Pretend installed-server live observations are campaign-scoped after the fact.
- Regex-redact assistant output containing exact input answers.
- Shorten heartbeat interval globally.

## Final Coherent Verdict

The repaired set has six runtime/coverage/documentation corrections plus one explicit capability boundary split:

- R1, R2, R3, R4, R5a, R5b, and R6 are coherent True SAFs under their repaired HORC framings.
- R5b is a negative SAF: the atomic correction is an explicit scope boundary, not new redaction machinery.
- The set preserves the original campaign finding that core child execution and session mechanics are healthy; it focuses repair on event authority, operation context, coverage invariants, campaign instance identity, confidentiality wording, and active phase state.
