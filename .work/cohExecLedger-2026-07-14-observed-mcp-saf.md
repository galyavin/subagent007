# Work Ledger: Observed MCP Campaign and SAF Repairs

## Contract

Source:
- User request: plan and run a fresh caller-perspective, end-to-end observed-use campaign of the `subagent007` MCP server; record temporary defects; select and execute only stress-tested True SAF repairs.

Task contract:
- Caller trigger: uses every public MCP capability, including durable and one-shot calls, named sessions, caller-child input, recursive delegation, and failure/edge paths.
- Trusted effect: customers receive clear, reliable, minimally noisy structured MCP contracts; semantic rejections never require ambiguous text parsing or leak private data.
- Success boundary: deterministic full-current evidence covers all required caller surfaces; available live Pi smoke validates installed integration; every repair either has a verified SAF and passing relevant oracle or remains an explicit residual.
- Failure boundary: no source repair is accepted from a simulated-only symptom, an incomplete caller-visible result, or an untested causal explanation.

Product movement gate:
- Triggered: no; this is bounded implementation and verification work, not a product-closure or risk-family claim.

Scope:
- Isolated observed campaign state and a temporary caller defects ledger under `/tmp`.
- Existing campaign/probe tooling, public contract source/tests/docs only when direct observed evidence supports a repair.

Non-goals:
- Do not alter public behavior merely for cosmetic consistency.
- Do not treat the deterministic fake child as evidence of installed Pi integration.
- Do not create branches, persist caller prompts/answers, or expose private recursive-control data.

Acceptance Criteria:
- AC1: A deterministic `full-current` campaign and MCP probe cover all manifest-required caller surfaces/result classes, including recursive and caller-child flows.
- AC2: A live-current campaign is attempted with a normal Pi child environment; its availability/failure is recorded without weakening deterministic coverage.
- AC3: Customer-facing friction and every observed defect/deviation/incoherence are recorded separately from server telemetry in a temporary defects ledger.
- AC4: Each repair candidate is traced to a responsible owner, has a concrete survivor history, passes `stress-test-mini`, and has an evidence-bounded verdict before implementation.
- AC5: Implemented repairs have focused regression evidence, fresh full-campaign evidence, and the repository validation required by project conventions.

Risk Flags:
- public API, persistence, retries, caller input, recursive delegation, private-data projection, child process execution, source-of-truth/projection.

Task profile:
- trust-bearing-model-first.
- Profile evidence: task reads and potentially changes a public contract, durable runtime state, external child execution, caller inputs, recursion, failure telemetry, and claim surfaces.
- Re-check points: after campaign discovery; before every repair; before final readiness.

Ledger profile:
- expanded.
- Expanded triggers: public MCP contract, persistent run state, recursive external execution, caller data redaction, observed proof, and repair plan.
- Why this profile is sufficient: it records the owner-to-effect paths and direct customer evidence without creating a parallel source of truth.

Completion evidence required:
- Final handoff and project-memory updates only when public behavior changes.
- Canonical closure source: direct oracle output plus the final trace table; the ledger is a supporting evidence index, not an authority.
- Artifact role map: campaign/probe outputs are receipts; `/tmp` defects ledger is diagnostic; source tests/contracts are enforcing; final response is claim-only.
- Executable guard decision: reuse existing observed campaign/probe result-class assertions; add one only if a repaired invariant lacks a focused executable oracle.
- Distributed invariant contract decision: reuse the existing public schema/result-class contracts and equivalent source/test owner-boundary proofs across MCP handlers, run state, campaign projection, and README when a repair crosses them.

Effect Projection Map:

| Projection | Code/docs surface | Discovery evidence | Nearest false-green | Killing proof or residual |
|---|---|---|---|---|
| Discovery and schema guidance | `src/server.ts`, `README.md`, observed probe | Existing full-current manifest/probe | tool list returns non-error but omits/noisily describes a customer tool | exact public-tool/list-schema probe |
| Durable and input lifecycle | `src/runTask.ts`, `src/server.ts` | architecture and campaign scenarios | run status looks valid but input receipt/retry ordering is wrong | caller run view plus exact retry/input scenarios |
| Recursive caller-child lifecycle | `src/recursiveControl.ts`, `src/runTask.ts` | architecture and recursive scenarios | child launches but lineage/events leak or disagree | two-hop/depth/forged-lineage run-view scenarios |
| Public result and redaction projection | `src/server.ts`, output/event/failure-log paths | architecture/conventions | structured result appears correct while private data/calibration leaks in another projection | artifact, view, and failure-log negative scans |
| Installed Pi integration | normal child runtime and `live-current` campaign | setup/pattern | fake-child deterministic success mistaken for real integration | live-current isolated smoke or explicit environment residual |

Distributed Invariant Contract Gate:

| Invariant | Surface | Role | Mode / owner proof | Bypass false-green | Killing proof or claim ceiling | Status |
|---|---|---|---|---|---|---|
| Caller can act on a clear and safe result | MCP handler, durable snapshot, public event/output, failure log, observed probe, README | validates/mutates/projects/claims | reuse public schema plus equivalent owner-boundary result/redaction assertions | handler result is structured but a later view leaks or changes taxonomy | full-current probe plus direct artifact inspection; any uncovered projection remains residual | DOING |

Trust Model:
- Protected effect: a caller can start, inspect, respond to, delegate, resume, cancel, and diagnose work using only stable public fields without private-data exposure.
- Authority source: current public MCP schemas/handlers and durable run owner state, evidenced through a fresh isolated campaign.
- Triggered facets:
  - Kernel:
    - Operation points:
      - discover/validate: list tool and preflight contracts are clear before child launch.
      - create/dispatch: run owner admits or refuses work before child spawn.
      - observe/respond: run owner records receipt only after child acceptance and projects safe views.
      - delegate/finalize: recursive owner validates lineage/depth and projects sanitized completion.
      - claim: campaign and final handoff do not represent synthetic coverage as live integration.
    - Allowed side effects: `/tmp` campaign state, controlled fake-child deterministic probes, normal live smoke if available, and source repairs supported by evidence.
    - Forbidden side effects: unbounded repository mutation, live child mutation outside the requested project cwd, leakage of prompts/answers/thinking/control payloads, and repair claims based only on text parsing.
    - Recovery rule: campaign-state cleanup is disposable; durable run telemetry is append-only diagnostic evidence; source repair failures revert only task-owned edits through a follow-up patch, never destructive reset.
    - False-green falsifiers:
      - FG1 [AC1]: a tool-list call succeeds without the exact expected surface -> full-current discovery assertion.
      - FG2 [AC1]: recursive child state exists but parent event/lineage diverges -> direct parent/child run-view assertion.
      - FG3 [AC3]: campaign summary looks clean while public artifact leaks a sentinel -> cross-artifact negative scan.
      - FG4 [AC2]: deterministic child success is reported as installed Pi integration -> separate normal-environment live campaign receipt.
  - Spine:
    - Invariant: a caller-facing operation is clear, typed, safe, and observable from entrypoint to durable terminal result.
    - Owner boundary: MCP handlers and durable task/recursive owners enforce state and projection; campaigns consume and assert but cannot certify implementation without an owner-boundary oracle.
    - Surface projections: public schema, preflight, run lifecycle, input receipt, recursion, session, output/event/failure telemetry, documentation.
    - Recovery semantics: terminal results remain diagnostic; campaign findings become repairs only after causal validation; no private diagnostic content is copied into durable project artifacts.
    - Non-claims: a passing live smoke does not exhaust all provider/model behavior; the campaign does not certify external provider uptime.
  - Ordering:
    - Gate order: campaign evidence -> SAF mechanism/survivor validation -> stress-test revision -> repair plan -> unit repair oracle -> full regression/campaign.
  - Parent/Handoff:
    - Parent invariant: a customer operation may produce a terminal public result only through the MCP handler and run owner after its validation/lineage conditions, with safe projections proven by caller-visible run/output/failure observations.
    - Handoff map:
      | Surface | Role in chain | Must prove or refuse | Nearest falsifier at this surface | Evidence | Status |
      | MCP schema/handler | validates/starts | typed tool intent or preflight refusal | text-only semantic error or child launch on invalid input | pending campaign probe | DOING |
      | durable task owner | mutates/records | state, receipt, and terminal run view agree | completed view without accepted input or wrong status | pending campaign run views | DOING |
      | recursive controller | validates/dispatches | only valid lineage/depth starts a child | forged/depth-overrun child appears | pending recursive trials | DOING |
      | public projections | mirrors/claims | events/artifacts/failure records omit private data | safe MCP result but leaky transcript/view | pending artifact scans | DOING |

Boundary Attack Matrix / probes:
- B1 [AC1]: boundary=invalid launch; falsifier=semantic rejection as MCP text; forbidden shortcut=child launches; guard=structured preflight result; killing proof=full-current preflight scenarios; earliest forbidden side effect=child spawn.
- B2 [AC1]: boundary=input retry; falsifier=same response id redelivers or changed answer succeeds; forbidden shortcut=receipt before child accepts; guard=acknowledged-input owner queue; killing proof=exact-retry scenario; earliest forbidden side effect=second answer delivery.
- B3 [AC1]: boundary=recursion; falsifier=forged/depth child starts or parent cannot see actual child; forbidden shortcut=trust caller lineage; guard=recursive controller/active parent validation; killing proof=two-hop/depth/forged-lineage scenarios; earliest forbidden side effect=descendant task creation.
- B4 [AC3]: boundary=public diagnostics; falsifier=prompt/input/control/calibration leaks in alternate projection; forbidden shortcut=only inspecting MCP response; guard=sanitized projections; killing proof=campaign artifact/failure scans; earliest forbidden side effect=public artifact write.

## Trace / Units

| AC / Boundary probe | Unit(s) | Evidence | Status |
|---|---|---|---|
| AC1, B1-B3 | U1 deterministic full-current campaign and caller evidence audit | E4, E5 | VERIFIED |
| AC2 | U2 normal-environment live-current integration smoke | E6 | VERIFIED |
| AC3, B4 | U3 temporary caller defects ledger and telemetry/artifact comparison | E7 | VERIFIED |
| AC4 | U4 SAF analysis, survivor test, stress-test, and coherent repair plan | E8 | VERIFIED |
| AC5 | U5 repair units and focused/final oracles | E9-E12 | VERIFIED |

## Evidence Log

- E1 [discovery]: Read `.mex/patterns/observed-campaign-saf.md`, architecture, conventions, setup, decisions, and required SAF/stress/execution workflows.
- E2 [ownership]: `git status --short --untracked-files=all` returned no changes; branch is `main`.
- E3 [memory]: `mex check` passed with drift score 100/100.
- E4 [campaign]: `full-current` deterministic campaign returned exit 0 with every required surface covered; 37 scenario oracles included recursive two-hop/depth/forged-lineage, caller input/exact retry, session, queue, cancellation, and redaction behavior.
- E5 [artifact-audit]: isolated deterministic state held 422 campaign events and 14 expected failure records; direct inspection found no prompt, answer, thinking, recursive-control, or socket sentinel in inspected public artifacts and no prohibited top-level telemetry keys.
- E6 [live-campaign]: `live-current` ran without `SUBAGENT007_PI_CHILD_PATH`, covered all four required live-model smoke surfaces, and completed an installed Pi-backed child with requested final output.
- E7 [customer-ledger]: recorded customer observations separately in `/tmp` defects ledger; no caller-visible defect, deviation, or incoherence was observed.
- E8 [SAF/stress]: no malformed owner-to-effect relation survived the campaign. `saf-ninja` selected no repair; `stress-test-mini` preserved that decision while capping it below universal provider/model reliability.
- E9 [validation]: `npm test` passed after a fresh atomic build.
- E10 [validation]: `npm run docs:check` passed.
- E11 [validation]: runtime readiness passed with durable contract `subagent007.durable_run` version 2 and no blocks; `allow_dirty` was needed only because this skill-owned local work ledger is untracked.
- E12 [campaign-recheck]: fresh `full-current` and `live-current` campaigns both exited 0; the latter ran with the deterministic child override unset.
- E13 [memory]: `mex sync` and final `mex check` passed at drift score 100/100; `mex log` recorded the no-repair decision in `.mex/events/decisions.jsonl`.
- E14 [delta-review]: final worktree review found only task-owned project-memory decision logging and this local ledger; no tracked source, test, README, or build-contract change exists, and `git diff --check` passed.

## SAF Analysis — no-repair candidate

Inventory:
- Covered findings: no caller-visible defects. The deterministic campaign met every required result-class/surface oracle; the normal Pi-backed smoke met every live-current requirement; direct artifact and telemetry inspection found no private-data leakage.
- Non-defects: permitted `resolved_model_class` internal/class-level metadata is not a concrete-model leak; test-harness diagnostic field names are not customer MCP output.
- Residual: live provider/model behavior beyond the single installed-Pi smoke is not exhaustively covered. This is outside the campaign's contract and is not evidence of a defect.

Recommendation:
- Select no source repair. The bounded target is: do not introduce product motion when no observed caller-facing failure has an owner/mechanism to fix.

Why:
- A repair needs a malformed owner-to-effect relation. The MCP handler, run owner, recursion controller, and public projections each passed their direct scenario evidence; no symptom remains to compress into a responsible cause.

Why it is smallest:
- A zero-change intervention avoids inventing validation, metadata, or workflow behavior that would add customer-visible noise without blocking an observed failure. Any source change would be strictly more real motion and has no covered outcome to justify it.

Survivor history:
- A future provider outage or a model that declines/uses recursive delegation differently could still make an actual live workflow fail after the present installed-Pi smoke. That survives because the smoke proves installed integration, not every provider/model behavior. It does not revive a covered server-contract failure; it is the explicit residual boundary.

Verification and verdict:
- Falsifiable postcondition: a fresh full-current campaign has zero missing required surfaces; a fresh live-current smoke has zero missing required surfaces; cross-artifact redaction/telemetry scans find no prompt, answer, thinking, control, or concrete-calibration field leakage.
- Weakest gate: the full-current result-class oracle plus direct artifact audit.
- Flip evidence: any missing required surface, structured-result mismatch, leak sentinel, or normal Pi smoke failure makes this no-repair decision false and starts a new SAF inventory.
- Verdict: no SAF candidate and therefore no `True SAF` repair. `No change` is evidence-bounded, not a claim that all possible provider/model behavior is flawless.

## Stress Test Mini — no-repair decision

Inferred target: retain the existing caller contract and make no source change because this campaign found no defect.

Red-team:
- Deterministic child behavior may fail to model a live agent's discretionary tool use or provider failures.
- A campaign summary could pass while an alternate public artifact leaks data or a scenario matcher is too permissive.
- A single live invocation cannot establish every model-class or recursive live behavior.

Blue-team:
- The deterministic lane owns the server's stateful boundaries and directly exercised all required recursion, caller-input, session, queue, and rejection paths; its purpose is deterministic e2e server-contract proof.
- The live lane deliberately owns a different question—whether the installed Pi/provider path can create a final result—and passed without the fake-child override.
- Independent artifact and failure-telemetry inspection supplements the scenario summaries, including negative sentinel checks.

Survival map:
- survives: no repair is justified for the observed server contract.
- fragile: a universal "production is flawless" claim; it would overstate the one-model live smoke.
- breaks: adding a speculative hardening patch solely because deterministic and live evidence serve different scopes.

Revision:
- Keep no source change. Preserve the existing two-lane campaign: deterministic full coverage for server-owned behavior and live smoke for installed integration. State the provider/model variability residual explicitly.

## Coherent Repair Plan

1. Repair input: none. The temporary customer defects ledger contains no defect with a responsible owner; source changes are not authorized by the evidence.
2. Repair moves: none. There is no verified `True SAF` to execute.
3. Oracles for the no-change plan: run the repository suite, documentation/runtime checks, then rerun fresh deterministic and live campaigns to guard against an observational fluke.

## Impact and Delta Review

- Impact surfaces considered: callbacks, persistence, projections, alternate entry points, external side effects, ordered trust boundaries, and error strategy. No executable or public-contract source surface changed.
- Fresh-eye delta scan: only this skill-owned work ledger is untracked; `git diff --name-only` has no tracked source/test/doc changes. `implementation-tightener` and `simplifier` are not triggered because there is no executable repair changeset.

Executable guard decision:
- Needed? no new guard.
- Trigger: existing observed result-class and surface assertions already cover the no-change decision.
- Canonical closure source covered: fresh campaign receipts plus repository validation output.
- Existing guard covering parent invariant: `scripts/run-observed-mcp-probe.mjs` and its full-current coverage manifest.
- Action: reused existing guard; no repair-specific invariant exists.

## Residuals

- None yet.

## Final Readiness

Status: READY WITH RESIDUALS
Validation:
- `npm test` => PASS.
- `npm run docs:check` => PASS.
- `npm run runtime:readiness -- --source-state-policy allow_dirty --expected-contract-name subagent007.durable_run --expected-contract-version 2` => PASS (`ready`, no blocks).
- Fresh `full-current` deterministic and `live-current` normal-Pi campaign runs => PASS (exit 0).
Validation rationale:
- The deterministic campaign directly proves every current caller-facing server contract surface, while the separate normal-Pi smoke proves installed integration. The repository suite and runtime/docs checks guard the unchanged source release.
Final invariant readiness check:
- Trusted effect: callers can use the public MCP service through clear structured operations without observed lifecycle, recursive, input, or projection failure.
- Authority source: fresh isolated MCP campaign receipts, direct public artifact/telemetry scans, and the current public schema/runtime checks.
- Projections checked: tool discovery, run/session/input/cancel/queue/recursion paths, public results, output artifacts, campaign ledger, and failure logs.
- Nearest surviving false-green: a live provider/model-specific behavior not exercised by the one installed-Pi smoke.
- Residual boundary: that broader provider/model variability is explicitly outside this campaign's live-smoke claim; it is not a verified service defect.
Residuals:
- Live model/provider behavior beyond the successful installed-Pi smoke remains outside the evidence boundary. No required campaign surface is missing.
Ledger:
- `.work/cohExecLedger-2026-07-14-observed-mcp-saf.md`
