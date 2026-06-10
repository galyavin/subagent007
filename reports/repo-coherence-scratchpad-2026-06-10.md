# Repo Coherence Scratchpad - 2026-06-10

## F001 - Baseline Worktree State

Observed while establishing the audit baseline: the repository is on `main` and has unstaged implementation/documentation changes from the prior repair pass, plus untracked `docs/` and `reports/` artifacts. This is not itself a defect, but it constrains the audit: repairs must preserve the current worktree and treat those artifacts as intentional unless inspection shows they are stale or contradictory.

## F002 - Stale: Transcript Metadata Can Outrun Persisted Transcript Content

Observed while inspecting `src/transcript.ts` and `src/output.ts`: `preparePublicTranscriptFromProcessOutput` derives `hasAssistantText`, `hasSubagentWarning`, and `hasSubagentError` from pre-truncation public lines, then returns a truncated text artifact. With a very small `SUBAGENT007_MAX_TRANSCRIPT_BYTES`, the persisted artifact can be reduced to the truncation marker while metadata still says public child content exists. That weakens the repaired `partial_output_available` invariant because it is supposed to describe useful public content in the output artifact, not only content that existed before truncation.

Status: stale after reinspection. Current `src/transcript.ts` and `src/output.ts` compute flags from rendered persisted text.

## F003 - Stale: Named Session Schema Accidentally Exposes Raw Continuity

Observed while comparing `src/server.ts`, `src/session.ts`, and the README: the schema refactor made `run_subagent_session` spread the timed run shape, which includes raw `continuity`. Named sessions are governed by `session_key` and `resume_mode`; `runSubagentSession` builds fresh/resume continuity internally from the manifest and ignores caller raw continuity. Advertising or accepting that field creates a misleading control surface and can force irrelevant resume-session validation before the field is discarded.

Status: stale after reinspection. Current `src/server.ts` builds `run_subagent_session` from `timedSessionInputSchema`, which does not include `continuity`.

## F004 - Repaired: Historical Reports Can Read As Current Defects

Observed while inspecting `reports/observed-real-use-trials-2026-06-10.md` and `reports/saf-stress-test-2026-06-10.md`: both are useful evidence artifacts, but their issue descriptions and SAF classifications describe the pre-repair state. Without a status note, readers can interpret already-repaired schema, packet, and partial-output defects as current repo behavior, contradicting `README.md`, source, and tests.

Status: repaired for the originally named historical reports; those files now have historical status notes.

## F005 - Stale: Package Dry Run Includes Audit Artifacts

Observed while running `npm pack --dry-run`: the package tarball would include `reports/` and `docs/plans/`, including the scratchpad ledger and historical audit reports. Those files are useful in the repository, but they are not runtime/package artifacts and include local investigation context. Shipping them would add semantic waste to the package surface.

Status: stale after reinspection. Current `.npmignore` excludes `docs/plans/` and `reports/`, and `npm pack --dry-run` confirms they are not included.

## F006 - Scratchpad Contains Stale Findings From A Prior Pass

Observed while verifying the existing scratchpad against current `src/transcript.ts`, `src/output.ts`, `src/server.ts`, and `src/session.ts`: F002 and F003 describe issues that are not present in the current source. Transcript content flags are computed from rendered/truncated output, and `run_subagent_session` no longer exposes raw `continuity` in its schema. The scratchpad needs status markers so prior findings do not read as active defects.

## F007 - Scratchpad Package-Surface Finding Is Also Stale

Observed while rerunning `npm pack --dry-run`: the current package tarball contains `README.md`, `package.json`, `dist/`, and `scripts/`, but not `reports/` or `docs/plans/`. F005 describes an older package surface and now contradicts the actual dry-run result. The scratchpad needs status markers for stale findings instead of leaving them indistinguishable from active defects.

## F008 - Ignored Finder Metadata Present In Repo Root

Observed while checking ignored files: a root `.DS_Store` exists and is ignored by git. It is not a tracked repository defect, but it is local semantic waste in the inspected repo directory and can be removed without changing product behavior.

Status: repaired by removing the ignored local `.DS_Store` file.

## F009 - Campaign Harness Archive Step Is CWD-Fragile

Observed while inspecting `scripts/run-observed-campaign.mjs`: the harness invokes `scripts/archive-failure-log.mjs` through a relative path inside `archiveFailureLog`. This works from the repo root and from npm scripts, but direct absolute-path invocation of the harness from another cwd would make `--archive` look for a non-existent `scripts/` directory in the caller cwd. The archive helper should resolve the sibling script from `import.meta.url`.

Status: repaired by resolving the archive script from `import.meta.url` and adding a regression that runs the harness from a temp cwd.

## F010 - New SAF Decision Artifacts Still Read As Pre-Implementation

Observed while scanning `reports/current-observed-real-use-trials-2026-06-10.md`, `reports/saf-adversarial-stress-test-2026-06-10.md`, `reports/coherent-revised-saf-set-2026-06-10.md`, and `docs/plans/coherent-revised-saf-implementation-plan-2026-06-10.md`: several status lines were true when written but now coexist with implemented source/tests. The plan still says `ready_for_implementation`, and the campaign report still says `current campaign report`. These are low-risk documentation contradictions that can be repaired with top-of-file status updates.

Status: repaired by marking the plan implemented and the relevant reports historical/implemented decision artifacts.

## F011 - Config Migration Leaves Whitespace-Only Noncanonical Defaults Unchanged

Observed while inspecting `scripts/migrate-config.mjs`: the idempotence check compares `canonicalModel` to `defaultModel.trim()`. A config value such as `" openrouter/deepseek/deepseek-v4-pro "` resolves to the canonical model but is reported `unchanged`, leaving noncanonical whitespace in persisted config. The migration boundary should rewrite whenever the persisted string differs from the canonical string.

Status: repaired by comparing the canonical model against the persisted string exactly and adding a whitespace canonicalization regression.

## F012 - Typo In Campaign-State SAF Report

Observed while scanning report text for stale or distorted references: `reports/coherent-revised-saf-set-2026-06-10.md` says `SKD-launched probes` where the intended term is `SDK-launched probes`. This is low-risk semantic waste in a decision artifact.

Status: repaired by correcting the report typo.

## F013 - `test:local` Omits New Test Files

Observed while comparing `package.json` scripts with the current test directory: `npm test` runs `tests/*.test.ts`, but `test:local` still enumerates the older pre-repair set and omits `tests/archive-failure-log.test.ts`, `tests/config-migrate.test.ts`, and `tests/observed-campaign.test.ts`. A local verification alias should not silently skip the newly added SAF coverage.

Status: repaired by changing `test:local` to use `tests/*.test.ts`, matching `npm test`.

## F014 - MCP Schemas Can Strip Unsupported Session Fields Before Runtime Validation

Observed while comparing `src/server.ts` and `src/validate.ts`: runtime validation rejects top-level `session_id` and `continuity.session_id` outside `mode:"resume"`, but `start_run` uses a non-strict object shape and the nested `continuity` branches are non-strict Zod objects. Through the MCP schema layer, unsupported fields can be stripped before `validateAndResolveRequest` sees them, turning an invalid request into an unintended ephemeral/fresh run.

Status: repaired by making `continuity` variants strict, making `start_run` strict, and adding MCP regression tests that prove unsupported session fields reject before child invocation.
