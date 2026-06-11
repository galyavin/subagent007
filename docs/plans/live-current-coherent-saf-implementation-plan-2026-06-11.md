---
title: Live Current Coherent SAF Implementation Plan
type: feat
date: 2026-06-11
status: implemented
origin: reports/full-coherent-revised-saf-set-2026-06-11-live-current.md
---

# Live Current Coherent SAF Implementation Plan

## Summary

Implement the repaired SAF set from `reports/full-coherent-revised-saf-set-2026-06-11-live-current.md` as one coherent reliability slice for `subagent007-pi`.

Implementation status: applied locally on 2026-06-11. Verification passed with `npm run typecheck`, `npm test`, deterministic `protocol-core`, deterministic `full-current`, and live `live-current` observed campaign probes.

The work is mostly observability, telemetry, campaign coverage, and documentation-boundary repair. It should not alter the core Pi child execution contract, named-session promotion semantics, packet parsing rules, model-class calibration, or public tool names.

The plan is intentionally ordered so later units build on earlier authority decisions:

1. Normalize terminal lifecycle authority.
2. Add explicit active phase state.
3. Add run-scoped operation context for run tools and failure logging.
4. Make coverage profiles structurally satisfiable.
5. Add executable campaign scenarios and a live campaign runner mode.
6. Repair input-answer confidentiality docs and scope boundary.

## Problem Frame

Observed real-use trials showed that core execution is healthy: child launch, output capture, polling, input mailbox, cancellation, timeout, named sessions, raw continuity, packet gating, and redaction all work. The remaining incoherences are around who owns public lifecycle events, how run-scoped failures recover context, whether coverage profiles are executable, how live campaigns claim attribution, and what confidentiality the public transcript contract actually promises.

This plan implements only those root repairs. It explicitly does not add a dataflow privacy system, replace the Pi child runner, change model routing, or introduce request-scoped campaign ids into public MCP tool inputs.

## Requirements Traceability

| Revised SAF | Requirement | Implementation Units |
| --- | --- | --- |
| R1 | Public terminal lifecycle events have one authority and no duplicate timeout/cancel terminal events. | U1 |
| R2 | Run-scoped tools resolve one operation context that both handlers and failure logging use. | U3 |
| R3 | Coverage profiles cannot require surfaces that selected scenarios cannot satisfy. | U4, U5 |
| R4 | Live campaigns run against an isolated campaign-owned server process. | U5 |
| R5a | Docs precisely state answer-event omission versus public child output. | U6 |
| R5b | Nonpublic caller-input dataflow redaction is explicitly out of scope unless a future sensitivity policy is introduced. | U6 |
| R6 | Active runs expose explicit post-spawn phase state before first heartbeat or child event. | U2 |

## Key Decisions

- **KD1. `runTask` owns terminal lifecycle events.** Raw `[subagent007 timeout]` and `[subagent007 cancelled]` markers remain transcript artifact content, but do not become public terminal lifecycle events in run-task event ledgers.
- **KD2. Active phase is separate from heartbeat.** `active_phase` answers "where is the run lifecycle now?" while `heartbeat_count` remains a timer/progress notification signal.
- **KD3. Run context is resolved at the run-tool boundary.** `get_run`, `answer_run_input`, and `cancel_run` should use one wrapper/resolver so handler behavior and telemetry agree.
- **KD4. Coverage correctness is an invariant, not a report convention.** The manifest must fail validation when a profile requires surfaces outside its executable scenario set.
- **KD5. Live campaign isolation is a server-instance primitive.** Campaign-scoped live evidence should come from a fresh server launched under campaign environment, not from retroactively tagging installed-server calls.
- **KD6. Current caller-input confidentiality is event-level only.** Do not implement regex redaction of assistant output; document the boundary honestly.

## Implementation Units

### U1. Normalize Public Terminal Lifecycle Authority

**Covers:** R1.

**Goal:** Ensure timeout and cancellation produce one public terminal lifecycle event while preserving raw process markers in Markdown transcripts.

**Files:**

- `src/transcript.ts`
- `src/runTask.ts`
- `src/types.ts`
- `tests/run-subagent.test.ts`
- `tests/timeout-budget.test.ts`

**Approach:**

- Change `publicMarkerLine` so raw process markers are not returned as `kind:"terminal"` lifecycle events from `publicOutputLineFromProcessLine`.
- Preserve raw process markers in `preparePublicTranscriptFromProcessOutput` output artifacts. This may require separating "artifact transcript marker rendering" from "run-task public event projection" instead of using one shared marker classifier for both.
- Keep `appendTerminalEvent` in `src/runTask.ts` as the single source of public terminal lifecycle events.
- Do not remove timeout/cancel text from Markdown artifacts; existing users inspecting raw transcripts should still see process-level stop markers.
- Optional: if raw markers are still useful in `recent_events`, project them as `kind:"child"` or `kind:"task"` diagnostics with non-terminal event names. Prefer omission unless a current consumer needs them.

**Test scenarios:**

- In `tests/run-subagent.test.ts`, a cancelled fake `start_run` terminal snapshot has exactly one `recent_events` item with `event:"cancellation_settled"` and its text is `[cancellation_settled] run cancelled`.
- In `tests/timeout-budget.test.ts`, a timed-out fake `start_run` terminal snapshot has exactly one `recent_events` item with `event:"timeout"` and its text is `[timeout] run timed out`.
- Markdown timeout transcript still matches `[subagent007 timeout] requested_timeout_ms=...`.
- Markdown cancellation transcript still includes `[subagent007 cancelled]`.
- Existing transcript content flag tests still classify raw markers as not assistant/warning/error content.

**Acceptance criteria:**

- Public event ledgers never contain duplicate terminal lifecycle events for one timeout or cancellation.
- Artifact compatibility for raw timeout/cancel markers is preserved.
- No public tool schema changes.

### U2. Add Active Run Phase State

**Covers:** R6.

**Goal:** Make active run state distinguish "child has spawned and server is awaiting first child event" from a stale or stalled task, even before the first heartbeat interval.

**Files:**

- `src/runTask.ts`
- `src/types.ts`
- `tests/run-subagent.test.ts`
- `tests/timeout-budget.test.ts`
- `README.md`

**Approach:**

- Add a run-task phase type, for example:
  - `starting`
  - `awaiting_child_event`
  - `running`
  - `input_required`
  - `cancelling`
  - `timed_out`
  - `cancelled`
  - `completed`
  - `failed`
- Add `active_phase?: RunTaskActivePhase` and `last_phase_at?: string` to `RunTaskView` and `RunTaskState`.
- Initialize task state with `active_phase:"starting"` at task creation.
- In `appendChildSpawnEvent`, immediately set `active_phase:"awaiting_child_event"` and `last_phase_at` to the child-spawn event timestamp, then write a snapshot.
- In `observeOutputLine`, update phase:
  - `input_required` for input requests
  - `running` for assistant/warning/error/message child events that are not terminal
  - terminal phases only when U1 still permits observing a terminal diagnostic, or preferably let `appendTerminalEvent` set terminal phases.
- In `cancelRunTask`, set `active_phase:"cancelling"` when cancellation is requested.
- In `appendTerminalEvent`, set final phases consistently from `result.stop_reason` and success.
- Preserve `last_progress_message` and `heartbeat_count` semantics; phase is additive and more structured.

**Test scenarios:**

- `start_run` immediate response after fake child spawn exposes `active_phase:"awaiting_child_event"` and a string `last_phase_at`.
- A fake timeout with effective runtime shorter than heartbeat interval still shows phase history reaching `awaiting_child_event` before terminal `timed_out`.
- A fake input-request run moves to `active_phase:"input_required"` when pending input appears and away from that phase after answering.
- A cancelled run moves through `cancelling` and terminal `cancelled`.
- Completed and failed fake runs expose terminal phases in persisted `get_run` snapshots after server restart.

**Acceptance criteria:**

- Active phase state never depends on MCP progress tokens.
- No global heartbeat interval reduction is needed.
- Terminal snapshots are stable and not overwritten by late heartbeat callbacks.

### U3. Introduce Run-Scoped Operation Context

**Covers:** R2.

**Goal:** Ensure run-scoped tools resolve task context once, use it for handler behavior, and use the same context for failure logging.

**Files:**

- `src/runTask.ts`
- `src/server.ts`
- `src/failureLog.ts`
- `src/types.ts`
- `tests/failure-log.test.ts`
- `tests/run-subagent.test.ts`

**Approach:**

- Add context fields to failure records:
  - `run_id?: string`
  - `task_kind?: "run" | "session"`
  - existing `session_key?: string`
  - derived `cwd?: string` when known from the run started event or snapshot metadata
- Extend `FailureReasonCode` with run-scoped state reasons:
  - `run_not_found`
  - `run_not_accepting_input`
  - `input_request_not_part_of_run`
  - `input_request_already_answered`
  - `input_request_already_timed_out`
  - `input_request_already_closed`
- Add a `RunOperationContext` resolver that can:
  - read active in-memory state when present
  - read persisted snapshots when present
  - derive cwd from snapshot/event metadata when possible
  - report a precise `run_not_found` context failure when absent
- Wrap `get_run`, `answer_run_input`, and `cancel_run` in a run-scoped handler wrapper instead of plain `withFailureLogging`.
- Avoid double-reading snapshots in hot paths where `getRunTask` already resolves the same data. If practical, expose a lower-level context resolver from `runTask.ts` that `getRunTask` can share.
- Keep SDK schema errors before handler invocation unchanged; those should still not write failure logs.

**Test scenarios:**

- Late `answer_run_input` after run terminal state rejects with the existing user-facing message or a compatible clearer message, and failure log includes `run_id`, `task_kind`, derived cwd, and `reason_code:"run_not_accepting_input"`.
- Duplicate answer to an answered request logs `input_request_already_answered` if it reaches the run handler path.
- Answering a request id from another run logs `input_request_not_part_of_run`.
- `cancel_run` for an unknown run logs `run_not_found` without cwd.
- `get_run` for an unknown run logs `run_not_found` without cwd.
- Schema errors for missing `run_id` remain SDK validation errors and do not log.

**Acceptance criteria:**

- Run-scoped failure telemetry is groupable by run id and cwd whenever the run exists.
- There is one wrapper pattern for run-scoped tools, not three parallel logging implementations.

### U4. Enforce Coverage Profile Satisfiability

**Covers:** R3.

**Goal:** Make profile definitions fail before execution when their required surfaces cannot be satisfied by selected scenarios with compatible evidence classes.

**Files:**

- `scripts/run-observed-mcp-probe.mjs`
- `scripts/observed-coverage-manifest.json`
- `tests/observed-campaign.test.ts`
- `README.md`

**Approach:**

- Refactor `assertManifestComplete` into a stronger manifest validator:
  - all `saf_required_surfaces` exist in `surfaces`
  - all profile `required_surfaces` exist in `surfaces`
  - all profile scenarios exist in `scenarios`
  - every profile required surface is covered by at least one selected scenario in that profile
  - scenario evidence class is compatible with the surface's declared evidence classes and the profile mode
- Keep validation fail-closed and run it even for `--help`, matching current self-check behavior.
- Preserve `protocol-core` as deterministic-only; it should not be forced to cover live-only surfaces.
- Introduce explicit profile categories if needed:
  - deterministic profile: only deterministic-compatible surfaces
  - live profile: live-model-compatible surfaces
  - aggregate profile: must include both deterministic and live scenario sets, or must be split into executable subprofiles
- Update error messages so a failed profile names both missing surfaces and the reason: unknown surface, no scenario, or evidence-class mismatch.

**Test scenarios:**

- A manifest where a profile requires an unknown surface fails with the existing class of message.
- A manifest where a profile requires a known surface but no selected scenario covers it fails with a new precise message.
- A manifest where a profile selects a scenario covering the surface but with incompatible evidence class fails.
- `protocol-core` passes validation without live-only surfaces.
- `full-current` fails validation until U5 adds missing scenarios or split executable subprofiles.

**Acceptance criteria:**

- No profile can be permanently red because of manifest drift that validation could have caught.
- Coverage failure is structural and immediate, not discovered only after running probe calls.

### U5. Add Missing Campaign Scenarios And Live Campaign Runner Mode

**Covers:** R3, R4.

**Goal:** Make `full-current` executable by adding missing scenarios and ensuring live campaign evidence is gathered through a campaign-owned server process.

**Files:**

- `scripts/run-observed-mcp-probe.mjs`
- `scripts/run-observed-campaign.mjs`
- `scripts/observed-coverage-manifest.json`
- `tests/observed-campaign.test.ts`
- `tests/helpers/fakePiChild.ts`
- `README.md`

**Approach:**

- Add deterministic scenarios where fake child can cover the surface:
  - `timeout-recovery`: `run_subagent` with fake timeout and assertion of `timeout_recovery_hint`
  - `async-polling`: `start_run`, then `get_run`, terminal completion
  - `caller-input`: fake child emits request input; probe answers via `answer_run_input`; final result completes
  - `cancellation`: `start_run` with `CANCEL_WAIT`; probe calls `cancel_run`; terminal state is cancelled
  - `packet-valid-closure`: `run_subagent_session` with `PACKET_VALID_WITH_CLOSURE`
  - `packet-invalid-closure`: `run_subagent_session` with `PACKET_INVALID_CLOSURE_SHAPE`
- Add live-only scenario for installed/Pi integration, but run it through a freshly launched server under campaign env:
  - profile name can be `live-current` or `full-current-live`
  - evidence class `live-model-smoke`
  - scenario should use a short class with known one-shot health or accept a configured `--model-class`
- Avoid making live provider calls part of default `protocol-core` or ordinary unit test paths.
- If `full-current` needs both deterministic and live evidence, model it as an orchestration profile that runs deterministic scenarios plus live scenarios in their compatible modes, or split it into `full-current-deterministic` and `full-current-live` with a wrapper summary.
- Extend probe runner only as far as needed for scenarios:
  - support multi-step scenarios, not just one `callTool`
  - record every MCP call attempt to campaign ledger
  - preserve prompt redaction in ledger `argument_shape`
  - record covered surfaces only when scenario result classes match observed outcomes
- Ensure `scripts/run-observed-campaign.mjs` remains the server process owner for live campaign mode by passing state env into the probe-launched MCP server.

**Test scenarios:**

- Deterministic `full-current` or its deterministic subprofile covers all deterministic required surfaces without missing-required failures.
- `timeout-recovery` records a call result with `timed_out:true` and `timeout_recovery_hint` containing `run_id`.
- `caller-input` records `start_run`, `get_run`, `answer_run_input`, and terminal `get_run` attempts without answer text in ledger.
- `cancellation` records cancellation settlement and no unknown failure log.
- Valid closure scenario covers `run_subagent_session-valid-packet-closure`.
- Invalid closure scenario covers `run_subagent_session-invalid-packet-closure` and logs packet failure.
- Live-mode rejects deterministic-only child failure scenarios, preserving current guardrail.
- A live campaign summary clearly marks `evidence_class:"campaign-scoped"` at harness level and `live-model-smoke` in probe coverage.

**Acceptance criteria:**

- A documented command can run all current deterministic coverage without missing surfaces.
- A documented command can run live smoke through a fresh campaign-scoped server.
- Installed-server observations are not relabeled campaign-scoped.
- Prompt and answer sentinels do not leak to campaign ledger records.

### U6. Repair Input-Answer Confidentiality Documentation And Scope Boundary

**Covers:** R5a, R5b.

**Goal:** Make the public contract match actual confidentiality behavior and explicitly avoid pseudo-promising dataflow redaction.

**Files:**

- `README.md`
- `tests/run-subagent.test.ts`
- `tests/observed-campaign.test.ts`

**Approach:**

- Update common-input and async-input sections in `README.md`:
  - `answer_run_input.answer` is stored in local mailbox settlement records.
  - Answer text is omitted from input/public event records.
  - Child-generated assistant output is public transcript material and may include answer-derived text if the child is asked to echo or use it.
  - The system does not currently provide nonpublic caller-input dataflow redaction.
  - Future nonpublic answer handling requires an explicit sensitivity policy, not regex redaction.
- Keep existing tests that prove raw public event files omit input answer text.
- Add or update a test/documentation assertion if useful: a fake child may echo answer text in assistant output, and this is not treated as a redaction failure.
- Do not add new public tool fields for sensitivity labels in this implementation slice.

**Test scenarios:**

- Existing `answer_run_input records no answer text in raw public event file` remains green.
- No test asserts assistant output redacts answer-derived text.
- README mentions "no dataflow confidentiality guarantee" or equivalent plain language.

**Acceptance criteria:**

- Users can distinguish event-level omission from end-to-end secrecy.
- Future sensitivity work has a clear boundary and cannot be smuggled in as regex cleanup.

## Integration Sequence

1. **U1 first** because it decides public event authority. U2 phase updates and U5 campaign assertions should target the cleaned event stream.
2. **U2 second** because it extends run snapshots and gives later tests stronger active-state assertions.
3. **U3 third** because it touches run-scoped tool wrappers; it should build on stable run view fields from U2.
4. **U4 fourth** because it changes validation semantics before new scenarios are added.
5. **U5 fifth** because it satisfies the new U4 invariant and adds the larger campaign runner behavior.
6. **U6 last** because docs should reflect final runtime and campaign semantics.

## Verification Strategy

Run these checks after each unit where relevant:

- `npm run typecheck`
- `npm test`
- `npm run observed-campaign -- --campaign-id campaign.plan-verification-protocol -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd <repo> --profile protocol-core`

Run after U5:

- deterministic full-current or deterministic subprofile campaign command, depending on final profile shape
- live campaign smoke command against a freshly launched campaign-scoped server, only when live Pi/model access is available

Manual/live checks after U5 when provider access is available:

- `list_model_classes` through the campaign-owned server
- quick `run_subagent` live smoke through the campaign-owned server
- verify harness state root receives runs, run tasks, input requests, sessions, raw sessions, model health, failure log, and campaign ledger

## Completeness And Cohesion Audit

| Check | Result |
| --- | --- |
| Every revised SAF has at least one implementation unit. | Yes: R1-U1, R2-U3, R3-U4/U5, R4-U5, R5a/R5b-U6, R6-U2. |
| Every runtime unit names feature-bearing files and tests. | Yes: U1-U5 name `src/` or `scripts/` files plus targeted tests. |
| Documentation-only scope boundary is isolated. | Yes: U6 handles R5a/R5b without contaminating runtime units. |
| Dependencies are acyclic. | Yes: event authority before phase, phase before context assertions, invariant before scenarios, scenarios before docs. |
| No plan step depends on Chrome/browser state. | Yes: all verification uses Node/MCP/campaign harness; live checks use fresh MCP server. |
| No unit requires public MCP tool schema expansion. | Yes: R2 adds failure-log fields, R6 adds output view fields; R4 uses harness mode, not tool inputs. |
| No unit weakens existing safety contracts. | Yes: schema errors remain pre-handler, prompt redaction remains, `protocol-core` remains deterministic. |
| Non-goals remain out of scope. | Yes: no dataflow redaction feature, no provider phase introspection, no request-scoped campaign ids. |

## Risks And Mitigations

- **Risk: U1 breaks transcript rendering by removing marker projection too broadly.** Mitigation: split artifact transcript rendering from run-task event projection and test both.
- **Risk: U2 phase names become another drifting vocabulary.** Mitigation: keep the phase enum minimal and update only at existing lifecycle choke points.
- **Risk: U3 logging wrapper accidentally logs prompt or answer text.** Mitigation: context includes ids/cwd/session metadata only; preserve existing prompt-redaction tests and add answer sentinel checks.
- **Risk: U4 makes current manifest fail before U5 lands.** Mitigation: land U4 and U5 in the same PR or temporarily update profile definitions in the same commit.
- **Risk: U5 live scenarios make CI flaky.** Mitigation: keep live-model profiles opt-in and deterministic coverage separate.
- **Risk: U6 wording overpromises again.** Mitigation: explicitly say there is no dataflow confidentiality guarantee for caller answers.

## Non-Goals

- Do not implement sensitivity-labeled caller input.
- Do not add regex redaction for assistant output containing answer values.
- Do not add request-scoped campaign ids to public tool inputs.
- Do not change model-class calibration or one-shot health semantics.
- Do not alter packet schema beyond using existing valid/invalid closure scenarios.
- Do not change named-session candidate promotion semantics.

## Ready Criteria

The implementation is complete when:

- All unit acceptance criteria pass.
- `npm run typecheck` and `npm test` pass.
- Deterministic observed campaign coverage passes with no missing required deterministic surfaces.
- Live campaign smoke can be run under isolated campaign state and is clearly labeled as live-model evidence.
- README accurately describes event-level answer omission and the absence of dataflow confidentiality.
- The final report or PR description maps completed changes back to R1-R6.

## Implementation Outcome

Local implementation completed all six units. Final verification commands:

- `npm run typecheck`
- `npm test`
- `npm run observed-campaign -- --campaign-id campaign.verify-protocol-20260611 -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile protocol-core`
- `npm run observed-campaign -- --campaign-id campaign.verify-full-current-20260611 -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile full-current`
- `npm run observed-campaign -- --campaign-id campaign.verify-live-current-20260611 -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile live-current`
