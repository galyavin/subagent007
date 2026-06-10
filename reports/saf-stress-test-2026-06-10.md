# SAF Stress Test - 2026-06-10

Status: historical pre-implementation stress test. The asymptotic gaps identified for SAF2 and SAF3 were incorporated into `reports/revised-saf-set-2026-06-10.md` and addressed by the subsequent implementation.

## Scope

This is an adversarial but fair review of the selected SAFs in `reports/observed-real-use-trials-2026-06-10.md`.

Classification labels:

- **True SAF**: smallest sufficient change that eliminates the fundamental cause for the identified HORC.
- **Asymptotic SAF**: approaches SAF quality but remains incomplete, indirect, overbroad, or not perfectly irreducible.
- **Pseudo-SAF**: appears minimal but mainly treats symptoms, defers the real fix, or hides complexity elsewhere.

Evidence basis:

- Source review of `src/session.ts`, `src/server.ts`, `src/runSubagent.ts`, and `src/transcript.ts`.
- Existing test expectations in `tests/failure-log.test.ts`.
- Direct Zod check showing `z.object({ ... }).safeParse({ unknown_key })` succeeds and strips unknown keys by default.
- One independent subagent review artifact at `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-10T202833647Z-4f7813b02c54.md`; I overrode it where local verification found a stronger objection.

## Verdict Table

| Selected SAF | Classification | Short Verdict |
| --- | --- | --- |
| SAF1: Required packet success requires valid packet, `verdict === "ready"`, and empty `blockers`. | **True SAF**, scoped | It directly fixes the observed semantic contradiction with the smallest predicate-level change, assuming the product intends success to mean claimed handoff readiness, not independently verified truth. |
| SAF2: Split public MCP schema so `run_subagent` omits `timeout_ms`, while keeping a defensive handler guard. | **Asymptotic SAF** | It fixes the displayed affordance but is incomplete as written because Zod strips unknown keys by default; the handler guard may never see forbidden `timeout_ms`. |
| SAF3: Set `partial_output_available` from useful public assistant/error content, not bytes. | **Asymptotic SAF** | It moves in the right direction, but "useful" is not atomic. The true invariant should be exact public child-generated content availability. |
| SAF4: Defer runtime config-repair change; maybe add future config health. | **Pseudo-SAF** | It is not a fix. It has no invariant, no committed delta, and no verification path. |

## SAF1 Stress Test

### Proposal Under Test

For `packet_policy: required`, treat a session run as successful only when:

- packet parse status is `valid`
- packet verdict is `ready`
- packet blockers array is empty

### Red-Team Attack

The fix could still accept a self-authored `ready` packet whose claims are false. `src/packet.ts` explicitly frames packets as model-authored claimed handoff packets, not authoritative evidence. A malicious or sloppy child can produce `verdict: "ready"` with empty blockers while omitting real problems.

The fix also keeps `success` as a compound boolean over process success, session establishment, and packet satisfaction. That means it does not implement the transframe ideal of independently exposed outcome dimensions.

### Blue-Team Defense

The observed HORC was narrower: a packet that explicitly said `inconclusive` with blockers was still treated as successful because `src/session.ts` only checked parse validity. The smallest complete repair for that contradiction is a stricter packet satisfaction predicate over fields already present in the packet.

The result still exposes `exit_code`, `timed_out`, `session_established`, `packet_parse_status`, and `claimed_packet`, so the boolean does not fully hide the underlying dimensions. Requiring independent evidence verification would be a different product contract, not a smaller fix to this HORC.

### Classification

**True SAF, scoped.**

It is true for the HORC "required packet success ignores semantic packet readiness." It is not a truth-verification system, but that broader guarantee was outside the existing contract. The irreducible core is:

```ts
requiredSatisfied =
  packetParseStatus === "valid" &&
  claimedPacket?.verdict === "ready" &&
  claimedPacket.blockers.length === 0;
```

### Guardrail

The implementation should define the semantics in README/tests: required packet means "the child claims ready handoff and reports no blockers", not "the server independently proves the work is ready."

## SAF2 Stress Test

### Proposal Under Test

Split public schemas so `run_subagent` no longer advertises `timeout_ms`, but keep the existing defensive guard in `runSubagent`.

### Red-Team Attack

This is incomplete as written. The server currently passes raw Zod shapes to `server.registerTool` in `src/server.ts`; the SDK normalizes them to Zod objects. Zod object parsing strips unknown keys by default:

```text
z.object({ prompt, cwd }).safeParse({ prompt, cwd, timeout_ms: 1000 })
=> success, data excludes timeout_ms
```

Therefore, if `timeout_ms` is simply omitted from `run_subagent`'s public input schema, a client that still sends `timeout_ms` may get a successful call where the field is silently ignored. The existing guard in `src/runSubagent.ts` only works if the forbidden key survives validation.

Existing tests also assert the stronger behavior: `tests/failure-log.test.ts` expects `run_subagent` with `timeout_ms` to return `isError: true` at the MCP schema boundary.

### Blue-Team Defense

The proposal correctly identifies the public-schema leak. A generated tool surface should not show `timeout_ms` as `{ "not": {} }`. Removing the impossible property is necessary.

The problem is not the direction; it is missing one condition: preserving rejection of unknown forbidden fields.

### Classification

**Asymptotic SAF.**

It approaches the true fix but is not complete or irreducible. It removes the misleading affordance while risking a silent-ignore behavior unless strict argument validation is added.

### True-SAF Revision

The true SAF is:

- Public `run_subagent` schema omits `timeout_ms`.
- The `run_subagent` argument object is strict or otherwise rejects unknown keys.
- A regression test proves both:
  - `listTools().run_subagent.inputSchema.properties.timeout_ms` is absent.
  - calling `run_subagent` with `timeout_ms` returns `isError: true`.

In implementation terms, the fix must solve both public affordance and rejection semantics. One without the other is not sufficient.

## SAF3 Stress Test

### Proposal Under Test

Set `partial_output_available` only when the public artifact contains useful child-generated assistant content or error/warning content, not merely any bytes.

### Red-Team Attack

"Useful" is not atomic. A classifier cannot truly know whether assistant text is useful to the caller. Assistant text may be generic, truncated, or an echo. An operational warning may be relevant to debugging but not a partial task answer. The proposed metadata list also risks growing into a second transcript semantics layer if "useful" keeps expanding.

The root problem is not just bytes vs usefulness; it is that the field name promises availability of partial child work while the implementation can count caller text and markers. The irreducible property is child-generated public content, not usefulness.

### Blue-Team Defense

The current implementation in `src/runSubagent.ts` is clearly wrong:

```ts
partialOutputAvailable = processResult.timedOut && output.sizeBytes > 0;
```

`src/transcript.ts` already distinguishes public user messages, assistant messages, warnings, errors, timeout markers, and cancellation markers. Returning content-kind metadata from that pass is a direct, low-motion correction.

### Classification

**Asymptotic SAF.**

It is close, but the selected SAF uses a fuzzy criterion. It becomes true only if the invariant is narrowed from "useful content" to "public child-generated content exists."

### True-SAF Revision

The true SAF is:

- Rename or define the field semantically as `partial_public_child_output_available`.
- Compute it from exact transcript roles/kinds:
  - true for public assistant text
  - true for public `subagent007.error` or `subagent007.warning`
  - false for user-only content
  - false for timeout/cancel markers alone
- Preserve the existing `partial_output_available` name only if README documents that exact meaning.

That removes subjectivity while preserving the intended user-facing guarantee: there is something generated by the child process that may help recovery.

## SAF4 Stress Test

### Proposal Under Test

Defer a runtime config-repair change for stale default model aliases; maybe add future config health.

### Red-Team Attack

This is not a fix. It does not change runtime behavior, persisted config, documentation, tests, or operational workflows. It has no atomic invariant and no failure it can prevent.

The observation is real: `list_allowed_models` reports `default_model_repaired: true` when config contains `openrouter/anthropic/claude-sonnet-4.5` and the server resolves it to `openrouter/~anthropic/claude-sonnet-latest`. But "defer unless repeated support issue" is a prioritization decision, not a SAF.

### Blue-Team Defense

Deferral may be strategically correct because the issue is not currently breaking execution. Avoiding silent config rewrites is prudent.

But strategic deferral should be labeled as non-intervention, not as a fix.

### Classification

**Pseudo-SAF.**

It is an operational note dressed as a SAF. It should be removed from the final SAF set or reframed as a backlog item.

### True-SAF Revision If This Becomes Worth Fixing

A true SAF would be one of:

- Add an explicit `config_status`/`repair_command` field to `list_allowed_models` and document the exact replacement.
- Add a `config:doctor` or `config:migrate` script that rewrites known stale aliases with user-invoked intent.

Those have an invariant and validation path. Deferral does not.

## Revised Final SAF Set

Proceed with three implementation tracks, but amend two of them before coding:

1. **SAF1 remains selected as true.**
   - Implement semantic required-packet satisfaction.
   - Explicitly document that this gates on claimed readiness, not independent proof.

2. **SAF2 must be upgraded before implementation.**
   - Omit `timeout_ms` from the displayed `run_subagent` schema.
   - Also reject unknown `timeout_ms` calls, using strict object parsing or equivalent raw-argument validation.

3. **SAF3 must be reframed before implementation.**
   - Replace "useful content" with exact "public child-generated content".
   - Decide whether to keep the old field name with documentation or introduce a clearer field name.

4. **SAF4 should be removed from the SAF set.**
   - Keep it as a backlog/config-health note only.

## Decision Signal

**Go with Conditions.**

The implementation plan is repairable and still directionally sound, but only SAF1 qualifies as a true SAF exactly as selected. SAF2 and SAF3 need sharper invariants before coding; SAF4 should not be implemented as part of the final SAF set.
