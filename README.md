# Subagent007 Pi

Subagent007 Pi is a private MCP server that delegates work to a separate Pi-backed child agent.

## Use The Tools This Way

- `run_subagent`: one synchronous, quick, non-interactive invocation. Requires `run_kind: "quick_noninteractive"`. No caller-supplied `timeout_ms`; no caller-input loop. It has an internal default deadline so a one-shot call cannot run forever.
- `start_run`: asynchronous invocation for polling, cancellation, caller input, or longer work. Pass `timeout_ms` when a hard deadline matters.
- `get_run`: inspect a `start_run` task, including pending input requests and terminal result.
- `answer_run_input`: answer one pending request from a `start_run` task.
- `cancel_run`: request cancellation for an active `start_run` task.
- `run_subagent_session`: named persistent sessions keyed by `session_key`, with manifest, ledger, locking, and optional contract-packet extraction.
- `list_allowed_models`: list curated exact model choices, model patterns, and default-model health. Entries ending in `+` are patterns, not literal model IDs.

If the child may need more information from the caller, use `start_run`, then poll with `get_run` and answer with `answer_run_input`. Do not use `run_subagent` for caller input; a synchronous MCP call has no practical answer loop.

Use `run_subagent_session` only when durable continuity by `session_key` matters. Use `run_subagent` or `start_run` for ordinary isolated delegation. The default `tool_profile` is `inspect`; set `workspace_write` before expecting the child to edit files.

## Requirements

- Node.js `>=22.19.0`
- A working Pi install on the machine
- Pi model/auth configuration visible to the MCP process

Quick checks:

```sh
node --version
pi --list-models | sed -n '1,20p'
npm install
npm run build
```

## Config

Default config path:

```text
~/.codex/subagent007-pi/config.json
```

Example:

```sh
mkdir -p ~/.codex/subagent007-pi
printf '%s\n' '{"default_model":"openai-codex/gpt-5.4-mini","default_thinking_level":"medium"}' > ~/.codex/subagent007-pi/config.json
```

Use a curated model name that Pi reports as available. Provider-qualified literal IDs are safest, for example `openai-codex/gpt-5.4-mini`. Known stale aliases may be repaired to curated refs; unknown, ambiguous, unauthenticated, or non-curated models fail before work starts.

Allowed model choices:

- OpenAI Codex `gpt-5.4` or newer GPT-5.x models; pass a literal model such as `openai-codex/gpt-5.4`, `openai-codex/gpt-5.4-mini`, or `openai-codex/gpt-5.5`, not `openai-codex/gpt-5.4+`
- `ollama/gemma4:12b`
- `openrouter/deepseek/deepseek-v4-flash`
- `openrouter/deepseek/deepseek-v4-pro`
- `openrouter/~anthropic/claude-sonnet-latest`
- `openrouter/nvidia/nemotron-3-super-120b-a12b:free`
- `openrouter/moonshotai/kimi-k2.6`

Equivalent unqualified Pi model ids such as `gpt-5.4-mini`, `gemma4:12b`, and `deepseek/deepseek-v4-pro` are accepted and canonicalized to provider-qualified refs before execution and session comparison.

Run `npm run models:reconcile` to compare the curated list with fresh source data from `pi --list-models`, OpenRouter `GET /api/v1/models`, and local Ollama `GET /api/tags`. The command exits nonzero when a curated model is missing or has drifted from a source; unavailable sources are reported as unverified instead of drift.

Run `npm run config:migrate` to rewrite a noncanonical but allowed `default_model` to its canonical provider-qualified ref. This includes known stale aliases, unqualified model ids, and whitespace-padded values. The command honors `SUBAGENT007_CONFIG_PATH`, writes atomically, preserves unknown fields, and is not run automatically by server startup or `list_allowed_models`.

`list_allowed_models` also reports the configured default model, the effective model after canonicalization, whether it is allowed, whether migration is needed, the exact migration command, and a suggested replacement when the default is stale.

`thinking_level` and `default_thinking_level` must be one of `low`, `medium`, `high`, or `xhigh`.

Override the config file path with `SUBAGENT007_CONFIG_PATH`.

## Register With Codex

Register directly when Pi auth keys are available to ordinary child processes:

```sh
npm run build
codex mcp add subagent007-pi -- node /Users/rgalyavin/myApps/003-subagent007-pi/dist/server.js
codex mcp get subagent007-pi
```

If Pi auth is loaded by shell startup files such as `~/.zshrc`, register through an interactive shell:

```sh
codex mcp add subagent007-pi -- zsh -ic 'exec node /Users/rgalyavin/myApps/003-subagent007-pi/dist/server.js'
```

After registration, start a new Codex session or reload MCP servers before expecting the tools to appear.

## Common Inputs

Child-invocation tools require:

- `cwd`: absolute directory path
- `prompt`: nonempty string

`run_subagent` also requires `run_kind: "quick_noninteractive"`. `start_run` and `run_subagent_session` do not use this field.

`run_subagent` and `start_run` may use `continuity`; `run_subagent_session` does not. `continuity.mode` must be `ephemeral`, `fresh`, or `resume`. Top-level `session_id` is invalid; use `continuity.session_id` only with `mode: "resume"`.

Optional common fields:

- `model`: curated exact Pi model id or accepted OpenAI Codex pattern member; falls back to `default_model`
- `thinking_level`: `low`, `medium`, `high`, or `xhigh`; falls back to `default_thinking_level`
- `skill_name`: bare skill name only, such as `pda-lite` or `google-drive:google-docs`; null or omission means no skill
- `skill`: legacy alias for `skill_name`; if both are provided, they must match
- `output_mode`: `final` or `transcript`; default is `final`; use `transcript` for debugging or audit trails
- `tool_profile`: child tool capability profile; default is `inspect`

Tool profiles:

- `inspect`: workspace non-mutating Pi tools: `read`, `grep`, `find`, `ls`, and `request_input`
- `shell`: `inspect` plus `bash`
- `workspace_write`: `shell` plus `edit` and `write`

Use `workspace_write` only when the child is expected to modify files. Use `shell` only when command execution is necessary. The default `inspect` profile is intended for review, research, and report-only delegation.

Bind skills with `skill_name`, not prompt syntax. It must be a bare name such as `pda-lite` or `google-drive:google-docs`, not `$skill`, `/skill:name`, markdown, prose, or a path.

Successful and failed invocations return `output_path`; read it for the final answer or public transcript. Transcript output redacts internal Pi events. On timeout, `partial_output_available` is true only when the artifact includes child assistant text, a warning/error, or a captured final message; user prompts, markers, and raw process bytes do not count.

## One-Shot Runs

Ephemeral run:

```json
{
  "cwd": "/absolute/project/path",
  "run_kind": "quick_noninteractive",
  "prompt": "Review this plan for the highest-risk flaw."
}
```

Fresh raw Pi session:

```json
{
  "cwd": "/absolute/project/path",
  "run_kind": "quick_noninteractive",
  "prompt": "Start by mapping the codebase.",
  "continuity": { "mode": "fresh" }
}
```

Resume raw Pi session:

```json
{
  "cwd": "/absolute/project/path",
  "run_kind": "quick_noninteractive",
  "prompt": "Continue from the previous analysis.",
  "continuity": {
    "mode": "resume",
    "session_id": "/Users/you/.codex/subagent007-pi/pi-raw-sessions/.../session.jsonl"
  }
}
```

`run_kind` is an explicit caller contract that the work is bounded, non-interactive, and compatible with the one-shot deadline. Use `start_run` instead for longer, cancellable, polling, caller-input, exploratory, or write-heavy work.
Resume session ids must point to an existing, readable, nonempty session file. A missing path fails before Pi is started.

`run_subagent` rejects caller-provided `timeout_ms`. Its internal default deadline is 110 seconds and can be changed with `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`.

## Async Runs And Caller Input

Use `start_run` for timed, cancellable, or interactive work:

```json
{
  "cwd": "/absolute/project/path",
  "prompt": "Ask me for the deployment target before editing files.",
  "timeout_ms": 600000
}
```

Flow:

1. Call `start_run`.
2. Poll `get_run` with the returned `run_id`.
3. If status is `input_required`, read `input_requests`.
4. Call `answer_run_input` with `run_id`, `request_id`, and `answer`.
5. Keep polling until status is `completed`, `failed`, or `cancelled`.

`start_run` accepts the same `continuity` object as `run_subagent` when async raw Pi continuity is needed.

Input requests are stored under `~/.codex/subagent007-pi/input-requests` by default.

`timeout_ms` is optional for `start_run` and `run_subagent_session`; omit it only for deliberately unbounded work. When provided, it is a hard response-budget cap: the child process is stopped before that budget is exhausted so the MCP tool can return timeout metadata and any public transcript. Values must leave at least one millisecond of effective child runtime after configured response headroom and kill grace are reserved. It is not a `run_subagent` input, and `run_subagent` rejects calls that provide it.

`start_run` task snapshots are stored under `~/.codex/subagent007-pi/run-tasks` by default. Completed runs can still be inspected by `get_run` after an MCP server restart. A run that was active during a restart is reported as failed with a clear restart-state error because the new server process cannot safely reattach to the old child process.

## Named Sessions

Use `run_subagent_session` when the caller wants durable continuity by semantic key:

```json
{
  "cwd": "/absolute/project/path",
  "session_key": "coherent-execution:T001",
  "prompt": "Continue the implementation review.",
  "resume_mode": "resume_or_new",
  "packet_policy": "best_effort"
}
```

`session_key` must start with an ASCII letter or digit and may contain letters, digits, `_`, `-`, `.`, or `:`. It is scoped with `cwd`; the same key in a different project is a different session.

`resume_mode` values:

- `resume_or_new`: default; resume if present, otherwise create
- `new`: fail if a session already exists
- `require_existing`: fail if no session exists

The first successful run locks in `cwd` and the normalized skill binding from `skill_name` or legacy `skill`. Later runs with the same `session_key` must use the same real `cwd` and same normalized skill binding. Do not pass raw `continuity` or top-level `session_id` to `run_subagent_session`; named sessions derive Pi continuity from the manifest.

Use `packet_policy` only when the caller needs a structured handoff packet. Values:

- `none`: default; no packet instruction or extraction
- `best_effort`: ask for a `contract_packet_v1` block and parse it when present; parse status is metadata only
- `required`: fail the session run unless a valid `contract_packet_v1` block claims `verdict: "ready"` with an empty `blockers` array

Session turns execute against a candidate Pi session first. The manifest and ledger advance only when the process succeeds, a Pi session is available, and the packet policy is satisfied. Failed candidate turns are recorded in `attempts.jsonl` instead of mutating the committed session manifest.

## State And Environment

Default state root:

```text
~/.codex/subagent007-pi/
```

Environment overrides:

- Paths: `SUBAGENT007_CONFIG_PATH`, `SUBAGENT007_RUNS_DIR`, `SUBAGENT007_RUN_TASKS_DIR`, `SUBAGENT007_PI_RAW_SESSIONS_DIR`, `SUBAGENT007_SESSIONS_DIR`, `SUBAGENT007_INPUT_REQUESTS_DIR`, `SUBAGENT007_FAILURE_LOG_PATH`
- Timeouts/progress: `SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS`, `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`, `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS`, `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS`, `SUBAGENT007_HEARTBEAT_INTERVAL_MS`, `SUBAGENT007_MAX_TRANSCRIPT_BYTES`
- Pi/runtime: `SUBAGENT007_PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `SUBAGENT007_PI_SKILL_PATHS`
- Failure logging: `SUBAGENT007_FAILURE_LOG=off`, `SUBAGENT007_BUILD_SHA`, `GIT_COMMIT`, `SUBAGENT007_RECORD_SOURCE`, `SUBAGENT007_CAMPAIGN_ID`

`SUBAGENT007_PI_AGENT_DIR` wins over Pi's native `PI_CODING_AGENT_DIR`; otherwise the Pi agent directory defaults to `~/.pi/agent`. The resolved agent directory is used for Pi auth, custom models, settings/resources, and session behavior.

`SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, and `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS` reserve time inside caller-provided `timeout_ms` so the MCP server can terminate the child process and return metadata before the caller deadline. `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS` can raise the accepted floor for timed tools. `SUBAGENT007_HEARTBEAT_INTERVAL_MS` controls progress notification cadence when the MCP client provides a progress token.

`SUBAGENT007_BUILD_SHA` or `GIT_COMMIT` is copied into failure-log records when present. `SUBAGENT007_RECORD_SOURCE` may be `production`, `test`, or `unknown`; invalid values default to `production`. `SUBAGENT007_CAMPAIGN_ID` is copied into failure-log records when it is a short token containing only letters, digits, `_`, `-`, `.`, or `:`.

## Observed Trial Campaigns

Use the campaign harness for scripted real-use probes so trial activity does not write to production state by default:

```sh
npm run observed-campaign -- --campaign-id campaign.example-1 -- node ./your-probe.mjs
```

When `--state-root` is omitted, the harness creates a temp campaign state root and sets `SUBAGENT007_FAILURE_LOG_PATH`, `SUBAGENT007_RUNS_DIR`, `SUBAGENT007_RUN_TASKS_DIR`, `SUBAGENT007_INPUT_REQUESTS_DIR`, `SUBAGENT007_SESSIONS_DIR`, `SUBAGENT007_PI_RAW_SESSIONS_DIR`, and `SUBAGENT007_CAMPAIGN_ID` for the probe command. Reports should record the campaign ID, state root, and ledger path printed by the harness.

## Development

```sh
npm run typecheck
npm test
```

Tests use `SUBAGENT007_PI_CHILD_PATH` to replace the real Pi child with a fake child process. Do not set it for normal MCP use.
