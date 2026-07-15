# Work Ledger: typed preflight guidance

## Contract

Source:
- User approval on 2026-07-14 of the stress-tested SAF-1.

Task contract:
- A caller receives retry guidance for a handler-level preflight rejection.
- The server must select that guidance from the typed `ValidationError.reasonCode`, not mutable English error prose.
- Success boundary: the existing underbudget preflight result, fields, guidance text, no-child guarantee, and failure-log behavior are unchanged.
- Failure boundary: no child launch, public-result shape, or unrelated SDK schema-error behavior changes.

Scope:
- Replace the two message classifiers in `src/server.ts` with typed reason-code classification, removing the unreachable one-shot-timeout branch.
- Verify the existing MCP underbudget contract and the absence of prose classification in the handler.

Non-goals:
- Do not implement the rejected custom SDK/pre-dispatch adapter.
- Do not change SDK schema-error behavior, tool schemas, public messages, result fields, docs, or failure-log policy.

Acceptance Criteria:
- AC1: Handler preflight retry guidance is selected only from `reasonCode`.
- AC2: A deadline-risk underbudget MCP request still returns `preflight_rejected`, `child_started:false`, its typed reason code, and current `wait_ms` guidance before child launch.
- AC3: The source build and relevant tests pass.

Assumptions:
- The existing `ValidationError.reasonCode` contract remains the semantic authority, as recorded in `.mex/context/decisions.md`.

Risk Flags:
- Public API / error projection; no persistent or external side effects are introduced.

Task profile:
- trust-bearing-model-first
- Profile evidence: the change is a public caller contract projection from typed validation authority.
- Re-check points: after discovery and before final readiness.

Ledger profile:
- expanded
- Expanded triggers: public contract and distributed source/projection invariant.
- Why this profile is sufficient: the only affected invariant crosses typed validation, MCP projection, and integration test surfaces.

Completion evidence required:
- Final handoff and the project memory update required by AGENTS.md.
- Canonical closure source: source diff plus executable tests.
- Artifact role map: source/tests enforce; this ledger and final response mirror evidence only.
- Executable guard decision: reuse focused integration test plus a source invariant check; no durable status artifact is changed.
- Distributed invariant contract decision: reuse existing `ValidationError.reasonCode` contract across validator, server projection, and tests.

Trust Model:
- Protected effect: caller retry guidance agrees with the typed public failure reason.
- Authority source: `ValidationError.reasonCode` / `FailureReasonCode` in `src/types.ts`.
- Triggered facets:
  - Kernel:
    - Operation points:
      - validate: throw a typed reason before child launch.
      - project: `preflightRejectedResult` derives guidance from that reason and returns the public envelope.
      - respond: MCP returns the envelope without a child launch.
    - Allowed side effects: existing failure logging only.
    - Forbidden side effects: child launch, output artifact creation, message-text semantic classification.
    - Recovery rule: no durable state is changed on rejection.
    - False-green falsifiers:
      - FG1 [AC1]: guidance still parses `error.message` and would drift when wording changes -> source invariant check.
      - FG2 [AC2]: typed rejection loses its envelope/guidance or launches a child -> existing focused MCP integration test.
  - Spine:
    - Invariant: validation author supplies a reason code; the public preflight projection consumes that code without reinterpreting prose.
    - Owner boundary: validation throw sites own semantics; `preflightRejectedResult` only projects them.
    - Surface projections:
      - `src/types.ts`: defines typed authority.
      - `src/validate.ts`: produces the deadline-risk reason.
      - `src/server.ts`: projects retry guidance.
      - `tests/failure-log.test.ts`: exercises the public MCP envelope.
    - Recovery semantics: no irreversible effect; rejection is returned unchanged.
    - Non-claims: SDK schema errors remain MCP `isError`; no all-schema structured-preflight claim.
  - Distributed invariant contract:
    - Decision: reuse existing contract.
    - Invariant: typed validation reason determines guidance.
    - Surfaces: `types.ts`, `validate.ts`, `server.ts`, focused MCP test.
    - Closing owner or equivalent owners: `ValidationError.reasonCode` and existing integration behavior.
    - First side-effect boundary: child entrypoint/launch, which must not be reached for the underbudget rejection.
    - Bypass false-green: `server.ts` reclassifies prose after the typed error was created.
    - Killing proof or claim ceiling: source invariant plus focused MCP test; no claim about SDK schema errors.

Effect Projection Map:

| Projection | Code/docs surface | Discovery evidence | Nearest false-green | Killing proof or residual |
|---|---|---|---|---|
| typed authority | `src/types.ts`, `src/validate.ts` | explicit reason enum and throw site | no typed code exists | existing reason-code test |
| public guidance projection | `src/server.ts` | message matching at `preflightRejectedResult` | prose selects semantic guidance | focused source check |
| caller-visible refusal | `tests/failure-log.test.ts` | MCP underbudget test | no structured no-child result | focused MCP test |

Boundary Closure Mini-Gate:

| Projection / claim | Nearest false-green | Killing proof | Earliest forbidden side effect | Status |
|---|---|---|---|---|
| AC1 typed guidance | prose is parsed after typed validation | `rg` confirms no `error.message.includes` in `src/server.ts` | incorrect caller guidance | VERIFIED |
| AC2 public no-child preflight | handler result loses structured fields | focused MCP test | child launch | VERIFIED |

## Trace / Units

| AC / Source row / Boundary probe | Unit(s) | Evidence | Status |
|---|---|---|---|
| AC1 / FG1 | U1 | E1, E5, E7 | VERIFIED |
| AC2 / FG2 | U1 | E2, E9 | VERIFIED |
| AC3 | U1 | E6, E8-E12 | VERIFIED |

## Evidence Log

- E1 [discovery]: `src/server.ts:145` derives `reasonCode` but uses two `error.message.includes` checks for guidance.
- E2 [discovery]: `tests/failure-log.test.ts:731` executes the existing MCP schema-boundary timeout case; underbudget integration coverage is at lines 647 and 704.
- E3 [ownership]: `git status --short` showed only prior `.mex/events/decisions.jsonl` and `.work/cohExecLedger-2026-07-14-observed-mcp-saf.md` changes; `src/server.ts`, focused tests, and README were clean.
- E4 [red-test-exception]: Existing external behavior is intentionally unchanged; the regression is authority ownership, so pre-change runtime output would pass. A direct source invariant check is the falsifier.
- E5 [change]: Replaced both prose classifiers in `preflightRejectedResult` with `reasonCode === "timeout_underbudget_for_deadline_risk"`; no new helper or public output change.
- E6 [validation]: `npm run build` => PASS.
- E7 [boundary]: `if rg -n 'error\\.message\\.includes' src/server.ts; then exit 1; fi` => PASS; no prose classifier remains in the server.
- E8 [validation]: `npm run typecheck` => PASS.
- E9 [validation]: `node --import tsx --test tests/failure-log.test.ts` => PASS (35 tests), including deadline-risk underbudget structured no-child preflights.
- E10 [validation]: simplifier baseline `npm test >/dev/null` => exit 0; a concurrent direct `npm test` completed against the same unchanged source.
- E11 [validation]: `npm run docs:check` => PASS; `npm run runtime:readiness -- --source-state-policy allow_dirty` => ready with a fresh non-stale build.
- E12 [review]: `implementation-tightener` reviewed the exact `src/server.ts` diff and applied no further change; `simplifier` adjacent loop finalized after two independent zero-opportunity scans.
- E13 [memory]: `mex sync` => no drift, `mex log` recorded the SAF rationale, and final `mex check` => 100/100 with 0 errors or warnings.

## Residuals

- SDK schema errors remain standard MCP `isError` by explicit non-goal; no custom dispatcher is added.

## Final Readiness

Status: READY
Validation:
- `npm run build` => PASS.
- `npm run typecheck` => PASS.
- `node --import tsx --test tests/failure-log.test.ts` => PASS (35 tests).
- `npm test >/dev/null` => PASS (simplifier baseline exit 0).
- `npm run docs:check` => PASS.
- `npm run runtime:readiness -- --source-state-policy allow_dirty` => ready.
- `mex check` => 100/100, 0 errors, 0 warnings.
Validation rationale:
- The source invariant kills message-based reclassification; the focused MCP suite preserves the typed no-child envelope; build, typecheck, full suite, docs, and runtime checks cover integration and publication.
Final invariant readiness check:
- Trusted effect: typed validation reasons own public retry guidance.
- Authority source: `ValidationError.reasonCode`; projection and caller-visible test surfaces were checked.
- Nearest false-green: reintroduced message parsing; source invariant rejects it.
- Residual boundary: SDK schema errors intentionally remain standard MCP `isError`.
Ledger:
- `.work/cohExecLedger-2026-07-14-reason-guidance-saf.md`
