# Observed Real-Use Trials: Subagent007 MCP Server

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Campaign id: `campaign.20260611.codex-current`

## Scope

This campaign tested the current `subagent007` MCP server as both:

- a local stdio MCP server launched from `dist/server.js` under the observed-campaign harness with deterministic fake Pi child behavior; and
- the installed active `subagent007` MCP server, using live Pi-backed class A model calls and production-state paths under `/Users/rgalyavin/.codex/subagent007-pi`.

The campaign covered model listing, compatibility aliases, one-shot execution, durable run snapshots, async polling, caller input, cancellation, timeouts, raw Pi continuity, named sessions, session resume modes, required packet gates, skill binding, prompt-level skill validation, broad-work one-shot preflight, deterministic child failures, schema errors, and handler validation.

## Verification

- `npm run build`: pass.
- `npm run typecheck`: pass.
- `npm test`: pass, 107 tests.
- `npm run models:reconcile`: pass. Pi registry, OpenRouter, and Ollama sources all reported calibrated model refs as present.
- Deterministic observed campaign:
  - Command: `npm run observed-campaign -- --campaign-id campaign.20260611.codex-current -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /Users/rgalyavin/myApps/003-subagent007-pi --mode protocol-deterministic --scenario all-bundled`
  - Result: pass, exit code 0.
  - State root: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-current-C4tOZm`
  - Ledger: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-campaign.20260611.codex-current-C4tOZm/campaign-ledger.jsonl`

## Trial Matrix

| ID | Surface | Trial | Observation |
| --- | --- | --- | --- |
| T1 | Local health | Build, typecheck, test suite. | All passed. Test suite covered 107 cases, including recent active-event and deterministic campaign behavior. |
| T2 | Model inventory | `npm run models:reconcile`. | All calibrated refs were present. |
| T3 | Deterministic MCP campaign | `observed-mcp-probe --mode protocol-deterministic --scenario all-bundled`. | Covered success, schema error, handler validation, child nonzero exit, and required packet failure. It honestly reported uncovered product surfaces. |
| T4 | Model classes | Installed `list_model_classes`. | Classes A-E returned. Default class was C. Only class A had known healthy one-shot health; B-E were unknown. |
| T5 | Compatibility alias | Installed `list_allowed_models`. | Returned the same structure as `list_model_classes`. |
| T6 | One-shot success | Installed `run_subagent`, class A, exact marker. | Completed in about 19.1s with `LIVE_ONE_SHOT_611_CX`. Returned `run_id`, output path, recent public events, and public excerpt. |
| T7 | Completed run inspection | `get_run` for T6. | Returned the same terminal snapshot and public events. Public one-shots are now durable and inspectable. |
| T8 | Async run polling | `start_run`, class A, shell profile, delayed command. | Initial view had lifecycle fields but empty `recent_events`; after about 11s it had the user prompt event; terminal state included assistant output. |
| T9 | Caller input | `start_run` with `request_input`; `get_run`; `answer_run_input`; final `get_run`. | `status:"input_required"` appeared with pending request. Answer settled and final output was `INPUT_ECHO:TOKEN_611_CX`. Duplicate answer was rejected. |
| T10 | Cancellation | `start_run` long shell sleep, then `cancel_run`. | Cancelled in about 3.5s. Snapshot included `last_progress_message:"cancellation requested"` and `[subagent007 cancelled]`. |
| T11 | Timeout | `start_run`, shell sleep, `timeout_ms:15000`. | Failed with `timed_out:true` after 8s effective runtime. `partial_output_available:false` was correct because no assistant/warning/error content existed before timeout. |
| T12 | Raw Pi continuity | `run_subagent` with `continuity:{mode:"fresh"}`, then resume by returned session file. | Fresh session established. Resume returned remembered marker `RAW_CONTINUITY_611_CX`. |
| T13 | Named session continuity | `start_session_run` new, then `run_subagent_session` require-existing. | Created manifest and ledger, then resumed by semantic key and returned `NAMED_CONTINUITY_611_CX`. |
| T14 | Named session negative modes | Existing key with `resume_mode:"new"`; missing key with `require_existing`. | Both rejected before child execution with clear text errors. |
| T15 | Required packet ready | Live `run_subagent_session`, `packet_policy:"required"`, ready packet with empty blockers. | Succeeded, committed manifest, wrote packet JSON, `packet_parse_status:"valid"`. |
| T16 | Required packet non-ready | Live required packet with `verdict:"inconclusive"` and blocker. | Failed closed with `exit_code:0`, no committed session, attempt session recorded, `packet_parse_status:"valid"`. |
| T17 | Required packet invalid closure | Live required packet with malformed `closure.artifact_roles` and `closure.validation`. | Failed closed with precise `packet_error`, no committed session, candidate attempt recorded. |
| T18 | Skill-bound async run | `start_run` with `skill_name:"pda-lite"`. | Completed in about 38.9s and showed injected `/skill:pda-lite` in transcript. |
| T19 | Skill-bound one-shot rejection | `run_subagent` with `skill_name:"pda-lite"`. | Rejected immediately as incompatible with the quick noninteractive contract. |
| T20 | Prompt-level skill validation | `start_run` prompt beginning `/skill:pda-lite`. | Rejected immediately with guidance to use `skill_name`. |
| T21 | Broad-work one-shot preflight | `run_subagent` prompt containing `Investigate`, `HORC`, and `SAF`. | Rejected immediately as broad/exploratory/synthesis work. |

## Observed Issues And Incoherences

### I1. Active Progress Is Still Mostly Transcript-Level, Not Operation-Level

The current run snapshot model is much better than the previous campaign: active and terminal views expose `recent_events` and `last_public_output_excerpt`. However, active polling still only sees public `message_end` events, timeout/cancel markers, warnings, and errors. It does not show a typed child/tool phase such as "model started", "bash running", "waiting for tool result", "skill resources loaded", or "packet parsed".

Observed in T8 and T18: an async shell task showed only the user prompt for most of the active period, then the final assistant message. A tiny skill-bound task took about 39s and exposed no intermediate skill-loading or reasoning-independent phase.

Relevant implementation:

- `src/runTask.ts` records bounded public events through `observeOutputLine`.
- `src/transcript.ts` only turns `message_end`, `subagent007.warning`, `subagent007.error`, timeout markers, and cancellation markers into public events.

### I2. `last_progress_message` Can Contradict Current Status

Observed in T9: `status` changed to `input_required`, but `last_progress_message` still said `running`. After terminal completion, several successful views still had `last_progress_message:"running"`. This is not a functional failure because `status` is authoritative, but it weakens scanability and can confuse simple clients that display the progress message as state text.

Relevant implementation:

- `getRunTask` derives `status` from mailbox state on read.
- `last_progress_message` is only updated by heartbeat/cancel paths through `setTaskProgress`.

### I3. Input Lifecycle Events Are Transient, Not Durable Public Events

Observed in T9: while the request was pending, `recent_events` included `[input_required] 1 pending input request`. Immediately after answering, the input marker disappeared from `recent_events`, although the `input_requests` record correctly showed `status:"answered"`.

This happens because input events are synthesized from currently pending requests inside `eventsForView`; they are not appended as durable public events when a request is created, answered, closed, or timed out.

Relevant implementation:

- `inputRequestEvent` only emits pending-request state.
- `answerRunTaskInput` settles the mailbox and writes the view but does not append an "input answered" event.

### I4. Packet Contract Instructions Dominate Public Events And Excerpts

Observed in T15-T17: required packet runs exposed the whole auto-appended `<subagent007_contract_packet>` instruction in the public user event. Because `last_public_output_excerpt` is a tail-only 1000-character buffer, the excerpt often starts mid-instruction and makes the actually relevant packet result harder to scan.

This is not a data leak to an unauthorized party; the caller supplied the run. It is an observability incoherence: control scaffolding is presented as if it were the user's substantive prompt.

Relevant implementation:

- `src/session.ts` appends packet instructions directly to `resolved.prompt`.
- `src/transcript.ts` renders the resulting Pi user message as ordinary `[user]` content.
- `src/runTask.ts` stores only a tail excerpt, so long scaffolded prompts crowd out the useful start of the interaction.

### I5. Validation Failures Are Clear But Structurally Thin To Tool Consumers

Observed in T14, T19, T20, and T21: validation failures returned clear text, and deterministic campaign records distinguished schema, handler, and failure-log deltas. But installed tool-call display for validation errors was a plain text error rather than the same structured result shape used by successful terminal views.

This is mostly an MCP surface ergonomics issue. Human callers get useful text; programmatic callers get less machine-readable detail unless they also inspect failure logs or use the deterministic ledger.

Relevant implementation:

- `server.ts` wraps successful tool results with `jsonToolResult`.
- Validation failures are thrown from handlers or schema validation and are not normalized into a public structured error envelope.

### I6. `all-bundled` Is A Useful Subset, Not Full Product Coverage

The deterministic probe now reports uncovered surfaces explicitly, which is correct. The remaining incoherence is naming: `--scenario all-bundled` can still sound like complete server coverage. It actually covers five deterministic protocol scenarios and leaves model listing, async polling, caller input, cancellation, timeout recovery, transcript redaction, valid/invalid packet closure, and installed Pi integration to other trials.

This is much less severe than the previous campaign because the summary no longer overclaims coverage.

## Common Patterns

1. The core server mechanics are healthy: launch, local build, model resolution, one-shot execution, durable snapshots, async runs, cancellation, timeout budgeting, caller input, raw continuity, named-session manifests, packet commit/attempt separation, skill binding, and preflight rejection all worked.
2. The weakest current layer is still observability, not execution correctness. The system records final artifacts reliably, but active snapshots are a partial public-transcript projection rather than a typed operational trace.
3. The server now avoids the largest historical footguns: broad one-shots and skill-bound one-shots fail fast, and deterministic campaign probes no longer depend on live model compliance for child-failure and packet-failure cases.
4. Strict packet gates are coherent and safe. The remaining issue is presentation: packet instructions and packet outputs occupy the same public event channel.
5. State machines are mostly sound, but some derived display fields lag or disappear because they are projections from current state rather than durable events.

## HORCs And SAFs

### HORC 1: Run Observability Is A Redacted Transcript Projection, Not A Typed Operational Timeline

The highest-order root cause is that the public run view treats observable activity as sanitized transcript lines plus a few markers. Execution phases that matter to a user or client are not first-class events.

Downstream effects:

- active shell/tool runs look idle except for the initial prompt;
- skill-bound runs provide no phase-level explanation during long waits;
- `last_progress_message` remains generic;
- terminal snapshots say "running" in the progress message even when the run is completed or failed.

Intraframe SAF candidate:

- Extend `RunTaskState` with a bounded typed event projection independent of transcript lines. Append events for `run_started`, `child_started`, `model_message`, `input_required`, `input_answered`, `tool_phase` when available, `timeout`, `cancelled`, `packet_parsed`, and `terminal`. Update `last_progress_message` from the latest status-significant event. Keep the same snapshot store and size caps.

Transframe SAF candidate:

- Replace task snapshots with an append-only event-sourced run ledger, and make `get_run` a projection over that ledger. All lifecycle, mailbox, packet, child process, and terminal state changes become typed events.

Selected SAF:

- Intraframe typed event projection. It fully resolves the observed active-state incoherence with less system motion than rebuilding the run store. It can later become the compatibility projection for a true event ledger.

Rejected pseudo-SAFs:

- Lower the heartbeat interval. More frequent generic "running" messages do not add information.
- Increase `last_public_output_excerpt` size. Bigger transcript tails still do not expose operation-level state.

### HORC 2: Caller Input Is Modeled As Mailbox State, Not Run History

The highest-order root cause is that input requests are durable mailbox records but only pending input is projected as a transient public event. Once answered or closed, the run history loses the visible interaction milestone unless the caller inspects `input_requests`.

Downstream effects:

- the `[input_required]` event disappears after answer;
- duplicate-answer failures are phrased at the run level when the run is terminal, not at the request-settlement level;
- status and progress message can diverge around input-required state.

Intraframe SAF candidate:

- Append redacted durable public events when input is requested, answered, timed out, or closed. Do not include answer text in the public event by default; retain answer details only in mailbox files. Update `last_progress_message` immediately when pending input appears or is settled.

Transframe SAF candidate:

- Make mailbox operations part of the same event-sourced run ledger as execution events, with request records as materialized views rather than separate authoritative state.

Selected SAF:

- Intraframe input lifecycle events. It resolves the observed disappearing-event and stale-message behavior without changing the mailbox contract or storage model.

Rejected pseudo-SAFs:

- Leave input history only in `input_requests`. That is accurate but does not fix run timeline incoherence.
- Store the full answer in `recent_events`. That improves visibility by leaking unnecessary user-provided content into a general event channel.

### HORC 3: Control Instructions And User Prompt Share One Public Text Channel

The highest-order root cause is that server-internal prompt scaffolding, especially packet contract instructions, is appended into the same text prompt that later renders as the public user message.

Downstream effects:

- packet runs show long internal instructions as user-authored content;
- useful public excerpts are clipped by scaffold text;
- packet observability is noisy even when packet semantics are correct.

Intraframe SAF candidate:

- Keep sending the combined prompt to Pi, but tag known server scaffolds before dispatch and strip or summarize those scaffold blocks in `publicOutputLineFromProcessLine`/run event projection. For packet runs, public events should show the original user prompt plus a compact marker such as `[packet_policy required: contract_packet_v1 instruction applied]`.

Transframe SAF candidate:

- Change the child-agent interface to accept separated prompt channels: user prompt, server contract instructions, skill binding, and output contract. Public transcript rendering would then naturally include only user-visible channels.

Selected SAF:

- Intraframe scaffold redaction/summarization in the public projection. It fully fixes the observed public event/excerpt incoherence with minimal changes. The transframe split is architecturally cleaner but requires changing the child request contract and Pi adapter assumptions.

Rejected pseudo-SAFs:

- Shorten the packet instruction text only. It still presents server control text as user content.
- Increase excerpt length. The public view would remain noisy.

### HORC 4: Handler Errors And Terminal Results Use Different Public Shapes

The highest-order root cause is that successful and process-terminal outcomes are normalized through `jsonToolResult`, while schema and handler validation failures are thrown through the MCP error path. Human-readable text is good, but machine-readable error classification is split across MCP error semantics, failure logs, and campaign ledgers.

Downstream effects:

- installed validation calls display plain text rather than structured error fields;
- client code must special-case thrown validation failures versus `success:false` terminal views;
- campaign harness must maintain separate call result classes for schema, handler, and child failures.

Intraframe SAF candidate:

- Add a stable structured error envelope for expected validation/preflight failures where MCP allows it, including `error_class`, `reason_code`, `tool`, and `retry_with` hints. Keep thrown errors for true schema-level SDK rejections and unexpected handler exceptions.

Transframe SAF candidate:

- Redesign the public MCP contract so every tool returns a discriminated union result, and schema validation is only used for basic type safety. Semantic validation would always be in-band.

Selected SAF:

- Intraframe structured preflight error envelope for expected semantic validation failures. It improves programmatic ergonomics without weakening the MCP schema boundary. Schema rejections should remain out-of-band because they happen before handler code.

Rejected pseudo-SAFs:

- Put all errors into `success:false` terminal result objects. That conflates "child ran and failed" with "server rejected the request before execution."
- Rely only on failure logs. Logs are audit telemetry, not the caller's primary response contract.

### HORC 5: Campaign Coverage Is Split Across Harness And Live Trials

The highest-order root cause is that no single command currently exercises every product surface. The deterministic harness correctly covers protocol mechanics; installed live trials cover model/provider integration and longer-lived interactions. The split is appropriate, but the naming and reporting still require human interpretation.

Downstream effects:

- `all-bundled` still sounds broader than it is;
- a report must manually combine deterministic ledger evidence with installed MCP observations;
- "full e2e coverage" depends on a campaign plan, not one reusable campaign profile.

Intraframe SAF candidate:

- Add named campaign profiles such as `protocol-core`, `live-smoke`, `stateful-live`, and `full-current`, where `full-current` orchestrates deterministic probes plus live installed-call checklist output. Rename `all-bundled` to `protocol-core` while keeping `all-bundled` as a compatibility alias.

Transframe SAF candidate:

- Build a first-class MCP conformance runner that can attach to either a local server process or installed server, execute deterministic and live scenarios, and emit one normalized evidence bundle with coverage claims.

Selected SAF:

- Intraframe campaign profiles and clearer naming. It removes the current coverage interpretation burden with much less motion than a full conformance runner.

Rejected pseudo-SAFs:

- Claim `all-bundled` is complete because it passes. Its own uncovered-surface list proves otherwise.
- Fold live-model scenarios into deterministic mode. That would reintroduce probabilistic model-compliance failures into protocol tests.

## Recommended Fix Order

1. Add typed run events and status-significant progress messages to active snapshots.
2. Persist input lifecycle events into the run timeline without exposing answer text.
3. Redact or summarize server-injected packet scaffolding in public run events and excerpts.
4. Normalize expected semantic validation failures into a structured preflight error envelope where MCP handler semantics allow it.
5. Rename/split campaign profiles so deterministic and live coverage claims are explicit and reproducible.
