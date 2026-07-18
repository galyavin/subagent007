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
last_updated: 2026-07-17
---

# Architecture

## System Overview
MCP client calls `dist/server.js` -> `src/server.ts` validates tool input and maps semantic rejections.
Run requests go through config/model/skill validation, then `src/runTask.ts` creates a durable run state keyed by `run_id`.
`src/activeChildLease.ts` atomically admits top-level durable runs either to an active-child lease or to a bounded metadata-only owner queue. One process-owned pump promotes that owner's in-memory requests in order, avoiding per-ticket filesystem polling. New lease paths bind run and owner identity; unreadable records conservatively retain capacity, while unreadable legacy owner-only records classify liveness as unknown rather than claiming a specific run. Confirmed lease deletion follows durable terminal publication; restart reconciliation recognizes live queue tickets and only attributable active leases.
`src/runSubagent.ts` writes a Pi child request file, then `src/processRunner.ts` spawns and supervises the child process with serialized output consumption and a protected-free-disk watermark. `src/runTask.ts` and `src/activeChildLease.ts` own finite local capacity.
For `effect_profile:"workspace_read_only"`, `src/piChild.ts` disables ambient extension discovery, explicitly binds `pi-search-hub`, passes the exact seven-tool allowlist to Pi at `createAgentSession`, excludes recursive control/delegate, verifies active tools, and emits a pre-prompt receipt. `src/runSubagent.ts` validates that receipt before public/durable projection. When `expected_skill_sha256` is present, the parent verifies the canonical skill before launch and places those bytes in the run-owned child-request directory; Pi expands the snapshot while the receipt identifies the canonical source.
`verify_skill_bindings` stays outside that execution graph. `src/server.ts` validates its strict version-1 canonical batch, then `src/skillVerification.ts` loads one catalog through `src/skillResources.ts` and applies the same skill-file read/hash/compare primitive used by launch. The handler returns an in-memory all-or-nothing point-in-time result and deliberately bypasses child readiness, model/config resolution, run/session registration, admission, snapshots, leases, events, temporary artifacts, caches, and failure logging.
`resolve_skill_bindings` shares that non-execution boundary and the same one-catalog/read/hash authority, but accepts hashless canonical names and returns their canonical paths and hashes in a full-request-bound all-or-nothing response.
`src/skillRuntimeBundle.ts` owns the complete admitted-runtime closure and one domain-separated digest over canonical paths, executable bits, and exact bytes. `validate_skill_runtime_bundle` applies it to caller-selected staging or canonical source without catalog authority; `resolve_skill_runtime_bundles` applies it after one canonical catalog load. `src/skillSnapshotStore.ts` materializes that captured closure at a content-addressed owner path and retains exact project/publication references. Publication identity uses a Bendum-persisted `publication_id`, not the later manifest hash, so crash retry is non-circular and idempotent.
Snapshot launches never resolve mutable source. The parent validates owner metadata, complete bytes, active reference, and publication receipt before task registration and again at execution; `piChild.ts` repeats the validation immediately before prompt and emits the exact activation receipt. Active references transition idempotently to closed without changing reference/snapshot identity. Both lifecycles remain retained and included in deletion impact; deletion recomputes the full project/reference impact under the snapshot lock.
Child output is projected directly into a sanitized public `.partial` transcript through `src/output.ts`; normal execution does not persist a private raw stdout/stderr spool. Active snapshots record that public staging path. Transcript publication atomically renames the complete public file, final-only success removes the redundant transcript staging file, and restart reconciliation promotes an interrupted partial transcript into the failed run's diagnostic output reference. Sanitized public events flow through run-event helpers, and failure records through `src/failureLog.ts`. Requested `final` output succeeds only when the child writes a final message; a clean exit without that artifact is classified as `missing_final_output`, with transcript output retained as diagnostics.
Server-authored prompt provenance uses `src/prompt.ts` to project caller prompt text to a redacted public marker before it reaches public event views or transcript artifacts; child execution still receives the real composed prompt.
Only explicitly recursion-enabled launches receive a private recursive control payload. `src/piChild.ts` emits a separate pre-prompt authorization receipt and exposes `delegate` only when enabled. Descendants inherit root authority through private server construction; the child tool has no widening parameter. `src/runTask.ts` records complete ancestor descendant order/status and delays each parent terminal snapshot until its direct children have recursively settled.
`get_run`, `answer_run_input`, and `cancel_run` operate on local filesystem-backed run snapshots and input mailbox records. Every answer carries a response ID over the parent-owned child stdin control channel; the child emits a correlated acceptance event only after its waiter takes the response, and `runTask.ts` then records safe settlement metadata and returns the receipt. Its run-owned mutation queue orders acknowledgment, cancellation, finalization, and pending-request closure. Raw answers are never written to mailbox sidecars or public run surfaces.
The MCP response projection strips backend Pi session IDs and internal mailbox filesystem paths while internal snapshots retain the data needed for recovery; callers use run/request IDs and output references instead.
After an atomic terminal snapshot captures the bounded public event projection and settled input views, `runTask.ts` removes that run's redundant event ledger and mailbox directory and evicts its in-memory task object after confirmed capacity release. Active and input-required runs retain both. Snapshot temp files are removed on local failure; startup recovers a valid dead-owner temp only when no canonical successor exists, and otherwise removes only provably dead-owner temps. Named-session candidate directories remain isolated during execution, then `session.ts` removes the exact attempt workspace after canonical promotion or failure telemetry persistence; the recorded attempt session id is historical audit metadata rather than a durable path.
Operation-only semantic failures from those run-operation tools project as `kind:"operation_rejected"` instead of MCP text errors; child-invocation preflight failures remain `kind:"preflight_rejected"` with `child_started:false`.
Named sessions add `src/session.ts` manifest/ledger/lock handling around the same child execution path. Locks remain owned until matching release or definite local owner death. A hash-verified pending commit publishes the canonical session file, ledger record, and manifest in recoverable order; the retained candidate workspace is deleted only after all three are verified. Manifest eligibility failures known before launch, such as missing `require_existing` sessions, reject before durable task registration with `preflight_rejected` and `child_started:false`; locked execution checks still run later as race protection. Terminal session failures logged after durable task creation preserve the caller tool, durable `run_id`, and `task_kind:"session"` so telemetry can be correlated with public run views.

## Key Components
- `server.ts` - MCP tool surface, schema/preflight rejection shape, retry and cancellation-eligibility guidance, and failure logging for handler-level failures.
- `skillVerification.ts` - canonical batch request digest, read-only typed result projection, and the shared resolved-skill file read/hash/compare primitive used by verification and launch.
- `skillRuntimeBundle.ts` / `skillRuntimeBundleValidation.ts` - canonical complete closure/digest and exact-root read-only public validation.
- `skillSnapshot.ts` / `skillSnapshotStore.ts` - public publication/lifecycle/activation contracts plus immutable materialization, references, locks, retention, and deletion impact.
- `runTask.ts` - durable task lifecycle, snapshots, background execution, cancellation, caller input closure, promotion from one-shot, and active-child lease release.
- `runTask.ts` also records recursive lineage metadata: `parent_run_id` for descendants, `root_run_id`, `recursion_depth`, direct `child_run_ids`, and parent public events for recursive child start/finish.
- `runSubagent.ts` - child request-file contract, Pi child invocation, transcript/final-output handling, missing-final classification, timeout metadata, provider error parsing, recursive control payload injection, skill snapshots/audit metadata, and activation-receipt validation.
- `recursiveControl.ts` / `recursiveDelegateTool.ts` - private local IPC and child-facing `delegate` tool for recursive Subagent007 calls; the child tool is a client, not an owner of durable task state.
- `processRunner.ts` - detached child process execution, backpressured line delivery, timeout/cancel/disk-reserve termination, heartbeat notifications, and parent-exit process-group cleanup. The Pi bridge also treats control-channel EOF as parent loss and terminates its owned process group.
- `failureStorage.ts` / `failureStorageWorker.ts` - one locked append/archive owner with an aggregate raw-byte budget, oldest-archive-first pruning, whole-record active-ledger compaction, and a bounded unref'ed worker that keeps telemetry off caller response latency.
- `diskReserve.ts` - preflight and active-run host free-space protection; it stops work rather than truncating a continuing transcript.
- `ownedTemporaryArtifact.ts` - owner metadata and startup reconciliation for child-request/final-message temp directories.
- `buildReleaseLease.ts` / `scripts/build-atomic.mjs` - versioned build publication through `dist/current` and live-release protection.
- `session.ts` - named-session manifests, read-only preflight eligibility checks, non-expiring local session locks, hash-verified pending commits, candidate ledgers, packet policy, skill/cwd immutability, and session terminal failure telemetry with durable caller context. Required packet failures distinguish missing, malformed, and parse-valid not-ready packets by reason code.
- `runtimeReadiness.ts` - built-entrypoint, source-state, contract, and public-tool readiness checks.

## External Dependencies
- Pi agent/runtime - child execution backend; Pi auth and model config must be visible to the MCP server process.
- Model providers via Pi/OpenRouter/Ollama inventory probes - reconciled by scripts, but concrete model ids and thinking levels are internal calibration behind public model classes.
- `@modelcontextprotocol/sdk` - public server/client protocol for tool listing and tool calls.
- Local filesystem - durable run snapshots, failure logs, input mailbox, sessions, model health, and active-child leases live under the state root.
- Git/source tree - runtime readiness can fail closed on dirty, unknown, or stale built source state.

## What Does NOT Exist Here
- No queue for one-shot, named-session, or recursive launches; only top-level `start_run` and `schedule_run` use bounded admission queueing.
- No database, remote worker service, or distributed lock manager; persistence and locks are local files.
- No public concrete model or thinking-level input, result field, failure-log field, session ledger field, or README calibration table; callers use model classes and class-level health/migration guidance.
- No tool restriction by legacy `tool_profile`; accepted values are validated and ignored. The separate opt-in `effect_profile:"workspace_read_only"` is enforced at Pi construction time.
- No OS sandbox or hostile-runtime containment claim for effect profiles.
- No full recursive descendant tree manager or cascade cancellation; the first recursive slice is one child-facing delegate tool plus direct lineage metadata.
- No exposure of raw thinking, private tool payloads, caller prompt text, full composed prompts, or input answer values in public event views.
