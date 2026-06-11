# Full Coherent Revised SAF Set - Subagent007 MCP - 2026-06-11

Source artifacts:

- `reports/observed-real-use-trials-2026-06-11.md`
- `reports/saf-adversarial-stress-test-2026-06-11.md`

Purpose: repair the selected SAF set after adversarial classification. This document is the canonical revised decision record; it did not itself implement runtime changes when written.

Status: implemented revised SAF decision record. The five revised repairs in this document are implemented in the current worktree; keep this file as traceability, not as an open task list.

## Repair Rule Applied

A fix is kept as a SAF only when the HORC is stated at the exact level the fix actually eliminates.

If the previous HORC was broader than the fix, this document either:

1. narrows the HORC to the real malformed primitive the fix can eliminate, or
2. replaces the fix with the smallest complete correction that really does eliminate the stated HORC.

Broader defects that remain true are listed as residual transframe backlog, not hidden inside overclaimed SAF language.

## Final Set Summary

| ID | Revised HORC | Final SAF | Classification | Priority |
| --- | --- | --- | --- | --- |
| R-SAF-1 | One-shot model-class reporting/resolution can treat inventory presence as one-shot usability. | Add one-shot model-class health as a first-class resolution/reporting gate. | **True SAF** for the narrowed HORC | P1 |
| R-SAF-2 | A one-shot timeout has no durable recovery identity even though the server already knows the run instance. | Make `run_subagent` execute through the durable run-task lifecycle and return the durable `run_id` on timeout/failure. | **True SAF** for the revised HORC | P1 |
| R-SAF-3 | Active run snapshot liveness is owned by optional client progress plumbing. | Always maintain internal run-task heartbeat snapshots independent of MCP progress notifications. | **True SAF** | P2 |
| R-SAF-4 | Probe scenario names have no authoritative coverage semantics. | Replace ad hoc scenario names with a coverage-tagged scenario registry and report computed covered/uncovered surfaces. | **True SAF** | P2 |
| R-SAF-5 | Failure-log analysis has no authoritative calibration-era boundary for mixed old/new records. | Add calibration-era fields to new records and make readers classify legacy records as `legacy_unclassified`. | **True SAF** | P3 |

## R-SAF-1 - One-Shot Model-Class Health Boundary

### Revised HORC

For one-shot calls, model-class reporting and resolution can treat "model exists in Pi/source inventory" as equivalent to "this class is usable for the one-shot execution budget."

This is narrower than the earlier overbroad HORC, "static model-class calibration is treated as capability truth." Full capability truth would require task-aware routing and benchmark distributions; the observed failure only proves one-shot smoke usability is not represented.

### Final SAF

Add one-shot model-class health as a first-class resolution/reporting gate.

Minimum required behavior:

1. Maintain health state keyed by at least:
   - model class,
   - resolved model ref,
   - execution surface, initially `run_subagent_one_shot`.
2. Health state records:
   - `last_checked_at`,
   - `last_success_latency_ms` when successful,
   - `last_failure_class` and `last_failure_at` when unsuccessful,
   - `usable_for_one_shot`.
3. `list_model_classes` exposes one-shot health alongside inventory/config status.
4. `run_subagent` fails fast or routes away before child spawn when the selected class is known unhealthy for one-shot use.
5. Existing model inventory reconciliation remains separate; inventory presence must not imply one-shot health.

### Intraframe Candidate

Change class `A` calibration from `ollama/gemma4:12b-mlx` to a model that already passed installed one-shot smoke, or remove/demote class `A` from one-shot recommendations.

### Transframe Candidate

Introduce the one-shot health boundary described above and make model-class resolution consult it for the one-shot surface.

### Selected Candidate

Transframe, but scoped to one-shot health rather than broad capability scoring.

The intraframe candidate fixes the immediate class `A` symptom but preserves the malformed equation between inventory and one-shot usability. The transframe candidate adds the missing primitive without requiring a full benchmark/routing platform.

### Classification

**True SAF for the revised HORC.**

It eliminates the exact malformed primitive: one-shot class resolution can no longer silently use inventory presence as one-shot readiness.

### Pseudo-SAFs Rejected

- Increase the one-shot timeout.
- Only document that class `A` may be slow.
- Swap class `A` to class `B` without adding a health boundary.
- Hide class `A` from `list_model_classes` while still accepting it in `run_subagent`.

### Validation

Force or record a failing class `A` one-shot health probe. Then verify:

- `list_model_classes` reports `usable_for_one_shot:false` for class `A`,
- `run_subagent` with class `A` fails fast or routes before spawning the child,
- `npm run models:reconcile` can still pass, proving inventory and health are distinct signals.

### Residual Backlog

Task-aware routing remains broader than this SAF. A future scheduler can use health, prompt shape, tool profile, latency history, and caller intent to choose execution mode and model class. That broader system should not be claimed as complete here.

## R-SAF-2 - Durable One-Shot Recovery Identity

### Revised HORC

When `run_subagent` times out or otherwise exceeds one-shot suitability after child work has started, the caller does not have a durable task identity that can be polled, inspected, cancelled, or resumed through the same lifecycle surface.

This replaces the earlier overbroad HORC, "workload shape is a caller assertion." Async-first identity does not make workload shape server-routable; it fixes the narrower lifecycle defect.

### Final SAF

Make `run_subagent` execute through the durable run-task lifecycle and return the durable `run_id` on timeout/failure.

Minimum required behavior:

1. `run_subagent` creates the same durable task snapshot shape as `start_run`.
2. Quick successful calls may still return synchronously for compatibility.
3. Timed-out, cancelled, or still-running one-shot calls return a `run_id` that `get_run` can inspect.
4. Output paths, failure logs, timeout metadata, and input request state are derived from the same task lifecycle authority as `start_run`.
5. The existing timeout recovery hint remains, but it points to the concrete returned `run_id`, not only to a different tool concept.

### Intraframe Candidate

Keep the current `run_subagent` process path and add more timeout guidance.

### Transframe Candidate

Collapse execution identity into the run-task lifecycle: `run_subagent` becomes a synchronous wait wrapper over a durable task.

### Selected Candidate

Transframe.

The intraframe guidance is already implemented and useful, but it leaves the one-shot result as a terminal dead end. The durable task wrapper is the smallest complete correction for the revised lifecycle HORC.

### Classification

**True SAF for the revised HORC.**

It removes the root contradiction that one-shot work has an internal run instance but no durable public lifecycle identity after timeout.

### Pseudo-SAFs Rejected

- Only add or reword `timeout_recovery_hint`.
- Raise the one-shot timeout.
- Add caller-provided `timeout_ms` back to `run_subagent`.
- Use prompt keyword heuristics as the only guard.

### Validation

Run an installed `run_subagent` prompt known to exceed the one-shot budget. Verify:

- result includes a durable `run_id`,
- `get_run` can inspect that `run_id` after timeout,
- output/failure metadata match the task snapshot,
- no orphaned child process remains after terminal state.

### Residual Backlog

Workload-shape authority remains unresolved. A separate future SAF would need explicit workload categories or scheduler-owned planning. Do not claim R-SAF-2 fixes workload routing.

## R-SAF-3 - Internal Active-Run Heartbeat Authority

### Revised HORC

Active run snapshot liveness is owned by optional client progress plumbing. When the client path does not supply progress notification plumbing, `get_run` can show `heartbeat_count:0` even while the MCP server is supervising an active child process.

### Final SAF

Always maintain internal run-task heartbeat snapshots independent of MCP progress notifications.

Minimum required behavior:

1. `start_run` installs an internal heartbeat/progress updater for task snapshots.
2. MCP progress notifications become a fan-out destination, not the source of truth.
3. `get_run` exposes heartbeat metadata even when the client did not provide a progress token.
4. Heartbeat intervals are cleared on terminal state.
5. Terminal snapshots cannot be overwritten by late heartbeat writes.

### Intraframe Candidate

Add an internal heartbeat loop in `runTask.ts` that updates `heartbeat_count`, `last_progress_at`, and `last_progress_message` while the task is active.

### Transframe Candidate

Replace heartbeat fields with a persisted sanitized run-event ledger consumed by both `get_run` and progress notifications.

### Selected Candidate

Intraframe.

The observed defect is the dependency on optional client progress plumbing, not lack of a full event-sourced run ledger.

### Classification

**True SAF.**

It directly moves liveness authority into the run task, which is the smallest complete fix for the stated HORC.

### Pseudo-SAFs Rejected

- Say `elapsed_ms` is enough.
- Require all MCP clients to provide progress tokens.
- Persist raw child stdout/stderr as progress evidence.
- Lower the heartbeat interval without changing ownership.

### Validation

Start an installed-production `start_run` through a client path that does not provide progress notifications. Poll before terminal completion and verify:

- `heartbeat_count > 0`,
- `last_progress_at` is present,
- `last_progress_message` is stable and sanitized,
- heartbeat values stop changing after terminal state.

## R-SAF-4 - First-Class Probe Coverage Semantics

### Revised HORC

Probe scenario names have no authoritative coverage semantics. `--scenario all` expands to all bundled scenario names, but neither the name nor the result declares what product surfaces are covered or uncovered.

This replaces the weaker previous wording, "campaign scenario vocabulary overstates coverage semantics." Renaming alone reduces confusion but does not make coverage authoritative.

### Final SAF

Replace ad hoc scenario names with a coverage-tagged scenario registry and report computed covered/uncovered surfaces.

Minimum required behavior:

1. Define a registry for every bundled scenario with:
   - scenario name,
   - evidence class,
   - tools exercised,
   - lifecycle phases covered,
   - failure/success classes covered.
2. Replace or alias `all` to explicit `all-bundled`, and make output state the expanded scenario set.
3. Compute `coverage_summary` from the registry, not from prose.
4. Include `uncovered_surfaces` in probe output for known major product surfaces not exercised by the selected scenarios.
5. Reports must cite the computed coverage summary when making coverage claims.

### Intraframe Candidate

Rename/report `all` as `all-bundled` and print a manually maintained uncovered-surface list.

### Transframe Candidate

Create the coverage-tagged scenario registry and compute coverage summaries from it.

### Selected Candidate

Transframe.

The intraframe candidate is useful, but adversarial testing showed it remains drift-prone and not machine-checkable. The registry is the smallest complete correction that makes coverage semantics authoritative.

### Classification

**True SAF.**

It eliminates the malformed primitive: scenario names stop being bare labels and become typed evidence records with explicit coverage meaning.

### Pseudo-SAFs Rejected

- Only rename `all` in documentation.
- Keep `all` but rely on report authors to explain the limitation.
- Add more scenarios while leaving coverage semantics implicit.

### Validation

Run the probe with all bundled scenarios. Verify output includes:

- `scenario_set:"all-bundled"`,
- expanded scenario names,
- computed `covered_surfaces`,
- computed `uncovered_surfaces`,
- evidence class per scenario.

Then add or remove a scenario in the registry and verify the coverage summary changes mechanically.

## R-SAF-5 - Calibration-Era Boundary For Failure Analysis

### Revised HORC

Failure-log analysis has no authoritative calibration-era boundary for mixed old/new records. Records produced under older concrete-model semantics and records produced under current model-class semantics can be silently grouped unless every reader infers the boundary from timestamps or field presence.

This is narrower and more complete than "failure records lack an explicit calibration era." The real defect is not only missing fields on future records; it is reader-visible ambiguity across mixed records.

### Final SAF

Add calibration-era fields to new records and make readers classify legacy records as `legacy_unclassified`.

Minimum required behavior:

1. New failure records include a calibration boundary field, for example:
   - `calibration_era`,
   - `model_class_schema_version`,
   - or equivalent single authoritative field.
2. Failure-log readers/reporters classify missing-era records as `legacy_unclassified`.
3. Reports segment model/calibration analysis by era.
4. Optional archival summaries may tag old records externally, but raw historical records do not need destructive mutation.

### Intraframe Candidate

Add `calibration_era` or `model_class_schema_version` to future failure records only.

### Transframe Candidate

Version failure analytics readers around an explicit calibration-era boundary and treat legacy missing-field records as a distinct era.

### Selected Candidate

Transframe, but limited to failure-log reading and reporting.

The intraframe future-field change is insufficient because the observed ambiguity comes from mixed historical and current records. The selected candidate repairs both sides of the boundary without mutating old logs.

### Classification

**True SAF.**

It eliminates the analysis ambiguity: every record is either explicitly current-era or explicitly legacy/unclassified at read time.

### Pseudo-SAFs Rejected

- Add a future field but leave readers to silently group old and new records.
- Delete old failure records.
- Infer calibration era only from timestamp.
- Treat `schema_version` as calibration semantics without defining that contract.

### Validation

Generate one new failure record and analyze a mixed file containing older records without the era field. Verify:

- new records include the explicit era field,
- old records are classified as `legacy_unclassified`,
- model/calibration summaries are segmented by era,
- no report silently merges legacy concrete-model failures with current model-class failures.

## Coherent Execution Order

1. **R-SAF-3** first if implementing runtime safety immediately: it is small, local, and improves installed async observability.
2. **R-SAF-2** next: durable one-shot identity reduces operational dead ends and aligns one-shot with existing async lifecycle mechanics.
3. **R-SAF-1** next: one-shot model health depends on having clear one-shot lifecycle evidence and failure identity.
4. **R-SAF-4** next: once new trial surfaces exist, campaign coverage needs authoritative semantics.
5. **R-SAF-5** last or in parallel with reporting work: it protects longitudinal analysis but does not block runtime behavior.

## Residual Transframe Backlog

These are real remaining problems, but they are not claimed as fixed by the revised SAF set:

- **Task-aware routing authority**: decide model class and lifecycle mode from prompt shape, tool profile, health, and caller intent.
- **Semantic progress observability**: heartbeat proves supervision, not meaningful model progress.
- **Full campaign product coverage**: a scenario registry names covered/uncovered surfaces; it does not by itself add missing scenarios.
- **Historical telemetry migration**: legacy records can be classified, but not all historical ambiguity can be reconstructed without external context.

## Final Coherent Set

The revised set contains five True SAFs, each true only at its explicitly stated scope:

1. **One-shot model-class health boundary** fixes one-shot inventory/readiness conflation.
2. **Durable one-shot recovery identity** fixes dead-end one-shot timeout lifecycle.
3. **Internal active-run heartbeat authority** fixes liveness dependence on optional client progress plumbing.
4. **First-class probe coverage semantics** fixes untyped scenario-name coverage claims.
5. **Calibration-era boundary for failure analysis** fixes mixed-era failure-log ambiguity.

The previous "workload shape is caller assertion" HORC remains important but is not solved by this set. It should become a separate scheduler/routing SAF only when the project is ready to change the execution-selection frame itself.
