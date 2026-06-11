# Live E2E Skill Campaign - 2026-06-10

Status: historical observed-use campaign. Runtime observations are pre-repair; this report was later amended only to record the evidence-boundary convention.

## Scope

Target: `subagent007-pi`, with emphasis on live installed MCP behavior, real Pi-backed child execution, skill invocation by subagents, parent-child input routing, sessions, packet policy, cancellation, timeout metadata, validation edges, and campaign-scoped protocol probing.

Environment:

- Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
- Branch: `main`
- Date: 2026-06-10
- Installed MCP server state root: `/Users/rgalyavin/.codex/subagent007-pi`
- Isolated protocol campaign: `live-mcp-protocol-20260610`

Evidence classes:

- Installed-server trials are production-state observations unless the installed MCP server process was launched under campaign environment variables before the calls.
- Harness-launched SDK or scripted probes are campaign-scoped observations only when their harness summary records `campaign_id`, `state_root`, `failure_log_path`, and `evidence_class:"campaign-scoped"`.
- Reports must not relabel production-state observations as campaign-scoped after the fact.

## Campaign Plan

1. Confirm current branch and inspect public server contract from `README.md`, `src/server.ts`, runner/session/input code, and existing reports.
2. Run local verification so live observations can be interpreted against the current source.
3. Exercise all public MCP surfaces with real Pi-backed calls:
   - `list_allowed_models`
   - `run_subagent`
   - `start_run`
   - `get_run`
   - `answer_run_input`
   - `cancel_run`
   - `run_subagent_session`
4. Run the required interactive `idea-via-pda` skill trial through `start_run` and `answer_run_input`, using a temporary workspace so skill materialization does not touch this repo.
5. Probe edge cases around schema validation, skill binding, timeout, cancellation, raw continuity, required packet parsing, and observed-campaign state isolation.
6. Reduce observations into common patterns, HORCs, SAF candidates, selected SAFs, and an implementation plan.

## Verification Baseline

| Check | Result |
| --- | --- |
| `git status --short --branch` | On `main`; no branch change. |
| `npm run typecheck` | Passed. |
| `npm test` | Passed 82/82. |
| Prior reports | Older packet/schema/partial-output issues are already marked historical and repaired. |

## Trial Matrix

| ID | Surface | Action | Observation |
| --- | --- | --- | --- |
| T1 | Model/config | Live `list_allowed_models`. | Succeeded. Persisted default `openrouter/anthropic/claude-sonnet-4.5` was repaired at runtime to `openrouter/~anthropic/claude-sonnet-latest`; `config_migration.needed: true`. |
| T2 | One-shot final | Live `run_subagent`, exact-output prompt. | Completed in about 3.0s. Output: `SUBAGENT007_ONE_SHOT_OK`. |
| T3 | One-shot transcript | Live `run_subagent`, repo-inspection prompt with `output_mode:"transcript"`. | Completed in about 5.4s. Transcript named package `subagent007-pi` and entry file `src/server.ts`. |
| T4 | Interactive skill invocation | Live `start_run` with `skill_name:"idea-via-pda"`, `tool_profile:"workspace_write"`, temp cwd `/tmp/subagent007-idea-via-pda.dVt5Tj`. | Real skill invocation proved: transcript begins with `/skill:idea-via-pda`; child ran sufficiency gate and PDA workflow. |
| T5 | Parent-child input | Same run as T4, polled with `get_run`, answered with `answer_run_input`. | Status became `input_required`; question matched skill format with one numbered policy question and lettered options. Answer was persisted and run resumed. |
| T6 | Skill materialization | Same run as T4. | Completed successfully in 179490 ms and wrote `/tmp/subagent007-idea-via-pda.dVt5Tj/idea-call-capture-to-brief.md`. |
| T7 | Named session create | Live `run_subagent_session`, `session_key:"trial:20260610-live-session-a"`, `resume_mode:"new"`. | Succeeded, created manifest/ledger, stored marker `LIVE_SESSION_MARKER_8142`. |
| T8 | Named session resume | Same session with `resume_mode:"require_existing"`. | Succeeded, returned exactly `LIVE_SESSION_MARKER_8142`, ledger advanced to sequence 2. |
| T9 | Required packet, natural closure | Live `run_subagent_session`, `packet_policy:"required"`, prompt requested `verdict:"ready"` and empty blockers. | Failed. Packet was syntactically present but invalid because generated `closure.artifact_roles` was an object and `closure.validation` was a string; parser requires arrays. |
| T10 | Required packet, no closure | Same packet policy with prompt explicitly omitting `closure`. | Succeeded. Packet parse status `valid`, `verdict:"ready"`, empty blockers, committed session. |
| T11 | Cancellation | Live `start_run` shell sleep prompt, then `cancel_run`, then `get_run`. | Terminal status `cancelled`, `stop_reason:"cancelled"`, `exit_code:null`, transcript contained `[subagent007 cancelled]`. |
| T12 | Timeout partial output | Live `start_run` with 12s timeout, assistant marker before shell sleep. | Terminal status `failed`, `timed_out:true`, `partial_output_available:true`; transcript contained assistant text plus timeout marker. |
| T13 | Raw continuity create | Live `run_subagent` with `continuity:{mode:"fresh"}`. | Succeeded and returned a raw Pi session file. |
| T14 | Raw continuity resume | Live `run_subagent` with `continuity:{mode:"resume"}` using T13 session file. | Succeeded and returned exactly `RAW_CONTINUITY_5279`. |
| T15 | Protocol schema campaign | `npm run observed-campaign -- --campaign-id live-mcp-protocol-20260610 -- node --input-type=module ...` against local `dist/server.js`. | Isolated state root created under `/var/folders/.../subagent007-pi-live-mcp-protocol-20260610-*`; real `run_subagent` succeeded with output `CAMPAIGN_PROTOCOL_OK`. |
| T16 | Public schema edge | SDK `listTools()` inside T15. | Tool list was exactly the seven expected public tools. `run_subagent` did not advertise `timeout_ms`; required fields were `prompt`, `cwd`, `run_kind`. |
| T17 | Invalid `run_subagent.timeout_ms` | SDK raw call inside T15. | Rejected at MCP input validation with `timeout_ms is not supported by run_subagent`. |
| T18 | Invalid raw `session_id` on `start_run` | SDK raw call inside T15. | Rejected at MCP input validation with guidance to use `continuity.mode`. |
| T19 | Invalid `continuity` on `run_subagent_session` | SDK raw call inside T15. | Rejected at MCP input validation with guidance to use `session_key` and `resume_mode`. |
| T20 | Skill smuggling in prompt | Live `run_subagent` prompt starting `/skill:pda-lite` without `skill_name`. | Rejected before child execution: `Pass skill_name instead of putting skill invocation syntax in prompt.` |
| T21 | Skill path as `skill_name` | Live `run_subagent` with `skill_name` as a local `SKILL.md` path. | Rejected before child execution with bare-skill-name guidance. |
| T22 | Invalid model | Live `run_subagent` with non-curated model. | Rejected at MCP input validation with curated model list. |
| T23 | Broad one-shot analysis | Live `run_subagent` asked for independent HORC/SAF analysis over observed facts. | Timed out at the one-shot limit; output had only user prompt plus timeout marker. This is consistent with the one-shot contract but poor ergonomics for broad analysis prompts. |

## Healthy Behaviors Observed

- Real one-shot final and transcript outputs work.
- Async polling works for working, input-required, completed, failed, and cancelled states.
- Caller input works end to end through mailbox files and `answer_run_input`.
- The required `idea-via-pda` trial was real, not simulated: the child transcript included `/skill:idea-via-pda`, asked a PDA-style policy question via `request_input`, accepted the answer, resumed, and wrote the idea brief artifact.
- Named sessions and raw Pi continuity both preserve memory across turns.
- Cancellation and timeout metadata are coherent.
- `partial_output_available` is true only when child assistant text is present in the timeout artifact in this campaign.
- Public schema rejects repaired edge cases: forbidden `run_subagent.timeout_ms`, raw `session_id`, raw `continuity` on named sessions, invalid model, and invalid skill binding.
- The observed-campaign harness can run a real local MCP protocol probe under isolated state paths.

## Observed Issues And Incoherences

### I1. Required Packet Instruction Invites An Underspecified Optional `closure`

Severity: medium.

Evidence:

- T9 asked for a ready packet with empty blockers.
- The appended server instruction said: `Optional closure fields may be added under closure: canonical_closure_source, artifact_roles, validation, claim_ceiling.`
- The child naturally emitted a `closure` object.
- `src/packet.ts` requires `closure.artifact_roles` to be an array of `{ path, role }` objects and `closure.validation` to be an array of strings.
- The child emitted `artifact_roles` as an object and `validation` as a string, so `packet_parse_status:"invalid"` and `success:false`.
- T10 succeeded when `closure` was explicitly omitted.

Why it matters:

The parser is strict, but the model-facing contract is not isomorphic with the parser. A caller can request a valid ready handoff and still fail because the server advertises optional closure fields without the shape needed to produce them.

### I2. Persisted Default Model Remains Stale Even Though Runtime Repair Works

Severity: low.

Evidence:

- Current config: `/Users/rgalyavin/.codex/subagent007-pi/config.json`
- Content: `{"default_model":"openrouter/anthropic/claude-sonnet-4.5","default_thinking_level":"medium"}`
- `list_allowed_models` reports runtime repair to `openrouter/~anthropic/claude-sonnet-latest` and `config_migration.needed:true`.

Why it matters:

Execution works today because alias repair exists, but persisted state and effective runtime state disagree. This keeps the installation dependent on compatibility repair and creates repeated health noise.

### I3. Interactive Skill Runs Have Sparse Progress Visibility Before Input Or Completion

Severity: low-medium.

Evidence:

- T4/T5 took about 61 seconds from `start_run` to first visible `input_required` state.
- The run then took about 179 seconds total.
- During working periods, `get_run` exposed only `status:"working"`, timestamps, and existing input requests.
- `src/processRunner.ts` can send heartbeat notifications only when the MCP caller provides a progress token; `get_run` snapshots do not expose recent child progress or last public output.

Why it matters:

The server is functionally correct, but long interactive skill runs are hard to distinguish from a hung child until an input request or terminal result appears.

### I4. Broad Analytical Prompts Are Still Easy To Misroute To `run_subagent`

Severity: low-medium.

Evidence:

- T23 used `run_subagent` for a concise independent HORC/SAF analysis and timed out at the one-shot default.
- The output had no assistant partial content, only the original prompt and timeout marker.
- README correctly says broad/long/caller-input work should use `start_run`, but the tool name remains attractive for broad delegation.

Why it matters:

This is not a correctness bug in the server. It is an affordance problem: the system relies on the caller to classify workload size correctly.

### I5. Live Installed MCP Probes Write To Production State Unless The Server Is Launched Under A Campaign Harness

Severity: low.

Evidence:

- Live installed MCP calls wrote outputs, sessions, input requests, and failures under `/Users/rgalyavin/.codex/subagent007-pi`.
- The isolated SDK campaign in T15 correctly wrote to a temp campaign state root, but only because it launched a fresh local server under campaign env.

Why it matters:

Observed real-use campaigns need clean attribution. The harness solves this for campaign-controlled local launches, but the already-running installed server cannot be retroactively scoped per request.

## Common Patterns

1. Core mechanics are healthy. The server reliably launches Pi children, captures output, persists sessions, routes input, handles cancellation, and records failure metadata.
2. Remaining defects are contract-boundary defects, not process-control defects.
3. The strongest live issue is schema asymmetry between model-facing packet instructions and parser-facing packet validation.
4. Runtime compatibility repair prevents breakage but leaves persistent configuration less coherent than effective behavior.
5. Long-running work has two separate UX gaps: limited active-run progress in `get_run`, and easy misuse of the one-shot tool for broad analysis.
6. State scoping is environment-based. That is simple and testable, but it means campaign isolation only applies when the MCP server process itself is launched under the campaign environment.

## HORCs And SAFs

### HORC 1: Packet Contract Has Two Non-Isomorphic Authorities

The highest-order root cause is that `appendContractPacketInstruction()` gives the child a partial prose contract while `extractContractPacket()` enforces a stricter Zod schema. The optional `closure` section is especially malformed: field names are advertised, but their internal types are hidden.

Intraframe SAF candidate:

- Make the appended packet instruction schema-isomorphic with `packetSchema`.
- Replace the optional closure sentence with either:
  - a complete `closure` JSON example showing `artifact_roles` as an array of `{ "path": "...", "role": "..." }` and `validation` as an array of strings, or
  - remove the optional closure invitation entirely if closure is not required for current workflows.
- Add a regression test where a required packet includes a valid closure object and succeeds.

Transframe SAF candidate:

- Stop asking the model for free-form fenced JSON and request the contract packet through a structured-output/tool-call channel validated before final response emission.

Selected SAF:

- Intraframe, schema-isomorphic instruction. It fully resolves the observed defect with the least system motion while preserving the existing packet artifact format and optional closure capability.

Rejected pseudo-SAFs:

- Prompt callers to say "do not include closure".
- Loosen parser validation to accept object-or-array/string-or-array closure fields.
- Keep the instruction vague and classify invalid closure packets as user/model error.

### HORC 2: Runtime Model Canonicalization Is Not Applied At The Persisted Config Boundary

The highest-order root cause is split authority: runtime request resolution knows how to canonicalize stale aliases, while persisted config remains noncanonical.

Intraframe SAF candidate:

- Execute the existing `npm run config:migrate` for the current config so persisted `default_model` becomes `openrouter/~anthropic/claude-sonnet-latest`.
- Keep `list_allowed_models.config_migration` as the non-mutating health signal.

Transframe SAF candidate:

- Introduce versioned config with automatic startup migration or an MCP-exposed config repair tool that performs compare-and-swap writes.

Selected SAF:

- Intraframe for the observed system: run the existing migration. Code already contains the canonicalizer and migration command; the smallest complete fix to this installation is applying it once.

Rejected pseudo-SAFs:

- Ignore the warning because runtime repair works.
- Remove runtime alias repair before persisted config is migrated.
- Silently rewrite config during ordinary read-only tool calls.

### HORC 3: Active Async Run State Is Terminal-Oriented

The highest-order root cause is that `get_run` exposes durable task state only at coarse lifecycle boundaries: working, input-required, terminal. Child stdout is buffered until completion, and progress notifications are best-effort side-channel events rather than persisted run state.

Intraframe SAF candidate:

- Add active-run progress fields to task snapshots, for example `last_progress_at`, `last_progress_message`, and `elapsed_ms`.
- Update `runChildProcess`/`runSubagent` with a non-invasive progress callback that records heartbeat beats and pending-input summaries into the in-memory task state and snapshots.
- Do not stream full child output into snapshots; keep prompt secrecy and transcript redaction boundaries intact.

Transframe SAF candidate:

- Rework active runs around a structured event ledger/stream so `get_run` can show recent public child events, tool activity, and progress with redaction at event-ingest time.

Selected SAF:

- Intraframe, heartbeat-backed active-run progress metadata. It addresses the observed ambiguity without changing output storage, transcript semantics, or the MCP tool set.

Rejected pseudo-SAFs:

- Tell users to wait longer.
- Lower heartbeat intervals only; if the caller does not receive progress notifications, `get_run` is still silent.
- Persist raw live transcript chunks without the existing transcript redaction path.

### HORC 4: Workload Class Is A Caller Promise, Not A Server-Assisted Decision

The highest-order root cause is that `run_subagent` depends on the caller's `run_kind:"quick_noninteractive"` promise, but the server does not provide much feedback when the prompt violates that spirit. The fixed one-shot timeout is correct, but recovery is not strongly guided at the failure point.

Intraframe SAF candidate:

- Add a `timeout_recovery_hint` structured field and transcript line on `run_subagent` timeout: use `start_run` for broad, exploratory, interactive, or long work and pass explicit `timeout_ms`.
- Keep `run_kind` and the no-caller-timeout rule unchanged.

Transframe SAF candidate:

- Remove public `run_subagent` or replace it with a scheduler that automatically routes all but tiny prompts through async `start_run`.

Selected SAF:

- Intraframe. The server should not infer arbitrary prompt complexity, but it can make the failed path self-correcting.

Rejected pseudo-SAFs:

- Increase the one-shot default timeout.
- Add caller-supplied `timeout_ms` back to `run_subagent`.
- Treat timeout artifacts with only a user prompt as useful partial output.

### HORC 5: Campaign Scope Is Process-Scoped, Not Request-Scoped

The highest-order root cause is that campaign IDs and state roots are environment-level settings read by the MCP server process. That is coherent for a launched campaign server, but not for an already-running installed MCP server.

Intraframe SAF candidate:

- For observed campaigns, launch a fresh MCP server under `scripts/run-observed-campaign.mjs` and perform protocol calls through that server.
- Record live-installed probes separately as production-state evidence.

Transframe SAF candidate:

- Add authenticated/request-scoped campaign metadata to public tool inputs or MCP request metadata and thread it through runs, sessions, and failure records.

Selected SAF:

- Intraframe for now. The harness already provides clean attribution when used correctly, and adding request-scoped campaign inputs would expand every public tool contract.

Rejected pseudo-SAFs:

- Post-hoc label production failure records as campaign records.
- Assume installed MCP calls are campaign-scoped because the client process has a campaign ID.

## Implementation Plan For Final SAF Set

1. Packet instruction/schema isomorphism.
   - Add tests for `contract_packet_v1` with valid `closure.artifact_roles` and `closure.validation`.
   - Update `appendContractPacketInstruction()` in `src/packet.ts` to show the exact optional closure shape or remove the optional closure invitation.
   - Prefer showing the exact shape, because parser/types already support closure.
   - Verify required packet with closure succeeds and malformed closure remains invalid.

2. Apply current config migration.
   - Run `npm run config:migrate` in `/Users/rgalyavin/myApps/003-subagent007-pi` for the current user config.
   - Re-run live `list_allowed_models` and verify `default_model_repaired:false` and `config_migration:null`.
   - Do not add silent auto-migration to read-only tools.

3. Active-run progress metadata.
   - Extend `RunTaskView` with small progress metadata fields.
   - Add an internal callback path from `runChildProcess` heartbeat to `runTask` state.
   - Include progress fields in `get_run` while preserving prompt secrecy and transcript redaction boundaries.
   - Add tests for a working async run that exposes progress before terminal completion.

4. Timeout recovery hint.
   - Add a structured timeout recovery hint for `run_subagent` failures.
   - Add the same hint to the timeout marker or result content where clients can see it.
   - Verify `start_run` timeout behavior remains unchanged.

5. Campaign discipline.
   - Keep live-installed probes marked as production-state evidence in reports.
   - Use `scripts/run-observed-campaign.mjs` for campaign-controlled SDK probes and record the returned `campaign_id`, `state_root`, and `failure_log_path`.
   - Defer request-scoped campaign metadata until there is evidence that process-scoped campaign state is insufficient for normal workflows.

## Artifacts

- Interactive skill transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-10T221816033Z-b08eff93d8e9.md`
- Interactive skill brief: `/tmp/subagent007-idea-via-pda.dVt5Tj/idea-call-capture-to-brief.md`
- Session continuity ledger: `/Users/rgalyavin/.codex/subagent007-pi/sessions/trial:20260610-live-session-a-28969fad8cb12bd44e0ff9352e65ea8a/ledger.jsonl`
- Invalid closure packet transcript: `/Users/rgalyavin/.codex/subagent007-pi/sessions/trial:20260610-live-packet-ready-ecd4390e80cbafb2d322245bfe6f146a/runs/2026-06-10T221946313Z-429423ac1a40.md`
- Valid no-closure packet: `/Users/rgalyavin/.codex/subagent007-pi/sessions/trial:20260610-live-packet-ready-no-closure-952d89d7c4a0932a0ae2bd7e2858484b/packets/0001-554d41fc02fd.json`
- Timeout transcript: `/Users/rgalyavin/.codex/subagent007-pi/runs/2026-06-10T222220508Z-1f9771a985b5.md`
- Isolated protocol campaign state root: `/var/folders/77/5qqkg8pj59n7s9wbmvldr_d00000gn/T/subagent007-pi-live-mcp-protocol-20260610-WU9oIu`
