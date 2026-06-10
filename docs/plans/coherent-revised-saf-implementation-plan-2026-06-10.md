---
title: Coherent Revised SAF Implementation Plan
date: 2026-06-10
status: implemented
source_artifacts:
  - reports/current-observed-real-use-trials-2026-06-10.md
  - reports/saf-adversarial-stress-test-2026-06-10.md
  - reports/coherent-revised-saf-set-2026-06-10.md
---

# Coherent Revised SAF Implementation Plan

Status note: this plan has been implemented in the current worktree. It remains as traceability for the repaired SAF set from `reports/coherent-revised-saf-set-2026-06-10.md`, not as an open task list.

This plan implemented the repaired SAF set from `reports/coherent-revised-saf-set-2026-06-10.md`. It is scoped to the smallest cohesive set of code, test, and documentation changes needed to remove the upstream incoherences found during observed real-use trials.

## Objectives

1. Make `failure-log:archive --help` and invalid invocations side-effect free.
2. Remove timing-dependent partial-output classification tests by separating semantic classification from process lifecycle timeout tests.
3. Require callers of the synchronous `run_subagent` MCP tool to explicitly declare quick, non-interactive intent.
4. Provide an explicit canonicalization boundary for stale local config model aliases.
5. Make future observed-trial campaigns attributable and state-isolated by construction.

## Non-Goals

- Do not rewrite the MCP server architecture.
- Do not remove compatibility alias repair from runtime model resolution.
- Do not automatically mutate the user's home config during tests or normal server startup.
- Do not add a new persistent external database or service for campaign state.
- Do not change `start_run` or `run_subagent_session` into quick-only APIs.

## SAF Implementation Units

### Unit 1: Archive Invocation Mode Boundary

SAF: archive script must classify invocation mode before any filesystem mutation.

Files:

- `scripts/archive-failure-log.mjs`
- `tests/archive-failure-log.test.ts`
- `package.json` only if a helper script name is needed

Implementation:

- Add a small `parseArgs(argv)` function at the top of `scripts/archive-failure-log.mjs`.
- Supported modes:
  - no args: archive the configured ledger, preserving current behavior.
  - `--help` or `-h`: print usage and exit `0` without creating directories, renaming files, or writing summaries.
  - unknown args: print usage plus an error and exit `2` without mutation.
- Ensure all filesystem reads, `mkdir`, `rename`, and summary writes occur only after mode is known to be `archive`.
- Keep `SUBAGENT007_FAILURE_LOG_PATH` support unchanged.

Tests:

- `--help` with a temp ledger path leaves the ledger untouched and creates no archive directory.
- unknown arg leaves the ledger untouched and exits nonzero.
- no-arg invocation archives a temp ledger and writes the summary as before.
- empty or missing ledger still remains a no-op archive success, matching current operational semantics.

Acceptance:

- `npm test` includes the new script tests.
- A manual `npm run failure-log:archive -- --help` displays usage and leaves the real ledger unchanged.

### Unit 2: Deterministic Partial-Output Semantics

SAF: semantic partial-output availability must be decided by pure classification, not by racing a child process timeout.

Files:

- `src/runSubagent.ts`
- `src/output.ts` or `src/transcript.ts`
- `tests/run-subagent.test.ts`
- `tests/timeout-budget.test.ts`

Implementation:

- Extract the current `childPublicOutputAvailable` decision into a small pure helper.
- Inputs should be explicit:
  - `finalMessage`
  - `hasPublicAssistantText`
  - `hasPublicSubagentWarning`
  - `hasPublicSubagentError`
  - `timedOut`
- Output should be the boolean currently assigned to `partial_output_available`.
- Reuse existing transcript flags from `writeRunOutput` and `publicTranscriptContentFlags`; do not add a second transcript parser.
- Keep process-timeout tests focused on lifecycle behavior only:
  - process times out,
  - child is terminated,
  - raw non-public output does not set `partial_output_available`,
  - timeout metadata is populated.
- Move assistant/warning/error/user-only/raw transcript classification cases into pure tests that do not depend on millisecond scheduling.

Tests:

- Pure helper returns `true` when timed out and there is a final assistant message.
- Pure helper returns `true` when timed out and output flags include public assistant text, warning, or error.
- Pure helper returns `false` when timed out but only raw text or user-only content exists.
- Pure helper returns `false` when not timed out, even if public output exists.
- Existing process timeout test remains, but no longer tries to prove every semantic case via a timed child process.

Acceptance:

- `npm test` passes repeatedly without flaky timeout-classification failures.
- The public MCP result shape for existing successful and timed-out calls remains unchanged except for more deterministic test coverage.

### Unit 3: Synchronous `run_subagent` Workload Contract

SAF: public synchronous one-shot calls must require an explicit quick, non-interactive workload declaration.

Files:

- `src/server.ts`
- `src/types.ts`
- `tests/run-subagent.test.ts`
- `README.md`

Implementation:

- Add a public schema field to `run_subagent` only:
  - `run_kind: "quick_noninteractive"`
- Mark `run_kind` required in the MCP input schema for `run_subagent`.
- Do not add this field to `start_run` or `run_subagent_session`.
- Update the `run_subagent` tool description so clients understand it is for quick, non-interactive work.
- Keep `timeout_ms` rejected for `run_subagent`; the new contract complements the timeout prohibition instead of replacing it.
- Pass through or strip `run_kind` before calling internal execution. The child process must not depend on it.

Tests:

- `list_tools` shows `run_subagent.inputSchema.required` includes `run_kind`.
- `run_subagent` without `run_kind` returns an MCP validation error and does not invoke the child.
- `run_subagent` with `run_kind: "quick_noninteractive"` still succeeds through the fake child path.
- `run_subagent` with another `run_kind` value is rejected.
- `run_subagent` with `timeout_ms` remains rejected.
- `start_run` still works without `run_kind`.

Documentation:

- Update `README.md` tool examples and behavior notes to show `run_kind: "quick_noninteractive"`.
- Clarify that long, exploratory, or interruptible work belongs in `start_run` plus polling, or in `run_subagent_session` when continuity is needed.

Acceptance:

- Public schemas make the quick-workload assumption visible to clients.
- Existing async and session workflows remain available for long tasks.

### Unit 4: Explicit Config Canonicalization Boundary

SAF: stale config alias repair must be surfaced as an operator-controlled migration, not hidden as an implicit runtime convenience.

Files:

- `src/config.ts`
- `src/modelAllowlist.ts`
- `src/server.ts`
- `scripts/migrate-config.mjs`
- `tests/config-migrate.test.ts`
- `tests/run-subagent.test.ts`
- `package.json`
- `README.md`

Implementation:

- Add `npm run config:migrate` backed by `scripts/migrate-config.mjs`.
- Add `preconfig:migrate` to run `npm run build`, matching the existing `models:reconcile` pattern for scripts that import compiled `dist` modules.
- The script should:
  - read `SUBAGENT007_CONFIG_PATH` when set, otherwise use the default config path,
  - inspect `default_model`,
  - rewrite only known stale aliases that `repairKnownModelAlias` maps to allowed canonical model refs,
  - preserve unknown fields,
  - write pretty JSON atomically,
  - report `unchanged`, `migrated`, `missing_config`, `invalid_json`, or `unrepairable_model`.
- Reuse `repairKnownModelAlias` and allowlist checks from compiled `dist/modelAllowlist.js`; do not duplicate alias tables in the script.
- Runtime resolution may keep compatibility alias repair so existing users are not broken.
- `list_allowed_models` should include explicit config status when the default config model is repaired at runtime:
  - `default_model_configured`
  - `default_model_effective`
  - `default_model_repaired`
  - `config_migration.command: "npm run config:migrate"` when migration is applicable
- Do not run the migration automatically from server startup, tests, or `list_allowed_models`.

Tests:

- stale alias config is rewritten to the canonical allowed model by the migration script using a temp `SUBAGENT007_CONFIG_PATH`.
- already canonical config is unchanged using a temp `SUBAGENT007_CONFIG_PATH`.
- unknown or unsupported model is not rewritten silently using a temp `SUBAGENT007_CONFIG_PATH`.
- invalid JSON produces a nonzero exit and does not overwrite the file.
- `list_allowed_models` exposes migration guidance when runtime alias repair occurs.

Documentation:

- Add a short config maintenance note to `README.md`.
- State that `config:migrate` is operator-controlled and does not run automatically.

Acceptance:

- The stale default-model condition becomes directly actionable.
- Runtime remains backward compatible, while operational drift can be removed intentionally.

### Unit 5: Campaign-Scoped Observability State

SAF: observed trials must carry campaign identity and isolate ledger state by construction.

Files touched or verified:

- `src/failureLog.ts`
- `scripts/archive-failure-log.mjs`
- `scripts/run-observed-campaign.mjs`
- `src/output.ts`
- `src/runTask.ts`
- `src/inputMailbox.ts`
- `src/runSubagent.ts`
- `tests/failure-log.test.ts`
- `tests/archive-failure-log.test.ts`
- `tests/observed-campaign.test.ts`
- `README.md`

Implementation:

- Add optional campaign metadata to failure records:
  - environment variable: `SUBAGENT007_CAMPAIGN_ID`
  - record field: `campaign_id`
- Validate campaign IDs as short, nonempty diagnostic tokens. The campaign harness must reject invalid IDs. The failure logger should omit invalid IDs rather than making tool execution fail.
- Extend archive summaries with a `by_campaign_id` group. Records without a campaign ID should be grouped as `uncategorized`.
- Add `scripts/run-observed-campaign.mjs` as the standard entrypoint for future real-use trial campaigns.
- The harness should:
  - create a unique campaign ID when one is not supplied,
  - create a private campaign state root when one is not supplied,
  - create a campaign-scoped failure ledger under that state root,
  - set `SUBAGENT007_FAILURE_LOG_PATH`,
  - set `SUBAGENT007_RUNS_DIR`,
  - set `SUBAGENT007_RUN_TASKS_DIR`,
  - set `SUBAGENT007_INPUT_REQUESTS_DIR`,
  - set `SUBAGENT007_SESSIONS_DIR`,
  - set `SUBAGENT007_PI_RAW_SESSIONS_DIR`,
  - set `SUBAGENT007_CAMPAIGN_ID`,
  - run the selected probe command,
  - print the campaign ID, state root, ledger path, archive path if archived, and command exit code.
- The harness must not write to production state directories or the production failure ledger unless the operator explicitly passes those paths.

Tests:

- forced failure with `SUBAGENT007_CAMPAIGN_ID` writes `campaign_id`.
- invalid campaign ID is omitted or rejected at the harness boundary, depending on entrypoint.
- archive summary groups records by campaign ID.
- campaign harness uses isolated runs, run-tasks, input-requests, sessions, raw-session, and ledger paths by default.
- production ledger fingerprint is unchanged by a default harness probe.
- campaign harness preserves the child command exit code.

Documentation:

- Add a short observed-trials section to `README.md` explaining the campaign harness.
- Future trial reports should include campaign ID, state root, and ledger path.

Acceptance:

- New observed campaigns can be attributed without reading global state.
- Production state directories and the global ledger are no longer the default sinks for trial-induced failures.

## Sequencing

1. Implement Unit 1 first because it removes the known destructive CLI mode bug and gives safer archive behavior for later tests.
2. Implement Unit 2 next because it stabilizes the test suite before schema and observability changes expand coverage.
3. Implement Unit 3 after the partial-output tests are stable, then update all direct MCP fixture calls that exercise `run_subagent`.
4. Implement Unit 4 once schema churn is complete, because it touches server metadata and README examples adjacent to Unit 3.
5. Implement Unit 5 last, reusing the safer archive tests and summary format from Unit 1.
6. Run the full verification suite and only then perform optional manual checks against the real default config or production ledger.

## Verification Plan

Automated:

- `npm run typecheck`
- `npm test`
- `npm run failure-log:archive -- --help` with a temp `SUBAGENT007_FAILURE_LOG_PATH`
- `SUBAGENT007_CONFIG_PATH=<temp-config> npm run config:migrate`
- observed-campaign harness test command with a temp state root and ledger

Manual MCP smoke tests:

- `list_allowed_models` returns model allowlist and, when applicable, config migration guidance.
- `run_subagent` without `run_kind` is rejected by schema validation.
- `run_subagent` with `run_kind: "quick_noninteractive"` works for a trivial fake or safe real prompt.
- `start_run` plus `get_run` remains the recommended path for longer work.

Operational checks:

- Do not mutate the user's default config unless explicitly approved.
- Before and after any manual archive check, verify the production ledger path and file size.
- Record campaign ID, state root, and ledger path in any future observed-use report.

## Traceability Matrix

| SAF | Root incoherence removed | Primary code change | Primary tests | Residual risk |
| --- | --- | --- | --- | --- |
| SAF-1 | CLI intent was inferred after mutation-capable setup | `scripts/archive-failure-log.mjs` parses mode first | `tests/archive-failure-log.test.ts` | Low: shell users may still run no-arg archive intentionally |
| SAF-2 | Semantic output classification was coupled to timeout races | pure partial-output helper and narrowed timeout tests | `tests/run-subagent.test.ts`, `tests/timeout-budget.test.ts` | Low: child process timing still tested once for lifecycle |
| SAF-3 | Synchronous one-shot API advertised no workload contract | required `run_kind` on `run_subagent` schema | `tests/run-subagent.test.ts` | Medium: existing clients must add one literal field |
| SAF-4 | Stale config aliases were repaired invisibly at runtime | explicit migration script and metadata guidance | `tests/config-migrate.test.ts`, `tests/run-subagent.test.ts` | Low: migration remains operator-controlled by design |
| SAF-5 | Trial evidence lacked first-class campaign state | campaign env, failure-log field, isolated state-root harness | `tests/failure-log.test.ts`, `tests/observed-campaign.test.ts` | Low: older records remain uncategorized |

## Cohesion Check

- Each implementation unit maps to exactly one final SAF, but units share existing primitives rather than inventing parallel systems.
- Unit 1 and Unit 5 intentionally meet at archive summaries; the archive script becomes both safer and more informative without a second summarizer.
- Unit 2 and Unit 3 both touch `run_subagent`, but they separate concerns: Unit 2 governs result semantics after execution, while Unit 3 governs admission to the synchronous public API.
- Unit 4 keeps runtime compatibility while adding an explicit operational exit from stale config state. This avoids a breaking migration hidden inside unrelated MCP calls.
- The plan keeps all new state either in temp paths, explicit config paths, or existing state-directory and failure-log env mechanisms. No new daemon, database, or branch is required.
- The acceptance gates cover code behavior, public MCP schemas, documentation, and operational safety. There is no SAF without at least one automated test and one observable acceptance condition.

## Completion Criteria

The implementation is complete when:

1. All five SAF units are implemented.
2. `npm run typecheck` and `npm test` pass.
3. Public MCP schemas and README examples agree on the `run_subagent` contract.
4. Archive help and invalid args are proven side-effect free.
5. Config migration is available but not automatically applied.
6. Observed trial reports can cite a campaign ID, isolated state root, and isolated ledger path.
