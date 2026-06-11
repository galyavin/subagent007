# Live E2E Coherent Revised SAF Set - 2026-06-10

Status: implemented superseding SAF decision record for the live E2E campaign. This document repairs the selected SAF set from `reports/live-e2e-skill-campaign-2026-06-10.md` using the adversarial classifications in `reports/live-e2e-saf-adversarial-stress-test-2026-06-10.md`.

No runtime code changes were made while writing this document. The selected repairs were implemented afterward in the current worktree.

## Repair Rule Applied

The stress test showed that the prior set mixed three different things:

- true root repairs,
- scoped local/operational repairs,
- useful guardrails that should not be called SAFs for broad architectural HORCs.

This revised set keeps a fix in the SAF set only when the HORC is stated at the exact level the fix actually eliminates. If the broader HORC remains, it is listed as a residual/transframe backlog item instead of being hidden inside an overclaimed SAF.

Classification terms:

- **True SAF**: smallest sufficient change that eliminates the stated HORC.
- **Scoped True SAF**: true for the explicitly narrowed frame; not claimed as a general architectural repair.
- **Supporting guardrail**: useful implementation detail, not a root fix.
- **Deferred transframe repair**: a broader frame change that would solve more but costs more motion than current evidence justifies.

## Final Set Summary

| ID | Revised HORC | Final SAF | Classification | Priority |
| --- | --- | --- | --- | --- |
| SAF-1 | Packet producer and packet parser are governed by non-isomorphic contracts. | Make the model-facing packet instruction schema-isomorphic with the parser contract. | **True SAF** | P1 |
| SAF-2 | This installation's persisted default model is stale while runtime uses a repaired canonical model. | Execute the existing explicit config migration and verify persisted config becomes canonical. | **Scoped True SAF** | P1 |
| SAF-3 | During long async runs, `get_run` cannot prove the task is still alive or waiting productively. | Add persisted active-run liveness/progress metadata derived from server heartbeat and mailbox state. | **Scoped True SAF** | P2 |
| SAF-4 | A one-shot timeout is a dead-end failure unless the result itself routes the caller to the async surface. | Add structured one-shot timeout recovery guidance. | **Scoped True SAF** | P3 |
| SAF-5 | Campaign reports can confuse harness-scoped evidence with installed-server production evidence. | Make campaign evidence classification explicit: only harness-launched server data is campaign telemetry. | **Scoped True SAF** | P3 |

## SAF-1: Packet Contract Single Authority

### Revised HORC

`appendContractPacketInstruction()` and `extractContractPacket()` currently expose two different packet contracts. The model sees field names for optional `closure`, but the parser enforces hidden structural requirements for those fields.

### Final SAF

Make the model-facing `contract_packet_v1` instruction schema-isomorphic with the parser's accepted packet shape.

Required implementation:

1. Include a complete valid packet example that shows optional `closure` with:
   - `canonical_closure_source` as a string,
   - `artifact_roles` as an array of `{ "path": "...", "role": "..." }`,
   - `validation` as an array of strings,
   - `claim_ceiling` as a string.
2. Keep malformed closure values invalid; do not loosen the parser to match bad model output.
3. Add regression coverage for:
   - required packet with valid closure succeeds,
   - required packet with malformed closure fails,
   - required packet without closure still succeeds when ready and unblocked.

### Intraframe Candidate

Update `src/packet.ts` so the appended instruction is generated from, or colocated with, the canonical packet example used by tests.

### Transframe Candidate

Replace fenced JSON packets with a structured-output/tool-call channel.

### Selected Candidate

Intraframe. The observed defect is not arbitrary JSON unreliability; it is the server giving the child an incomplete shape and enforcing a stricter one.

### Classification

**True SAF.**

This directly removes the malformed primitive: the child and parser now share one packet contract.

### Pseudo-SAFs Rejected

- Tell callers to omit `closure`.
- Add vague prose like "use arrays where appropriate."
- Accept both object and array shapes for `artifact_roles`.

## SAF-2: Current Config Canonicalization

### Revised HORC

This installation's persisted config contains a known stale alias:

```json
{"default_model":"openrouter/anthropic/claude-sonnet-4.5","default_thinking_level":"medium"}
```

Runtime repair canonicalizes it to `openrouter/~anthropic/claude-sonnet-latest`, so the persisted source of truth and effective runtime behavior disagree.

### Final SAF

Run the existing explicit migration boundary and verify the persisted config becomes canonical.

Required implementation:

1. Run `npm run config:migrate` from `/Users/rgalyavin/myApps/003-subagent007-pi`.
2. Confirm the config file now stores `openrouter/~anthropic/claude-sonnet-latest`.
3. Confirm live `list_allowed_models` reports:
   - `default_model_repaired:false`,
   - `config_migration:null`.

### Intraframe Candidate

Use the existing `scripts/migrate-config.mjs`, which resolves known allowed aliases, writes atomically, preserves unknown fields, and refuses unknown models.

### Transframe Candidate

Add versioned config migrations or an authenticated MCP/admin config-repair action.

### Selected Candidate

Intraframe, because the needed repair path already exists and the observed defect is a single stale persisted value in this installation.

### Classification

**Scoped True SAF.**

It is true for the revised HORC: this installation's persisted default model is stale. It is not claimed as a full product SAF for all future config authority drift. The broader transframe repair remains deferred until stale config recurrence justifies more system motion.

### Pseudo-SAFs Rejected

- Ignore the warning because runtime repair works.
- Silently mutate config during `list_allowed_models`.
- Remove runtime alias repair before the persisted config is canonical.

## SAF-3: Active Async Liveness State

### Revised HORC

For long `start_run` executions, `get_run` can remain `working` for long periods without exposing whether the MCP server is still actively supervising the child, whether the run is waiting on caller input, or when the last progress observation happened.

This revised HORC is intentionally narrower than "the server lacks full live child-event state." Full event projection is useful but not required to eliminate the observed liveness ambiguity.

### Final SAF

Persist minimal active-run liveness/progress metadata in task snapshots.

Required fields:

- `elapsed_ms`
- `last_progress_at`
- `last_progress_message`
- `heartbeat_count`

Allowed message sources:

- server heartbeat,
- pending-input summary,
- cancellation requested,
- terminal transition.

Non-goals:

- no raw child transcript streaming,
- no unredacted stdout/stderr persistence,
- no promise that the model is semantically making progress.

### Intraframe Candidate

Add an internal progress callback from `runChildProcess`/`runSubagent` into `runTask` state, and include the resulting metadata in `get_run` snapshots.

### Transframe Candidate

Add a sanitized active child-event ledger derived from the same parser/redaction boundary as final transcripts.

### Selected Candidate

Intraframe, because the observed issue was "is this run alive?" rather than "show me every safe child event before completion."

### Classification

**Scoped True SAF.**

It fully fixes the revised liveness HORC: `get_run` no longer has to represent long active supervision as a contentless `working` state. It remains asymptotic for the broader child-event observability HORC, which is explicitly deferred.

### Pseudo-SAFs Rejected

- Tell users to wait.
- Lower the heartbeat interval only.
- Persist raw live process chunks.

## SAF-4: One-Shot Timeout Self-Routing

### Revised HORC

When `run_subagent` times out, the failure result does not itself give the caller a concrete recovery route, even though the correct route is known: use `start_run` for broad, exploratory, long-running, cancellable, polling, or caller-input work.

This revised HORC is intentionally narrower than "the server can perfectly classify workload before execution." That broader problem would require removing the public one-shot tool or adding a scheduler/preflight classifier.

### Final SAF

Add structured timeout recovery guidance to `run_subagent` timeout results.

Required implementation:

1. Add `timeout_recovery_hint` to `RunSubagentResult` when:
   - tool is public `run_subagent`,
   - `timed_out:true`.
2. Include a concise public transcript marker or result text equivalent:
   - "Use `start_run` with explicit `timeout_ms` for broad, exploratory, interactive, cancellable, polling, or long-running work."
3. Do not add caller-supplied `timeout_ms` to `run_subagent`.
4. Do not weaken the required `run_kind:"quick_noninteractive"` contract.

### Intraframe Candidate

Add the recovery hint at result construction and include it in timeout transcript metadata for the one-shot public tool only.

### Transframe Candidate

Remove public `run_subagent` and expose only async delegation plus named sessions.

### Selected Candidate

Intraframe, because current evidence supports fixing the dead-end timeout experience, not removing the one-shot surface.

### Classification

**Scoped True SAF.**

It fully fixes the revised HORC: a one-shot timeout no longer leaves the caller without the correct next action. It remains asymptotic for pre-execution workload classification, which is not selected for repair now.

### Pseudo-SAFs Rejected

- Increase the one-shot default timeout.
- Reintroduce caller `timeout_ms` to `run_subagent`.
- Treat user-prompt-only timeout artifacts as useful partial output.

## SAF-5: Campaign Evidence Boundary

### Revised HORC

Observed-use reports can become incoherent when they treat installed-server production-state probes and harness-launched campaign-state probes as the same evidence class.

This revised HORC is narrower than "the MCP server has no request-scoped campaign attribution." Request-scoped attribution is a broader transframe repair and is not justified by current evidence.

### Final SAF

Make the evidence boundary explicit:

- only probes executed through `scripts/run-observed-campaign.mjs` against a server launched under campaign env count as clean campaign telemetry,
- installed live MCP probes count as production-state live evidence,
- reports must record which class each observation belongs to.

Required implementation:

1. Update campaign reporting conventions/templates to require:
   - `campaign_id`,
   - `state_root`,
   - `failure_log_path`,
   - evidence class: `campaign-scoped` or `installed-production`.
2. Do not post-hoc relabel production records as campaign records.
3. Use the observed-campaign harness for future SDK/scripted protocol probes.

### Intraframe Candidate

Document and enforce the evidence boundary in observed-trial reports and harness usage.

### Transframe Candidate

Add authenticated request-scoped campaign metadata to public tool calls or MCP request metadata.

### Selected Candidate

Intraframe. It eliminates the reporting incoherence with little system motion; the broader request-scoped attribution repair is deferred.

### Classification

**Scoped True SAF.**

It is true for the revised reporting HORC. It is not a product architecture SAF for request-scoped campaign attribution.

### Pseudo-SAFs Rejected

- Pretend installed-server calls are campaign-scoped because the client process has a campaign ID.
- Post-hoc edit production failure records.
- Omit the limitation from the report.

## Supporting Guardrails

These are useful, but they are not SAFs under the broader HORCs.

| Guardrail | Supports | Why Not A SAF |
| --- | --- | --- |
| Keep runtime model alias repair. | SAF-2 | Compatibility fallback, not persisted canonical state. |
| Keep `run_kind:"quick_noninteractive"`. | SAF-4 | It forces caller declaration, but cannot prove the prompt is actually quick. |
| Keep `partial_output_available` strict. | SAF-4 | Prevents false usefulness claims, but does not route workload. |
| Keep campaign IDs in failure records. | SAF-5 | Helps filtering, but does not isolate state by itself. |
| Consider full active child-event ledger later. | SAF-3 | Stronger observability, but more system motion than liveness requires. |

## Deferred Transframe Repairs

These would solve broader architectural HORCs but are not selected now.

1. **Structured packet output channel**
   - Replaces fenced JSON packets with schema-validated structured output/tool calls.
   - Deferred because schema-isomorphic instructions solve the observed defect with far less motion.

2. **Versioned config migration framework**
   - Adds startup/admin config migration semantics for all future drift.
   - Deferred until stale config recurrence exceeds the cost of a one-command explicit migration boundary.

3. **Sanitized active event ledger**
   - Exposes safe live child events through `get_run`.
   - Deferred because liveness metadata addresses the current observed pain.

4. **Async-only public delegation**
   - Removes `run_subagent` as a public MCP tool.
   - Deferred because one-shot exact-output work is healthy and useful.

5. **Request-scoped campaign attribution**
   - Makes campaign state a first-class request/session dimension.
   - Deferred because harness-scoped evidence boundaries are sufficient for current campaigns.

## Coherent Implementation Order

1. **SAF-1 Packet Contract Single Authority**
   - Highest-value true product SAF.
   - Add tests first, then update `src/packet.ts`.

2. **SAF-2 Current Config Canonicalization**
   - Operationally simple and removes live health noise.
   - Run migration and verify with `list_allowed_models`.

3. **SAF-3 Active Async Liveness State**
   - Improves interactive skill-run ergonomics without exposing raw transcript.
   - Add task snapshot tests before implementation.

4. **SAF-4 One-Shot Timeout Self-Routing**
   - Cheap ergonomic repair after timeout.
   - Keep it scoped; do not weaken the one-shot contract.

5. **SAF-5 Campaign Evidence Boundary**
   - Reporting/process repair.
   - Add template/reporting convention; continue using observed-campaign harness for SDK probes.

## Acceptance Gate

The revised set is complete when:

- required packets with valid closure pass and malformed closure fails,
- current config no longer reports `default_model_repaired:true`,
- active `get_run` responses expose liveness/progress metadata before input or terminal completion,
- `run_subagent` timeout results include recovery guidance to `start_run`,
- future observed-use reports label evidence as campaign-scoped or installed-production.

## Final Classification

| ID | Final Classification | Scope Honesty |
| --- | --- | --- |
| SAF-1 | **True SAF** | Product root fix for packet contract mismatch. |
| SAF-2 | **Scoped True SAF** | True for current installed config; broader config migration framework deferred. |
| SAF-3 | **Scoped True SAF** | True for async liveness ambiguity; broader live event observability deferred. |
| SAF-4 | **Scoped True SAF** | True for dead-end timeout recovery; pre-execution workload classification deferred. |
| SAF-5 | **Scoped True SAF** | True for reporting/evidence-class coherence; request-scoped campaign architecture deferred. |
