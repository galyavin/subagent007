---
name: recursive-result-rejoin
description: Private descendant result retrieval and complete primary-output reintegration after a recursive delegate bounded wait returns working.
last_updated: 2026-07-31
---

# Recursive Result Rejoin

Use when a recursively delegated Pi child needs to wait again for an existing descendant result without widening run authority.

1. Keep the child-facing call on the existing private recursive-control socket; do not add an MCP tool, store, queue, or mailbox.
2. Authenticate the recursive caller with the existing active parent/root/depth authority, then verify the requested `run_id` is already in that caller's recorded `descendant_run_ids` before reading target state.
3. Reuse `getRunTask(run_id, false, wait_ms)` after authorization so resident waits remain publication-driven and nonresident reads remain truthful immediate snapshots; apply the one common private terminal projection to delegate and rejoin. It may inline only the complete primary artifact after revalidating its canonical reference against the configured runs root with the existing 1 MiB no-follow/single-link/current-byte checks. Public `get_run` remains references-only.
4. Keep delegation depth limits on new `delegate` calls only: `rejoin` cannot create descendants and must remain available to an already-authorized caller at the depth boundary.
5. Test a zero-wait nonterminal delegate followed by rejoin to terminal output at two recursive depths; terminal delegate and rejoin must each return primary output longer than the 1,000-character public excerpt with matching reference identity. Also prove public `get_run` has no private payload and a known non-descendant rejection has no target state or output fields.
