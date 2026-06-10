# Repo Coherence Scratchpad - 2026-06-10

## F001 - Baseline Worktree State

Observed while establishing the audit baseline: the repository is on `main` and has unstaged implementation/documentation changes from the prior repair pass, plus untracked `docs/` and `reports/` artifacts. This is not itself a defect, but it constrains the audit: repairs must preserve the current worktree and treat those artifacts as intentional unless inspection shows they are stale or contradictory.

## F002 - Transcript Metadata Can Outrun Persisted Transcript Content

Observed while inspecting `src/transcript.ts` and `src/output.ts`: `preparePublicTranscriptFromProcessOutput` derives `hasAssistantText`, `hasSubagentWarning`, and `hasSubagentError` from pre-truncation public lines, then returns a truncated text artifact. With a very small `SUBAGENT007_MAX_TRANSCRIPT_BYTES`, the persisted artifact can be reduced to the truncation marker while metadata still says public child content exists. That weakens the repaired `partial_output_available` invariant because it is supposed to describe useful public content in the output artifact, not only content that existed before truncation.

## F003 - Named Session Schema Accidentally Exposes Raw Continuity

Observed while comparing `src/server.ts`, `src/session.ts`, and the README: the schema refactor made `run_subagent_session` spread the timed run shape, which includes raw `continuity`. Named sessions are governed by `session_key` and `resume_mode`; `runSubagentSession` builds fresh/resume continuity internally from the manifest and ignores caller raw continuity. Advertising or accepting that field creates a misleading control surface and can force irrelevant resume-session validation before the field is discarded.

## F004 - Historical Reports Can Read As Current Defects

Observed while inspecting `reports/observed-real-use-trials-2026-06-10.md` and `reports/saf-stress-test-2026-06-10.md`: both are useful evidence artifacts, but their issue descriptions and SAF classifications describe the pre-repair state. Without a status note, readers can interpret already-repaired schema, packet, and partial-output defects as current repo behavior, contradicting `README.md`, source, and tests.

## F005 - Package Dry Run Includes Audit Artifacts

Observed while running `npm pack --dry-run`: the package tarball would include `reports/` and `docs/plans/`, including the scratchpad ledger and historical audit reports. Those files are useful in the repository, but they are not runtime/package artifacts and include local investigation context. Shipping them would add semantic waste to the package surface.
