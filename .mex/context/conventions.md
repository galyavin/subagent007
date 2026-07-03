---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
last_updated: 2026-07-03
---

# Conventions

## Naming
- TypeScript files use camelCase module names such as `runSubagent.ts`, `runtimeReadiness.ts`, and `activeChildLease.ts`.
- Public JSON fields and reason codes use snake_case, for example `reason_code`, `child_started`, and `local_capacity_exhausted`.
- Environment variables use the `SUBAGENT007_*` prefix except Pi-native compatibility names such as `PI_CODING_AGENT_DIR`.
- Durable run identity is `run_id`; mailbox identity is `run_id` plus `request_id`.
- Public model tiers are named model classes `A`, `B`, `C`, `D`, and `E`.

## Structure
- `src/server.ts` owns MCP registration and handler-level result shaping.
- `src/runTask.ts` owns durable task lifecycle; do not duplicate task state transitions in handlers.
- `src/runSubagent.ts` owns the Pi child request-file contract and child result projection.
- `src/types.ts` is the public type/reason-code source; update tests and README when public fields change.
- `tests/*.test.ts` are integration-heavy Node tests; helpers live in `tests/helpers/`.
- `scripts/*.mjs` are operational commands and should be documented in AGENTS/setup context when added.

## Patterns
- Semantic preflight rejection must happen before child launch and return structured content with `kind:"preflight_rejected"` and `child_started:false`.
- Run-operation semantic rejections from `get_run`, `answer_run_input`, and `cancel_run` return structured content with `kind:"operation_rejected"` and a typed `reason_code`; do not include `child_started` because the target run may already have launched.
- Public event views and transcripts must stay sanitized; never expose raw thinking, private tool payloads, caller prompt text, full composed prompts, or answer values. Use the shared public prompt projection marker instead of writing `request.prompt` into public events or transcript provenance.
- Public model calibration must stay class-level on caller surfaces: expose `model_class`/`resolved_model_class` and health/migration actions, not concrete model IDs or thinking levels in MCP results, failure logs, session ledgers, observed campaign summaries, or README.
- Required named-session packet failures use distinct reason codes: missing packet -> `packet_required_missing`, malformed packet -> `packet_required_invalid`, parse-valid not-ready packet -> `packet_required_not_ready`.
- When adding an environment variable, update source constants, README environment docs, and `npm run docs:check` coverage.
- When changing child execution, verify timeout/cancel/parent-exit cleanup because fake child descendants can otherwise outlive the test run.
- Compatibility aliases such as `list_allowed_models`, legacy `skill`, and legacy `tool_profile` are intentional unless a migration explicitly removes them.
- Observed campaign result classes must prove the caller-visible contract they name. For `tool-listing`, assert the exact public tool surface and schema guidance; do not count a generic non-error `listTools()` response as full discovery coverage.

## Verify Checklist
Before presenting code changes:
- [ ] `npm run typecheck` passes for TypeScript source/test changes.
- [ ] `npm run build` has refreshed `dist/` after `src/` edits.
- [ ] Focused tests cover the touched public behavior or failure mode.
- [ ] `npm test` passes for shared lifecycle, public schema, or child-process changes.
- [ ] `npm run docs:check` passes after README/runtime fact or env-var changes.
- [ ] Preflight failures still happen before child spawn and preserve `child_started:false`.
- [ ] Operation-only semantic failures return `operation_rejected` instead of forcing callers to parse MCP error text.
- [ ] Failure logs and public result metadata remain synchronized when reason codes or provider fields change.
