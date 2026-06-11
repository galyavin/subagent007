# Observed Real Use HORC/SAF Campaign - Subagent007 MCP

Date: 2026-06-10
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Mode: report-only observed trials and root-cause analysis

Status: historical pre-repair observed-use campaign. The revised SAF set derived from this report has since been implemented in the current worktree; retained observations describe the state at campaign time.

## Coverage Run

Verification commands:

- `npm test` -> 85/85 passing
- `npm run typecheck` -> passing
- `npm run models:reconcile` -> passing; all curated model refs present in Pi/source checks
- `npm run observed-campaign -- --campaign-id observed.realuse.20260610 -- node -e "process.exit(0)"` -> campaign-scoped summary emitted with isolated state paths and exit code 0

Live MCP trials against the installed server:

- T1 `run_subagent`: completed in 2.7s, persisted `LIVE_RUN_SUBAGENT_OK`.
- T2 `start_run` -> `get_run` -> `answer_run_input`: surfaced input request, accepted answer `blue42`, completed with `ANSWER:blue42`.
- T3 `start_run` -> pending input -> `cancel_run` -> `get_run`: terminal `cancelled`, persisted transcript with cancellation marker.
- T3 late answer probe: `answer_run_input` accepted `late-after-cancel` after the run was already terminal cancelled.
- T4 `run_subagent_session` new/resume: created then resumed the same semantic session; manifest `run_count` advanced to 2.
- T5 `run_subagent_session` with `packet_policy: required`: valid ready packet committed session and wrote packet JSON.
- T6 `run_subagent_session` with non-ready required packet: returned `packet_failed`, wrote `attempts.jsonl` and packet, did not create manifest or ledger.
- T7 `run_subagent` read-only repo review: timed out at the one-shot cap with recovery hint.
- T7b `start_run` read-only repo review: cancelled after proving async progress and cancellation path.

## Observed Issues And Incoherences

### O1. Late answers are accepted after run cancellation

Severity: medium

Evidence:

- T3 reached `status: cancelled`, `stop_reason: cancelled`, and persisted `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-10T233304224Z-e8a2ced1b92d.md`.
- After that terminal state, `answer_run_input` accepted the still-pending request and created `/Users/rgalyavin/.codex/subagent007-pi/input-requests/2026-06-10T233257175Z-35d854a57d87/2026-06-10T233257175Z-35d854a57d87-f12580699196.answer.json`.
- The answer cannot reach a child process because the run is already cancelled, but the public request status becomes `answered`.

Code path:

- `src/runTask.ts:246` to `src/runTask.ts:258`: cancellation marks `cancelRequested` and aborts the process, but does not close pending mailbox requests.
- `src/runTask.ts:261` to `src/runTask.ts:284`: `answerRunTaskInput` checks membership only, not whether the run is terminal.
- `src/inputMailbox.ts:209` to `src/inputMailbox.ts:240`: `answerInputRequest` rejects only already answered or timed-out requests.

HORC:

The input mailbox has an independent lifecycle from the run task lifecycle. A request can remain logically pending after the only consumer has been terminated, because "pending" is derived from mailbox files, not from the owning run state.

Intraframe SAF candidate:

Add an explicit mailbox terminalization step for owned pending requests when a run reaches any terminal state. Extend request status with a terminal reason such as `cancelled` or `closed`, and make `answer_run_input` accept only requests whose effective status is `pending` and whose owning run is still active or `input_required`.

Transframe SAF candidate:

Replace the file-pair mailbox with an event-sourced run state log where input request creation, answer, timeout, cancellation, and run terminalization are one ordered stream. `answer_run_input` would validate against the current aggregate state instead of independent mailbox files.

Selected SAF:

Intraframe SAF. It eliminates the defect with the least system motion: keep the mailbox storage model, but make run terminalization close outstanding request states and guard `answerRunTaskInput` against terminal runs. A pure guard that rejects late answers is not sufficient by itself because it still leaves user-visible pending requests on cancelled runs.

### O2. Session result semantics conflate candidate session establishment with committed session establishment

Severity: medium

Evidence:

- T6 used `packet_policy: required` with a valid `inconclusive` packet. The result correctly failed and did not create a manifest or ledger.
- The T6 session directory still contains an attempt Pi session file under `attempt-pi-sessions/0001-72659f0faf3d/...jsonl`, proving candidate Pi session establishment occurred.
- The public result reports `subagent_session_id: null` and `session_established: false`.
- Failure logging separately classifies the event as `packet_failed/packet_required_invalid`, which implies the implementation internally knew this was not a missing-session failure.

Code path:

- `src/session.ts:508` to `src/session.ts:525`: computes `attemptSubagentSessionId` and `attemptSessionEstablished`.
- `src/session.ts:526` to `src/session.ts:532`: computes `committedSubagentSessionId` only after packet satisfaction.
- `src/session.ts:618` to `src/session.ts:619`: exposes only committed state through `subagent_session_id` and `session_established`.
- `src/session.ts:641` to `src/session.ts:649`: failure logging uses `attemptSessionEstablished` for classification, so telemetry and public result semantics diverge.

HORC:

The public session result has one flat "session established" primitive for two different phases: candidate child session establishment and durable committed session promotion.

Intraframe SAF candidate:

Add explicit result and run-record fields for both phases, for example `attempt_subagent_session_id`, `attempt_session_established`, `committed_subagent_session_id`, and `committed_session_established`. Keep existing fields as backward-compatible aliases for committed state, and document that packet failures can have an established attempt but no committed session.

Transframe SAF candidate:

Change `run_subagent_session` to return a transaction object with nested phases: `attempt`, `packet_gate`, and `commit`. The result shape would make promotion the central mechanic instead of exposing flat booleans.

Selected SAF:

Intraframe SAF. The underlying transaction design is already sound. The defect is the public vocabulary, so adding phase-explicit fields resolves the incoherence without rewriting the session mechanic.

### O3. Failure observability is split between SDK schema validation and handler validation

Severity: low to medium

Evidence:

- Automated tests intentionally assert that SDK input-schema rejections happen before failure logging.
- Handler-level validation failures are logged through `withFailureLogging`, but schema-boundary failures are returned by the MCP SDK before the handler wrapper runs.
- For observed campaigns, this means failure ledgers undercount malformed caller requests unless the campaign harness or client records schema errors separately.

Code path:

- `src/server.ts:117` to `src/server.ts:164`: strict Zod schemas reject some invalid inputs before tool handlers execute.
- `src/server.ts:35` to `src/server.ts:59`: failure logging wraps handlers only.
- `src/failureLog.ts:165` to `src/failureLog.ts:195`: central failure records are written only when called by handler code.

HORC:

Observation is attached to handler execution, but part of the public contract is enforced before handler execution. The system therefore has two validation frames but only one telemetry frame.

Intraframe SAF candidate:

Move all semantically meaningful validation into handler-level code by making MCP schemas permissive enough to invoke the handler, then use existing validation and failure logging uniformly.

Transframe SAF candidate:

Make the observed campaign harness the authoritative observation boundary. It should record every MCP call attempt, including SDK schema errors, handler errors, tool results, and failure-log deltas, without weakening tool schemas in the production server.

Selected SAF:

Transframe SAF. The strict schemas are valuable client contracts. Full campaign observability is better solved one frame higher, by the campaign harness or MCP probe client, so production schemas stay strong while observed-use ledgers become complete.

## Common Patterns

- Lifecycle state exists in multiple artifacts: in-memory run state, JSON snapshots, mailbox request files, session manifests, ledgers, attempts, packets, and failure logs.
- The implementation is strongest where it models a transaction explicitly, as with session candidate attempts and packet-gated promotion.
- Incoherence appears when a public field or command crosses artifact boundaries without naming the phase it is operating in.
- The highest-risk defects are not child-agent failures. They are parent-server state-machine leaks after cancellation, rejection, or validation short-circuiting.

## Non-Issues Observed

- One-shot timeout on T7 behaved as documented: it returned a timeout marker and recovery hint pointing to `start_run`.
- Default heartbeat behavior is coherent after the first 30s interval. Early active snapshots can show `heartbeat_count: 0`, then later snapshots show `last_progress_message: running`.
- Packet-gated sessions fail closed: T6 wrote attempts and packet evidence but did not mutate committed manifest or ledger.
- Model allowlist reconciliation passed against current sources on 2026-06-10.

## Recommended Fix Order

1. Fix O1 first. It is user-visible and can create misleading input audit state after cancellation.
2. Fix O2 next. It improves caller interpretation and prevents packet failures from looking like missing-session failures.
3. Fix O3 in the campaign harness or probe client. It is mostly an observability completeness issue, not an execution correctness issue.
