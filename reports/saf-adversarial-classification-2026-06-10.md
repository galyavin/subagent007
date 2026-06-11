# SAF Adversarial Classification - Subagent007 MCP

Date: 2026-06-10
Source report: `reports/observed-real-use-horc-saf-campaign-2026-06-10.md`
Mode: report-only red/blue stress-test of selected SAFs

Status: historical adversarial classification. The stricter SAF set produced from this review has since been implemented in the current worktree.

## Verdict

None of the three selected SAFs survives as a strict True SAF as written.

- O1 is an asymptotic SAF: correct root target, but underspecified around atomic request state transitions.
- O2 is an asymptotic SAF: correct root target, but over-expands the result schema beyond the irreducible change.
- O3 is an asymptotic SAF: correct frame shift for campaign evidence, but incomplete if interpreted as fixing server-level telemetry.

No selected SAF is a pseudo-SAF. Each targets the real upstream incoherence rather than merely hiding the immediate symptom. The issue is precision and irreducibility, not direction.

## Evidence Frame

The evaluated proposals are the selected SAFs from the observed-use campaign report. The objective is stricter than "would this help": determine whether each proposal is the smallest sufficient change that eliminates the HORC without moving hidden complexity elsewhere.

## O1: Terminalize Pending Input Requests On Run Terminalization

Selected SAF:

Keep mailbox storage, but when a run reaches terminal state, close outstanding pending request states and guard `answerRunTaskInput` against terminal runs. A guard alone is insufficient because it leaves user-visible pending requests on cancelled runs.

Classification: asymptotic SAF.

Red-team critique:

The proposal targets the right root cause, but it does not explicitly define a single atomic request-state transition primitive. In the current file-pair mailbox, answering and terminalizing can be implemented as writes to different marker files. If cancellation and answer race, both an answer marker and a close marker can exist unless there is a per-request compare-and-set rule. That means the proposal can fix the observed late-answer path while leaving a subtler lifecycle contradiction.

Why it matters:

The HORC is not just "missing guard." It is independent lifecycle authority. A non-atomic terminalization pass plus a terminal-run guard reduces the defect but may still leave ambiguous audit state under concurrent answer/cancel/timeout conditions.

Defense:

Within the current stack, adding terminalization plus an active-run guard is still the smallest coherent fix that addresses both user-visible symptoms: late answers are rejected, and terminal runs stop presenting pending requests as actionable. It also fits the existing mailbox marker pattern.

Final assessment:

Asymptotic SAF. It is nearly right, but not perfectly irreducible or complete unless restated as a single mailbox transition primitive.

True-SAF refinement:

Introduce one mailbox-level terminal transition API, for example `settleInputRequest(requestId, outcome)`, where `outcome` is `answered`, `timed_out`, or `closed`. It must create exactly one terminal status per request or deterministically resolve races. Then `cancelRunTask` and run finalization call `settleInputRequest(..., "closed")`, and `answerRunTaskInput` calls the same primitive with `"answered"` only when the owning run is still non-terminal.

Smallest validation:

Add a test that starts a pending-input run, cancels it, verifies `get_run` no longer exposes an actionable pending request, verifies `answer_run_input` rejects the request, and verifies the mailbox has one effective terminal status.

## O2: Add Attempt Vs Committed Session Fields

Selected SAF:

Add explicit result and run-record fields for both phases, such as `attempt_subagent_session_id`, `attempt_session_established`, `committed_subagent_session_id`, and `committed_session_established`. Keep existing fields as backward-compatible aliases for committed state and document that packet failures can have an established attempt but no committed session.

Classification: asymptotic SAF.

Red-team critique:

The proposal correctly identifies that there are two phases, but it overstates the necessary schema motion. The existing `subagent_session_id` and `session_established` can remain committed-state fields. The missing information is the attempt phase. Adding both attempt fields and duplicate committed fields is clear, but not atomic.

Why it matters:

The defect is public semantic ambiguity, not lack of storage for committed state. Duplicating committed fields risks creating a second naming migration and future drift between aliases.

Defense:

The selected SAF is not symptom-only. It names the actual phases and would make the T6 packet-failure result coherent. Backward-compatible explicit committed fields may also help clients that cannot infer alias semantics safely.

Final assessment:

Asymptotic SAF. It resolves the HORC, but it is slightly overbuilt as written.

True-SAF refinement:

Keep existing `subagent_session_id` and `session_established` as committed-state fields, and add only `attempt_subagent_session_id` plus `attempt_session_established` to the public result and attempt run record. Document the existing fields as committed aliases. Only add `committed_*` fields if a concrete client migration need appears.

Smallest validation:

Add a required-packet failure test that verifies `attempt_session_established: true`, `attempt_subagent_session_id` points to the attempt Pi session file, `session_established: false`, `subagent_session_id: null`, and failure logging remains `packet_failed`, not `missing_session_id`.

## O3: Make Campaign Harness The Authoritative Observation Boundary

Selected SAF:

Make the observed campaign harness or probe client record every MCP call attempt, including SDK schema errors, handler errors, tool results, and failure-log deltas, while keeping strict production schemas.

Classification: asymptotic SAF.

Red-team critique:

This is a valid transframe move only if the target system is "observed campaign evidence." It does not eliminate the split inside the MCP server: schema-boundary validation still happens before handler-level failure logging. Outside the harness, production `failures.jsonl` can still undercount malformed calls.

Why it matters:

If the intended invariant is "central server failure logging captures all public contract failures," this proposal is not sufficient. It would hide completeness in a special caller path. That would be pseudo-SAF for server telemetry.

Defense:

The original issue was framed around observed campaigns. Keeping strict MCP schemas is valuable, and campaign completeness is naturally a client/probe concern because schema failures are client-visible events before handler execution. Recording at the probe boundary captures all attempts without weakening production validation.

Final assessment:

Asymptotic SAF. It is a strong transframe fix for campaign evidence, but not a True SAF for global server observability. It is not pseudo only because the selected scope was campaign observability, not production telemetry.

True-SAF refinement:

Narrow the claim and make the observation boundary first-class: provide a campaign MCP probe runner that is the only supported way to claim campaign-scoped evidence. It should log `call_started`, `call_result`, `call_schema_error`, `call_handler_error`, and `failure_log_delta` records. Do not claim that production failure logging is complete unless a separate protocol-boundary server observer is added.

Smallest validation:

Run a campaign probe with one schema-boundary rejection, one handler-level validation failure, one child nonzero failure, and one success. Verify the campaign ledger records all four call attempts, while the server failure log only records the latter two failure classes where applicable.

## Pattern-Level Finding

All three selected SAFs point at the correct root layer, but each needs sharper state vocabulary:

- O1 needs a single request terminal-state authority.
- O2 needs phase-specific session result fields with minimal aliasing.
- O3 needs scoped wording: campaign evidence completeness is not the same as server telemetry completeness.

The common anti-pattern is "correct concept, imprecise boundary." None of the proposals is fake, but none should be called a True SAF until the exact state authority and result vocabulary are tightened.
