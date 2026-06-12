# Simplification Report - 2026-06-12

## Loop 1 - Shared Run Task State Construction

Finding: `src/runTask.ts` repeats the same `RunTaskState` construction in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`. The repeated block is internal scaffolding: run id, mailbox paths, abort controller, timestamps, progress defaults, and the initial unresolved promise. It is semantic waste because future lifecycle changes must be kept synchronized across three public tool paths.

Behavior check: extracting the repeated construction into one helper should not change observable behavior if it preserves id generation, timestamp creation, mailbox path derivation, `taskKind`, optional `sessionKey`, and the initial field values.

Oracle: existing MCP lifecycle tests cover `run_subagent`, `schedule_run`, `start_run`, `start_session_run`, `get_run`, cancellation, input, timeout, progress, and persisted snapshots through this construction path. No new pinning test is needed for a pure helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `handleTaskHeartbeat` and replaced the three repeated heartbeat callbacks with calls to that helper. The helper preserves the prior order: phase update, progress update, snapshot write, then optional heartbeat notification forwarding.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted lifecycle tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

Patch: added `createRunTaskState` and replaced the three repeated `RunTaskState` initialization blocks with calls to that helper. No public schema, event text, status value, persisted path, timeout behavior, or child invocation option was intentionally changed.

Targeted oracle result: `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 2 - Shared Heartbeat Snapshot Handling

Finding: `src/runTask.ts` repeats the same heartbeat callback body in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: transition from `awaiting_child_event`/`running_silent` to `running`, update progress fields, persist the task snapshot, then forward the heartbeat notification. This is semantic waste because the public liveness contract can drift between run, session, and one-shot paths.

Behavior check: extracting the repeated heartbeat body into one helper should not change observable behavior if it preserves transition conditions, progress message fallback, snapshot timing, heartbeat count, and notification forwarding order.

Oracle: existing lifecycle tests assert active heartbeat metadata, `running_silent` transition behavior, and timeout/progress handling across `run_subagent`, `start_run`, and `start_session_run`. No new pinning test is needed for a pure helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.
