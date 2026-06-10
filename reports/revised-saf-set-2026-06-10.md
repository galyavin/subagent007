# Revised SAF Set - 2026-06-10

Status: selected final SAF set. The three SAFs in this document are implemented in the current worktree; keep this file as the decision record rather than as an open task list.

## Decision

Proceed with three SAFs.

Remove the stale default-model config item from the SAF set. It remains a backlog/config-health note because it is an operational hygiene issue, not a currently necessary atomic fix for a live defect.

## SAF 1: Required Packet Must Mean Claimed Ready Handoff

### HORC

`run_subagent_session` currently treats `packet_policy: required` as "a syntactically valid `contract_packet_v1` block exists." That makes `success: true` possible even when the packet itself says `verdict: "inconclusive"` or includes blockers.

### True SAF

For `packet_policy: required`, a session run may commit and return `success: true` only when all of these are true:

1. child process succeeded
2. session was established
3. packet parse status is `valid`
4. claimed packet verdict is exactly `ready`
5. claimed packet `blockers` array is empty

### Exact Invariant

```ts
contractSatisfied =
  packetPolicy !== "required" ||
  (
    packetParseStatus === "valid" &&
    claimedPacket?.verdict === "ready" &&
    claimedPacket.blockers.length === 0
  );
```

### Non-Goals

- This does not prove the work is objectively ready.
- This does not make model-authored packets authoritative evidence.
- This only aligns session commit/success semantics with the packet's own claimed readiness.

### Required Implementation Shape

- Change packet satisfaction to inspect the parsed packet, not only parse status.
- Reuse the existing attempts path: non-ready required packets append to `attempts.jsonl` and do not advance manifest or ledger.
- Add or reuse failure classification for required packets that parse but are not contract-satisfied.
- Update docs to define `required` as "ready packet required", not merely "valid JSON required."

### Validation

- Required packet with `verdict: "ready"` and `blockers: []` succeeds and commits.
- Required packet with `verdict: "inconclusive"` fails and writes an attempt.
- Required packet with `verdict: "needs_repair"` fails and writes an attempt.
- Required packet with `verdict: "blocked"` fails and writes an attempt.
- Required packet with nonempty `blockers` fails even if verdict is `ready`.

## SAF 2: `run_subagent` Must Not Expose Or Accept Caller Timeout

### HORC

The public MCP schema currently exposes forbidden `run_subagent.timeout_ms` as an impossible JSON Schema property (`{ "not": {} }`). Removing the property alone is incomplete because Zod strips unknown object keys by default, which could silently ignore a supplied timeout before the handler guard sees it.

### True SAF

`run_subagent` must have no public `timeout_ms` schema property and must still reject any call that supplies `timeout_ms`.

### Exact Invariant

For `run_subagent`:

1. `listTools()` output contains no `inputSchema.properties.timeout_ms`.
2. A tool call containing `timeout_ms` returns an MCP input validation error.
3. A valid call without `timeout_ms` continues to use the internal one-shot timeout.

### Non-Goals

- Do not add caller timeout support to `run_subagent`.
- Do not silently ignore `timeout_ms`.
- Do not weaken `start_run` or `run_subagent_session`; they should continue to accept `timeout_ms`.

### Required Implementation Shape

- Split public input schemas so `run_subagent` omits `timeout_ms`.
- Make the `run_subagent` argument object strict, or add equivalent raw-argument rejection before unknown keys are stripped.
- Keep the internal `runSubagent` guard as defense in depth.
- Keep `start_run` and `run_subagent_session` timed schemas explicit.

### Validation

- MCP schema probe: `run_subagent` has no `timeout_ms` property.
- MCP call probe: `run_subagent` with `timeout_ms` returns `isError: true`.
- Existing one-shot run still reports internal default timeout metadata.
- `start_run` with `timeout_ms` still works.
- `run_subagent_session` with `timeout_ms` still works.

## SAF 3: Partial Output Flag Must Mean Public Child-Generated Content Exists

### HORC

`partial_output_available` is currently computed from artifact byte count. On timeout, user prompt text plus a timeout marker can make the flag true even when the child produced no public assistant content, warning, or error.

### True SAF

`partial_output_available` may be true only when the public artifact contains child-generated public content.

### Exact Invariant

On timeout:

```ts
partialOutputAvailable =
  publicTranscript.hasAssistantText ||
  publicTranscript.hasSubagentWarning ||
  publicTranscript.hasSubagentError;
```

It must be false for transcripts containing only:

- user messages
- timeout markers
- cancellation markers
- truncation markers without preceding child-generated public content

### Non-Goals

- Do not attempt to judge whether assistant content is useful, correct, or sufficient.
- Do not parse private thinking or internal tool payloads.
- Do not change public transcript redaction guarantees.

### Required Implementation Shape

- Extend transcript/output preparation to return rendered text plus public-content metadata.
- Compute `partial_output_available` from exact public content kinds, not byte count.
- Preserve current output file format unless a field rename is intentionally introduced.
- Document the field's precise meaning if the existing name is retained.

### Validation

- Timeout with only user prompt plus timeout marker returns `partial_output_available: false`.
- Timeout after public assistant text returns `partial_output_available: true`.
- Timeout after `subagent007.warning` returns `partial_output_available: true`.
- Timeout after `subagent007.error` returns `partial_output_available: true`.
- Cancellation marker alone does not set partial output available.

## Non-SAF Backlog Item: Config Alias Hygiene

### Observation

Current config can contain a stale default model alias such as `openrouter/anthropic/claude-sonnet-4.5`; runtime repair maps it to `openrouter/~anthropic/claude-sonnet-latest`.

### Classification

Not part of the SAF set.

### Reason

Execution currently succeeds. A repair here would improve configuration hygiene, but it is not necessary to eliminate the observed functional defects above.

### Backlog Shape

If this becomes worth fixing, use an explicit user-invoked config health path:

- Add `config_status` and `repair_command` details to `list_allowed_models`, or
- Add a `config:doctor`/`config:migrate` script that rewrites known stale aliases only when explicitly run.

Do not silently rewrite user config during ordinary tool calls.

## Coherent Implementation Order

1. Add regression tests for all three SAF invariants.
2. Implement SAF 2 first because schema behavior affects public tool contracts and test harness expectations.
3. Implement SAF 1 next because it changes session commit semantics.
4. Implement SAF 3 last because it touches transcript/output metadata and can be verified independently.
5. Update README after behavior is implemented.
6. Run:
   - `npm run typecheck`
   - `npm test`
   - `npm run models:reconcile`
7. Repeat live probes:
   - `listTools()` schema inspection
   - invalid `run_subagent.timeout_ms` call
   - required packet with non-ready verdict
   - timeout with no assistant output

## Final SAF Set Summary

| SAF | Status | Irreducible Fix |
| --- | --- | --- |
| Required packet readiness | **True SAF** | Required packet success gates on valid parse, `verdict === "ready"`, and empty blockers. |
| One-shot timeout contract | **True SAF after repair** | `run_subagent` hides `timeout_ms` from schema and rejects supplied `timeout_ms`. |
| Partial output semantics | **True SAF after repair** | Partial output flag means public child-generated assistant/warning/error content exists. |
