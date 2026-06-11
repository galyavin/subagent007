# Full Coherent Revised SAF Set: Subagent007 MCP Server

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Inputs:

- `reports/observed-real-use-trials-2026-06-11-codex-current.md`
- `reports/saf-adversarial-stress-test-2026-06-11-codex-current.md`

Status: repaired SAF set after adversarial review. This is a design/repair artifact, not an implementation record.

## Repair Principles

1. Do not preserve a selected SAF merely because it was previously selected.
2. Collapse duplicate fixes when two downstream symptoms share one primitive.
3. Prefer changing the earliest malformed representation over adding downstream filters.
4. Scope each SAF to the exact HORC it actually eliminates.
5. Keep asymptotic claims out of True SAF language.

## Revised Classification

| ID | Repaired SAF | Classification | Why |
| --- | --- | --- | --- |
| R-SAF-1 | Public run-event append ledger with snapshot projection | **True SAF for public run observability** | Replaces transcript/mailbox-derived active state with one authoritative redacted event primitive, while retaining snapshots as projections. |
| R-SAF-2 | Prompt provenance envelope at composition boundary | **True SAF for public prompt-channel incoherence** | Separates public user prompt provenance from internal server contracts at the first composition point, avoiding renderer-only masking. |
| R-SAF-3 | Semantic preflight rejection envelope | **True SAF for semantic validation shape** | Re-scopes the problem to expected semantic preflight failures and gives them one structured in-band response shape. |
| R-SAF-4 | Executable coverage manifest and fail-closed campaign profiles | **True SAF for campaign coverage claims** | Converts coverage from prose/naming into machine-checkable surface requirements and pass/fail predicates. |

Non-goal: this set does not claim to solve every possible internal audit, provider behavior, or MCP transport concern. It repairs the observed incoherences at the smallest boundary that fully accounts for them.

## R-SAF-1: Public Run-Event Append Ledger

### HORC

Public run state is currently reconstructed from partial transcript events, mailbox reads, heartbeat fields, and terminal snapshots. That means activity, input lifecycle, packet parsing, cancellation, timeout, and terminal settlement do not share one authoritative public history.

This is the upstream cause behind:

- active runs looking idle except for the initial prompt;
- `last_progress_message` lagging behind `status`;
- input-required events disappearing after answer;
- terminal snapshots saying `running` in the progress message;
- packet parse and terminal details appearing as metadata but not as timeline events.

### Intraframe SAF Candidate

Add one redacted append-only public run-event ledger per run and make task snapshots a projection over it.

Minimal shape:

- Event storage: one JSONL file or equivalent append-only record next to the task snapshot.
- Append API: a single internal function, for example `appendRunEvent(runId, event)`.
- Projection: `get_run.recent_events`, `last_public_output_excerpt`, `last_progress_at`, `last_progress_message`, and terminal snapshot fields derive from the latest relevant public events plus the existing result metadata.
- Producers:
  - run/task created;
  - child process started;
  - public user/assistant message;
  - input requested;
  - input answered, timed out, or closed;
  - timeout marker;
  - cancellation requested and settled;
  - packet parsed, packet rejected, packet accepted;
  - terminal completed, failed, or cancelled.
- Privacy rule: public events may include request ids and status transitions, but not answer text, raw thinking, private tool payloads, or unredacted internal prompts.

### Transframe SAF Candidate

Replace the task snapshot store with full event sourcing for all run state, including private/internal event streams, process state, mailbox state, and terminal result materialization.

### Selected SAF

Select the intraframe append ledger.

It is the smallest sufficient change because the defect is public run-history incoherence, not absence of a complete private runtime event store. A full event-sourced runtime is cleaner long-term, but it moves more state authority than required to eliminate the observed issue.

### Rejected Pseudo-SAFs

- Lower heartbeat interval. More `running` messages still do not explain what is happening.
- Store a bigger transcript excerpt. More text is not a typed state history.
- Add input-specific public events outside a shared event append primitive. That creates another projection boundary.

### Acceptance Checks

- A long shell run shows public events for task creation, child start, public prompt, terminal timeout/cancel/complete, and final assistant output when present.
- A caller-input run records `input_required` and `input_answered` once, in order, with no answer text.
- A cancelled run records cancellation requested and terminal cancelled.
- A required packet run records packet parse status and packet gate result.
- `last_progress_message` always matches the latest status-significant public event, not stale heartbeat text.
- Restarted completed runs preserve public event history through `get_run`.

## R-SAF-2: Prompt Provenance Envelope

### HORC

The public transcript currently derives the user-visible prompt from the composed child prompt. Server contracts such as packet instructions and skill wrappers can therefore appear as if they were user-authored prompt content.

This is the upstream cause behind:

- packet contract instructions dominating `recent_events`;
- `last_public_output_excerpt` starting mid-scaffold;
- renderer-specific redaction being tempting as a symptom fix;
- future renderers or logs inheriting the same prompt provenance error.

### Intraframe SAF Candidate

Introduce a prompt provenance envelope before child dispatch.

Minimal shape:

- Preserve `public_prompt`: the caller-authored prompt after validation and normalization.
- Preserve `internal_contracts`: server-authored additions such as packet instructions and skill binding metadata.
- Preserve `composed_child_prompt`: the exact string sent to Pi when the current child interface still needs one text prompt.
- Render public run events from `public_prompt` plus compact contract markers, not from `composed_child_prompt`.
- Store or expose enough metadata to say, for example, `packet_policy: required contract_packet_v1 instruction applied`, without dumping the full instruction into the public user event.

### Transframe SAF Candidate

Change the Pi child request protocol to support separate channels for user prompt, system/developer contract instructions, skill binding, and output contract instructions.

### Selected SAF

Select the intraframe prompt provenance envelope.

It changes the first boundary where the malformed public representation is created, while remaining compatible with the current child process contract. Renderer redaction can remain as defense in depth, but it is not the fix.

### Rejected Pseudo-SAFs

- Strip `<subagent007_contract_packet>` in `publicOutputLineFromProcessLine` only. That hides the symptom after the prompt has already been misclassified.
- Shorten packet instructions. Shorter scaffold text is still scaffold text presented as user content.
- Increase excerpt length. The excerpt would remain polluted.

### Acceptance Checks

- A required packet run's public user event contains only the original user prompt plus a compact packet-policy marker.
- The full packet instruction is not present in `recent_events` or `last_public_output_excerpt`.
- The child still receives the complete contract needed to produce a packet.
- Skill-bound runs distinguish caller prompt from server-applied skill wrapper.
- Public transcript tests prove scaffold text is absent without relying on brittle pattern-only redaction.

## R-SAF-3: Semantic Preflight Rejection Envelope

### HORC

Expected semantic preflight failures are currently exposed through thrown handler errors, while process-terminal outcomes use structured result objects. Schema-level MCP validation and unexpected exceptions are separate concerns, but expected semantic rejections need a stable caller-facing shape.

This is the upstream cause behind:

- broad-work one-shot rejection returning clear human text but no stable structured rejection payload;
- skill-bound one-shot rejection requiring client special-casing;
- semantic validation being hard to distinguish from unexpected handler failure through the installed tool surface.

### Intraframe SAF Candidate

Return expected semantic preflight failures as structured in-band results with a discriminant.

Minimal shape:

```json
{
  "status": "rejected",
  "kind": "preflight_rejected",
  "success": false,
  "child_started": false,
  "error_class": "validation_error",
  "reason_code": "run_subagent_incompatible_workload",
  "message": "This request is incompatible with run_subagent's quick_noninteractive contract.",
  "retry_with": "start_run",
  "retry_arguments": { "timeout_ms_required": true }
}
```

Scope:

- In scope: semantic validation and preflight decisions after the request reaches handler logic.
- Out of scope: SDK schema rejections before handler invocation.
- Out of scope: unexpected exceptions that should remain error-path failures and failure-log records.
- Out of scope: child process failures, which should stay terminal `status:"failed"` result objects with `child_started:true`.

### Transframe SAF Candidate

Relax MCP schemas to type-only boundaries and make all semantic validation return a single discriminated union result. This would make the caller result shape more uniform at the cost of weakening schema-level feedback.

### Selected SAF

Select the intraframe semantic preflight envelope.

It is a True SAF only after the HORC is scoped precisely to expected semantic preflight failures. It does not pretend to unify SDK schema errors, unexpected exceptions, and terminal child failures.

### Rejected Pseudo-SAFs

- Put all errors into `success:false` terminal results. That conflates "server rejected before execution" with "child ran and failed."
- Rely on failure logs for caller semantics. Logs are audit telemetry, not response shape.
- Claim schema errors are fixed by handler envelopes. Handler code never sees them.

### Acceptance Checks

- Broad-work `run_subagent` rejection returns `kind:"preflight_rejected"`, `child_started:false`, and `retry_with:"start_run"`.
- Skill-bound `run_subagent` rejection returns the same envelope with a skill-bound reason code.
- Prompt-level `/skill:` syntax returns a semantic preflight envelope if it reaches handler logic.
- Missing required fields remain MCP schema errors and are documented as such.
- Child nonzero exit remains a terminal failed run, not a preflight rejection.

## R-SAF-4: Executable Coverage Manifest And Fail-Closed Campaign Profiles

### HORC

Campaign coverage is currently assembled from script names, prose report interpretation, deterministic harness output, live installed calls, and unit-test knowledge. The deterministic probe now reports uncovered surfaces honestly, but no single profile defines required surfaces, evidence class, and pass/fail criteria as executable data.

This is the upstream cause behind:

- `all-bundled` sounding broader than it is;
- "full e2e coverage" depending on manual report assembly;
- deterministic and live evidence being easy to conflate;
- future campaigns passing despite missing an important surface.

### Intraframe SAF Candidate

Add an executable coverage manifest and profile runner.

Minimal shape:

- A manifest listing product surfaces:
  - tool listing;
  - model class listing and compatibility alias;
  - one-shot success;
  - one-shot semantic preflight rejection;
  - one-shot child failure;
  - one-shot timeout recovery;
  - async start/poll/complete;
  - caller input request/answer/late answer;
  - cancellation;
  - timeout;
  - raw Pi continuity;
  - named session create/resume;
  - named session negative modes;
  - packet ready/non-ready/invalid;
  - skill binding and skill validation;
  - transcript redaction;
  - installed Pi integration.
- Profiles:
  - `protocol-core`: deterministic fake-child MCP protocol subset.
  - `live-smoke`: minimal installed Pi integration.
  - `stateful-live`: installed continuity/session/input/cancel/timeout paths.
  - `full-current`: all required current surfaces, with deterministic and live evidence separated.
- Each profile declares required, optional, and out-of-scope surfaces.
- A profile exits nonzero when a required surface lacks a recorded successful observation or expected failure observation.
- Output includes `covered_surfaces_by_evidence_class`, skipped surfaces with reasons, and state paths.

### Transframe SAF Candidate

Build a full MCP conformance runner that can attach to arbitrary MCP server processes or installed MCP tool contexts, normalize all deterministic and live evidence into one conformance artifact, and manage environment-dependent prerequisites.

### Selected SAF

Select the intraframe executable coverage manifest and profile runner.

It fully eliminates the observed coverage-claim incoherence without requiring a general-purpose conformance product. The current scripts already provide much of the substrate; the missing primitive is executable coverage semantics.

### Rejected Pseudo-SAFs

- Rename `all-bundled` to `protocol-core` only. Naming helps but does not enforce coverage.
- Add more prose to reports. Prose does not fail closed.
- Fold live-model scenarios into deterministic mode. That reintroduces model-compliance noise into protocol tests.

### Acceptance Checks

- `protocol-core` passes deterministic scenarios and marks live installed surfaces out of scope.
- `full-current` fails when installed Pi integration is unavailable or skipped without an explicit allowed skip.
- `full-current` fails if caller input, cancellation, timeout, packets, skills, or raw/named continuity are missing.
- Coverage output is machine-readable and lists evidence class per surface.
- Reports cite the manifest output rather than manually inferring coverage from multiple logs.

## Coherent Implementation Order

1. **R-SAF-1 first:** establish the public event append primitive and snapshot projection.
2. **Fold input lifecycle into R-SAF-1:** implement caller-input events as producers, not a separate mechanism.
3. **R-SAF-2 next:** preserve prompt provenance before public event rendering depends further on composed prompts.
4. **R-SAF-3 next:** normalize semantic preflight responses after event/result terminology is stable.
5. **R-SAF-4 last:** encode the repaired behavior into executable campaign profiles.

## Cross-SAF Coherence Rules

- There must be exactly one public run-event append path.
- Mailbox records remain authoritative for answers, but run events are authoritative for public timeline.
- Public prompt provenance must never be reconstructed from a composed child prompt.
- Semantic preflight rejection must mean `child_started:false`.
- Terminal child failure must mean child execution began and settled.
- Coverage claims must be emitted by executable profile results, not inferred from script names.

## Revised Non-Goals

- Do not rebuild the entire runtime around private event sourcing unless later evidence shows public event ledgers are insufficient.
- Do not expose raw chain-of-thought, private tool payloads, or answer text in public events.
- Do not weaken MCP schema validation merely to force all errors into one response envelope.
- Do not claim deterministic fake-child coverage proves live provider behavior.

## Final SAF Set

1. **R-SAF-1:** Add a redacted public run-event append ledger and make `get_run` active/terminal observability a projection over it.
2. **R-SAF-2:** Add a prompt provenance envelope at composition time so public transcript/events render caller prompt and compact server-contract markers, not the composed child prompt.
3. **R-SAF-3:** Return expected semantic preflight failures as structured `preflight_rejected` results with `child_started:false`, while preserving schema errors and child terminal failures as distinct classes.
4. **R-SAF-4:** Add executable coverage manifests and fail-closed campaign profiles so coverage claims are machine-checkable by surface and evidence class.
