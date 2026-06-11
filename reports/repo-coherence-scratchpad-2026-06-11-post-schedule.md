Finding 1: scheduler-first guidance is not consistently propagated.

Observed while cross-referencing README, server tool descriptions, and preflight retry guidance: `schedule_run` is now the preferred durable-first tool for uncertain work, but several active public strings still route broad/timed work only to `start_run`, and `get_run` says durable runs come from `run_subagent`, `start_run`, `start_session_run`, or `run_subagent_session`, omitting `schedule_run`.

Impact: low-to-medium public-contract incoherence. Runtime behavior is healthy, but clients following MCP tool descriptions can miss the new scheduler-first SAF and continue treating `start_run` as the sole non-one-shot path.

Repair: update active public guidance in source and README to mention `schedule_run` where it is the intended default, while preserving `start_run` as the immediate-handle compatibility option.

Finding 2: observed `full-current` coverage omits the new public scheduler surface.

Observed while inspecting `scripts/observed-coverage-manifest.json`: `schedule_run` is registered as a public MCP tool and has unit-level MCP tests, but the coverage manifest has no `schedule_run-*` surface and no selected scenario for it. The deterministic `full-current` profile can therefore pass while never exercising the scheduler-first SAF.

Impact: medium coverage incoherence. The implementation is tested, but the campaign named `full-current` no longer represents the current public MCP surface set.

Repair: add a scheduler surface and deterministic scenario to the manifest and probe, require it in `full-current`, and update observed-campaign tests so profile coverage fails if this surface regresses.

Finding 3: newly added observed-use report lacks a pre-repair status boundary.

Observed while scanning dated reports after the scheduler and alias repairs: `reports/observed-real-use-horc-saf-campaign-2026-06-11-codex-current.md` describes the pre-repair state where `all`/`all-bundled` mapped to `protocol-core`. That was accurate when observed, but after this implementation it is no longer current behavior, and the file has no status header marking it as a pre-repair observation record.

Impact: low documentation distortion. The report is valuable traceability, but without a status boundary it can be misread as describing the current executable probe semantics.

Repair: add a concise status note to the report header stating that the observations are pre-repair and that current behavior is defined by README plus the latest manifest/probe tests.

Finding 4: implemented plan artifact still reads like an open implementation plan.

Observed while checking the newly added plan file: `docs/plans/2026-06-11-001-refactor-revised-saf-implementation-plan.md` has the implementation instructions and verification plan, but no status note showing that the work has now been applied locally. Nearby older plan files use explicit implemented/historical status notes to avoid open-task ambiguity.

Impact: low documentation waste. The file is useful traceability, but without status it can be mistaken for remaining work after the code and tests already implement the plan.

Repair: add an implementation status note near the top naming the completed surfaces and current verification anchors.

Finding 5: `schedule_run` grace waiting treats `input_required` as waitable instead of action-required.

Observed while reading `src/runTask.ts`: `scheduleRunTask` returns early for terminal statuses and `wait_ms:0`, but its wait loop does not return immediately when the durable task becomes `status:"input_required"`. With a positive `wait_ms`, a child that asks for caller input quickly can be hidden until the grace deadline expires.

Impact: medium workflow incoherence. `input_required` is not terminal, but it is return-worthy because the caller must answer before useful progress can continue. Delaying it undermines the scheduler-first promise for caller-interactive work.

Repair: treat `input_required` as a schedule-returnable status, without changing terminal semantics for `get_run` or task persistence.

Finding 6: root `.DS_Store` workspace metadata file is present.

Observed while scanning for generated leftovers: `./.DS_Store` exists at the repository root. It is not part of the product, source, tests, docs, or reproducible state.

Impact: low semantic waste. It does not affect runtime or tests, but it is a dead local filesystem artifact in the repo workspace.

Repair: remove the `.DS_Store` file from the workspace.

Finding 7: older "current" SAF plan/decision record lack supersession by the scheduler pass.

Observed while checking status claims: `docs/plans/current-coherent-revised-saf-implementation-plan-2026-06-11.md` and `reports/full-coherent-revised-saf-set-2026-06-11-current.md` correctly describe an earlier implemented slice, but both still say full scheduler-owned workload routing is outside that set. After the newer scheduler-first pass, those statements remain historically true for that slice but are no longer the latest repo state unless a supersession note is present.

Impact: low-to-medium documentation incoherence. A reader can mistake the older "current" plan for the latest architecture boundary and miss `schedule_run`.

Repair: add supersession notes pointing to `docs/plans/2026-06-11-001-refactor-revised-saf-implementation-plan.md` and the repaired `README.md`/coverage manifest as the current scheduler-first contract.
