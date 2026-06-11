# Observed Real Use Trials - Subagent007 MCP - 2026-06-11

Status: historical pre-implementation observed-use campaign. The revised SAF set derived from this report has since been implemented in the current worktree; retained observations describe the state at campaign time.

## Scope

Objective: plan and run observed real-use trials covering the `subagent007-pi` MCP server end-to-end, including happy paths, schema errors, handler validation, child failures, timeout behavior, async runs, caller input, cancellation, named sessions, packet gating, transcript redaction, model calibration, failure logging, and campaign evidence boundaries.

Evidence classes used:

- `unit/integration`: local project checks through `npm run typecheck`, `npm test`, and `npm run models:reconcile`.
- `campaign-scoped`: `scripts/run-observed-campaign.mjs` launching `dist/server.js` under isolated state with the fake Pi child.
- `sdk-client-with-fake-pi`: direct MCP SDK client against `dist/server.js` with isolated state and fake Pi child.
- `installed-production`: direct calls through the installed `mcp__subagent007` tools in this Codex session.

No source code changes were made by this campaign. This report is the only repository write.

## Trial Plan

1. Verify baseline build/test/model inventory.
2. Run the bundled campaign probe for all supported probe scenarios:
   - success,
   - schema error,
   - handler validation error,
   - child nonzero failure,
   - required packet failure.
3. Run additional SDK trials not covered by the bundled probe:
   - tool list and alias behavior,
   - one-shot timeout guidance,
   - transcript redaction,
   - async liveness plus caller input answer,
   - cancellation closing input requests,
   - valid required packet with closure,
   - invalid closure shape rejection.
4. Run installed-production MCP trials:
   - model class listing,
   - one-shot smoke using class A,
   - async smoke using class B,
   - caller-input run using class B,
   - named session plus required packet using class B,
   - one-shot independent review attempt using class B.
5. Group observed issues, identify common patterns, identify HORCs, and select SAFs.

## Commands And Results

### Baseline

Command:

```sh
npm run typecheck && npm test
```

Result: pass. The full suite passed: 95 tests, 0 failures.

Command:

```sh
npm run models:reconcile
```

Result: pass. Pi reported 263 models, OpenRouter 337, Ollama 1. All curated refs were present:

- `openai-codex/gpt-5.4+`
- `openai-codex/gpt-5.5`
- `ollama/gemma4:12b`
- `openrouter/deepseek/deepseek-v4-flash`
- `openrouter/deepseek/deepseek-v4-pro`

### Campaign-Scoped MCP Probe

Command shape:

```sh
SUBAGENT007_CONFIG_PATH=<temp>/config.json \
SUBAGENT007_PI_CHILD_PATH=<fake-pi-child> \
FAKE_PI_LOG_PATH=<fake-pi-log> \
SUBAGENT007_RECORD_SOURCE=test \
npm run observed-campaign -- \
  --campaign-id campaign.2026-06-11.full-e2e \
  --state-root <temp-state-root> \
  -- npm run observed-mcp-probe -- \
    --server ./dist/server.js \
    --cwd /Users/rgalyavin/myApps/003-subagent007-pi \
    --scenario all
```

Result: pass.

Campaign summary:

- `campaign_id`: `campaign.2026-06-11.full-e2e`
- `evidence_class`: `campaign-scoped`
- `campaign_ledger_path`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-campaign-20260611-XXXXXX.V4ks2ClwXB/campaign-ledger.jsonl`
- `failure_log_path`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-campaign-20260611-XXXXXX.V4ks2ClwXB/failures.jsonl`

Observed counts:

- campaign ledger: 13 records
- failure log: 3 records
- event counts: `call_started:5`, `call_result:3`, `call_schema_error:1`, `call_handler_error:1`, `failure_log_delta:3`

Observed behavior:

- Success call completed with `success:true`.
- SDK schema error was recorded in campaign ledger and did not produce a server failure-log delta.
- Handler validation error produced `failure_class:validation_error`, `reason_code:cwd_not_absolute`.
- Child failure produced `failure_class:nonzero_exit`, `reason_code:nonzero_exit`.
- Required packet failure produced `failure_class:packet_failed`, `reason_code:packet_required_invalid`.
- Prompt sentinels did not appear in the campaign ledger or failure log.

### Additional SDK Fake-Pi Trials

Result: pass.

Observed scenarios:

- `tool-list`: all eight expected tools exposed.
- `model-class-alias`: `list_allowed_models` matched `list_model_classes`; default class `C`.
- `one-shot-timeout`: timed out with `timeout_recovery_hint`; `partial_output_available:true`.
- `transcript-redaction`: public assistant text was retained; thinking events and secret marker were absent.
- `async-liveness-input-answer`: heartbeat appeared under SDK fake-client path, status became `input_required`, answer settled, run completed.
- `cancel-closes-input`: cancellation closed pending request and late answer was rejected.
- `session-required-packet-valid-closure`: required packet with valid closure succeeded and committed session.
- `session-required-packet-invalid-closure`: malformed closure was rejected; attempt session existed while committed session stayed false.

### Installed-Production Trials

#### Model class listing

`list_model_classes` succeeded. Current installed config:

- `default_model_class`: `C`
- `default_model_class_configured`: `C`
- `config_migration`: `null`
- `resolved_default_model`: `openrouter/deepseek/deepseek-v4-pro`
- `resolved_default_thinking_level`: `high`

#### One-shot class A smoke

Call:

- tool: `run_subagent`
- model class: `A`
- prompt: exact reply with `SUBAGENT007_LIVE_SMOKE_OK`

Observed result:

- `status:failed`
- `timed_out:true`
- `duration_ms:103018`
- `resolved_model:ollama/gemma4:12b`
- `partial_output_available:false`
- `timeout_recovery_hint` present

Output file contained only the user prompt and timeout marker. `pi --list-models` showed `ollama/gemma4:12b` is present, so this is not an inventory/auth miss.

#### Async class B smoke

Call:

- tool: `start_run`
- model class: `B`
- timeout: `180000`
- prompt: exact reply with `SUBAGENT007_LIVE_ASYNC_OK`

Observed result:

- initial status: `working`
- completed in `4842ms`
- `success:true`
- `resolved_model:openrouter/deepseek/deepseek-v4-flash`
- output exactly `SUBAGENT007_LIVE_ASYNC_OK`

In the installed MCP path, active `get_run` exposed `elapsed_ms`, but `heartbeat_count` stayed `0` before completion.

#### Installed caller-input path

Call:

- tool: `start_run`
- model class: `B`
- prompt forced use of `request_input`

Observed result:

- run became `input_required`
- request question: `What token should I echo?`
- `answer_run_input` with `LIVE_INPUT_OK` settled the request as `answered`
- run completed successfully
- output exactly `ECHO:LIVE_INPUT_OK`

Again, `heartbeat_count` stayed `0` in the installed MCP path even though status transitions were visible.

#### Installed named session required packet

Call:

- tool: `run_subagent_session`
- model class: `B`
- `resume_mode:new`
- `packet_policy:required`

Observed result:

- `success:true`
- `packet_parse_status:valid`
- `session_established:true`
- `attempt_session_established:true`
- committed session promoted
- claimed packet: `verdict:"ready"`, `blockers:[]`, `summary:"live packet ok"`

#### Installed one-shot independent review attempt

Call:

- tool: `run_subagent`
- model class: `B`
- prompt asked for an independent review of repository risks and SAFs

Observed result:

- `status:failed`
- `timed_out:true`
- `partial_output_available:true`
- transcript contained only the user prompt and assistant text: `I'll start by reading the relevant files in parallel.`
- no useful review findings were produced before timeout
- `timeout_recovery_hint` present

## Observed Issues And Incoherences

### I1 - Class A Is Advertised As The Simplest Tier But Timed Out On A Trivial Exact-Reply Task

Severity: P1 for installed usability.

Observed evidence:

- `list_model_classes` advertises class `A` as suitable for the simplest mechanistic tasks.
- `run_subagent` with class `A` and a trivial exact-reply prompt timed out after 103 seconds.
- `pi --list-models` confirmed `ollama/gemma4:12b` exists, so the failure is not merely missing inventory.

Why it matters:

Class `A` is the first thing a caller will choose for cheap/simple work. If it can fail a smoke prompt, the model-class abstraction is misleading even when reconciliation passes.

### I2 - The One-Shot Tool Still Attracts Work That Is Structurally Not One-Shot-Safe

Severity: P2.

Observed evidence:

- The installed independent review attempt with class `B` timed out after 103 seconds after only starting file reads.
- The timeout hint correctly routed to `start_run`.
- The server cannot know from `run_kind:"quick_noninteractive"` whether the prompt is actually bounded.

Why it matters:

The public contract depends on callers truthfully and accurately classifying work. In practice, review/exploration prompts are easy to send to `run_subagent`, and the result is a late timeout plus weak partial output.

### I3 - Installed Async Liveness Is Weaker Than The Documented/Intended Liveness Repair

Severity: P2/P3.

Observed evidence:

- SDK fake-client trial showed heartbeat metadata under a direct SDK client path.
- Installed MCP trials showed `elapsed_ms` and status transitions, but `heartbeat_count` stayed `0` during both async smoke and caller-input trials.
- The caller-input trial still reached `input_required`, so state transitions are useful; the missing piece is heartbeat/progress metadata.

Why it matters:

The README promises active runs expose liveness/progress metadata through `get_run`. The implementation only starts process heartbeats when a heartbeat notifier exists, so installed clients that do not provide a progress token get a weaker proof of active supervision.

### I4 - Bundled `--scenario all` Campaign Probe Is Not Full E2E Coverage

Severity: P3.

Observed evidence:

- The bundled probe's `all` covers success, schema error, handler validation, child failure, and packet failure.
- It does not cover async run polling, timeout recovery, caller input, cancellation settlement, transcript redaction, valid closure parsing, invalid closure shape rejection, session resume, or live Pi integration.
- Additional SDK and installed-production trials were required for those paths.

Why it matters:

The campaign harness is now a good evidence boundary, but its scenario vocabulary can still invite overclaiming. `--scenario all` means all bundled probe scenarios, not all MCP product functionality.

### I5 - Production Failure Logs Contain Mixed Historical Calibration Semantics

Severity: P4.

Observed evidence:

- Recent production failures include older records with concrete `model` and `thinking_level:"medium"` and current records with `model_class:"A"` plus `thinking_level:"high"`.
- Current config is canonical, and current model reconciliation passes.

Why it matters:

This is not a current runtime bug, but longitudinal failure-log analysis can confuse pre-migration and post-migration semantics unless reports segment by server version/config era.

## Common Patterns

1. Boundary repairs work best when the observer is explicit. The campaign ledger cleanly observes SDK schema errors that server handler logs cannot see.
2. The product is strongest when work is represented as a lifecycle object: async runs, input requests, and named sessions now expose coherent state transitions.
3. The remaining incoherences are mostly classification problems: model class vs real latency, one-shot contract vs real task shape, and `all` scenario naming vs real coverage.
4. Several fixes are correct but scoped. Timeout hints, campaign ledgers, and heartbeat metadata each improve a narrow boundary; they do not eliminate the broader need for workload/model/runtime health routing.

## HORCs And SAFs

### HORC-1 - Static Model-Class Calibration Is Treated As Capability Truth

Malformed primitive:

`MODEL_CLASS_CALIBRATIONS` maps class `A` to `ollama/gemma4:12b` as a static capability tier, and `list_model_classes` reports availability/config health, not real task latency or smoke-test health.

Downstream effects:

- A trivial class `A` prompt timed out.
- Model reconciliation still passed because inventory presence is not execution suitability.
- Callers receive a valid-looking class and only learn about unsuitability after a 103-second timeout.

Intraframe SAF candidate:

Change class `A` calibration from `ollama/gemma4:12b` to a model that passes a live trivial smoke within the one-shot budget in this environment, or demote `A` behind an explicit health-gated warning in `list_model_classes` until it passes.

Transframe SAF candidate:

Introduce a runtime model-class health registry: periodic or on-demand smoke probes record `{class, model, available, last_success_latency_ms, last_failure, usable_for_one_shot}`; resolution refuses or warns on unhealthy class bindings.

Selected SAF:

Transframe, but in the smallest useful form: add a first-class smoke-health check to model-class resolution/reporting and make class `A` non-default/non-recommended for one-shot until it passes. Merely swapping the model may fix today's symptom but preserves the false equation of inventory presence with usable capability.

Pseudo-SAFs rejected:

- Increase the one-shot timeout.
- Declare class `A` "best effort" only in docs.
- Remove class `A` without creating a health boundary for future drift.

### HORC-2 - Workload Shape Is A Caller Assertion, Not A Server-Routable State

Malformed primitive:

`run_subagent` accepts `run_kind:"quick_noninteractive"` as a contract, but the server does not independently classify whether the prompt is actually quick, bounded, or non-exploratory.

Downstream effects:

- Exploratory/review prompts can time out after doing preparatory work.
- The recovery hint is useful but only after a late failure.
- Partial output may contain no actionable work product.

Intraframe SAF candidate:

Add a cheap preflight classifier for obvious non-quick prompts and reject or soft-route them to `start_run`: keywords and structural signals such as "review repo", "investigate", "plan and run", "fully cover", "inspect files", "campaign", "e2e", and prompt length/depth.

Transframe SAF candidate:

Collapse public execution onto async-first semantics: make all child work a `start_run` task and treat `run_subagent` as a thin compatibility wrapper that starts, polls up to the one-shot budget, and returns a resumable `run_id` on timeout.

Selected SAF:

Transframe. The minimal complete repair is async-first one-shot compatibility: every run has a durable task identity from the start. This preserves quick-call ergonomics while eliminating dead-end one-shot timeouts and avoiding brittle prompt classification as the sole guard.

Pseudo-SAFs rejected:

- Only add more warning text to README.
- Only tune keyword rejection.
- Only raise `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`.

### HORC-3 - Active Progress State Is Coupled To Optional Client Progress Plumbing

Malformed primitive:

`startRunTask` records heartbeat metadata only when `runSubagent` is given a heartbeat notifier. In installed MCP use, the observable task state can stay at `heartbeat_count:0` even while the server supervises the child.

Downstream effects:

- `get_run` can show `working` plus elapsed time, but not last progress.
- The same code path behaves better in SDK/test contexts than in the installed tool context.
- The liveness repair is partially dependent on client transport behavior rather than run-task state itself.

Intraframe SAF candidate:

Always install an internal heartbeat/progress updater for `start_run` task snapshots, independent of whether MCP progress notifications are available. If a client notifier exists, fan out to it separately.

Transframe SAF candidate:

Replace heartbeat fields with a persisted sanitized run-event ledger used by both `get_run` and progress notifications.

Selected SAF:

Intraframe. The observed incoherence is not lack of full event sourcing; it is that snapshot liveness depends on optional notification plumbing. An internal heartbeat writer is the smallest sufficient correction.

Pseudo-SAFs rejected:

- Say `elapsed_ms` is enough.
- Require all MCP clients to provide progress tokens.
- Persist raw child stdout/stderr as progress.

### HORC-4 - Campaign Scenario Vocabulary Overstates Coverage Semantics

Malformed primitive:

`--scenario all` means all scenarios known to `run-observed-mcp-probe.mjs`, but the name reads like complete product E2E coverage.

Downstream effects:

- Campaign reports can pass while major lifecycle paths remain unobserved.
- Future reports may confuse campaign boundary completeness with product surface completeness.

Intraframe SAF candidate:

Rename/report `all` as `all-bundled` or include an explicit uncovered-surface list in the probe summary.

Transframe SAF candidate:

Make the probe scenario registry first-class and coverage-tagged, with each tool/lifecycle feature mapped to at least one scenario and report output showing covered/uncovered surfaces.

Selected SAF:

Intraframe now: change the summary label/documentation to `all-bundled` and print uncovered major surfaces. This removes the overclaim with minimal motion. The coverage registry becomes justified if campaign use expands.

Pseudo-SAFs rejected:

- Rely on human report prose to clarify every time.
- Add more scenarios but keep `all` semantically vague.

### HORC-5 - Failure Records Lack An Explicit Calibration Era

Malformed primitive:

Failure records encode current run metadata but do not explicitly name whether a record was produced before or after model-class migration/calibration changes.

Downstream effects:

- Historical production logs can mix `model/thinking_level` semantics with `model_class` semantics.
- Analysts may infer current calibration behavior from stale records.

Intraframe SAF candidate:

Add `resolved_model_class`/`calibration_version` or `model_class_schema_version` to all failure records and reports going forward.

Transframe SAF candidate:

Move operational analytics to a versioned event schema with migration-aware readers.

Selected SAF:

Intraframe. Current runtime behavior is coherent; the defect is analysis ambiguity in logs. A calibration/schema-era field is sufficient.

Pseudo-SAFs rejected:

- Delete or ignore old failure records.
- Infer era only from timestamp.

## Final Assessment

The current codebase has materially repaired the June 10 lifecycle and evidence-boundary defects: input settlement, session attempt/commit fields, packet closure parsing, timeout recovery hints, campaign ledgers, and config migration all held under trials.

The most important remaining issue is upstream of those repaired mechanics: model/workload routing. The system exposes clean tool contracts, but the selected child execution path can still be wrong for the real work. The next highest-leverage fixes are model-class health gating and async-first execution identity.
