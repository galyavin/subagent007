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

## Loop 13 - Single Model Health Action Computation

Finding: `modelHealthForClass` in `src/modelHealth.ts` calls `modelHealthProbeCommand(modelClass)` in both the no-record and cached-record result branches. The returned `health_action` string is identical for the same model class, so this repeats one public-output derivation inside a single view constructor.

Behavior check: computing `healthAction` once should not change observable behavior if both branches still return the same `health_action` string.

Oracle: existing `list_model_classes` tests assert unknown, healthy, and unhealthy model-health views include probe commands with the relevant model class. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced `healthAction` in `modelHealthForClass` and reused it in both unknown and cached-record views.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 14 - Single Timeout Reserve Calculation

Finding: `src/timeoutBudget.ts` computes `responseHeadroomMs + killGraceMs + forceGraceMs` separately in `computeTimeoutBudget` and `minimumRequestedTimeoutMs`. This is one timeout-reserve primitive duplicated across two exported timeout calculations, so future timeout accounting changes would have to stay synchronized manually.

Behavior check: extracting the sum into a pure helper should not change observable behavior if both callers pass the same resolved timeout options and the helper preserves the exact addition order and operands.

Oracle: existing timeout tests assert effective timeout, minimum requested timeout, hard caller caps, environment-derived timeout options, and timeout metadata surfaced through MCP runs. No new pinning test is needed for this helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `reservedTimeoutMs` and reused it from both `computeTimeoutBudget` and `minimumRequestedTimeoutMs`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/timeout-budget.test.ts tests/validation.test.ts tests/run-subagent.test.ts tests/session.test.ts tests/failure-log.test.ts` passed; targeted tests passed 91/91.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 15 - Single Terminal Input Status Projection

Finding: `requestStatus` in `src/inputMailbox.ts` repeats the same terminal-record projection shape for `answered`, `timed_out`, and `closed`: return the terminal status, copy `settled_at`, and expose one status-specific timestamp alias. This is internal view-shaping duplication for one persisted terminal record format.

Behavior check: extracting the projection into a helper should not change observable behavior if it preserves the exact returned object shapes for valid terminal statuses and preserves the current malformed-terminal fallback to legacy `.answer.json` / `.timed_out.json` markers.

Oracle: existing input mailbox and run lifecycle tests cover answered, timed-out, closed, duplicate-settlement, legacy marker, filtering, and close-pending behavior. No new pinning test is needed if the helper deliberately returns `null` for unknown terminal statuses so the legacy fallback path remains intact.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `terminalStatusView` and reused it from `requestStatus`, returning `null` for unknown terminal statuses so legacy marker fallback remains unchanged.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/input-mailbox.test.ts tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 16 - Single Observed Coverage Metadata Pass

Finding: `coverageSummary` in `scripts/run-observed-mcp-probe.mjs` maps selected scenarios once to attach static registry metadata, then immediately maps the result again to attach call-derived evidence fields. This creates two passes and one intermediate metadata shape for one coverage-summary projection.

Behavior check: combining the two maps should not change observable behavior if each output entry keeps the same field order and values: `scenario`, registry fields, `evidence_class`, `evidence_satisfied`, and `observed_result`.

Oracle: existing observed campaign tests assert `full-current` coverage, covered/missing surfaces, per-scenario tool metadata, evidence classes, evidence satisfaction, and redaction observed results. No new pinning test is needed for this projection-only simplification.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: combined the two `coverageSummary` metadata maps into one pass while preserving the emitted scenario metadata fields.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 17 - Single Process Force-Finish Delay

Finding: `runChildProcess` in `src/processRunner.ts` computes `options.timeoutBudget.killGraceMs + options.timeoutBudget.forceGraceMs` separately in timeout escalation and cancellation escalation. This is one force-finish delay for the same child-termination sequence, duplicated across the two stop paths.

Behavior check: storing the delay once inside the process run should not change observable behavior if the `SIGTERM`, `SIGKILL`, and forced `finish(null)` order stays unchanged and both stop paths still use the same timeout-budget values.

Oracle: existing timeout and run lifecycle tests cover child timeout, forced process cleanup, cancellation status/events, heartbeat cleanup after timeout, and timeout metadata. No new pinning test is needed for this expression-level reuse.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced one local `forceFinishDelayMs` in `runChildProcess` and reused it for both timeout and cancellation forced-finish timers.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/timeout-budget.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 48/48.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 18 - Single Server Heartbeat Options Adapter

Finding: `src/server.ts` repeats the same task heartbeat options object in five MCP handlers: `heartbeat: heartbeatFromExtra(extra)` plus `heartbeatIntervalMs: heartbeatIntervalMsFromEnv()`. This is one server-to-task adapter duplicated across durable, one-shot, and session tool registrations.

Behavior check: extracting the object construction into a helper should not change observable behavior if the helper is called inside each handler, preserving per-call lookup of `extra` and the heartbeat interval environment value.

Oracle: existing MCP run lifecycle and timeout tests cover run tool registration, durable starts, one-shot timeout recovery, session starts, heartbeat progress, and heartbeat interval environment parsing. No new pinning test is needed for this adapter extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `taskHeartbeatOptions` and reused it from the five server handlers that start one-shot, durable, scheduled, or session tasks.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/session.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 19 - Single Run Task Heartbeat Callback Adapter

Finding: `src/runTask.ts` repeats the same child heartbeat callback wrapper in `startRunTask`, `startSessionRunTask`, and `runSubagentOneShotTask`: call `handleTaskHeartbeat(state, beat, message, options.heartbeat)`. The heartbeat transition and snapshot behavior is already centralized, but each launch path still hand-rolls the adapter passed to child/session execution.

Behavior check: extracting the wrapper into a helper should not change observable behavior if each caller still creates the callback inside its task closure, closes over the same `state`, forwards the same optional heartbeat notifier, and preserves the same returned promise.

Oracle: existing run lifecycle and timeout tests cover heartbeats, active progress transitions, snapshot writes, one-shot timeout recovery, session task startup, and heartbeat cleanup. No new pinning test is needed for this adapter-only simplification.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `taskHeartbeatHandler` and reused it from the three run task launch paths that pass heartbeat callbacks to child or session execution.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/session.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 20 - Single Observed Campaign State Path Set

Finding: `scripts/run-observed-campaign.mjs` derives campaign state paths in scattered places: `failureLogPath` and `campaignLedgerPath` locals, then repeated `path.join(stateRoot, ...)` expressions inside the child environment, then reads those env fields back into the JSON summary. This is one campaign state-path set split across construction and reporting.

Behavior check: collecting the paths into one local object should not change observable behavior if configured failure-log and campaign-ledger overrides still resolve the same way, directories are created before use, child environment variables keep the same values, and the JSON summary keeps the same field names and values.

Oracle: existing observed campaign tests assert isolated default paths, production failure-log preservation, child env equality with summary fields, campaign ledger use, and archive behavior. No new pinning test is needed for this harness-internal path projection.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced one `statePaths` object in `run-observed-campaign.mjs` and reused it for campaign environment variables and JSON summary fields.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 21 - Single Archive Private-Path Normalization

Finding: `classifyCwd` in `scripts/archive-failure-log.mjs` repeats the same `/private/` prefix normalization for both the candidate cwd and `os.tmpdir()` before classifying temp-directory failure records. This is one path normalization rule duplicated inside a single classifier.

Behavior check: extracting the normalization into a helper should not change observable behavior if both paths are still passed through `path.normalize` first and the helper preserves the exact `/private/` stripping condition.

Oracle: archive tests exercise temp cwd records but did not assert the `by_cwd_class.temp` bucket directly. Add a focused assertion to the existing archive summary test, then patch minimally. If any test fails, revert this loop and do not retry it.

Decision: patch minimally after adding the missing pinning assertion.

Patch: added `withoutPrivatePrefix`, reused it for normalized cwd and temp paths, and added an archive summary assertion for `by_cwd_class.temp`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/archive-failure-log.test.ts` passed; targeted tests passed 5/5.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 22 - Single Enum-Like Request Choice Validator

Finding: `src/validate.ts` repeats the same pattern in `validateModelClass`, `validateOutputMode`, and `validateToolProfile`: trim an optional string, apply an optional default, check membership in an allowed string list, and emit `<field> must be one of: ...`. This is one request-choice validation primitive duplicated across three public input fields.

Behavior check: extracting a helper should not change observable behavior if each caller keeps the same field name, allowed choices, default value, returned type, and exact error message text.

Oracle: existing validation and MCP tests assert invalid model_class, output_mode/tool_profile failure classification, defaults, schema preflight behavior, and resolved request fields. No new pinning test is needed for this validation-helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `validateChoice` and reused it for `model_class`, `output_mode`, and `tool_profile` validation.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts tests/failure-log.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 73/73.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 23 - Single Skill Ambiguity Error Message

Finding: `resolveRequestedSkill` in `src/skillResources.ts` repeats the exact same ambiguity error message for loader diagnostics and duplicate skill matches. This is one user-facing ambiguity contract duplicated across two detection paths.

Behavior check: extracting the message into a helper should not change observable behavior if both branches still throw `Error` with the same `JSON.stringify(skillName)` formatting and text.

Oracle: existing skill-resource tests assert unknown skill behavior and ambiguous skill rejection. No new pinning test is needed for this message-helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `ambiguousSkillError` and reused it for both skill ambiguity detection paths.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/skill-resources.test.ts` passed; targeted tests passed 3/3.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 24 - Single Observed Surface Set Projection

Finding: `coverageSummary` in `scripts/run-observed-mcp-probe.mjs` computes the same product-surface complement twice for `optional_surfaces` and `out_of_scope_surfaces`, and computes the same uncovered-surface complement twice for `skipped_surfaces` and `uncovered_surfaces`. These are paired legacy/current output names for two surface sets, but the underlying set construction is duplicated.

Behavior check: reusing local arrays should not change observable behavior if the emitted JSON keeps the same field names, field order, and values. The arrays are constructed and immediately returned without later mutation.

Oracle: existing observed campaign tests assert coverage summary fields including `uncovered_surfaces` and `missing_required_surfaces`, and the full campaign summary shape is exercised through the probe harness. No new pinning test is needed for this projection-only simplification.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced `optionalSurfaces` and `uncoveredSurfaces` locals in `coverageSummary`, then reused them for the paired legacy/current summary fields.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 25 - Single Config Migration Unrepairable Result Envelope

Finding: `scripts/migrate-config.mjs` hand-builds the same `unrepairable_model_class` JSON envelope in three branches: invalid canonical class, missing/incomplete legacy pair, and unsupported legacy pair. Each branch differs only in the model-detail fields inserted between `config_path` and `allowed_model_classes`.

Behavior check: extracting the envelope should not change observable behavior if the helper preserves the exact `status`, `config_path`, detail fields, and `allowed_model_classes` values and insertion order for `JSON.stringify`.

Oracle: existing config migration tests cover the invalid legacy-pair and unsupported-model branches, but they do not directly pin the shared `allowed_model_classes` contract. Add one focused assertion before the helper extraction, then run the config migration tests.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `unrepairableModelClassResult`, reused it from the three unrepairable migration branches, and pinned `allowed_model_classes` in the unsupported legacy-pair test.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/config-migrate.test.ts` passed; targeted tests passed 7/7.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 26 - Single Run Task Progress Projection

Finding: `activeProgressView` and `terminalProgressView` in `src/runTask.ts` duplicate the same public progress fields: last progress timestamp/message, heartbeat count, active phase, phase timestamp, recent events, and optional public-output excerpt. They differ only in the source of `elapsed_ms`.

Behavior check: extracting a shared projection should not change observable behavior if both callers keep the same `elapsed_ms` value and the returned public task view preserves the same field names, insertion order, and optional-field omission rules.

Oracle: existing run lifecycle, timeout, session, and input mailbox tests assert active progress, terminal snapshots, heartbeat counts, recent events, timeout metadata, and restart snapshots. No new pinning test is needed for this projection-only extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced `RunTaskProgressView` and `progressView`, then reused the shared projection from active and terminal task views while leaving each caller's `elapsed_ms` calculation unchanged.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/session.test.ts tests/input-mailbox.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 64/64.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 27 - Single Transcript Input Request Id Projection

Finding: `publicLineForEvent` in `src/transcript.ts` repeats the same request-id fallback expression in the three input-event branches: `input_request`, `input_timed_out`, and `input_closed`. This is one transcript projection primitive duplicated across three public input status lines.

Behavior check: extracting the request-id projection should not change observable behavior if missing or non-string request ids still render as `unknown` and each branch keeps the same text, kind, and event values.

Oracle: existing run lifecycle and input mailbox tests cover pending input, input timeouts, input closure, public events, transcript redaction, and late-answer handling. No new pinning test is needed for this expression-only extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `eventRequestId` and reused it for input-required, input-timeout, and input-closed transcript event rendering.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/input-mailbox.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 53/53.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 28 - Single Input Request Settlement Status View

Finding: `src/inputMailbox.ts` builds the same public settlement status view in two places: `terminalStatusView` for terminal records and `requestStatus` for legacy `.answer.json` / `.timed_out.json` markers. The answered and timed-out branches duplicate the `status`, `settled_at`, and status-specific timestamp shape.

Behavior check: extracting the status-view construction should not change observable behavior if answered, timed-out, and closed records keep the same field names, insertion order, and omission rules, and unknown terminal statuses still fall back to legacy marker checks.

Oracle: existing input mailbox tests cover answered, timed-out, closed, duplicate settlement, filtering by status, and legacy answer/timeout markers. No new pinning test is needed for this projection-only extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `InputRequestStatusView` and `settlementStatusView`, then reused the shared projection from terminal records and legacy answer/timeout marker handling.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/input-mailbox.test.ts tests/run-subagent.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 53/53.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 29 - Single Failure-Log Private-Path Normalization

Finding: `classifyFailureCwd` in `src/failureLog.ts` repeats the same `/private/` prefix normalization for both the candidate cwd and `os.tmpdir()` before classifying temp-directory failure records. This is one path-normalization rule duplicated inside production failure telemetry.

Behavior check: extracting the normalization into a helper should not change observable behavior if both paths are still passed through `path.normalize` first and the helper preserves the exact `/private/` stripping condition.

Oracle: existing failure-log tests assert temp cwd classification for generated failure records. No new pinning test is needed for this local classifier extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `withoutPrivatePrefix` in `failureLog.ts` and reused it for normalized cwd and temp paths.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts` passed; targeted tests passed 13/13.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 30 - Single Session Enum Choice Validator

Finding: `validateResumeMode` and `validateSessionPacketPolicy` in `src/session.ts` repeat the same defaulted enum validation pattern: accept `undefined` as a field-specific default, require a string in an allowed list, and emit `<field> must be one of: ...`.

Behavior check: extracting a local session-choice validator should not change observable behavior if each caller keeps the same default, allowed choices, returned type, and exact error message text.

Oracle: existing session tests cover valid defaults and valid non-default packet/resume flows, but they do not directly pin invalid `resume_mode` and `packet_policy` messages. Add focused preflight assertions for those public validation contracts before extracting the helper.

Decision: patch minimally after adding the missing pinning assertions. If any test fails, revert this loop and do not retry it.

Targeted oracle result: failed at `npm run typecheck`. The proposed pinning tests used direct typed casts for intentionally invalid `resume_mode` and `packet_policy` values, producing TypeScript TS2352 errors before runtime assertions could execute.

Reversion: reverted the `validateSessionChoice` helper and the invalid-choice tests. Do not retry this session enum validator extraction in this campaign.

## Loop 31 - Single Run Failure Classification Calculation

Finding: `runSubagentCore` in `src/runSubagent.ts` repeats the same failure classification decision inside the `logFailure` call: timeout, missing fresh session id, otherwise `failureClassForProcessResult(result)`. The same classification primitive feeds both `failure_class` and `reason_code`.

Behavior check: extracting the classification into locals should not change observable behavior if the log record still receives the same `failure_class`, same `reason_code`, and same field insertion order.

Oracle: existing failure-log and run-subagent tests assert nonzero-exit, missing-session-id, timeout, and unknown validation failure records. No new pinning test is needed for this local failure-log projection.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced `failureClass` and `reasonCode` locals in `runSubagentCore` and reused them in the failure log record.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/run-subagent.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 61/61.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 32 - Single Observed Failure Delta Set Projection

Finding: `runCall` in `scripts/run-observed-mcp-probe.mjs` repeats the same failure-log delta set projection for `failure_classes`, `reason_codes`, and `tools`: map a field, filter empty values, de-duplicate with `Set`, and sort.

Behavior check: extracting this projection should not change observable behavior if the emitted ledger record keeps the same field names, field order, and sorted string arrays.

Oracle: existing observed campaign tests assert `failure_log_delta` records and check reason-code and failure-class arrays for handler validation and child failures. No new pinning test is needed for this helper extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `uniqueRecordValues` and reused it for `failure_classes`, `reason_codes`, and `tools` in observed failure-log delta ledger records.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 33 - Reuse Default Model Health Probe Command

Finding: `listModelClassesResult` in `src/server.ts` calls `modelHealthForClass(defaultModelClass)` to build `defaultOneShotHealth`, whose public view already includes the probe command, then separately calls `modelHealthProbeCommand(defaultModelClass)` for `model_health_probe_command`. This recomputes the same command string in one response projection.

Behavior check: reusing `defaultOneShotHealth.health_action` should not change observable behavior because `modelHealthForClass` constructs that field from `modelHealthProbeCommand(defaultModelClass)` before reading cached health state.

Oracle: existing `list_model_classes` tests assert model health actions, default health status/basis, and the top-level probe command. No new pinning test is needed for this projection-only reuse.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Targeted oracle result: failed at `npm run typecheck`; replacing the top-level probe command with `defaultOneShotHealth.health_action` left the `modelHealthProbeCommand` import unused in `src/server.ts`.

Reversion: reverted the server change. Do not retry this default model-health command reuse in this campaign.

## Loop 34 - Single Observed Run Subagent Call Builder

Finding: `scenarioCall` in `scripts/run-observed-mcp-probe.mjs` repeats the same `run_subagent` request skeleton across successful, validation, child-failure, transcript-redaction, timeout-recovery, and installed-Pi scenarios: `tool: "run_subagent"` plus `cwd`, `prompt`, and `run_kind: "quick_noninteractive"`.

Behavior check: extracting a small `runSubagentScenarioCall` helper should not change observable behavior if each scenario keeps the same argument keys, insertion order, and optional scenario-specific fields such as `output_mode`.

Oracle: existing observed campaign tests exercise the affected scenarios, assert call attempts and redaction, and inspect ledger argument-shape presence. No new pinning test is needed for this scenario-call construction helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `runSubagentScenarioCall` and reused it for the observed probe scenarios that call `run_subagent`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 35 - Single Run Task Terminal Event Projection

Finding: `appendTerminalEvent` in `src/runTask.ts` computes the terminal event name and terminal event text with parallel conditionals over the same result state: cancelled, timeout, completed, or failed. This is one public terminal-event projection split into two decision trees.

Behavior check: extracting the projection should not change observable behavior if each terminal result still emits the same `event`, `text`, and progress message, and the public event object keeps the same field order.

Oracle: existing run lifecycle, timeout, session, and cancellation tests assert terminal phases, timeout/cancellation event counts, packet terminal events, and completed/failed run views. No new pinning test is needed for this local projection extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `terminalEventDetails` and reused it when appending result-backed terminal run-task events.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts tests/session.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 36 - Single Run Task Terminal State Projection

Finding: after Loop 35, `appendTerminalEvent` uses `terminalEventDetails` for terminal event name, text, and progress message, but still calls `terminalPhase` to reclassify the same terminal result into an active phase. This leaves one terminal-state projection split across two helpers.

Behavior check: folding the active phase into `terminalEventDetails` should not change observable behavior if cancelled still maps to `cancellation_settled`/`cancelled`, timeout still maps to `timeout`/`timed_out`, success still maps to `completed`/`completed`, and other failures still map to `failed`/`failed`.

Oracle: existing run lifecycle, timeout, session, and cancellation tests assert terminal `status`, `active_phase`, terminal events, timeout events, and cancellation-settled events. No new pinning test is needed for this local projection consolidation.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: folded terminal active phase into `terminalEventDetails` and removed the separate `terminalPhase` helper.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts tests/session.test.ts` passed; targeted tests passed 59/59.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 37 - Shared Child Termination Mechanics

Finding: `runChildProcess` handles timeout and cancellation with duplicated mechanics after setting their distinct state: append a control marker to output, emit each marker line through the best-effort public output callback, send SIGTERM, then schedule SIGKILL and forced finish using the same grace timers.

Behavior check: extracting only those shared mechanics should not change observable behavior if timeout still sets `timedOut`, cancellation still sets `cancelled`, marker text and line emission order stay the same, and the same timers are assigned after SIGTERM.

Oracle: existing timeout-budget tests cover timeout markers, cancellation markers through run-task cancellation paths, stop reasons, forced timeout cleanup, and heartbeat timer cleanup. No new pinning test is needed for this local process-runner mechanics extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `appendControlMarker` and `startGracefulTermination` inside `runChildProcess`, then reused them for timeout and cancellation termination paths.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/timeout-budget.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 48/48.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 38 - Single Session Failure Classification Projection

Finding: `failureClassForSessionResult` and `failureReasonCodeForSessionResult` in `src/failureLog.ts` duplicate the same ordered session failure classification: timeout, nonzero exit, missing session, unsatisfied packet, otherwise unknown. The two exported functions project different fields from one classification.

Behavior check: extracting a private session failure projection should not change observable behavior if the exported functions remain available, keep the same precedence, and return the same packet reason split between `packet_required_missing` and `packet_required_invalid`.

Oracle: failure-log tests assert session missing-id and packet-invalid records, while session tests exercise missing packet and non-ready packet session failures. No new pinning test is needed for this private projection extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a private `sessionFailureProjection` helper and kept `failureClassForSessionResult` and `failureReasonCodeForSessionResult` as wrappers over it.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/session.test.ts` passed; targeted tests passed 24/24.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 39 - Single Snapshot Public Excerpt Projection

Finding: `loadSnapshotEvents` in `src/runTask.ts` calls `publicOutputExcerptProjection(events)` twice while building the same persisted snapshot event projection. The projection is pure and should be calculated once.

Behavior check: storing the excerpt in a local should not change observable behavior if snapshots with events still return the same `recent_events` and include `last_public_output_excerpt` only when the projected excerpt is truthy.

Oracle: existing run-task restart and sanitized active event tests cover snapshot event projection and public-output excerpt behavior. No new pinning test is needed for this local pure-projection reuse.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: stored `publicOutputExcerptProjection(events)` in `lastPublicOutputExcerpt` and reused it when returning snapshot event projection.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 41/41.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 40 - Single Session Failure Input View

Finding: after Loop 38, `runSubagentSession` still constructs the same `{ ...result, session_established: attemptSessionEstablished }` object twice when passing session failure input to `failureClassForSessionResult` and `failureReasonCodeForSessionResult`.

Behavior check: storing this failure input view in a local should not change observable behavior because the same object shape and values are passed to the same exported failure-log projection wrappers.

Oracle: failure-log and session tests cover session failure records for missing session, packet failure, timeout, and non-ready packet resumes. No new pinning test is needed for this local duplicate construction removal.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced a `failureInput` local in `runSubagentSession` and reused it for session failure class and reason-code projection.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/session.test.ts` passed; targeted tests passed 24/24.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 41 - Exact Transcript Text Part Narrowing

Finding: `textPartsFromContent` in `src/transcript.ts` filters content parts by proving each retained part has `type === "text"` and a string `text`, but the TypeScript predicate still returns a weaker optional shape and the following `map` keeps a dead `?? ""` fallback.

Behavior check: tightening the predicate to `{ type: "text"; text: string }` and mapping `part.text` directly should not change observable behavior because the runtime filter condition is unchanged.

Oracle: existing run-subagent transcript tests cover assistant text extraction, redaction, warning/error flags, timeout/cancellation markers, and public transcript availability. No new pinning test is needed for this type-narrowing cleanup.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: tightened the `textPartsFromContent` type predicate to the exact retained text-part shape and removed the unreachable `?? ""` fallback.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/observed-campaign.test.ts` passed; targeted tests passed 55/55.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 42 - Shared Observed Poll Completion Predicate

Finding: `responseMatchesResultClass` in `scripts/run-observed-mcp-probe.mjs` repeats the same `success === true`, `status === "completed"`, and `polled === true` predicate for both `async_polling` and `scheduled_durable`; the scheduled case only adds `scheduled === true`.

Behavior check: extracting that shared predicate should not change observable behavior if `async_polling` still requires only the completed-polled predicate and `scheduled_durable` still requires completed-polled plus scheduled.

Oracle: observed-campaign tests cover async polling, scheduled durable scenarios, scenario evidence satisfaction, and full-current coverage. No new pinning test is needed for this local predicate extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a `completedAfterPolling` local in `responseMatchesResultClass` and reused it for `async_polling` and `scheduled_durable`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 43 - Direct Config Normalization Return

Finding: `normalizeConfigRecord` in `src/config.ts` creates a mutable `RunnerConfig` object only to optionally assign `default_model_class` in either the canonical or legacy migration path. No other fields are accumulated.

Behavior check: returning the canonical, migrated, or empty config object directly should not change observable behavior if supported canonical configs still win over legacy fields, supported legacy pairs still map to the same class, and unsupported or missing config still returns `{}`.

Oracle: validation tests cover canonical config defaults, raw record preservation, legacy migration, malformed legacy config, unsupported model classes, and missing config. No new pinning test is needed for this local accumulator removal.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed the mutable config accumulator and returned canonical, migrated, or empty config objects directly.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts tests/config-migrate.test.ts` passed; targeted tests passed 26/26.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 44 - Boolean Broad Work Predicate

Finding: `oneShotIncompatibilityReason` in `src/validate.ts` assigns `firstBroadPattern` from `ONE_SHOT_BROAD_WORK_PATTERNS.find(...)` but only uses its truthiness. The matched pattern itself is dead.

Behavior check: replacing `find(...)` plus a truthy check with `some(...)` should not change observable behavior because both stop at the first matching regex and return the same broad-work rejection message.

Oracle: run-subagent tests cover broad one-shot prompt rejection before child spawn and durable schedule-run acceptance for broad work. No new pinning test is needed for this local boolean predicate cleanup.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: replaced the unused `firstBroadPattern` `find(...)` result with a direct `some(...)` boolean check.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 60/60.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 45 - Direct Empty Public Excerpt Check

Finding: `publicOutputExcerptProjection` in `src/runEvents.ts` filters event text with `value.trim() !== ""` before joining, then checks `text.trim() === ""`. After that filter, the joined string can only trim to empty when the joined string is exactly empty.

Behavior check: replacing the post-join trim check with `text === ""` should not change observable behavior because every retained segment already contains non-whitespace text.

Oracle: run-subagent and timeout tests cover recent public events, timeout/cancellation public events, raw-event redaction, and `last_public_output_excerpt` projection. No new pinning test is needed for this pure helper cleanup.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: replaced the redundant `text.trim() === ""` post-join check with `text === ""` in `publicOutputExcerptProjection`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 48/48.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 46 - Shared Mailbox Sidecar Path Projection

Finding: `answerPathFor`, `timeoutPathFor`, and `terminalPathFor` in `src/inputMailbox.ts` repeat the same `recordPath.replace(/\.json$/, ...)` sidecar path projection, differing only by the sidecar suffix.

Behavior check: extracting a private sidecar path helper should not change observable behavior if `.answer.json`, `.timed_out.json`, and `.terminal.json` paths are still produced by replacing the trailing `.json` suffix exactly as before.

Oracle: mailbox tests cover answer settlement, timeout settlement, terminal settlement, closed settlement, duplicate rejection, and legacy `.answer.json`/`.timed_out.json` markers. No new pinning test is needed for this local path projection extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `sidecarPathFor` and reused it for answer, timeout, and terminal mailbox sidecar paths.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/input-mailbox.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 46/46.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 47 - Named Mailbox Request File Predicate

Finding: `listInputRequests` in `src/inputMailbox.ts` embeds the primary request-record file predicate inline: require a regular `.json` file while excluding `.answer.json`, `.timed_out.json`, `.terminal.json`, and temporary files. This file-kind rule is a single reusable mailbox primitive, not loop control.

Behavior check: extracting the predicate should not change observable behavior if the exact same filename checks remain in the same truth conditions.

Oracle: mailbox tests cover listing pending, answered, timed-out, closed, and legacy sidecar files, and run-subagent tests cover input closure through task views. No new pinning test is needed for this local predicate extraction.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: extracted `isRequestRecordFile` and reused it in `listInputRequests`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/input-mailbox.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 46/46.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 125/125.

## Loop 48 - Single Timeout Validation Reason Branch

Finding: `failureReasonCodeForError` in `src/failureLog.ts` has two adjacent branches returning `invalid_timeout_ms`: one for "timeout_ms must be at least" and one for "timeout_ms must be a positive integer". They are one reason-code classification with two message patterns.

Behavior check: combining those adjacent predicates should not change observable behavior if both messages still map to `invalid_timeout_ms` and the later `timeout_ms is not supported by run_subagent` branch still maps to `run_subagent_timeout_unsupported`.

Oracle: existing tests cover the function but only directly assert tool-profile mapping. Add focused reason-code assertions for both invalid-timeout messages before combining the duplicate branches.

Decision: patch minimally after adding the missing pinning assertions. If any test fails, revert this loop and do not retry it.

Patch: added direct invalid-timeout reason-code assertions and combined the adjacent invalid-timeout message predicates in `failureReasonCodeForError`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/validation.test.ts` passed; targeted tests passed 33/33.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 126/126.

## Loop 49 - Direct Empty Transcript Message Check

Finding: `eventMessageLine` in `src/transcript.ts` joins the output of `textPartsFromContent`, which already filters out text parts whose trimmed content is empty, then checks `text.trim() === ""`. After that upstream filter, the joined string can only be empty when no text parts remain.

Behavior check: replacing the post-join trim check with `text === ""` should not change observable behavior because every retained text part already contains non-whitespace content.

Oracle: run-subagent transcript tests cover assistant and user message extraction, public content flags, truncation behavior, timeout/cancellation markers, and transcript redaction. No new pinning test is needed for this pure transcript helper cleanup.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: replaced the redundant `text.trim() === ""` post-join check with `text === ""` in `eventMessageLine`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/observed-campaign.test.ts` passed; targeted tests passed 55/55.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 126/126.

## Loop 50 - Named Session Manifest Drift Predicates

Finding: `runSubagentSession` computes `model_changed_from_manifest` and `thinking_level_changed_from_manifest` inline inside the public result object. The predicates are session-manifest drift rules, not result-shape construction, and one embeds the legacy manifest fallback through `modelRefForComparison`.

Behavior check: extracting the predicates should not change observable behavior if null manifests still produce `false`, current class-based manifests still compare `initial_model_class` to the resolved model class, legacy manifests without `initial_model_class` still compare normalized `initial_model` to the resolved model, and thinking-level drift still compares `initial_thinking_level` directly.

Oracle: the existing session test already covers the true class-based drift case. Add pinning assertions for the null-manifest false case and the legacy no-class false fallback before extracting the predicates.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added pinning assertions for null-manifest and legacy no-class manifest drift behavior, then extracted `modelChangedFromManifest` and `thinkingLevelChangedFromManifest`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/session.test.ts` passed; targeted tests passed 11/11.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 126/126.

## Loop 51 - Remove Redundant Schedule Wait Finiteness Check

Finding: `scheduleWaitMs` in `src/runTask.ts` rejects invalid wait values with `typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0`. `Number.isInteger` already rejects non-numbers, `NaN`, and infinities, making the explicit type and finiteness checks redundant.

Behavior check: replacing the predicate with `!Number.isInteger(value) || value < 0` should not change observable behavior because all previously rejected non-number, fractional, negative, `NaN`, and infinite values still reject with the same `ValidationError` message, while nonnegative integers still pass.

Oracle: existing MCP schedule tests cover valid wait behavior but do not directly pin invalid exported-task validation. Add direct `scheduleRunTask` invalid `wait_ms` assertions before simplifying the predicate.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Targeted oracle result: failed at `npm run typecheck` before tests. TypeScript does not narrow `unknown` to `number` after `Number.isInteger(value)`, producing `TS2365` on `value < 0` and `TS2322` on returning `value`.

Revert: reverted the `scheduleWaitMs` predicate simplification and the added invalid-wait test. Do not retry this candidate as-is.

## Loop 52 - Use Canonical Model Class List In Health Validation

Finding: `assertRecord` in `src/modelHealth.ts` validates health-record `model_class` with a duplicated literal `["A", "B", "C", "D", "E"]` instead of the canonical `MODEL_CLASSES` constant used elsewhere.

Behavior check: replacing the literal with `MODEL_CLASSES` should not change observable behavior because the constant currently contains the same ordered set and the existing `String(record.model_class)` coercion can be preserved.

Oracle: existing MCP model-health tests cover valid cached health records. Add a direct invalid health-record assertion before replacing the duplicate literal.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a direct invalid model-health-record assertion and replaced the duplicated model-class literal in `assertRecord` with `MODEL_CLASSES`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 61/61.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 127/127.

## Loop 53 - Use Model-Class Choices In Health Probe Script

Finding: `scripts/probe-model-health.mjs` defines its own `new Set(["A", "B", "C", "D", "E"])` even though it already imports the built model allowlist module that exposes `modelClassChoices()`.

Behavior check: using `modelClassChoices()` for the accepted CLI classes should not change observable behavior if the same classes and the same comma-separated invalid-class error text are preserved.

Oracle: no direct test currently executes `scripts/probe-model-health.mjs`. Add focused CLI tests for invalid `--model-class` rejection and direct healthy record mode before replacing the duplicate set.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added focused `model-health-probe` CLI tests and replaced the duplicate script-local model-class set with `modelClassChoices()`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/model-health-probe.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 129/129.

## Loop 54 - Use Canonical Model Class Enum In Session Schemas

Finding: `src/session.ts` still duplicates model-class choices in `sessionManifestSchema.initial_model_class` and `sessionRunRecordSchema.resolved_model_class` as `z.enum(["A", "B", "C", "D", "E"])` instead of using the canonical `MODEL_CLASSES` tuple.

Behavior check: replacing both schema literals with `z.enum(MODEL_CLASSES)` should not change observable behavior because `MODEL_CLASSES` currently contains the same ordered values and is already accepted by other Zod schemas in `src/server.ts`.

Oracle: existing session tests cover valid manifest and ledger records. Add direct invalid persisted manifest and ledger model-class assertions before replacing the schema literals.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added invalid persisted manifest and ledger model-class assertions, then replaced both session schema model-class literals with `z.enum(MODEL_CLASSES)`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/session.test.ts` passed; targeted tests passed 11/11.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 129/129.

## Loop 55 - Cache Model-Class Choices In Config Migration CLI

Finding: `scripts/migrate-config.mjs` calls `modelClassChoices()` separately for the allowed-classes display and canonical `default_model_class` validation. The valid class set is one CLI invariant and does not need repeated projection.

Behavior check: caching `modelClassChoices()` in a local constant should not change observable behavior if the same choices are used for `.join(", ")` and `.includes(...)`, preserving the same invalid-class JSON field and exit behavior.

Oracle: `tests/config-migrate.test.ts` directly covers unsupported class reporting, canonical class no-op, whitespace migration, legacy pair migration, and missing/invalid config behavior. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: cached `modelClassChoices()` in `MODEL_CLASS_CHOICES` and reused it for migration allowed-class rendering and validation.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/config-migrate.test.ts` passed; targeted tests passed 7/7.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 129/129.

## Loop 56 - Share Observed Probe Profile Selection

Finding: `scripts/run-observed-mcp-probe.mjs` repeats the same profile-selection assignments in `--profile` handling and the `--scenario all` alias path: set `options.profile`, `options.scenarioSet`, and `options.mode` from `MANIFEST.profiles[profile]`.

Behavior check: extracting those assignments into a local helper should not change observable behavior if `--profile` still validates aliases before selecting, `--scenario all` still appends the full-current scenarios, and both paths keep the same mode and scenario-set values.

Oracle: `tests/observed-campaign.test.ts` directly covers `--scenario all` mapping to `full-current`, live profile aliases, retired alias rejection, mode compatibility, and full-current coverage. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `selectProfile` and reused it for `--profile` and `--scenario all` profile assignment.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 129/129.

## Loop 57 - Share Retired Observed Probe Alias Guard

Finding: `scripts/run-observed-mcp-probe.mjs` repeats the same retired `all-bundled` alias guard and message in both `--profile` and `--scenario` parsing.

Behavior check: extracting a local `assertNotRetiredAlias` helper should not change observable behavior if both flags still reject `all-bundled` with the same `RETIRED_BUNDLED_ALIAS_MESSAGE` before any ordinary alias/profile/scenario resolution.

Oracle: `tests/observed-campaign.test.ts` directly covers retired alias rejection for both `--profile all-bundled` and `--scenario all-bundled`. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `assertNotRetiredAlias` and reused it for `--profile` and `--scenario` parsing.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 129/129.

## Loop 58 - Reuse Choice Validation For Continuity Mode

Finding: `src/validate.ts` manually trims and checks `continuity.mode` against `RUN_CONTINUITY_MODES`, duplicating the shared `validateChoice` helper used by the other enum-like request fields.

Behavior check: replacing the manual membership check with `validateChoice(continuity.mode, "continuity.mode", RUN_CONTINUITY_MODES)` should not change observable behavior if missing/blank/invalid modes still produce `continuity.mode must be one of: ephemeral, fresh, resume`, non-string modes still produce `continuity.mode must be a string`, and valid resume/fresh behavior is preserved.

Oracle: existing validation tests cover valid `fresh`, valid `resume`, resume file errors, and illegal session IDs. Add a focused invalid `continuity.mode` assertion before replacing the manual check.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added an invalid `continuity.mode` pinning assertion and reused `validateChoice` for continuity mode parsing.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts` passed; targeted tests passed 20/20.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 129/129.

## Loop 59 - Share Session Enum Validation

Finding: `src/session.ts` has two near-identical enum validators, `validateResumeMode` and `validateSessionPacketPolicy`, each checking `undefined`, string type, membership, and rendering a `must be one of` error from the corresponding canonical tuple.

Behavior check: extracting a local `validateOptionalChoice` helper should not change observable behavior if `resume_mode` still defaults to `resume_or_new`, `packet_policy` still defaults to `none`, invalid values keep their exact error messages, and valid session/packet flows are unchanged.

Oracle: existing session tests cover valid resume modes and required packet policy behavior. Add focused invalid `resume_mode` and invalid `packet_policy` assertions before extracting the shared helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added invalid `resume_mode` and `packet_policy` pinning assertions, then introduced `validateOptionalChoice` for the two session enum fields.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/session.test.ts tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 67/67.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 130/130.

## Loop 60 - Reuse Shared State Path For Config

Finding: `src/config.ts` manually builds the same `~/.codex/subagent007-pi/<leaf>` state path shape already captured by `defaultSubagentStatePath` in `src/output.ts`.

Behavior check: replacing `defaultConfigPath` with `defaultSubagentStatePath("SUBAGENT007_CONFIG_PATH", "config.json")` should not change observable behavior if the default still resolves to `<homedir>/.codex/subagent007-pi/config.json` and explicit `SUBAGENT007_CONFIG_PATH` values are still resolved with `path.resolve`.

Oracle: add a direct pure path-construction assertion for default and env override behavior before replacing the manual implementation.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a default/env config path assertion and rewired `defaultConfigPath` through `defaultSubagentStatePath`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts tests/config-migrate.test.ts` passed; targeted tests passed 28/28.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 61 - Share Durable Task Close Reason

Finding: `src/runTask.ts` repeats the same durable-task finalization reason expression in both `startRunTask` and `startSessionRunTask`: cancelled tasks close as `run cancelled`, otherwise they close as `run reached a terminal state`.

Behavior check: extracting that expression into a local helper should not change observable behavior if durable run and durable session cancellation/final active-phase events still use the same close reason strings. The one-shot `runSubagentOneShotTask` finalizer is intentionally left unchanged because it is not the same cancellable durable surface.

Oracle: existing `tests/run-subagent.test.ts` covers durable `start_run` cancellation, durable session cancellation, terminal active phases, and running-silent transitions. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `durableTaskCloseReason` and reused it in `startRunTask` and `startSessionRunTask` finalizers.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts tests/failure-log.test.ts` passed; targeted tests passed 62/62.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 62 - Share Task Output Observer

Finding: `src/runTask.ts` repeats the same `onOutputLine: (line) => observeOutputLine(state, line)` adapter in durable run, durable session, and one-shot run child options.

Behavior check: extracting a local `taskOutputObserver(state)` helper should not change observable behavior if each launch still passes an async callback that records sanitized public events and excerpts through `observeOutputLine` for the same task state.

Oracle: existing `tests/run-subagent.test.ts` covers raw public event redaction, active public event projection, session packet events, answer redaction, and cancellation terminal events. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `taskOutputObserver` and reused it for durable run, durable session, and one-shot run child output callbacks.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts tests/failure-log.test.ts` passed; targeted tests passed 62/62.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 63 - Share Task Child Runtime Options

Finding: `src/runTask.ts` repeats the same child runtime option bundle in durable run, durable session, and one-shot run launch paths: task heartbeat handler, heartbeat interval, task abort signal, and task output observer.

Behavior check: extracting that bundle into a local helper should not change observable behavior if each child call still receives the same heartbeat notification wrapper, interval, abort signal, and output-line observer while keeping call-specific fields such as `failureLogTool`, `allowTimeout`, `runsDir`, `sessionsDir`, and mailbox IDs explicit.

Oracle: existing `tests/run-subagent.test.ts`, `tests/timeout-budget.test.ts`, and `tests/failure-log.test.ts` cover heartbeats, cancellation, timeout metadata, public events, durable session runs, and failure log behavior. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `taskChildRuntimeOptions` and reused it across durable run, durable session, and one-shot run child launches.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts tests/failure-log.test.ts` passed; targeted tests passed 62/62.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 64 - Share Observed Campaign Child Exit Wait

Finding: `scripts/run-observed-campaign.mjs` builds the same child-process `error`/`exit` promise in both `spawnAsync` and `archiveFailureLog`.

Behavior check: extracting a local `waitForChildExit(child)` helper should not change observable behavior if command exit codes/signals and archive child failures are still propagated exactly as before, with archive stdout/stderr capture left unchanged.

Oracle: `tests/observed-campaign.test.ts` covers harness command exit propagation and archive behavior. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `waitForChildExit` and reused it for the observed campaign command child and archive child.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts` passed; targeted tests passed 14/14.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 65 - Share Raw Session ID Schema Error

Finding: `src/server.ts` repeats the same Zod unrecognized-key predicate for raw `session_id` rejection in `startRunInputSchema` and `scheduleRunInputSchema`, with only the tool name differing in the message.

Behavior check: extracting the message predicate into a local helper should not change observable behavior if `start_run` still says `session_id is not a start_run input...` and `schedule_run` still says `session_id is not a schedule_run input...`.

Oracle: existing MCP tests cover the `start_run` raw `session_id` message. Add a focused `schedule_run` raw `session_id` assertion before extracting the helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a `schedule_run` raw `session_id` assertion and introduced `rawSessionIdSchemaError` for the two schema error callbacks.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 55/55.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 66 - Share Object Tool Result Projection

Finding: `src/server.ts` repeats `jsonToolResult(result, { ...result })` in preflight-aware handlers and run-scoped handlers whenever an object result should be returned as both formatted text and structured content.

Behavior check: extracting a local `jsonObjectToolResult` helper should not change observable behavior if the text remains `JSON.stringify(result, null, 2)` and structured content remains a shallow object copy of the same result.

Oracle: existing MCP tests cover successful object results, preflight rejection structured content, `get_run`, `answer_run_input`, and `cancel_run`. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `jsonObjectToolResult` and reused it in preflight-aware handlers and run-scoped object-result handlers.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 55/55.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 67 - Share Unrecognized-Key Schema Predicate

Finding: `src/server.ts` still repeats the Zod custom-error predicate shape `issue.code === "unrecognized_keys" && issue.keys.includes(...)` for `run_subagent` `timeout_ms`, run/schedule raw `session_id`, and session `continuity` rejection.

Behavior check: extracting a generic `unrecognizedKeySchemaError` helper should not change observable behavior if each schema still emits the same exact message for its unsupported key and returns `undefined` for all other issue kinds.

Oracle: existing MCP tests cover `run_subagent` `timeout_ms`, `start_run` raw `session_id`, and `schedule_run` raw `session_id`. Add a focused MCP assertion for `run_subagent_session` raw `continuity` before extracting the helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a `run_subagent_session` raw `continuity` MCP assertion and introduced `unrecognizedKeySchemaError` for the custom schema error callbacks.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 55/55.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 68 - Share Model-Class Tool Registration

Finding: `src/server.ts` registers `list_model_classes` and the compatibility alias `list_allowed_models` with the same title, empty input schema, failure-logging wrapper shape, and handler; only the tool name and description differ.

Behavior check: extracting a small registration helper should not change observable behavior if both tool names, titles, descriptions, schemas, failure-log tool ids, and payloads remain unchanged.

Oracle: existing MCP tests cover both tool names being exposed and `list_allowed_models` returning the same structured payload as `list_model_classes`, but they do not pin the listTools title/description metadata. Add those focused assertions before extracting the helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added listTools title/description assertions for `list_model_classes` and `list_allowed_models`, then introduced `registerModelClassListTool` for their shared registration shape.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 55/55.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 131/131.

## Loop 69 - Share Model-Health Nonempty Field Guard

Finding: `src/modelHealth.ts` repeats the same model-health record check for `resolved_model` and `checked_at`: each field must be a string and must not trim to empty, with only the field name changing in the error message.

Behavior check: extracting a local field guard should not change observable behavior if invalid `resolved_model` and invalid `checked_at` still produce the exact same `ValidationError` messages and valid records are still accepted.

Oracle: existing tests cover invalid model-health `model_class` but do not pin these two field messages. Add focused validation tests for empty `resolved_model` and empty `checked_at` before extracting the helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added invalid `resolved_model` and `checked_at` model-health assertions, then introduced `assertNonEmptyStringField` for the shared record-field guard.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts tests/model-health-probe.test.ts` passed; targeted tests passed 24/24.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 132/132.

## Loop 70 - Share Timestamped Random ID Segment

Finding: `src/output.ts` and `src/inputMailbox.ts` independently build the same timestamp-plus-12-hex-random id shape from `new Date().toISOString().replace(/[:.]/g, "")` and `randomBytes(6).toString("hex")`.

Behavior check: extracting the id segment builder should not change observable behavior if `newRunId()` still returns the same safe timestamped id shape and run output files still use the same basename shape with a `.md` suffix.

Oracle: existing tests exercise generated run ids and output files but do not pin their filename/id shape. Add focused assertions for `newRunId()` and `writeRunOutput()` before extracting the helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added run-id and output-basename shape assertions, then introduced `timestampedRandomId` and reused it for `newRunId()` and run output filenames.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/input-mailbox.test.ts tests/validation.test.ts tests/run-subagent.test.ts tests/failure-log.test.ts` passed; targeted tests passed 84/84.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 134/134.

## Loop 71 - Reuse Timestamped ID for Failure Events

Finding: after Loop 70, `src/failureLog.ts` still independently builds `event_id` from the same timestamp-plus-12-hex-random expression now centralized as `timestampedRandomId`.

Behavior check: reusing `timestampedRandomId()` should not change observable behavior if failure records still include the same event id shape and all failure-log fields remain unchanged.

Oracle: existing failure-log tests exercise records but do not pin `event_id`. Add a focused assertion for the event id shape before replacing the local builder.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added a failure-record `event_id` shape assertion and changed `eventId()` to delegate to `timestampedRandomId()`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts tests/validation.test.ts tests/input-mailbox.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 134/134.

## Loop 72 - Remove Script Timestamp Identity Replacement

Finding: `scripts/run-observed-campaign.mjs` and `scripts/archive-failure-log.mjs` both apply `.replace(/Z$/, "Z")` immediately after ISO timestamp colon/dot removal. Replacing `Z` with `Z` is a no-op for every possible string and adds semantic noise.

Behavior check: removing the identity replacement cannot change the timestamp string; the preceding `.replace(/[:.]/g, "")` remains unchanged.

Oracle: existing archive and observed-campaign tests exercise generated archive/campaign paths and timestamped outputs. No new pinning test is needed because the removed operation is algebraically identical.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed the identity `.replace(/Z$/, "Z")` call from both script timestamp helpers.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/archive-failure-log.test.ts tests/observed-campaign.test.ts` passed; targeted tests passed 19/19.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 134/134.

## Loop 73 - Share Transcript JSON Event Parsing

Finding: `src/transcript.ts` parses candidate JSON event lines in two places: `preparePublicTranscriptFromProcessOutput` and `publicOutputLineFromProcessLine` both trim a line, require it to start with `{`, parse JSON, require an object, and then pass it to `publicLineForEvent`.

Behavior check: extracting that line-to-object parser should not change observable behavior if malformed JSON still falls through in transcript rendering, non-object JSON is ignored, and valid public event lines still project the same public transcript lines.

Oracle: existing transcript tests cover structured event rendering, marker handling, malformed/non-public fallback classes, and MCP active public event projection through `publicOutputLineFromProcessLine`. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: introduced `eventObjectFromJsonLine` and reused it for both transcript rendering and active output-line projection.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/timeout-budget.test.ts tests/validation.test.ts` passed; targeted tests passed 71/71.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 134/134.

## Loop 74 - Share Safe Integer Env Parsing

Finding: `src/timeoutBudget.ts` and `src/progress.ts` repeat the same environment parser shape: read an env var, return fallback when unset or blank, parse with `Number`, require a safe integer, reject values below a minimum, otherwise return the parsed value.

Behavior check: extracting a shared parser with an explicit inclusive minimum should not change observable behavior if timeout-budget env values still accept nonnegative safe integers and heartbeat interval env values still accept only positive safe integers.

Oracle: existing timeout-budget tests cover nonnegative timeout env parsing and positive heartbeat interval parsing, including invalid fallback behavior. No new pinning test is needed.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added `safeIntegerFromEnv` and used it for timeout-budget nonnegative env values and heartbeat positive interval env values.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/timeout-budget.test.ts tests/validation.test.ts tests/run-subagent.test.ts` passed; targeted tests passed 71/71.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 134/134.

## Loop 75 - Reuse Safe Integer Env Parser for Transcript Limit

Finding: `src/transcript.ts` still repeats the positive safe-integer env parser shape now centralized in `safeIntegerFromEnv`: `SUBAGENT007_MAX_TRANSCRIPT_BYTES` falls back when unset, blank, non-safe, or less than one.

Behavior check: delegating to `safeIntegerFromEnv(..., 1)` should not change observable behavior if valid byte limits still truncate and invalid values still fall back to the default transcript byte limit.

Oracle: existing transcript tests cover default and valid configured byte limits but not invalid configured values. Add a focused invalid-env assertion before reusing the helper.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: added an invalid `SUBAGENT007_MAX_TRANSCRIPT_BYTES` transcript assertion and delegated `maxTranscriptBytes` to `safeIntegerFromEnv`.

Targeted oracle result: `npm run typecheck`, `git diff --check`, and `npm run build && node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts tests/validation.test.ts tests/timeout-budget.test.ts` passed; targeted tests passed 71/71.

Full oracle result: `SUBAGENT007_FAILURE_LOG_PATH=$(mktemp -d ...)/failures.jsonl npm test` passed 134/134.

## Loop 76 - Remove Dead One-Shot Strict Rejection Helper

Finding: after `run_subagent` auto-promotion, `src/validate.ts` still exported `assertRunSubagentOneShotCompatible()`, the old strict rejection helper for valid-but-one-shot-incompatible work. `rg` showed no callers. Keeping it preserved a dead alternate policy path contradicting the current scheduler-owned promotion rule.

Behavior check: removing the helper and its private `ONE_SHOT_GUIDANCE` string should not change external MCP behavior because `runSubagentOneShotTask()` consumes `runSubagentOneShotIncompatibility()` directly, and hard invalid-input validation still lives in `validateAndResolveRequest()`. The public failure-log classifier for historical matching strings is left intact.

Oracle: existing validation and `run_subagent` tests cover invalid inputs, schema-level `timeout_ms`, quick-compatible one-shot behavior, auto-promotion cases, model-health gating, and timeout recovery. No new pinning test was needed for a dead uncalled helper removal.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `assertRunSubagentOneShotCompatible()` and the now-unused private `ONE_SHOT_GUIDANCE` constant from `src/validate.ts`.

Targeted oracle result: `npm run typecheck`, `npm run build`, `node scripts/run-tests-with-ledger-guard.mjs tests/validation.test.ts`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 66/66.

Full oracle result: `npm test` passed 136/136.

## Loop 77 - Remove Dead Incompatibility Retry Guidance Branch

Finding: after Loop 76, `rg` showed no source producer for the old ValidationError message `incompatible with run_subagent's quick_noninteractive contract`. `src/server.ts` still had a private `preflightRetryGuidance()` branch for that removed message, so the active preflight guidance logic retained a dead policy route.

Behavior check: removing only the private server retry-guidance branch should not change observable MCP behavior because no current handler throws that message. The failure-log classifier branch for `run_subagent_incompatible_workload` remains because it is exported defensive/historical classification code.

Oracle: existing failure-log and run-subagent tests cover current preflight rejection behavior, schema-level `timeout_ms` guidance, auto-promotion, and invalid inputs. No new pinning test was needed for a private unreachable branch removal.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed the unreachable incompatibility-message branch from `preflightRetryGuidance()` in `src/server.ts`.

Targeted oracle result: `npm run typecheck`, `npm run build`, `node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 57/57.

Full oracle result: `npm test` passed 136/136.

## Loop 78 - Inline Single-Branch Preflight Retry Guidance

Finding: after Loop 77, `preflightRetryGuidance()` in `src/server.ts` became a one-condition helper with exactly one caller. The helper no longer names a general policy decision; it only checks the active `timeout_ms is not supported by run_subagent` message and returns one fixed guidance string.

Behavior check: inlining the condition into `preflightRejectedResult()` should not change observable behavior if the same message substring still produces the same `retry_guidance` value and all other ValidationErrors still omit `retry_guidance`.

Oracle: existing failure-log and run-subagent tests cover current preflight rejection behavior, schema-level timeout handling, and structured MCP results. No new pinning test is needed for a same-expression inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `preflightRetryGuidance()` and inlined the exact timeout-guidance condition into `preflightRejectedResult()`.

Targeted oracle result: `npm run typecheck`, `npm run build`, `node scripts/run-tests-with-ledger-guard.mjs tests/failure-log.test.ts`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 57/57.

Full oracle result: `npm test` passed 136/136.

## Loop 79 - Inline Single-Use Schedule Terminal Status Helper

Finding: `isTerminalStatus()` in `src/runTask.ts` is a one-call helper used only by `isScheduleReturnableStatus()`. It no longer removes duplication; it splits one local scheduler-return predicate across two tiny functions.

Behavior check: inlining the same terminal status checks into `isScheduleReturnableStatus()` should not change observable behavior if completed, failed, cancelled, and input-required statuses remain the only schedule-returnable states.

Oracle: existing run-subagent tests cover `schedule_run` immediate completion, active working return, input-required return, cancellation, and terminal polling. No new pinning test is needed for a same-predicate inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `isTerminalStatus()` and inlined the exact completed/failed/cancelled/input-required predicate in `isScheduleReturnableStatus()`.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Loop 80 - Inline Single-Use Task Input Request Loader

Finding: `taskInputRequests()` in `src/runTask.ts` is a one-call helper that only forwards `state.mailboxRoot` and `state.runId` to `listInputRequests()` inside `getRunTask()`. It no longer removes duplication and makes the snapshot/read path one hop less direct.

Behavior check: inlining the same `listInputRequests({ mailboxRoot: state.mailboxRoot, runId: state.runId })` call should not change observable behavior because the same mailbox root and run id are used to populate `input_requests`.

Oracle: existing run-subagent tests cover active, terminal, cancelled, input-required, answered, and restarted `get_run` views. No new pinning test is needed for a same-call inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `taskInputRequests()` and called `listInputRequests()` directly in `getRunTask()` with the same mailbox root and run id.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Loop 81 - Inline Single-Use Terminal Progress View

Finding: `terminalProgressView()` in `src/runTask.ts` is a one-call helper that only passes `state` plus `result.duration_ms` to `progressView()` in the terminal `getRunTask()` branch. It no longer removes duplication and splits one terminal-view projection across two local functions.

Behavior check: inlining `progressView(state, state.result.duration_ms)` should not change observable behavior if terminal `elapsed_ms` still comes from the result duration and all other progress fields still come from the same state.

Oracle: existing run-subagent tests cover terminal `get_run` views for one-shot, scheduled, started, cancelled, timeout, input, and restart paths. No new pinning test is needed for a same-call inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `terminalProgressView()` and called `progressView(state, state.result.duration_ms)` directly in the terminal `getRunTask()` branch.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Loop 82 - Inline Single-Use Task Heartbeat Adapter

Finding: `taskHeartbeatHandler()` in `src/runTask.ts` is a one-call helper that only curries `state` and the optional upstream heartbeat callback into `handleTaskHeartbeat()` for `taskChildRuntimeOptions()`. It no longer names a policy boundary; the heartbeat policy remains in `handleTaskHeartbeat()`.

Behavior check: replacing the helper call with the same `(beat, message) => handleTaskHeartbeat(state, beat, message, options.heartbeat)` callback should not change observable behavior if heartbeat count, progress message, active phase transitions, snapshot writes, and caller notification order are unchanged.

Oracle: existing run-subagent tests cover `running_silent` before output, heartbeat metadata becoming `running`, progress timestamps/messages, and completion after heartbeat activity. No new pinning test is needed for a same-callback inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `taskHeartbeatHandler()` and passed the same `(beat, message) => handleTaskHeartbeat(state, beat, message, options.heartbeat)` callback directly from `taskChildRuntimeOptions()`.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Loop 83 - Inline Single-Use Task Output Adapter

Finding: `taskOutputObserver()` in `src/runTask.ts` is a one-call helper that only curries `state` into `observeOutputLine()` for `taskChildRuntimeOptions()`. It no longer removes duplication; the output filtering, event projection, and progress policy remain in `observeOutputLine()`.

Behavior check: replacing the helper call with the same `(line) => observeOutputLine(state, line)` callback should not change observable behavior if child output still updates public events, input-required state, public excerpts, and snapshots through the same `observeOutputLine()` path.

Oracle: existing run-subagent tests cover sanitized active public events, public output excerpts, input-required transitions from child output, secret-output non-leakage, and terminal event projections. No new pinning test is needed for a same-callback inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `taskOutputObserver()` and passed the same `(line) => observeOutputLine(state, line)` callback directly from `taskChildRuntimeOptions()`.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Loop 84 - Inline Single-Use Promotion Metadata Builder

Finding: `promotionMetadata()` in `src/runTask.ts` is a one-call helper that only builds the public auto-promotion metadata object for `runSubagentPromotedTask()`. It no longer removes duplication, and the surrounding promoted-run setup is easier to audit when the object fields are visible at the use site.

Behavior check: inlining the same `RunSubagentPromotion` object should not change observable behavior if `auto_promoted_from`, `promotion_reason_code`, `promotion_reason`, `poll_with`, and `cancel_with` keep the same values and remain attached to state, auto-promotion events, and terminal results.

Oracle: existing run-subagent tests explicitly assert auto-promotion metadata fields for skill-bound, broad-work, and workspace-write promotion paths, and also assert the auto-promoted event. No new pinning test is needed for a same-object inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `promotionMetadata()` and built the same typed `RunSubagentPromotion` object directly inside `runSubagentPromotedTask()`.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Loop 85 - Inline Single-Use Running-Silent Marker

Finding: `markChildRunningSilently()` in `src/runTask.ts` is a one-call helper used only by `prepareChildRun()` immediately after `appendChildSpawnEvent()` sets `activePhase` to `awaiting_child_event`. It no longer removes duplication and makes the child-preparation sequence require an extra jump for one guarded state transition.

Behavior check: inlining the same guard and state/progress updates into `prepareChildRun()` should not change observable behavior if the transition to `running_silent`, the progress message `child process running; waiting for output`, and the subsequent snapshot write are unchanged.

Oracle: existing run-subagent tests assert `running_silent` and the child-running progress message for `schedule_run`, `start_run`, and `start_session_run` before first child output. No new pinning test is needed for a same-branch inline.

Decision: patch minimally. If any test fails, revert this loop and do not retry it.

Patch: removed `markChildRunningSilently()` and inlined its exact active-phase guard plus state/progress updates into `prepareChildRun()`.

Targeted oracle result: `npm run typecheck`, `npm run build`, and `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` passed; targeted tests passed 43/43.

Full oracle result: `npm test` passed 136/136.

## Current Constraints

The goal is not complete. I have not yet proven that the entire codebase has no material simplifications left. A broader lifecycle-shell extraction in `src/runTask.ts` remains plausible but is higher risk than the completed helper extractions and needs its own loop with direct oracle coverage. The current test oracle has historically had an incoherent constraint: with no explicit `SUBAGENT007_FAILURE_LOG_PATH`, full-suite success can depend on the ambient user-level failure ledger not changing during the run; the latest sequential `npm test` completed cleanly, but the constraint is still part of the oracle design.
