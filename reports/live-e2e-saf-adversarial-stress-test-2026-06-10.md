# Live E2E SAF Adversarial Stress Test - 2026-06-10

Status: adversarial review of the selected SAFs in `reports/live-e2e-skill-campaign-2026-06-10.md`. No runtime code changes were made while this report was written.

Method: balanced `red-blue-review`, codebase-only research. Classifications use:

- **True SAF**: smallest sufficient change that eliminates the fundamental cause for the stated HORC without losing completeness.
- **Asymptotic SAF**: useful and directionally correct, but incomplete, indirect, overbroad, or not perfectly irreducible.
- **Pseudo-SAF**: appears minimal but mainly treats symptoms or hides complexity elsewhere.

## Verdict

Rework before implementing the full set as "SAFs".

Only **SAF-1** qualifies as a True SAF under adversarial review. **SAF-2 through SAF-5** are useful interventions, but their current selected forms are asymptotic because they either fix one observed instance, add partial observability, recover after failure, or impose operational discipline without eliminating the named architectural cause.

No selected item is pure pseudo-SAF if represented honestly. The risk is labeling operational containments as root fixes.

## Summary Table

| SAF | Selected Intervention | Classification | Short Verdict |
| --- | --- | --- | --- |
| SAF-1 | Make packet instruction schema-isomorphic with parser. | **True SAF**, if implemented as exact packet shape, not vague prose. | Directly eliminates the two-authority mismatch that caused valid-intent packets to fail. |
| SAF-2 | Run existing config migration for current stale default model. | **Asymptotic SAF** | Fully fixes this installation's stale config, but does not eliminate the general split between runtime canonicalization and persisted config authority. |
| SAF-3 | Add heartbeat-backed active-run progress metadata to `get_run`. | **Asymptotic SAF** | Improves "is it alive?" visibility, but does not fully fix the terminal-oriented state model or expose meaningful child progress. |
| SAF-4 | Add timeout recovery hint for `run_subagent` failures. | **Asymptotic SAF** | Helps users recover after misrouting broad work, but does not prevent or detect the misclassification before spending the failed run. |
| SAF-5 | Use campaign harness for clean campaign runs; record installed-server probes separately. | **Asymptotic SAF** | Honest operational containment, but not a system fix for process-scoped rather than request-scoped campaign attribution. |

## SAF-1: Packet Instruction/Schema Isomorphism

### Selected SAF

Update `appendContractPacketInstruction()` so the model-facing `contract_packet_v1` instruction exactly matches `packetSchema`, especially optional `closure.artifact_roles` and `closure.validation`.

### Red-Team Stress Test

The weakest version of this fix is just adding another prose sentence: "closure fields must be arrays." That is not enough. Models routinely follow examples more reliably than prose, and future schema edits could reintroduce drift if the instruction is manually maintained.

The transframe alternative, structured output/tool-call packet emission, would be stronger against malformed JSON generally. But the observed HORC was not "models can ever emit invalid JSON"; it was "the server told the model an incomplete shape and then enforced a stricter one."

### Blue-Team Defense

The parser already accepts the desired closure shape. The packet artifact format is useful and already integrated with sessions, attempts, ledgers, and tests. A complete example or schema-derived instruction changes the malformed primitive itself: the child receives the same contract that the parser enforces.

### Classification

**True SAF**, with one precision requirement.

The atomic fix must be "schema-isomorphic instruction", not "better wording." Best implementation:

- Show one complete packet example including a valid optional `closure` object, or generate the example from a canonical template colocated with the schema.
- Add tests for valid closure success and malformed closure failure.

Tests are verification, not the atomic fix. The atomic fix is making the contract seen by the child equivalent to the contract enforced by the parser.

### Pseudo-SAFs Rejected

- Tell callers to omit closure.
- Loosen parser types to accept whatever shape the model emits.
- Keep vague optional-field prose and blame the model for invalid packets.

## SAF-2: Apply Current Config Migration

### Selected SAF

Run `npm run config:migrate` so `/Users/rgalyavin/.codex/subagent007-pi/config.json` stores `openrouter/~anthropic/claude-sonnet-latest` instead of the stale alias `openrouter/anthropic/claude-sonnet-4.5`.

### Red-Team Stress Test

This is only a true fix for the local snapshot. The named HORC is broader: runtime canonicalization and persisted config are separate authorities. A one-time migration does not prevent future manual stale edits, future alias drift, or another install from repeatedly depending on runtime repair.

The code already has a real migration command, and it handles `--help`, invalid JSON, missing config, unknown models, and atomic writes. But executing it once is operational repair, not architectural repair.

### Blue-Team Defense

The observed defect was a specific stale persisted config on this machine. The smallest complete intervention for that actual state is to run the already-existing migration. Adding auto-migration or request-scoped repair would create much more system motion and could mutate user config during otherwise read-only operations.

### Classification

**Asymptotic SAF** for the HORC as named.

It is a **true local remediation** for this installation, but not a True SAF for "runtime canonicalization is not applied at the persisted config boundary." To make it a True SAF for that broader HORC, the system needs a canonical config write boundary, such as:

- a required setup/doctor step that fails health until config is canonical, or
- an explicit MCP/admin repair action that compares and rewrites config, or
- startup-time migration with clear opt-in semantics.

### Pseudo-SAFs Rejected

- Ignore the warning because runtime repair works.
- Remove runtime repair before migration is complete.
- Silently rewrite config during `list_allowed_models`.

## SAF-3: Active-Run Progress Metadata

### Selected SAF

Extend `get_run` snapshots with lightweight progress fields such as `last_progress_at`, `last_progress_message`, and `elapsed_ms`, backed by heartbeat or pending-input summaries.

### Red-Team Stress Test

This does not actually expose child progress. It can say "the server heartbeat fired" or "no input is pending", but it cannot distinguish:

- the child model is thinking productively,
- a tool call is stalled,
- stdout has useful public events buffered but not yet written,
- the process is alive but semantically stuck.

The fundamental state model remains terminal-oriented: child output is buffered until completion, and live progress notifications are side-channel best effort. Heartbeat-backed fields reduce anxiety but do not eliminate the root cause if the root is "active run state lacks meaningful child event state."

### Blue-Team Defense

The selected fix intentionally avoids streaming raw transcript chunks into task snapshots, preserving redaction and prompt-safety boundaries. The observed problem was not "I need a full live transcript"; it was "I cannot tell whether this long interactive run is alive before input or completion." Heartbeat metadata plus elapsed time and pending-input summaries would answer that narrower operational question with minimal blast radius.

### Classification

**Asymptotic SAF**.

It is valuable and likely worth doing, but it is not irreducible root repair. It repairs the most visible symptom of terminal-oriented state while leaving the deeper primitive intact. A True SAF for the broader HORC would add a sanitized active event/progress ledger derived from the same event stream used for final transcript redaction, not just heartbeat state.

### Pseudo-SAFs Rejected

- Tell users to wait longer.
- Reduce heartbeat interval only.
- Persist raw live child output without redaction.

## SAF-4: `run_subagent` Timeout Recovery Hint

### Selected SAF

On `run_subagent` timeout, add a structured recovery hint telling callers to use `start_run` with explicit `timeout_ms` for broad, exploratory, interactive, or long work.

### Red-Team Stress Test

This is downstream of the failure. It does not prevent a broad prompt from being sent to `run_subagent`, does not detect complexity before execution, and does not recover the lost wall-clock time. The HORC says workload class is caller-promised rather than server-assisted; a hint only assists after the promise has already failed.

Increasing the default timeout would be worse because it weakens the one-shot contract. Adding caller `timeout_ms` back to `run_subagent` would undo a repaired public contract.

### Blue-Team Defense

The server should not pretend it can reliably classify arbitrary prompt complexity. Preflight classification would either be heuristic and leaky or require another model call. The selected hint makes the failure path self-correcting while preserving the clean division: `run_subagent` for quick noninteractive work, `start_run` for long or interactive work.

### Classification

**Asymptotic SAF**.

It is a good ergonomic improvement, but not a root fix for caller-side workload classification. A True SAF would move the classification boundary before execution, for example by removing the public one-shot tool, adding a scheduler/router, or adding an explicit preflight classifier. Those options have much higher system motion and may not be justified.

### Pseudo-SAFs Rejected

- Increase one-shot timeout.
- Reintroduce caller timeout on `run_subagent`.
- Mark user-prompt-only timeout artifacts as useful partial output.

## SAF-5: Campaign Discipline For Process-Scoped State

### Selected SAF

For observed campaigns, launch a fresh MCP server under `scripts/run-observed-campaign.mjs`; treat already-running installed MCP probes as production-state evidence and record them separately.

### Red-Team Stress Test

This does not fix the architecture. Campaign state remains process-scoped. An already-running installed server still cannot receive request-scoped campaign metadata. The fix depends on operator discipline and reporting hygiene, so it can fail silently if someone forgets to use the harness.

If the HORC is "campaign scope is process-scoped, not request-scoped," this selected intervention accepts the frame instead of changing it.

### Blue-Team Defense

The harness already provides clean state isolation for controlled protocol probes. Adding campaign fields to every public tool input or relying on MCP request metadata would expand the public API and introduce trust/abuse questions. For current observed-use campaigns, process-scoped campaign servers are an honest and low-motion containment.

### Classification

**Asymptotic SAF**.

It is a valid operational containment, not a True SAF for the architectural HORC. A True SAF would create authenticated request-scoped campaign attribution or a first-class campaign server/session primitive that cannot be confused with production state.

### Pseudo-SAFs Rejected

- Post-hoc relabel production records as campaign records.
- Pretend installed-server calls are campaign-scoped because the client process has a campaign ID.
- Hide the limitation from reports.

## Revised Final SAF Set

1. **Keep SAF-1 as True SAF.**
   - Implement schema-isomorphic packet instructions.
   - Verify valid closure packets succeed and malformed closure packets fail.

2. **Downgrade SAF-2 to operational remediation unless the scope is explicitly "this installation only."**
   - Run `npm run config:migrate` as a local cleanup.
   - Do not claim it fixes the architectural boundary unless paired with a canonical config write/repair boundary.

3. **Reframe SAF-3 as observability improvement, not root repair.**
   - Implement heartbeat/progress metadata if useful.
   - Do not call it a True SAF unless it adds sanitized active child-event state.

4. **Reframe SAF-4 as recovery guidance, not workload-classification repair.**
   - Implement it because it is cheap and helpful.
   - Do not claim it eliminates misrouting.

5. **Reframe SAF-5 as campaign operating procedure, not system SAF.**
   - Continue using the harness for clean campaigns.
   - Consider request-scoped campaign attribution only if mixed production/campaign evidence remains a repeated problem.

## Implementation Implication

The immediate code implementation should prioritize **SAF-1**. The other four should be tracked as useful improvements or operational tasks, but not as fundamental repairs unless their HORCs are narrowed:

- SAF-2 becomes True only for "this config file contains one stale alias."
- SAF-3 becomes True only for "show the caller that the async task is alive."
- SAF-4 becomes True only for "give recovery guidance after one-shot timeout."
- SAF-5 becomes True only for "produce a clean campaign when using a campaign-launched server."

Under the broader HORCs written in the campaign report, those four remain asymptotic.

