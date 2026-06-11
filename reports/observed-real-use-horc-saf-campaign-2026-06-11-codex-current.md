# Observed Real-Use HORC/SAF Campaign: Subagent007 MCP Server

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Status: pre-repair observed-use campaign. The executable behavior for coverage aliases, scheduler-first runs, active liveness, and model-health disclosure has since been repaired in the current worktree; this file remains traceability for the observations that drove those repairs.

## Campaign Goal

Plan and run observed real-use trials covering the current end-to-end MCP server surface and edge cases, then distinguish common patterns, identify highest-order root causes, and select Supreme Atomic Fix candidates for distinct residual incoherences.

## Evidence Classes

- Local health checks: `npm run build`, `npm run typecheck`, `npm test`, `npm run models:reconcile`.
- Campaign-scoped deterministic MCP probe: fake child through `SUBAGENT007_PI_CHILD_PATH`, isolated state root.
- Campaign-scoped live-model MCP probe: fresh stdio server with real Pi integration, isolated state root.
- Installed MCP tool calls through the active Codex `subagent007` server. These are production-state observations under `/Users/rgalyavin/.codex/subagent007-pi`.

## Plan Executed

1. Map product surface from `README.md`, `src/server.ts`, and `scripts/observed-coverage-manifest.json`.
2. Build current `dist/server.js`.
3. Run deterministic full-current probe for schema, preflight, child process, timeout, async polling, caller input, cancellation, packet gate, session closure, and transcript redaction surfaces.
4. Run live-current probe for real Pi integration.
5. Run installed-server live trials for model listing, caller input, cancellation, and broad-work one-shot preflight.
6. Run project health checks and reconcile model inventory.
7. Inspect implementation around progress snapshots, heartbeat, one-shot suitability, session locks, packet gates, and probe aliases.

## Health Checks

- `npm run build`: pass.
- `npm run typecheck`: pass.
- `npm test`: pass, 117 tests.
- `npm run models:reconcile`: pass. Pi registry, OpenRouter, and local Ollama all reported calibrated model refs present.

## Campaign-Scoped Probe Evidence

### Deterministic Full-Current

Command:

```sh
npm run observed-campaign -- --campaign-id campaign.20260611.codex-full-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile full-current
```

Summary:

- `campaign_id`: `campaign.20260611.codex-full-current`
- `evidence_class`: `campaign-scoped`
- `mode`: `protocol-deterministic`
- `state_root`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-full-current-AoCPwQ`
- `campaign_ledger_path`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-full-current-AoCPwQ/campaign-ledger.jsonl`
- `failure_log_path`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-full-current-AoCPwQ/failures.jsonl`
- `missing_required_surfaces`: none.
- Required covered surfaces: tool listing, model-class listing, one-shot success, schema error, preflight rejection, child failure, timeout recovery, async polling, caller input, cancellation settlement, transcript redaction, packet failure, valid packet closure, invalid packet closure.

Notable observed outcomes:

- `child-failure` deterministically returned `exit_code:42`, `success:false`.
- `timeout-recovery` returned `timed_out:true` and `timeout_recovery_hint:true`.
- `caller-input` completed with `input_request_count:1` and `pending_input_count:0`.
- `cancellation` reached `status:"cancelled"` and included a `cancellation_settled` event.
- Required packet inconclusive failed closed with `packet_parse_status:"valid"` but `success:false`.
- Invalid closure failed closed with `packet_parse_status:"invalid"` and precise closure shape errors.
- Transcript redaction succeeded and did not leak fake thinking payloads.

### Live-Current

Command:

```sh
npm run observed-campaign -- --campaign-id campaign.20260611.codex-live-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile live-current
```

Summary:

- `campaign_id`: `campaign.20260611.codex-live-current`
- `evidence_class`: `campaign-scoped`
- `mode`: `live-model`
- `state_root`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-live-current-RZyDJ5`
- `campaign_ledger_path`: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-live-current-RZyDJ5/campaign-ledger.jsonl`
- `missing_required_surfaces`: none.
- Required covered surfaces: tool listing, model-class listing, one-shot success, installed Pi integration.

Notable observed outcomes:

- Real Pi one-shot `success` scenario completed with `exit_code:0`.
- Real Pi installed integration scenario completed with `exit_code:0`.

## Installed-Server Live Trials

| ID | Surface | Trial | Observation |
| --- | --- | --- | --- |
| L1 | Model class listing | `list_model_classes` through active MCP server. | Classes A-E exposed. Default class `C`; configured and effective default both `C`; class `A` one-shot health healthy; classes B-E unknown. |
| L2 | Async caller input | `start_run`, class A, prompt required `request_input`; polled with `get_run`; answered via `answer_run_input`. | Input request appeared after about 26s. Final run completed in 34.1s with output `ANSWERED:TOKEN_611_LIVE`. Run id `2026-06-11T220748243Z-034ad91c658b`; output path `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T220822396Z-507661c3c857.md`. |
| L3 | Active progress before child output | Same run as L2, polled repeatedly before input. | For about 26s, status remained `working`, `active_phase:"awaiting_child_event"`, `heartbeat_count:0`, and `last_progress_message:"child process starting"`. `recent_events` and `last_public_output_excerpt` existed, but no alive/running update occurred until input. |
| L4 | Cancellation | `start_run` shell-capable 90s sleep, then `cancel_run`, then `get_run`. | Cancellation settled in about 3.3s. Final snapshot had `status:"cancelled"`, `stop_reason:"cancelled"`, `exit_code:null`, `cancellation_settled` event, and output path `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-11T220830577Z-6dedcd622536.md`. |
| L5 | Broad one-shot preflight | `run_subagent` prompt containing `Investigate`, `HORC`, and `SAF`. | Immediate structured rejection: `kind:"preflight_rejected"`, `child_started:false`, `reason_code:"run_subagent_incompatible_workload"`, with guidance to use `start_run`. |

## Observed Issues And Incoherences

### I1. Silent Child Startup Still Looks Stuck During Live Runs

Current active-run observability is much better than earlier reports: snapshots now include `recent_events` and `last_public_output_excerpt`. However, L2/L3 showed a residual incoherence. Until the child emitted an input request at about 26s, the run remained in `active_phase:"awaiting_child_event"` with `last_progress_message:"child process starting"` and `heartbeat_count:0`.

This is not a terminal correctness failure: the run completed. It is a real-use coherence defect because the server has spawned a child and is doing work, but the caller sees a stale startup phase for a noticeable live latency window.

Relevant implementation:

- [src/runTask.ts](/Users/rgalyavin/myApps/003-subagent007-pi/src/runTask.ts:170) projects active state from in-memory progress fields.
- [src/runTask.ts](/Users/rgalyavin/myApps/003-subagent007-pi/src/runTask.ts:384) updates phase primarily from parsed public child output.
- [src/runTask.ts](/Users/rgalyavin/myApps/003-subagent007-pi/src/runTask.ts:549) only moves out of `awaiting_child_event` on heartbeat or output after spawning.
- [src/processRunner.ts](/Users/rgalyavin/myApps/003-subagent007-pi/src/processRunner.ts:96) starts heartbeat on an interval, but there is no immediate heartbeat on spawn.

### I2. "All" Probe Alias Still Means Protocol-Core, Not Full-Current

The full-current profile correctly covered all deterministic current required surfaces. But the script still maps `all` and `all-bundled` to `protocol-core`, which is narrower than `full-current`. The usage text does disclose this, but the word "all" remains semantically incoherent for operators running a fresh campaign.

Relevant implementation:

- [scripts/run-observed-mcp-probe.mjs](/Users/rgalyavin/myApps/003-subagent007-pi/scripts/run-observed-mcp-probe.mjs:21) documents aliases.
- [scripts/run-observed-mcp-probe.mjs](/Users/rgalyavin/myApps/003-subagent007-pi/scripts/run-observed-mcp-probe.mjs:81) maps `all` and `all-bundled` through the manifest alias.
- `scripts/observed-coverage-manifest.json` maps both aliases to `protocol-core`.

### I3. One-Shot Suitability Is Still Lexical

The broad HORC/SAF one-shot now rejects before child spawn, which resolves the previous expensive timeout pattern for common broad-work terms. The residual limitation is that the compatibility boundary is a regex list rather than a semantic workload classifier. This can produce both false negatives, for broad work that avoids listed words, and false positives, for tiny prompts using a listed word literally.

Relevant implementation:

- [src/validate.ts](/Users/rgalyavin/myApps/003-subagent007-pi/src/validate.ts:30) defines broad-work regexes.
- [src/validate.ts](/Users/rgalyavin/myApps/003-subagent007-pi/src/validate.ts:54) provides the one-shot redirect guidance.

### I4. Default Model Class Has Unknown One-Shot Health

The installed server default is class `C`, but `list_model_classes` reported one-shot health as known healthy only for class `A`; B-E were unknown. Model reconciliation passed, so this is not evidence of broken provider access. The incoherence is operational: the configured default can be viable and still reported as unknown for one-shot health, leaving callers without readiness confidence for the default.

## Common Patterns

1. Core server mechanics are currently healthy. Tool listing, model listing, one-shot success, validation rejection, async polling, input settlement, cancellation, timeout recovery, session packet gates, closure validation, transcript redaction, and live Pi execution all passed observed trials.
2. The strongest current surface is deterministic protocol coverage. The fake-child probe now proves server mechanics without relying on model compliance.
3. Live-model evidence is appropriately narrower. It proves installed integration and simple one-shot execution, while deterministic scenarios cover negative and edge behavior.
4. Remaining defects cluster around operator interpretation, not terminal execution: progress wording, alias naming, lexical routing, and health-state semantics.
5. Recent event projection is a real improvement, but progress state still needs a source of truth when the child is alive and silent.

## HORCs And SAFs

### HORC 1: Active Progress Truth Is Coupled To Public Child Output Or Delayed Heartbeat

The most upstream incoherence is that active task progress is not derived from child process liveness as a first-class state. It is derived mostly from startup events, parsed public output, and scheduled heartbeat callbacks. When the child is alive but silent, the snapshot can remain stuck at "child process starting".

Intraframe SAF candidate:

- Emit an immediate post-spawn liveness heartbeat/progress update and event, then continue periodic synthetic liveness updates while no public child output has arrived. Set phase to `running` after successful spawn or first liveness tick, with a message such as `child process running; waiting for output`.

Transframe SAF candidate:

- Replace ad hoc active-progress fields with a typed process-state machine: `spawn_requested`, `spawned`, `running_silent`, `public_output_seen`, `input_required`, `terminating`, `terminal`. Make `get_run` a projection over typed process-state events.

Selected SAF:

- Intraframe immediate liveness event. It fully resolves the observed stale startup defect with the least system motion because the server already has `appendStatusEvent`, `setTaskPhase`, and heartbeat plumbing. A full state machine is cleaner, but not necessary to eliminate this specific incoherence.

Rejected pseudo-SAFs:

- Lower the heartbeat interval only. It still leaves an initial stale window and increases background churn.
- Add documentation that startup can be slow. That explains the symptom but does not make the active state truthful.

### HORC 2: Coverage Names Encode Historical Compatibility More Strongly Than Present Coverage Semantics

The highest-order root cause is that alias names such as `all` are preserved as compatibility shims even after the product gained a fuller `full-current` profile. The operator-facing word now points at historical behavior, not the current plain-language meaning.

Intraframe SAF candidate:

- Remap `all` to `full-current`; keep `all-bundled` as a deprecated alias to `protocol-core` only if necessary, and print a deprecation warning when selected.

Transframe SAF candidate:

- Remove semantic aliases entirely. Require explicit profiles (`protocol-core`, `full-current`, `live-current`) and make the CLI fail when a user asks for ambiguous coverage.

Selected SAF:

- Intraframe remap `all` to `full-current` plus a compatibility warning for `all-bundled`. This fixes the most misleading operator path while preserving backward compatibility where the old bundled meaning may matter.

Rejected pseudo-SAFs:

- Rely on usage text alone. The incoherence is in the command semantics.
- Rename `full-current` without changing aliases. That leaves the most likely mistaken command unchanged.

### HORC 3: One-Shot Workload Suitability Is A Lexical Heuristic Standing In For Work Semantics

The upstream incoherence is that the server knows one-shot is a strict contract, but it approximates incompatible work with prompt terms. The observed broad HORC/SAF prompt is now caught, but the primitive remains "listed words" rather than "bounded noninteractive workload".

Intraframe SAF candidate:

- Keep deterministic regexes, but add structured caller intent fields such as `expected_work_units` or `max_child_actions` for `run_subagent`; reject when omitted for risky profiles, skill use, write profiles, or long prompts.

Transframe SAF candidate:

- Replace public `run_subagent` routing with a scheduler tool that always creates a durable task, returning a synchronous result only when the task completes within a short internal grace period. The caller no longer decides sync versus async up front.

Selected SAF:

- Transframe scheduler, as the true final fix. The regex guard is a useful current intraframe mitigation, but no lexical expansion can fully resolve the mismatch between semantic workload shape and caller-selected transport. The scheduler removes the false immutability assumption that sync and async must be separate caller decisions.

Rejected pseudo-SAFs:

- Add more broad-work keywords forever. That reduces some misses but grows false positives and keeps the wrong primitive.
- Increase one-shot timeout. That makes misrouting more expensive.

### HORC 4: Model Health Is A Sparse Cache, But It Is Presented Beside Default Selection

The highest-order root cause is that `one_shot_health` is a remembered probe result, not a complete readiness assertion, yet it is shown in the same structure as default model-class selection. This makes `default_model_class:"C"` plus health `unknown` look like an incoherent default, even though reconciliation proves the model exists and unknown health does not block execution.

Intraframe SAF candidate:

- Add explicit `health_basis` and `health_action` fields per class, for example `cached_probe`, `never_probed`, `not_a_gate`, and `probe_command`, and add a top-level `default_one_shot_health_status`.

Transframe SAF candidate:

- Replace cached one-shot health with a tiered readiness contract: inventory presence, auth reachability, one-shot smoke, and recent production success are separate first-class readiness dimensions.

Selected SAF:

- Intraframe health-basis fields. They resolve the observed ambiguity with minimal motion and do not require a new readiness subsystem.

Rejected pseudo-SAFs:

- Auto-probe every class during `list_model_classes`. That makes a read-only listing slow, expensive, and side-effect-heavy.
- Hide unknown health. That removes useful caution instead of clarifying it.

## Recommended Fix Order

1. Add immediate/synthetic child liveness progress after spawn.
2. Remap or deprecate misleading `all` coverage aliases.
3. Clarify model health basis in `list_model_classes`.
4. Treat scheduler-style sync/async unification as a larger product-contract change; do not expand keyword lists as the main strategy.

## Bottom Line

Current Subagent007 MCP server behavior is broadly coherent and the e2e mechanics passed the campaign. The remaining issues are not core execution failures; they are places where the operator-facing model of the system is still more ambiguous than the system state itself.
