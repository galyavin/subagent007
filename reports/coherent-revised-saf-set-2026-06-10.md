# Coherent Revised SAF Set - 2026-06-10

Status: implemented superseding SAF decision record. This document replaces the provisional final SAF set in `reports/current-observed-real-use-trials-2026-06-10.md` after adversarial stress testing in `reports/saf-adversarial-stress-test-2026-06-10.md`.

No runtime code changes were made while writing this document. The selected SAFs were implemented afterward in the current worktree.

## Repair Rule Applied

The stress test showed that the prior set mixed true root-cause fixes with useful but incomplete guardrails. This revised set keeps only fixes that change the relevant upstream boundary, primitive, or authority rule. When a previously selected item was merely advisory, optional, or post-failure, it is either replaced with a stronger SAF or demoted to a supporting guardrail.

Classification terms:

- **True SAF**: smallest sufficient upstream change that removes the HORC under the relevant authority boundary.
- **Asymptotic SAF**: useful and close, but still incomplete, indirect, optional, or timing/discipline dependent.
- **Supporting guardrail**: valuable implementation detail that is not itself a SAF.

## Final Set Summary

| ID | HORC | Final SAF | Classification | Priority |
| --- | --- | --- | --- | --- |
| SAF-1 | CLI intent is not modeled before mutation | Classify CLI invocation mode before any archive filesystem action; help and invalid modes exit without mutation | **True SAF** | P1 |
| SAF-2 | Semantic timeout metadata is tested through wall-clock process races | Move semantic partial-output classification into pure deterministic tests; leave process timeout tests to lifecycle mechanics only | **True SAF** | P1 |
| SAF-3 | Generic synchronous one-shot tool has no pre-execution workload contract | Add a mandatory quick-workload contract to the synchronous tool boundary; broad/interactive/long work is rejected before child spawn and routed to `start_run` | **True SAF, with caller-intent boundary noted** | P2 |
| SAF-4 | Config compatibility repair is runtime-only | Add explicit config migration as the canonicalization boundary; after migration, persisted config is canonical and runtime default-model repair is no longer the steady-state path | **True SAF if migration is executed; otherwise asymptotic** | P2 |
| SAF-5 | Observed-use campaigns rely on a global production failure ledger | Make campaign state/ledger isolation a required trial-harness primitive instead of optional record annotation | **True SAF for observed-trial attribution** | P3 |

## SAF-1: Archive Invocation Mode Before Mutation

### HORC

`scripts/archive-failure-log.mjs` currently has only one implicit mode: archive now. It does not model caller intent before filesystem mutation, so `--help` or any unknown flag can still move the active failure ledger.

### Final SAF

Parse and classify `process.argv.slice(2)` before computing archive destinations or calling any mutating filesystem operation.

Accepted modes:

- `help`: `--help` or `-h`; print usage and exit 0.
- `archive`: no arguments; preserve current archive behavior.
- `invalid`: any unknown argument; print usage/error and exit 2.

### Exact Invariant

No invocation containing any CLI argument may call `fs.rename`, `fs.writeFile`, or `fs.mkdir` for archive state unless that argument set has been explicitly classified as an accepted mutating mode.

For the current script, the only accepted mutating mode is no arguments.

### Intraframe Candidate

Inline argument parsing at the top of `scripts/archive-failure-log.mjs`, before `const logPath = defaultFailureLogPath()`.

### Transframe Candidate

Move all operational scripts behind a shared CLI framework with generated help, dry-run support, and mutation gates.

### Selected Candidate

Intraframe. The issue is local and caused by a missing invocation-mode boundary in one script. A shared framework would be more uniform, but not smaller or necessary.

### Pseudo-SAFs Rejected

- Add README warning.
- Add a `--help` special case but continue ignoring all other flags.
- Print a clearer archive result after mutating.

### Validation

- With a temp `SUBAGENT007_FAILURE_LOG_PATH`, `node scripts/archive-failure-log.mjs --help` exits 0 and leaves the log in place.
- `node scripts/archive-failure-log.mjs -h` exits 0 and leaves the log in place.
- `node scripts/archive-failure-log.mjs --unknown` exits 2 and leaves the log in place.
- `node scripts/archive-failure-log.mjs` still archives and writes a summary.

## SAF-2: Deterministic Semantic Boundary For Partial Output

### HORC

The partial-output invariant is semantic, but the current regression test proves it through small wall-clock process-timeout windows. That allows event emission, stdout flush, timeout, and child termination scheduling to determine whether a semantic classifier appears correct.

### Final SAF

Move the semantic proof to deterministic pure tests over the transcript/output classification boundary. Keep process-timeout integration tests only for lifecycle mechanics: timeout marker, hard-cap timing, child termination, and metadata propagation shape.

### Exact Invariant

Tests for whether public child-generated content exists must not require a real timeout, child process kill, or wall-clock race.

The semantic invariant is:

```ts
partialOutputAvailable =
  timedOut &&
  (
    Boolean(finalMessage) ||
    output.hasPublicAssistantText ||
    output.hasPublicSubagentWarning ||
    output.hasPublicSubagentError
  );
```

The transcript/output classifiers must be tested directly with fixed input strings/events.

### Intraframe Candidate

Add deterministic tests for `preparePublicTranscriptFromProcessOutput`, `publicTranscriptContentFlags`, and a small extracted helper for partial-output decision composition. Reduce timeout integration tests to process-runner behavior and one propagation smoke.

### Transframe Candidate

Introduce a controllable fake process runner or fake clock so timeout integration tests can be fully deterministic end to end.

### Selected Candidate

Intraframe with helper extraction. It removes the actual semantic race. A fully fake process runner is cleaner for all timeout tests, but larger than required for the observed HORC.

### Why This Is Now A True SAF

The previous version said "generous integration margins," which remained timing-dependent. The repaired SAF changes what authority proves the invariant: pure classifier tests prove semantic content, while process tests prove process behavior.

### Pseudo-SAFs Rejected

- Retry failed tests in CI.
- Only increase the timeout from 120 ms to a larger value.
- Delete the `partial_output_available` assertions.

### Validation

- Direct classifier tests cover assistant event, warning event, error event, final message, raw text, user-only event, timeout marker, cancellation marker, and truncation marker.
- A direct decision helper test covers final message plus output flags.
- Timeout integration test no longer asserts every semantic content class through child-process timing.
- Repeated timeout suite runs do not reproduce the original flake.

## SAF-3: Mandatory Quick-Workload Contract For Synchronous Runs

### HORC

The public synchronous tool is named and shaped as a generic subagent runner while actually having a fixed one-shot deadline and no caller-input loop. This exposes broad repo-scale work as an apparently valid synchronous action, with feedback arriving only after a wasted timeout.

### Final SAF

Make bounded quick workload an explicit pre-execution contract of the synchronous tool. A call must declare that it is quick, non-interactive, and deadline-compatible before the child process is spawned. Broad, interactive, long-running, or undeclared work must fail validation and route to `start_run`.

### Exact Invariant

For the public synchronous tool:

1. The input schema includes a required workload contract field, for example:

   ```ts
   run_kind: "quick_noninteractive"
   ```

2. Omitted, unknown, broad, interactive, or long-running run kinds fail at schema/validation time before child spawn.
3. The rejection message names the correct replacement path: `start_run` with `timeout_ms` for longer, cancellable, polling, or caller-input work.
4. The synchronous tool still enforces its internal deadline.

### Intraframe Candidate

Add a required literal/enum workload contract field to `run_subagent`, update README/tool descriptions, and add schema rejection tests.

### Transframe Candidate

Remove the public synchronous tool entirely and expose only async `start_run` plus named sessions, keeping `runSubagent` as an internal implementation function.

### Selected Candidate

Intraframe, with the explicit boundary note that this fixes caller-declared workload authority, not perfect semantic intent inference. It is the least-motion fix that moves complexity feedback before child spawn.

### Why This Replaces The Prior Pseudo-SAF

Docs and timeout hints are post hoc. A required workload contract changes the public API boundary. A broad synchronous run is no longer silently accepted as ordinary work; it is either declared quick or rejected before execution.

### Limits

No schema can prove that a caller's prompt is truly quick. The SAF removes the system's ambiguity, not caller dishonesty or model misuse. If stronger enforcement is required later, the transframe candidate is to remove the public synchronous tool.

### Supporting Guardrails

- Timeout recovery hint remains useful, but is not the SAF.
- README examples should emphasize quick exact-output or bounded review prompts.
- Tool description should say "quick, non-interactive" in the first sentence.

### Validation

- `listTools()` shows the workload contract field for the synchronous tool.
- A synchronous call without `run_kind` returns `isError: true` before child spawn.
- A synchronous call with `run_kind: "quick_noninteractive"` and a small exact-output prompt succeeds.
- A call declaring broad/interactive/long work is rejected and points to `start_run`.
- Existing `start_run` and `run_subagent_session` behavior remains unchanged.

## SAF-4: Explicit Config Canonicalization Boundary

### HORC

Known model alias repair currently happens at runtime. The server can execute with a repaired model while the persisted config still contains stale state, so persisted configuration and effective runtime behavior diverge.

### Final SAF

Add an explicit config canonicalization mechanism and make canonical config the steady-state invariant. Known stale default-model aliases are migrated atomically under explicit operator intent; runtime alias repair remains only as a compatibility detector, not the normal execution path.

### Exact Invariant

After the config migration has run successfully:

1. `config.json.default_model` is a canonical allowed model ref.
2. `list_allowed_models.default_model_repaired` is false.
3. Ordinary execution does not depend on known-alias repair for the default model.
4. If a stale alias is detected before migration, the system exposes an exact migration command or fails with a precise repair instruction rather than hiding the divergence.

### Intraframe Candidate

Add a `config:migrate` script that:

- Reads `SUBAGENT007_CONFIG_PATH` or the default config path.
- Applies `repairKnownModelAlias` only to known safe aliases.
- Writes atomically with a backup or temp-file rename.
- Is idempotent.
- Reports changed/unchanged status.

Update `list_allowed_models` to return a `config_migration` object when `default_model_repaired` is true.

### Transframe Candidate

Introduce versioned config schema migrations in `loadConfig`, with explicit migration records and rollback metadata.

### Selected Candidate

Intraframe plus execution of the migration for the current stale config when implementing this SAF. A full schema migration framework is more general but not required for one known alias family.

### Classification

**True SAF if the migration is part of the repair and is run for the current config.** Merely adding a suggestion to `list_allowed_models` remains asymptotic.

### Pseudo-SAFs Rejected

- Keep silent runtime repair and only add documentation.
- Add a suggestion but no executable migration path.
- Remove runtime repair abruptly without an explicit migration path.

### Validation

- With stale config, `npm run config:migrate` rewrites the alias atomically.
- Running `npm run config:migrate` again reports unchanged.
- After migration, `list_allowed_models.default_model_repaired === false`.
- Execution with the default model still succeeds.
- A fixture with an unknown alias is not rewritten silently.

## SAF-5: Campaign-Scoped Observability State For Observed Trials

### HORC

Observed-use campaigns currently read and mutate the global production failure ledger. Records from unrelated background activity can mix with campaign records, and campaign edge probes can mutate production observability state.

### Final SAF

Make isolated campaign state a required primitive of observed-use trials. A trial campaign must create and use a campaign-scoped failure ledger and state root for all scripted/SDK-launched probes, and reports must summarize that scoped ledger rather than the global production ledger.

### Exact Invariant

For a recorded observed-use campaign:

1. The campaign has a stable `campaign_id`.
2. The campaign has its own failure ledger path.
3. All campaign-controlled MCP server launches or SDK probes receive that ledger path through environment.
4. Reports summarize the campaign ledger, not the default production ledger.
5. If the live installed MCP server cannot be launched with campaign env, that limitation is explicitly recorded and those records are not treated as clean campaign telemetry.

### Intraframe Candidate

Add a lightweight campaign harness script or documented command wrapper that creates a campaign directory and exports:

- `SUBAGENT007_FAILURE_LOG_PATH`
- `SUBAGENT007_RUNS_DIR`
- `SUBAGENT007_RUN_TASKS_DIR`
- `SUBAGENT007_INPUT_REQUESTS_DIR`
- `SUBAGENT007_SESSIONS_DIR`
- `SUBAGENT007_RECORD_CONTEXT` or `SUBAGENT007_CAMPAIGN_ID`

Then run SDK-based campaign probes through that harness.

### Transframe Candidate

Move observability into a queryable store with first-class run, session, campaign, and source dimensions.

### Selected Candidate

Intraframe campaign harness. The optional record-context field is useful metadata, but the true boundary fix is state isolation by default for campaigns.

### Why This Replaces The Prior Asymptotic SAF

An optional context field improves filtering only when propagated correctly. A campaign-scoped ledger prevents unrelated production records from entering the campaign dataset in the first place.

### Limits

Live MCP calls made through an already-running installed server may still write to that server's configured ledger. Those probes can be used as live behavior evidence, but not as clean campaign-ledger evidence unless the server was launched under the campaign harness.

### Supporting Guardrails

- Add optional `campaign_id` to failure records for cross-checking.
- Extend archive summaries with `by_campaign_id`.
- Keep default production ledger behavior for normal server use.

### Validation

- A campaign harness creates a unique campaign directory.
- A forced failure during a harness-launched SDK probe writes only to the campaign ledger.
- The production ledger fingerprint is unchanged by harness probes.
- Campaign report summary reads the campaign ledger.
- Records include `campaign_id` when present and group missing context separately.

## Revised Implementation Order

1. **SAF-1 archive invocation mode**
   - Smallest, highest-risk operational fix.
   - Add tests before/after the script change.

2. **SAF-2 deterministic timeout semantics tests**
   - Stabilizes the verification floor before deeper API work.
   - Extract any needed pure helper before changing assertions.

3. **SAF-3 synchronous workload contract**
   - Public API change; update tests, README, and MCP schema expectations together.
   - Keep compatibility risk explicit because existing callers must add the workload contract field.

4. **SAF-4 config canonicalization**
   - Add migration script and tests.
   - Run the migration for the current stale default config only under explicit operator approval.

5. **SAF-5 campaign-scoped observability**
   - Add harness/record context after the core product boundary fixes.
   - Use it for future observed real-use campaigns.

## Coherent Non-Goals

- Do not silently mutate config during ordinary `list_allowed_models`.
- Do not pretend timeout partials are useful; the field only means public child content exists.
- Do not use prompt heuristics as the primary guard for broad synchronous work.
- Do not remove failure logging or production ledgers.
- Do not change packet-policy semantics; live required ready/blocked behavior is already coherent.

## Acceptance Gate For The Full Set

The repaired set is implemented only when all of these are true:

- Archive `--help` and unknown flags are non-mutating.
- Timeout semantic tests are deterministic and no longer prove content classes through child kill timing.
- Synchronous public calls require an explicit quick-workload contract and reject undeclared/broad modes before spawn.
- Known stale default-model config can be migrated atomically, and the current config no longer reports `default_model_repaired: true` after migration.
- Observed-use campaigns can run against a campaign-scoped ledger without changing the production ledger.

## Final Classification

| ID | Final Classification | Reason |
| --- | --- | --- |
| SAF-1 | **True SAF** | Directly fixes the invocation-mode primitive before mutation. |
| SAF-2 | **True SAF** | Reassigns semantic proof to deterministic semantic code, not timing. |
| SAF-3 | **True SAF within caller-declared intent authority** | Moves workload classification before execution; stronger semantic enforcement would require removing the sync tool. |
| SAF-4 | **True SAF if migration is executed; asymptotic if only suggested** | The invariant is persisted canonical config, not better messaging. |
| SAF-5 | **True SAF for campaign attribution** | Isolated campaign state prevents global-ledger mixing instead of merely labeling it afterward. |
