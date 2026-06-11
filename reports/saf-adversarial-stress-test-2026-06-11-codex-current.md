# SAF Adversarial Stress Test: Subagent007 MCP Server

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Source report: `reports/observed-real-use-trials-2026-06-11-codex-current.md`
Method: adversarial but fair red/blue review of each selected SAF.

## Verdict

Overall decision: **Rework Before Proceeding**.

The selected SAF set is directionally good, but only one item survives as a True SAF under strict atomicity. Three are asymptotic SAFs: useful and near the right shape, but incomplete or not perfectly irreducible. One is a pseudo-SAF against its stated HORC because it hides prompt-channel conflation in the public renderer instead of correcting the conflated channel.

Replace-vs-repair threshold is not crossed. The set can be repaired by consolidating event-related fixes and tightening the exact intervention boundary for prompt-channel and campaign-coverage problems.

## Evidence Frame

The prior report identified five selected SAFs for active observability, caller input history, packet scaffold visibility, validation error shape, and campaign coverage. This review assumes the objective is strict HORC removal with the least total real system motion, not merely reducing visible symptoms.

## Classification Summary

| Selected SAF | Classification | Short Reason |
| --- | --- | --- |
| S1. Bounded typed run-event projection | **Asymptotic SAF** | Correct direction, but a projection over snapshots is not the primitive that eliminates timeline incoherence; it remains incomplete when child/tool phases are not emitted and when active state is lost after restart. |
| S2. Durable input lifecycle events | **True SAF, if implemented inside the unified run-event model** | Smallest sufficient correction for the mailbox/run-history split; it directly makes input lifecycle part of run history without exposing answer text. |
| S3. Redact/summarize server scaffolding in public projection | **Pseudo-SAF against the stated HORC** | It improves display but leaves control instructions and user prompt in one channel. The malformed primitive remains; complexity is hidden in renderer rules. |
| S4. Structured preflight error envelope | **Asymptotic SAF** | Useful and low-motion, but only covers expected semantic validation failures. It does not eliminate public result-shape bifurcation across schema, handler, and terminal failures. |
| S5. Named campaign profiles and clearer coverage naming | **Asymptotic SAF** | Clarifies evidence and reduces overclaiming, but does not itself create a single authoritative conformance run across deterministic, live-model, installed-server, and stateful surfaces. |

## Stress-Test Findings

| ID | Target | Red-Team Critique | Evidence / Severity / Confidence | Blue-Team Defense | Final Status | Repair / Validation |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | S1 typed run-event projection | The proposal says "typed events" but keeps them as a bounded projection inside the task snapshot store. That can still lose the authoritative sequence, omit unavailable tool phases, and report active restart failures without an event history. | Evidence: direct from selected SAF wording and `src/runTask.ts` snapshot model. Severity: high. Confidence: high. | It is intentionally intraframe and would materially improve active `get_run` without replacing storage. A bounded projection may be enough for current UX defects. | Partially resolved. It is a good near-SAF but not strictly atomic against the timeline HORC. | Recast S1 as "introduce a single append API for typed public run events, initially materialized into snapshots." Validation: long shell run shows `child_started`, `tool_waiting`, `terminal`; restart snapshot preserves terminal events for completed runs. |
| F2 | S2 input lifecycle events | This may duplicate S1. If S1 already includes `input_required` and `input_answered`, a separate input SAF risks a second event path and incoherent ordering between mailbox state and run events. | Evidence: direct. S1 already lists input events; S2 separately proposes them. Severity: medium. Confidence: high. | As a scoped correction, S2 is exactly the smallest fix for the mailbox/run-history split. It can be implemented as a specialized producer of the same event model, not a separate mechanism. | Resolved with condition. True SAF only when folded into the same event append primitive as S1. | Implement S2 as mailbox-to-run-event emission through S1's single append API. Validation: input-required, answered, timed-out, and closed transitions appear once, in order, with no answer text in public events. |
| F3 | S3 scaffold redaction | Redaction in `publicOutputLineFromProcessLine` repairs the transcript symptom, not the root. The child still receives one combined prompt; persisted outputs, debug logs, model behavior, token costs, and future renderers can still inherit the conflation. | Evidence: direct from selected SAF and `src/session.ts` prompt append path. Severity: high. Confidence: high. | It is cheaper than changing the Pi child request contract and may fully solve the currently observed public excerpt problem. | Unresolved. Against the stated HORC, this is pseudo-SAF: useful tactical mitigation, not a fundamental fix. | Replace selected SAF with channel separation at the request object boundary: user prompt plus `system_contracts` or equivalent internal instruction field. If Pi cannot accept channels, create an adapter-level metadata field and make renderers source public user text from pre-compose input, not from echoed child prompt. Validation: required-packet run public event shows original user prompt plus a compact packet-policy marker; raw child request preserves contract separately. |
| F4 | S4 structured preflight envelope | The proposal preserves multiple failure channels: SDK schema rejections, thrown unexpected errors, terminal child failures, and semantic preflight envelopes. Programmatic callers still need branching logic. | Evidence: direct from `server.ts` schema use and selected SAF caveat "where MCP allows it." Severity: medium. Confidence: high. | Some bifurcation is appropriate: schema-level type failures happen before handler code, and in-band semantic failures should not weaken input schemas. The fix still improves the common expected-error path. | Partially resolved. It is asymptotic: useful but incomplete against the public-shape HORC. | Narrow the claim: "Normalize semantic preflight errors, not all errors." Or choose the transframe fix: loosen schemas to type-only and return semantic validation as a discriminated union. Validation: invalid `run_subagent` broad-work request returns structured `preflight_rejected`; missing required `prompt` remains SDK schema error and is documented as outside the semantic envelope. |
| F5 | S5 campaign profiles | Profiles and naming reduce interpretation burden, but "full-current" can become another label unless it actually runs installed-server, live-model, async, caller-input, cancellation, timeout, packets, and deterministic failure scenarios with a unified coverage artifact. | Evidence: direct from current probe coverage summary and selected SAF wording. Severity: medium. Confidence: high. | Clear profile names are a real improvement, and a pragmatic full profile can orchestrate enough surfaces for routine regression confidence without building a full conformance platform. | Partially resolved. Asymptotic: good campaign hygiene, not a complete coverage primitive. | Define coverage semantics as data, not prose: each profile declares required surfaces, evidence class, allowed skips, and pass/fail criteria. Validation: `full-current` exits nonzero if any required surface lacks a recorded call/result, and reports deterministic vs live evidence separately. |

## Per-SAF Determination

### S1. Bounded Typed Run-Event Projection

Classification: **Asymptotic SAF**.

It is not a pseudo-SAF because it attacks the right representation boundary: run state needs typed events instead of raw transcript snippets. But it is not a True SAF under strict HORC language because a bounded projection is still a derived view, not the authoritative timeline primitive. It also contains the phrase "when available" for tool phases, which means the proposal does not guarantee coverage of the very phases that made active runs feel opaque.

True-SAF revision:

- Introduce one public run-event append primitive used by process start, child start, public model messages, input lifecycle, timeout, cancellation, packet parse, and terminal settlement.
- Continue materializing bounded `recent_events` into snapshots for compatibility.
- Do not claim full event sourcing yet unless the append log is durable and authoritative.

Revised classification after this repair: **True SAF for active public observability**, still not a full internal audit ledger.

### S2. Durable Input Lifecycle Events

Classification: **True SAF, conditionally**.

This is the smallest sufficient correction for its distinct HORC: input lifecycle currently lives in mailbox state and only pending state is projected transiently. Appending redacted request/answer/close/timeout events makes the interaction part of run history without exposing answer content.

The condition is architectural: it must not create an input-specific side channel. It should be one producer into S1's event append primitive. If implemented separately from the run-event model, it degrades to an asymptotic SAF because it creates another projection boundary.

Validation that preserves True-SAF status:

- Create input request: one durable `input_required` event.
- Answer request: one durable `input_answered` event with request id, no answer text.
- Cancel run with pending request: one durable `input_closed` event.
- Late duplicate answer: error message identifies request settlement when the run is still known, while terminal runs may still report "not accepting input" if the run-level state is the primary blocker.

### S3. Scaffold Redaction/Summarization

Classification: **Pseudo-SAF against the stated HORC**.

The selected fix is a good UI mitigation, but it is not the smallest sufficient change that eliminates "control instructions and user prompt share one public text channel." It leaves the shared channel in place and teaches the renderer to hide the consequences. That is exactly the pseudo-SAF failure mode: symptom relief by moving complexity into a downstream filter.

True-SAF replacement:

- Preserve separate request fields for user prompt and server contracts before child dispatch.
- Render public transcript from the user-prompt field plus compact contract markers, not from the composed prompt echoed by the child.
- If the Pi child can only accept one prompt string today, use an adapter object with both `publicPrompt` and `composedPrompt`; treat `composedPrompt` as internal and never as public user-authored content.

Minimality argument:

- This does not require a full Pi protocol redesign immediately.
- It changes the frame at the point of prompt composition, which is the first place the conflation occurs.
- It removes the need for fragile renderer pattern matching.

### S4. Structured Preflight Error Envelope

Classification: **Asymptotic SAF**.

It improves the common caller experience and is probably worth doing, but it does not fully resolve the HORC. The public API still has at least three shapes: SDK schema errors, structured semantic preflight rejections, and terminal `success:false` child/session results.

This is not pseudo because the selected fix does address a real upstream branch: semantic validation is currently thrown through the same path as other handler errors. But it is not irreducible or complete as stated.

True-SAF alternatives:

- Strict transframe: make every tool return a discriminated union and reduce MCP schema validation to minimal type checks. Semantic validation becomes in-band.
- Practical revised SAF: explicitly scope the fix to "semantic preflight failures" and document schema errors as a separate MCP transport concern.

Recommended classification-preserving repair:

- Rename the SAF to "semantic preflight envelope" and stop claiming it fixes all public result-shape bifurcation.
- Add `kind:"preflight_rejected"`, `reason_code`, `retry_with`, and `child_started:false`.

### S5. Campaign Profiles And Coverage Naming

Classification: **Asymptotic SAF**.

The proposal reduces ambiguity but does not inherently create full coverage. A profile named `full-current` can still become a pseudo-complete label unless the profile has executable coverage requirements and fails closed when required surfaces are absent.

This is not pseudo because the selected repair attacks a real upstream source of overclaiming: named scenarios and coverage semantics. But it remains incomplete if the profile is mostly naming plus checklist output.

True-SAF revision:

- Define a machine-readable coverage manifest listing every required surface, evidence class, command/call source, and pass/fail predicate.
- Make each profile execute or explicitly skip surfaces with a reason.
- Make `full-current` fail nonzero when required surfaces are not evidenced.

Validation:

- Run `protocol-core`: passes deterministic subset and reports uncovered live surfaces as out of scope.
- Run `full-current` without live model auth or installed server access: fails with explicit missing evidence, not a green partial report.
- Run `full-current` with all dependencies: emits one normalized coverage artifact linking deterministic and live observations.

## Revised Recommendation

Proceed only after revising the selected SAF set as follows:

1. Merge S1 and S2 into a single public run-event append primitive, with input lifecycle as one event producer.
2. Replace S3 with prompt-channel separation at the composition boundary. Renderer redaction can remain only as defense in depth.
3. Re-scope S4 to semantic preflight errors, or choose the larger discriminated-union contract if uniform machine shape is mandatory.
4. Re-scope S5 from naming to executable coverage manifests with fail-closed required-surface checks.

## Residual Risks

- Tool-phase events may require changes in the Pi child or adapter to become more than coarse lifecycle markers.
- Separating prompt channels may expose assumptions in Pi's current request contract and require compatibility handling.
- Uniform error contracts may be constrained by MCP SDK behavior; schema-level errors may remain out-of-band unless schemas are deliberately loosened.
- A full campaign profile that includes live installed-server behavior will remain slower and more environment-sensitive than deterministic protocol tests.
