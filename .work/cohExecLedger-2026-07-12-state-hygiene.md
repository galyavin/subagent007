# Work Ledger: State hygiene

## Contract

Source:
- User-approved revision from the 2026-07-12 hygiene audit and stress test.

Scope:
- Give the test process tree one runner-owned temporary root and remove it on settlement.
- Canonicalize terminal run events and settled input views into the terminal snapshot, then remove redundant event-ledger and mailbox files.
- Remove named-session attempt workspaces after promotion or failure telemetry is persisted.
- Synchronize tests, README, and project memory with changed persistence behavior.

Non-goals:
- No automatic age/count retention and no deletion of existing production state.
- No deletion of outputs, terminal snapshots, canonical named sessions, active runs, pending inputs, or campaign evidence.

Acceptance Criteria:
- AC1: A successful or failing test child leaves no runner-owned suite temporary root.
- AC2: Terminal `get_run` remains stable in-process and after restart when event-ledger and mailbox files are absent.
- AC3: Working and input-required runs retain event-ledger and mailbox state.
- AC4: Successful and failed named-session turns leave no attempt workspace while canonical resume and audit metadata remain correct.
- AC5: Source, tests, README, and project memory describe the same terminal-compaction behavior.

Risk Flags:
- Persistence, filesystem deletion, restart behavior, public result semantics, cleanup ordering.

Task profile:
- trust-bearing-model-first; cleanup/delete and durable state transitions are in scope.

Ledger profile:
- expanded; kernel, spine, preimage, writable-surface, and direct boundary evidence are triggered.

Trust Model:
- Protected effect: only redundant, operation-owned scratch/state is deleted after its durable successor is authoritative.
- Authority source: terminal `RunTaskView` snapshot and committed named-session manifest/ledger or attempts ledger.
- Kernel operation points:
  - test runner allocation/child exit/removal;
  - terminal snapshot canonicalization/atomic rename/event and mailbox cleanup;
  - session promotion or failure record/attempt cleanup.
- Allowed side effects: runner-owned suite root; terminal snapshot replacement; deletion of that run's event ledger/mailbox directory; deletion of that turn's attempt directory.
- Forbidden side effects: deleting active/input-required state, output artifacts, canonical session data, campaign evidence, or sibling run/session paths.
- Recovery: cleanup follows the authoritative write; a crash before cleanup leaves redundant data, while a crash after cleanup retains canonical state.
- False-green falsifiers:
  - FG1: cleanup runs before terminal snapshot rename -> restart test must lose data and fail.
  - FG2: terminal `get_run` re-reads removed mailbox and returns no settled inputs -> in-process and restart assertions fail.
  - FG3: session attempt cleanup removes canonical promoted state -> resume test fails.
  - FG4: test wrapper cleans only the ledger fixture -> post-child suite-root absence assertion fails.
- Spine invariant: cleanup is projected only from the owner that has observed successful successor persistence.
- Preimage: cleanup targets are derived from owner-created run/session ids and exact owner roots; no caller-selected arbitrary deletion path is accepted.
- Writable surface partition:
  - writable/deletable: runner-created suite root; exact terminal run ledger/mailbox paths; exact attempt directory.
  - protected: outputs, snapshots, canonical sessions, repository files outside task edits, sibling state, user campaign roots.

Boundary Closure Mini-Gate:
| Projection / claim | Nearest false-green | Killing proof | Earliest forbidden side effect | Status |
|---|---|---|---|---|
| AC1 | child exit leaves suite fixtures | wrapper integration test/readback | host temp root fixture remains | VERIFIED |
| AC2 | snapshot loses events or inputs after cleanup | terminal/restart focused tests | redundant file removed without canonical view | VERIFIED |
| AC3 | active state compacted | active/input-required focused assertion | active event/mailbox removed | VERIFIED |
| AC4 | canonical or diagnostic session state removed | success/failure/resume session tests | canonical session removed | VERIFIED |

## Trace / Units

| AC / probe | Unit(s) | Evidence | Status |
|---|---|---|---|
| AC1 / FG4 | U1 test runner | E4, E9 | VERIFIED |
| AC2 / FG1 / FG2 | U2 terminal compaction | E5, E6, E9 | VERIFIED |
| AC3 | U2 terminal compaction | E5, E9 | VERIFIED |
| AC4 / FG3 | U3 session attempts | E7, E9 | VERIFIED |
| AC5 | U4 docs and memory | E8, E10 | VERIFIED |

## Evidence Log

- E1 [discovery]: `scripts/run-tests-with-ledger-guard.mjs` owns the test child and already settles a private ledger fixture.
- E2 [discovery]: `writeTaskSnapshot` atomically renames snapshots; terminal views already carry bounded events and input request views.
- E3 [discovery]: `prepareAttemptSession` creates a run-id-scoped attempt directory and promotion copies its contents to canonical session storage.
- E4 [validation]: `tests/test-ledger-guard.test.ts` proves runner-owned `TMPDIR`/state paths are removed on success and intentional guard failure.
- E5 [validation]: `tests/input-mailbox.test.ts` proves pending-input compaction refusal and settled mailbox removal.
- E6 [validation]: completed-run and restart-drift tests prove terminal events/settled inputs survive event-ledger/mailbox removal in-process and after restart.
- E7 [validation]: named-session success, resume, missing-packet, and failed-resume tests prove exact attempt workspace removal while canonical continuity and audit metadata survive.
- E8 [docs]: README, durable-run capability, `.mex` architecture/decision/pattern surfaces synchronized with terminal compaction and suite isolation.
- E9 [integration]: `npm test` => 206 passed, 0 failed.
- E10 [validation]: `npm run typecheck`, `npm run build`, `npm run docs:check`, `git diff --check`, and `mex check` passed after final edits.
- E11 [containment]: final readback found zero `/tmp/s7t-*` roots and zero PPID-1 `fake-pi-child.cjs` processes after removing only provably orphaned fake test children.
- E12 [tightening]: fresh-context implementation review removed terminal-event overlap branching in favor of chronological merge and made non-fatal cleanup failures observable without changing committed outcomes.

## Residuals

- Automatic retention policy remains explicitly out of scope.

## Final Readiness

Status: READY

Validation:
- `npm test` => 206 passed, 0 failed.
- `npm run typecheck` => passed.
- `npm run build` => passed.
- `npm run docs:check` => passed.
- `mex check` => passed.

Final invariant readiness check:
- Trusted effect: redundant run/session/test state is deleted only after its successor is durable or the suite owner settles.
- Authority owner: terminal snapshot writer, named-session commit/failure owner, and test runner.
- Projections checked: active/terminal `get_run`, restart drift, input settlement/rejection, named-session promotion/failure/resume, README/contract/memory.
- Nearest surviving false-green: historical state remains because automatic retention and migration are explicitly out of scope.
