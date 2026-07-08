---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
last_updated: 2026-07-08
---

# Architecture

## System Overview
MCP client calls `dist/server.js` -> `src/server.ts` validates tool input and maps semantic rejections.
Run requests go through config/model/skill validation, then `src/runTask.ts` creates a durable run state keyed by `run_id`.
When configured, `src/activeChildLease.ts` acquires a local active-child lease before task registration can launch child work.
`src/runSubagent.ts` writes a Pi child request file, then `src/processRunner.ts` spawns and supervises the child process.
Child output becomes file-backed artifacts through `src/output.ts`, sanitized public events through run-event helpers, and failure records through `src/failureLog.ts`. Requested `final` output succeeds only when the child writes a final message; a clean exit without that artifact is classified as `missing_final_output`, with transcript output retained as diagnostics.
Server-authored prompt provenance uses `src/prompt.ts` to project caller prompt text to a redacted public marker before it reaches public event views or transcript artifacts; child execution still receives the real composed prompt.
Server-launched children receive a private recursive control payload in the child request file. `src/piChild.ts` exposes it only as a native `delegate` tool; `src/recursiveControl.ts` validates the private token and recursion depth, then `src/runTask.ts` validates caller lineage against active parent run state before the parent scheduler creates a descendant. Parent run views project recursive child lifecycle through sanitized `recursive_child_started` and `recursive_child_finished` public events so callers can see descendant start and terminal status/success without reading private recursive-control payloads.
`get_run`, `answer_run_input`, and `cancel_run` operate on local filesystem-backed run snapshots and input mailbox records.
Operation-only semantic failures from those run-operation tools project as `kind:"operation_rejected"` instead of MCP text errors; child-invocation preflight failures remain `kind:"preflight_rejected"` with `child_started:false`.
Named sessions add `src/session.ts` manifest/ledger/lock handling around the same child execution path. Manifest eligibility failures known before launch, such as missing `require_existing` sessions, reject before durable task registration with `preflight_rejected` and `child_started:false`; locked execution checks still run later as race protection.

## Key Components
- `server.ts` - MCP tool surface, schema/preflight rejection shape, retry guidance, and failure logging for handler-level failures.
- `runTask.ts` - durable task lifecycle, snapshots, background execution, cancellation, caller input closure, promotion from one-shot, and active-child lease release.
- `runTask.ts` also records recursive lineage metadata: `parent_run_id` for descendants, `root_run_id`, `recursion_depth`, direct `child_run_ids`, and parent public events for recursive child start/finish.
- `runSubagent.ts` - child request-file contract, Pi child invocation, transcript/final-output handling, missing-final classification, timeout metadata, provider error parsing, recursive control payload injection, and skill audit metadata.
- `recursiveControl.ts` / `recursiveDelegateTool.ts` - private local IPC and child-facing `delegate` tool for recursive Subagent007 calls; the child tool is a client, not an owner of durable task state.
- `processRunner.ts` - detached child process execution, timeout/cancel termination, heartbeat notifications, and parent-exit process-group cleanup.
- `session.ts` - named-session manifests, read-only preflight eligibility checks, candidate ledgers, packet policy, skill/cwd immutability, and local session locks. Required packet failures distinguish missing, malformed, and parse-valid not-ready packets by reason code.
- `runtimeReadiness.ts` - built-entrypoint, source-state, contract, and public-tool readiness checks.

## External Dependencies
- Pi agent/runtime - child execution backend; Pi auth and model config must be visible to the MCP server process.
- Model providers via Pi/OpenRouter/Ollama inventory probes - reconciled by scripts, but concrete model ids and thinking levels are internal calibration behind public model classes.
- `@modelcontextprotocol/sdk` - public server/client protocol for tool listing and tool calls.
- Local filesystem - durable run snapshots, failure logs, input mailbox, sessions, model health, and active-child leases live under the state root.
- Git/source tree - runtime readiness can fail closed on dirty, unknown, or stale built source state.

## What Does NOT Exist Here
- No queue behind local capacity rejection; exhausted active-child capacity returns `preflight_rejected` with `child_started:false`.
- No database, remote worker service, or distributed lock manager; persistence and locks are local files.
- No public concrete model or thinking-level input, result field, failure-log field, session ledger field, or README calibration table; callers use model classes and class-level health/migration guidance.
- No tool restriction by `tool_profile`; accepted legacy profile values resolve to all child tools.
- No full recursive descendant tree manager or cascade cancellation; the first recursive slice is one child-facing delegate tool plus direct lineage metadata.
- No exposure of raw thinking, private tool payloads, caller prompt text, full composed prompts, or input answer values in public event views.
