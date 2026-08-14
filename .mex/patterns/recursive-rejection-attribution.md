---
name: recursive-rejection-attribution
description: Attribute valid recursive delegate attempts rejected before admission without creating run state or disclosing prompt text.
last_updated: 2026-08-14
---

# Recursive Rejection Attribution

Use this pattern when changing a fail-fast recursive `delegate` rejection.

## Invariant

A valid delegate envelope that reaches start admission owns one nonsecret request
identity even when it owns no run. Its rejection must bind the attempted public
start body and exact reason. Protocol-invalid envelopes are not claimed starts.

## Receipt

1. Reuse the recursive RPC request ID; do not create a run ID or durable record.
2. Hash a versioned canonical projection containing public parent/root/depth,
   Task SHA-256 and byte size, and normalized public start fields.
3. Return the request ID/digest, Task digest/size, public projection, and exact
   rejection reason on every valid-envelope pre-admission rejection.
4. Never echo prompt text, the private control token, governing private fields,
   thinking/tool payloads, or other private transport data.
5. Do not retry, queue, admit, interpret, or persist the rejected attempt.

## Verification

- Same public attempt bytes: same request digest, different per-request IDs.
- Capacity and recursion-depth rejection: full receipt and exact reason, zero
  admitted descendants.
- Public projection: no prompt text or private governing field.
- Protocol-invalid envelope: remains a protocol failure without a false start
  receipt.
