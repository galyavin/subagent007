# Current SAF Adversarial Stress Test - 2026-06-11

Source proposal: `reports/observed-real-use-trials-2026-06-11-current.md`

Method: adversarial-but-fair red/blue review of the four selected SAFs from the current observed-use campaign. The question is not "is this useful?" but whether each selected fix is the smallest sufficient correction for its stated HORC.

Status: pre-implementation stress test. Its refinement recommendations were incorporated into `reports/full-coherent-revised-saf-set-2026-06-11-current.md` and implemented in the current worktree.

Definitions used:

- **True SAF**: smallest sufficient upstream change that eliminates the stated HORC without moving the defect elsewhere.
- **Asymptotic SAF**: directionally correct and materially helpful, but incomplete, indirect, overbroad, or not perfectly irreducible for the stated HORC.
- **Pseudo-SAF**: appears minimal but mainly addresses symptoms, avoids the malformed primitive, or hides complexity elsewhere while the stated HORC remains.

## Verdict

Do not treat the current selected SAF set as canonical without refinement.

| ID | Selected SAF Under Test | Classification | Short Rationale |
| --- | --- | --- | --- |
| SAF-1 | Add bounded redacted `recent_events` and `last_public_output_excerpt` to run-task snapshots. | **Asymptotic SAF** | Directly improves active-run opacity, but remains a bounded projection grafted onto snapshots, not the event-stream primitive named by the HORC. |
| SAF-2 | Add `run_subagent` preflight redirect for broad, skill-bound, or long-looking work. | **Asymptotic SAF** | Moves failure earlier and prevents common misuse, but heuristic suitability classification does not fully replace caller-promised workload shape. |
| SAF-3 | Split observed probe modes into deterministic protocol probes using fake child plus separate live-model smoke probes. | **True SAF**, if the split is enforced by scenario mode and registry semantics. | It directly removes model compliance from protocol assertions using an existing child-adapter boundary. |
| SAF-4 | Align campaign probe client/server timeouts and audit stale locks after campaign commands. | **Pseudo-SAF for the stated HORC**; **True SAF for a narrower harness HORC**. | It prevents or reports the campaign symptom, but does not repair the product-level fact that synchronous session locks depend on handler completion after client abandonment. |

## Evidence Frame

Known facts:

- `src/runTask.ts` currently projects active task state as lifecycle status plus `elapsed_ms`, `last_progress_at`, `last_progress_message`, and `heartbeat_count`.
- `src/processRunner.ts` buffers child stdout/stderr until process completion while heartbeats are generic unless supplied a richer message.
- `scripts/run-observed-mcp-probe.mjs` has a scenario registry and coverage summary, but the current `child-failure` and packet scenarios are still prompt-driven against the configured child.
- `src/runSubagent.ts` already supports `SUBAGENT007_PI_CHILD_PATH`, and `tests/helpers/fakePiChild.ts` contains deterministic branches for `FAIL_EXIT`, timeout, transcript, and packet cases.
- `src/session.ts` holds a filesystem lock for synchronous `run_subagent_session` execution and recovers stale local locks only when a later acquisition detects a dead owner PID.
- The current campaign observed a client-side MCP timeout in the packet-failure probe with a stale temp session lock.

Assumptions:

- Classification is relative to the HORCs as written in `observed-real-use-trials-2026-06-11-current.md`, not narrowed after the fact.
- The project prefers low-motion repairs when they actually eliminate the stated malformed primitive.
- "Fair" stress testing means preserving the best reasonable interpretation of each selected SAF before demotion.

## SAF-1 - Bounded Recent Active Events

Stated HORC:

Active runs are modeled as lifecycle snapshots, not event streams.

Selected SAF:

Persist a small redacted `recent_events` array and `last_public_output_excerpt` into run-task snapshots. Populate it from sanitized child stdout/stderr/progress events as they arrive, using final transcript redaction rules.

Red-team stress:

- The selected fix still treats events as snapshot fields. It does not make the run's source of truth an event stream; it adds an event-like projection to the existing mutable task record.
- A bounded tail can drop the exact event needed to diagnose a long or multi-phase run. If a run spends 80 seconds in skill setup and then emits noisy progress, the original stall evidence may fall out of the tail.
- `last_public_output_excerpt` can create a false sense of semantic progress. Public text availability is not the same as tool phase, model phase, input wait, or child subprocess state.
- Redaction safety becomes an active invariant. If the projection uses a subtly different sanitizer from final transcript rendering, the fix creates a second redaction authority.

Blue-team defense:

- The observed defect was active-run opacity through `get_run`, not the absence of a perfect audit log. A bounded redacted projection would materially change caller experience during T4, T6, and T12.
- A full event-sourced run ledger is larger motion and touches storage, migrations, terminal reconstruction, and probably compatibility semantics.
- If implemented as a projection generated from one sanitized ingest function, it can avoid becoming a separate redaction authority.

Final classification: **Asymptotic SAF**.

Why not True SAF:

The selected fix improves the symptom and partly introduces event structure, but the stated HORC names the primitive: run state is not event-stream based. A bounded projection is not the smallest complete correction for that primitive; it is a low-motion approximation.

Why not pseudo-SAF:

It is not just documentation or a cosmetic heartbeat. It would add upstream active-run evidence before terminal completion, which directly attacks the observed incoherence.

What would make it True:

Narrow the HORC to: "`get_run` lacks a bounded, redacted active-run evidence projection." Under that narrower HORC, this is close to a True SAF. For the current broader HORC, the True SAF is an event ingest/ledger primitive with `get_run` as a projection over it.

Cheapest validation check:

Run a fake-child scenario that emits assistant text, warning/error events, and then sleeps. Poll `get_run` before terminal state and verify `recent_events` contains sanitized public events while secrets and raw thinking remain absent.

## SAF-2 - One-Shot Preflight Redirect

Stated HORC:

One-shot suitability is a caller promise with late enforcement.

Selected SAF:

Add a preflight suitability classifier for `run_subagent`: reject or redirect prompts with skill binding, synthesis/audit/review markers, long prompt length, or explicit broad-work vocabulary unless the caller uses `start_run`. Return recovery guidance before child spawn.

Red-team stress:

- A vocabulary or length classifier is heuristic. A short prompt can still be slow or broad, and a long prompt can be a deterministic exact-output fixture.
- The fix can become a policy list that drifts with usage patterns. That hides complexity in classifier tuning rather than eliminating workload ambiguity.
- It may reject legitimate quick tasks, causing user friction and encouraging callers to game wording.
- It still leaves the central public primitive in place: the caller declares `quick_noninteractive`; the server does not observe or negotiate workload shape as first-class state.

Blue-team defense:

- The observed harm is expensive late failure. A preflight gate prevents many high-risk calls from spawning any child process, which is more upstream than a post-timeout hint.
- Perfect workload classification is not available without much larger system motion. The classifier can be conservative: target only obvious broad markers, skill binding, and known slow categories.
- Current validation already rejects skill smuggling and unsupported fields. Extending that boundary to obvious one-shot misuse is consistent with the codebase's contract style.

Final classification: **Asymptotic SAF**.

Why not True SAF:

It approaches the right boundary by moving feedback before child spawn, but it does not fully eliminate caller-promised suitability. It replaces late enforcement with partial heuristic enforcement.

Why not pseudo-SAF:

Unlike timeout hints, this would prevent a class of bad executions before cost is paid. It targets the decision boundary, not just the consequence.

What would make it True:

Either narrow the HORC to: "`run_subagent` accepts obvious broad-work prompts without preflight rejection," or change the frame so workload shape is explicit scheduler state. A stricter intraframe True SAF would require a declared workload category enum plus server-side compatibility rules, not just prompt heuristics.

Cheapest validation check:

Submit an obvious broad prompt such as "inspect this repo, synthesize HORCs, and produce a plan" through `run_subagent`. Verify it rejects before child spawn with a `start_run` redirect. Then submit a terse exact-output prompt and verify it still runs.

## SAF-3 - Deterministic Protocol Probe Split

Stated HORC:

The observed probe mixes protocol assertions with model-compliance prompts.

Selected SAF:

Split probe modes into `protocol-deterministic` and `live-model`. Use `SUBAGENT007_PI_CHILD_PATH` with the existing fake child for deterministic failure, packet, timeout, and transcript cases; keep a separate live-model smoke scenario for installed Pi integration.

Red-team stress:

- If the split is only naming, it can still leave real-model prompts in "deterministic" scenarios.
- Fake-child coverage can overfit server-child protocol details and miss live Pi integration failures.
- Maintaining two modes creates a reporting risk: callers may compare deterministic protocol pass rates with live-model smoke pass rates as if they were the same evidence class.

Blue-team defense:

- The proposal explicitly separates the evidence classes rather than conflating them. Fake child proves server protocol mechanics; live smoke proves installed integration.
- The code already has the required adapter point in `SUBAGENT007_PI_CHILD_PATH`; tests already encode deterministic fake-child behavior for failure, packets, and timeouts.
- The current probe already has a scenario registry and coverage summary, so making mode/evidence class authoritative is a small extension rather than a new framework.

Final classification: **True SAF**, with one condition.

Condition:

The split must be enforced structurally: deterministic scenarios must launch the server under a fake-child environment, and the registry/summary must label deterministic and live-model evidence classes separately. A mere rename would be asymptotic.

Why True:

The malformed primitive is mixed evidence authority. The selected fix separates the authorities at the child boundary: protocol assertions use a deterministic adapter; provider behavior is tested only as live smoke. No smaller complete fix is apparent. Prompt tuning would remain model compliance.

Cheapest validation check:

Run `observed-mcp-probe --scenario child-failure` in deterministic mode and verify it returns `exit_code:42` or `nonzero_exit` from the fake child every time. Run live-model mode separately and verify it does not claim deterministic child-failure coverage.

## SAF-4 - Campaign Timeout Alignment And Stale Lock Audit

Stated HORC:

Session locks depend on handler completion, but client timeouts can abandon the handler.

Selected SAF:

For the harness defect, align client and server timeouts and audit stale locks after campaign commands. The report noted that async named-session execution would be the cleaner product-level transframe repair but larger than needed for the observed campaign issue.

Red-team stress:

- Timeout alignment prevents the harness from abandoning the handler in expected cases, but it does not change session lock ownership, lock lifetime, or lock cleanup semantics in the server.
- Stale lock audit detects residue after the fact. It does not protect a real client that times out and never runs the campaign cleanup path.
- The current lock recovery already handles stale local locks on the next acquisition. The proposed audit mostly moves discovery earlier, not root-cause authority.
- If the server process remains alive but the client request is gone, a lock can still persist until the handler finishes. This is sometimes correct, but it means the product-level HORC remains.

Blue-team defense:

- The observed issue happened in the campaign harness. For that specific failure mode, client/server timeout alignment plus stale-lock reporting is the smallest practical repair.
- Unconditionally moving `run_subagent_session` onto async run tasks is a bigger API/behavior change and not necessary to make campaign evidence clean.
- Auditing stale locks is safer than deleting them blindly and can expose product-level lock problems without corrupting active sessions.

Final classification: **Pseudo-SAF for the stated HORC**.

Why pseudo for the stated HORC:

The stated HORC is about product architecture: synchronous session execution owns locks until handler completion, while clients can abandon requests. The selected fix changes the campaign caller's behavior and adds after-the-fact audit. The malformed server primitive remains.

Why it is not useless:

For a narrower HORC, "the observed campaign harness can create misleading stale-lock residue by using shorter client timeouts than server session work," this is a **True SAF** if it both aligns request timeouts and reports stale locks in the campaign summary.

What would make it True for the stated HORC:

Move named session execution into a durable, cancellable/pollable task lifecycle, or introduce a server-side request-abandonment/lease mechanism that can settle session locks independently of synchronous MCP handler completion. The transframe async-session model named in the original report is the real root repair.

Cheapest validation check:

In harness scope: run a packet-failure scenario with client timeout greater than server timeout and verify no stale lock remains, or that a stale lock is reported in the campaign summary. Product scope: forcibly abandon a `run_subagent_session` client call and verify the server either continues with visible durable state or releases/marks the lock through a lease mechanism. The selected SAF only satisfies the first check.

## Revised Recommendation

1. Keep SAF-3 as a True SAF and implement it first. It improves the reliability of all future observed-use evidence.
2. Keep SAF-1 and SAF-2 as useful asymptotic fixes, but do not label them True SAFs unless their HORCs are narrowed.
3. Demote SAF-4 from the selected SAF set for the stated product HORC. Keep it as a campaign-harness repair, and track async named-session execution or lock leasing as the true product-level repair.
4. Update future HORC/SAF reports to state classification scope explicitly: "true for narrowed harness HORC", "asymptotic for product HORC", etc. This prevents useful guardrails from being mistaken for root fixes.
