---
name: effect-profile-boundary
description: Checklist for enforced opt-in Pi tool ceilings and pre-prompt receipts.
last_updated: 2026-07-21
---

# Effect Profile Boundary

1. Keep legacy/omitted request behavior unchanged; use an additive field.
   When a creator-named ceiling has unrelated historical consumers, add a neutral profile and preserve the legacy name/tool order rather than silently migrating it. Admit only tools demonstrated necessary by current callers.
2. Pass the exact tool allowlist to `createAgentSession` before the first prompt. Runtime active-tool selection is verification, not the enforcement owner.
3. Disable ambient extension discovery separately. Explicit providers must have stable identity and implementation SHA-256 or fail closed. A controller-owned interpreter must be selected only in the parent from deterministic discovery, prove every profile-owned fixed runtime import before admission, be resolved to one absolute realpath and file SHA-256, rechecked for identity and imports in parent and child, included in its activation digest, and invoked only at that exact path (never via a later `PATH` lookup).
4. Exclude recursive control/delegate unless descendant widening is explicitly part of the contract.
5. Emit a receipt before `child_prompt_submitted`; parent-validate exact keys, tool order, provider bindings, hashes, and any skill binding before durable/public projection.
6. If skill bytes are pinned, make Pi expand a run-owned snapshot of the verified bytes while reporting the canonical source identity.
7. For filesystem-authoring ceilings, bind the exact real task root, bounded initial tree, recursion setting, and exact writable closure into a strict versioned receipt checked independently by parent and child. Reject sparse, oversized, multi-link, symlinked, special, swapped, or escaping immutable inputs before prompt. Neutral profiles admit only exact canonical new required output files and no extras. Stateful profiles require a fresh absent fixed state root, constrain direct tools and every controller mutation path to it, and treat everything initially outside it as immutable. Separately bound writable file/aggregate size and sparsity, recheck after controller calls, and reinspect the complete task/snapshot closure after every settled child outcome.
8. Test omitted/legacy compatibility, unknown/missing tools, missing/mutated bindings, stale state, leaf/parent swaps, hardlinks, sparse/oversized input and writable closure, provider absence, interpreter drift, invalid receipts, extension isolation, all supported continuity modes, named-session rejection, failure/cancel drift telemetry, durable ordering, dispatched allowed/forbidden paths, and one installed-Pi seam.
9. State the claim ceiling: Pi callable-tool dispatch (and any owned path guards) is enforced; OS sandboxing and hostile-runtime containment are not implied.
