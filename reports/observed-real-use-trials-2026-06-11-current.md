# Observed Real-Use Trials: Subagent007 MCP Server

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`

Status: pre-repair observed-use campaign. The issues recorded here drove the current SAF implementation; retained trial observations describe the server behavior at campaign time.

## Scope

Campaign goal: exercise the Subagent007 MCP server as a real caller would, covering core end-to-end functionality, validation edges, stateful continuity, sessions, packet gates, cancellation, timeouts, skill binding, model inventory, and the observed-campaign harness.

Evidence classes:

- Local code health: `npm run build`, `npm run typecheck`, `npm test`, `npm run models:reconcile`.
- Campaign-scoped stdio MCP probes against `dist/server.js`.
- Installed MCP tool calls through the active `subagent007` server. These wrote production-state observations under `/Users/rgalyavin/.codex/subagent007-pi`.

## Health Checks

- `npm run build`: pass.
- `npm run typecheck`: pass.
- `npm test`: pass, 100 tests.
- `npm run models:reconcile`: pass. Pi registry, OpenRouter, and Ollama sources all reported the curated model refs as present.

## Trial Matrix And Observations

| ID | Surface | Trial | Observation |
| --- | --- | --- | --- |
| T1 | Tool listing | Raw MCP SDK `listTools()` under `campaign.20260611.schema-extra`. | Eight tools exposed: `answer_run_input`, `cancel_run`, `get_run`, `list_allowed_models`, `list_model_classes`, `run_subagent`, `run_subagent_session`, `start_run`. The extra tool is the documented compatibility alias. |
| T2 | Model listing | Installed `list_model_classes`. | Classes A-E returned. Default class was `C`; class A had healthy one-shot health, others unknown. |
| T3 | One-shot success | Installed `run_subagent`, class A, exact output. | Completed in about 15.2s and wrote exactly `INSTALLED_ONE_SHOT_OK`. |
| T4 | Async caller input | Installed `start_run`, class A, prompt forced `request_input`. | `get_run` showed `input_required` after about 20s. `answer_run_input` settled the request and final output was exactly `ECHO_TOKEN:TRIAL_TOKEN_611`. |
| T5 | Cancellation | Installed `start_run` shell sleep, then `cancel_run`. | Cancelled in about 3.7s. Terminal snapshot had `status:"cancelled"`, `exit_code:null`, and transcript marker `[subagent007 cancelled]`. |
| T6 | Timeout | Installed `start_run`, shell-capable, `timeout_ms:20000`. | Failed with `timed_out:true` after effective child runtime of 13s. Transcript had only user prompt plus timeout marker; `partial_output_available:false`. |
| T7 | Raw Pi continuity | Installed `run_subagent` with `continuity:{mode:"fresh"}`, then resume with returned session file. | Fresh session established. Resume returned exact remembered marker `RAW_MARKER_611X`. |
| T8 | Named session continuity | Installed `run_subagent_session`, `resume_mode:"new"`, then `require_existing`. | Created and resumed successfully. Ledger had two committed records. Resume returned exact marker `NAMED_MARKER_611Y`. |
| T9 | Named session negative modes | Existing session with `resume_mode:"new"`; missing session with `require_existing`. | Both rejected before child invocation with clear text errors. Failure log classified them as `session_already_exists` and `session_does_not_exist`. |
| T10 | Required packet, valid | Installed `run_subagent_session`, `packet_policy:"required"`, ready packet with empty blockers and omitted closure. | Committed successfully; `packet_parse_status:"valid"` and packet JSON persisted. |
| T11 | Required packet, invalid closure | Installed `run_subagent_session`, ready packet but malformed `closure.artifact_roles` and `closure.validation`. | Failed closed. `exit_code:0`, `success:false`, `packet_parse_status:"invalid"`, no manifest, attempt recorded in `attempts.jsonl`. Took about 82s. |
| T12 | Skill binding | Installed `start_run` with `skill_name:"pda-lite"`, output transcript. | Completed successfully after about 80s. Transcript showed `/skill:pda-lite` was injected and final answer contained `SKILL_BOUND_OK`. |
| T13 | Skill validation | Installed `run_subagent` with a skill path; prompt-level `/skill:pda-lite` without `skill_name`. | Both rejected before child execution with clear guidance. |
| T14 | Schema edges | Campaign-scoped raw SDK calls with forbidden fields. | `run_subagent.timeout_ms`, `start_run.session_id`, and `run_subagent_session.continuity` rejected at MCP schema boundary with targeted messages. Missing run IDs rejected consistently for `get_run`, `answer_run_input`, and `cancel_run`. |
| T15 | Bundled observed probe | `campaign.20260611.current-full`, `observed-mcp-probe --scenario all-bundled`. | Success, schema error, and handler validation behaved. The scripted `child-failure` scenario unexpectedly returned success. The scripted `packet-failure` scenario hit a client-side MCP timeout and left a stale temp session lock. |
| T16 | Broad synthesis one-shot | Installed `run_subagent`, class A, concise HORC/SAF synthesis over observed facts. | Timed out at the one-shot effective runtime of 103s with no useful partial output. Returned `timeout_recovery_hint`. |

Campaign-scoped paths:

- `campaign.20260611.current-full`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.current-full-OEwi9n`
- `campaign.20260611.schema-extra`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.schema-extra-NZ1tGY`

Selected installed output paths:

- One-shot exact marker: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T170511464Z-cc99da596c0f.md`
- Caller input output: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T170624597Z-c706ab17724f.md`
- Timeout transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T170709841Z-95c626ad436b.md`
- Skill transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T171317008Z-4c06fdd04888.md`

## Observed Issues And Incoherences

### I1. Active Run Progress Is Too Opaque

Repeated on T4, T6, and T12: `get_run` exposed only `status:"working"`, elapsed time, heartbeat count, and generic `last_progress_message:"running"` until input or terminal state. For the skill-bound task, this lasted about 80s even though the child eventually succeeded.

Relevant implementation:

- `src/runTask.ts` stores only `last_progress_message` and `heartbeat_count` in active views.
- `src/processRunner.ts` sends heartbeat notifications, but the default message remains generic unless a richer message provider is supplied.
- Child stdout/stderr is buffered until completion, so public transcript evidence is not visible through `get_run` during execution.

### I2. Partial Output Often Has Low Diagnostic Value On Timeout

T6 timed out cleanly and returned precise budget metadata, but the transcript had only the user prompt and timeout marker. T16 also timed out without useful partial output. The metadata is correct; the practical issue is that public child events are not persisted incrementally.

### I3. Broad Analytical Work Is Still Easy To Misroute To `run_subagent`

T16 asked for a concise synthesis and still consumed the one-shot budget. The tool returned a helpful `timeout_recovery_hint`, but only after 103s effective runtime. Historical failure-log tail also shows repeated `run_subagent` one-shot timeouts.

### I4. The Bundled Probe Overstates Deterministic Coverage

The `observed-mcp-probe --scenario all-bundled` name suggests broad coverage, but its own summary left many surfaces uncovered. More importantly:

- Its `child-failure` scenario uses a prompt token (`FAIL_EXIT`) against a real model, so real Pi can simply answer successfully.
- Its `packet-failure` scenario had no explicit client request timeout alignment with the server-side session timeout; the SDK call timed out at about 60s, while the server-side session left a stale lock in the temp campaign session directory.

This is a harness issue, not a core server failure.

### I5. Required Packet Closure Is Strict And Model-Authored JSON Remains Fragile

T10 showed the happy path works when `closure` is omitted. T11 showed malformed closure fails closed correctly. The incoherence is ergonomic: a model can produce semantically understandable closure data that fails because arrays are required. The strictness is defensible for machine contracts, but callers need to know that `required` means "schema-valid JSON exactly", not "substantively ready".

### I6. Tiny Skill-Bound Work Can Be Slow Without Intermediate Explanation

T12 succeeded, but a deliberately tiny `pda-lite` task took about 80s. This may be acceptable for skill loading plus model latency, but paired with I1 it creates a poor observed-use experience.

## Common Patterns

1. Core mechanics are healthy: launch, output capture, timeout/cancel termination, caller input, raw continuity, named sessions, packet commit/attempt separation, model class listing, skill validation, and failure logging all work.
2. The weak layer is observability during nonterminal work. The server has durable final artifacts, but active task state is mostly lifecycle-level.
3. The scripted harness sometimes tests model compliance rather than server mechanics, making probe outcomes sensitive to model behavior.
4. Current public contracts are mostly strict and coherent, but names like `all-bundled` and `run_subagent` still invite overbroad expectations.

## HORCs And SAFs

### HORC 1: Active Runs Are Modeled As Lifecycle Snapshots, Not Event Streams

The highest-order root cause is that a run's durable state is a coarse task snapshot. Child activity, public transcript increments, tool/action phases, and skill-loading phases are not first-class persisted events available to `get_run`.

Intraframe SAF candidate:

- Persist a small redacted `recent_events` array and `last_public_output_excerpt` into run-task snapshots. Populate it from sanitized child stdout/stderr/progress events as they arrive, with the same redaction rules used for final transcript rendering.

Transframe SAF candidate:

- Replace task snapshots with an event-sourced run ledger and make `get_run` a projection over that ledger. Treat heartbeat, child output, input request, tool phase, cancellation, timeout, and terminal result as typed events.

Selected SAF:

- Intraframe first: add a bounded persisted recent-events projection. It removes the real defect with less motion than rebuilding the run store, and it can later become the compatibility projection for a fuller event ledger.

Rejected pseudo-SAFs:

- Lower heartbeat interval only. More frequent `running` messages do not explain what the child is doing.
- Add more final transcript metadata only. The issue is active-run opacity.

### HORC 2: One-Shot Suitability Is A Caller Promise With Late Enforcement

The highest-order root cause is that `run_subagent` relies on the caller to know whether work is quick and noninteractive. The server enforces only after the expensive child run consumes the one-shot timeout.

Intraframe SAF candidate:

- Add a preflight suitability classifier for `run_subagent`: reject or strongly redirect prompts with skill binding, synthesis/audit/review markers, long prompt length, or explicit broad-work vocabulary unless the caller uses `start_run`. Return the same recovery guidance before child spawn.

Transframe SAF candidate:

- Collapse `run_subagent` and `start_run` behind a scheduler tool that chooses sync-return only for proven tiny prompts and otherwise returns an async `run_id`.

Selected SAF:

- Intraframe preflight redirect. It preserves the current public surface and prevents the common expensive mistake. The transframe scheduler is cleaner long-term but moves more contract surface than needed.

Rejected pseudo-SAFs:

- Increase the one-shot timeout. That hides routing mistakes and makes failed calls more expensive.
- Re-add caller `timeout_ms` to `run_subagent`. That blurs the deliberate one-shot contract.

### HORC 3: The Observed Probe Mixes Protocol Assertions With Model-Compliance Prompts

The highest-order root cause is that the campaign probe tries to prove server behavior using prompts that require a real model to behave in a specific way. That makes "child failure" and packet-failure scenarios probabilistic.

Intraframe SAF candidate:

- Split probe modes into `protocol-deterministic` and `live-model`. Use `SUBAGENT007_PI_CHILD_PATH` with the existing fake child for deterministic failure, packet, timeout, and transcript cases; keep a separate live-model smoke scenario for installed Pi integration.

Transframe SAF candidate:

- Define an MCP-level conformance harness that can drive server internals through deterministic child adapters and separately attach live-provider health probes as non-conformance checks.

Selected SAF:

- Intraframe split. The code already supports `SUBAGENT007_PI_CHILD_PATH`; the smallest sufficient change is to make the probe use that capability for deterministic scenarios and rename `all-bundled` to avoid implying complete live coverage.

Rejected pseudo-SAFs:

- Tune the `FAIL_EXIT` prompt. A different prompt is still a model-compliance test, not a deterministic child-failure test.
- Ignore client request timeouts. The timeout mismatch is exactly what produced stale campaign state.

### HORC 4: Session Locks Depend On Handler Completion, But Client Timeouts Can Abandon The Handler

The highest-order root cause is that synchronous `run_subagent_session` holds a filesystem lock for the duration of child execution, while an MCP client can time out before the server-side handler reaches `finally`. The campaign packet-failure trial showed a stale temp lock whose owner PID was gone.

Intraframe SAF candidate:

- Add session-level timeout guidance to the probe and pass explicit SDK request timeouts longer than server `timeout_ms`; also add a cleanup/audit step in the campaign harness that identifies stale local locks in its state root after the command exits.

Transframe SAF candidate:

- Move named session execution onto the durable `start_run` task model so long session work is always cancellable/pollable and lock cleanup is decoupled from synchronous MCP request lifetime.

Selected SAF:

- Intraframe for the harness defect: align client and server timeouts and audit stale locks after campaign commands. For product evolution, the transframe async-session model is cleaner, but it is larger than needed to fix the observed campaign issue.

Rejected pseudo-SAFs:

- Delete stale locks unconditionally. That risks corrupting a genuinely active run on another host or process.
- Treat all packet-failure calls as short. Live model latency made that false.

## Recommended Next Fix Order

1. Fix observed probe determinism and timeout alignment. It improves future evidence quality with low code motion.
2. Add bounded recent active events to `get_run`. This addresses the most repeated real-use incoherence.
3. Add `run_subagent` preflight redirection for broad or skill-bound work.
4. Clarify packet policy docs around strict JSON validity and closure shape, including examples of "ready without closure" and "invalid closure fails closed".
