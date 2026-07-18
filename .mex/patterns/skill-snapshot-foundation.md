---
name: skill-snapshot-foundation
description: Verification path for complete skill bundle and immutable snapshot contract changes.
last_updated: 2026-07-17
---

# Skill Snapshot Foundation

1. Keep one closure/digest owner in `skillRuntimeBundle.ts`; exact-root, catalog-resolution, publication, and activation paths must call it.
2. Exclusively claim stable pre-existing `project_id` + `publication_id` for one canonical request/snapshot set, never a later manifest hash or wall-clock value. Exact replay resumes/returns the claim; changed requests conflict.
3. Capture current source once, compare freshness, and materialize captured bytes. Revalidate the recorded snapshot and exact reference before returning receipts.
4. Validate snapshot identity/reference in the parent before run registration and again at execution; Pi child repeats complete validation before `child_prompt_submitted`.
5. Closing references is idempotent and identity-preserving. Both active and closed references block automatic reclamation and appear in explicit deletion impact.
6. Test referenced-file and executable-bit drift, source swaps, missing/altered snapshots, future-source edits, concurrent versions, stable retry, close retry, exact deletion impact, all start surfaces, fresh/raw resume, descendant inheritance, and no child/prompt on rejection.
7. Synchronize strict MCP schemas, durable/readiness capabilities, README receipt fields, observed tool inventory, and `.mex` memory. Build before runtime probes.
