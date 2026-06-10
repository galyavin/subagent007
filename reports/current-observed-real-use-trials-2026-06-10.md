# Current Observed Real-Use Trials Report - 2026-06-10

Status: historical observed-use campaign report. No runtime code changes were made while this report was written; the SAF implementation that followed has repaired the defects identified here.

## Scope

Target: `subagent007-pi`, a private MCP server for Pi-backed subagent delegation.

Coverage goal: exercise the public MCP tools, local validation suite, session lifecycle, cancellation, caller input, packet policy, schema contract, operational scripts, timeout behavior, model/config health, and representative edge cases.

Primary environment:

- Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
- Branch: `main`
- Date: 2026-06-10
- Node project command surface from `package.json`
- Live installed MCP tools from `subagent007-pi`

## Campaign Plan

1. Map the public contract from `README.md`, `src/server.ts`, and prior reports.
2. Run baseline automated coverage: build, typecheck, tests, model reconciliation, operational scripts.
3. Exercise live MCP tools: `list_allowed_models`, `run_subagent`, `start_run`, `get_run`, `answer_run_input`, `cancel_run`, `run_subagent_session`.
4. Probe edge cases: forbidden `run_subagent.timeout_ms`, required packet readiness, cancellation, broad one-shot timeout, `archive-failure-log --help`.
5. Use subagent delegation for independent read-only probes.
6. Reduce observations into patterns, HORCs, SAF candidates, selected SAFs, and implementation plan.

## Trial Matrix

| ID | Surface | Action | Observation |
| --- | --- | --- | --- |
| T0 | Git/worktree | `git status --short --branch` | On `main`; no local branch change made. |
| T1 | Prior reports | Read `reports/observed-real-use-trials-2026-06-10.md`, `reports/revised-saf-set-2026-06-10.md`, and `docs/plans/revised-saf-implementation-plan-2026-06-10.md`. | Prior packet/schema/partial-output SAFs appear implemented in code and docs. Current campaign treated them as hypotheses to re-test. |
| T2 | Full local suite | First `npm test`. | Failed once: `timeout partial output reflects public child-generated content`, case `TIMEOUT_ASSISTANT_EVENT`, expected `partial_output_available: true`, got `false`. |
| T3 | Isolated timeout suite | `node scripts/run-tests-with-ledger-guard.mjs tests/timeout-budget.test.ts`. | Passed 8/8. |
| T4 | Full local suite retry | Second `npm test`. | Passed 61/61. The first failure is a flake/order/timing issue, not a deterministic regression. |
| T5 | Typecheck | `npm run typecheck`. | Passed. |
| T6 | Model reconciliation | `npm run models:reconcile`. | Passed. Pi 263, OpenRouter 338, Ollama 1; all curated refs present. |
| T7 | Archive script edge | `node scripts/archive-failure-log.mjs --help`. | `--help` was ignored and the default production failure ledger was archived. Archive summary: `/Users/rgalyavin/.codex/subagent007-pi/archives/failures-2026-06-10T210608068Z.summary.json`, 10 records. |
| T8 | Live model list | MCP `list_allowed_models`. | Succeeded. Config default `openrouter/anthropic/claude-sonnet-4.5` was repaired to `openrouter/~anthropic/claude-sonnet-latest`; `default_model_repaired: true`. |
| T9 | Live one-shot | MCP `run_subagent`, exact-output prompt. | Completed in 6032 ms. Output artifact contained exactly `real-trial-pong-2026-06-10`. |
| T10 | Live async | MCP `start_run`, then `get_run`. | Transitioned `working -> completed` in 5014 ms. Output artifact contained exactly `async-real-trial-pong-2026-06-10`. |
| T11 | Live caller input | MCP `start_run` prompt requiring `request_input`, then `get_run`, `answer_run_input`, `get_run`. | Transitioned to `input_required` with question `Trial token?`, answer accepted, final output `token=blue-42`. Request creation took about 18.9s; total run duration 55.6s. |
| T12 | Live cancellation | MCP `start_run` shell sleep prompt, then `cancel_run`, then `get_run`. | Immediate view was `cancelled`; terminal view had `stop_reason: cancelled`, `exit_code: null`, transcript contained user prompt plus `[subagent007 cancelled]`. |
| T13 | Live named session | `run_subagent_session` `resume_mode:new`, then `resume_or_new`. | Created manifest/ledger and resumed the same `subagent_session_id`; resumed output returned `SESSION_MARKER_CURRENT_2026_06_10`; ledger had 2 records. |
| T14 | Required packet ready | `run_subagent_session` with `packet_policy: required` and prompt forcing `verdict:"ready"`, `blockers:[]`. | `success:true`, `packet_parse_status:"valid"`, committed manifest/ledger. |
| T15 | Required packet blocked | `run_subagent_session` with `packet_policy: required` and prompt forcing `verdict:"blocked"`, nonempty blockers. | `success:false`, `failure_class: packet_failed`, `reason_code: packet_required_invalid`, wrote `attempts.jsonl`, did not create manifest/ledger. |
| T16 | Public schema edge | SDK `listTools()` against `dist/server.js`. | `run_subagent` has no `timeout_ms`; `start_run` and `run_subagent_session` do. |
| T17 | Raw forbidden timeout | SDK raw `run_subagent` call with `timeout_ms`. | Returned `isError:true` with message `timeout_ms is not supported by run_subagent; use start_run for timed work`; no child execution. |
| T18 | Broad delegated probes | Two read-only `run_subagent` probes across API and operations surfaces. | Both timed out at the one-shot 110s default and produced only shallow assistant progress text. |
| T19 | Narrow delegated probe | Read-only `run_subagent` probe of `scripts/archive-failure-log.mjs`. | Completed and independently confirmed `--help` is ignored and moves the log because `process.argv` is never read. |
| T20 | Failure ledger | Read current fresh `~/.codex/subagent007-pi/failures.jsonl`. | Contains campaign packet failure plus timeout records. Also contained an unrelated-looking `/skill:investigate` `start_run` timeout, showing the global ledger can mix campaign and background work. |

## Healthy Behaviors Observed

- Core one-shot execution works for small exact-output prompts.
- Async run polling works and returns coherent timeout metadata.
- Caller input works end to end through mailbox creation, answer, and final artifact.
- Cancellation works and does not falsely report success or partial output.
- Named session create/resume preserves continuity, manifest, and ledger.
- Required packet policy now gates success on valid parse, `verdict === "ready"`, and empty blockers.
- Public MCP schema no longer advertises forbidden `run_subagent.timeout_ms`, and raw invalid calls are rejected.
- Typecheck, model reconciliation, and the full test suite pass on retry.

## Observed Issues And Incoherences

### I1. Archive Script Treats `--help` As A Destructive Archive Command

Severity: medium-high.

Observed in T7 and independently confirmed in T19.

Evidence:

- `node scripts/archive-failure-log.mjs --help` archived the default log instead of printing help.
- Archive created: `/Users/rgalyavin/.codex/subagent007-pi/archives/failures-2026-06-10T210608068Z.jsonl`
- Summary created: `/Users/rgalyavin/.codex/subagent007-pi/archives/failures-2026-06-10T210608068Z.summary.json`
- Summary had 10 production records.
- `scripts/archive-failure-log.mjs:66-74` computes the default log path and renames it without parsing `process.argv`.

Why it matters:

A user asking for help mutates production observability state. It is a move, not deletion, but it still changes the active ledger and creates archive noise.

### I2. Timeout Metadata Regression Test Is Timing-Sensitive

Severity: medium.

Observed in T2, then contradicted by T3/T4.

Evidence:

- First full `npm test` failed at `tests/timeout-budget.test.ts:242`.
- Isolated timeout test passed.
- Full suite retry passed.
- The test uses a 120 ms requested timeout with tiny 20/10/10 ms reserves at `tests/timeout-budget.test.ts:210-242`.

Why it matters:

The invariant is important: `partial_output_available` should mean public child-generated content exists. A flaky test around that invariant weakens trust in CI even when implementation is correct.

### I3. Broad One-Shot Delegation Times Out With Low-Value Partials

Severity: medium.

Observed in T18.

Evidence:

- Two broad read-only `run_subagent` review prompts timed out at the 110s one-shot default.
- Both returned `partial_output_available:true` because there was public assistant text, but the artifacts only contained planning/progress narration, not findings.
- `README.md:154` documents that `run_subagent` has an internal 110s deadline and broad/long work should use `start_run`.

Why it matters:

The current semantics are technically correct but ergonomically easy to misuse. For a realistic "review this repo" job, the one-shot tool can produce a failure artifact that is public but not actually useful.

### I4. Default Model Config Is Still Stale And Repaired At Runtime

Severity: low.

Observed in T8.

Evidence:

- `list_allowed_models` reported `default_model: "openrouter/anthropic/claude-sonnet-4.5"`.
- It also reported `default_model_resolved: "openrouter/~anthropic/claude-sonnet-latest"` and `default_model_repaired: true`.
- Alias repair lives in `src/modelAllowlist.ts:81-89`.

Why it matters:

Execution works, but the persisted config remains dependent on compatibility repair. This is an operational hygiene gap, not a current functional break.

### I5. Global Failure Ledger Is Not Trial-Scoped

Severity: low.

Observed in T20.

Evidence:

- The fresh failure ledger included the campaign's packet failure and delegated probe timeouts.
- It also included an unrelated-looking `/skill:investigate` `start_run` timeout from another active/background flow.
- Failure records include `record_source`, `tool`, `session_key` when available, and paths, but not a campaign/run namespace.

Why it matters:

For observed-use campaigns, global telemetry makes attribution harder. This does not break runtime behavior, but it makes operational analysis noisier.

## Common Patterns

1. Core execution mechanics are coherent. The real MCP flows for one-shot, async, input, cancellation, sessions, and required packets all behaved as intended.
2. Remaining issues live at operational boundaries: CLI affordances, test determinism, timeout ergonomics, config hygiene, and telemetry scoping.
3. Several public fields are intentionally minimal. `partial_output_available` now means public child content exists, not that the content is sufficient or useful.
4. Fixed one-shot timeouts are correct for small delegation but brittle for broad audits. Users need either better routing to `start_run` or stronger tool affordances.
5. Runtime compatibility repairs prevent breakage but leave persistent state less honest than the live behavior.

## HORCs And SAFs

### HORC 1: CLI Intent Is Not Modeled Before Mutation

The script has only one implicit mode: archive now. It never separates informational intent (`--help`) from mutating intent, so any invocation with a recognizable or unrecognizable flag can still perform the archive.

Intraframe SAF candidate:

- Add a tiny argument parser at the top of `scripts/archive-failure-log.mjs`.
- If `--help` or `-h`, print usage and exit 0 before any filesystem operation.
- If unknown args are present, print usage/error and exit 2 before any filesystem operation.
- Preserve current no-arg archive behavior.

Transframe SAF candidate:

- Move operational scripts behind a shared CLI command framework with explicit command objects, help generation, dry-run support, and mutation gates.

Selected SAF:

- Intraframe. The smallest complete fix is argument parsing before side effects. A help-only guard fixes the observed `--help` case, but rejecting unknown args is the atomic step that eliminates the broader malformed primitive: flags are currently invisible to the script.

Rejected pseudo-SAFs:

- README-only warning.
- Renaming the script.
- Printing the archive result more clearly after mutation.

### HORC 2: Timeout-Semantics Tests Use Wall-Clock Process Races To Prove A Semantic Invariant

The partial-output invariant is semantic, but the regression test proves it through very small wall-clock timeout windows and process shutdown behavior. That makes a correct classifier look broken when event output loses a scheduling race.

Intraframe SAF candidate:

- Split the test into deterministic transcript/content-classification unit tests plus a smaller integration timeout test with generous margins.
- Increase the timeout budget used in the integration cases so the fake child has enough time to emit and flush structured events before termination.
- Keep one raw-timeout integration case for process-runner behavior.

Transframe SAF candidate:

- Replace environment/time/process based timeout tests with dependency-injected runtime config, fake timers, and an in-process controllable child event stream.

Selected SAF:

- Intraframe. It removes the flake with much less system motion while still proving the invariant at the right layer.

Rejected pseudo-SAFs:

- Blindly retrying tests in CI.
- Deleting the assertion for `partial_output_available`.
- Treating one local pass as proof that the initial failure is irrelevant.

### HORC 3: One-Shot Delegation Exposes A Broad-Work Affordance Without Complexity Feedback

`run_subagent` is technically a short synchronous one-shot, but its name and examples make it easy to use for repo-scale review. The tool correctly times out, yet its partial artifact can be content-bearing and still not decision-useful.

Intraframe SAF candidate:

- Tighten the tool description and README examples to frame `run_subagent` as quick/non-interactive only.
- On timeout, include a concise recovery hint in the result or transcript: use `start_run` with an explicit `timeout_ms` for broad review, input loops, or long work.
- Optionally add a `timeout_recovery_hint` structured field for clients.

Transframe SAF candidate:

- Add an orchestration layer that classifies prompt complexity and automatically routes broad/deep work to `start_run` instead of synchronous `run_subagent`.

Selected SAF:

- Intraframe. Automatic routing is attractive but bigger than needed. A timeout recovery hint plus sharper public descriptions resolves the misuse pattern without changing tool semantics.

Rejected pseudo-SAFs:

- Raising the default one-shot timeout globally.
- Redefining `partial_output_available` to mean "useful".
- Removing `run_subagent`.

### HORC 4: Config Compatibility Repair Is Runtime-Only

The system can repair known model aliases during use, but the underlying config remains stale. The repaired runtime and persisted config can therefore tell different stories.

Intraframe SAF candidate:

- Add `repair_command` or `config_repair_suggestion` to `list_allowed_models` when `default_model_repaired` is true.
- Document the exact replacement value.
- Do not rewrite config during ordinary model listing or execution.

Transframe SAF candidate:

- Introduce a versioned config schema and an explicit `config:migrate` or `config:doctor` command that can rewrite known stale aliases.

Selected SAF:

- Intraframe for now. Runtime is not broken, so the least-motion complete fix is to surface a precise, explicit repair path without hidden mutation.

Rejected pseudo-SAFs:

- Silently rewriting config during `list_allowed_models`.
- Removing alias repair before users migrate.
- Ignoring `default_model_repaired` because execution succeeds.

### HORC 5: Observability Records Lack A Campaign Namespace

Failure logging is globally useful but not designed for observed-use campaign attribution. Records from unrelated work can land in the same ledger during a campaign window.

Intraframe SAF candidate:

- Add an optional `SUBAGENT007_RECORD_CONTEXT` or `SUBAGENT007_CAMPAIGN_ID` environment field copied into failure records.
- Have scripts and QA reports filter/summarize by that field when present.

Transframe SAF candidate:

- Move from append-only global JSONL to a queryable observability store with explicit run/campaign/session dimensions.

Selected SAF:

- Intraframe. A single optional context field is enough to distinguish campaigns without changing storage format.

Rejected pseudo-SAFs:

- Manually filtering by timestamp only.
- Maintaining separate ledgers by convention without a first-class record field.

## Final SAF Set

| HORC | Selected SAF | Priority |
| --- | --- | --- |
| CLI intent is not modeled before mutation | Parse args before filesystem work; implement `--help`/`-h` and reject unknown flags before archive | P1 |
| Timeout test uses wall-clock race for semantic invariant | Split deterministic content-classifier tests from generous integration timeout tests | P1 |
| One-shot delegation lacks complexity feedback | Add timeout recovery hint and sharpen public description/examples for quick-only use | P2 |
| Runtime-only config repair | Surface explicit repair suggestion/command in `list_allowed_models` when repaired | P3 |
| Failure ledger lacks campaign namespace | Add optional record context/campaign id to failure records | P3 |

## Coherent Implementation Plan

1. Fix archive CLI guard first.
   - Add argument parsing before `const logPath = defaultFailureLogPath()`.
   - Implement `--help`/`-h`.
   - Reject unknown args with exit code 2.
   - Add script tests using a temp `SUBAGENT007_FAILURE_LOG_PATH` proving `--help` does not move files and unknown flags do not move files.

2. Stabilize timeout metadata tests.
   - Add direct tests for `preparePublicTranscriptFromProcessOutput` and/or `publicTranscriptContentFlags`.
   - Keep integration timeout coverage but use larger timing margins.
   - Preserve the existing invariant: raw user/marker bytes do not set `partial_output_available`; assistant/warning/error/final message do.

3. Improve `run_subagent` timeout ergonomics.
   - Update MCP description and README language around quick one-shot use.
   - Add timeout recovery hint in the failure result or timeout transcript.
   - Add one test asserting the hint appears on one-shot timeout.

4. Add config repair affordance.
   - Extend `list_allowed_models` structured result with a suggested config replacement when `default_model_repaired` is true.
   - Update README config section.
   - Do not auto-write config.

5. Add optional failure record context.
   - Add optional env-derived field to `FailureLogRecord`.
   - Update archive summary to group by context when present.
   - Add tests for records with and without context.

6. Verify.
   - `npm run typecheck`
   - `npm test`
   - `npm run models:reconcile`
   - Live smoke: `list_allowed_models`, one-shot exact output, async exact output, required ready/blocked packet, archive `--help` against temp ledger.

## Residual Risks

- Real Pi behavior still depends on model compliance for packet contents and request-input use.
- `partial_output_available` intentionally does not measure content usefulness.
- Broad delegated probes should be run through `start_run` with explicit timeouts, not one-shot `run_subagent`.
- The default failure ledger was archived during this campaign by the `--help` edge trial; the archive path is recorded above.
