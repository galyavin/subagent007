# SAF Adversarial Stress Test - 2026-06-11

Source proposal: `reports/observed-real-use-trials-2026-06-11.md`

Method: adversarial-but-fair red/blue review of each selected SAF. The classification asks whether the selected fix is a **True SAF**, **asymptotic SAF**, or **pseudo-SAF** relative to the stated HORC, not whether the fix is useful.

## Verdict

Rework the selected SAF set before treating it as canonical.

One selected fix is a True SAF for its stated HORC. Three are asymptotic: useful and directionally correct, but incomplete or not perfectly irreducible. One is a pseudo-SAF relative to its stated HORC because it avoids the malformed primitive instead of correcting it.

## Evidence Frame

The stress test uses the five HORC/SAF pairs in the June 11 observed-use report plus code evidence from `src/modelAllowlist.ts`, `src/runSubagent.ts`, `src/runTask.ts`, `src/failureLog.ts`, and `scripts/run-observed-mcp-probe.mjs`. Risk posture is balanced; the objective is root-cause correctness, not minimizing implementation effort alone.

## Classification Summary

| ID | Selected SAF Under Test | Classification | Short Rationale |
| --- | --- | --- | --- |
| SAF-1 | Runtime model-class smoke health and class A non-recommendation until passing. | **Asymptotic SAF** | Corrects inventory-vs-health confusion for observed smoke suitability, but smoke health remains a proxy for broader capability truth. |
| SAF-2 | Async-first execution identity; `run_subagent` becomes a compatibility wrapper over durable tasks. | **Pseudo-SAF for the stated HORC** | Eliminates dead-end timeout consequences, but does not make workload shape server-routable or correct the caller-assertion primitive. |
| SAF-3 | Internal heartbeat/progress updater independent of MCP progress notification plumbing. | **True SAF** | Directly removes the coupling between task snapshot liveness and optional client progress plumbing. |
| SAF-4 | Rename/report bundled `all` as `all-bundled` and print uncovered surfaces. | **Asymptotic SAF** | Reduces overclaiming in reports, but leaves coverage semantics external to the scenario model unless the scenario registry becomes authoritative. |
| SAF-5 | Add calibration/schema-era field to future failure records. | **Asymptotic SAF** | Improves future records but leaves historical ambiguity unless readers/backfill handle legacy records. |

## Detailed Stress Test

### SAF-1 - Model-Class Smoke Health

Stated HORC:

Static model-class calibration is treated as capability truth.

Selected SAF:

Add a first-class smoke-health check to model-class resolution/reporting and make class `A` non-default/non-recommended for one-shot until it passes.

Red-team critique:

- A smoke-health registry tests only a narrow representative task. It can show that a model passed or failed a trivial exact-reply prompt; it cannot prove the class is generally suitable for "simplest mechanistic tasks."
- Health can decay between probes. A registry can become stale in the same way the static calibration did, just with a newer data source.
- If resolution refuses unhealthy bindings, the fix now has operational policy questions: probe cadence, failure thresholds, transient outage handling, and fallback selection. Those are real mechanics, not incidental details.

Blue-team defense:

- The observed defect was not "class A fails every possible simple task"; it was "inventory-present static calibration allowed a known-bad one-shot path." Smoke health is the smallest frame change that distinguishes inventory from execution suitability.
- A health field in `list_model_classes` would prevent callers from confusing presence with readiness even if it does not prove universal capability.
- Full task-specific benchmarking would be overbuilt for the observed failure.

Final classification: **Asymptotic SAF**.

Why not True SAF:

It corrects a major downstream contradiction, but the stated HORC is broader than the selected fix. "Capability truth" includes task-type suitability, latency distribution, and transient runtime behavior. A smoke probe approaches that truth but does not become it.

Why not pseudo-SAF:

It does not merely hide the class `A` timeout. It introduces a new authority boundary between model inventory and execution health, which is upstream of the observed defect.

Better candidate:

Restate the HORC narrowly as: "model-class reporting conflates inventory presence with one-shot smoke usability." Under that narrower HORC, health-gated class reporting can be a True SAF. For the broader HORC, the true transframe repair would be task- and environment-aware routing with observed health as one input, not the entire authority.

Validation check:

Run `list_model_classes` after forcing class `A` smoke failure and verify the result exposes `usable_for_one_shot:false` or rejects class `A` for `run_subagent` without waiting for the 103-second timeout.

### SAF-2 - Async-First Execution Identity

Stated HORC:

Workload shape is a caller assertion, not a server-routable state.

Selected SAF:

Make all child work a durable `start_run` task and treat `run_subagent` as a compatibility wrapper that starts, polls up to the one-shot budget, and returns a resumable `run_id` on timeout.

Red-team critique:

- This does not classify workload shape. A caller can still assert `quick_noninteractive` for a review/campaign prompt; the server still does not know whether it is quick or exploratory.
- The fix changes failure recovery, not routing authority. It turns a dead-end timeout into a resumable timeout, which is valuable but downstream.
- It may increase implementation surface: duplicate semantics between direct `start_run` and wrapped `run_subagent`, compatibility result fields, cancellation behavior, failure logs, and output paths.
- If the HORC is "caller assertion," then the irreducible correction must either remove the assertion, verify it, or replace it with observable scheduler state. Async identity alone does none of those.

Blue-team defense:

- The real observed harm was not just misclassification; it was late timeout with no durable handle. Async-first identity removes that harm.
- Perfect preflight workload classification is likely brittle and expensive. Durable execution identity is a robust frame change that makes the consequence of wrong classification tolerable.
- Keeping `run_subagent` as a wrapper preserves existing ergonomics while unifying lifecycle state.

Final classification: **Pseudo-SAF for the stated HORC**.

Why pseudo-SAF:

It appears upstream because it changes the execution frame, but relative to "workload shape is caller assertion," it sidesteps rather than repairs the malformed primitive. The server still cannot route based on workload shape; it only survives bad routing better.

What it really is:

A strong SAF candidate for a different HORC: "one-shot timeout has no durable recovery identity." For that narrower HORC, async-first identity is close to a True SAF.

Better candidate:

Either revise the HORC to the narrower dead-end-timeout lifecycle defect, or choose a real workload-shape SAF:

- Intraframe: explicit workload category enum such as `quick`, `interactive`, `exploratory`, `write_heavy`, with server-side rejection of incompatible tool/time/profile combinations.
- Transframe: scheduler-owned run planning where the server first creates a run, records an observed/declared workload plan, and then routes to one-shot polling or long async behavior as an output of that scheduler state.

Validation check:

Submit a prompt containing "inspect the repo and review risks" through the compatibility `run_subagent`. If the server still accepts it as `quick_noninteractive` without recording/routing workload shape, the stated HORC remains.

### SAF-3 - Internal Heartbeat Writer

Stated HORC:

Active progress state is coupled to optional client progress plumbing.

Selected SAF:

Always install an internal heartbeat/progress updater for `start_run` task snapshots, independent of whether MCP progress notifications are available; fan out to client notifications separately when available.

Red-team critique:

- Heartbeat does not prove semantic model progress. A process can be alive and stuck.
- Periodic writes increase filesystem churn and require cleanup/interval lifecycle care.
- If implemented naively, it can race with terminal snapshot writes or keep intervals alive after task completion.

Blue-team defense:

- The stated HORC is not "prove semantic progress." It is "snapshot liveness depends on optional client progress plumbing." An internal writer directly removes that dependency.
- The existing code already has heartbeat fields and snapshot writes; this SAF moves the heartbeat source from optional external notifier to run-task ownership.
- Race/cleanup concerns are implementation details with straightforward validation.

Final classification: **True SAF**.

Why True SAF:

It directly changes the malformed authority. Run-task liveness becomes owned by the run task, not by whether an MCP client supplied progress plumbing. No smaller complete fix is apparent: documentation, elapsed time alone, or requiring progress tokens would leave the same dependency.

Validation check:

Start an installed-production `start_run` through a client path that does not provide progress notifications. Poll `get_run` before terminal completion and verify `heartbeat_count > 0`, `last_progress_at` is present, and terminal cleanup stops further heartbeat changes.

### SAF-4 - `all-bundled` Naming And Uncovered Surface List

Stated HORC:

Campaign scenario vocabulary overstates coverage semantics.

Selected SAF:

Rename/report bundled `all` as `all-bundled` and print uncovered major surfaces.

Red-team critique:

- If the CLI still accepts `--scenario all`, the ambiguity survives at the invocation boundary. A summary label helps readers, but the user still asked for "all."
- A manually maintained uncovered-surface list can drift from the real tool surface.
- Adding uncovered surfaces to prose does not make coverage first-class or machine-checkable.

Blue-team defense:

- The observed defect is report overclaiming, not absence of a formal coverage engine. Changing the report label and surfacing uncovered areas would prevent the exact false inference made in reports.
- A full scenario registry is more motion than the current evidence requires.
- Keeping `all` as an alias can preserve compatibility if output clearly says `scenario_set: all-bundled`.

Final classification: **Asymptotic SAF**.

Why not True SAF:

It reduces semantic overclaiming but does not make coverage semantics authoritative. The true root is that scenarios are untyped names without declared product-surface coverage. A label and uncovered list can still drift.

Why not pseudo-SAF:

It addresses the actual language boundary where the overclaim occurred. It is not purely cosmetic if the probe summary and reports consistently expose "bundled only" semantics.

Better candidate:

Promote scenarios to a first-class registry with declared coverage tags:

- tool names covered,
- lifecycle phases covered,
- evidence class,
- major uncovered surfaces.

Then `--scenario all-bundled` can be explicit, and a separate `coverage_summary` can be computed from the registry.

Validation check:

Run the probe with every supported scenario and verify output includes `scenario_set:"all-bundled"` plus machine-readable uncovered surfaces such as async input, cancellation, timeout recovery, redaction, valid packet closure, and installed Pi integration.

### SAF-5 - Calibration Era Field In Failure Records

Stated HORC:

Failure records lack an explicit calibration era.

Selected SAF:

Add `resolved_model_class`/`calibration_version` or `model_class_schema_version` to all failure records and reports going forward.

Red-team critique:

- "Going forward" does not repair existing production records, which are the records that motivated the observed ambiguity.
- A field in raw records is insufficient if readers/reports do not use it to segment analysis.
- `schema_version` already exists but does not encode calibration semantics; adding another version field can create version taxonomy drift unless ownership is clear.

Blue-team defense:

- Future ambiguity is the only part the runtime can cleanly prevent without risky historical rewriting.
- Failure logs are append-only operational telemetry; backfilling may be inappropriate.
- A calibration-era field is the smallest runtime change that gives future analysis an explicit boundary.

Final classification: **Asymptotic SAF**.

Why not True SAF:

It only fixes future records. The historical ambiguity remains unless there is either a backfill/migration or a reader rule that classifies legacy records as `calibration_era:"legacy_unclassified"`.

Why not pseudo-SAF:

It does address the malformed data model for new records and gives future analysis a real field instead of timestamp inference.

Better candidate:

Add `calibration_era` to new records and add a failure-log reader/report convention:

- records without the field are explicitly classified as `legacy_unclassified`,
- reports must segment by `calibration_era`,
- optional one-time archival summary tags pre-field records without mutating originals.

That combined runtime-plus-reader boundary is a True SAF for analysis ambiguity.

Validation check:

Generate one new failure and run the archive/report path over mixed old/new records. Verify old records are not silently grouped with current calibration and new records expose the explicit era.

## Revised SAF Set

| HORC | Revised Classification | Revised Recommendation |
| --- | --- | --- |
| Model-class calibration as capability truth | Asymptotic as written | Narrow the HORC to one-shot smoke usability, or expand the fix to task/environment-aware routing. |
| Workload shape as caller assertion | Pseudo-SAF as written | Reclassify async-first identity under dead-end timeout lifecycle, or add real workload-shape authority. |
| Progress coupled to client plumbing | True SAF | Keep selected intraframe fix. |
| Scenario vocabulary overclaims coverage | Asymptotic as written | Add a first-class scenario coverage registry if this must be a true root repair. |
| Failure records lack calibration era | Asymptotic as written | Pair new era fields with legacy reader/report segmentation. |

## Residual Risks

- The strongest remaining root issue is still routing authority: which model and lifecycle mode should handle a given job. Current selected fixes improve failure recovery and reporting, but only a health- and workload-aware scheduler fully addresses that class.
- The word SAF is too easy to overclaim. Future reports should state the exact HORC scope first, then classify whether the fix is true only under that scope.
- Some asymptotic fixes may still be the right engineering choice. Classification as asymptotic is not a rejection; it means the claim should be narrowed or the residual risk should be made explicit.
