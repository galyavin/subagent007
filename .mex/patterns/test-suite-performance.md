---
name: test-suite-performance
description: Reduce full-suite runtime by removing repeated orchestration and shortening the critical path without weakening assurance.
last_updated: 2026-07-26
---

# Test Suite Performance

## Use when

The full `npm test` wall time grows materially or one test file dominates the critical path.

## Steps

1. Measure one clean `npm test`, per-file duration, total file-seconds, and the slowest file.
2. Delete proven duplicate executions before adding concurrency.
3. Replace arbitrary sleeps with waits for the owned observable event or durable record.
4. Group concurrently safe tests by one responsibility. Keep `process.env` mutation, module mocking, and real owner/process-loss timing behind explicit semantic barriers.
5. Split only demonstrated critical-path files into explicit name-pattern targets. Every test must be selected exactly once; the run-owner suite stays one isolated target containing all 11 tests, with its five independent crash-cut subtests concurrent inside that target.
6. Give every target its own short `/tmp` root, state paths, and guarded failure ledger. Explicit shared state, failure-ledger, or campaign-ledger paths force unsplit one-worker mode.
7. Preserve the two dependency chains and launch protected timing targets with bounded low-contention overlap; cap the combined active target processes at four rather than creating a serial timing lane or waiting for the pool to finish.
8. Verify focused targets, the full suite, typecheck, docs facts, cleanup, and repeated wall time.

## Reference evidence

On 2026-07-26, on the Apple Silicon reference machine, the original build-inclusive baseline was 364.55s. The final three green build-inclusive runs were 65.65s, 65.64s, and 65.38s: median 65.64s, maximum 65.65s, with 46/46 targets and 439 tests. The resulting 5.6x speedup was accepted at stable approximately 65.6s; the deliberate decision was not to add scheduler complexity merely to chase the final seconds and cross 60s.

## Guardrails

- One package `pretest` build; never build per target.
- Preserve real stdio, process death, restart, cleanup, reason-code, and public-tool coverage.
- Do not add an in-memory transport or test-only product architecture solely for speed.
- Prefer removing orchestration work over increasing worker count.
- Runtime claims name the reference machine, sample count, and whether build time is included.
