---
name: recursive-result-rejoin
description: Private descendant result retrieval after a recursive delegate bounded wait returns working.
last_updated: 2026-07-31
---

# Recursive Result Rejoin

Use when a recursively delegated Pi child needs to wait again for an existing descendant result without widening run authority.

1. Keep the child-facing call on the existing private recursive-control socket; do not add an MCP tool, store, queue, or mailbox.
2. Authenticate the recursive caller with the existing active parent/root/depth authority, then verify the requested `run_id` is already in that caller's recorded `descendant_run_ids` before reading target state.
3. Reuse `getRunTask(run_id, false, wait_ms)` after authorization so resident waits remain publication-driven, nonresident reads remain truthful immediate snapshots, and terminal output references use the existing transport.
4. Keep delegation depth limits on new `delegate` calls only: `rejoin` cannot create descendants and must remain available to an already-authorized caller at the depth boundary.
5. Test a zero-wait nonterminal delegate followed by rejoin to terminal output at two recursive depths, plus a known non-descendant ID rejection with no target view fields.
