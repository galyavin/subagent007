# Repo Coherence Scratchpad Ledger - 2026-06-11

## F001 - README Timeout Tool List Omits `start_session_run`

Observed while scanning README public-contract text after the new async session tool was added: the timeout section says "`timeout_ms` is optional for `start_run` and `run_subagent_session`" but omits `start_session_run`, even though `start_session_run` uses the same timed named-session schema and is now documented as the preferred pollable named-session path.

Impact: low-risk documentation incoherence. It can make callers think the preferred async session tool is not timed even though the schema and implementation accept `timeout_ms`.

Repair: updated README timeout guidance to include `start_session_run`.

Status: repaired and verified by docs scan, build, typecheck, full tests, package dry-run, diff check, model reconciliation, and deterministic observed MCP campaign.

## F002 - `run_subagent_session` Compatibility Wrapper May Swallow Handler Validation Errors

Observed while inspecting `src/server.ts` and `src/runTask.ts`: `run_subagent_session` now calls `runSubagentSessionTaskAndWait`, which starts a durable session task and returns `getRunTask`. The task body catches `ValidationError` into `state.error`, and `getRunTask` renders that as a structured failed task view instead of throwing. Before the durable wrapper, `runSubagentSession` threw validation errors directly to the MCP handler.

Impact: possible public-contract regression. Schema errors still fail at the SDK boundary, but handler validation cases such as invalid `session_key`, existing session with `resume_mode:"new"`, or missing required existing session may no longer return MCP `isError:true` or handler failure telemetry as before.

Verification: confirmed with an isolated MCP client call to `run_subagent_session` using `session_key:"bad key with spaces"`. The response had structured failed task content and no `isError:true`.

Repair: updated `runSubagentSessionTaskAndWait` to rethrow `state.error` after the durable task settles, and added an MCP regression test asserting invalid `session_key` returns `isError:true`.

Status: repaired and verified by targeted MCP regression coverage in the full test suite.

## F003 - `start_session_run` Creates Tasks Before Basic Session Validation

Observed while comparing `startRunTask` and `startSessionRunTask`: `startRunTask` calls `validateAndResolveRequest` before allocating a run id or writing a task snapshot. `startSessionRunTask` currently allocates a run id and starts a task before `runSubagentSession` validates `session_key`, `cwd`, `resume_mode`, and packet policy inside the async body.

Impact: public lifecycle incoherence. The two async start tools do not share the same preflight boundary, and invalid named-session inputs can create short-lived failed task records instead of failing before side effects.

Repair: exported `validateRunSubagentSessionRequestPreflight`, called it before `startSessionRunTask` allocates a task id, and added an MCP regression test for invalid `start_session_run.session_key`.

Status: repaired and verified by targeted MCP regression coverage in the full test suite.

## F004 - `get_run` Tool Description Omits Durable Session Run Producers

Observed while checking registered MCP tool descriptions in `src/server.ts`: `get_run` says it reads durable runs created by `run_subagent` or `start_run`, but durable task snapshots can now also be created by `start_session_run` and the compatibility `run_subagent_session` wrapper.

Impact: low-risk public-contract incoherence. The implementation works, but the advertised contract under-describes which run ids are valid for polling and inspection.

Repair: updated the `get_run` MCP tool description to include `start_session_run` and `run_subagent_session` as durable run producers.

Status: repaired and verified by build and deterministic observed MCP campaign.

## F005 - Terminal Run View Block Has Formatting Drift

Observed while inspecting `src/runTask.ts`: the `if (state.result)` return block in `getRunTask` is overindented relative to the surrounding code.

Impact: semantic waste only. It does not change runtime behavior, but it weakens code readability in a core state-rendering path.

Repair: normalized indentation of the terminal result return block in `getRunTask`.

Status: repaired and verified by typecheck, full tests, and diff whitespace check.

## F006 - Older June 11 Plan Still Claims Named Sessions Bypass Public Run Tasks

Observed while scanning planning docs for stale active-contract text: `docs/plans/coherent-revised-saf-implementation-plan-2026-06-11.md` is marked `status: implemented`, but still says `run_subagent_session` continues to call core child execution without creating public run-task snapshots. The current implementation and newer current plan intentionally wrap `run_subagent_session` in the durable session task lifecycle.

Impact: documentation incoherence. The file is traceability, but without a supersession marker the stale claim looks like an active architectural invariant and contradicts README/server behavior.

Repair: added a supersession pointer to the newer current plan and rewrote the stale named-session boundary claims as historical notes.

Status: repaired and verified by docs scan and full verification.
