---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
last_updated: 2026-08-08
---

# Decisions

### Runs are execution attempts, not caller missions
**Date:** 2026-07-23
**Status:** Active
**Decision:** Subagent007 is a universal execution-attempt substrate. One `run_id` denotes one concrete attempt from exact admission through live observation/control to durable terminal evidence. `client_start_id` binds one exact normalized start request; it is not an objective or retry-series key. `session_id` carries semantic context only. The current execution owner is the only live custodian, and definite owner loss closes the same run honestly as terminal `restart_drift` rather than claiming reattachment. Callers retain durable objective identity, canon/workflow state, replacement authorization, reconciliation, and external-effect safety.
**Reasoning:** “Same work” and whether it may be tried again are domain decisions that a universal runner cannot infer from a prompt, session, process exit, or elapsed time. Making every run survive process loss would require a real persistent job custodian, not extra status fields or caller-specific policy inside this local MCP server. Separating the durable logical obligation from the durable attempt record keeps Subagent007 minimal and lets Bendum and other callers compose their own semantics without turning this repository into a pet workflow engine.
**Consequences:** Exact ambiguous-start replay uses caller-persisted `client_start_id` and identical request bytes to recover the same `run_id`. A replacement always receives a fresh attempt identity after the caller settles prior terminal/descendant evidence and ambiguous effects. No Bendum-specific objective state, retry controller, speculative lifetime enum, second run store, or second control plane is added. Stronger live custody is a future additive capability only if a current universal requirement names an owner that can actually enforce it.

### Scoped authoring binds exact outputs or one fresh state subtree
**Date:** 2026-07-21
**Status:** Active
**Decision:** Add only `allowed_output_paths` to the existing constrained v3 run request family. `task_root_authoring_v1` requires that exact canonical new-file list. Researcher/AJ instead receive one fixed fresh-only `.subagent007/<profile>` writable state subtree; their direct tools and controller mutation paths share it, while read-only controller inputs may reference the immutable outside task tree. Parent and child capture/compare exact task-root and bounded initial-tree identity in activation receipt v2. Terminal reinspection runs after every settled child outcome. Immutable and writable trees reject sparse/multi-link entries and use separate size ceilings.
**Reasoning:** Subagent007 can observe Pi tool dispatch, owned path/controller calls, and terminal filesystem state, but it does not own Bendum's semantic manifests or an OS sandbox. Exact output paths and fixed state roots are the smallest enforceable closures that prevent transient substitution through the available tool/controller surfaces without importing a second semantic schema.
**Consequences:** Bendum must stop forwarding `input_manifest`, derive sorted canonical exact `allowed_output_paths` for neutral builder runs, require capability `authoring_effect_scope_binding`, and validate receipt schema 2 and its exact scope binding. Same-key changes to output closure conflict through the existing idempotent request hash. Legacy/v2 no-key behavior and creator-named schema-1 activation stay unchanged.

## Decision Log

### Recursive semantic edges have an opt-in digest witness
**Date:** 2026-08-08
**Status:** Active
**Decision:** Add optional root `recursive_edge_witness:"prompt_sha256_v1"` only with enabled recursion. Inherit it from active parent state outside the model-facing delegate schema. Bind each child run to the SHA-256 and UTF-8 byte count of the exact raw recursive prompt received before normalization or child-prompt composition; persist no additional raw prompt or ancestor witness map.
**Reasoning:** Existing lineage, settlement, Git effects, and outputs witness what descendants did but not which model-authored Task crossed an edge. A caller-owned Task artifact plus this digest resolves that one mechanical uncertainty without asking the host to store prompts, judge narrowing, certify return consumption, or own AB1 workflow state.
**Consequences:** The unsalted digest is public and can reveal equality or enable guessing of low-entropy prompts, so it is opt-in and unsuitable for secrets. Omission is unchanged. Existing private `delegate`/`rejoin` output delivery remains sufficient mechanical transport evidence; semantic integration still requires product dependence, tests, or ablation rather than a host receipt that cannot observe cognition.

### Governing system skills are current catalogue roles, not snapshots or workflow state
**Date:** 2026-07-30
**Status:** Active
**Decision:** Add optional `system_skill_name` only to the ordinary run surfaces. Resolve it through the existing canonical catalogue, reject equality with ordinary `skill_name` and combinations that remove ambient tools, expose the normal catalogue minus only that governing entry, and append its current body with the last inline `before_agent_start` handler. Recursively enabled descendants inherit the resolved name only through private caller context; the model-facing delegate schema cannot select or change it. A strict receipt reports the child-observed name, canonical path, source digest, final Pi system-prompt digest, and exactly-once suffix placement under an explicit Pi-prompt-only observation ceiling.
**Reasoning:** First-cycle recursive-governor canaries require system-level embodiment while preserving Pi base/project instructions, ambient tools, and progressive specialist disclosure. Pi's ordered inline-extension and resource-loader seams provide that composition without forking Pi or importing caller workflow doctrine. Snapshotting the governing body would contradict current-source reentry semantics and manufacture a second semantic source.
**Consequences:** Ephemeral, fresh, raw-resume, and recursive launches reread current source; named sessions and effect profiles remain outside this smallest mode. No governing prompt copy, immutable snapshot, version ledger, session-manifest field, queue, DAG, acceptance state, or semantic-compliance claim is added. The receipt does not witness later `before_provider_request` rewrites, provider serialization, or model obedience.

### Execution routing and timeout policy are explicit caller inputs
**Date:** 2026-07-27
**Status:** Active
**Decision:** Remove prompt-text classification from one-shot routing and durable timeout admission. Every valid `run_subagent` request remains a bounded synchronous one-shot. Durable execution requires the caller to choose `start_run` or `schedule_run`, and timed tools apply only mechanical numeric timeout validation.
**Reasoning:** Prompt wording cannot reliably determine breadth, duration, write intent, cancellation needs, or deadline policy. Letting lexical heuristics choose the execution surface or reject an otherwise valid timeout made lifecycle authority implicit and produced false positives.
**Consequences:** Retired one-shot routing result fields and prompt-derived reason codes are rejected in current durable snapshots rather than migrated. Callers must select the durable surface directly when they need polling, cancellation, input, or a caller-specified hard deadline.

### Bounded get_run waits only on resident owner publication
**Date:** 2026-07-27
**Status:** Active
**Decision:** Add optional nonnegative `wait_ms` to public `get_run`. Omission/zero remains an immediate snapshot. A positive request is capped by the existing scheduler wait ceiling and, only while the run is resident in this process, waits on post-owner-release committed-state publication until `input_required`, terminal state, or one expiry timer. Heartbeats/progress may trigger condition checks. Nonresident/persisted reads return current truth immediately.
**Reasoning:** Subagent007 may wait only on attempt state its serving owner can authoritatively observe. Resident publication already marks the committed observable boundary; filesystem polling or a public revision would manufacture cross-process observation semantics without an owner-record event stream. Reusing the existing cap and condition source keeps waits bounded without adding a queue, database, tool, schema migration, or mission/retry policy.
**Consequences:** Public callers can block boundedly for actionable resident state without timer polling. `schedule_run` uses the same publication-driven mechanic while retaining its distinct default and wait metadata. A foreign/nonresident observer may need a later `get_run` call to see newer persisted truth. Owner loss continues to reconcile honestly to terminal `restart_drift`, and operation failures remain structured.

### Recursive delegate omission waits at the caller-without-poll boundary
**Date:** 2026-07-25
**Status:** Active
**Decision:** Only the private child-facing `delegate` adapter normalizes omitted `wait_ms` to 30000 ms. Explicit zero and positive values remain exact before the existing scheduler ceiling, and public `schedule_run` keeps its 1000 ms omission default. The delegate surface calls the optional termination authority `hard_timeout_ms`; only an explicit value maps to the existing internal durable `timeout_ms`, while omission forwards no hard lifetime. No polling/cancellation tool or second lifecycle owner is added.
**Reasoning:** Public scheduler callers can recover an active result through `get_run`; recursive children receive one sequential `delegate` response and cannot poll. The former shared one-second default returned `working` for an observed 15.6-second child that later completed, leaving the parent unable to consume the answer. A bounded private default is the smallest owner-observable repair.
**Consequences:** Ordinary descendants settling within the effective bound return usable terminal evidence to the same tool call. `wait_ms:0` remains intentional parallel work but does not detach descendant ownership. Configured lower ceilings may truncate omission, and children exceeding the effective bound can still return `working`; that survivor does not authorize retrying the same attempt or claiming an answer.

### Terminal output identity is issued by the descriptor finalizer
**Date:** 2026-07-24
**Status:** Active
**Decision:** Durable-run v3 terminal child output has exactly one primary file reference containing only one canonical provider basename, exact bounded size, lowercase SHA-256, fixed Markdown/UTF-8 metadata, and output mode. Public top-level `output_path`, reference `path`, active partial-output locators, and failure-log output paths are absent. One 1 MiB no-follow regular single-link descriptor finalizer owns normal write, streaming publication, and restart recovery: it captures an exact retained descriptor tuple before the pre-rename hook, requires exact descriptor/path identity after it, renames, captures post-rename `S0`, hashes exactly `S0.size` descriptor bytes with a hard ceiling and short-read rejection, requires exact regular single-link `S1`, and verifies the final pathname names `S1` before emitting only `S1` size/SHA-256.
**Reasoning:** A pre-rename hash cannot describe a rewrite in the rename window; a post-rename descriptor hash directly attests the bounded finalized bytes while avoiding pathname reopen authority. Cross-rename ctime reasoning describes filesystem behavior rather than the public evidence. Persisting or returning an output root would create another authority distinction; the configured runs root plus one relative basename is sufficient.
**Consequences:** This is a bounded point-in-time final-state witness, not prevention of arbitrary later mutation; callers such as Bendum recapture from their configured runs root. Path-only current-v3 records fail closed and are neither migrated nor assigned a synthesized digest. Terminal documents larger than 1 MiB fail. Current owner/copy inspection accepts only the exact reference and compares copied bytes to provider size/SHA-256. Transcript streaming/backpressure, final-only semantics, restart drift, sessions, and one-claim owner transitions remain on their existing owners. No lock, copy, store, state machine, durable distinction, or compatibility path is added. Declared authoring-artifact count/size changes are outside this decision.

### Durable runs have one per-run state owner
**Date:** 2026-07-22
**Status:** Active
**Decision:** Reuse the existing per-run owner for every claim-bearing transition. Resident state is the only live semantic source; otherwise the durable owner record is. Producers submit named operations, never complete snapshots. Under the owner, read fresh truth, apply to a private draft, derive/validate the unchanged v3 public view, commit the next revision, and synchronously publish. Construct canonical events once in the draft and append the same bytes only after owner commit as non-authoritative JSONL staging. Keep mailbox I/O, waits, failure logging, and cross-run work outside locks. Reconcile descendants by parent read/release, descendant inspection, then fresh parent reacquisition and semantic reassessment.
**Reasoning:** Multiple full-view writers and JSONL overlays could each overwrite facts they did not freshly observe. Nested parent/descendant ownership could deadlock, while rejecting every changed revision would let unrelated heartbeats starve restart convergence. One observable owner can enforce terminal absorption, event-specific idempotency, and exact persistence/projection joins without adding a reducer framework or new schema.
**Consequences:** Spawn, heartbeat/progress, input, cancellation, output/session/lifecycle evidence, terminalization, and restart reconciliation cannot stale-roll back one another. JSONL/input files remain staging and telemetry, never repair authority. Stable events may exact-no-op; general evidence remains observable. The valid SIGKILL control required one pre-authorized gate on the existing stdin pipe, so consequential child work waits for the post-owner-commit release and EOF exits. Public durable-run v3 bytes remain unchanged; no parallel store, queue, controller, or lifecycle field was added.

### Durable start identity is owner-bound before execution admission
**Date:** 2026-07-21
**Status:** Active
**Decision:** Durable-run contract v3 adds optional `client_start_id` only to `start_run`. One strict schema-normalized canonical request identity excludes only that key and uses deterministic code-point key ordering. The existing run-task store atomically persists and fsyncs key to request-hash/run-id before queue or child admission; replay does not rerun mutable launch preflights.
**Reasoning:** Bendum must survive ambiguous transport/process loss without creating a second run, but a caller key cannot authorize a changed body or counterfeit reattachment.
**Consequences:** Exact replay returns the same run across processes, changed bodies reject as `client_start_id_conflict`, and live concurrent admission reads the already-promoted canonical run promptly without polling. If another promoter removed the private candidate, the join re-resolves the authoritative key/request digest and accepts that exact canonical run in any valid current lifecycle state, including child-started work or terminal completion. One shared run-task validator now guards current-v3 snapshot publication/readback and the replay join, rejecting impossible active/result/error combinations. Configured runtime persisted-run reads accept only `subagent007.current_run_claim`; direct-v2, bare-v3, and historical owner envelopes fail without mutation. For owner terminals it derives declaration-only, observed, and settled phases from existing fields: declarations remain valid before child launch, observations reuse the existing strict receipt validators after prompt submission, and one exact final settlement event is required. A process-zero result may still be a typed durable failure when post-run contract validation fails. Definitely lost execution ownership produces the existing owner-issued terminal restart drift. No lookup tool, queue, service, or second run store was added.

### Retained snapshot source resolution stays inside the snapshot owner
**Date:** 2026-07-21
**Status:** Active
**Decision:** Add one public `resolve_retained_skill_snapshot_source` v1 operation to the existing snapshot family. It accepts one exact committed retained identity, resolves immutable private bytes itself, accepts active/closed references, and returns only the existing owner-controlled content-addressed runtime source identity after complete validation.
**Reasoning:** Rollback needs immutable predecessor bytes, but caller access to private store paths or caller-path publication would split authority. The runtime cannot atomically bind a caller-selected publication path to continued authorized ancestry, and a generic export/control plane would exceed the requirement.
**Consequences:** Exact retries are idempotent and zero-write; no caller staging path, copy, lock, cache, or retained-state mutation exists. Consumers that copy the resolved source revalidate under their own transaction. Internal content-addressed bundle materialization, reference closure, and impact-confirmed deletion remain separate.

### Researcher and AJ bounded profiles use fixed snapshot-owned controllers
**Date:** 2026-07-19
**Status:** Active
**Decision:** Add exactly `researcher_bounded_v1` and `assumption_audit_bounded_v1` as additive Pi effect ceilings. Each requires exact canonical `skill_name`, an active complete immutable snapshot binding, and ephemeral/fresh continuity with recursion disabled. The ordered tool list is the six bounded task-root filesystem tools, `web_search`, `web_read`, and one profile-specific controller. The controller wrapper discovers inherited-`PATH` `python3` candidates only in the parent, admits the first realpath that imports the profile-owned fixed requirements (`json` for Researcher; `json` and `yaml` for AJ), then invokes only that parent-bound resolved absolute realpath plus the exact snapshot `scripts/researchctl.py` or `scripts/aj.py` via `execFile`. Parent and child recheck regular-file identity, SHA-256, and required imports; the child/controller never substitutes a `PATH` interpreter. It validates bounded data/path arguments and retains state/artifacts under the exact real task root.
**Reasoning:** Researcher and AJ need Smith authoring-phase state transitions without ambient shell, arbitrary executables, unrestricted writes, mutable skill source, or controller-path substitution. A callable-tool ceiling alone cannot constrain filesystem side effects, so the existing task-root guards are shared and controller-owned I/O is separately bounded.
**Consequences:** Parent and Pi child activation receipts bind the explicit web provider and a combined SHA-256 over the fixed controller wrapper, exact snapshot script, and resolved Python realpath/file SHA-256. An AJ launch with no YAML-capable candidate fails closed as `effect_profile_activation_failed` before a Pi child is spawned; Researcher remains stdlib-only. URLs remain data only outside owned path arguments. The boundary claims Pi tool dispatch, owned path guards, and owned subprocess invocation only; it does not claim an OS sandbox or hostile-runtime containment. Existing profiles and omitted behavior remain unchanged.

### Batch skill verification is a point-in-time public owner boundary
**Date:** 2026-07-16
**Status:** Active
**Decision:** `verify_skill_bindings` contract version 1 accepts one absolute cwd and 1–64 unique, strictly ASCII name-sorted canonical skill/digest pairs. Subagent007 resolves the complete set through one catalog and uses the same skill-file read/hash/compare primitive as launch. The transient all-or-nothing response binds cwd, count, and the canonical request SHA-256; launch retains its independent recheck.
**Reasoning:** Callers such as Bendum must reject mismatched name/digest pairs before publishing routes, but importing private build modules or reproducing Subagent007 discovery would split authority. Starting a child merely to compare local bytes would add model/runtime dependency and operational state without improving the comparison.
**Alternatives considered:** Caller-side resolution and hashing (rejected as duplicate authority), one MCP call per skill (rejected because partial responses are not bound to the complete publication set), and a model-backed canary (rejected because it creates unnecessary child/run state).
**Consequences:** The durable-run contract stays at version 2 and advertises additive capability `batch_skill_binding_verification`. The operation invokes no model or child and writes no run/session/admission/snapshot/lease/event/temp/cache/failure-log state. Typed semantic failures distinguish unknown, ambiguous, unreadable, mismatch, and cwd failures; malformed request shape remains a standard MCP input error. The receipt is point-in-time evidence, not a durable filesystem transaction or substitute for launch-time checking.

### Session ownership survives time and partial publication
**Date:** 2026-07-15
**Status:** Active
**Decision:** Named-session locks never transfer merely because time elapsed; only matching release or definite local owner death permits recovery. Successful candidate-session promotion writes a hash-verified pending commit before atomically publishing the canonical file, idempotently appending its `run_id` ledger record, and publishing the manifest. The attempt workspace remains until those durable effects are verified. New active-child lease filenames include both the encoded run id and owner id; unreadable legacy owner-only leases retain capacity but return explicit unknown liveness.
**Reasoning:** A duration cannot prove a live local session owner lost authority. Likewise, replacing canonical state before its ledger and manifest advance can leave callers with conflicting durable views. Legacy unreadable lease files lack enough identity to safely attach to a particular run, but treating them as absent would allow destructive restart drift.
**Consequences:** Interrupted session promotion resumes from one marker without a false canonical/ledger/manifest combination or duplicate record. Session inspection reports `operation_rejected` with `run_liveness_unknown` for legacy ambiguity, and restart reconciliation leaves that snapshot untouched until ownership becomes observable.

### Complete public transcripts replace raw child spools
**Date:** 2026-07-12
**Status:** Superseded only for the terminal byte bound by the 2026-07-24 descriptor-finalizer decision
**Decision:** Child output is parsed incrementally and written directly to one sanitized public transcript staging file. Canonical transcript files have no per-artifact byte cap; bounded MCP events and excerpts remain separate projections. A protected free-space reserve stops a run cleanly before host exhaustion instead of silently truncating its transcript.
**Reasoning:** The former 256 KiB render cap discarded useful output but did not constrain the unbounded private `combined-output.log` files that exhausted the disk. Removing the redundant raw spool eliminates the dangerous accumulation path and makes backpressure, publication, and cleanup share one observable owner.
**Consequences:** Resource exhaustion is a typed `resource_exhausted` / `disk_reserve_exhausted` failure across run results, sessions, and failure telemetry. Canonical transcripts are durable outputs, not default retention targets. Public partial transcript files are named by run ownership; recovery converges on the same referenced output whether interruption occurs before or after the atomic `.partial` to `.md` rename.

### Build publication keeps runnable entrypoints continuously available
**Date:** 2026-07-12
**Status:** Active
**Decision:** Builds compile into versioned release directories, atomically switch `dist/current`, and keep stable launcher files present. Live server processes lease their release; cleanup removes only inactive unleased releases while retaining the current and immediately previous release.
**Reasoning:** Deleting shared `dist/` before compilation created a caller-visible window where server and child entrypoints did not exist. Versioned publication separates compilation failure from runtime availability and gives release cleanup an observable owner.
**Consequences:** `npm run clean:dist` prunes inactive releases instead of deleting live entrypoints. Runtime code locates the project root independently of its versioned release depth.

### Terminal snapshots own compacted durable run state
**Date:** 2026-07-12
**Status:** Active
**Decision:** Active runs keep append-only public event ledgers and input mailbox files. After terminal input settlement and terminal event projection, the atomically renamed terminal snapshot becomes authoritative for bounded events and settled input views; only then are the redundant event ledger and run mailbox directory removed. Named-session attempt directories are likewise removed after canonical promotion or durable failure telemetry.
**Reasoning:** The previous create-only filesystem lifecycle made successful tests and production terminal state grow monotonically. Snapshot-first compaction preserves restart inspection and input status while assigning cleanup to the owner that can observe safe terminal persistence.
**Consequences:** `get_run` must use terminal snapshot input/event projections rather than treating absent compacted files as empty live state. Active-child leases remain held until that terminal snapshot is durable; a persistence failure retains ownership fail-closed rather than exposing false restart drift. Attempt session ids are historical telemetry, not durable readable paths. Outputs, terminal snapshots, canonical sessions, active runs, and pending inputs are not retention targets.

### Acknowledged input is one version-2 contract
**Date:** 2026-07-10
**Status:** Active
**Decision:** Durable runs expose one caller-input contract at durable-run version 2. `answer_run_input` requires `response_id`; the raw answer is held only in live process memory, crosses the private stdin control channel, and produces a receipt only after the correlated child waiter accepts it. The request/terminal mailbox records persist only safe identifiers, status, and receipt metadata.
**Reasoning:** Bendum needs a dependable governed operator handoff without plaintext operational retention or a public mode decision. Retaining the former dual input paths would preserve incompatible delivery guarantees and unnecessary state.
**Consequences:** Exact live retries return the original receipt without redelivery; changed answer bodies under the same response identity reject. A run-owned mutation queue makes acknowledgment, cancellation, finalization, and pending closure deterministic. Process loss fails the run closed, so no cross-restart answer recovery is promised.

### Validation reason codes are explicit data, not message parsing
**Date:** 2026-07-09
**Status:** Active
**Decision:** Failure-log reason mapping and handler-level preflight retry guidance use `ValidationError.reasonCode` when present and otherwise report no inferred semantic code or guidance; neither inspects validation message text to derive semantics.
**Reasoning:** Message parsing made public telemetry and caller guidance depend on prose that can drift independently from caller contracts. Typed reason ownership belongs at the validation throw site, where the author knows the semantic failure.
**Alternatives considered:** Keep the message fallback as defense in depth (rejected because it silently hides missing structured codes), or centralize message strings and codes together (rejected because it still couples telemetry to copy).
**Consequences:** New semantic validation paths must pass an explicit reason code. New retry guidance must be selected by that code, and tests should assert both explicit-code preservation and unknown fallback for uncoded validation errors.

### Legacy provider compatibility surfaces are removed without migration
**Date:** 2026-07-27
**Status:** Active
**Decision:** Remove public tool alias `list_allowed_models` and input properties `skill` and `tool_profile` immediately. `list_model_classes` and `skill_name` are the only canonical surfaces. Strict MCP schemas reject retired properties before handler invocation, direct validation rejects instead of ignoring them, client-start identity refuses to canonicalize them, and current-v3 snapshots fail closed when they contain retired request residue.
**Reasoning:** These surfaces no longer have authority or a migration sponsor. In particular, the ignored tool selector conveyed no effect ceiling, while dual skill names and a model-list alias made the current provider body inexact.
**Alternatives considered:** Shims, aliases, dual schemas, ignored parsing, persisted-state coercion, and a migration window were rejected by the approved immediate-removal requirement.
**Consequences:** The public inventory is exactly 20 tools. Canonical `skill_name` resolution, expected digest/snapshot evidence, `effect_profile` ceilings, recursive delegation, model-class health, owner/idempotency, sessions, and waiting semantics remain unchanged. Historical append-only MEX events may still describe the former contract but are not active guidance.

### workspace_read_only is an additive Pi-boundary ceiling
**Date:** 2026-07-15
**Status:** Active
**Decision:** `effect_profile:"workspace_read_only"` is the explicit public effect ceiling. It disables ambient project/global extension loading, explicitly binds and digests the web provider and native `request_input`, constructs Pi with only `read`, `grep`, `find`, `ls`, `web_search`, `web_read`, and `request_input`, excludes `delegate`, and requires an exact receipt before prompt submission. The native provider digest covers its owning runtime modules and excludes unrelated release and live lease files. Omission preserves all-tools behavior; named sessions reject the new field.
**Reasoning:** Prompt policy and post-effect detection cannot deny an effect. Pi's construction-time `tools` allowlist owns ordinary model-issued tool dispatch, while extension loading must be disabled separately because extension hooks run outside that callable list.
**Alternatives considered:** Reintroduce an ignored or ambiguous selector (rejected because it conveys no authority), filter only after session construction (rejected because extension hooks would already have run), or claim OS sandboxing (rejected because this slice does not own hostile runtime code or direct host APIs).
**Consequences:** The durable contract advertises exact tools, continuity modes, provider binding, receipt fields, and claim ceiling. Raw resume must supply the profile on every constrained invocation. Failure is typed as `capability_unavailable` with `effect_profile_activation_failed` or `skill_content_mismatch`.

### Skill content pins execute from run-owned snapshots
**Date:** 2026-07-15
**Status:** Active
**Decision:** `expected_skill_sha256` requires canonical `skill_name`. The parent resolves and hashes canonical `SKILL.md` before launch, copies those bytes into the owned child-request directory, and Pi rehashes/expands that snapshot before prompt. Public receipt/result paths continue to identify the canonical source.
**Reasoning:** Pi expands `/skill:name` by rereading `skill.filePath` at prompt time. Hashing only the source path before launch leaves a time-of-check/time-of-use gap between the receipt and the bytes Pi actually sends to the model.
**Alternatives considered:** Report the digest only after execution (rejected as too late), re-read the canonical path in the child without snapshotting (rejected because Pi would read it again), or expose the private snapshot path (rejected because callers need stable canonical identity).
**Consequences:** Source mutation or disappearance fails closed before prompt; owned-temp cleanup removes snapshots with the child request; omitted expected digests preserve legacy behavior.

### Session failures preserve durable caller context
**Date:** 2026-07-08
**Status:** Active
**Decision:** Terminal failures from durable session tasks log the public entrypoint that created the run, the durable `run_id`, and `task_kind:"session"`; `get_run_contract` exposes session start tools under `tools.session_start` without changing the existing run-only `tools.start` tuple.
**Reasoning:** Session tools create normal durable run-task snapshots, so callers and operators need failure telemetry and adapter contract discovery to line up with the `run_id` they receive from `start_session_run` or `run_subagent_session`. Misattributing async session packet failures to the compatibility wrapper made telemetry ambiguous.
**Alternatives considered:** Only document the caveat (rejected because correlation stayed broken), only add `run_id` to failure records (rejected because the public tool was still wrong), or mutate `tools.start` to include session tools (rejected because adapters may already depend on the existing tuple).
**Consequences:** Observed `full-current` includes `start_session_run` packet-failure telemetry correlation; failure-log tests assert `tool`, `run_id`, and `task_kind` for session packet failures.

### Final-mode success requires a captured final message
**Date:** 2026-07-08
**Status:** Active
**Decision:** Runs that request `output_mode:"final"` fail with `reason_code:"missing_final_output"` when the child process exits cleanly but no final message artifact is captured.
**Reasoning:** A clean process exit only proves the child stopped. It does not prove the caller received the verdict they asked for, and treating a progress transcript as success made unattended campaign episodes look healthy after a child stalled before finalization.
**Alternatives considered:** Add a designer-in-chief-specific smoke check (rejected because the failure is a generic final-output contract breach), keep falling back to transcript success (rejected because it hides missing verdicts), or infer success from side effects/artifacts (rejected because the public contract is the requested output mode).
**Consequences:** Public run results, named-session projections, and failure logs use `missing_final_output`; transcript fallback remains diagnostic output for failures/timeouts/cancellations, not a substitute success path for requested final output.

### Named-session manifest eligibility preflights before durable task registration
**Date:** 2026-07-04
**Status:** Active
**Decision:** Session tools reject deterministic manifest eligibility failures before creating a durable run task when the failure is knowable without launching a child, for example `resume_mode:"require_existing"` with no matching session.
**Reasoning:** These failures are front-door caller errors, not child execution outcomes. Returning a `run_id` and requiring polling was ambiguous because no child started, yet callers could not see `child_started:false`.
**Alternatives considered:** Leave missing sessions as background terminal failures (rejected as caller-hostile), or move all session locking/reconciliation into preflight (rejected because the locked execution path must remain the race authority and preflight should stay read-only).
**Consequences:** Such failures return `kind:"preflight_rejected"`, `child_started:false`, and a typed `reason_code`, and they log one validation failure. The locked session path still repeats checks to handle races and stale state.

### Operation semantic rejections are not preflight rejections
**Date:** 2026-07-01
**Status:** Active
**Decision:** `get_run`, `answer_run_input`, and `cancel_run` ValidationErrors return structured `kind:"operation_rejected"` results with typed `reason_code`; child-invocation validation keeps `kind:"preflight_rejected"` and `child_started:false`.
**Reasoning:** Operation tools often refer to runs that already launched, so reusing `preflight_rejected` would make the child-start claim ambiguous or false. A separate structured rejection keeps caller adapters from parsing MCP text while preserving the exact preflight invariant.
**Alternatives considered:** Leave operation errors as MCP text errors (rejected because callers had to infer reason codes), reuse `preflight_rejected` for all semantic errors (rejected because `child_started:false` is not meaningful for operations), and replace the whole error envelope (rejected as broader than the observed failure).
**Consequences:** Observed campaign probes must require `operation_rejected` for run-operation semantic failures, not text-derived reason-code fallback.

### Required packet failures distinguish not-ready from invalid
**Date:** 2026-07-01
**Status:** Active
**Decision:** Required session packets use `packet_required_not_ready` for parse-valid packets whose verdict/blockers do not satisfy the required policy; malformed packets continue using `packet_required_invalid`, and missing packets use `packet_required_missing`.
**Reasoning:** A valid packet that honestly says "not ready" is different from a malformed packet. Callers need this distinction to decide whether to repair packet shape or continue task work.
**Alternatives considered:** Keep `packet_required_invalid` for all unsatisfied packets (rejected as caller-hostile taxonomy collapse), or add a new packet object state machine (rejected as unnecessary for the observed ambiguity).
**Consequences:** Failure logs, terminal metadata, README, and observed-campaign result matching must stay synchronized with all three packet reason codes.

### Local capacity uses bounded top-level admission queueing
**Date:** 2026-07-12
**Status:** Active
**Decision:** `SUBAGENT007_MAX_ACTIVE_CHILDREN` defaults to 24. Top-level `start_run` and `schedule_run` overflow into an owner-scoped metadata-only queue bounded by `SUBAGENT007_MAX_QUEUED_RUNS`, default 96. Queueing can be disabled with `0`. One-shot, named-session, and recursive launches remain fail-fast.
**Reasoning:** Burst demand should retain a durable run identity without increasing concurrent child pressure. Keeping request payloads in owner memory avoids a new raw-prompt retention path, while excluding recursive work prevents all active parents from waiting on descendants that cannot acquire a slot.
**Alternatives considered:** Strict global FIFO (rejected because another server process cannot execute an in-memory request and a stalled owner could block everyone), persisted request payloads (rejected as a new sensitive accumulation path), and queueing every tool (rejected because synchronous and recursive contracts need immediate capacity outcomes).
**Consequences:** Queued views use `status:"working"` and `active_phase:"queued"`; one process-owned pump preserves FIFO per owner with approximate cross-process fairness. Cancellation removes a ticket before launch. Mutable safety preconditions are checked again at promotion, filesystem records publish atomically, unreadable ownership records fail closed, and restart drift never replays an unavailable prompt.

### Skill resolution and recursive delegation remain authority-owned

**Date:** 2026-07-16
**Status:** Active
**Decision:** `resolve_skill_bindings` v1 resolves 1–64 canonical sorted names through the same catalog/read/hash authority as verification and launch, with a domain-separated full-request digest and no execution-state writes. Recursive delegation is a separate explicit launch authority: omission disables it, raw resume reauthorizes every turn, named sessions reject it, and read-only conflicts with it. The child emits a strict pre-prompt receipt; ancestor views expose complete descendant IDs and terminal statuses, and parent terminal publication waits for subtree closure.
**Consequences:** Callers can bind hashless semantic drafts without duplicating catalog authority, while launches retain drift rechecks. Recursive callers must opt in before prompt submission; enabled descendants inherit but cannot widen authority, and parent terminal views remain open until contributing descendants settle.

### Complete skill bundles execute from owner snapshots

**Date:** 2026-07-17
**Status:** Active
**Decision:** One execution-owner algorithm digests the complete admitted runtime closure. Exact-root validation is catalog-neutral for both staging and canonical-source recomputation. Publication independently resolves current catalog source, freezes captured bytes into a content-addressed snapshot, and exclusively claims stable `project_id` plus caller-persisted `publication_id` for one complete canonical request/snapshot set. Pending exact replay resumes and committed replay returns the same receipts; a different request under that identity fails closed. Launch accepts only owner receipt identities, derives the path, and revalidates in parent and Pi child before prompt.
**Reasoning:** `SKILL.md`-only pins miss referenced runtime drift, mutable projections cannot preserve old project versions, and a final manifest hash is circular because the manifest depends on publication evidence. A stable pre-existing publication command identity survives crash retry without letting caller paths/hashes replace owner snapshot evidence.
**Alternatives considered:** Caller-computed bundle hashes (rejected as duplicated authority), temporary installation of staging (rejected as effectful and resolver-visible), final manifest SHA references (rejected as circular), and mutable-source launch with post-hoc evidence (rejected as too late).
**Consequences:** Active references close idempotently without identity change; active and closed references remain retained and deletion-visible. Automatic GC is disabled. Named sessions reject snapshot bindings. Recursive descendants inherit only an ancestor-confirmed snapshot binding. The claim is exact owner filesystem/Pi activation integrity, not hostile-runtime containment.

### Public model input is model_class, not concrete model ids
**Date:** 2026-06-25
**Status:** Active
**Decision:** Callers choose capability classes `A` through `E` or external expert classes `Z1` through `Z5`; concrete model ids and thinking levels remain internal calibration.
**Reasoning:** Model/provider inventory changes independently of the public API, and class names keep callers from depending on volatile concrete ids.
**Alternatives considered:** Public `model` and `thinking_level` inputs (rejected because they leak calibration and make migrations harder).
**Consequences:** Config migration, model reconciliation, and model-health probing must preserve the class abstraction. Public MCP results, failure logs, session ledgers, observed-campaign summaries, and README should expose model classes and class-level health/migration actions, not concrete model IDs or thinking-level calibration values.

### Durable run snapshots are local filesystem state
**Date:** 2026-06-24
**Status:** Active
**Decision:** Run tasks, input mailbox records, session state, failure logs, and active-child leases use local filesystem paths under the state root.
**Reasoning:** This server is local/private and needs inspectable, restart-tolerant state without operating a database or service.
**Alternatives considered:** Database-backed state or remote worker queues (rejected as operationally heavier than this local MCP boundary needs).
**Consequences:** Runtime readiness and tests must account for local build/source state; restart drift fails closed instead of trying to reattach to unknown old child processes.

### Garbage collection follows observable ownership, not age
**Date:** 2026-07-12
**Status:** Active
**Decision:** Provider-owned snapshot temps, terminal in-memory task objects, child process groups, and raw failure telemetry are reclaimed automatically. Canonical outputs and Pi sessions are not deleted by provider TTL because callers such as Bendum durably retain their paths and session identities.
**Reasoning:** Deterministic cleanup can safely enforce file, process, and byte mechanics it owns. It cannot infer that a caller has consumed a canonical artifact merely from elapsed time or a successful return.
**Alternatives considered:** Blanket TTL deletion (rejected because it breaks Bendum rereads/resume), caller vigilance (rejected because routine manual cleanup is not a systemic fix), and unbounded observability (rejected because raw telemetry caused material disk growth).
**Consequences:** Failure raw storage defaults to 64 MiB and keeps whole newest records; append and archive share one atomically published lock, summaries precede raw pruning, and a bounded unref'ed worker removes telemetry I/O from caller latency. Bridge control EOF terminates the owned group; terminal snapshots survive restart while redundant memory/events/mailboxes do not; future canonical release requires an explicit caller-owned acknowledgment contract.

### Public event views are sanitized projections
**Date:** 2026-06-24
**Status:** Active
**Decision:** Public run views and transcript-rendered artifacts expose bounded, sanitized progress rather than raw thinking, private tool payloads, answer values, or full composed prompts.
**Reasoning:** Run state must be useful for polling/debugging without leaking private reasoning or sensitive caller input.
**Alternatives considered:** Storing raw child streams directly in public events (rejected because it would conflate auditability with disclosure).
**Consequences:** Changes to transcript, event, and failure-log code need tests for what is omitted as well as what is included.

### Researcher state discovery and terminal projection are adapter-owned

**Date:** 2026-07-25
**Status:** Active
**Decision:** `researcher_bounded_v1` live activation requires exact receipt v4 advertising `researchctl_state_paths_v1` and `researchctl_strict_v2`; exact v3 remains durable-readback-only. Its native controller returns exact bound job/input paths through read-only `state-paths`. One Researcher-only queue serializes mediator and model-visible controller writes while leaving provider/web I/O outside it; inside that queue exact `init` validates the canonical binding-derived job argument and fixed runtime before mutation, creates or admits only the real state/input chain, rechecks directory identity before execution and after success, and requires exact job/input/writable postconditions without provider retry or rollback. AJ keeps its direct unqueued controller path. After child settlement, the existing materializer is the sole source of primary+Bendum bytes and exact v2 receipt. One pure validator, called on producer return and current-run readback, enforces profile/activation/status/output/receipt projection consistency and role-named hash joins without claiming that controller execution ran.
**Reasoning:** A confined child cannot reliably infer a hidden adapter-owned state root, and a clean child exit or self-consistent receipt cannot prove controller-defined completion. Durable evidence must reject forged, cross-profile, reordered, duplicated, or hash-swapped projections while preserving the weaker exact historical v3 ceiling. Queue ownership must cover only Researcher controller writes; applying it to AJ would add unsupported serialization.
**Alternatives considered:** Exposing the hidden path only in prose (rejected as non-authoritative), letting the child search or derive it (rejected as brittle and confinement-hostile), validating receipt shape without joining named output references (rejected because forged/cross-profile evidence remains admissible), treating `run_id` as an execution join (rejected because it proves no controller observation), changing generic `success` semantics (rejected because Subagent007 is an attempt substrate), or sharing the new queue with AJ (rejected because AJ has no mediator concurrency requirement).
**Consequences:** Strict v4 completion requires the exact v2 receipt plus one primary and one Bendum packet; materialized failed/cancelled/timed-out results may preserve that pair, while non-complete and activation-failure results have one diagnostic primary without receipt/packet. Non-Researcher projections admit neither. Legacy v3 durable projections have exactly one primary and may retain only the exact weaker v1 receipt, with no output-hash join. Live ingress never produces, coerces, defaults, or upgrades v3. Direct CLI Researcher runs keep their existing `${TMPDIR:-/tmp}` path. Generic callers may continue treating `success` as process/transport outcome.

### Researcher evidence and terminal pairs have exclusive observable owners

**Date:** 2026-07-26
**Status:** Active
**Decision:** Model-visible Researcher `researchctl` excludes provider claim/result commands, and model write/edit is confined to the exact real controller `input_root`; a non-registerable runtime adapter alone performs dispatch accounting through the shared queue. Strict primary and packet renders are canonicalized before receipt hashing, prepared together, and recorded as one private pending pair in the durable run claim before the first public rename. Terminal commit clears that pending ownership only when exact output references own both files; failure and owner-loss paths remove the recorded pair, retaining failed cleanup for startup retry. Primary-only session/restart consumers enforce the role after generic lexical decoding.
**Reasoning:** A controller receipt cannot certify provider observation when the model can author the same dispatch state or edit `job.json`. Likewise, two independent public renames cannot provide durable pair ownership, and a raw-render hash cannot identify bytes that publication later sanitizes. The existing run owner, controller queue, canonicalizer, and consumer boundaries already observe the necessary mechanics.
**Alternatives considered:** Terminal signatures over shared state (rejected because the writer remains shared), controller-side content rejection (rejected as cross-repository policy motion), catch-only output deletion (rejected because host death skips it), restart completion phases (rejected because a restarted attempt already fails), and global role-specific decoder APIs (rejected as broader than the three primary-only consumers).
**Consequences:** Researcher direct inputs remain writable without exposing job/dispatch authority. Strict receipt and durable hashes share exact bytes. A crash after one publish leaves a durable cleanup owner rather than an orphan. The public output/result shape and legacy v3 readback remain unchanged; the Researcher contract reports `task_root_write_scope:"exact_controller_input_root"`.
