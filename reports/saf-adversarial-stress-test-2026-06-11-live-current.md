# SAF Adversarial Stress Test - 2026-06-11 Live Current

Source campaign report: `reports/observed-real-use-horc-saf-campaign-2026-06-11-live-current.md`

Purpose: adversarially but fairly test each selected SAF against four criteria:

- Completeness: does it eliminate the HORC, not only the observed symptom?
- Irreducibility: is there a smaller complete fix?
- Hidden motion: does it move complexity into another layer, workflow, or manual convention?
- Frame honesty: does it only work after silently narrowing the problem?

## Verdict Table

| HORC | Selected SAF | Verdict | Short reason |
| --- | --- | --- | --- |
| A | Reserve terminal lifecycle authority for `runTask`; demote raw timeout/cancel process markers in public event projection. | True SAF | Removes the actual duplicate authority for public terminal lifecycle events with the smallest local change. |
| B | Add a small run-context resolver for run-scoped failure logging. | Asymptotic SAF | Fixes the observed edge, but remains a handler/wrapper patch unless operation context becomes first-class. |
| C | Add missing executable scenarios and make `full-current` an executable orchestration profile. | Asymptotic SAF | Makes current coverage executable, but does not by itself prevent required-surface/scenario drift recurring. |
| D | Provide a live campaign runner that launches a fresh server under campaign-scoped environment. | Asymptotic SAF | Produces isolated live campaigns, but does not change the process-scoped attribution primitive. |
| E | Clarify docs that input answers are omitted from input events but child output remains public. | Pseudo-SAF for the HORC as written | Corrects expectation, but does not fix structural/non-data-flow-aware redaction. |
| F | Add explicit post-spawn phases and immediate first heartbeat snapshot. | Asymptotic SAF | Improves liveness signal, but is not a complete phase/state model and may be slightly overbroad. |

## HORC A: Terminal Lifecycle Events Have Multiple Authorities

Selected SAF: reserve terminal lifecycle authority for `runTask`; demote raw `[subagent007 timeout]` and `[subagent007 cancelled]` process markers in the public event projection while keeping them in output artifacts.

### Adversarial Attacks

- Completeness attack: if raw markers remain in Markdown artifacts, external consumers may still parse duplicate lifecycle state from artifacts.
- Irreducibility attack: simply suppressing duplicate terminal event names from `recent_events` might be smaller.
- Hidden-motion attack: demoting markers to diagnostics could hide useful low-level process data from public event consumers.
- Frame attack: the fix only addresses public event projection, not all possible transcript consumers.

### Defense

The observed HORC is specifically that public terminal lifecycle state has two authorities: `publicMarkerLine` in `src/transcript.ts` maps raw process markers to terminal events, and `appendTerminalEvent` in `src/runTask.ts` emits normalized terminal lifecycle events. The selected fix removes one authority from the public lifecycle channel while preserving raw transcript fidelity. A narrower "dedupe same event names" patch would be smaller in lines changed, but not smaller in semantics: it still leaves lifecycle inference split across producers.

### Classification

True SAF, scoped to the public event model. It is atomic because the essential correction is one rule: only `runTask` may author terminal lifecycle events. It is complete for the observed contradiction and does not require schema, storage, or process-runner redesign.

The stronger typed-event-bus transframe candidate is cleaner architecturally, but it is not necessary to eliminate this HORC in the current frame.

## HORC B: Failure Logging Uses Tool Request Shape Instead Of Run Context

Selected SAF: for run-scoped tools, resolve the run snapshot before logging when possible and include `run_id`, `task_kind`, `session_key`, derived `cwd`, and precise reason-code mapping for common input-state errors.

### Adversarial Attacks

- Completeness attack: if the run id is invalid, expired, or snapshot-corrupt, no run context can be derived.
- Irreducibility attack: only adding a specific `run_is_not_accepting_input` reason code would fix the observed late-answer edge with fewer changes.
- Hidden-motion attack: resolving snapshots inside failure logging can create read-time side effects, latency, or failure modes in the logging path.
- Frame attack: the real primitive problem is that handlers do not run with an operation context; a resolver is a retrofit.

### Defense

The specific reason-code-only patch is a pseudo-SAF because it leaves `cwd_class:"missing"` and loses run/session grouping. A resolver is the smallest current-frame change that can reconnect `answer_run_input` and `cancel_run` failures to the task they operate on.

But the selected fix is not perfectly irreducible. To be truly atomic, tool invocation would begin by resolving an operation context, and failure logging would consume that context uniformly. The proposed resolver approaches that without changing the handler architecture.

### Classification

Asymptotic SAF. It is directionally correct and should eliminate the observed telemetry defect for existing valid run ids, but it remains a retrofit around a missing first-class context primitive. It is not a pseudo-SAF because it fixes both label precision and context recovery for the common path.

The stricter True SAF would be: introduce a central run-scoped handler wrapper that resolves `RunOperationContext` once, passes it to the handler, and passes the same context to failure logging.

## HORC C: Coverage Manifest Declares More Product Surfaces Than The Probe Can Execute

Selected SAF: add executable scenarios for the missing surfaces and make `full-current` an executable orchestration profile rather than only a required-surface assertion.

### Adversarial Attacks

- Completeness attack: adding today's missing scenarios does not prevent tomorrow's required surfaces from lacking scenarios.
- Irreducibility attack: one could simply relax `full-current` requirements to match existing scenarios.
- Hidden-motion attack: adding live scenarios may make the profile slow, flaky, provider-dependent, or awkward to run in CI.
- Frame attack: manual live installed observations still cannot satisfy a campaign ledger unless the runner can execute or import them.

### Defense

Relaxing requirements is a pseudo-SAF: it weakens the claim instead of fixing coverage. Adding executable scenarios repairs the current contradiction between "required" and "runnable." The issue is that this is a finite inventory repair, not a structural invariant.

The report's selected SAF says "make `full-current` an executable orchestration profile"; if interpreted strictly, that should include a manifest invariant: every `required_surface` in a profile must be covered by at least one scenario in that profile whose evidence class is compatible with the profile mode, or the profile definition itself fails before execution. Without that invariant, the fix can regress.

### Classification

Asymptotic SAF as originally stated. It becomes a True SAF only if expanded to include the invariant tying required surfaces to executable scenarios. Scenario addition alone approaches the right state but is not irreducible or future-complete.

The refined True SAF would be: encode profile satisfiability as a manifest validation rule, then add the minimal scenarios needed to satisfy that rule.

## HORC D: Campaign Scope Is Bound To Process Environment

Selected SAF: provide a live campaign runner that launches a fresh server under `scripts/run-observed-campaign.mjs` and drives all live-model scenarios through that server.

### Adversarial Attacks

- Completeness attack: an already-running installed MCP server still cannot be retroactively campaign-scoped.
- Irreducibility attack: documenting "restart MCP under campaign env" would be smaller.
- Hidden-motion attack: the runner moves attribution correctness into a special launch path; callers outside that path still have the same risk.
- Frame attack: the HORC says the primitive is process-scoped campaign identity, but the fix continues to rely on process scope.

### Defense

The runner is stronger than documentation because it makes the correct process scope mechanically reproducible. It also avoids the larger trust and protocol-design cost of request-scoped campaign metadata. For observed trial campaigns, launching a campaign-scoped server is enough to prevent production-state pollution and evidence mislabeling.

But it does not eliminate the malformed primitive. It uses the primitive correctly. That is a valid engineering move when the intended workflow is campaign execution, but it is not a true root-cause correction for campaign attribution as a general capability.

### Classification

Asymptotic SAF. It is fair and useful, but not a True SAF for the HORC as phrased. The root remains process-scoped identity. It is not pseudo because it really does produce isolated live campaign evidence when used.

The refined True SAF would require request-scoped campaign attribution or a formally separate "campaign server instance" primitive that the MCP client can invoke explicitly.

## HORC E: Public Transcript Redaction Is Structural, Not Data-Flow-Aware

Selected SAF: clarify README/tool docs that `answer_run_input.answer` is omitted from mailbox/public input events, but child-generated output is public unless a future sensitivity mode prevents disclosure.

### Adversarial Attacks

- Completeness attack: documentation does not stop sensitive input values from appearing in assistant output.
- Irreducibility attack: if the defect is only misleading docs, this is minimal; if the defect is redaction, it is not a fix at all.
- Hidden-motion attack: it moves risk management to user behavior and prompt discipline.
- Frame attack: the selected SAF silently reframes the HORC from "redaction is not data-flow-aware" to "expectations are unclear."

### Defense

The implementation did exactly what it claimed narrowly: input-answer events omitted the answer, while assistant output remained public. If the real incoherence is documentation/expectation mismatch, doc clarification is the smallest sufficient fix.

But the HORC was named as a structural redaction limitation. Against that HORC, the selected fix does not alter the redaction primitive. It neither tracks sensitivity labels nor redacts derived output. It therefore cannot honestly be called a SAF for non-data-flow-aware redaction.

### Classification

Pseudo-SAF for the HORC as written. It is a True SAF only for a narrower corrected HORC: "documentation implies stronger answer confidentiality than the system provides." The original HORC should be split:

- Documentation HORC: ambiguous confidentiality boundary. True SAF: clarify docs.
- Redaction HORC: no data-flow-aware sensitivity model. True SAF: introduce explicit sensitivity-labeled input/output policy, or declare that such confidentiality is out of scope.

## HORC F: Active Progress Is Timer-Based, Not Phase-Based

Selected SAF: add explicit phase transitions after spawn, such as `child_started`, `awaiting_child_event`, and `last_output_at`, and emit an immediate first heartbeat snapshot after spawn.

### Adversarial Attacks

- Completeness attack: provider/model/tool startup can still be opaque after `awaiting_child_event`.
- Irreducibility attack: an immediate snapshot with `last_progress_message:"child spawned; awaiting first event"` may be smaller than adding multiple fields.
- Hidden-motion attack: introducing phase fields creates another state vocabulary that can drift from actual child/process state.
- Frame attack: the true missing primitive may be typed child runtime state, not more heartbeat metadata.

### Defense

Shortening heartbeat intervals is correctly rejected. The defect is not just frequency; it is absence of a meaningful state transition after spawn. Adding a phase and immediate snapshot directly addresses the observed "looks stalled" period without needing Pi/provider internals.

However, the selected SAF is not perfectly irreducible. `child_started`, `awaiting_child_event`, `last_output_at`, and immediate heartbeat are a bundle. The smallest sufficient fix for the observed incoherence may be a single persisted phase plus immediate snapshot. The broader bundle approaches a phase model but does not become one.

### Classification

Asymptotic SAF. It materially reduces ambiguity but remains incomplete and slightly over-specified. It is not pseudo because it changes the active run state users observe, rather than just describing the stall differently.

The refined True SAF for the observed defect would be: after child spawn, immediately persist `active_phase:"awaiting_child_event"` and `last_phase_at`, then update `active_phase` on first public child event, input request, timeout, cancellation, or terminal result.

## Revised Classifications

1. HORC A: True SAF.
2. HORC B: Asymptotic SAF.
3. HORC C: Asymptotic SAF, upgradeable to True SAF by adding profile satisfiability validation.
4. HORC D: Asymptotic SAF.
5. HORC E: Pseudo-SAF for the stated HORC; True SAF only for a narrower documentation HORC.
6. HORC F: Asymptotic SAF.

## Net Correction To The Prior Report

The prior report was too generous in calling several selected candidates "SAF" without marking their scope. The only selected candidate that survives strict adversarial testing as a True SAF is HORC A. HORCs B, C, D, and F are useful least-motion repairs but not perfectly atomic root-cause eliminations. HORC E needs reframing; the proposed documentation change is valuable, but it does not fix the stated structural redaction HORC.
