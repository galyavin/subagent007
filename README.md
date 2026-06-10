# Subagent007 Pi

Subagent007 Pi is a private MCP server that delegates work to a separate Pi-backed child agent.

## Use The Tools This Way

- `run_subagent`: one synchronous, non-interactive invocation. No caller-supplied `timeout_ms`; no caller-input loop. It has an internal default deadline so a one-shot call cannot run forever.
- `start_run`: asynchronous invocation for work that may need timeout, cancellation, polling, or caller input.
- `get_run`: inspect a `start_run` task, including pending input requests and terminal result.
- `answer_run_input`: answer one pending request from a `start_run` task.
- `cancel_run`: request cancellation for an active `start_run` task.
- `run_subagent_session`: named persistent sessions keyed by `session_key`, with manifest, ledger, locking, and optional contract-packet extraction.
- `list_allowed_models`: list curated model choices and default-model health. Entries ending in `+` are patterns, not literal model IDs.

If the child may need more information from the caller, use `start_run`, then poll with `get_run` and answer with `answer_run_input`. Do not use `run_subagent` for caller input; a synchronous MCP call has no practical answer loop.

Use `run_subagent_session` only when durable continuity by `session_key` matters. Use `run_subagent` or `start_run` for ordinary isolated delegation.

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
- `openrouter/moonshotai/kimi-k2.6:free`

Equivalent unqualified Pi model ids such as `gpt-5.4-mini`, `gemma4:12b`, and `deepseek/deepseek-v4-pro` are accepted when Pi can resolve them.

Run `npm run models:reconcile` to compare the curated list with fresh source data from `pi --list-models`, OpenRouter `GET /api/v1/models`, and local Ollama `GET /api/tags`. The command exits nonzero when a curated model is missing or has drifted from a source; unavailable sources are reported as unverified instead of drift.

`list_allowed_models` also reports the configured default model, the resolved effective model after known-alias repair, whether it is allowed, and a suggested replacement when the default is stale.

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

Optional common fields:

- `model`: curated exact Pi model id or accepted OpenAI Codex pattern member; falls back to `default_model`
- `thinking_level`: `low`, `medium`, `high`, or `xhigh`; falls back to `default_thinking_level`
- `skill`: bare skill name only, such as `pda-lite` or `google-drive:google-docs`
- `output_mode`: `final` or `transcript`; default is `final`

Do not pass `$skill`, markdown links, prose, or filesystem paths as `skill`.

Successful and failed invocations return metadata plus an `output_path`. Read that file for the full final answer or public transcript. Transcript artifacts redact internal Pi event payloads such as streamed thinking deltas and partial tool-call JSON.

## One-Shot Runs

Ephemeral run:

```json
{
  "cwd": "/absolute/project/path",
  "prompt": "Review this plan for the highest-risk flaw."
}
```

Fresh raw Pi session:

```json
{
  "cwd": "/absolute/project/path",
  "prompt": "Start by mapping the codebase.",
  "continuity": { "mode": "fresh" }
}
```

Resume raw Pi session:

```json
{
  "cwd": "/absolute/project/path",
  "prompt": "Continue from the previous analysis.",
  "continuity": {
    "mode": "resume",
    "session_id": "/Users/you/.codex/subagent007-pi/pi-raw-sessions/.../session.jsonl"
  }
}
```

`continuity.mode` must be `ephemeral`, `fresh`, or `resume`. Top-level `session_id` is invalid; use `continuity.session_id` only with `mode: "resume"`.

`run_subagent` rejects caller-provided `timeout_ms`. Its internal default deadline is 110 seconds and can be changed with `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`. Use `start_run` for longer work, explicit timeouts, cancellation, polling, or caller input.

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

Input requests are stored under `~/.codex/subagent007-pi/input-requests` by default.

`timeout_ms` is accepted by `start_run` and `run_subagent_session`. It is a hard response-budget cap: the child process is stopped before that budget is exhausted so the MCP tool can return timeout metadata and any public transcript. It is rejected by `run_subagent`.

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

The first run locks in `cwd` and `skill`. Later runs with the same `session_key` must use the same real `cwd` and same `skill`.

Use `packet_policy` only when the caller needs a structured handoff packet. Values:

- `none`: default; no packet instruction or extraction
- `best_effort`: ask for a `contract_packet_v1` block and parse it when present
- `required`: fail the session run unless a valid `contract_packet_v1` block is present

Session turns execute against a candidate Pi session first. The manifest and ledger advance only when the process succeeds, a Pi session is available, and the packet policy is satisfied. Failed candidate turns are recorded in `attempts.jsonl` instead of mutating the committed session manifest.

## State And Environment

Default state root:

```text
~/.codex/subagent007-pi/
```

Environment overrides:

- `SUBAGENT007_CONFIG_PATH`
- `SUBAGENT007_RUNS_DIR`
- `SUBAGENT007_RUN_TASKS_DIR`
- `SUBAGENT007_PI_RAW_SESSIONS_DIR`
- `SUBAGENT007_SESSIONS_DIR`
- `SUBAGENT007_INPUT_REQUESTS_DIR`
- `SUBAGENT007_FAILURE_LOG_PATH`
- `SUBAGENT007_FAILURE_LOG=off`
- `SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS`
- `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`
- `SUBAGENT007_MAX_TRANSCRIPT_BYTES`
- `SUBAGENT007_PI_AGENT_DIR`
- `PI_CODING_AGENT_DIR`
- `SUBAGENT007_PI_SKILL_PATHS`

`SUBAGENT007_PI_AGENT_DIR` wins over Pi's native `PI_CODING_AGENT_DIR`; otherwise the Pi agent directory defaults to `~/.pi/agent`. The resolved agent directory is used for Pi auth, custom models, settings/resources, and session behavior.

## Development

```sh
npm run typecheck
npm test
```

Tests use `SUBAGENT007_PI_CHILD_PATH` to replace the real Pi child with a fake child process. Do not set it for normal MCP use.
