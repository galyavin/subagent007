---
name: terminal-state-compaction
description: Safely compact redundant run or session filesystem state after a durable successor becomes authoritative.
last_updated: 2026-07-23
---

# Terminal State Compaction

Use this pattern when run, mailbox, event, or session-attempt files grow after their operational role ends.

## Invariant

Cleanup happens only after the owner has atomically persisted a successor that contains every caller-visible fact needed after restart. Active runs, pending inputs, canonical sessions, outputs, and sibling paths are protected.

## Steps

1. Identify the exact operation-owned directory or sidecar and its durable successor.
2. Persist and read back the successor before deleting redundant state.
3. Derive the deletion target from the owner root plus validated run/attempt identity; never accept an arbitrary cleanup path.
4. Refuse compaction while input is pending or state is non-terminal.
5. Make post-success cleanup best-effort so a cleanup failure leaves redundancy rather than masking the committed outcome.
6. Test in-process and restart views, active-state refusal, failure paths, and sibling/canonical non-deletion.
7. When a bounded terminal projection must retain an owner-observed anchor, commit the canonical anchor and its owner/public join atomically before appending identical non-authoritative staging bytes. Staging may expose a conflict but must never authorize or repair missing owner truth. Treat the caller-supplied later owner projection as authoritative, apply the child-evidence filter and existing bound directly, and do not merge an earlier projection or staging back into it. Preserve byte-identical observations already present with multiplicity and enough claim-bearing anchors to expose duplicates, then validate the compacted owner/public join before deleting staging state.

## Verification

- `npm run typecheck`
- `npm run build`
- Focused lifecycle and session tests
- `npm test`
- `npm run docs:check`
