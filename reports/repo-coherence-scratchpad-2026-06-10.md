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

## F015 - Live E2E Artifacts Still Read As Pre-Implementation

Observed while inspecting the new live-e2e plan/report artifacts after the approved implementation: `docs/plans/live-e2e-coherent-saf-implementation-plan-2026-06-10.md` still has frontmatter `status: planned`, and `reports/live-e2e-skill-campaign-2026-06-10.md` still begins `Status: current observed-use campaign` even though the implemented source/tests now satisfy that plan. This is documentation-level semantic drift, not runtime behavior, but it can mislead future readers about whether the SAF set remains pending.

Status: repaired by marking the live-e2e implementation plan implemented and the live campaign report historical/pre-repair.

## F016 - README Overstates Immediacy Of Pending-Input Progress Message

Observed while comparing `README.md`, `src/runTask.ts`, and `src/runSubagent.ts`: active `get_run` status immediately becomes `input_required` when pending request files exist, but `last_progress_message` is heartbeat-derived and only names pending request ids after a heartbeat observes them. The README wording says "when pending input requests exist, the progress message names the pending request ids," which is directionally true but too absolute for the implementation timing.

Status: repaired by clarifying that status reflects pending input immediately and heartbeat progress messages name pending request ids once observed.

## F017 - Model Health Reporting Misses Whitespace-Only Config Drift

Observed while comparing `src/server.ts`, `scripts/migrate-config.mjs`, `src/modelAllowlist.ts`, and `tests/config-migrate.test.ts`: `config:migrate` intentionally rewrites a whitespace-padded but otherwise canonical `default_model`, but `list_allowed_models` computes `default_model_repaired` by comparing the effective model to `defaultModelConfigured.trim()`. That means the MCP health surface can report no migration needed for a config state that the migration command would still repair. This is a low-risk semantic drift between diagnosis and repair boundaries.

Status: repaired by comparing the effective model to the persisted configured string and adding an MCP regression for whitespace-padded defaults.

## F018 - Implemented Campaign Artifacts Mention A Dead Context Env Var

Observed while scanning implemented campaign-state decision artifacts: `reports/coherent-revised-saf-set-2026-06-10.md` still mentions `SUBAGENT007_RECORD_CONTEXT` as an implementation option, but the actual code, README, and tests use `SUBAGENT007_CAMPAIGN_ID`. In an artifact marked implemented, that stale alternative reads like a live supported environment variable.

Status: repaired by naming only the implemented `SUBAGENT007_CAMPAIGN_ID` field in the implemented decision record.

## F019 - Full Coherent SAF Plan Still Reads As Pending

Observed while scanning `docs/plans/full-coherent-revised-saf-implementation-plan-2026-06-10.md`: the plan describes work to implement the three-SAF set, but the current source and tests now contain those repairs. Unlike the older implemented plans, this file has no `status: implemented` frontmatter or status note, so it can be mistaken for an open implementation plan.

Status: repaired by adding `status: implemented` frontmatter and an explicit status note.

## F020 - New Full-HORC Report Chain Lacks Post-Implementation Status Notes

Observed while scanning `reports/observed-real-use-horc-saf-campaign-2026-06-10.md`, `reports/saf-adversarial-classification-2026-06-10.md`, and `reports/full-coherent-revised-saf-set-2026-06-10.md`: the first two describe pre-repair findings and classifications, while the third is the revised set now implemented in code. None of those files has a status note making that timeline explicit. This can make repaired defects, such as late answers after cancellation, read as current behavior.

Status: repaired by adding historical/pre-repair status notes to the source campaign and adversarial review, and an implemented decision-record status to the revised SAF set.

## F021 - Live E2E Revised SAF Set Omits Subsequent Implementation Status

Observed while scanning `reports/live-e2e-coherent-revised-saf-set-2026-06-10.md`: it correctly says no runtime code changes were made while writing the document, but companion artifacts now mark the implementation plan as implemented and the live campaign report as historical. Without a subsequent implementation note, this decision record can read as superseding but not yet realized.

Status: repaired by marking the live E2E revised SAF set as implemented and noting that implementation occurred after the document was written.

## F022 - Model Health Cannot Detect Whitespace Drift Through Normalized Config Loader

Observed while running `npm test`: the new whitespace-padding health regression failed because `list_allowed_models` receives `default_model_configured` after the config loader has already trimmed it. The migration script operates on persisted JSON, but the MCP health tool only sees normalized config, so it still cannot diagnose persisted whitespace-only drift without a raw persisted value boundary.

Status: repaired by adding a raw config-record loader, keeping runtime config normalization separate, and making `list_allowed_models` use the raw persisted `default_model` only for migration diagnostics.

## F023 - Config Normalizer Reintroduced Undefined Keys For Missing Config

Observed while rerunning `npm test` after the raw config-record repair: `loadConfig` returned `{ default_model: undefined, default_thinking_level: undefined }` for a missing config file instead of the established empty object `{}`. The raw-record boundary is correct, but the normalizer must preserve the previous sparse-object runtime contract.

Status: repaired by returning a sparse `RunnerConfig` from `normalizeConfigRecord`.
