# Observed Real-Use Trials Report - 2026-06-10

Status: historical pre-implementation evidence. The runtime issues labeled I1-I3 were repaired by the subsequent SAF implementation; this report is retained to show the observations that led to those fixes.

## Scope

Campaign target: `subagent007-pi`, covering MCP tool behavior, local harness coverage, persisted state, model/config checks, packet policy, cancellation, caller input, and operational scripts.

No runtime code changes were made during the campaign.

## Trial Matrix

| ID | Surface | Action | Observation |
| --- | --- | --- | --- |
| T0 | Local test suite | Ran `npm test`. | 56 tests passed. Covered validation, MCP fake client, session ledgers, packet missing/valid cases, timeouts, cancellation, failure logging, transcript redaction, and config parsing. |
| T1 | Type safety | Ran `npm run typecheck`. | Passed. |
| T2 | Model reconciliation | Ran `npm run models:reconcile`. | Passed. Pi reported 263 models, OpenRouter 338, Ollama 1. All curated refs present. |
| T3 | Failure-log archive | Ran `npm run failure-log:archive` with `SUBAGENT007_FAILURE_LOG_PATH` pointed at a temp ledger. | Archived and summarized correctly without touching the production ledger. |
| T4 | Live `list_allowed_models` | Called installed MCP tool. | Succeeded. Current config default `openrouter/anthropic/claude-sonnet-4.5` was repaired to `openrouter/~anthropic/claude-sonnet-latest`. |
| T5 | Live `run_subagent` | One-shot prompt requiring exact output. | Completed in about 3.1s. Output file contained exactly `pong from subagent007-pi real trial`. |
| T6 | Live `start_run`/`get_run` | Async prompt with 30s timeout. | Initial status `working`, terminal status `completed`; timeout metadata showed 30s caller cap and 23s effective child runtime. |
| T7 | Live input mailbox | Started a run requiring `request_input`, answered via `answer_run_input`. | Transitioned `working -> input_required -> working -> completed`; output was `token=blue-42`. |
| T8 | Live cancellation | Started shell-capable run intended to sleep, then cancelled. | Immediate view became `cancelled`; final view had `stop_reason: cancelled`, `exit_code: null`, and transcript marker `[subagent007 cancelled]`. |
| T9 | Live named session | Created and resumed `observed-trial:2026-06-10-live`. | Same `subagent_session_id`, two output files, two ledger records, manifest `run_count: 2`. |
| T10 | Live required packet | Ran `run_subagent_session` with `packet_policy: required`. | Returned `success: true` because packet parse status was `valid`, even though the packet verdict was `inconclusive` and `blockers` was nonempty. |
| T11 | Public MCP schema | Listed tool schemas through an MCP client. | `run_subagent` advertises `timeout_ms` with schema `{ "not": {} }`; invalid calls return `isError: true` with a clear message. |
| T12 | One-shot review timeout | Ran an independent inspect-only repo review through live `run_subagent`. | Timed out at default 110s. Result had `partial_output_available: true`, but the transcript only contained the user prompt and timeout marker, with no assistant partial answer. |

## Observed Issues And Incoherences

### I1. Required Packet Success Ignores Packet Verdict

Evidence: T10 returned `success: true`, committed the session run, and wrote a packet even though the claimed packet said:

- `verdict: "inconclusive"`
- `blockers` contained a concrete blocker
- the final answer said it could not produce an authoritative ready verdict

Relevant code:

- `src/session.ts`: `packetSatisfied(policy, status)` only checks parse status for `required`.
- `src/session.ts`: session `success` is computed from process success, session establishment, and `packetSatisfied`.
- `src/packet.ts`: packet schema explicitly allows `ready`, `needs_repair`, `blocked`, and `inconclusive`.

Why it matters: callers can read `success: true` as a usable handoff even when the packet says the handoff is blocked or inconclusive.

### I2. Forbidden `run_subagent.timeout_ms` Leaks Into The Public Schema

Evidence: T11 showed `run_subagent`'s public schema includes:

```json
{
  "timeout_ms": {
    "not": {}
  }
}
```

The runtime rejects the value with a clear `isError` response, but generated clients can still surface the field.

Relevant code:

- `src/server.ts`: `runInputSchema.timeout_ms` is `z.never().optional()`.
- `README.md`: correctly says `run_subagent` does not accept caller-supplied `timeout_ms`.

Why it matters: the public affordance contradicts the intended tool contract. It invites invalid calls and makes generated tool UIs harder to understand.

### I3. `partial_output_available` Is Byte-Based, Not Usefulness-Based

Evidence: T12 timed out with `partial_output_available: true`, but the output file only contained the user prompt and the timeout marker:

```text
[user]
...

[subagent007 timeout] ...
```

No assistant answer, warning, error, or useful partial result was present.

Relevant code:

- `src/runSubagent.ts`: `partialOutputAvailable = processResult.timedOut && output.sizeBytes > 0`.
- `src/transcript.ts`: public transcript can include user messages and operational markers.

Why it matters: clients may attempt to use a "partial" artifact that contains no child-generated work.

### O1. Live Default Model Is Repaired On Every Read

Evidence: T4 showed config contains `openrouter/anthropic/claude-sonnet-4.5`; the server repairs it to `openrouter/~anthropic/claude-sonnet-latest`.

This is not a runtime failure today. It is an operational coherence gap: config remains stale and depends on a compatibility repair path.

## Common Patterns

1. Core execution mechanics are healthy. The tested happy paths for one-shot, async, input, cancellation, sessions, ledgers, and archive scripts behaved coherently.
2. The sharp issues are contract-boundary issues, not child-process basics. They occur where internal mechanics are compressed into public booleans, public JSON schema, or public metadata flags.
3. Several fields are mechanically true but semantically weak: `success`, `partial_output_available`, and repaired model defaults all need clearer meaning at the public boundary.
4. Existing tests cover many failure modes, but the live campaign found gaps around semantic packet outcomes, schema affordances, and partial-output usefulness.

## HORCs And SAFs

### HORC 1: Session Success Conflates Parse Validity With Handoff Readiness

The highest-order root cause is that `packet_policy: required` is modeled as "a syntactically valid packet exists" while the result's `success` field is read as "the session run produced an acceptable handoff." The packet's own verdict has no control over success.

Intraframe SAF candidate:

- Change packet satisfaction for `required` to require:
  - `packet_parse_status === "valid"`
  - `claimed_packet.verdict === "ready"`
  - `claimed_packet.blockers.length === 0`
- Add failure reason coverage for non-ready required packets.
- Update README and tests to define `required` as "ready contract packet required", not merely parseable packet required.

Transframe SAF candidate:

- Replace the single `success` boolean with a structured outcome object such as:
  - `process_success`
  - `session_committed`
  - `packet_parse_status`
  - `contract_verdict`
  - `contract_satisfied`
- Make callers choose which dimension they gate on.

Selected SAF:

- Intraframe. It resolves the observed contradiction with less total motion and preserves the existing API shape. The false immutability assumption is that `required` must mean parse-only because the README currently says "valid"; the live behavior shows callers need "ready" semantics when they request a required contract.

Rejected pseudo-SAFs:

- Prompt the model harder to say `ready`.
- Hide or ignore blockers when deciding success.
- Keep `success: true` and only document that callers must inspect `claimed_packet`.

### HORC 2: Public Tool Schema Is Derived From An Internal Negative Constraint

The highest-order root cause is that the server uses the same input schema to express both the public tool contract and a handler-level rejection rule. `z.never().optional()` is good at rejecting values but bad at describing a public API.

Intraframe SAF candidate:

- Split the tool schemas:
  - `runSubagentPublicInputSchema`: omit `timeout_ms`.
  - `timedRunInputSchema`: include `timeout_ms` for `start_run` and sessions.
- Keep a defensive handler/runtime guard against raw requests that still include `timeout_ms`.

Transframe SAF candidate:

- Introduce a first-class tool contract layer that generates MCP schemas separately from internal request DTOs and validation guards.

Selected SAF:

- Intraframe. It removes the misleading property from generated clients with small code motion in `src/server.ts` and preserves the existing runtime safety check.

Rejected pseudo-SAFs:

- README-only clarification.
- Changing the error message while still advertising `{ "not": {} }`.
- Relying on clients to understand JSON Schema's impossible type.

### HORC 3: Partial Output Availability Is Defined By Artifact Bytes

The highest-order root cause is that output availability is computed after transcript generation as "file has bytes", even when those bytes are only caller text or operational markers.

Intraframe SAF candidate:

- Have transcript/output generation return metadata such as:
  - `has_public_assistant_content`
  - `has_public_error_or_warning`
  - `has_only_user_or_marker_content`
- Set `partial_output_available` to true only when the public artifact contains child-generated assistant content or a child error/warning that can actually inform recovery.

Transframe SAF candidate:

- Persist a structured event ledger with role/kind metadata and derive all output flags from that ledger rather than from rendered Markdown bytes.

Selected SAF:

- Intraframe. It fixes the misleading field without changing artifact format or storage layout.

Rejected pseudo-SAFs:

- Rename the field while keeping byte-based behavior.
- Treat timeout/cancel markers as useful partial output.
- Tell callers to manually inspect every output file.

### HORC 4: Compatibility Repairs Are Runtime-Only, Not Configuration Hygiene

The highest-order root cause is that known model alias repair lives in request resolution/listing, but not in any migration or repair workflow for persisted config.

Intraframe SAF candidate:

- Add a lightweight config health output and remediation instruction when `default_model_repaired` is true, for example a suggested JSON replacement in `list_allowed_models` and README.

Transframe SAF candidate:

- Add versioned config schema with an explicit migration/doctor command that can rewrite stale aliases safely.

Selected SAF:

- Defer runtime change unless this becomes a repeated support issue. It is currently an observed operational note, not a functional failure. The smallest useful action is to include it in a future config-health improvement rather than change execution semantics now.

Rejected pseudo-SAFs:

- Silently rewriting user config during ordinary tool calls.
- Removing alias repair before users have a migration path.

## Implementation Plan For Final SAF Set

1. Add regression tests first.
   - Required packet with `verdict: "inconclusive"` and nonempty `blockers` must return `success: false`, write an attempt, and not advance manifest/ledger.
   - Required packet with `verdict: "needs_repair"` or `blocked` should also fail contract satisfaction.
   - Required packet with `verdict: "ready"` and empty blockers should continue to pass.
   - `listTools()` for `run_subagent` must not include `timeout_ms`.
   - Timeout transcript with only user prompt plus timeout marker must report `partial_output_available: false`.

2. Implement packet satisfaction semantics.
   - Update `writePacket`/session flow so `packetSatisfied` receives the parsed packet, not just parse status.
   - Add a reason code for non-ready required packet, or map it to `packet_required_invalid` if avoiding a schema migration.
   - Ensure failed contract packets append to `attempts.jsonl` and do not commit candidate session state.

3. Split public MCP schemas in `src/server.ts`.
   - Define a base run input without `timeout_ms`.
   - Define timed input variants for `start_run` and `run_subagent_session`.
   - Keep the existing handler guard in `runSubagent` as a defensive check.

4. Return output usefulness metadata.
   - Extend transcript/output preparation to classify rendered content.
   - Use that classification for `partial_output_available`.
   - Preserve existing output files and public transcript redaction behavior.

5. Update documentation.
   - Clarify that `packet_policy: required` means a ready handoff packet, not merely parseable JSON.
   - Confirm that `run_subagent` has no public `timeout_ms` field.
   - Document when `partial_output_available` is true.

6. Verify.
   - Run `npm run typecheck`.
   - Run `npm test`.
   - Run `npm run models:reconcile`.
   - Repeat the live packet trial and schema probe.
