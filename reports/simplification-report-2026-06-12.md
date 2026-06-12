# Simplification Report - 2026-06-12

## Loop 1 - Shared Run Task State Construction

Finding: `src/runTask.ts` repeats the same `RunTaskState` construction in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`. The repeated block is internal scaffolding: run id, mailbox paths, abort controller, timestamps, progress defaults, and the initial unresolved promise. It is semantic waste because future lifecycle changes must be kept synchronized across three public tool paths.

Behavior check: extracting the repeated construction into one helper should not change observable behavior if it preserves id generation, timestamp creation, mailbox path derivation, `taskKind`, optional `sessionKey`, and the initial field values.

Oracle: existing MCP lifecycle tests cover `run_subagent`, `schedule_run`, `start_run`, `start_session_run`, `get_run`, cancellation, input, timeout, progress, and persisted snapshots through this construction path. No new pinning test is needed for a pure helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `finalizeRunTask` and replaced the three repeated terminal cleanup blocks. Cancellable task paths still pass `run cancelled` when cancellation was requested and `run reached a terminal state` otherwise; the one-shot path still always passes `run reached a terminal state`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/input-mailbox.test.ts tests/failure-log.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `npm test` passed 125/125.

Patch: computed `cwdFromRunStartedEvent(events)` once in `resolveRunOperationContext` and reused the local value in the returned context object.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 54/54.

Full oracle result: `npm test` passed 125/125.

## Loop 5 - Shared Run Task Finalization

Finding: `src/runTask.ts` repeats the same terminal cleanup sequence in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: set `finishedAt`, close pending input requests, append input-closed events, append the terminal event, mark terminal snapshot started, and write the final snapshot. The only intentional behavioral difference is the close reason string used by the one-shot path versus cancellable task paths.

Behavior check: extracting the cleanup sequence into one helper should not change observable behavior if each caller passes the same close reason it uses today and the helper preserves operation order.

Oracle: existing lifecycle tests cover terminal snapshots, cancellation, input closure, timeout metadata, and one-shot result handling across all three paths. No new pinning test is needed for a pure helper extraction with preserved close reasons.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

## Loop 4 - Single Preflight Retry Guidance Classification

Finding: `preflightRejectedResult` in `src/server.ts` calls `preflightRetryGuidance(error.message)` twice while constructing one structured rejection result. This duplicates message classification in a public error path and makes later guidance changes easier to desynchronize.

Behavior check: computing the guidance once and conditionally spreading the local value should not change observable behavior. It must preserve omission when no guidance applies and preserve the exact `retry_guidance` string when it does apply.

Oracle: the existing skill-bound `run_subagent` preflight test covers the rejection path but did not assert `retry_guidance`. Add a pinning assertion for that public structured field before patching the implementation.

Decision: add the pinning assertion and patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a structured `retry_guidance` assertion to the skill-bound `run_subagent` preflight test, then computed `preflightRetryGuidance(error.message)` once in `preflightRejectedResult`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

Patch: added `handleTaskHeartbeat` and replaced the three repeated heartbeat callbacks with calls to that helper. The helper preserves the prior order: phase update, progress update, snapshot write, then optional heartbeat notification forwarding.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted lifecycle tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 3 - Single Cwd Recovery Scan

Finding: `resolveRunOperationContext` calls `cwdFromRunStartedEvent(events)` twice when resolving context from a persisted snapshot. This repeats the same event scan inside failure logging context recovery and makes the object construction less direct.

Behavior check: storing the recovered cwd in a local variable should not change observable behavior. It preserves the same event source, the same inclusion condition, and the same returned `cwd` value.

Oracle: existing failure-log tests cover run-scoped failure context and persisted run lookup behavior. No new pinning test is needed for this expression-level simplification.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `createRunTaskState` and replaced the three repeated `RunTaskState` initialization blocks with calls to that helper. No public schema, event text, status value, persisted path, timeout behavior, or child invocation option was intentionally changed.

Targeted oracle result: `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 2 - Shared Heartbeat Snapshot Handling

Finding: `src/runTask.ts` repeats the same heartbeat callback body in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: transition from `awaiting_child_event`/`running_silent` to `running`, update progress fields, persist the task snapshot, then forward the heartbeat notification. This is semantic waste because the public liveness contract can drift between run, session, and one-shot paths.

Behavior check: extracting the repeated heartbeat body into one helper should not change observable behavior if it preserves transition conditions, progress message fallback, snapshot timing, heartbeat count, and notification forwarding order.

Oracle: existing lifecycle tests assert active heartbeat metadata, `running_silent` transition behavior, and timeout/progress handling across `run_subagent`, `start_run`, and `start_session_run`. No new pinning test is needed for a pure helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.
