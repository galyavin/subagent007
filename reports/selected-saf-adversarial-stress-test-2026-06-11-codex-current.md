# Selected SAF Adversarial Stress Test

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Input artifact: `reports/observed-real-use-horc-saf-campaign-2026-06-11-codex-current.md`
Scope: adversarial but fair classification of each selected SAF as True SAF, asymptotic SAF, or pseudo-SAF.

## Verdict

Go with conditions. None of the four selected SAFs are pseudo-SAFs. Two are True SAFs for their stated HORCs, and two are asymptotic: they point in the right direction but include avoidable excess, preserve ambiguity, or fall short of perfect irreducibility.

Replace-vs-repair threshold is not crossed. The selected set is directionally sound, but the exact recommended first fixes should be tightened before implementation.

## Evidence Frame

The stress test uses the observed live campaign plus code inspection of `runTask`, `processRunner`, `validate`, `modelHealth`, and the observed-probe manifest. I assume the objective is not "make the system perfect"; it is to eliminate each stated HORC with the least real system motion and without hiding complexity elsewhere.

## Classification Summary

| HORC | Selected SAF | Classification | Short Reason |
| --- | --- | --- | --- |
| H1 active progress truth coupled to child output/delayed heartbeat | Immediate post-spawn liveness event plus periodic synthetic liveness updates | Asymptotic SAF | Correct direction, but not irreducible: the smallest sufficient fix is an immediate `running_silent` phase/message after successful spawn. Periodic synthetic events are extra for the observed defect. |
| H2 coverage aliases preserve historical semantics | Remap `all` to `full-current`; keep/deprecate `all-bundled` with warning | Asymptotic SAF | Fixes the most likely operator mistake, but preserves one ambiguous `all-*` alias. A warning mitigates rather than removes the semantic contradiction. |
| H3 one-shot suitability uses lexical heuristic | Replace caller sync/async routing with scheduler that always creates durable task and sync-returns only if fast | True SAF | Removes the malformed primitive: caller-chosen transport no longer has to encode workload semantics. No smaller lexical or intent-field patch fully resolves false positives/negatives. |
| H4 sparse model health presented beside default selection | Add health-basis/action fields and default health status | True SAF | The defect is ambiguity, not missing readiness proof. Explicit basis/action is the smallest sufficient correction without adding side effects. |

## Findings Table

| ID | Critique | Evidence, Severity, Confidence | Best Defense | Final Status | Repair / Validation |
| --- | --- | --- | --- | --- | --- |
| F1 | H1 selected SAF is slightly overbuilt. The observed defect is stale `awaiting_child_event` for ~26s before first child output. Periodic synthetic liveness is useful, but an immediate post-spawn phase/message is the atomic fix. | Verified, Medium, High. `src/runTask.ts` projects active progress from state fields; output parsing updates phase; `src/processRunner.ts` heartbeat interval defaults to 30s. | The selected SAF explicitly includes immediate liveness, so it would solve the defect. Periodic updates help longer silent runs. | Partially Resolved. Asymptotic SAF. | Tighten to: after successful child spawn, set `active_phase:"running"` or `running_silent`, `last_progress_message:"child process running; waiting for output"`, and write snapshot. Validate with a live/fake child that emits no output for less than 30s. |
| F2 | H2 selected SAF preserves ambiguity by keeping `all-bundled` as a live alias. A deprecation warning is not the same as making the command semantics coherent. | Verified, Medium, High. Manifest maps `all` and `all-bundled` to `protocol-core`; usage text says so, but `full-current` is the actual deterministic current coverage profile. | Backward compatibility matters; `all-bundled` may mean "all bundled protocol-core scenarios" to existing callers. | Partially Resolved. Asymptotic SAF. | Split meanings: `all -> full-current`; `all-bundled -> protocol-core` only with a machine-visible deprecation field and stderr warning, or fail `all-bundled` unless `--profile protocol-core` is explicit. Validate by asserting `--scenario all` reports `scenario_set:"full-current"`. |
| F3 | H3 scheduler is high-motion and changes the public mental model; it may be too large for a near-term patch. | Direct, High, Medium. Current tool table intentionally distinguishes `run_subagent` and `start_run`; `validate.ts` regex guard currently catches broad work. | The HORC is precisely that caller-selected sync/async transport is the wrong primitive. A scheduler is the smallest complete frame change because lexical or structured-intent patches still require classifying workload before execution. | Resolved. True SAF, but not a small implementation task. | Treat as a contract migration: introduce scheduler-compatible path first, keep old tools as wrappers, and validate that broad work returns a durable `run_id` without invoking regex suitability as the decisive mechanism. |
| F4 | H4 health-basis fields do not prove the default model works. Operators may still want readiness, not just explanation. | Verified, Medium, High. `modelHealthForClass` returns `unknown` when no cached record exists; `assertModelClassUsableForOneShot` blocks only known unhealthy classes. | The HORC is presentation ambiguity: unknown health beside default class reads like incoherence. The selected SAF makes unknown status intelligible without making listing slow or side-effectful. | Resolved. True SAF. | Add `health_basis:"never_probed" | "cached_probe"` and `health_action`/`probe_command`; validate `list_model_classes` for a missing health file explains unknown and does not run probes. |

## Per-SAF Stress Tests

### H1: Immediate/Synthetic Child Liveness Progress

Adversarial probes:

- Does it eliminate the root cause or just rename the symptom?
  - It eliminates the observed stale label if the snapshot is written immediately after successful spawn with a running-silent phase.
- Is every part necessary?
  - No. Periodic synthetic liveness is useful for long silence, but the observed incoherence before the first heartbeat is solved by one immediate state transition and snapshot write.
- Does it hide complexity elsewhere?
  - Not if implemented as process-state projection. It would hide complexity if implemented as repeated text-only events without phase semantics.
- Could a smaller change work?
  - Yes: set phase/message to running-silent immediately after the child spawn event. That is smaller than immediate plus periodic synthetic events.

Classification: Asymptotic SAF.

Revised atomic form:

- After child spawn succeeds, write one active snapshot with phase `running` or a new `running_silent` phase and message `child process running; waiting for output`.
- Keep existing heartbeat for longer runs. Add periodic synthetic events only if a separate trial proves long-silent active views remain incoherent after the immediate state fix.

### H2: Coverage Alias Remap/Deprecation

Adversarial probes:

- Does it eliminate the malformed primitive?
  - Partly. Remapping `all` to `full-current` fixes the most direct contradiction. Keeping `all-bundled` as a working alias still preserves an ambiguous word.
- Is the compatibility assumption actually immutable?
  - No. This is an internal campaign script, not a broad public API. The compatibility cost exists but should not dominate semantic correctness unless known external automation depends on it.
- Does the warning fully resolve operator confusion?
  - No. Warnings are easy to miss and do not change the returned coverage.
- Could a smaller change work?
  - For `all`, yes: one manifest alias remap. For `all-bundled`, the smallest coherent correction is to require explicit `protocol-core` or mark the result as deprecated in structured output.

Classification: Asymptotic SAF.

Revised atomic form:

- Remap `all` to `full-current`.
- Stop treating `all-bundled` as a normal alias. Either fail with "use --profile protocol-core" or return a structured `deprecated_alias:true` plus warning.

### H3: Scheduler-Style Sync/Async Unification

Adversarial probes:

- Does it eliminate the lexical-classifier root cause?
  - Yes. The caller no longer needs to correctly predict workload shape to choose a tool. The server can always create a durable task, then optionally wait briefly for a completed result.
- Is it smaller than adding better regexes?
  - No in implementation size, but yes in root-cause sufficiency. More regexes never eliminate false positives/negatives.
- Could structured intent fields be smaller and sufficient?
  - They are smaller but not sufficient. They shift the workload-classification burden from prompt vocabulary to caller self-reporting.
- Does it hide complexity elsewhere?
  - It centralizes complexity in a scheduler. That is acceptable if the old tools become wrappers and result semantics are explicit.
- What could make it pseudo-SAF?
  - If implemented as just "run regex classifier then start async when rejected," it would be pseudo. The decisive mechanism must be durable-task-first execution, not better preflight wording.

Classification: True SAF.

Implementation guardrails:

- Durable task is created before child execution for both short and long work.
- Synchronous return is an optimization over the same task, not a separate execution mode.
- Existing `run_subagent`/`start_run` can remain compatibility wrappers, but the primitive exposed in docs should be scheduler-first.

### H4: Model Health-Basis Fields

Adversarial probes:

- Does it eliminate the observed incoherence?
  - Yes. The incoherence is that `unknown` health beside a default class looks like a readiness contradiction. Explaining basis and action makes it coherent.
- Does it solve a different problem instead?
  - No. It does not claim to prove readiness; it clarifies what the health result means.
- Could a smaller change work?
  - A documentation-only note is smaller but insufficient because the ambiguity is in structured tool output. Adding fields to the output is the smallest place that reaches all callers.
- Does it hide complexity elsewhere?
  - No, if it explicitly says unknown is not a gate and gives the probe command.

Classification: True SAF.

Implementation guardrails:

- Do not auto-probe in `list_model_classes`.
- Add fields to each `one_shot_health` view, not just README prose.
- Include top-level default health status so default readiness interpretation is not left to callers.

## Revised Recommendation

1. Implement H1 in tighter form: immediate running-silent snapshot after spawn. Classify this revised form as the True SAF; the earlier immediate-plus-periodic proposal remains asymptotic.
2. Implement H2 in tighter form: `all -> full-current`; make `all-bundled` explicit/deprecated or reject it. The previous compatibility-preserving form remains asymptotic.
3. Keep H3 as the true transframe SAF, but treat it as a contract migration rather than a quick patch.
4. Implement H4 as selected: health-basis/action fields in structured output.

## Residual Risks

- H1 may still not expose what the model is doing internally; that is acceptable because the selected HORC is stale liveness, not full introspection.
- H2 may break existing local automation if `all` currently expects `protocol-core`; mitigate with a clear changelog or one-release warning period.
- H3 has high contract motion and should not be slipped into a minor cleanup.
- H4 clarifies unknown health but does not increase readiness confidence; callers still need to run `npm run model-health:probe` for proof.
