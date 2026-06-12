# Observed Real-Use Trials: Subagent007 MCP Server

Date: 2026-06-12
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Status: completed, no verified True SAFs found in current code

## Scope

This campaign exercised the current `subagent007` MCP server through:

- local deterministic MCP protocol probes launched from `dist/server.js` under campaign-scoped state;
- local live-model probes launched from `dist/server.js` under campaign-scoped state;
- the already-registered active `subagent007` MCP server exposed to Codex in this session;
- repository build, type, unit, integration, observed-probe, model-reconciliation, and retired-alias oracles.

The `saf-ninja` skill named in the request was not available in this session's skill list. I used a fallback SAF triage: only findings with current observed evidence, a coherent root cause, and a smallest sufficient repair were eligible for implementation.

## Trial Evidence

### Local Oracles

| Trial | Command or tool | Result |
| --- | --- | --- |
| Build | `npm run build` | Pass |
| Typecheck | `npm run typecheck` | Pass |
| Full test suite | `SUBAGENT007_FAILURE_LOG_PATH=<private>/failures.jsonl npm test` | Pass, 136/136 |
| Model reconciliation | `npm run models:reconcile` | Pass; calibrated refs present in Pi registry/source inventories |
| Retired alias edge | `npm run observed-mcp-probe -- --profile all-bundled --cwd ...` | Expected exit 2 with targeted `protocol-core` guidance before running probes |

### Deterministic Campaign

Command:

```sh
npm run observed-campaign -- --campaign-id campaign.20260612.codex-full-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile full-current --mode protocol-deterministic
```

Result: pass, exit code 0.

Campaign state:

- State root: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260612.codex-full-current-fg9qH3`
- Ledger: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260612.codex-full-current-fg9qH3/campaign-ledger.jsonl`
- Failure log: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260612.codex-full-current-fg9qH3/failures.jsonl`

Covered required deterministic surfaces:

- `tool-listing`
- `model-class-listing`
- `run_subagent-success`
- `run_subagent-schema-error`
- `run_subagent-preflight-rejection`
- `run_subagent-child-failure`
- `run_subagent-timeout-recovery`
- `schedule_run-durable-first`
- `start_run-async-polling`
- `answer_run_input-caller-input`
- `cancel_run-cancellation-settlement`
- `transcript-redaction`
- `run_subagent_session-packet-failure`
- `run_subagent_session-valid-packet-closure`
- `run_subagent_session-invalid-packet-closure`

Missing required deterministic surfaces: none.

Expected failure-log deltas appeared only on negative-path scenarios: handler validation, child nonzero exit, timeout, required packet failure, and invalid packet closure.

### Live Campaign

Command:

```sh
npm run observed-campaign -- --campaign-id campaign.20260612.codex-live-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile live-current --mode live-model
```

Result: pass, exit code 0.

Campaign state:

- State root: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260612.codex-live-current-ozkYjn`
- Ledger: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260612.codex-live-current-ozkYjn/campaign-ledger.jsonl`
- Failure log: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260612.codex-live-current-ozkYjn/failures.jsonl`

Covered required live surfaces:

- `tool-listing`
- `model-class-listing`
- `run_subagent-success`
- `installed-pi-integration`

Missing required live surfaces: none.

### Installed MCP Server Trials

| Trial | Tool | Observation |
| --- | --- | --- |
| Model classes | `list_model_classes` | Classes A-E returned. Class A was cached healthy. Default C was explicitly `never_probed`, with `blocks_only_known_unhealthy` gate and probe action. |
| One-shot success | `run_subagent`, class A, exact marker | Completed in 19.176s with `INSTALLED_READY_20260612`. |
| Durable inspection | `get_run` for installed one-shot run | Returned the same completed snapshot, coherent terminal progress, and public event history. |

Installed run id: `2026-06-12T195243917Z-99d68361d539`

Installed output path: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-12T195303135Z-79cc4d298560.md`

## Observed Issues And Incoherences

No new verified product issues were observed in the current code.

Historical incoherences from earlier reports were rechecked through current oracles:

| Historical concern | Current observation | Triage |
| --- | --- | --- |
| Active silent child looked like startup was stuck | Current async/session tests and deterministic campaign expose `running_silent`; installed terminal run ended with `run completed`. | Resolved |
| `last_progress_message` contradicted terminal state | Installed `run_subagent` and `get_run` both returned `last_progress_message:"run completed"` with `active_phase:"completed"`. | Resolved |
| Caller input lifecycle disappeared from history | Deterministic full-current caller-input scenario satisfied `input_answered` with no missing required surface. | Resolved |
| Packet closure validation ambiguous | Deterministic valid and invalid closure scenarios both produced expected packet status and closure classification. | Resolved |
| Coverage alias `all` underclaimed current coverage | `all-bundled` is retired with guidance; observed tests cover `all -> full-current`. | Resolved |
| Model health `unknown` looked incoherent beside default class | Structured output includes `health_basis`, `health_gate`, and `health_action`; unknown is explicitly non-gating unless known unhealthy. | Resolved |

Non-defect notes:

- Full e2e confidence is compositional: `full-current` covers deterministic protocol and failure behavior, while `live-current` covers real Pi/model success surfaces. This split is explicit in the coverage summaries.
- Already-running installed MCP trials write to production Subagent007 state by design. Campaign-scoped state applies only to server processes launched under the observed-campaign harness.
- The deterministic campaign records failure-log deltas on expected negative cases. Those are evidence that failure telemetry fired, not product defects.

## SAF Triage

| Candidate | Evidence | Classification | Decision |
| --- | --- | --- | --- |
| Repair active progress state | Current code and oracles already show `running_silent` and coherent terminal progress. | Not current / already repaired | No action |
| Repair input lifecycle observability | Current deterministic caller-input scenario satisfies the required surface. | Not current / already repaired | No action |
| Repair packet closure semantics | Current deterministic valid and invalid closure scenarios satisfy required surfaces. | Not current / already repaired | No action |
| Repair coverage alias semantics | Retired alias rejects with targeted guidance; `all` maps to `full-current` in tests. | Not current / already repaired | No action |
| Repair model health ambiguity | Installed output and tests expose basis/action/gate fields. | Not current / already repaired | No action |

Verified True SAFs requiring implementation: none.

## Implementation Plan

No code repair plan was executed because the verified True SAF set is empty. The coherent plan is:

1. Preserve current behavior.
2. Keep the fresh report as the campaign record.
3. Re-run the same oracle bundle after any future code change touching MCP lifecycle, campaign coverage, model health, sessions, input mailbox, transcript redaction, or timeout handling.

## Final Oracles

- `npm run build`: pass
- `npm run typecheck`: pass
- `SUBAGENT007_FAILURE_LOG_PATH=<private>/failures.jsonl npm test`: pass, 136/136
- `npm run observed-campaign -- --campaign-id campaign.20260612.codex-full-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile full-current --mode protocol-deterministic`: pass
- `npm run observed-campaign -- --campaign-id campaign.20260612.codex-live-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --profile live-current --mode live-model`: pass
- Installed `list_model_classes`: pass
- Installed `run_subagent` class A one-shot: pass
- Installed `get_run` for the one-shot: pass
- `npm run models:reconcile`: pass
- `npm run observed-mcp-probe -- --profile all-bundled --cwd /Users/rgalyavin/myApps/003-subagent007-pi`: expected rejection with guidance
