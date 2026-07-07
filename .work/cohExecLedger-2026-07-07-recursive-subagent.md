# Work Ledger: Recursive Subagent Delegation

## Contract

Source:
- User request: implement coherent recursive Subagent007 calls after prior investigation/proposal approval.

Task contract:
- Actor/caller: a Subagent007 child process.
- Trigger: child asks to delegate a subtask while running under the parent MCP server.
- Operation: child invokes one native recursive delegation tool.
- Trusted effect: the original parent/server control plane creates and owns the descendant durable run, records lineage/depth metadata, and returns a simple result to the child.
- Success boundary: a root caller can inspect the child-created descendant run through normal run views.
- Failure boundary: invalid recursive control requests fail before a descendant child process is launched.

Product movement gate:
- Triggered: no. This is product behavior implementation, not proof-only closure work.
- Status: not triggered.

Scope:
- Add a private parent-owned recursive control channel.
- Add one child-facing delegate tool.
- Add lineage/depth metadata to durable run views.
- Add focused fake-child/integration coverage for child-to-grandchild visibility.
- Update public docs for the new recursive behavior and env var.

Non-goals:
- No full descendant tree management, cascading cancellation, or multi-tool recursive surface.
- No child-local task store ownership.
- No changes to public root MCP tool count beyond existing public tools.

Acceptance Criteria:
- AC1: Every server-launched Subagent007 child receives a native delegate tool when recursive control is available.
- AC2: A child delegate request creates a descendant via the original parent durable run scheduler, not child-local task state.
- AC3: Root-visible run views include lineage/depth metadata for recursive descendants.
- AC4: Recursion depth is bounded and rejects before descendant launch when exceeded.
- AC5: Focused tests prove a fake child can spawn a root-visible grandchild and that metadata links parent/root/depth.

Assumptions:
- A1: The first slice should keep one child-facing tool only; the tool may return run status/output but does not expose separate polling/cancel tools to the child.
- A2: Default recursion max depth may be environment-configured with a conservative finite default.

Risk Flags:
- Public contract, durable state, external local IPC, child process launch, lineage/source-of-truth projection, docs/runtime fact drift.

Task profile:
- trust-bearing-model-first
- Profile evidence: the change crosses durable task ownership, process launch, IPC token validation, persisted snapshots, and public run views.
- Re-check points: after discovery and before READY.

Ledger profile:
- expanded
- Expanded triggers: persistence, public contract, external local IPC, child process spawning, distributed lineage invariant, docs updates.
- Why this profile is sufficient: the expanded ledger records the single parent-owned invariant and focused boundary proofs without creating unrelated process overhead.

Completion evidence required:
- final handoff only plus repository GROW updates if project state/docs changed.
- Canonical closure source: executable source/tests plus validation command results.
- Artifact role map: ledger is attempt-local; README and `.mex` are docs mirrors; final response is claim surface only.
- Executable guard decision: use focused automated tests and docs checker; no separate custom guard needed because the invariant is executable in integration tests.
- Distributed invariant contract decision: add shared typed recursive control payload/result contracts and use parent scheduler as the only descendant owner.

Effect Projection Map:
| Projection | Code/docs surface | Discovery evidence | Nearest false-green | Killing proof or residual |
|---|---|---|---|---|
| Child tool availability | `src/piChild.ts`, child custom tools | E3, E6, E8, E11 | Tool exists in source but not injected into Pi sessions | Focused test/fake child reads payload and delegates through control channel |
| Parent-owned descendant launch | `src/server.ts`, `src/runTask.ts`, new control module | E3, E4, E6, E8, E11 | Child calls `startRunTask` locally or launches unmanaged subprocess | Integration test asserts grandchild visible via root `get_run` |
| Lineage/depth durable metadata | `src/runTask.ts`, run snapshots/views | E4, E7, E8, E11 | Grandchild launches but parent/root/depth absent or only in transient memory | Test asserts `parent_run_id`, `root_run_id`, `recursion_depth`, `child_run_ids` |
| Depth bound refusal | control server handler before scheduler | E3, E4, E6, E8, E11 | Depth check happens after scheduling or after child launch | Focused rejection test checks no child id is registered when max depth reached |
| Docs/runtime fact projection | `README.md`, docs checker coverage | E5, E9, E10 | README omits env/tool behavior or docs checker drifts | `npm run docs:check` |

Trust Model:
- Protected effect: Recursive delegation remains frictionless for children while descendant durable runs are owned, visible, and bounded by the original parent server.
- Authority source: Parent MCP server durable scheduler and run state store.
- Triggered facets:
  - Kernel:
    - Operation points:
      - child request-file creation: must carry private recursive endpoint/token and caller lineage only to the spawned child.
      - child delegate tool: must validate simple tool params, default cwd, and call parent IPC without exposing token publicly.
      - parent IPC handler: must validate token and depth before scheduling.
      - durable scheduler: must create descendant state with lineage and child-run linkage.
      - run view/snapshot: must claim lineage/depth from durable state.
    - Allowed side effects: temp request file, local IPC request, descendant durable run/state/event writes after valid token/depth, docs/test updates.
    - Forbidden side effects: descendant launch on bad token or exceeded depth; public token exposure; child-local durable task ownership.
    - Recovery rule: invalid/malformed control calls fail closed with no descendant launch; valid descendant failures remain normal run failures visible via run views.
    - False-green falsifiers:
      - FG1 [AC1]: tool implementation exists but is never passed to Pi session -> test/fake recursive child path.
      - FG2 [AC2]: child creates unmanaged/local descendant invisible to root -> root `get_run` visibility test.
      - FG3 [AC3]: metadata kept only in memory -> snapshot/get-run assertions.
      - FG4 [AC4]: max-depth checked after schedule -> rejection test asserts no `child_run_ids`.
      - FG5 [security]: token appears in public output/transcript -> review and targeted grep of public-facing docs/tests/source output paths if needed.
  - Spine:
    - Invariant: A recursive descendant run may be created only by the parent server control plane after private token and depth validation, and any created descendant must be root-visible with lineage metadata.
    - Owner boundary: parent server control handler plus `runTask.ts` scheduler owns creation/state; child tool is only a client/dispatcher.
    - Surface projections:
      - request file: dispatches private capability to child.
      - child tool: validates and dispatches.
      - IPC control server: validates and authorizes.
      - run scheduler/state: mutates durable state and snapshots.
      - README/tests: mirror/verify behavior.
    - Recovery semantics:
      - Reversible: transient IPC request and failed validation response.
      - Irreversible: durable run/event writes once valid descendant is scheduled; do not erase them during failure handling.
      - Exact intended effect already happened: report normal run status.
      - No intended effect happened: fail closed.
      - Wrong/mismatched irreversible effect happened: surface diagnostic; do not hide by deleting audit state.
    - Non-claims: no cascade cancel/tree UI/full descendant management in this slice.
  - Distributed invariant contract:
    - Decision: add shared typed recursive control contracts and equivalent owner-boundary proof through scheduler/run-view tests.
    - Invariant: lineage/depth and parent ownership across request file, control RPC, scheduler, snapshots, and docs.
    - Surfaces: request payload, child tool, control server, run state/view, README, tests.
    - Closing owner or equivalent owners: parent scheduler/run state is closing owner; control types are shared proof object for RPC shape.
    - Equivalent proof criteria: same run identifiers, depth increment before scheduling, fail-closed token/depth checks.
    - First side-effect boundary: durable descendant scheduling/child launch.
    - Bypass false-green: any sibling path can schedule without lineage or depth validation.
    - Killing proof or claim ceiling: focused integration tests plus typecheck/build/full test suite.

## Trace / Units

| AC / Source row / Boundary probe | Unit(s) | Evidence | Status |
|---|---|---|---|
| AC1 child gets native delegate tool | U1, U2 | E6, E8, E11 | VERIFIED |
| AC2 parent-owned descendant scheduler | U1, U3 | E6, E8, E11 | VERIFIED |
| AC3 run views include lineage/depth | U3, U4 | E7, E8, E11 | VERIFIED |
| AC4 bounded recursion rejects before launch | U1, U4 | E6, E8, E11 | VERIFIED |
| AC5 focused root visibility coverage | U4 | E8, E11 | VERIFIED |

## Unit Details

### U1
Goal: Add parent recursive control IPC contracts/server/client with token and depth validation.
AC / source-row / boundary-probe links: AC2, AC4
Files: `src/recursiveControl.ts`, `src/server.ts`, `src/types.ts`
Existing pattern to follow: `src/server.ts` handlers delegate durable run creation to `scheduleRunTask`; preflight rejection uses `ValidationError` reason codes.
Tests / checks: focused recursive tests, typecheck/build
Verification: E8, E11
Dependencies: discovery of scheduler APIs
Scope exclusions: no tree/cascade tools
Evidence IDs: E6, E8, E11

### U2
Goal: Inject one child-facing delegate tool into Pi children.
AC / source-row / boundary-probe links: AC1, AC2
Files: `src/piChild.ts`, new child tool module, `src/runSubagent.ts`
Existing pattern to follow: `src/piChild.ts` injects request-scoped `ToolDefinition` instances through `customTools`.
Tests / checks: fake child recursive integration
Verification: E8, E11
Dependencies: U1 control client
Scope exclusions: no child polling/cancel tool
Evidence IDs: E6, E8, E11

### U3
Goal: Persist and expose lineage/depth metadata in run state/views.
AC / source-row / boundary-probe links: AC2, AC3
Files: `src/runTask.ts`, `src/types.ts`, tests
Existing pattern to follow: `src/runTask.ts` builds active and terminal `RunTaskView` snapshots from `RunTaskState`.
Tests / checks: run view assertions
Verification: E8, E11
Dependencies: U1 scheduler options
Scope exclusions: no complete tree API
Evidence IDs: E7, E8, E11

### U4
Goal: Add fake-child tests for child-to-grandchild success and max-depth refusal.
AC / source-row / boundary-probe links: AC1, AC2, AC3, AC4, AC5
Files: `tests/helpers/fakePiChild.ts`, relevant `tests/*.test.ts`
Existing pattern to follow: existing fake child prompt sentinels and `connectFakeClient` MCP integration tests in `tests/run-subagent.test.ts`.
Tests / checks: focused test command, full suite
Verification: E8, E11
Dependencies: U1-U3
Scope exclusions: no live Pi dependency
Evidence IDs: E8, E11

### U5
Goal: Update docs and project memory mirrors.
AC / source-row / boundary-probe links: docs/runtime projection
Files: `README.md`, `.mex/*` as needed
Existing pattern to follow: existing README environment-variable list plus `scripts/check-docs-runtime-facts.mjs`.
Tests / checks: `npm run docs:check`, `mex check`, `mex sync`
Verification: E9, E10, E12
Dependencies: final source shape
Scope exclusions: no broad README rewrite
Evidence IDs: E9, E10, E12, E13

## Evidence Log

- E1 [ownership]: `git status --short` before edits showed pre-existing `M .mex/events/decisions.jsonl`; this task will preserve it unless GROW appends intentionally.
- E2 [context]: Loaded `.mex/ROUTER.md`, `.mex/context/architecture.md`, `.mex/context/conventions.md`, and `.mex/patterns/INDEX.md`; no existing recursion-specific pattern found.
- E3 [discovery]: `src/piChild.ts` currently passes only `createRequestInputTool(request)` in `customTools`, so recursive delegate availability requires request-scoped tool injection.
- E4 [discovery]: `src/runTask.ts` owns durable lifecycle through `startRunTask`/`scheduleRunTask`, active `tasks`, and `writeTaskSnapshot`; descendant ownership must go through these APIs to stay root-visible.
- E5 [discovery]: README has an environment variable section and `docs:check` extracts `SUBAGENT007_*` keys, so new env vars must be documented.
- E6 [change]: Added `src/recursiveControl.ts`, `src/recursiveDelegateTool.ts`, server startup wiring, and child request-file/tool injection. The parent server validates token/depth and schedules descendants through `scheduleRunTask`.
- E7 [change]: Added lineage fields to `RunTaskView` and state snapshots: `parent_run_id`, `root_run_id`, `recursion_depth`, and `child_run_ids`; threaded lineage through run/session child launches.
- E8 [focused-validation]: `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` => PASS, 55 tests. New recursive tests prove child-to-grandchild root visibility and max-depth no-launch behavior.
- E9 [validation]: `npm run typecheck` => PASS.
- E10 [validation]: `npm run docs:check` => PASS.
- E11 [validation]: `npm test` => PASS, 197 tests.
- E12 [memory-validation]: `mex check` => PASS, drift score 100/100; `mex sync` => PASS, no drift.
- E13 [record]: `mex log --type decision ...` recorded the parent-owned recursive delegation decision.
- E14 [review]: Diff reviewed for scope and token exposure. Public fake `ECHO_REQUEST` output redacts `recursiveControl.token`; the child-facing delegate tool returns run views/rejections, not the private control token.
- E15 [validation]: `npm run build` => PASS after source edits; `npm test` also rebuilt `dist/` through `pretest`.
- E16 [change]: Added durable-run contract capability `recursive_delegate_lineage` and test coverage asserting `get_run_contract` advertises it.
- E17 [tightening]: Moved recursive caller-lineage authority into `runTask.ts` via `lineageForRecursiveDelegate`, so the scheduler derives descendant lineage from active parent run state instead of trusting the IPC payload tuple.
- E18 [tightening]: Removed unused private child request field `max_recursion_depth`.
- E19 [focused-validation]: `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` => PASS, 56 tests. Added forged-lineage no-launch negative coverage.
- E20 [validation]: `npm run build` => PASS, `npm run typecheck` => PASS, `npm test` => PASS, 198 tests after tightening.

## Residuals

- None currently.

## Final Readiness

Status: READY
Validation:
- `npm run build` => PASS.
- `node scripts/run-tests-with-ledger-guard.mjs tests/run-subagent.test.ts` => PASS, 56 tests.
- `npm run typecheck` => PASS.
- `npm run docs:check` => PASS.
- `npm test` => PASS, 198 tests.
- `mex check` and `mex sync` => PASS.
Validation rationale:
- Focused recursive tests exercise the actual built MCP server, fake child request-file contract, private IPC, parent scheduler, `get_run`, lineage metadata, depth rejection, and forged-lineage rejection. Full test suite covers existing lifecycle/schema/session/readiness behavior after the public view change and tightening.
Final invariant readiness check:
- Trusted effect: child `delegate` requests create descendants only through the parent server scheduler.
- Authority source: private recursive control token plus active parent `RunTaskState`; descendant scheduling still goes through `scheduleRunTask`.
- Projections checked: child tool injection, request-file payload, IPC handler, durable snapshots/views, README/env docs, project memory.
- Nearest surviving false-green: no known in-scope false-green after focused root-visible grandchild, max-depth no-launch, and forged-lineage no-launch tests.
- Residual boundary: full tree management and cascade cancellation remain out of scope by contract.
Residuals:
- None for the approved first recursive slice.
Ledger:
- `.work/cohExecLedger-2026-07-07-recursive-subagent.md`
