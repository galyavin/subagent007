# Work Ledger: session SAF repairs

## Contract

Source:
- User approval on 2026-07-15 to implement and fault-test the selected SAF repairs.

Task profile: Trust-bearing model-first.
Ledger profile: Expanded; local filesystem persistence, cleanup, retry/recovery, and public operation rejection cross multiple owner boundaries.

Scope:
- Remove time-based named-session lock transfer.
- Make named-session canonical promotion recoverable with one pending-commit owner.
- Make active-child lease liveness attributable without weakening capacity fail-closed behavior.

Non-goals:
- No database, distributed locking, public session-path migration, durable-status expansion, or broad Pi integration rewrite.

Acceptance criteria:
- AC1: A live named-session owner cannot be displaced by elapsed time.
- AC2: Every session-promotion fault boundary recovers to one canonical/ledger/manifest state at the same public path.
- AC3: Unreadable leases consume capacity but cannot assert unrelated run liveness; legacy ambiguity is explicit and non-destructive.

Risk flags:
- Local filesystem persistence, atomic replacement, cleanup, retry/idempotency, public reason-code contract, restart reconciliation.

Trust Model:
- Protected effect: a named-session commit and a durable run’s liveness claim are published only by their observable owners.
- Authority source: matching session lock owner_id; pending-commit record plus canonical/attempt hashes; attributable active-child lease path.
- Kernel operation points:
  - lock acquire/reclaim/release: only definite owner death can transfer authority.
  - commit prepare/replace/append/manifest/cleanup/recover: marker precedes effect and owns retained attempt cleanup.
  - lease scan/query/reconcile: path occupancy owns capacity; run identity owns liveness.
- Allowed side effects: atomic lock, marker, canonical file, ledger, manifest, and lease-file changes under their owners.
- Forbidden side effects: deleting a live owner’s lock, deleting an attempt needed for recovery, duplicate ledger append, false working claim, or restart terminalization under unknown ownership.
- Recovery rule: exact successor is completed idempotently; predecessor/no effect retries from retained attempt; mismatched artifacts fail closed; unknown legacy lease defers destructive reconciliation.
- False-green falsifiers:
  - FG1 [AC1]: an expired timestamp lets contender B run while A is alive. Killing proof: current-PID expired lock stays rejected.
  - FG2 [AC2]: canonical rename succeeds but ledger append fails. Killing proof: next run recovers exactly one record and stable path.
  - FG3 [AC3]: unreadable lease matches all runs or none. Killing proof: exact new lease isolates R1/R2; legacy unreadable causes typed rejection and no terminal mutation.
- Spine:
  - Invariant: owner authority must survive every mutation/recovery boundary until an observable release, definite death, or explicit ambiguity.
  - Owner boundary: session.ts owns session commit; activeChildLease.ts owns lease evidence; runTask.ts only consumes its liveness classification to decide restart drift.
  - Surface projections: session lock/commit/cleanup, active lease scan/query, runTask read/reconciliation, server operation rejection, types/README/tests.
  - Non-claims: no automatic recovery for a live wedged process; no attribution for unreadable legacy owner-only lease.
- Distributed invariant contract:
  - Decision: equivalent owner-boundary proof.
  - Invariant: no false session commit or liveness claim after partial failure/corruption.
  - Surfaces: session.ts mutation/recovery; activeChildLease.ts classification; runTask.ts terminalization; server.ts operation projection; types/README/tests.
  - Closing owners: session pending-commit recovery and active lease classifier, with runTask/server consuming their typed results.
  - First forbidden side effect: canonical replacement, terminal snapshot persistence, or public working claim.
  - Bypass false-green: a raw boolean/null liveness predicate or direct canonical copy bypasses the owner record.

Boundary closure map:

| Projection / claim | Nearest false-green | Killing proof | Earliest forbidden side effect |
|---|---|---|---|
| AC1 lock | expiry reclaims a live owner | focused session lock test | child launch / session mutation |
| AC2 commit | rename succeeds before durable metadata | injected phase faults and recovery test | canonical replacement / attempt deletion |
| AC3 lease | unreadable record matches all or none | lease + getRun/reconcile tests | false public working view / terminal snapshot |

## Trace / Units

| Unit | Goal | ACs | Files | Tests / verification | Status |
|---|---|---|---|---|---|
| U1 | Replace expiring session lock with definite-death ownership | AC1 | src/session.ts, tests/session.test.ts, README.md | focused session tests; typecheck/build | DONE |
| U2 | Add pending-commit publication/recovery/cleanup ownership | AC2 | src/session.ts, tests/session.test.ts | injected commit faults at prepared/canonical/ledger/manifest boundaries; focused session tests | DONE |
| U3 | Add attributable lease paths and unknown liveness projection | AC3 | src/activeChildLease.ts, src/runTask.ts, src/types.ts, tests, README.md | focused lease/run tests; typecheck/build/docs check | DONE |

## Evidence Log

- E1 [discovery]: Current lock expires in src/session.ts; promotion deletes then copies the canonical directory before ledger/manifest; unreadable lease null matches every run.
- E2 [test-design]: U1 needs live-expiry rejection and definite-death recovery; U2 needs pre-rename, post-rename, post-ledger recovery; U3 needs exact-new, legacy-unknown, capacity, and no-terminalization probes.
- E3 [implementation]: Session locks no longer contain or refresh time leases. Pending commits include predecessor/successor hashes, a deterministic staged canonical file, one run-record identity, and the next manifest; recovery verifies and finishes publication before cleanup.
- E4 [fault evidence]: `tests/session.test.ts` passes all 23 tests, including injected faults after `prepared`, `canonical_published`, `ledger_published`, and `manifest_published`; every recovered sequence keeps one public session path, exactly one record per run, removes the marker, and leaves no staged file.
- E5 [fault evidence]: `tests/resource-hygiene.test.ts` and the targeted active-run test pass: unreadable exact new lease identity stays run-scoped; unreadable legacy lease keeps capacity, returns `run_liveness_unknown`, and leaves the working snapshot unchanged during reconciliation.
- E6 [verification]: `npm run typecheck`, `npm run build`, and `npm run docs:check` pass. `npm run runtime:readiness` reports only expected `git_worktree_dirty` while this uncommitted repair is present.
- E7 [tightening]: The pending marker now derives run identity from `run_record`, canonical identity from `next_manifest`, and its staging path from those owners instead of persisting duplicate authorities. New lease filenames use a prefix-free base64url run component, and malformed new-format leases for other runs classify as absent rather than legacy unknown.

## Residuals

- None.

## Final Readiness

Status: READY
Validation:
- Focused fault tests pass; source typecheck, atomic build, and runtime-doc fact check pass.
- The broad `npm test` run was not accepted as clean evidence: its direct focused run has pre-existing model-health expectation mismatches against the current local registry (`openai-codex/gpt-5.6-luna` vs retired expected provider value, and `unknown` vs expected `unhealthy`). These are outside this changeset; the touched session/lease suites pass.
Final invariant readiness check:
- AC1: elapsed time cannot transfer a live lock. AC2: every injected publication boundary converges on canonical file, ledger, manifest, and cleanup. AC3: liveness is attributable or explicit unknown, never destructive by ambiguity.
