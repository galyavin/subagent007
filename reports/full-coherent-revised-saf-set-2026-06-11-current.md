# Full Coherent Revised SAF Set - Subagent007 MCP - 2026-06-11 Current Campaign

Source artifacts:

- `reports/observed-real-use-trials-2026-06-11-current.md`
- `reports/current-saf-adversarial-stress-test-2026-06-11.md`

Purpose: repair the selected SAF set after adversarial classification. This is a decision record, not an implementation report.

Status: implemented in the current worktree after this decision record. The implemented changes add deterministic probe evidence modes, active sanitized `get_run` events, a one-shot incompatibility gate, and durable task/lease-backed named-session execution.

## Repair Rule Applied

A fix remains in the SAF set only when the HORC is stated at the exact level the fix eliminates.

If the previous HORC was broader than the selected fix, this document either:

1. narrows the HORC to the malformed primitive the fix actually removes, or
2. replaces the fix with the smallest complete correction that removes the broader HORC.

Useful but incomplete guardrails are moved to residual backlog or supporting work. They are not labeled as SAFs.

## Final Set Summary

| ID | Revised HORC | Final SAF | Classification | Priority |
| --- | --- | --- | --- | --- |
| R-SAF-1 | `get_run` active views lack a bounded, redacted projection of public child/run events before terminal state. | Add a single sanitized active-event projection to run-task snapshots: bounded `recent_events` plus `last_public_output_excerpt`. | **True SAF** for the narrowed HORC | P1 |
| R-SAF-2 | `run_subagent` accepts known one-shot-incompatible request shapes before child spawn. | Add a pre-spawn one-shot incompatibility gate with explicit predicates and `start_run` recovery guidance. | **True SAF** for the narrowed HORC | P1 |
| R-SAF-3 | Observed protocol probes use live model compliance as evidence for server protocol behavior. | Split probe modes into deterministic protocol probes using `SUBAGENT007_PI_CHILD_PATH` plus separate live-model smoke probes, with registry-enforced evidence classes. | **True SAF** | P1 |
| R-SAF-4 | Named session execution is synchronously coupled to the MCP request lifetime, so lock ownership is not durable/pollable when clients abandon a request. | Move named session runs onto the durable run-task lifecycle, with session locks owned by a durable task/lease rather than the synchronous handler. | **True SAF** for the product HORC | P2 |

## R-SAF-1 - Bounded Active Event Projection

### Revised HORC

`get_run` active views lack a bounded, redacted projection of public child/run events before terminal state.

This narrows the overbroad previous HORC, "active runs are modeled as lifecycle snapshots, not event streams." A full event-sourced run ledger is a valid future architecture, but the observed defect only requires active callers to see safe, current, public evidence while a run is still executing.

### Final SAF

Add a single sanitized active-event projection to run-task snapshots:

- `recent_events`: bounded list of redacted public run events.
- `last_public_output_excerpt`: bounded public excerpt derived from the same sanitized event ingest path.

Minimum required behavior:

1. Introduce one active-event sanitizer/normalizer shared by the final transcript renderer and active projection.
2. Populate `recent_events` from public child events, heartbeat/progress events, input-request transitions, timeout, cancellation, and terminal transitions.
3. Bound event count and text length so snapshots remain small.
4. Exclude raw thinking, raw stderr secrets, internal Pi control payloads, and unsanitized prompt material.
5. Preserve current lifecycle fields (`status`, `elapsed_ms`, `heartbeat_count`, `input_requests`) for compatibility.

### Intraframe Candidate

Add bounded `recent_events` and `last_public_output_excerpt` fields to existing run-task snapshots.

### Transframe Candidate

Replace run-task snapshots with a full event-sourced run ledger and make `get_run` a projection over the ledger.

### Selected Candidate

Intraframe, with a single shared sanitizer boundary.

The transframe event ledger is cleaner long-term, but it is larger than required for the narrowed HORC. The narrowed defect is not "the system lacks perfect event sourcing"; it is "active `get_run` has no safe public evidence before terminal state."

### Classification

**True SAF for the revised HORC.**

It adds the missing active-view primitive exactly where callers observe the defect, without pretending to solve complete historical event sourcing.

### Pseudo-SAFs Rejected

- Lower heartbeat interval while keeping `last_progress_message:"running"`.
- Add more final transcript metadata only.
- Persist raw child stdout/stderr into `get_run`.
- Add a separate sanitizer for active events that can drift from final transcript redaction.

### Validation

Use deterministic fake-child scenarios to emit:

- public assistant text,
- public warning/error events,
- raw thinking/control events,
- timeout and cancellation markers.

Poll `get_run` before terminal state and verify:

- public events appear in `recent_events`,
- `last_public_output_excerpt` is bounded and sanitized,
- raw thinking/control events do not appear,
- terminal snapshots preserve the final state without late heartbeat overwrites.

### Residual Backlog

Full event-sourced run history remains useful for auditability, replay, and richer debugging. It is not required for this SAF and should be tracked separately.

## R-SAF-2 - One-Shot Incompatibility Gate

### Revised HORC

`run_subagent` accepts known one-shot-incompatible request shapes before child spawn.

This narrows the overbroad previous HORC, "one-shot suitability is a caller promise with late enforcement." Full workload-shape authority would require scheduler-owned routing. The current SAF only claims to eliminate acceptance of request shapes the server can already identify as incompatible with the one-shot surface.

### Final SAF

Add a pre-spawn one-shot incompatibility gate to `run_subagent`.

Minimum required behavior:

1. Define explicit incompatibility predicates in code, not only prose. Initial predicates should include:
   - `skill_name` or legacy `skill` present unless explicitly allowlisted for one-shot use,
   - prompt starts with or contains skill invocation syntax,
   - prompt contains high-confidence broad-work markers such as repository-wide audit/review/synthesis/campaign/HORC/SAF planning requests,
   - prompt length above a conservative configured maximum for one-shot,
   - tool profile plus prompt combination that implies shell/write-heavy or long-running behavior.
2. Reject incompatible requests before child request-file creation.
3. Return structured guidance pointing to `start_run`, including when an explicit `timeout_ms` should be used.
4. Keep terse exact-output and simple inspection prompts accepted.
5. Make predicates observable in tests so the guard does not become undocumented model-routing folklore.

### Intraframe Candidate

Add a conservative pre-spawn guard to the existing `run_subagent` validation path.

### Transframe Candidate

Replace caller-selected `run_subagent`/`start_run` routing with scheduler-owned workload planning and execution-mode selection.

### Selected Candidate

Intraframe, scoped to known incompatible shapes.

The transframe scheduler is the true repair for broad workload-shape authority, but it is not the smallest complete fix for the revised HORC. The revised HORC is about accepting request shapes the server already has enough information to reject.

### Classification

**True SAF for the revised HORC.**

It eliminates the exact malformed rule: known incompatible one-shot request shapes can no longer pass through to child execution.

### Pseudo-SAFs Rejected

- Only add a timeout recovery hint after `run_subagent` times out.
- Raise the one-shot timeout.
- Re-add caller-provided `timeout_ms` to `run_subagent`.
- Depend on informal prompt-writing guidance without executable predicates.

### Validation

Run MCP schema/handler tests that verify:

- an obvious repo audit/HORC/SAF synthesis prompt rejects before child spawn,
- a skill-bound prompt rejects or requires async routing unless allowlisted,
- a long prompt over the configured limit rejects,
- a terse exact-output prompt still runs,
- no child request file is written for rejected requests.

### Residual Backlog

Full workload routing remains unresolved. A future scheduler SAF should model workload class as server-owned state using prompt shape, requested tools, model health, caller intent, and observed latency history.

## R-SAF-3 - Deterministic Protocol Probe Boundary

### Revised HORC

Observed protocol probes use live model compliance as evidence for server protocol behavior.

The current probe has a scenario registry and coverage summary, but child failure and packet scenarios are still prompt-driven unless the configured child behaves deterministically. This lets model behavior masquerade as server protocol evidence.

### Final SAF

Split observed probe modes into deterministic protocol probes and live-model smoke probes.

Minimum required behavior:

1. Add a `protocol-deterministic` probe mode that launches the server with `SUBAGENT007_PI_CHILD_PATH` pointing to a deterministic fake child.
2. Keep a separate `live-model` mode for installed Pi/model integration smoke tests.
3. Mark every scenario with an evidence class:
   - `protocol-deterministic`,
   - `live-model`,
   - `schema-only`,
   - or another explicit class if needed.
4. Prevent deterministic scenario results from being produced by live model prompts.
5. Report covered and uncovered surfaces per evidence class.

### Intraframe Candidate

Rename current `all-bundled`, keep prompt-based scenarios, and explain the limitation.

### Transframe Candidate

Make the child adapter boundary explicit in the probe system and separate deterministic protocol evidence from live provider evidence.

### Selected Candidate

Transframe at the harness boundary, using the already-supported `SUBAGENT007_PI_CHILD_PATH` adapter.

This is low system motion because the runtime already has the required child-path injection point, and tests already contain a deterministic fake child with failure, timeout, transcript, and packet branches.

### Classification

**True SAF.**

It removes the mixed evidence authority. Protocol assertions are proven by deterministic child behavior; live-model behavior is tested separately and cannot accidentally satisfy or falsify protocol claims.

### Pseudo-SAFs Rejected

- Tune the `FAIL_EXIT` prompt.
- Rename `all` without changing execution mode.
- Add more live prompts and call the resulting set deterministic.
- Hide uncovered surfaces by omitting coverage summaries.

### Validation

Run deterministic mode and verify:

- `child-failure` produces the fake child nonzero exit deterministically,
- packet-valid and packet-invalid cases produce known packet results,
- transcript-redaction cases include public text and exclude raw thinking,
- coverage summary labels evidence class as `protocol-deterministic`.

Run live-model mode separately and verify:

- it does not claim deterministic failure/packet coverage,
- it reports installed Pi/model integration as live evidence.

## R-SAF-4 - Durable Named-Session Run Lifecycle

### Revised HORC

Named session execution is synchronously coupled to the MCP request lifetime, so session lock ownership is not durable/pollable when clients abandon a request.

This keeps the product-level HORC from the stress test. The campaign-only timeout alignment was demoted because it only prevents or detects one harness symptom.

### Final SAF

Move named session runs onto the durable run-task lifecycle, with session locks owned by a durable task/lease rather than the synchronous MCP handler.

Minimum required behavior:

1. Add a durable named-session run task type, either by:
   - extending `start_run` with `session_key`, `resume_mode`, and `packet_policy`, or
   - adding a new async session-start tool with the same durable task semantics.
2. Keep synchronous `run_subagent_session` only as a compatibility wrapper that starts the durable session task and waits up to its request budget.
3. Store task snapshots for named-session runs so `get_run` or an equivalent polling tool can report:
   - session key,
   - session directory,
   - current lock/lease owner,
   - attempt session id,
   - packet status,
   - terminal result.
4. Make session lock ownership task-scoped:
   - lock owner includes task id and lease timestamp,
   - active tasks refresh the lease,
   - abandoned/dead local task owners are recoverable without requiring blind deletion.
5. On client abandonment, the task either:
   - continues durably and remains pollable/cancellable, or
   - is marked abandoned/cancelled and releases or expires its lock through the lease rule.
6. Preserve existing manifest/ledger/attempt promotion semantics: failed packet attempts must not commit the manifest.

### Intraframe Candidate

Align campaign probe client/server timeouts and audit stale locks after campaign commands.

### Transframe Candidate

Move named session execution into a durable, pollable task lifecycle with task-owned lock leases.

### Selected Candidate

Transframe.

The intraframe campaign fix is useful operational containment, but it leaves the product-level malformed primitive intact. The transframe candidate is the smallest complete correction for the stated product HORC because it moves authority from the synchronous request to a durable task/lease.

### Classification

**True SAF for the product HORC.**

It eliminates the root contradiction: session execution and lock ownership no longer depend on the caller's synchronous MCP request staying alive.

### Pseudo-SAFs Rejected

- Only increase SDK client request timeouts.
- Only audit stale locks after campaign commands.
- Delete stale locks unconditionally.
- Treat packet-failure scenarios as short enough for synchronous execution.
- Only document that callers should use longer timeouts.

### Validation

Run deterministic and live tests that verify:

- a named-session run can be started durably and polled while active,
- forced client abandonment leaves a pollable/cancellable task or an expired lease, not an unexplained stale lock,
- a packet-required invalid attempt records in `attempts.jsonl` and does not mutate `manifest.json`,
- a successful packet-required run promotes the attempt session and appends the committed ledger,
- stale local task leases are recovered only when the owning task/process is definitely dead or expired by policy.

### Residual Backlog

Campaign timeout alignment and stale-lock audits remain useful guardrails. They should be implemented as harness hygiene, not represented as the product-level SAF.

## Supporting Guardrails Not In The SAF Set

These are worth doing, but they are not root fixes for the revised HORCs:

- Clarify packet-policy docs with strict closure examples.
- Add campaign stale-lock audit summaries.
- Improve progress wording for heartbeat-only states.
- Add more live-model smoke scenarios.
- Archive or annotate historical reports whose SAF statuses are superseded.

## Coherent Execution Order

1. **R-SAF-3** first. Deterministic evidence makes every later repair easier to verify.
2. **R-SAF-1** next. Active event projection directly improves real-use observability and gives tests more evidence to assert.
3. **R-SAF-2** next. One-shot incompatibility gating prevents obvious expensive mistakes before child spawn.
4. **R-SAF-4** last among the SAFs. It is the largest product-frame change, but it is the real repair for named-session request abandonment.

Supporting guardrails can run in parallel after R-SAF-3, especially packet-doc clarification and campaign stale-lock reporting.

## Final Coherent Set

The repaired set contains four SAFs:

1. **Bounded active event projection** is a True SAF for active `get_run` evidence opacity.
2. **One-shot incompatibility gate** is a True SAF for known incompatible request shapes reaching child spawn.
3. **Deterministic protocol probe boundary** is a True SAF for mixed model/protocol evidence.
4. **Durable named-session run lifecycle** is a True SAF for session locks coupled to synchronous request lifetime.

Two broader problems remain intentionally outside this set:

- Full event-sourced run history.
- Full scheduler-owned workload routing.

Those are real future architecture improvements, but claiming them as solved by this set would recreate the overclaim the stress test identified.
