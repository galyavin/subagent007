---
title: Live E2E Coherent SAF Implementation Plan
date: 2026-06-10
status: implemented
origin:
  - reports/live-e2e-skill-campaign-2026-06-10.md
  - reports/live-e2e-saf-adversarial-stress-test-2026-06-10.md
  - reports/live-e2e-coherent-revised-saf-set-2026-06-10.md
---

# Live E2E Coherent SAF Implementation Plan

This plan was implemented after approval. It implements the revised SAF set from `reports/live-e2e-coherent-revised-saf-set-2026-06-10.md` and is scoped to the smallest cohesive set of code, test, documentation, and operator steps needed to make the five selected repairs real without expanding into the deferred transframe work.

## Problem Frame

Observed live use showed that the MCP server's core execution mechanics are healthy, but several boundary contracts need repair:

- packet instructions do not fully match packet parser expectations,
- the current installed config is stale even though runtime repair masks it,
- long async runs expose too little liveness state through `get_run`,
- one-shot timeout failures do not guide callers to the async surface,
- campaign reports need a hard evidence boundary between harness-scoped telemetry and installed-server production evidence.

## Scope

In scope:

- update packet instruction generation and packet tests,
- execute and verify current config canonicalization,
- add active-run liveness/progress metadata for `start_run`/`get_run`,
- add timeout recovery guidance for public `run_subagent` timeout results,
- make observed-campaign evidence classification explicit in code output and docs.

Out of scope:

- structured-output/tool-call packet transport,
- versioned config migration framework,
- sanitized live child-event ledger,
- removal of public `run_subagent`,
- request-scoped campaign attribution in every public tool call.

## Requirements Traceability

| Requirement | Source | Plan Unit |
| --- | --- | --- |
| Required packets with optional `closure` must be producible in the exact parser shape. | SAF-1 | Unit 1 |
| Current installed config must stop depending on runtime stale-alias repair. | SAF-2 | Unit 2 |
| Active async runs must show liveness through `get_run` before input or completion. | SAF-3 | Unit 3 |
| Public one-shot timeouts must route callers toward `start_run`. | SAF-4 | Unit 4 |
| Campaign reports must distinguish harness telemetry from installed-server evidence. | SAF-5 | Unit 5 |

## Implementation Units

### Unit 1: Packet Contract Single Authority

SAF: make the model-facing packet instruction schema-isomorphic with the parser contract.

Files:

- `src/packet.ts`
- `src/types.ts`
- `tests/helpers/fakePiChild.ts`
- `tests/session.test.ts`
- optionally `tests/packet.test.ts` if direct packet-instruction tests are cleaner than extending session tests

Design:

- Define one canonical packet example near `packetSchema` in `src/packet.ts`.
- The example should include all required fields and a valid optional `closure` object:
  - `canonical_closure_source: string`
  - `artifact_roles: Array<{ path: string; role: string }>`
  - `validation: string[]`
  - `claim_ceiling: string`
- Update `appendContractPacketInstruction()` to show that exact shape and state that `closure` may be omitted, but if included must match the example's structure.
- Keep `packetSchema` strict about the nested closure fields. Do not accept object-or-array ambiguity.
- Add fake-child prompts for:
  - `PACKET_VALID_WITH_CLOSURE`
  - `PACKET_INVALID_CLOSURE_SHAPE`

Test scenarios:

- `run_subagent_session` with `packet_policy:"required"` and `PACKET_VALID_WITH_CLOSURE` succeeds, commits the manifest/ledger, writes a packet file, and returns `claimed_packet.closure.artifact_roles` as an array.
- Required packet with `PACKET_INVALID_CLOSURE_SHAPE` fails with `packet_parse_status:"invalid"`, writes an attempt, and does not advance the manifest/ledger.
- Existing valid no-closure packet still succeeds.
- Existing non-ready packet cases still fail contract satisfaction.
- Direct instruction test, if added: `appendContractPacketInstruction()` includes a closure example whose JSON parses and validates through `extractContractPacket()`.

Acceptance:

- Packet producer instructions and parser expectations are aligned from one source of truth or colocated canonical example.
- No parser relaxation is introduced to hide model output mistakes.

### Unit 2: Current Config Canonicalization

SAF: execute the explicit migration boundary for the current installed config.

Files:

- `scripts/migrate-config.mjs`
- `tests/config-migrate.test.ts`
- `README.md`
- installed user config outside the repo: `~/.codex/subagent007-pi/config.json`

Design:

- No source-code change is expected unless verification reveals a drift in the existing migration path.
- Run the existing operator-controlled migration command from this repo:
  - `npm run config:migrate`
- Verify that the installed config's `default_model` becomes `openrouter/~anthropic/claude-sonnet-latest`.
- Keep runtime alias repair in `src/modelAllowlist.ts` as a compatibility fallback.
- Do not make `list_allowed_models` mutate config.

Test scenarios:

- Existing `tests/config-migrate.test.ts` remains green:
  - stale alias rewrites to canonical ref,
  - canonical config is unchanged,
  - whitespace-padded canonical config is trimmed,
  - unsupported models are not silently rewritten,
  - invalid JSON is not overwritten,
  - missing config is a no-op.
- Live verification after migration:
  - `list_allowed_models.default_model_repaired === false`
  - `list_allowed_models.config_migration === null`

Acceptance:

- Installed config no longer reports stale runtime repair.
- Migration remains explicit and operator-controlled.

### Unit 3: Active Async Liveness State

SAF: make `get_run` expose active-run liveness/progress metadata before input or terminal completion.

Files:

- `src/runTask.ts`
- `src/runSubagent.ts`
- `src/processRunner.ts`
- `src/progress.ts`
- `src/types.ts`
- `tests/timeout-budget.test.ts`
- `tests/run-subagent.test.ts`
- `tests/helpers/fakePiChild.ts`

Design:

- Add the task snapshot tests before changing runtime behavior; this is the most invasive unit and should be pinned by failing coverage first.
- Add optional progress metadata to `RunTaskView`:
  - `elapsed_ms`
  - `last_progress_at`
  - `last_progress_message`
  - `heartbeat_count`
- `elapsed_ms` should be computed for active runs from `started_at` to now; terminal runs already have `duration_ms`.
- Add an internal heartbeat/progress callback path that updates the in-memory `RunTaskState`.
- `startRunTask()` should pass a heartbeat to `runSubagent()` even when the MCP client did not provide a progress token, so `get_run` liveness does not depend on side-channel notification support.
- If the MCP caller did provide a progress token, the wrapper should both update task state and forward the notification.
- Progress messages should be safe and coarse:
  - default `running`,
  - pending input summary when available,
  - `cancellation requested`,
  - terminal transition message if useful.
- Persist snapshots periodically through the existing task snapshot mechanism, but avoid writing raw child transcript or unredacted stdout/stderr.

Test scenarios:

- Add a fake child mode that stays alive long enough for at least one heartbeat, for example `HEARTBEAT_LONG_WAIT`.
- `start_run` returns `working`; polling `get_run` before terminal completion eventually shows:
  - `heartbeat_count > 0`
  - `last_progress_at` is a string timestamp
  - `last_progress_message` is nonempty
  - `elapsed_ms > 0`
- A run with pending input shows a pending-input progress message after heartbeat.
- A cancelled run preserves terminal `status:"cancelled"` and does not regress liveness fields into success semantics.
- A completed snapshot read after server restart still behaves as before; active pre-restart snapshots may include stale progress metadata but still report restart-state failure per current behavior.

Acceptance:

- `get_run` no longer has to represent supervised long-running work as a contentless `working` state.
- No raw transcript streaming is introduced.
- Existing progress-token notifications still work.

### Unit 4: One-Shot Timeout Self-Routing

SAF: one-shot timeout results must tell the caller the correct recovery surface.

Files:

- `src/runSubagent.ts`
- `src/types.ts`
- `src/server.ts`
- `src/transcript.ts` or `src/processRunner.ts` only if adding a transcript marker there proves cleaner
- `tests/run-subagent.test.ts`
- `tests/failure-log.test.ts`
- `README.md`

Design:

- Add optional `timeout_recovery_hint` to `RunSubagentResult`.
- Populate it only for public `run_subagent` timeout results, not internal `start_run` or `run_subagent_session` timeouts.
- Suggested text:
  - `Use start_run with explicit timeout_ms for broad, exploratory, interactive, cancellable, polling, or long-running work.`
- Keep `run_kind:"quick_noninteractive"` required for `run_subagent`.
- Keep caller-supplied `timeout_ms` rejected for `run_subagent`.
- Keep `partial_output_available` semantics unchanged.
- If adding the hint to persisted transcript output, append a small `[subagent007 recovery] ...` marker after the timeout marker; otherwise keep it as structured result metadata only. Prefer structured metadata first to avoid changing transcript classifiers unless necessary.
- For this plan, `timeout_recovery_hint` in the structured result is the selected "result text equivalent." Do not add a transcript marker unless implementation reveals a client cannot access structured metadata.

Test scenarios:

- Public `run_subagent` timeout through MCP or internal handler returns `timeout_recovery_hint`.
- `start_run` timeout does not include one-shot recovery guidance.
- `run_subagent_session` timeout does not include one-shot recovery guidance.
- `run_subagent` timeout with only user prompt plus timeout marker still reports `partial_output_available:false`.
- `run_subagent` timeout with assistant output still reports `partial_output_available:true`.
- Failure log records do not leak prompt text and do not need to include the hint unless explicitly chosen.

Acceptance:

- A caller seeing a one-shot timeout has a concrete next action.
- The one-shot API contract remains quick-only and timeout-controlled by the server.

### Unit 5: Campaign Evidence Boundary

SAF: make harness-scoped campaign telemetry and installed-server production evidence distinct by construction and convention.

Files:

- `scripts/run-observed-campaign.mjs`
- `tests/observed-campaign.test.ts`
- `README.md`
- `reports/live-e2e-skill-campaign-2026-06-10.md`
- future report templates or conventions under `reports/`

Design:

- Extend the observed-campaign harness JSON summary with:
  - existing required fields: `campaign_id`, `state_root`, `failure_log_path`
  - `evidence_class: "campaign-scoped"`
- Update README's observed campaign section:
  - harness-launched SDK/scripted probes are campaign telemetry,
  - already-running installed MCP probes are installed-production evidence,
  - reports must not combine the two without labeling them,
  - every campaign report must record `campaign_id`, `state_root`, `failure_log_path`, and evidence class.
- Add a short report convention section to the current live campaign report or a small reusable note in `reports/`.
- Do not add campaign parameters to every public MCP tool now.
- Do not post-hoc rewrite production failure records.

Test scenarios:

- `observed-campaign` summary includes `campaign_id`, `state_root`, `failure_log_path`, and `evidence_class:"campaign-scoped"`.
- Existing isolated path assertions still pass.
- Invalid campaign IDs still fail before running the child command.
- Archive behavior still archives the campaign ledger, not production.

Acceptance:

- Future campaign reports can mechanically cite whether an observation came from a campaign-scoped server or an installed production-state server.
- README/reporting convention names all mandatory campaign evidence fields: `campaign_id`, `state_root`, `failure_log_path`, and evidence class.
- Harness behavior remains backward-compatible except for the additional JSON summary field.

## Sequencing

1. **Unit 1: Packet contract**
   - Highest-value product correctness fix.
   - Independent of all other units.

2. **Unit 2: Config canonicalization**
   - Fast operational cleanup.
   - Run after Unit 1 or before; no dependency, but keep it explicit because it mutates user config outside the repo.

3. **Unit 3: Active async liveness**
   - Most invasive code change in this plan.
   - Do after Unit 1 so packet tests remain easy to interpret if failures appear.

4. **Unit 4: One-shot timeout routing**
   - Small result-shape change.
   - Do after Unit 3 so heartbeat/progress types and result types can be updated coherently.

5. **Unit 5: Campaign evidence boundary**
   - Documentation/harness/reporting change.
   - Last because it does not affect runtime correctness and can absorb any final report wording from Units 1-4.

## Cross-Unit Cohesion Checks

- Unit 1 must not change packet satisfaction semantics; it only aligns instructions with the existing parser.
- Unit 2 must not introduce silent mutation during server startup or `list_allowed_models`.
- Unit 3 must not expose raw child output or change terminal status semantics.
- Unit 4 must not reintroduce caller-controlled timeout for `run_subagent`.
- Unit 5 must not imply installed MCP calls are campaign-scoped unless the server process was launched under campaign env.
- All result-shape additions should be optional to avoid breaking existing callers.
- README examples should remain aligned with MCP schemas after type changes.

## Verification Plan

Targeted checks during implementation:

- `npm run typecheck`
- `node scripts/run-tests-with-ledger-guard.mjs tests/session.test.ts`
- `node scripts/run-tests-with-ledger-guard.mjs tests/config-migrate.test.ts`
- `node scripts/run-tests-with-ledger-guard.mjs tests/timeout-budget.test.ts tests/run-subagent.test.ts`
- `node scripts/run-tests-with-ledger-guard.mjs tests/observed-campaign.test.ts`

Final checks:

- `npm test`
- live `list_allowed_models` after config migration
- one live required-packet run with closure after Unit 1
- one live `start_run` long-running probe that shows `get_run` liveness metadata before completion
- one controlled one-shot timeout probe that returns `timeout_recovery_hint`
- one observed-campaign SDK probe verifying `evidence_class:"campaign-scoped"`

## Completion Gate

The implementation is complete only when all of these are true:

- required packets with valid closure pass and malformed closure fails,
- current installed config no longer reports `default_model_repaired:true`,
- active `get_run` responses include liveness/progress metadata while a run is still working,
- public `run_subagent` timeout results include recovery guidance to `start_run`,
- observed-campaign harness summaries include `campaign_id`, `state_root`, `failure_log_path`, and identify campaign-scoped evidence,
- README and reports use the same evidence and API vocabulary as the code,
- `npm run typecheck` and `npm test` pass.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Packet instruction gets manually out of sync again. | Keep canonical example colocated with parser and test that example parses. |
| Config migration mutates the wrong config path. | Print and verify the resolved config path; honor `SUBAGENT007_CONFIG_PATH` only when explicitly set. |
| Progress metadata creates noisy disk writes. | Write on heartbeat cadence only; do not write per stdout chunk. |
| Progress metadata implies semantic model progress. | Use conservative labels like `running`; document that it is liveness, not proof of useful work. |
| Timeout hint appears on async/session runs where it is not the right advice. | Gate hint to public `run_subagent` only. |
| Campaign evidence classification becomes only documentation. | Add `evidence_class` to harness JSON and test it. |
