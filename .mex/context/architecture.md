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
last_updated: 2026-07-12
---

# Architecture

## System Overview
MCP client calls `dist/server.js` -> `src/server.ts` validates tool input and maps semantic rejections.
Run requests go through config/model/skill validation, then `src/runTask.ts` creates a durable run state keyed by `run_id`.
`src/activeChildLease.ts` acquires a local active-child lease before task registration and retains it until the terminal snapshot is durable; restart reconciliation therefore cannot mistake a live owner's finalization window for abandonment.
`src/runSubagent.ts` writes a Pi child request file, then `src/processRunner.ts` spawns and supervises the child process with serialized output consumption and a protected-free-disk watermark. `src/runTask.ts` and `src/activeChildLease.ts` own finite local capacity.
Child output is projected directly into a sanitized public `.partial` transcript through `src/output.ts`; normal execution does not persist a private raw stdout/stderr spool. Active snapshots record that public staging path. Transcript publication atomically renames the complete public file, final-only success removes the redundant transcript staging file, and restart reconciliation promotes an interrupted partial transcript into the failed run's diagnostic output reference. Sanitized public events flow through run-event helpers, and failure records through `src/failureLog.ts`. Requested `final` output succeeds only when the child writes a final message; a clean exit without that artifact is classified as `missing_final_output`, with transcript output retained as diagnostics.
Server-authored prompt provenance uses `src/prompt.ts` to project caller prompt text to a redacted public marker before it reaches public event views or transcript artifacts; child execution still receives the real composed prompt.
Server-launched children receive a private recursive control payload in the child request file. `src/piChild.ts` exposes it only as a native `delegate` tool; `src/recursiveControl.ts` validates the private token and recursion depth, then `src/runTask.ts` validates caller lineage against active parent run state before the parent scheduler creates a descendant. Parent run views project recursive child lifecycle through sanitized `recursive_child_started` and `recursive_child_finished` public events so callers can see descendant start and terminal status/success without reading private recursive-control payloads.
`get_run`, `answer_run_input`, and `cancel_run` operate on local filesystem-backed run snapshots and input mailbox records. Every answer carries a response ID over the parent-owned child stdin control channel; the child emits a correlated acceptance event only after its waiter takes the response, and `runTask.ts` then records safe settlement metadata and returns the receipt. Its run-owned mutation queue orders acknowledgment, cancellation, finalization, and pending-request closure. Raw answers are never written to mailbox sidecars or public run surfaces.
After an atomic terminal snapshot captures the bounded public event projection and settled input views, `runTask.ts` removes that run's redundant event ledger and mailbox directory. Active and input-required runs retain both. Named-session candidate directories remain isolated during execution, then `session.ts` removes the exact attempt workspace after canonical promotion or failure telemetry persistence; the recorded attempt session id is historical audit metadata rather than a durable path.
Operation-only semantic failures from those run-operation tools project as `kind:"operation_rejected"` instead of MCP text errors; child-invocation preflight failures remain `kind:"preflight_rejected"` with `child_started:false`.
Named sessions add `src/session.ts` manifest/ledger/lock handling around the same child execution path. Manifest eligibility failures known before launch, such as missing `require_existing` sessions, reject before durable task registration with `preflight_rejected` and `child_started:false`; locked execution checks still run later as race protection. Terminal session failures logged after durable task creation preserve the caller tool, durable `run_id`, and `task_kind:"session"` so telemetry can be correlated with public run views.

## Key Components
- `server.ts` - MCP tool surface, schema/preflight rejection shape, retry and cancellation-eligibility guidance, and failure logging for handler-level failures.
- `runTask.ts` - durable task lifecycle, snapshots, background execution, cancellation, caller input closure, promotion from one-shot, and active-child lease release.
- `runTask.ts` also records recursive lineage metadata: `parent_run_id` for descendants, `root_run_id`, `recursion_depth`, direct `child_run_ids`, and parent public events for recursive child start/finish.
- `runSubagent.ts` - child request-file contract, Pi child invocation, transcript/final-output handling, missing-final classification, timeout metadata, provider error parsing, recursive control payload injection, and skill audit metadata.
- `recursiveControl.ts` / `recursiveDelegateTool.ts` - private local IPC and child-facing `delegate` tool for recursive Subagent007 calls; the child tool is a client, not an owner of durable task state.
- `processRunner.ts` - detached child process execution, backpressured line delivery, timeout/cancel/disk-reserve termination, heartbeat notifications, and parent-exit process-group cleanup.
- `diskReserve.ts` - preflight and active-run host free-space protection; it stops work rather than truncating a continuing transcript.
- `ownedTemporaryArtifact.ts` - owner metadata and startup reconciliation for child-request/final-message temp directories.
- `buildReleaseLease.ts` / `scripts/build-atomic.mjs` - versioned build publication through `dist/current` and live-release protection.
- `session.ts` - named-session manifests, read-only preflight eligibility checks, candidate ledgers, packet policy, skill/cwd immutability, local session locks, and session terminal failure telemetry with durable caller context. Required packet failures distinguish missing, malformed, and parse-valid not-ready packets by reason code.
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
- No tool restriction by `tool_profile`; accepted legacy profile values are validated and ignored, and every child uses all registered tools.
- No full recursive descendant tree manager or cascade cancellation; the first recursive slice is one child-facing delegate tool plus direct lineage metadata.
- No exposure of raw thinking, private tool payloads, caller prompt text, full composed prompts, or input answer values in public event views.
