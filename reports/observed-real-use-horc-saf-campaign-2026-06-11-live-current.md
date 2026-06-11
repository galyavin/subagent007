# Observed Real Use HORC/SAF Campaign - 2026-06-11 Live Current

Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`

Branch: `main`

Scope: current `subagent007-pi` MCP server, deterministic MCP protocol harness, installed live MCP server, Pi-backed child execution, async polling, caller input, cancellation, timeout, raw continuity, named sessions, packet policy, validation/preflight, failure telemetry, and campaign coverage semantics.

## Campaign Plan

1. Verify repo baseline and current branch.
2. Run the full repository test suite.
3. Run the campaign-scoped deterministic MCP probe with `protocol-core`.
4. Run live installed MCP trials against every public tool:
   - `list_model_classes`
   - `run_subagent`
   - `start_run`
   - `get_run`
   - `answer_run_input`
   - `cancel_run`
   - `run_subagent_session`
   - `start_session_run`
5. Exercise edge cases:
   - quick one-shot success
   - broad prompt preflight rejection
   - async input request and duplicate/late answer rejection
   - cancellation settlement
   - hard timeout settlement
   - named-session create/resume
   - async named-session wrapper
   - raw Pi continuity create/resume
   - required packet valid closure
   - required packet invalid closure
   - full aggregate coverage profile fail-closed behavior
6. Inspect failure telemetry and artifacts.
7. Distinguish patterns, identify HORCs, compare Intraframe and Transframe SAF candidates, and select the least-motion complete fix for each HORC.

## Evidence Summary

### Repo Baseline

- `git branch --show-current`: `main`
- `git status --short`: clean before report creation
- `npm test`: passed, 111 tests

### Deterministic Protocol Campaign

Command:

```sh
npm run observed-campaign -- --campaign-id campaign.current-protocol-20260611 -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile protocol-core
```

Result: passed.

Campaign summary:

- Campaign id: `campaign.current-protocol-20260611`
- Evidence class: `campaign-scoped`
- State root: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.current-protocol-20260611-lL5NEm`
- Ledger: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.current-protocol-20260611-lL5NEm/campaign-ledger.jsonl`
- Covered protocol surfaces:
  - `tool-listing`
  - `model-class-listing`
  - `run_subagent-success`
  - `run_subagent-schema-error`
  - `run_subagent-preflight-rejection`
  - `run_subagent-child-failure`
  - `run_subagent_session-packet-failure`
  - `transcript-redaction`

### Full-Current Profile Check

Command:

```sh
npm run observed-campaign -- --campaign-id campaign.current-full-profile-20260611 -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile full-current
```

Result: failed closed as designed, but exposed a coverage-system gap.

State root: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.current-full-profile-20260611-QUV8bF`

Missing required surfaces:

- `answer_run_input-caller-input`
- `cancel_run-cancellation-settlement`
- `installed-pi-integration`
- `run_subagent-timeout-recovery`
- `run_subagent_session-invalid-packet-closure`
- `run_subagent_session-valid-packet-closure`
- `start_run-async-polling`

Observation: those missing surfaces were manually exercised live in this campaign, but the bundled `full-current` profile has no executable scenarios for them, so the profile cannot become green from the bundled scenario set alone.

### Live Installed MCP Trials

These calls used the already-running installed MCP server. Per README semantics, they are production-state observations, not campaign-scoped harness observations.

| ID | Surface | Observation |
| --- | --- | --- |
| L1 | `list_model_classes` | Server reachable. Default class `C`; configured/effective `C`; class `A` one-shot health `healthy`; B-E health `unknown`. |
| L2 | `run_subagent` one-shot | Completed in 18.9s with exact output `SUBAGENT007_LIVE_ONE_SHOT_OK`. Run id `2026-06-11T191853538Z-2f8f61968dc5`. |
| L3 | `get_run` completed one-shot | Replayed terminal snapshot and public events for L2. |
| L4 | `start_run` async caller input | Child requested `What token should I echo?` after about 20s; run status became `input_required`. Run id `2026-06-11T191923959Z-47f26da4ca8f`. |
| L5 | `answer_run_input` | Answered request `2026-06-11T191923959Z-47f26da4ca8f-eafdd801314c`; run completed with `INPUT_ECHO:LIVE_INPUT_TOKEN_7319`. Input event omitted the answer text. |
| L6 | Late answer rejection | Re-answering the same request returned `run is not accepting input: 2026-06-11T191923959Z-47f26da4ca8f`. Failure log reason was `unknown_validation_error`. |
| L7 | `cancel_run` | A shell-capable async run was cancelled after startup; terminal status `cancelled`, `exit_code:null`, transcript contained `[subagent007 cancelled]`. Run id `2026-06-11T192010564Z-12dc9bc45992`. |
| L8 | `start_run` timeout | A 12s requested timeout produced 5s effective child runtime after headroom/grace reserves; status `failed`, `timed_out:true`, `partial_output_available:false`. Run id `2026-06-11T192025344Z-3f36ae122ac0`. |
| L9 | `run_subagent_session` create | Created named session `campaign:20260611-live-session-a`, stored marker `LIVE_SESSION_MARKER_4821`, ledger sequence 1. |
| L10 | `run_subagent_session` resume | Resumed the same session and recalled exactly `LIVE_SESSION_MARKER_4821`, ledger sequence 2. |
| L11 | `start_session_run` | Async named-session wrapper resumed the same session and completed with `START_SESSION_RUN_OK`, ledger sequence 3. |
| L12 | Required packet valid closure | `packet_policy:"required"` accepted a valid `contract_packet_v1`; public events redacted packet body and emitted `packet_accepted`. |
| L13 | Required packet invalid closure | Child exited 0 but session failed closed with `packet_parse_status:"invalid"` and no committed session id. Error: `closure.artifact_roles` expected array, received object; `closure.validation` expected array, received string. |
| L14 | Broad one-shot preflight | `run_subagent` rejected a broad HORC/SAF implementation-plan prompt before child start, reason `run_subagent_incompatible_workload`, with retry guidance. |
| L15 | Raw Pi continuity | `continuity:{mode:"fresh"}` established a raw Pi session file; later `continuity:{mode:"resume"}` recalled `RAW_CONTINUITY_MARKER_9164`. |

Key live artifact paths:

- One-shot final: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T191912452Z-ce2212a2d75c.md`
- Caller-input transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T191957214Z-21932fd3ab9e.md`
- Cancellation transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T192013858Z-eec9e3de2536.md`
- Timeout transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T192030370Z-0b86bb0af49d.md`
- Named-session ledger: `/Users/rgalyavin/.codex/subagent007-pi/sessions/campaign:20260611-live-session-a-c907b60f0e44dbb3d0c475193bde5490/ledger.jsonl`
- Invalid packet attempts ledger: `/Users/rgalyavin/.codex/subagent007-pi/sessions/campaign:20260611-live-packet-invalid-closure-b1c06747b1103e68a746000ebbd68e87/attempts.jsonl`

## Observed Issues And Incoherences

### I1. Timeout And Cancellation Emit Duplicate Terminal Events

Evidence:

- Cancellation `get_run` recent events included:
  - `event:"cancellation_settled"`, text `[subagent007 cancelled]`
  - `event:"cancellation_settled"`, text `[cancellation_settled] run cancelled`
- Timeout `get_run` recent events included:
  - `event:"timeout"`, text `[subagent007 timeout] requested_timeout_ms=...`
  - `event:"timeout"`, text `[timeout] run timed out`

Impact: consumers see two terminal lifecycle events for one terminal transition, and the same event kind has two incompatible text vocabularies.

### I2. Run-Started Text Says `run run`

Evidence: live public events render one-shot and async runs as `[run_started] run run <id>`. Session tasks render `[run_started] session run <id>`, which is coherent.

Impact: low severity, but public event grammar exposes an internal `task_kind` naming collision.

### I3. Late Input Rejection Loses Run Context In Failure Telemetry

Evidence: late `answer_run_input` rejection returned the correct user-facing message, but the failure log record was:

- `tool:"answer_run_input"`
- `failure_class:"validation_error"`
- `reason_code:"unknown_validation_error"`
- `cwd_class:"missing"`

Impact: run-scoped tool failures cannot be grouped by cwd/session/task, and a common expected edge has no precise reason code.

### I4. Answer Redaction Boundary Is Easy To Misread

Evidence: `answer_run_input` did not put `LIVE_INPUT_TOKEN_7319` in the input event, but the assistant output did include `INPUT_ECHO:LIVE_INPUT_TOKEN_7319` because the task asked it to echo the answer.

Impact: the implementation is technically consistent with "answer text omitted from input events," but a caller could incorrectly infer stronger transcript confidentiality than the system provides.

### I5. Active Runs Can Look Stalled Before First Heartbeat

Evidence: the caller-input run remained at `last_progress_message:"child process starting"`, `heartbeat_count:0` until the child requested input after about 20 seconds. The timeout trial also had no heartbeat before its 5s effective runtime expired.

Impact: not a correctness failure, but short or startup-heavy runs have little liveness signal between child spawn and first model/tool event.

### I6. `full-current` Is A Required-Surface Inventory, Not An Executable Full Campaign

Evidence: `full-current` requires 15 surfaces but runs only the same 8 scenarios as `protocol-core`. It therefore reports missing required surfaces that the current bundled probe cannot produce.

Impact: users can run the documented "full" profile and get a truthful failure, but not an actionable complete campaign from one command.

### I7. Campaign Attribution Is Process-Scoped, Not Request-Scoped

Evidence: harness-launched protocol probes wrote to temp campaign state, but live installed MCP calls wrote to `/Users/rgalyavin/.codex/subagent007-pi`. This matches README, but it means observed live E2E evidence cannot be campaign-scoped unless the MCP server process itself is launched under campaign environment variables.

Impact: reports must manually join harness evidence and production-state live evidence. Mistagging live evidence as campaign-scoped is easy.

### I8. Model Health Coverage Is Partial

Evidence: `list_model_classes` reported class `A` healthy for one-shot and B-E unknown.

Impact: tool selection is still usable, but "default class C" has unknown one-shot health at the public health surface.

## Common Patterns

1. Core execution mechanics are healthy: child launch, output capture, run snapshots, polling, input mailbox, cancellation, timeout, named sessions, raw continuity, packet gating, and redaction all work in current live use.
2. The highest-friction failures are not child execution failures; they are observability and classification mismatches around events, coverage, telemetry, and attribution.
3. The server has two different evidence domains: deterministic campaign-scoped protocol evidence and live installed production-state evidence. Both are useful, but they do not naturally merge into one coverage ledger.
4. Public event streams are projections from several producers: task lifecycle, process markers, transcript parsing, packet policy, and input mailbox. Most incoherences occur where those projections overlap.
5. The system protects against dangerous misuse at the tool boundary better than it explains every post-boundary dataflow. Preflight rejection is strong; redaction semantics need sharper framing.

## HORC / SAF Analysis

### HORC A: Terminal Lifecycle Events Have Multiple Authorities

Malformed upstream structure: terminal state is emitted both by the child-process transcript marker parser and by the run-task lifecycle appender. They share lifecycle event names but not text shape or authority.

Downstream effects:

- duplicate `timeout` and `cancellation_settled` events
- mixed marker vocabularies
- consumers must deduplicate terminal state themselves

Intraframe SAF candidate: make `observeOutputLine` classify raw `[subagent007 timeout]` and `[subagent007 cancelled]` as process diagnostics, not terminal lifecycle events, or suppress them from `recent_events` when the task lifecycle will append the normalized terminal event. Keep raw markers in output artifacts for transcript fidelity.

Transframe SAF candidate: replace line-derived lifecycle inference with a typed event bus where `runChildProcess` emits structured `process_timeout` / `process_cancelled` diagnostics and `runTask` alone emits terminal lifecycle transitions.

Selected SAF: Intraframe. The smallest complete fix is to reserve terminal lifecycle authority for `runTask` and demote raw process markers in the public event projection. It eliminates duplicate terminal events without changing artifacts, tool schemas, or process control.

Rejected pseudo-SAF: rename one of the text labels while still emitting two terminal events. That hides the collision but keeps duplicate lifecycle state.

### HORC B: Failure Logging Uses Tool Request Shape Instead Of Run Context

Malformed upstream structure: failure logging derives `cwd` and reason from the immediate tool request. Run-scoped tools like `answer_run_input` and `cancel_run` are keyed by `run_id`, not `cwd`, so validation failures lose the task context unless the handler explicitly resolves it.

Downstream effects:

- late input rejection logs `cwd_class:"missing"`
- expected validation edge maps to `unknown_validation_error`
- failures cannot be reliably joined to session/cwd/task in telemetry

Intraframe SAF candidate: for run-scoped tools, resolve the run snapshot before logging when possible and include `run_id`, `task_kind`, `session_key`, derived `cwd`, and precise reason-code mapping for common input-state errors.

Transframe SAF candidate: introduce a first-class `RunRef`/`OperationContext` primitive required by every handler; all telemetry, validation, state reads, and authorization resolve through that context.

Selected SAF: Intraframe with a small context resolver. It fully fixes the observed telemetry defect and can be implemented without reshaping public tool inputs.

Rejected pseudo-SAF: add a generic `answer_run_input_failed` reason code. That improves labels but still loses cwd/session/run context.

### HORC C: Coverage Manifest Declares More Product Surfaces Than The Probe Can Execute

Malformed upstream structure: `full-current` is a product surface inventory, but its scenario set is still protocol-core. Required surfaces and executable scenarios are not the same abstraction.

Downstream effects:

- `full-current` is permanently red from the bundled scenario set
- manual live trials cannot satisfy the profile ledger
- users get a failure that is true but not self-remediating

Intraframe SAF candidate: add executable scenarios for the missing surfaces: async start/poll, caller input, cancellation, one-shot timeout recovery, valid packet closure, invalid packet closure, and live installed Pi integration. Keep deterministic scenarios deterministic, and require `--mode live-model` only for live-specific scenarios.

Transframe SAF candidate: turn campaigns into a persistent coverage database that can merge multiple evidence ledgers across deterministic, live, and production-state runs, then evaluate `full-current` over the merged evidence set.

Selected SAF: Intraframe for current completeness. Add the missing scenarios and make `full-current` an executable orchestration profile instead of just a required-surface assertion. The transframe coverage database is cleaner long term, but it is more system motion than needed to eliminate the current failure.

Rejected pseudo-SAF: remove missing surfaces from `full-current`. That makes the profile green by weakening its meaning.

### HORC D: Campaign Scope Is Bound To Process Environment

Malformed upstream structure: campaign identity and state paths are read from environment variables at server process start. An already-running installed MCP server cannot be retroactively scoped to a campaign.

Downstream effects:

- live installed evidence lands in production state
- reports must manually distinguish evidence classes
- campaign claims are easy to overstate

Intraframe SAF candidate: provide a live campaign runner that launches a fresh server under `scripts/run-observed-campaign.mjs` and drives all live-model scenarios through that server, including async input/cancel/session flows.

Transframe SAF candidate: add authenticated request-scoped campaign metadata through MCP `_meta` or explicit tool inputs and thread it through output, session, input, and failure paths.

Selected SAF: Intraframe. A live campaign runner gives isolated live evidence without expanding every public tool contract. Request-scoped campaign metadata is more powerful but requires broader protocol and trust design.

Rejected pseudo-SAF: set `SUBAGENT007_CAMPAIGN_ID` in the parent shell after the MCP server is already running. That does not change the server process environment.

### HORC E: Public Transcript Redaction Is Structural, Not Data-Flow-Aware

Malformed upstream structure: the event projection knows how to redact packet blocks and omit direct input-answer events, but it does not track sensitive values through later model-generated assistant text.

Downstream effects:

- input answers can appear in public assistant output if the task asks the child to echo them
- "answer omitted from public events" can be misread as stronger confidentiality

Intraframe SAF candidate: clarify the README and tool docs: `answer_run_input.answer` is omitted from mailbox/public input events, but child-generated output is public unless the task or a future sensitivity mode prevents disclosure.

Transframe SAF candidate: add sensitivity-labeled input channels and dataflow redaction, where values supplied through `answer_run_input` can be marked nonpublic and exact/derived leaks are blocked or redacted in transcript projections.

Selected SAF: Intraframe for the observed incoherence. The system currently behaves as designed; the smallest sufficient correction is to remove the ambiguous implication. Dataflow redaction is a separate privacy feature with substantial false-positive/false-negative design cost.

Rejected pseudo-SAF: redact every assistant line that contains an input answer string. That breaks legitimate echo workflows and still cannot handle paraphrase or transformation.

### HORC F: Active Progress Is Timer-Based, Not Phase-Based

Malformed upstream structure: active liveness depends mostly on heartbeat intervals and child-visible events. Before the first heartbeat or model/tool event, the state remains at `child process starting`.

Downstream effects:

- 5s timeout runs can have no heartbeat at all
- 20s model/tool startup periods look unchanged except for `elapsed_ms`

Intraframe SAF candidate: add explicit phase transitions after spawn, such as `child_started`, `awaiting_child_event`, and `last_output_at`, and emit an immediate first heartbeat snapshot after spawn.

Transframe SAF candidate: expose a structured child runtime state machine with provider/model/tool phases, not just a generic progress message.

Selected SAF: Intraframe. Immediate post-spawn phase metadata improves liveness without requiring Pi/provider internals.

Rejected pseudo-SAF: shorten the heartbeat interval globally. That increases write/notification churn and still misses very short effective timeouts.

## SAF Priority

1. HORC A: normalize terminal lifecycle authority. This removes duplicate terminal events and cleans the public event stream.
2. HORC B: enrich run-scoped failure context. This makes expected edge telemetry actionable.
3. HORC C/D: make full-current live campaign execution real. These two are related; adding live executable scenarios under an isolated campaign runner would close both coverage and attribution gaps.
4. HORC E: clarify input-answer confidentiality language.
5. HORC F: improve active phase metadata.

## Overall Verdict

Current e2e functionality is operationally healthy. The observed defects are concentrated in meta-surfaces: event projection, telemetry context, coverage execution, campaign attribution, and documentation boundaries. No evidence from this campaign shows a fundamental child execution, session continuity, packet-gating, or mailbox correctness failure.
