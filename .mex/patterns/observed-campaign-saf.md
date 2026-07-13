---
name: observed-campaign-saf
description: Run customer-style observed MCP campaigns, turn findings into SAF repairs, and verify public contract fixes.
triggers:
  - "observed campaign"
  - "real use trials"
  - "SAF repair"
  - "caller perspective"
edges:
  - target: context/architecture.md
    condition: before interpreting tool lifecycle or failure projection findings
  - target: context/conventions.md
    condition: before changing public result fields, reason codes, tests, or README
last_updated: 2026-07-13
---

# Observed Campaign SAF

## Context
Load architecture, conventions, setup, decisions, and this pattern. Use isolated state under `/tmp` for observed campaigns. Treat the campaign ledger as caller evidence and the failure ledger as server telemetry; do not mix them.

## Steps
1. Run `npm run build` before MCP/runtime probes when `src/` may have changed.
2. Run a deterministic full-current campaign through `scripts/run-observed-campaign.mjs` and `scripts/run-observed-mcp-probe.mjs --profile full-current` with a temp `SUBAGENT007_CONFIG_PATH`.
3. Run `--profile live-current` when Pi/auth are available to prove installed Pi integration, but do not treat live smoke as full edge coverage.
4. Inspect `campaign-ledger.jsonl`, `failures.jsonl`, run-task snapshots/events, and selected output artifacts directly. Record friction from the caller's point of view, including ambiguous result kinds, reason-code collapse, required text parsing, noisy fields, and secret leakage.
5. Compress findings with `saf-ninja`, then stress-test the selected SAF with `red-blue-review` before editing.
6. After implementation, rerun focused oracles first, then the full observed campaign or `tests/observed-campaign.test.ts`, `npm run docs:check`, `npm run runtime:readiness -- --source-state-policy allow_dirty --expected-contract-name subagent007.durable_run --expected-contract-version 2`, and `npm test`.
7. Run a fresh-eye repair-delta scan. If it finds material oracle gaps, repair them and rerun the relevant oracles.

## Gotchas
- `SUBAGENT007_PI_CHILD_PATH` is acceptable for deterministic probes only; do not set it for normal MCP use.
- Do not let the observed probe infer repaired reason codes from MCP text. A campaign should fail if a semantic rejection loses structured `kind` and `reason_code`.
- Public `preflight_rejected` means no child launch and must keep `child_started:false`; operation-only rejections use `operation_rejected`.
- A queue-lifecycle scenario must release the active slot while preserving an already queued run, then observe that run complete; starting a new run after release proves only new admission, not queue promotion.
- Two-hop recursive evidence must prove each direct parent-to-child link as well as the grandchild lineage; a depth-boundary scenario must also prove that rejection created no third descendant.
- Packet-required failures must distinguish `packet_required_missing`, `packet_required_invalid`, and `packet_required_not_ready`.
- Prompt/input/thinking redaction must be checked across public artifacts and run views, not only the campaign ledger; a campaign can otherwise pass while `recent_events`, `last_public_output_excerpt`, or transcript artifacts leak caller prompt text.
- Tool discovery coverage must inspect the exact listed public surface and schema guidance; a non-error `listTools()` response is not enough to prove caller-visible tools are present, clear, and free of uncontracted noise.
- Coverage is enforced through caller-visible `surfaces` and `result_classes`. Do not add descriptive lifecycle buckets as a required coverage axis unless callers actually consume them.
- Public calibration redaction must be checked negatively: model-class surfaces may expose class and health/migration fields, but observed responses and failure-log deltas must not include concrete model IDs, thinking levels, `resolved_*model*` calibration fields, or field-name variants such as `*_thinking_level_*`.
- Finalization checks should be generic to Subagent007 output-mode semantics. Use skills such as `designer-in-chief` as canaries only; the runtime oracle is that requested `final` output either captures a final message or fails with `missing_final_output`.
- Full-current edge coverage should include caller-friendly front-door rejection and release contracts, including `require_existing` missing-session preflight for both named-session tools and `local_capacity_exhausted` followed by lease release.
- Full-current session failure coverage should include `start_session_run` packet-failure telemetry correlation: failure logs must keep `tool:"start_session_run"`, the public durable `run_id`, and `task_kind:"session"`.
- Recursive delegate coverage must prove root-visible lineage, parent `recursive_child_started`/`recursive_child_finished` event visibility, wait-0 child completion after parent terminalization, depth-limit rejection, and forged-lineage rejection through structured fields and run views. Event child ids must match the delegated run id. Do not expose recursive control token/socket payloads in ledgers, summaries, or public artifacts.

## Verify
- [ ] Deterministic `full-current` campaign has no missing required surfaces.
- [ ] Live smoke covers `installed-pi-integration` when available.
- [ ] `tool-listing` evidence reports no missing or unexpected public tools and clear `skill_name`/legacy `skill` guidance.
- [ ] Coverage summaries do not depend on non-contract descriptive metadata such as retired lifecycle phases.
- [ ] Ledger, run-view, event-file, and output-artifact scans show no prompt/input/thinking secret leakage.
- [ ] Public results, failure-log deltas, session artifacts, and README checks show no concrete model/thinking calibration leakage, with observed-probe absence flags explicitly true rather than missing.
- [ ] Repaired result classes are asserted by the observed probe, not inferred by wrapper text parsing.
- [ ] Recursive delegate evidence covers success lineage, parent recursive child start/finish events, wait-0 descendant completion after parent terminalization, depth-limit rejection, forged-lineage rejection, and absence of private recursive-control payload leakage.
- [ ] Requested `final` output is covered by both progress-then-final success and clean-exit-without-final failure oracles.
- [ ] Named-session `require_existing` missing-session preflight is covered for both session tools with `child_started:false` and no `run_id`.
- [ ] `start_session_run` packet-failure coverage proves failure-log correlation by public tool, durable `run_id`, and `task_kind:"session"`.
- [ ] Local active-child capacity coverage proves `local_capacity_exhausted`, cancellation cleanup, and a successful launch after release.
- [ ] `npm test`, `npm run docs:check`, and relevant focused tests pass.

## Debug
- If a required surface is missing, inspect `scripts/observed-coverage-manifest.json` before changing source.
- If campaign coverage passes while a caller-visible regression is still possible, tighten `responseMatchesResultClass` or scenario-specific result synthesis.
- If runtime readiness blocks on dirty source during local repair, use `allow_dirty` only for exploratory verification; keep `require_clean` for release checks.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if public behavior changed
- [ ] Update relevant `.mex/context/` files for new result fields, reason codes, or campaign workflow facts
- [ ] Run `mex sync` and `mex log` when rationale matters
