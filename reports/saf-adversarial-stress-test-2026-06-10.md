# SAF Adversarial Stress Test - 2026-06-10

Status: historical adversarial classification of the selected SAFs from `reports/current-observed-real-use-trials-2026-06-10.md`. The repaired SAF set derived from this review has since been implemented in the current worktree.

Method: red/blue review with codebase verification. A narrow independent subagent critique also reviewed the five classifications. No runtime code changes were made.

## Classification Rules

- **True SAF**: smallest sufficient upstream change that eliminates the HORC, with no smaller complete fix available.
- **Asymptotic SAF**: useful and directionally close, but incomplete, indirect, overbroad, optional, or still leaving the malformed primitive partly intact.
- **Pseudo-SAF**: appears minimal but mainly documents, routes around, or compensates for symptoms while the HORC remains.

## Verdict Summary

| Selected SAF | Classification | Short Rationale |
| --- | --- | --- |
| Parse archive CLI args before filesystem mutation; implement `--help`/`-h`; reject unknown flags | **True SAF** | It moves intent recognition before mutation, which is the malformed primitive that caused `--help` to archive the production ledger. |
| Split timeout semantic tests from wall-clock integration tests; give integration tests generous margins | **Asymptotic SAF** | It repairs the proof boundary for the semantic invariant, but still leaves timeout integration confidence partly dependent on timing. |
| Add `run_subagent` timeout recovery hint and sharpen docs/examples | **Pseudo-SAF** | It helps after misuse but does not remove the broad-work affordance or prevent the wasted one-shot timeout path. |
| Surface explicit config repair suggestion/command when `default_model_repaired` is true | **Asymptotic SAF** | It makes stale config visible and actionable, but does not itself restore config integrity. |
| Add optional failure-record campaign/context field | **Asymptotic SAF** | It improves attribution when callers opt in, but unscoped records still intermix and global-ledger ambiguity remains by default. |

## Detailed Stress Test

### SAF 1: Archive CLI Arg Parsing Before Mutation

Original HORC: CLI intent is not modeled before mutation.

Evidence:

- `scripts/archive-failure-log.mjs:66-74` computes the active failure-log path and calls `fs.rename` without reading `process.argv`.
- The real trial `node scripts/archive-failure-log.mjs --help` moved `/Users/rgalyavin/.codex/subagent007-pi/failures.jsonl` into an archive.

Red-team stress:

- A help-only guard would fix the observed case but still allow `--dry-run`, typo flags, or future options to mutate unexpectedly.
- A parser added after `logPath` construction but before `fs.rename` is still acceptable; a parser after filesystem work is not.
- Adding a confirmation prompt would be heavier than necessary and worse for automation.

Blue-team defense:

- The selected SAF includes both known help flags and unknown-argument rejection before filesystem work, not just a `--help` special case.
- It preserves no-arg archive behavior, so it fixes the malformed primitive without changing the script's identity.

Classification: **True SAF**.

Why not asymptotic: it directly eliminates the upstream rule violation: flags are no longer invisible before mutation.

Cheapest validation:

- With a temp `SUBAGENT007_FAILURE_LOG_PATH`, `node scripts/archive-failure-log.mjs --help` exits 0, prints usage, and leaves the log file in place.
- `node scripts/archive-failure-log.mjs --unknown` exits 2 and leaves the log file in place.
- `node scripts/archive-failure-log.mjs` still archives and summarizes.

### SAF 2: Timeout Semantic Tests Split From Wall-Clock Integration

Original HORC: timeout-semantics tests use wall-clock process races to prove a semantic invariant.

Evidence:

- `tests/timeout-budget.test.ts:210-242` uses a 120 ms timeout and asserts semantic `partial_output_available` classifications through child process timing.
- The first full `npm test` failed on `TIMEOUT_ASSISTANT_EVENT`; the isolated timeout test and retry passed.
- The actual semantic classifier lives in `src/transcript.ts:61-66` and `src/transcript.ts:122-150`; the result field is composed in `src/runSubagent.ts:246-252`.

Red-team stress:

- "Generous margins" lower flake probability but do not abolish scheduler, process startup, IO flush, or platform timing variance.
- If the integration test still asserts every semantic case through child timeout behavior, the root test-shape problem remains.
- Deterministic classifier unit tests prove parsing and metadata, but they do not prove process-runner capture under timeout.

Blue-team defense:

- The selected SAF correctly moves the semantic proof to the transcript/content layer, where timing is irrelevant.
- Keeping one or two generous integration tests is appropriate because process timeout behavior still needs coverage.
- Full fake timers or dependency-injected process runners would be more exact but require broader architecture motion than this observed test flake justifies.

Classification: **Asymptotic SAF**.

Why not True SAF: the selected fix still relies on "generous" timing for remaining integration confidence. A True SAF would make the timeout integration deterministic by controlling the child event stream or process clock boundary.

Why not pseudo-SAF: it does move the core semantic invariant out of the wall-clock race, so it is not merely hiding the symptom.

Cheapest validation:

- Add direct tests for `preparePublicTranscriptFromProcessOutput` covering assistant, warning, error, raw text, user-only, marker-only, and truncation cases.
- Keep a small integration test that verifies timeout mechanics, not every semantic classifier branch.
- Run the timeout suite repeatedly enough to catch the original flake pattern.

### SAF 3: `run_subagent` Timeout Recovery Hint And Sharper Docs

Original HORC: one-shot delegation exposes a broad-work affordance without complexity feedback.

Evidence:

- `README.md:7-17` already distinguishes one-shot, async, and session tools.
- `README.md:154` already says broad/long work should use `start_run`.
- `src/runSubagent.ts:62-70` enforces the internal one-shot timeout; broad delegated probes timed out with shallow partial progress.

Red-team stress:

- Better docs do not help generated clients or users who call the tool based on the name/description.
- A timeout hint appears only after the user has already paid the failed 110 second run.
- A structured `timeout_recovery_hint` helps recovery, not prevention.
- The malformed affordance remains: the tool accepts arbitrary broad prompts and has no workload-intent gate.

Blue-team defense:

- The tool is intentionally a general prompt runner; perfect complexity detection is unreliable.
- Post-timeout hints are low-risk and useful because the system cannot always know a prompt is too broad before execution.
- Raising the timeout or auto-routing would create other failure modes.

Classification: **Pseudo-SAF** for the stated HORC.

Why not asymptotic: it is helpful, but it addresses the aftermath of the contradiction rather than the contradiction itself. The broad-work affordance remains unchanged.

What a closer SAF would be:

- Rename or split the public affordance so the synchronous path is explicitly quick/non-interactive at the tool-contract level, or add a pre-execution workload intent parameter that forces broad/deep work through `start_run`.
- A less invasive asymptotic repair would add a preflight warning/rejection for obviously broad prompts based on explicit user intent fields, not heuristic content guessing.

Cheapest validation for the selected pseudo-fix:

- Force a one-shot timeout and assert the hint is present. This validates the hint, but not root-cause removal.

### SAF 4: Config Repair Suggestion For Runtime-Repaired Default Model

Original HORC: config compatibility repair is runtime-only.

Evidence:

- `src/modelAllowlist.ts:81-89` repairs `openrouter/anthropic/claude-sonnet-4.5` to `openrouter/~anthropic/claude-sonnet-latest`.
- `src/server.ts:160-178` reports `default_model`, `default_model_resolved`, and `default_model_repaired`, but does not produce a concrete config patch or mutate config.
- `src/config.ts:34-59` only reads config; there is no migration/write path.

Red-team stress:

- A suggestion in `list_allowed_models` does not eliminate stale config; it only tells a human how to eliminate it.
- If the caller never runs the suggested repair, every future call still depends on runtime repair.
- If multiple aliases or config fields drift, one suggestion path may become a piecemeal doctor.

Blue-team defense:

- Silent config mutation during ordinary listing/execution would be surprising and risky.
- Surfacing an exact replacement is a real improvement over hidden compatibility magic.
- Because execution currently succeeds, a full config migration command may be disproportionate for this severity.

Classification: **Asymptotic SAF**.

Why not True SAF: the selected repair does not itself restore the persisted invariant; it merely exposes the path.

Why not pseudo-SAF: visibility plus an explicit repair command or exact patch materially reduces hidden incoherence and can lead to a real repair without hidden mutation.

What a True SAF would require:

- An explicit, user-invoked config repair/migration mechanism that rewrites known stale aliases atomically, or a config schema/version migration path that runs under clear operator intent.

Cheapest validation:

- With a stale config, `list_allowed_models` returns the resolved model plus an exact replacement command/patch.
- After running the explicit repair command, `default_model_repaired` becomes false.

### SAF 5: Optional Failure-Record Campaign Context

Original HORC: observability records lack a campaign namespace.

Evidence:

- `FailureLogRecord` in `src/failureLog.ts:63-96` has `record_source`, tool, paths, and session fields, but no campaign/context field.
- `recordSourceFromEnv` at `src/failureLog.ts:112-115` captures only `production`, `test`, or `unknown`.
- `scripts/archive-failure-log.mjs:36-63` summarizes by schema, tool, failure class, cwd class, and day, not campaign.

Red-team stress:

- Optional env context works only when every process in the campaign is launched with it.
- It does not help existing records.
- It does not prevent mixed records by default; it only makes filtering possible when operators remember to opt in.
- It creates another low-discipline string field unless naming and propagation are standardized.

Blue-team defense:

- The issue is attribution, not runtime failure. A full observability store is overbuilt for the current need.
- An optional field preserves compatibility and lets QA campaigns self-scope immediately.
- Archive summaries can group by context without changing ledger format.

Classification: **Asymptotic SAF**.

Why not True SAF: optional caller-supplied context does not eliminate the default global-ledger ambiguity.

Why not pseudo-SAF: when used, it creates a real namespace dimension in the record, which is the missing primitive for campaign filtering.

What a True SAF would require:

- Automatic campaign/run identity propagation from the campaign harness into every MCP call and failure record, or per-campaign ledgers selected by the harness rather than convention.

Cheapest validation:

- With `SUBAGENT007_CAMPAIGN_ID=current-observed-trials`, failures include that field.
- Archive summaries include `by_campaign_id`.
- Records without the field remain valid but are explicitly grouped as `missing`.

## Revised Recommendation

Proceed with SAF 1 as written.

Rework SAF 2 into "semantic classifier tests are deterministic; timeout integration is limited to process mechanics." That is still not a perfect True SAF, but it is a good low-motion repair.

Do not call SAF 3 a SAF. Treat it as an ergonomic patch unless the tool contract is changed to prevent or preflight broad synchronous work.

Keep SAF 4 and SAF 5 as low-priority asymptotic improvements. They are useful, but they should not be described as root-cause elimination unless paired with explicit config migration and automatic campaign identity propagation respectively.
