---
name: model-class-calibration
description: Update exact model calibration and public class membership without changing execution custody.
last_updated: 2026-09-30
---

# Model Class Calibration

1. Bind the requested class/model/thinking mapping; retain unspecified thinking levels and the configured default unless the founder changes them. `src/modelAllowlist.ts` owns calibration; `src/types.ts` owns accepted class membership.
2. Confirm exact IDs through the installed Pi `ModelRuntime`/`ModelRegistry` and provider inventory, exposing only model metadata and auth presence. Inventory and configured auth do not certify successful provider execution. Transport fallbacks preserve the requested model ID; verify their source metadata and template availability.
3. Update class membership, calibration, exact allowlist, relevant transport fallbacks, operational script choices, schema descriptions, existing tests, README class guidance, and current memory. Remove retired classes from caller schemas; do not invent aliases, persisted-state migrations, or replacement authority.
4. Verify each calibrated pair, the default, class listing, and retired-class SDK rejection before handler/child invocation. Retain calibration redaction on public results, events, failure logs, and README. Update offline payload-cap fixtures when remapped classes change.
5. Run typecheck, build, focused coverage, the full suite for public-schema changes, and docs checks. The guarded test runner owns and removes per-target temporary roots/processes. A live model probe is separate evidence and must use an isolated, owned run root with cleanup.
6. Record the change in ROUTER and relevant context; log the founder decision with `mex log`. Confirm build publication and distinguish it from the release leased by an already-running MCP owner. Reconnection is required for that owner to load new calibration; never terminate shared active attempts just to apply a mapping.
