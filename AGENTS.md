---
name: agents
description: Always-loaded project anchor. Read this first. Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.
last_updated: 2026-06-30
---

# Subagent007 Pi

## What This Is
A private MCP server that delegates work to a separate Pi-backed child agent through one-shot, durable run, and named-session tools.

## Non-Negotiables
- Always work on `main`; do not create branches unless explicitly instructed.
- Keep public MCP result fields, reason codes, durable-run statuses, and failure-log schema changes synchronized across source, tests, and README.
- Do not parse or expose private thinking/tool payloads in public events, transcripts, failure logs, or run views.
- Preflight validation must reject before child launch and report `child_started:false`.
- Run `npm run build` after changing `src/` before runtime or MCP-server checks.
- Do not set `SUBAGENT007_PI_CHILD_PATH` for normal MCP use; it is for tests and controlled probes.

## Commands
- Clean build output: `npm run clean:dist`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Local test alias: `npm run test:local`
- Docs/runtime fact check: `npm run docs:check`
- Runtime readiness: `npm run runtime:readiness`
- Config migration: `npm run config:migrate`
- Model reconciliation: `npm run models:reconcile`
- Model health probe: `npm run model-health:probe -- --model-class C --cwd /absolute/project/path`
- Observed campaign harness: `npm run observed-campaign`
- Observed MCP probe: `npm run observed-mcp-probe`
- Failure-log archive: `npm run failure-log:archive`
- Project memory check: `mex check`
- Project memory sync: `mex sync`
- Project memory log: `mex log`

## After Every Task
After meaningful work, run GROW:
- Ground: what changed in reality?
- Record: update `.mex/ROUTER.md` and relevant `.mex/context/` files
- Orient: create or update a `.mex/patterns/` runbook if this can recur
- Write: bump `last_updated` on changed scaffold files and run `mex log` when rationale matters

## Navigation
At the start of every session, read `.mex/ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.
