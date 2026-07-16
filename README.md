# Subagent007 Pi

Subagent007 Pi is a private MCP server that delegates work to a separate Pi-backed child agent.

## Agent Quickstart

Use this server as a durable delegation boundary. Treat `run_id` as the unit of progress.

- Default to `schedule_run` for work that may be broad, slow, skill-bound, interactive, or worth cancelling.
- Use `run_subagent` only when the task is genuinely quick, bounded, non-interactive, and deadline-compatible.
- Use `schedule_run.wait_ms` for the initial wait; use `timeout_ms` only when the child should be killed at a hard deadline.
- If `status:"working"`, poll the same `run_id` with `get_run`; if `status:"input_required"`, answer its `request_id` and keep polling. Do not resubmit the same prompt.
- Treat `working` as authoritative. Silence, heartbeats, elapsed time, and recursive children do not authorize cancellation; use `cancel_run` only for explicit user intent or a caller-owned stop condition.
- Bind skills with the `skill_name` field. Do not put `/skill:...`, `$skill`, markdown links, paths, or prose skill references in the prompt.
- Treat `preflight_rejected` plus `child_started:false` as a front-door validation failure. No child model work ran.
- At terminal status, prefer file-backed `output_references`; fall back to legacy `output_path` only when present.

## Tool Selection

| Situation | Tool | Key constraints |
| --- | --- | --- |
| Quick, bounded, non-interactive one-shot work | `run_subagent` | Requires `run_kind: "quick_noninteractive"`; rejects caller `timeout_ms`; one-shot-incompatible valid requests auto-promote to a durable run. |
| Broad, long, cancellable, polling, or caller-interactive work | `schedule_run` or `start_run` plus `get_run` | Prefer `schedule_run` for uncertain work. It creates the durable task before waiting, caps the initial wait, and reports `wait_truncated` when shortened. Use `start_run` when the caller wants only an immediate task handle. Leave `timeout_ms` unset unless there is a hard kill deadline. |
| Durable continuity by semantic key | `start_session_run` plus `get_run`, or `run_subagent_session` for compatibility | Requires `session_key`; use when manifest/ledger continuity matters. Prefer the async task form for long, cancellable, or abandoned-client-safe work. |
| Existing durable run operations | `get_run`, `answer_run_input`, `cancel_run` | Use the returned `run_id`; answer only listed pending `request_id` values; poll after cancellation until a terminal state appears. |
| Validate a canonical skill name/digest set before publishing work | `verify_skill_bindings` | Read-only, versioned, and all-or-nothing; requires an absolute `cwd` plus 1–64 unique name-sorted bindings. Treat the result as point-in-time evidence and retain launch-time rechecks. |
| Model-class/config health | `list_model_classes` | `list_allowed_models` is a compatibility alias. |
| Durable-run adapter compatibility | `get_run_contract` | Check `contract_name`, `contract_version`, terminal/non-terminal statuses, and capabilities before launching command-mode adapters; fail closed when incompatible. |
| Runtime/build/source readiness | `get_runtime_readiness`; or `npm run runtime:readiness` before MCP launch | Use the script when a caller needs to prove the built server entrypoint can launch. It reports typed blocks such as `missing_build`, `stale_build`, `dirty_source`, `source_state_unknown`, `incompatible_contract`, and `runtime_launch_failure`. |

## Requirements

- Node.js `>=22.19.0`
- npm, using the committed `package-lock.json`
- Pi-compatible model/auth configuration visible to the MCP process
- For `effect_profile:"workspace_read_only"`, a valid `pi-search-hub` package at `<resolved Pi agent dir>/npm/node_modules/pi-search-hub`; this repository does not install that explicit provider

The server uses the bundled `@earendil-works/pi-*` dependencies. A separately installed `pi` CLI is optional: normal MCP execution does not use it, while `npm run models:reconcile` queries `pi --list-models` when available and otherwise marks that inventory source unverified.

Quick checks:

```sh
node --version
npm ci
npm test
```

## Config

The config file is optional. When it is missing, the server uses model class `C`.
Create the file only to override that default or preserve explicit local policy.

Default config path:

```text
~/.codex/subagent007-pi/config.json
```

Example explicit policy:

```sh
mkdir -p ~/.codex/subagent007-pi
printf '%s\n' '{"default_model_class":"C"}' > ~/.codex/subagent007-pi/config.json
```

Use model classes instead of concrete model IDs. The default class is `C`; callers may pass `model_class` when a specific capability tier matters. Concrete model and `thinking_level` selection is internal calibration and is not part of the public MCP contract.

| Class | Use when |
| --- | --- |
| `A` | Narrow, low-risk read-only probes. |
| `B` | Simple coding, review, or search with limited ambiguity. |
| `C` | Default for bounded implementation and ordinary repo-grounded reasoning. |
| `D` | Complex multi-file debugging, planning, or synthesis. |
| `E` | Highest-difficulty work requiring the deepest technical judgment. |

Run `npm run models:reconcile` to compare calibrated concrete models with fresh source data from `pi --list-models`, OpenRouter `GET /api/v1/models`, and local Ollama `GET /api/tags`. The command exits nonzero when a calibrated model is missing or has drifted from a source; unavailable sources are reported as unverified instead of drift. Inventory reconciliation is separate from one-shot health.

Run `npm run model-health:probe -- --model-class C --cwd /absolute/project/path` to record whether a class is usable for the `run_subagent` one-shot surface. The health file defaults to `~/.codex/subagent007-pi/model-health.json` and can be overridden with `SUBAGENT007_MODEL_HEALTH_PATH`; an unhealthy probe exits nonzero after writing its record. Unknown health is reported with `health_basis:"never_probed"` and does not block execution; cached probe results use `health_basis:"cached_probe"`. The health gate is `blocks_only_known_unhealthy`: only known unhealthy one-shot health fails `run_subagent` before the child process starts. Each health view includes `health_action` with the exact probe command to refresh that model class.

Run `npm run config:migrate` to canonicalize `default_model_class` or migrate a legacy `default_model` plus `default_thinking_level` pair when it exactly matches a known class calibration. The command honors `SUBAGENT007_CONFIG_PATH`, writes atomically, preserves unknown fields, and is not run automatically by server startup or model-class listing.

`list_model_classes` reports the configured default class, effective default class, whether migration is needed, and one-shot health for each class. Legacy public `model` and `thinking_level` inputs are rejected; use `model_class`.

## Register With Codex

Register directly when Pi auth keys are available to ordinary child processes:

```sh
npm run build
SERVER_PATH="$(pwd)/dist/server.js"
npm run runtime:readiness -- --source-state-policy allow_dirty --expected-contract-name subagent007.durable_run --expected-contract-version 2
codex mcp add subagent007-pi -- node "$SERVER_PATH"
codex mcp get subagent007-pi
```

Use the default `require_clean` source policy for release or canary checks that must fail closed on dirty source.

If Pi auth is loaded by shell startup files such as `~/.zshrc`, register through an interactive shell:

```sh
SERVER_PATH="$(pwd)/dist/server.js"
codex mcp add subagent007-pi -- zsh -ic "exec node \"$SERVER_PATH\""
```

After registration, start a new Codex session or reload MCP servers before expecting the tools to appear.

## Common Inputs

Child-invocation tools require:

- `cwd`: absolute directory path
- `prompt`: nonempty string

Do not pass secrets unless the child model/tools may receive them and child output artifacts may contain them if echoed. Server-authored public events and transcript provenance render a redacted caller-prompt marker instead of raw `prompt`; final or transcript artifacts can still contain prompt-derived text emitted by the child. Caller-input answers cross only the live parent/child control channel. Mailbox terminal records contain response identity and receipt, never the answer body or a content-derived digest.

Optional common fields:

- `model_class`: capability tier `A`, `B`, `C`, `D`, or `E`; omit for configured `default_model_class` or `C`; concrete `model` and `thinking_level` are unsupported
- `skill_name`: bare skill name only, such as `pda-lite` or `google-drive:google-docs`; null or omission means no skill
- `skill`: legacy alias for `skill_name`; if both are provided, they must match
- `output_mode`: `final` or `transcript`; default is `final`; use `transcript` for debugging or audit trails
- `tool_profile`: legacy compatibility field; accepted values are validated and ignored; all registered child tools are active

Opt-in effect and skill-identity fields are accepted only by `run_subagent`, `start_run`, and `schedule_run`. They are independent; a skill digest may be pinned without selecting an effect profile.

- `effect_profile: "workspace_read_only"`: creates the Pi session with exactly `read`, `grep`, `find`, `ls`, `web_search`, `web_read`, and `request_input`; ambient project/global extensions and recursive `delegate` are excluded
- `expected_skill_sha256`: optional lowercase SHA-256 content pin paired with canonical `skill_name`; the parent rejects a source mismatch before child launch, and the child rejects a snapshot mismatch before prompt submission

Child-invocation input rules:

| Tool | Required beyond `cwd`/`prompt` | Accepted fields beyond common inputs | Rejected fields |
| --- | --- | --- | --- |
| `run_subagent` | `run_kind: "quick_noninteractive"` | `continuity`, `effect_profile`, `expected_skill_sha256` | `timeout_ms`, top-level `session_id` |
| `schedule_run` | none | `continuity`, `timeout_ms`, `wait_ms`, `effect_profile`, `expected_skill_sha256` | top-level `session_id` |
| `start_run` | none | `continuity`, `timeout_ms`, `effect_profile`, `expected_skill_sha256` | top-level `session_id` |
| `start_session_run` | `session_key` | `resume_mode`, `packet_policy`, `timeout_ms` | `continuity`, top-level `session_id`, `effect_profile`, `expected_skill_sha256` |
| `run_subagent_session` | `session_key` | `resume_mode`, `packet_policy`, `timeout_ms` | `continuity`, top-level `session_id`, `effect_profile`, `expected_skill_sha256` |

Run-control operation tools do not accept `cwd` or `prompt`: `get_run` takes `run_id`; `cancel_run` takes `run_id`; `answer_run_input` requires `run_id`, `request_id`, `response_id`, and `answer`. A successful receipt means the child-side waiter accepted that exact response. During a live run, an exact retry returns the prior receipt without redelivery; a changed answer under the same response identity is rejected. The separate read-only `verify_skill_bindings` operation accepts `cwd` but no prompt.

`verify_skill_bindings` is a separate version-1 read-only operation for callers that must validate canonical skill identity before publishing work. It accepts a strict object with `contract_version:1`, an absolute `cwd`, and 1–64 unique bindings strictly ASCII-sorted by `skill_name`; each binding contains only canonical `skill_name` and lowercase `expected_skill_sha256`. It invokes no model or child and creates no run, session, admission record, snapshot, lease, event, temporary artifact, cache, or failure-log record. Success is all-or-nothing and returns the canonical resolved path and SHA-256 for every binding. Semantic failures use `skill_not_found`, `skill_ambiguous`, `skill_unreadable`, `skill_content_mismatch`, `cwd_not_absolute`, `cwd_inaccessible`, or `cwd_not_directory` without returning partial bindings. Every `skill_*` rejection includes `failed_binding` with its zero-based canonical-array `index`, `skill_name`, and `expected_skill_sha256`; every `cwd_*` rejection omits `failed_binding` because no binding was evaluated. Malformed version, shape, count, order, duplicates, names, and digests are standard MCP input errors.

Every version-1 response binds the complete request through `request_binding.cwd`, `request_binding.count`, and lowercase `request_binding.canonical_request_sha256`. Compute that digest as SHA-256 over the UTF-8 bytes of the domain string `subagent007.skill_binding_verification.request.v1\n` followed immediately by `JSON.stringify({contract_version:1,cwd,bindings})`, with object keys in that shown order and bindings in the required canonical order. Verification is point-in-time only; callers must retain the launch-time digest recheck rather than caching the result as durable authority.

For raw Pi `continuity`, use `mode: "ephemeral"`, `mode: "fresh"`, or `mode: "resume"` with absolute `continuity.session_id`. Resume session ids must point to an existing, readable, nonempty session file. The session file does not retain `effect_profile`; send the profile on every constrained resume invocation. Prefer named sessions for unconstrained durable project work; named-session APIs do not accept the constrained profile.

When `effect_profile` is omitted, every child retains the legacy behavior: all tools registered by the embedded Pi session are active, including installed Pi extension/MCP tools and the native recursive `delegate` tool. Legacy `tool_profile` does not alter that behavior. Legacy startup still fails if `web_search` or `web_read` is unavailable from the registered Pi tools. Subagent007 does not import Codex MCP registrations; install legacy capabilities in the Pi environment.

`effect_profile:"workspace_read_only"` is an additive fail-closed exception. Before the first prompt, Subagent007 disables ambient project/global extension discovery, explicitly loads `pi-search-hub` from the resolved Pi agent directory, constructs the Pi session with the exact seven-tool allowlist, verifies the active tool set, and emits `subagent007.activation_confirmed`. `web_search`, `web_read`, and `request_input` each have a provider identity and implementation SHA-256 in `activation_receipt.tool_bindings`; missing providers, missing receipts, conflicting toolsets, or digest-shape failures produce `reason_code:"effect_profile_activation_failed"`. The receipt precedes `child_prompt_submitted` and is copied into active/terminal durable views. This is a Pi tool-dispatch boundary, not an OS sandbox or a hostile-runtime security claim.

Activation receipt schema `1` is strict and requires `confirmed_before_prompt:true`. Its exact top-level fields are `schema_version`, `confirmed_before_prompt`, `requested_effect_profile`, `resolved_effect_profile`, `active_tool_names`, `tool_bindings`, `toolset_sha256`, and `skill_binding`. For `workspace_read_only`, both profile fields name that profile, the active tools use the documented seven-tool order, and bindings are ordered `request_input`, `web_read`, `web_search`, each with `tool_name`, `provider_id`, and lowercase `implementation_sha256`. `toolset_sha256` binds the profile, ordered tools, and bindings. For a digest-pinned skill without an effect profile, the profile fields and toolset digest are null, tool arrays are empty, and `skill_binding` carries `name`, canonical `path`, `content_sha256`, and `expected_content_sha256`.

`skill_name` must resolve to exactly one bare skill name before model invocation. Unknown, ambiguous, prompt-syntax, markdown, prose, and path forms reject with `child_started:false`; terminal metadata records the resolved path and content hash. When `expected_skill_sha256` is supplied, Subagent007 compares it with the resolved `SKILL.md` content before launch, gives Pi a run-owned read-only snapshot of those bytes, and the child re-verifies that snapshot before prompt submission. A mismatch fails closed as `skill_content_mismatch`; a match is included under `activation_receipt.skill_binding`, whose path remains the canonical source path rather than the private snapshot.

Result semantics:

- `get_runtime_readiness` returns the concrete runtime snapshot from inside the running MCP server: resolved project root, server entrypoint, build/dist facts, git/source facts, durable-run contract compatibility, and public tool/capability surface. For pre-launch checks, use `npm run runtime:readiness`; it verifies `dist/server.js` exists before launching MCP, then calls `get_runtime_readiness`. A blocked result includes `status:"blocked"`, `ready:false`, and machine-readable `blocks[].class`.
  The default source policy is `require_clean`, which blocks dirty or unknown git state; `allow_dirty` permits dirty checkouts while still blocking unknown source state, and `allow_unknown` permits both dirty and unknown source state for package-style or exploratory probes.
- `get_run_contract` returns the durable-run lifecycle contract. Version `2` defines non-terminal statuses `working` and `input_required`, terminal statuses `completed`, `failed`, `cancelled`, and `timed_out`, complete file-backed transcripts with bounded public excerpts, fail-closed disk-reserve protection, mailbox addressing by `run_id/request_id`, recursive lineage fields, session start tools under `tools.session_start`, fail-closed restart drift behavior, the additive `effect_profiles.workspace_read_only` capability/receipt schema, and the additive version-1 `skill_binding_verification` operation contract. Its acknowledged-input guarantees require response IDs, make receipts evidence of child-waiter acceptance, support exact live replay, forbid operational answer persistence, and fail closed after provider loss. The durable-run contract remains version `2`; callers discover batch verification through capability `batch_skill_binding_verification`.
- Terminal views after child execution include `output_references` plus legacy `output_path`; read the referenced file for the full answer and check `written_output_mode`. File-backed public transcripts are complete and are not subject to a per-transcript byte cap; only bounded MCP event/excerpt projections are shortened. Requested `final` output succeeds only when a final message is captured. A clean child exit without that final message fails with `reason_code:"missing_final_output"` and writes the public transcript as diagnostic output; timeout, cancellation, disk-reserve termination, and other failures can also expose transcript output. Schema and preflight rejections do not create output artifacts.
- Failed, timed-out, restart-drift, and structured rejection views include `error_class` and `reason_code` when the server can classify the failure; adapters should branch on those fields instead of parsing `error`.
- Provider usage-limit failures use `reason_code:"usage_limit_reached"` and may include provider reset/retry fields such as `provider_status_code`, `provider_error_message`, `usage_limit_resets_in_seconds`, `usage_limit_retry_after_seconds`, and primary/secondary usage percentages. The same fields are copied to failure-log records.
- SDK input-schema errors—such as missing required fields, invalid enum values, or unrecognized inputs—return standard MCP `isError` responses before the server handler or child starts. They do not carry `kind:"preflight_rejected"` or `child_started`; correct the input and retry.
- Child-invocation preflight rejections return structured content with `kind:"preflight_rejected"`, `success:false`, and `child_started:false`; no child model work ran.
- Operation-only semantic rejections from `get_run`, `answer_run_input`, and `cancel_run` return structured content with `kind:"operation_rejected"`, `success:false`, and a typed `reason_code`; these views do not include `child_started` because the target run may already have launched.
- Skill-bound terminal results include `requested_skill`, `resolved_skill_path`, and `resolved_skill_sha256`; pinned runs also include `expected_skill_sha256` and the confirmed binding in `activation_receipt`; unbound runs use `null` for the legacy skill audit fields.
- Valid `run_subagent` requests that are incompatible only with one-shot execution auto-promote and include `auto_promoted_from`, `promotion_reason_code`, `promotion_reason`, `poll_with`, and `cancel_with`.
- `run_subagent`, `schedule_run`, `start_run`, `start_session_run`, and `run_subagent_session` create durable run-task snapshots inspectable with `get_run` by `run_id`.
- Recursive descendant runs created through a child `delegate` tool are also durable root-visible runs. Run views include `root_run_id`, `recursion_depth`, direct `child_run_ids`, and `parent_run_id` for non-root descendants. Parent `recent_events` include sanitized `recursive_child_started` and `recursive_child_finished` events with child run id and terminal status/success metadata. There is no full descendant-tree manager or cascade cancellation; cancel each returned child run explicitly when needed.
- Active `get_run` views expose sanitized `recent_events`, `last_public_output_excerpt`, and `partial_output_path` once the public transcript staging file exists; raw thinking, private tool payloads, backend Pi session IDs, internal mailbox paths, caller prompt text, full packet instructions, composed child prompts, and input answer values are not exposed in public event views. Callers address input through `run_id` and `request_id`, never a filesystem path. After a server restart, reconciliation atomically promotes that partial file into the failed run's diagnostic `output_references` instead of leaving an orphan.
- On timeout or disk-reserve termination, `partial_output_available` is true only when the artifact includes child assistant text, a warning/error, or a captured final message.

## One-Shot Runs

One-shot request:

```json
{
  "cwd": "/absolute/project/path",
  "run_kind": "quick_noninteractive",
  "prompt": "Review this plan for the highest-risk flaw."
}
```

`run_kind` asserts that work is bounded, non-interactive, and deadline-compatible. Skill-bound, long, broad, or write-like valid requests auto-promote to a durable run; hard-invalid inputs still reject before child execution. Auto-promotion is a compatibility fallback—call `schedule_run` or `start_run` directly for deliberate durable work. The one-shot health gate applies only when execution remains synchronous.

`run_subagent` rejects caller-provided `timeout_ms`. Its internal default deadline is 110 seconds and can be changed with `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`; that deadline applies only when the request remains a synchronous one-shot. Auto-promoted runs use the durable-run timeout contract: no server hard cap is added unless the caller uses a timed durable tool such as `schedule_run` or `start_run`. If a true one-shot hits its deadline, retry broad work through `schedule_run` or `start_run`; use `schedule_run.wait_ms` for the initial wait and `timeout_ms` only for a real kill deadline. Inspect the original `run_id` with `get_run`.

## Async Runs And Caller Input

Use `schedule_run` for the default durable-first path:

```json
{
  "cwd": "/absolute/project/path",
  "prompt": "Ask me for the deployment target before editing files.",
  "wait_ms": 1000
}
```

Use `start_run` instead when the caller wants only an immediate task handle; it accepts the same fields except `wait_ms`.

`schedule_run` creates the durable task before waiting. If the child completes or requests caller input within the effective wait window, it returns that state; otherwise it returns the active run view. Default `wait_ms` is 1000; set `wait_ms:0` to return the task handle immediately. The server caps the initial wait at 30000 ms by default and always includes:

- `requested_wait_ms`: the caller's requested wait
- `effective_wait_ms`: the wait the server actually used
- `wait_truncated`: true when the server shortened the requested wait

If `wait_truncated:true`, continue with `get_run` instead of retrying the same request.

Flow:

1. Call `schedule_run` or `start_run`.
2. Poll `get_run` with the returned `run_id`.
3. If status is `input_required`, read `input_requests`.
4. Call `answer_run_input` with `run_id`, `request_id`, stable `response_id`, and `answer`; retain `input_response_receipt` for an exact idempotent retry.
5. Keep polling until status is `completed`, `failed`, `cancelled`, or `timed_out`, then read `output_references` or legacy `output_path` when present.

After `cancel_run`, an in-flight cancellation reports `status:"working"` with `active_phase:"cancelling"`.
Continue polling until `status:"cancelled"` appears; that terminal view includes the settled cancellation metadata.

Active input requests are stored under `~/.codex/subagent007-pi/input-requests` by default. Each request has one terminal settlement: `answered`, `timed_out`, or `closed`. Multiple pending requests are legal; clients that auto-answer should do so only when exactly one request is pending and fail closed otherwise. Duplicate answers, stale request IDs, foreign request IDs, and late answers to closed or timed-out requests are rejected. A run serializes answer acceptance, cancellation, finalization, and pending-request closure; the first committed outcome wins. Cancelling a run or reaching any terminal run state closes remaining pending requests. After the authoritative terminal snapshot contains the settled input views, the run-owned mailbox directory is removed; `get_run` continues to return those canonical settled views.

`timeout_ms` is optional for `schedule_run`, `start_run`, `start_session_run`, and `run_subagent_session`; omit it for broad or long durable work unless the caller intentionally wants a hard kill deadline. When provided, it is a hard response-budget cap: the child process is stopped before that budget is exhausted so the MCP tool can return timeout metadata and any public transcript. Values must leave at least one millisecond of effective child runtime after configured response headroom, kill grace, and force grace are reserved. Broad review, verification, scan, skill-bound, long-prompt, or write-like run requests with an underbudget `timeout_ms` are rejected before child launch with `reason_code:"timeout_underbudget_for_deadline_risk"`; use `wait_ms` for the initial scheduler wait, omit `timeout_ms` for long durable work, or set `timeout_ms` above the configured deadline-risk floor.

Run task snapshots and active public event ledgers are stored under `~/.codex/subagent007-pi/run-tasks` by default. Active runs expose progress fields, `active_phase`, `last_phase_at`, lifecycle fields such as `last_child_lifecycle_event`, no-output timing via `no_public_output_elapsed_ms`, and bounded public events immediately after task creation; `running_silent` means the child process has spawned or emitted status-only lifecycle events while the server is still waiting for first public child output. `status` reflects pending input immediately. Once a terminal snapshot is atomically persisted, it becomes the canonical bounded event/input view and the redundant per-run event ledger and mailbox directory are removed. Output artifacts and terminal snapshots remain durable, so terminal `run_subagent`, `schedule_run`, `start_run`, and session task snapshots can still be inspected by `get_run` after an MCP server restart. Startup reconciliation skips runs that still have a live child lease, so a second server cannot move another live owner's partial transcript. An unreadable legacy lease returns `kind:"operation_rejected"` with `reason_code:"run_liveness_unknown"` instead of claiming a specific run is live or terminalizing it. An ownerless run that was active during a restart is persisted as terminal `status:"failed"` with `error_class:"restart_drift"` and `reason_code:"server_restarted_active_run"` because the new server process cannot safely reattach to the old child process, while its bounded public event projection is preserved in the terminal snapshot.

Inside a Subagent007 child, use the native `delegate` tool for recursive subtasks. Its inputs intentionally mirror the durable-first path: `prompt` is required, `cwd` defaults to the current child cwd, and optional `model_class`, `skill_name`, `output_mode`, `wait_ms`, and `timeout_ms` are passed to the parent scheduler. The tool does not require `run_kind` and does not expose the private control token. If the depth limit is reached, it returns `kind:"recursive_delegate_rejected"` with `reason_code:"recursive_depth_exceeded"` before any descendant child is launched. Invalid private control state or caller lineage returns `reason_code:"recursive_control_invalid"` without launching a descendant.

## Named Sessions

Use `start_session_run` when the caller wants durable continuity by semantic key and pollable task behavior:

```json
{
  "cwd": "/absolute/project/path",
  "session_key": "coherent-execution:T001",
  "prompt": "Continue the implementation review.",
  "resume_mode": "resume_or_new",
  "packet_policy": "best_effort"
}
```

`run_subagent_session` remains as a synchronous compatibility wrapper around the durable session task lifecycle. It waits for terminal state when the request stays alive, while `start_session_run` returns the task immediately for `get_run`, `cancel_run`, and active-event polling.

`session_key` must start with an ASCII letter or digit and may contain letters, digits, `_`, `-`, `.`, or `:`. It is scoped with `cwd`; the same key in a different project is a different session.

`resume_mode` values:

- `resume_or_new`: default; resume if present, otherwise create
- `new`: fail if a session already exists
- `require_existing`: fail if no session exists

Session existence and compatibility failures that are known before child launch reject at the front door with `kind:"preflight_rejected"` and `child_started:false`; for example, `require_existing` with no matching session returns `reason_code:"session_does_not_exist"` without a `run_id`.

The first successful run locks in `cwd` and the normalized skill binding from `skill_name` or legacy `skill`. Later runs with the same `session_key` must use the same real `cwd` and same normalized skill binding. Do not pass raw `continuity` or top-level `session_id` to named-session tools; named sessions derive Pi continuity from the manifest.

Use `packet_policy` only when the caller needs a structured handoff packet. Values:

- `none`: default; no packet instruction or extraction
- `best_effort`: ask for a `contract_packet_v1` block and parse it when present; parse status is metadata only
- `required`: fail the session run unless a valid `contract_packet_v1` block claims `verdict: "ready"` with an empty `blockers` array. Missing packets use `reason_code:"packet_required_missing"`, malformed packets use `reason_code:"packet_required_invalid"`, and parse-valid packets that are not ready or still have blockers use `reason_code:"packet_required_not_ready"`.

Session turns execute against a candidate Pi session first. The manifest and ledger advance only when the process succeeds, a Pi session is available, and the packet policy is satisfied. Successful promotion uses a session-local pending-commit record so restart recovery can finish the canonical file, ledger, and manifest together before removing the candidate workspace. Failed candidate turns are recorded in `attempts.jsonl` instead of mutating the committed session manifest.

When packet policy or skill binding adds server-authored instructions, public events and transcript artifacts render a redacted caller-prompt marker plus compact markers such as `[server_contract] skill_name=pda-lite` or `[server_contract] packet_policy=required contract_packet_v1 instruction applied`. The child still receives the full composed prompt required for current Pi behavior.

Session results keep `subagent_session_id` and `session_established` as committed-state fields. They also expose historical `attempt_subagent_session_id` and `attempt_session_established` telemetry so packet-required failures can show that Pi created a candidate session even when promotion to the committed session was rejected. The attempt identifier is audit metadata, not a durable readable path: after canonical promotion or failure telemetry is persisted, the run-owned attempt workspace is removed.

Named-session locks remain owned until their matching holder releases them or the local owner process is definitely gone; elapsed time never transfers a live session lock. Packet-policy semantics are unchanged by the async task wrapper.

## State And Environment

Default state root:

```text
~/.codex/subagent007-pi/
```

Environment overrides:

- Paths: `SUBAGENT007_CONFIG_PATH`, `SUBAGENT007_RUNS_DIR`, `SUBAGENT007_RUN_TASKS_DIR`, `SUBAGENT007_PI_RAW_SESSIONS_DIR`, `SUBAGENT007_SESSIONS_DIR`, `SUBAGENT007_INPUT_REQUESTS_DIR`, `SUBAGENT007_FAILURE_LOG_PATH`, `SUBAGENT007_MODEL_HEALTH_PATH`, `SUBAGENT007_ACTIVE_CHILDREN_DIR`, `SUBAGENT007_QUEUED_RUNS_DIR`, `SUBAGENT007_TEMP_DIR`
- Timeouts/progress/resources: `SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS`, `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`, `SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS`, `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS`, `SUBAGENT007_DEADLINE_RISK_TIMEOUT_FLOOR_MS`, `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS`, `SUBAGENT007_HEARTBEAT_INTERVAL_MS`, `SUBAGENT007_MIN_FREE_DISK_BYTES`
- Pi/runtime: `SUBAGENT007_PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `SUBAGENT007_PI_SKILL_PATHS`, `SUBAGENT007_PI_CHILD_PATH`, `SUBAGENT007_MAX_ACTIVE_CHILDREN`, `SUBAGENT007_MAX_QUEUED_RUNS`, `SUBAGENT007_MAX_RECURSION_DEPTH`
- Failure logging and campaigns: `SUBAGENT007_FAILURE_LOG=off`, `SUBAGENT007_FAILURE_STORAGE_MAX_BYTES`, `SUBAGENT007_BUILD_SHA`, `GIT_COMMIT`, `SUBAGENT007_RECORD_SOURCE`, `SUBAGENT007_CAMPAIGN_ID`, `SUBAGENT007_CAMPAIGN_LEDGER_PATH`, `SUBAGENT007_COVERAGE_MANIFEST_PATH`

`SUBAGENT007_PI_AGENT_DIR` wins over Pi's native `PI_CODING_AGENT_DIR`; otherwise the Pi agent directory defaults to `~/.pi/agent`. The resolved agent directory is used for Pi auth, custom models, settings/resources, and session behavior.
`SUBAGENT007_PI_CHILD_PATH` overrides the built child entrypoint and is intended for tests or controlled probes; do not set it for normal MCP use.

`SUBAGENT007_MAX_ACTIVE_CHILDREN` is the shared local execution ceiling and defaults to `24`. Top-level `start_run` and `schedule_run` requests above that ceiling enter a bounded owner-scoped queue and return `status:"working"`, `active_phase:"queued"`, `child_started:false`, and `queued_at`. Promotion adds `child_started_at` and `queue_wait_ms`; `timeout_ms` starts only after launch. `SUBAGENT007_MAX_QUEUED_RUNS` defaults to `96`; `0` disables queueing, and a full queue rejects before registration with `reason_code:"local_queue_exhausted"`. Queue tickets under `SUBAGENT007_QUEUED_RUNS_DIR` contain ownership metadata only, never prompts. One-shot, named-session, and recursive launches remain fail-fast with `local_capacity_exhausted` to preserve their contracts and avoid recursive deadlock. Setting `SUBAGENT007_MAX_ACTIVE_CHILDREN=0` disables both the execution ceiling and admission queue.

`SUBAGENT007_MIN_FREE_DISK_BYTES` protects host free space and defaults to 5 GiB. A run below the reserve rejects before child launch with `reason_code:"disk_reserve_exhausted"` and `child_started:false`; an active run checks the reserve once per second and terminates cleanly with `error_class:"resource_exhausted"` and the same reason code after publishing all public transcript content captured through that point. Durable-run and named-session failure logs preserve that classification even when process termination also produces a signal or nonzero exit. Set the reserve to `0` only when host-level disk protection is provided elsewhere.

Child stdout/stderr is projected directly into a sanitized `.partial` transcript in the durable runs directory with serialized, backpressured writes. Normal execution does not create `subagent007-process-output-*` raw spools. Terminal transcript publication atomically renames the public partial artifact; successful final-only output removes the redundant transcript staging file. Child-request/final-message scratch lives under `SUBAGENT007_TEMP_DIR` (default `~/.codex/subagent007-pi/tmp`), and server startup removes only owned directories whose recorded process is definitely gone.

`npm run build` compiles into a versioned release and atomically switches `dist/current`; stable `dist/server.js` and `dist/piChild.js` launchers remain present throughout publication. Live servers lease their release, and build cleanup removes only inactive unleased releases while preserving the current and immediately previous release. `npm run clean:dist` now prunes inactive releases rather than deleting the live `dist/` entrypoints.

`SUBAGENT007_MAX_RECURSION_DEPTH` bounds child-to-child delegation depth; the default is 8 and `0` disables descendant launch. The parent server validates the private recursive control token and depth before scheduling a descendant run.

`SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS` caps how long `schedule_run` may keep the MCP call open before returning a pollable active run view; the default is 30000. `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, and `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS` reserve time inside caller-provided `timeout_ms` so the MCP server can terminate the child process and return metadata before the caller deadline. `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS` can raise the accepted floor for timed tools. `SUBAGENT007_DEADLINE_RISK_TIMEOUT_FLOOR_MS` sets the preflight floor for deadline-risk run requests that provide a hard `timeout_ms`; the default is 600000. `SUBAGENT007_HEARTBEAT_INTERVAL_MS` controls active-run snapshot cadence and MCP progress notification cadence when the client provides a progress token.

`SUBAGENT007_BUILD_SHA` or `GIT_COMMIT` is copied into failure-log records when present. `SUBAGENT007_RECORD_SOURCE` may be `production`, `test`, or `unknown`; invalid values default to `production`. `SUBAGENT007_CAMPAIGN_ID` accepts a short token containing only letters, digits, `_`, `-`, `.`, or `:`. New records include `calibration_era:"model_class_v1"`; summaries classify older records as `legacy_unclassified`.

Raw failure telemetry is bounded across the active ledger and archived `.jsonl` files by `SUBAGENT007_FAILURE_STORAGE_MAX_BYTES`, default 64 MiB. A bounded, unref'ed worker keeps logging and compaction off the MCP response path; saturation or storage failure drops telemetry rather than delaying or changing a tool result. Therefore, do not treat `failures.jsonl` as synchronous run-completion evidence: use the durable run view as authority and allow a short bounded wait when a test or observer needs the correlated telemetry record. Append and archive operations share one atomic owner lock. When over budget, oldest raw archives are removed first and the active ledger keeps the newest complete JSON records; compact summaries are written before raw pruning and retained. `0` disables raw failure persistence.

Archive the on-disk ledger with `npm run failure-log:archive`. A successful archive prints JSON containing the summary path and `raw_archive_retained`; under a tight budget the summary can remain even when its raw archive is immediately pruned.

## Observed Trial Campaigns

Use the campaign harness for scripted real-use probes so trial activity does not write to production state by default:

```sh
npm run observed-campaign -- --campaign-id campaign.example-1 -- node ./your-probe.mjs
```

Without `--state-root`, the harness isolates run state and telemetry in a temporary root and defaults `SUBAGENT007_RECORD_SOURCE=test`. Calls through an already-running installed server remain production-state observations unless that server was launched inside the campaign environment.

Use the bundled MCP probe when a report needs deterministic current-surface call-attempt evidence:

```sh
npm run observed-campaign -- --campaign-id campaign.example-1 -- npm run observed-mcp-probe -- --server ./dist/server.js --cwd /absolute/project/path --profile full-current
```

Run the probe through `observed-campaign` for isolation. Direct probes require `SUBAGENT007_FAILURE_LOG_PATH` plus either `SUBAGENT007_RECORD_SOURCE=test` or `SUBAGENT007_CAMPAIGN_ID`; `SUBAGENT007_CAMPAIGN_LEDGER_PATH` selects the call-attempt ledger. Only that ledger proves MCP call-attempt coverage—`failures.jsonl` is handler/child failure telemetry. The probe defaults to `protocol-core`; `--profile full-current` covers the deterministic current surface defined in `scripts/observed-coverage-manifest.json`. For installed-Pi smoke evidence, leave `SUBAGENT007_PI_CHILD_PATH` unset and run `--profile live-current`; it is intentionally an integration smoke profile, not full edge coverage.

## Development

For repository work, read `AGENTS.md` and `.mex/ROUTER.md` first; they carry the current project rules and context map. In a fresh clone or new project-memory environment, run `mex setup` once before relying on `.mex/`. When README or project-memory facts change, run `mex sync` and `mex check`; use `mex log` for rationale future agents need.

```sh
npm run build
npm run typecheck
npm run docs:check
npm test
npm run models:reconcile
```

Run `npm run build` after changing `src/`; the registered MCP command and package tarball use `dist/server.js`.
Run `npm run docs:check` after changing README environment-variable docs, public model-class/internal-calibration guidance, `src/modelAllowlist.ts`, or runtime environment-variable handling in `src/` or `scripts/`; it fails when README leaks internal model IDs or environment-variable facts drift from source.
There is no lint script; use `npm run typecheck`, `npm run docs:check`, and `npm test` as the local gates.

Primary source boundaries:

- `src/server.ts` registers public MCP tools and preflight result shaping.
- `src/activeChildLease.ts` owns the shared active-child ceiling, bounded top-level admission queue, ticket-to-lease promotion, and abandoned-owner reconciliation.
- `src/runTask.ts` owns durable task state, polling views, cancellation, promotion, and active-child lease release.
- `src/runSubagent.ts` owns the Pi child request-file contract, pre-launch skill hashing/snapshotting, output projection, timeout metadata, and provider error parsing.
- `src/toolProfile.ts` owns the constrained allowlist, explicit provider identities/digests, and activation receipt construction/validation.
- `src/processRunner.ts` owns backpressured child output consumption and timeout/cancel/disk-reserve/parent-exit termination.
- `src/failureStorage.ts` owns locking, archival, the aggregate raw-byte budget, and whole-record compaction; `src/failureStorageWorker.ts` provides bounded asynchronous runtime writes.
- `src/session.ts` owns named-session manifests, packet policy, and local session locks.
- `src/skillBinding.ts` owns `skill_name`/legacy `skill` validation and prompt-level skill-invocation rejection; `src/skillResources.ts` owns name-to-`SKILL.md` resolution and ambient resource isolation.
- `src/skillVerification.ts` owns the versioned batch request digest and the shared skill-file read/hash/compare primitive used by both `verify_skill_bindings` and launch-time rechecks.
- `src/types.ts` is the public type/reason-code source; keep it synchronized with README and tests when public fields change.

Tests use `SUBAGENT007_PI_CHILD_PATH` to replace the real Pi child with a fake child process. Do not set it for normal MCP use. `npm test` runs test files serially inside one short, runner-owned temporary root. On Unix, success or failure terminates processes whose command line is owned by that exact root; every platform then removes the root. Unless explicitly overridden, run outputs, task snapshots, mailboxes, sessions, raw Pi sessions, model health, active-child leases, and the private failure ledger are all scoped beneath that root; explicit paths are preserved, and an inherited failure ledger is fingerprinted.
