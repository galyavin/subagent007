# Garbage lifecycle implementation ledger

Date: 2026-07-12
Target: Subagent007 Pi on `main`
Approved outcome: effective, simple garbage hygiene that does not degrade callers, especially Bendum.

## Acceptance criteria

- AC1 — Snapshot/temp artifacts are removed on success and failure.
- AC2 — Interrupted atomic writes recover successor-first without deleting the last valid state.
- AC3 — Terminal in-memory run-task state is evicted without changing durable run views.
- AC4 — Loss of the MCP parent's control channel terminates the owned Pi child process group.
- AC5 — Failure telemetry has a deterministic byte budget; only complete JSONL records survive, oldest raw archives go first, compact summaries survive, and telemetry failure never changes tool results.
- AC6 — Bendum forwards the provider's supported hygiene environment consistently.
- AC7 — Parallel queue work is reconciled and verified without overwriting it.
- AC8 — Canonical outputs/sessions are released only where an observable Bendum-owned authority exists; otherwise retention remains an explicit residual, never a guessed TTL.

## Trust model

- Provider owns temporary files, process groups, in-memory task objects, raw failure telemetry, and queue metadata it creates.
- Callers own the meaning and lifetime of returned canonical output/session paths.
- Deterministic code may enforce observable byte/process/file mechanics. It must not infer semantic consumption from age or successful return.

## Work units

| Unit | ACs | State | Notes |
|---|---|---|---|
| U1 snapshot cleanup | AC1 | DONE | Local write failure removes its temp in `finally`; focused recovery test green. |
| U2 partial recovery | AC2 | DONE | Startup recovers valid dead-owner temp via no-clobber link only when canonical state is absent. |
| U3 terminal task eviction | AC3 | DONE | State map eviction follows durable terminal snapshot plus confirmed capacity release. |
| U4 parent-loss cleanup | AC4 | DONE | Control EOF terminates the bridge-owned process group; focused suite green. |
| U5 bounded failure telemetry | AC5 | DONE | One raw-byte budget, complete newest JSONL records, oldest raw archives first, summaries retained. |
| U6 Bendum environment | AC6 | DONE | Narrowly merged provider hygiene variables into the existing dirty allowlist; focused tests green. |
| U7 queue reconciliation | AC7 | DONE | Tightened queue released after 223/223 tests; hygiene changes applied afterward without overwriting it. |
| U8 canonical release authority | AC8 | DONE | No release authority exists: Bendum durably rereads output paths and session IDs. Canonical deletion is explicitly excluded. |

## Evidence log

- Preimage: `main` at `737b3a5`; parallel queue task has uncommitted edits in lifecycle/server/docs files.
- Existing failure telemetry appends indefinitely to `failures.jsonl`; archive command moves raw JSONL but never prunes it.
- Existing archive summaries are compact and sufficient for aggregate historical evidence.
- False green to avoid: bounding only the active log while raw archives continue growing.
- False green to avoid: truncating bytes mid-record and corrupting JSONL.
- False green to avoid: deleting canonical outputs because they are old; Bendum stores returned paths and may resume sessions.
- RED evidence: three focused failure-storage tests failed before implementation (zero budget, active bound, archive pruning).
- AC5 verification: typecheck passed; `tests/failure-log.test.ts` passed 33/33.
- AC4 verification: build and typecheck passed; `tests/timeout-budget.test.ts` passed 11/11, including an ignoring descendant.
- AC6 verification: Bendum focused environment-policy tests passed 2/2 with `python3 -m unittest`.
- AC8 evidence: Bendum `BUILD-SPEC.md` B-010 forbids Bendum retention/deletion and its ledger/core later require readable external `output_path`; resume resolves durable prior `session_id`.
- AC1/AC2 focused verification: resource-hygiene recovery test passed; live-owner temp and existing canonical successor were preserved.
- AC3 focused verification: terminal snapshot test removes the durable successor and proves `get_run` no longer falls back to retained process memory.

## Verification record

- Combined full suite: 224/224 passed after preserving terminal cancel idempotency and late recursive-child completion publication.
- Focused observed full-current aliases: 2/2 passed.
- Provider typecheck, build, docs check, mex drift, and diff check passed.
- Bendum environment-policy tests: 2/2 passed.
