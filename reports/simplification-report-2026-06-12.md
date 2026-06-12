# Simplification Report - 2026-06-12

## Loop 1 - Shared Run Task State Construction

Finding: `src/runTask.ts` repeated the same `RunTaskState` construction in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`. The repeated block was internal scaffolding: run id, mailbox paths, abort controller, timestamps, progress defaults, and the initial unresolved promise. It was semantic waste because future lifecycle changes had to stay synchronized across three public tool paths.

Behavior check: extracting the repeated construction into one helper should not change observable behavior if it preserves id generation, timestamp creation, mailbox path derivation, `taskKind`, optional `sessionKey`, and the initial field values.

Oracle: existing MCP lifecycle tests cover `run_subagent`, `schedule_run`, `start_run`, `start_session_run`, `get_run`, cancellation, input, timeout, progress, and persisted snapshots through this construction path. No new pinning test was needed for a pure helper extraction.

Decision: patched minimally. If any test had failed, this loop would have been reverted and not retried.

Patch: added `createRunTaskState` and replaced the three repeated `RunTaskState` initialization blocks with calls to that helper. No public schema, event text, status value, persisted path, timeout behavior, or child invocation option was intentionally changed.

Targeted oracle result: `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 2 - Shared Heartbeat Snapshot Handling

Finding: `src/runTask.ts` repeated the same heartbeat callback body in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: transition from `awaiting_child_event`/`running_silent` to `running`, update progress fields, persist the task snapshot, then forward the heartbeat notification. This was semantic waste because the public liveness contract could drift between run, session, and one-shot paths.

Behavior check: extracting the repeated heartbeat body into one helper should not change observable behavior if it preserves transition conditions, progress message fallback, snapshot timing, heartbeat count, and notification forwarding order.

Oracle: existing lifecycle tests assert active heartbeat metadata, `running_silent` transition behavior, and timeout/progress handling across `run_subagent`, `start_run`, and `start_session_run`. No new pinning test was needed for a pure helper extraction.

Decision: patched minimally. If any test had failed, this loop would have been reverted and not retried.

Patch: added `handleTaskHeartbeat` and replaced the three repeated heartbeat callbacks with calls to that helper. The helper preserves the prior order: phase update, progress update, snapshot write, then optional heartbeat notification forwarding.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted lifecycle tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 3 - Single Cwd Recovery Scan

Finding: `resolveRunOperationContext` called `cwdFromRunStartedEvent(events)` twice when resolving context from a persisted snapshot. This repeated the same event scan inside failure logging context recovery and made the object construction less direct.

Behavior check: storing the recovered cwd in a local variable should not change observable behavior. It preserves the same event source, the same inclusion condition, and the same returned `cwd` value.

Oracle: existing failure-log tests cover run-scoped failure context and persisted run lookup behavior. No new pinning test was needed for this expression-level simplification.

Decision: patched minimally. If any test had failed, this loop would have been reverted and not retried.

Patch: computed `cwdFromRunStartedEvent(events)` once in `resolveRunOperationContext` and reused the local value in the returned context object.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 54/54.

Full oracle result: `npm test` passed 125/125.

## Loop 4 - Single Preflight Retry Guidance Classification

Finding: `preflightRejectedResult` in `src/server.ts` called `preflightRetryGuidance(error.message)` twice while constructing one structured rejection result. This duplicated message classification in a public error path and made later guidance changes easier to desynchronize.

Behavior check: computing the guidance once and conditionally spreading the local value should not change observable behavior. It must preserve omission when no guidance applies and preserve the exact `retry_guidance` string when it does apply.

Oracle: the existing skill-bound `run_subagent` preflight test covered the rejection path but did not assert `retry_guidance`. A pinning assertion for that public structured field was added before patching the implementation.

Decision: added the pinning assertion and patched minimally. If any test had failed, this loop would have been reverted and not retried.

Patch: added a structured `retry_guidance` assertion to the skill-bound `run_subagent` preflight test, then computed `preflightRetryGuidance(error.message)` once in `preflightRejectedResult`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 5 - Shared Run Task Finalization

Finding: `src/runTask.ts` repeated the same terminal cleanup sequence in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: set `finishedAt`, close pending input requests, append input-closed events, append the terminal event, mark terminal snapshot started, and write the final snapshot. The only intentional behavioral difference was the close reason string used by the one-shot path versus cancellable task paths.

Behavior check: extracting the cleanup sequence into one helper should not change observable behavior if each caller passes the same close reason it used before and the helper preserves operation order.

Oracle: existing lifecycle tests cover terminal snapshots, cancellation, input closure, timeout metadata, and one-shot result handling across all three paths. No new pinning test was needed for a pure helper extraction with preserved close reasons.

Decision: patched minimally. If any test had failed, this loop would have been reverted and not retried.

Patch: added `finalizeRunTask` and replaced the three repeated terminal cleanup blocks. Cancellable task paths still pass `run cancelled` when cancellation was requested and `run reached a terminal state` otherwise; the one-shot path still always passes `run reached a terminal state`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/input-mailbox.test.ts tests/failure-log.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `npm test` passed 125/125.

## Loop 6 - Shared Child-Spawn Prelude

Finding: `src/runTask.ts` still repeats the same child-spawn prelude in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: append the child-spawn event, move to `running_silent` if no child output has arrived, and persist the updated task snapshot. This is internal lifecycle bookkeeping that must stay identical across all three public run paths.

Behavior check: extracting this prelude into one helper should not change observable behavior if it preserves operation order and still writes the snapshot after `running_silent` is set.

Oracle: existing lifecycle tests assert `child_spawned` events, `running_silent` initial active phase, snapshot progression, and one-shot/start/session task behavior. No new pinning test is needed for this pure helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `prepareChildRun` and replaced the three repeated child-spawn prelude blocks. The helper preserves the prior order: append child-spawn event, mark silent running, then persist the task snapshot.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 7 - Shared Background Handler Failure Logging

Finding: `src/runTask.ts` repeats the same non-validation catch logging block in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: set `state.error`, skip `ValidationError`, and append a failure-log record with `failure_class:"unknown_error"`, `reason_code:"handler_error"`, request cwd, and `success:false`. Only the public tool name differs.

Behavior check: extracting the log call behind a helper should not change observable behavior if `state.error` remains assigned in each catch, validation errors remain skipped, and the emitted record fields are identical.

Oracle: existing failure-log tests cover task failure logging, validation non-logging, cancellation non-logging, and session failure logging. No new pinning test is needed for this helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `logBackgroundHandlerError` and replaced the three repeated catch logging blocks. Each catch still assigns `state.error`; the helper still skips `ValidationError` and emits the same `unknown_error`/`handler_error` record fields for non-validation failures.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 54/54.

Full oracle result: `npm test` passed 125/125.

## Loop 8 - Shared Task Registration Snapshot

Finding: `src/runTask.ts` repeats the same initial task registration sequence in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: put the state in the process-local task map, append the public `run_started` event, and write the first persisted task snapshot. This is one lifecycle primitive and should not be manually repeated across public run paths.

Behavior check: extracting this registration sequence should not change observable behavior if the state is inserted before `appendRunStartedEvent`, and the snapshot is still written after the run-started event is appended.

Oracle: existing lifecycle tests cover initial `working` views, `run_started` events, persisted snapshots, and server-restart snapshot reads. No new pinning test is needed for this helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `registerRunTaskState` and replaced the three repeated state-registration/start-event/initial-snapshot blocks. The helper preserves insertion into `tasks` before the public run-started event and preserves snapshot writing after that event.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `npm test` passed 125/125.

## Loop 9 - Single Snapshot Excerpt Projection

Finding: `loadSnapshotEvents` in `src/runTask.ts` computes `publicOutputExcerptProjection(events)` twice when a persisted event file exists. That repeats the same projection over the same event array while rebuilding a `get_run` view after restart.

Behavior check: storing the excerpt in a local variable should not change observable behavior. It preserves the same input events, omission when the projection is undefined, and the same returned `last_public_output_excerpt` value.

Oracle: existing lifecycle tests cover sanitized public event projection and completed-run snapshot reads after MCP server restart. No new pinning test is needed for this expression-level simplification.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch attempted: stored `publicOutputExcerptProjection(events)` in a local `lastPublicOutputExcerpt` and reused it in the returned projection object.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `npm test` failed because `scripts/run-tests-with-ledger-guard.mjs` detected that the default failure ledger at `/Users/rgalyavin/.codex/subagent007-pi/failures.jsonl` changed during the full run. Per the loop rule, the code patch was reverted and this simplification was not retried.

## Loop 10 - Private Test Failure Ledger By Default

Finding: `scripts/run-tests-with-ledger-guard.mjs` fingerprints the user-level default failure ledger when `SUBAGENT007_FAILURE_LOG_PATH` is not set, but it also spawns tests without forcing a private failure ledger. That makes the oracle depend on ambient writes to `/Users/rgalyavin/.codex/subagent007-pi/failures.jsonl` by any concurrent process, and it can fail a behavior-preserving code change after all test assertions pass.

Behavior check: when callers explicitly provide `SUBAGENT007_FAILURE_LOG_PATH`, the guard must preserve and guard that path. When callers omit it, the guard can set a private temp failure ledger for the spawned test process. That changes no MCP API, error contract, data format, or production side effect; it only removes user-global telemetry coupling from the test oracle.

Oracle: add a pinning test that runs the guard without an inherited `SUBAGENT007_FAILURE_LOG_PATH` and asserts the child test process receives a private temp failure ledger path rather than the user-level default path.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch attempted: changed the guard to create a private temp `SUBAGENT007_FAILURE_LOG_PATH` when none is inherited, and added `tests/test-ledger-guard.test.ts` to pin that behavior.

Targeted oracle result: `npm run typecheck` and `git diff --check` passed, but `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/test-ledger-guard.test.ts` failed because the dummy child test did not write the expected env-capture file. Per the loop rule, the guard and test patches were reverted and this simplification was not retried.

## Loop 11 - Single One-Shot Timeout Hint Persistence

Finding: `runSubagentOneShotTask` in `src/runTask.ts` has two branches that both append `Inspect this run with get_run using run_id ...`, write the updated snapshot, mirror the hint into `state.result`, and return the updated view. The only difference is the base hint: default one-shot recovery text when a timed-out view has no hint, or the existing `view.timeout_recovery_hint` when present.

Behavior check: computing the base hint first and using one persistence branch should not change observable behavior if it preserves the current conditions and the exact final hint text.

Oracle: existing lifecycle tests assert timeout recovery guidance and concrete `run_id` inclusion for `run_subagent`. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: computed `timeoutRecoveryHint` first, then used one branch to append the concrete `get_run` instruction, write the snapshot, mirror the hint into `state.result`, and return the updated view.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125. The explicit private ledger path avoids the known ambient default-ledger guard issue recorded in loops 9 and 10.

## Loop 12 - Single Packet Satisfaction Evaluation

Finding: `runSubagentSession` in `src/session.ts` evaluates `packetSatisfied(packetPolicy, packet.packetParseStatus, packet.claimedPacket)` once to compute session success, then evaluates the same predicate again later when logging a failed session result. This repeats a deterministic policy decision inside one run result construction.

Behavior check: storing the packet satisfaction result in a local variable should not change observable behavior. It preserves the same inputs, success condition, and failure classification inputs.

Oracle: existing session and failure-log tests cover packet-required success/failure, missing/invalid packets, non-ready packet failures, and failure-log classification. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced `packetIsSatisfied` and reused it for both session success computation and failure-log classification.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/session.test.ts tests/failure-log.test.ts` passed; targeted tests passed 24/24.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Current Constraints

The goal is not complete. I have not yet proven that the entire codebase has no material simplifications left. A broader lifecycle-shell extraction in `src/runTask.ts` remains plausible but is higher risk than the completed helper extractions and needs its own loop with direct oracle coverage. The current test oracle still has an incoherent constraint: with no explicit `SUBAGENT007_FAILURE_LOG_PATH`, full-suite success can depend on the ambient user-level failure ledger not changing during the run.
