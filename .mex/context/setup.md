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
last_updated: 2026-07-13
---

# Setup

## Prerequisites
- Node.js `>=22.19.0`.
- npm, using the committed `package-lock.json`.
- Pi-compatible model/auth configuration visible to the MCP process. Normal MCP execution uses the bundled `@earendil-works/pi-*` dependencies; a separate `pi` CLI is optional inventory input for `npm run models:reconcile`.
- `mex` CLI for project memory checks and logs.

## First-time Setup
1. Run `npm ci`.
2. Run `mex setup` when project memory has not been initialized in this environment.
3. Ensure Pi-compatible auth/model configuration is visible in the environment that will launch the MCP server.
4. Optionally create `~/.codex/subagent007-pi/config.json` to override or explicitly pin the default `{"default_model_class":"C"}` policy.
5. Run `npm run build`.
6. Run `npm test`.
7. Register the built server with Codex using `codex mcp add subagent007-pi -- node "$(pwd)/dist/server.js"`.

## Environment Variables
- Required in practice: Pi auth/model configuration visible to the server process.
- Optional config/state paths: `SUBAGENT007_CONFIG_PATH`, `SUBAGENT007_RUNS_DIR`, `SUBAGENT007_RUN_TASKS_DIR`, `SUBAGENT007_PI_RAW_SESSIONS_DIR`, `SUBAGENT007_SESSIONS_DIR`, `SUBAGENT007_INPUT_REQUESTS_DIR`, `SUBAGENT007_FAILURE_LOG_PATH`, `SUBAGENT007_MODEL_HEALTH_PATH`, `SUBAGENT007_ACTIVE_CHILDREN_DIR`, `SUBAGENT007_QUEUED_RUNS_DIR`, `SUBAGENT007_TEMP_DIR`.
- Optional runtime/child controls: `SUBAGENT007_PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `SUBAGENT007_PI_SKILL_PATHS`, `SUBAGENT007_PI_CHILD_PATH`, `SUBAGENT007_MAX_ACTIVE_CHILDREN` (default `24`; `0` disables), `SUBAGENT007_MAX_QUEUED_RUNS` (default `96`; `0` disables queueing), `SUBAGENT007_MAX_RECURSION_DEPTH`.
- Optional timeout/progress/resource controls: `SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS`, `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`, `SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS`, `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS`, `SUBAGENT007_DEADLINE_RISK_TIMEOUT_FLOOR_MS`, `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS`, `SUBAGENT007_HEARTBEAT_INTERVAL_MS`, `SUBAGENT007_SESSION_LOCK_LEASE_MS`, `SUBAGENT007_MIN_FREE_DISK_BYTES` (default 5 GiB).
- Optional failure/campaign controls: `SUBAGENT007_FAILURE_LOG=off`, `SUBAGENT007_FAILURE_STORAGE_MAX_BYTES` (default 64 MiB; `0` disables raw failure persistence), `SUBAGENT007_BUILD_SHA`, `GIT_COMMIT`, `SUBAGENT007_RECORD_SOURCE`, `SUBAGENT007_CAMPAIGN_ID`, `SUBAGENT007_CAMPAIGN_LEDGER_PATH`, `SUBAGENT007_COVERAGE_MANIFEST_PATH`.

## Common Commands
- `npm run clean:dist` — prune inactive, unleased build releases while preserving live entrypoints.
- `npm run build` — compile a versioned release and atomically switch `dist/current` without removing live entrypoints.
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
