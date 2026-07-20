---
name: effect-profile-boundary
description: Checklist for enforced opt-in Pi tool ceilings and pre-prompt receipts.
last_updated: 2026-07-19
---

# Effect Profile Boundary

1. Keep legacy/omitted request behavior unchanged; use an additive field.
2. Pass the exact tool allowlist to `createAgentSession` before the first prompt. Runtime active-tool selection is verification, not the enforcement owner.
3. Disable ambient extension discovery separately. Explicit providers must have stable identity and implementation SHA-256 or fail closed.
4. Exclude recursive control/delegate unless descendant widening is explicitly part of the contract.
5. Emit a receipt before `child_prompt_submitted`; parent-validate exact keys, tool order, provider bindings, hashes, and any skill binding before durable/public projection.
6. If skill bytes are pinned, make Pi expand a run-owned snapshot of the verified bytes while reporting the canonical source identity.
7. For filesystem-authoring ceilings, override or bind every callable filesystem tool with exact-run-cwd guards. Reject lexical traversal and resolved/symlink escapes; writes must remain at the exact real task root, and read roots may add only a validated complete snapshot runtime bundle. Bound list/search/read arguments independently of the model prompt.
8. Test omitted/legacy compatibility, unknown/missing tools, invalid receipts, extension isolation, all supported continuity modes, named-session rejection, failure telemetry, durable ordering, a dispatched allowed/forbidden path seam, and one installed-Pi allowed/forbidden seam.
9. State the claim ceiling: Pi callable-tool dispatch (and any owned path guards) is enforced; OS sandboxing and hostile-runtime containment are not implied.
