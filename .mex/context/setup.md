---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/architecture.md
    condition: when understanding how components connect during setup
last_updated: 2026-07-08
---

# Setup

## Prerequisites
- Node.js `>=22.19.0`.
- npm, using the committed `package-lock.json`.
- A working Pi install and Pi model/auth configuration visible to the MCP process.
- `mex` CLI for project memory checks and logs.

## First-time Setup
1. Run `npm ci`.
2. Ensure `pi --list-models` works in the same environment that will launch the MCP server.
3. Optionally create `~/.codex/subagent007-pi/config.json` to override or explicitly pin the default `{"default_model_class":"C"}` policy.
4. Run `npm run build`.
5. Run `npm test`.
6. Register the built server with Codex using `codex mcp add subagent007-pi -- node "$(pwd)/dist/server.js"`.

## Environment Variables
- Required in practice: Pi auth/model configuration visible to the server process.
- Optional config/state paths: `SUBAGENT007_CONFIG_PATH`, `SUBAGENT007_RUNS_DIR`, `SUBAGENT007_RUN_TASKS_DIR`, `SUBAGENT007_PI_RAW_SESSIONS_DIR`, `SUBAGENT007_SESSIONS_DIR`, `SUBAGENT007_INPUT_REQUESTS_DIR`, `SUBAGENT007_FAILURE_LOG_PATH`, `SUBAGENT007_MODEL_HEALTH_PATH`, `SUBAGENT007_ACTIVE_CHILDREN_DIR`.
- Optional runtime/child controls: `SUBAGENT007_PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `SUBAGENT007_PI_SKILL_PATHS`, `SUBAGENT007_PI_CHILD_PATH`, `SUBAGENT007_MAX_ACTIVE_CHILDREN`, `SUBAGENT007_MAX_RECURSION_DEPTH`.
- Optional timeout/progress controls: `SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS`, `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`, `SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS`, `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS`, `SUBAGENT007_DEADLINE_RISK_TIMEOUT_FLOOR_MS`, `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS`, `SUBAGENT007_HEARTBEAT_INTERVAL_MS`, `SUBAGENT007_MAX_TRANSCRIPT_BYTES`, `SUBAGENT007_SESSION_LOCK_LEASE_MS`.
- Optional failure/campaign metadata: `SUBAGENT007_FAILURE_LOG=off`, `SUBAGENT007_BUILD_SHA`, `GIT_COMMIT`, `SUBAGENT007_RECORD_SOURCE`, `SUBAGENT007_CAMPAIGN_ID`, `SUBAGENT007_CAMPAIGN_LEDGER_PATH`, `SUBAGENT007_COVERAGE_MANIFEST_PATH`.

## Common Commands
- `npm run clean:dist` — remove built output.
- `npm run build` — rebuild `dist/` from TypeScript.
- `npm run typecheck` — check source and tests without emitting.
- `npm test` / `npm run test:local` — run the full Node test suite through the ledger guard.
- `npm run docs:check` — verify README runtime facts against source constants.
- `npm run runtime:readiness` — check the built server entrypoint and runtime contract.
- `npm run config:migrate` — migrate supported legacy model config to model classes.
- `npm run models:reconcile` — compare calibrated models with source inventories.
- `npm run model-health:probe` — record one-shot usability for a model class.
- `npm run observed-campaign` / `npm run observed-mcp-probe` — run isolated observation probes.
- `npm run failure-log:archive` — archive the configured failure log.
- `mex check`, `mex sync`, `mex log` — project memory drift, sync, and rationale notes.

## Common Issues
- **Stale build:** Runtime readiness blocks when `src/` is newer than `dist/`; run `npm run build`.
- **Dirty source blocks readiness:** Use the default clean source policy for release checks; use `--source-state-policy allow_dirty` only for exploratory local checks.
- **Missing Pi auth in MCP process:** Register through `zsh -ic "exec node ..."` if auth is loaded by shell startup files.
- **Fake child leaks into real use:** Unset `SUBAGENT007_PI_CHILD_PATH` outside tests and controlled probes.
- **Focused tests fail readiness after source edits:** Rebuild first, because direct `node scripts/run-tests-with-ledger-guard.mjs ...` does not run the package `pretest` hook.
