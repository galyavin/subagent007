# Full Coherent Revised SAF Set - Subagent007 MCP

Date: 2026-06-10
Source artifacts:

- `reports/observed-real-use-horc-saf-campaign-2026-06-10.md`
- `reports/saf-adversarial-classification-2026-06-10.md`

Purpose: repair the previously asymptotic selected SAFs into a coherent revised set with exact state authority, scoped claims, rejected pseudo-fixes, and validation checks.

Status: implemented revised SAF decision record. The three revised SAFs in this document are implemented in the current worktree; keep this file as traceability, not as an open task list.

## Coherence Rules

These SAFs are coherent only if they preserve three shared rules:

1. Each lifecycle object must have exactly one authoritative terminal transition.
2. Public result fields must name their phase: attempt, commit, or observation boundary.
3. Evidence claims must stay scoped to the system that actually observes them.

## R-SAF-1: Single Input-Request Settlement Authority

HORC:

Input mailbox state and run task state have independent terminal lifecycles. A request can remain actionable after the owning run is terminal because "pending" is derived from mailbox marker files rather than from a single owning transition.

Revised SAF:

Introduce one mailbox-level settlement primitive for input requests:

```ts
settleInputRequest(requestId, outcome)
```

where `outcome` is exactly one of:

- `answered`
- `timed_out`
- `closed`

The primitive must be the only path that creates terminal status for an input request. It must make terminal status effectively single-writer, either by atomic marker creation with deterministic precedence or by a single terminal record. `answerRunTaskInput` may settle as `answered` only when the owning run is still active and the request is still effectively pending. Run cancellation and run finalization must settle all still-pending owned requests as `closed`.

Classification after repair:

True SAF within the current file-backed mailbox frame.

Why this is atomic:

The smallest complete correction is not "reject late answers" and not "hide pending requests." The primitive being malformed is request terminalization itself. A single settlement authority removes the upstream contradiction that allowed `answered`, `timed_out`, and post-run pending states to diverge.

Rejected pseudo-SAFs:

- Add only a terminal-run guard to `answerRunTaskInput`: rejects one symptom but leaves cancelled runs showing actionable pending requests.
- Delete pending request files on cancellation: destroys audit evidence and does not define a terminal state.
- Filter pending requests out of `get_run` for cancelled runs: hides the contradiction while allowing late answers to mutate state.

Implementation sketch:

- Add a terminal status marker or terminal record shape in `inputMailbox.ts`.
- Make `answerInputRequest` use the settlement primitive instead of directly writing an answer marker.
- Add `closePendingInputRequestsForRun(mailboxRoot, runId)` and call it from terminal run paths.
- Update `listInputRequests` so `closed` is visible and non-actionable.

Validation:

- Start a run that reaches `input_required`.
- Cancel it.
- Verify `get_run` reports no actionable pending request.
- Verify `answer_run_input` rejects the closed request.
- Verify the mailbox has exactly one effective terminal status.
- Add a race-oriented test where answer and cancellation contend; the final status must be deterministic and non-contradictory.

## R-SAF-2: Attempt-Phase Session Fields Only

HORC:

`run_subagent_session` currently exposes one flat session establishment concept even though session execution has two distinct phases: candidate Pi session establishment and committed session promotion after packet gating.

Revised SAF:

Keep existing public fields as committed-state fields:

- `subagent_session_id`
- `session_established`

Add only the missing attempt-phase fields:

- `attempt_subagent_session_id`
- `attempt_session_established`

Expose them on `run_subagent_session` results and session attempt records. Do not add duplicate `committed_*` fields unless a concrete client migration requires them. Document explicitly that packet-required failures may have `attempt_session_established: true` while `session_established: false`.

Classification after repair:

True SAF within the current session transaction frame.

Why this is atomic:

The committed phase is already represented. The smallest missing concept is the attempt phase. Adding only attempt-phase fields resolves the ambiguity without duplicating committed semantics or creating a second alias set.

Rejected pseudo-SAFs:

- Change `session_established` to mean attempt establishment: breaks existing committed-session meaning and makes successful commit state less clear.
- Add only documentation: leaves clients unable to distinguish packet failure from missing candidate session through structured fields.
- Add full nested transaction shape immediately: clearer long-term, but more motion than needed to eliminate the specific contradiction.
- Add both attempt and committed duplicate fields now: solves the issue but is overbuilt and risks alias drift.

Implementation sketch:

- Preserve `subagent_session_id: committedSubagentSessionId`.
- Preserve `session_established: committedSubagentSessionId !== null`.
- Add `attempt_subagent_session_id: attemptSubagentSessionId`.
- Add `attempt_session_established: attemptSubagentSessionId !== null`.
- Include attempt fields in failed `attempts.jsonl` records where useful for audit.

Validation:

- Required-packet success: attempt and committed fields are both true and point to the committed session after promotion.
- Required-packet non-ready failure: attempt fields show the candidate session; committed fields remain null/false.
- Missing-session failure: both attempt and committed fields are null/false.
- Failure log classification remains `packet_failed` for non-ready packet failures and `missing_session_id` only when no attempt session exists.

## R-SAF-3: Campaign Probe As First-Class Observation Boundary

HORC:

Observed campaign evidence claims depend on server failure logging, but some public-contract failures are enforced by the MCP SDK before tool handlers and therefore before handler-level failure logging.

Revised SAF:

Make campaign-scoped evidence depend on a first-class MCP campaign probe runner, not on production `failures.jsonl` alone. The probe runner is the authoritative observation boundary for campaigns and must record every MCP call attempt as campaign evidence.

Minimum event vocabulary:

- `call_started`
- `call_result`
- `call_schema_error`
- `call_handler_error`
- `failure_log_delta`

Scope rule:

This SAF claims complete observed-campaign evidence, not complete production server telemetry. Production strict MCP schemas remain intact. Do not claim production `failures.jsonl` captures all malformed caller requests unless a separate protocol-boundary observer is added to the server.

Classification after repair:

True SAF for campaign evidence completeness. Not a SAF for global production telemetry, by explicit scope.

Why this is atomic:

The malformed primitive is the campaign evidence boundary, not the production validator. Moving observation to the probe/client boundary captures SDK schema failures without weakening schemas or forcing all validation into handlers.

Rejected pseudo-SAFs:

- Relax production MCP schemas just to make failures loggable: weakens client contracts and moves the defect into runtime validation.
- Treat `failures.jsonl` as campaign-complete despite schema-boundary gaps: hides missing observations.
- Add ad hoc stderr scraping to the shell harness: brittle and not tied to MCP call identity.
- Record only failures: cannot prove coverage or distinguish unattempted paths from successful paths.

Implementation sketch:

- Add a campaign MCP probe script or library that starts the server under campaign env and calls tools through the MCP client.
- Emit a campaign ledger separate from, or adjacent to, `failures.jsonl`.
- For each call, record call id, tool name, arguments class or redacted argument shape, result status, schema/handler error class, output metadata, and failure-log delta.
- Update campaign documentation: only probe-run campaigns may claim complete MCP call-attempt coverage.

Validation:

- Probe four calls in one campaign:
  1. SDK schema rejection.
  2. Handler-level validation failure.
  3. Child nonzero or packet failure.
  4. Success.
- Verify the campaign ledger has all four `call_started` records and matching terminal records.
- Verify server `failures.jsonl` still records only handler/child failures where applicable.
- Verify the harness summary points to both campaign ledger and server failure log paths.

## Final Revised Set

| ID | Revised SAF | Classification | Scope |
| --- | --- | --- | --- |
| R-SAF-1 | Single input-request settlement authority | True SAF | Current file-backed mailbox/run lifecycle |
| R-SAF-2 | Add only attempt-phase session fields | True SAF | Current session transaction/result schema |
| R-SAF-3 | Campaign probe as first-class observation boundary | True SAF | Campaign evidence completeness only |

## Execution Order

1. R-SAF-1 first: it fixes a user-visible lifecycle contradiction and prevents misleading post-cancel input mutation.
2. R-SAF-2 second: it clarifies packet-gated session outcomes without destabilizing transaction mechanics.
3. R-SAF-3 third: it improves evidence quality for future campaigns and should be validated against the first two repairs.

## Residual Boundaries

- R-SAF-1 does not replace the mailbox with an event log; it makes the existing mailbox coherent enough for the observed lifecycle defects.
- R-SAF-2 does not redesign session results into nested transactions; it adds the irreducibly missing attempt phase.
- R-SAF-3 does not fix production telemetry completeness; it prevents campaign reports from overclaiming based on server logs alone.
