---
name: run-owner-transitions
description: Change durable-run lifecycle producers without creating stale writers, staging authority, or nested run ownership.
last_updated: 2026-07-27
---

# Run Owner Transitions

Use this pattern when adding or changing spawn, heartbeat/progress, input, cancellation, output/session/lifecycle, terminal, or restart behavior.

## Invariant

One per-run owner is the only observable state writer. Resident `RunTaskState` is semantic truth while live; otherwise the durable owner record is. JSONL and mailbox files stage evidence but never authorize or repair owner state.

## Steps

1. Express the producer as a small named owner operation, not a prebuilt full snapshot.
2. Under one run owner, read fresh truth, clone a private draft, apply event-specific idempotency, derive/validate the public view, atomically commit the next revision, and synchronously publish the exact draft.
3. Construct each public event once in the draft. Project it into owner truth before appending the byte-identical event to JSONL after owner release.
4. Keep terminal absorption, exact timeout-recovery enrichment, stable-event no-ops, and repeated general evidence observability explicit.
5. Register input delivery before send; commit acceptance or closure under the owner; release the owner before mailbox I/O or waits.
6. Never hold two run owners. For descendant reconciliation, read/release the parent, inspect descendants, reacquire/reread the parent, and reassess semantic authorization rather than rejecting unrelated revision progress.
7. Put failure logging, process waits, child/ancestor mutation, and staging-failure settlement outside the owner.
8. For a bounded resident observation wait, register against committed resident-state publication outside the owner, notify only after owner release, and use one expiry timer. Progress may wake a condition check. Never timer-poll `getRunTask`, filesystem-poll a nonresident owner record, or add a public revision merely to wait.
9. If a child can perform consequential work after owner loss but before durable authorization, use only the existing control-pipe release frame; EOF before release must exit.

## Verification

- Producer-real stale-snapshot and owner-before-staging controls
- Positive and negative SIGKILL controls with the same nonce/effect fixture
- Parent/child/grandchild restart convergence with compatible heartbeat progress
- Input registration/acceptance/cancellation ordering and restart replay
- Resident actionable wake, truthful expiry, omission/zero immediacy, and nonresident immediate-snapshot ceiling
- `npm run typecheck`
- `npm run build`
- `npm test`
