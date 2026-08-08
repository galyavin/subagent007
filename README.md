# Subagent007 Pi

Subagent007 Pi is a private MCP server that delegates work to a separate Pi-backed child agent.

## Founder Policy And Product Boundary

> Subagent007 is a universal execution-attempt substrate, not a workflow or mission owner. A run represents one concrete delegation attempt. Subagent007 guarantees exact admission, duplicate-safe identity, bounded execution, live observation and control, durable terminal evidence, and honest owner-loss closure. It does not guarantee that an active attempt survives loss of its execution custodian. Callers own durable objective identity, retry and reconciliation policy, and external-effect safety. Bendum therefore preserves and resumes the logical project obligation, reconnects to a still-owned attempt when possible, and creates a fresh fenced attempt only after the prior attempt is conclusively settled and replacement is canon-authorized.

The first five sentences define the universal Subagent007 contract. The final sentence is Bendum's composition of that contract, not special behavior embedded in Subagent007.

The identities are intentionally separate:

| Identity | Meaning |
| --- | --- |
| caller objective, workflow step, or mission | Caller-owned logical obligation; may span zero, one, or several execution attempts. |
| `client_start_id` plus normalized request | Caller-chosen identity for exactly one attempted admission; exact replay returns that attempt and changed reuse conflicts. |
| `run_id` | Subagent007-owned record of exactly one concrete execution attempt, from admission through terminal evidence. |
| `session_id` | Private semantic conversation continuity; not execution ownership, attempt identity, or process-survival proof. |
| child process and server owner | The live execution custodian; ephemeral and never reconstructed by assertion after owner loss. |

“Durable run” means durable attempt identity, inspection, and terminal evidence—not an immortal child process or a durable caller mission. While the current server still owns an attempt, callers poll and control the same `run_id`. If that execution owner is definitely lost, Subagent007 terminalizes the old run as `restart_drift` instead of claiming reattachment. Only the caller can decide whether its logical obligation permits a new run, and only after it reconciles prior terminal/descendant evidence and any ambiguous external effects.

Callers that need duplicate-safe admission across an ambiguous start response use `start_run` with a durably retained `client_start_id` and exact request body. Convenience surfaces without that caller key do not invent mission identity or make a lost start response replay-safe. Stronger live custody, if ever justified by a current universal need, requires a real observable execution owner and an additive capability contract; it is not a speculative lifetime flag or a Bendum-specific workflow mode.

## Agent Quickstart

Use this server as a durable execution-attempt boundary. Treat `run_id` as the unit of attempt observation and control, never as the caller's mission or workflow identity.

- Default to `schedule_run` for work that may be broad, slow, skill-bound, interactive, or worth cancelling.
- Use `run_subagent` only when the task is genuinely quick, bounded, non-interactive, and deadline-compatible.
- Use `schedule_run.wait_ms` for the initial wait; use `timeout_ms` only when the child should be killed at a hard deadline.
- If `status:"working"`, call `get_run` on the same `run_id`; optionally set bounded `wait_ms` to wait for `input_required` or terminal state. If `status:"input_required"`, answer its `request_id` and continue observing. Do not resubmit the same prompt.
- If an exact `start_run` response may have been lost, replay the same durably retained `client_start_id` and exact request. Do not mint a replacement identity until the caller has settled the prior attempt and authorized retry.
- Treat `working` as authoritative. Silence, heartbeats, elapsed time, and recursive children do not authorize cancellation; use `cancel_run` only for explicit user intent or a caller-owned stop condition.
- Bind skills with the `skill_name` field. Do not put `/skill:...`, `$skill`, markdown links, paths, or prose skill references in the prompt.
- Treat `preflight_rejected` plus `child_started:false` as a front-door validation failure. No child model work ran.
- At terminal status, require exactly one provider-issued primary `output_references` entry and allow at most one additive `packet` entry; derive files only from the configured runs root plus `relative_path`.

## Tool Selection

| Situation | Tool | Key constraints |
| --- | --- | --- |
| Quick, bounded, non-interactive one-shot work | `run_subagent` | Requires `run_kind: "quick_noninteractive"`; rejects caller `timeout_ms`; always executes synchronously under the bounded internal one-shot deadline. |
| Broad, long, cancellable, polling, or caller-interactive work | `schedule_run` or `start_run` plus `get_run` | Prefer `schedule_run` for uncertain work. It creates the durable task before waiting, caps the initial wait, and reports `wait_truncated` when shortened. Use `start_run` when the caller wants only an immediate task handle. Leave `timeout_ms` unset unless there is a hard kill deadline. |
| Durable continuity by semantic key | `start_session_run` plus `get_run`, or `run_subagent_session` for compatibility | Requires `session_key`; use when manifest/ledger continuity matters. Prefer the async task form for long, cancellable, or abandoned-client-safe work. |
| Existing durable run operations | `get_run`, `answer_run_input`, `cancel_run` | Use the returned `run_id`; `get_run.wait_ms` is an optional bounded resident-owner wait, while omission/zero is immediate; answer only listed pending `request_id` values; observe after cancellation until a terminal state appears. |
| Validate a canonical skill name/digest set before publishing work | `verify_skill_bindings` | Read-only, versioned, and all-or-nothing; requires an absolute `cwd` plus 1–64 unique name-sorted bindings. Treat the result as point-in-time evidence and retain launch-time rechecks. |
| Resolve canonical skill names for a hashless draft | `resolve_skill_bindings` | Read-only version-1 all-or-nothing resolution for 1–64 unique strictly ASCII-sorted names; returns canonical paths and lowercase content hashes. |
| Validate one exact runtime-bundle root | `validate_skill_runtime_bundle` | Read-only v1 validation for settled staging or canonical source; no catalog lookup or writes. |
| Publish, retain, or resolve immutable skill snapshots | `resolve_skill_runtime_bundles`, `publish_skill_snapshots`, `resolve_retained_skill_snapshot_source`, `close_skill_snapshot_references` | Owner-resolved complete bundles, content-addressed snapshots, stable active/closed references, and zero-write resolution of an owner-controlled retained runtime source. |
| Inspect or explicitly delete snapshots | `plan_skill_snapshot_deletion`, then `delete_skill_snapshot` | Reports all affected projects/references; deletion requires the fresh impact digest and is never automatic. |
| Model-class/config health | `list_model_classes` | Reports capability classes, configuration migration state, and one-shot health. |
| Durable-run adapter compatibility | `get_run_contract` | Check `contract_name`, `contract_version`, terminal/non-terminal statuses, and capabilities before launching command-mode adapters; fail closed when incompatible. |
| Runtime/build/source readiness | `get_runtime_readiness`; or `npm run runtime:readiness` before MCP launch | Use the script when a caller needs to prove the built server entrypoint can launch. It reports typed blocks such as `missing_build`, `stale_build`, `dirty_source`, `source_state_unknown`, `incompatible_contract`, `loaded_release_mismatch`, and `runtime_launch_failure`. |

## Requirements

- Node.js `>=22.19.0`
- npm, using the committed `package-lock.json`
- Pi-compatible model/auth configuration visible to the MCP process
- For `effect_profile:"workspace_read_only"` and the bounded Researcher/AJ profiles, a valid `pi-search-hub` package at `<resolved Pi agent dir>/npm/node_modules/pi-search-hub`; this repository does not install that explicit provider

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

Use model classes instead of concrete model IDs. The default class is `C`; callers may pass `model_class` when a specific capability tier or external expert perspective matters. Classes `Z1` through `Z5` are independent OpenRouter-backed external expert classes for maximum-difficulty work. Concrete model and `thinking_level` selection is internal calibration and is not part of the public MCP contract.

Using `Z1` through `Z5` requires authenticated OpenRouter access in the Pi process. Run the class-specific health probe before relying on an external expert for one-shot work.

| Class | Use when |
| --- | --- |
| `A` | Narrow, low-risk read-only probes. |
| `B` | Simple coding, review, or search with limited ambiguity. |
| `C` | Default for bounded implementation and ordinary repo-grounded reasoning. |
| `D` | Complex multi-file debugging, planning, or synthesis. |
| `E` | Highest-difficulty work requiring the deepest technical judgment. |
| `Z1` | External expert for maximum-difficulty work requiring an independent frontier-model perspective. |
| `Z2` | External expert for maximum-difficulty work requiring an independent technical perspective. |
| `Z3` | External expert for maximum-difficulty work requiring deep synthesis and independent judgment. |
| `Z4` | External expert for maximum-difficulty work requiring an independent frontier-model perspective. |
| `Z5` | External expert for maximum-difficulty work requiring the deepest independent synthesis. |

Run `npm run models:reconcile` to compare calibrated concrete models with fresh source data from `pi --list-models`, OpenRouter `GET /api/v1/models`, and local Ollama `GET /api/tags`. The command exits nonzero when a calibrated model is missing or has drifted from a source; unavailable sources are reported as unverified instead of drift. Inventory reconciliation is separate from one-shot health.

Run `npm run model-health:probe -- --model-class C --cwd /absolute/project/path` to record whether a class is usable for the `run_subagent` one-shot surface. The health file defaults to `~/.codex/subagent007-pi/model-health.json` and can be overridden with `SUBAGENT007_MODEL_HEALTH_PATH`; an unhealthy probe exits nonzero after writing its record. Unknown health is reported with `health_basis:"never_probed"` and does not block execution; cached probe results use `health_basis:"cached_probe"`. The health gate is `blocks_only_known_unhealthy`: only known unhealthy one-shot health fails `run_subagent` before the child process starts. Each health view includes `health_action` with the exact probe command to refresh that model class.

Run `npm run config:migrate` to canonicalize `default_model_class` or migrate a legacy `default_model` plus `default_thinking_level` pair when it exactly matches a known class calibration. The command honors `SUBAGENT007_CONFIG_PATH`, writes atomically, preserves unknown fields, and is not run automatically by server startup or model-class listing.

`list_model_classes` reports the configured default class, effective default class, whether migration is needed, and one-shot health for each class. Legacy public `model` and `thinking_level` inputs are rejected; use `model_class`.

## Register With Codex

Register directly when Pi auth keys are available to ordinary child processes:

```sh
npm run build
SERVER_PATH="$(pwd)/dist/server.js"
npm run runtime:readiness -- --source-state-policy allow_dirty --expected-contract-name subagent007.durable_run --expected-contract-version 3
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

- `model_class`: capability tier `A` through `E`, or external expert class `Z1` through `Z5`; omit for configured `default_model_class` or `C`; concrete `model` and `thinking_level` are unsupported
- `skill_name`: bare skill name only, such as `pda-lite` or `google-drive:google-docs`; null or omission means no skill
- `output_mode`: `final` or `transcript`; default is `final`; use `transcript` for debugging or audit trails

Opt-in effect and skill-identity fields are accepted only by `run_subagent`, `start_run`, and `schedule_run`. They are independent; a skill digest may be pinned without selecting an effect profile.

- `system_skill_name`: canonical bare catalogue name for one governing system-level skill. It must differ from ordinary `skill_name` and is rejected with `effect_profile` because this mode preserves ambient tools. Pi keeps its base/project instructions and ambient tools, loads the normal Subagent007 specialist catalogue minus only this governing entry, and appends the current canonical body through the last inline `before_agent_start` handler. Raw fresh/resume launches reread current source; no governing prompt snapshot, generated copy, or version ledger is created. Named-session APIs do not support this field.
- `recursive_edge_witness: "prompt_sha256_v1"`: requires `recursive_delegation:"enabled"`; exposes a public digest/UTF-8 byte-count witness on each descendant edge and inherits outside the model-facing `delegate` schema. Named-session APIs do not support this field.

- `effect_profile: "workspace_read_only"`: creates the Pi session with exactly `read`, `grep`, `find`, `ls`, `web_search`, `web_read`, and `request_input`; ambient project/global extensions and recursive `delegate` are excluded
- `effect_profile: "task_root_authoring_v1"`: neutral builder profile with exactly ordered `read`, `write`; it requires `allowed_output_paths`, a UTF-8 byte-sorted list of unique, nonoverlapping canonical absolute paths for new required files beneath the exact real run `cwd`. Reads remain beneath that task root plus an explicitly validated immutable snapshot runtime root when bound; writes are confined to the exact declared files. Empty `allowed_output_paths` means no task-root write is legal. Ambient extensions, edit/search/list/shell/web/input tools, and recursive `delegate` are excluded.
- `effect_profile: "skill_creator_authoring_v1"`: creates the Pi session with exactly `read`, `grep`, `find`, `ls`, `write`, and `edit`; ambient extensions, general shell, caller-input/web tools, and recursive `delegate` are excluded. Writes/edits are guarded to the exact real run `cwd`; read/list/find/grep also receive the exact active immutable snapshot runtime root only for a validated `skill_snapshot_binding`, and use bounded requests.
- `effect_profile: "researcher_bounded_v1"`: requires canonical `skill_name:"researcher"` plus an active immutable complete-runtime snapshot binding, and supports only ephemeral/fresh continuity. Its exact ordered tools are `read`, `grep`, `find`, `ls`, `write`, `edit`, `web_search`, `web_read`, `researchctl`; no shell, input, delegate, ambient extension, installer, credential, or caller-chosen executable is available. The native controller exposes read-only `state-paths`, which returns the exact bound `job_path` and `input_root` without creating state. The first exact serialized `researchctl init` validates that canonical binding-derived path pair, creates or admits only their real directory chain, and establishes the exact `input_root` before invoking the unchanged snapshot controller.
- `effect_profile: "assumption_audit_bounded_v1"`: requires canonical `skill_name:"assumption-judge"` plus an active immutable complete-runtime snapshot binding, and supports only ephemeral/fresh continuity. Its exact ordered tools are `read`, `grep`, `find`, `ls`, `write`, `edit`, `web_search`, `web_read`, `aj_switchboard`; no shell, input, delegate, ambient extension, installer, credential, or caller-chosen executable is available.
- Both bounded profiles resolve `cwd` to the exact task-root realpath and require their profile-owned state root to be absent in both parent and child pre-prompt capture. Researcher controller state remains under `.subagent007/researcher_bounded_v1`, but model-visible `write`/`edit` is narrower: it may create payloads only beneath the exact controller-returned `input_root`; `job.json` and dispatch accounting remain controller/runtime-owned. Inside the shared Researcher controller queue, exact `init` binds `argv[0]` to the canonical returned `job_path`, captures and rechecks the real state/input directory identities before controller execution and after successful exit, and requires a canonical regular single-link `job.json` plus the exact writable input closure. Nonzero exit, timeout, or failed postcondition remains an honest failure with no provider retry, deletion, rollback, or synthetic success. AJ direct and controller mutations remain within `.subagent007/assumption_audit_bounded_v1`. Validated read-only controller arguments may reference task-root inputs outside those writable boundaries, and everything initially present outside the state root is immutable. The controller tools invoke one parent-bound resolved absolute `python3` realpath with `execFile`, recheck its file SHA-256 and fixed runtime imports in parent and child, and pass only the exact snapshot `scripts/researchctl.py`/`scripts/aj.py`, closed subcommands, and bounded argv/JSON/stdout/stderr/time. Researcher activation receipt v4 binds `researchctl_state_paths_v1` and `researchctl_strict_v2`: model-visible `researchctl` excludes `claim-dispatch` and `record-dispatch-result`; a non-registerable runtime adapter claims each top-level `web_search`/`web_read` against one exact reservation before provider execution and records its result afterward through the shared serialized controller queue. AJ remains on bounded activation receipt v2. Both receipts bind the explicit web provider plus a combined SHA-256 of the fixed wrapper, exact snapshot script, and resolved Python realpath/file SHA-256. URLs are data, not executable paths. This is a Pi callable-tool/path/controller/terminal-reinspection boundary, not an OS sandbox or hostile-runtime claim.
- Interpreter admission has no caller-specific override: before launch only, the parent visits inherited `PATH` `python3` candidates left-to-right, canonicalizes each candidate to its realpath, and accepts the first executable that can import the profile-owned fixed requirements in the controller environment (`json` for Researcher; `json` and `yaml` for AJ). It binds that exact realpath and file SHA-256; the child repeats identity and import checks and never performs a `PATH` lookup or substitutes another interpreter at controller execution time. If no candidate passes, AJ fails closed before child launch with `reason_code:"effect_profile_activation_failed"`. The explicit web provider is resolved from the Pi agent directory, whose precedence is `SUBAGENT007_PI_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.
- `expected_skill_sha256`: optional lowercase SHA-256 content pin paired with canonical `skill_name`; the parent rejects a source mismatch before child launch, and the child rejects a snapshot mismatch before prompt submission
- `skill_snapshot_binding`: owner-issued immutable complete-runtime snapshot binding paired with canonical `skill_name`; mutually exclusive with `expected_skill_sha256`
- `allowed_output_paths`: required only with `task_root_authoring_v1`; exact canonical new file paths, included in `client_start_id` request identity. Subagent007 does not accept or interpret a caller's semantic input/output manifest.

Child-invocation input rules:

| Tool | Required beyond `cwd`/`prompt` | Accepted fields beyond common inputs | Rejected fields |
| --- | --- | --- | --- |
| `run_subagent` | `run_kind: "quick_noninteractive"` | `continuity`, `effect_profile`, `allowed_output_paths`, `expected_skill_sha256`, `skill_snapshot_binding`, `recursive_delegation`, `recursive_edge_witness`, `system_skill_name` | `timeout_ms`, top-level `session_id` |
| `schedule_run` | none | `continuity`, `timeout_ms`, `wait_ms`, `effect_profile`, `allowed_output_paths`, `expected_skill_sha256`, `skill_snapshot_binding`, `recursive_delegation`, `recursive_edge_witness`, `system_skill_name` | top-level `session_id` |
| `start_run` | none | `continuity`, `timeout_ms`, `effect_profile`, `allowed_output_paths`, `expected_skill_sha256`, `skill_snapshot_binding`, `recursive_delegation`, `recursive_edge_witness`, `system_skill_name`, `client_start_id` | top-level `session_id` |
| `start_session_run` | `session_key` | `resume_mode`, `packet_policy`, `timeout_ms` | `continuity`, top-level `session_id`, `effect_profile`, `allowed_output_paths`, `expected_skill_sha256`, `skill_snapshot_binding`, `recursive_delegation`, `recursive_edge_witness`, `system_skill_name` |
| `run_subagent_session` | `session_key` | `resume_mode`, `packet_policy`, `timeout_ms` | `continuity`, top-level `session_id`, `effect_profile`, `allowed_output_paths`, `expected_skill_sha256`, `skill_snapshot_binding`, `recursive_delegation`, `recursive_edge_witness`, `system_skill_name` |

Run-control operation tools do not accept `cwd` or `prompt`: `get_run` requires `run_id` and optionally accepts nonnegative integer `wait_ms`; `cancel_run` takes `run_id`; `answer_run_input` requires `run_id`, `request_id`, `response_id`, and `answer`. A successful receipt means the child-side waiter accepted that exact response. During a live run, an exact retry returns the prior receipt without redelivery; a changed answer under the same response identity is rejected. The separate read-only `verify_skill_bindings` and `resolve_skill_bindings` operations accept `cwd` but no prompt.

`verify_skill_bindings` is a separate version-1 read-only operation for callers that must validate canonical skill identity before publishing work. It accepts a strict object with `contract_version:1`, an absolute `cwd`, and 1–64 unique bindings strictly ASCII-sorted by `skill_name`; each binding contains only canonical `skill_name` and lowercase `expected_skill_sha256`. It invokes no model or child and creates no run, session, admission record, snapshot, lease, event, temporary artifact, cache, or failure-log record. Success is all-or-nothing and returns the canonical resolved path and SHA-256 for every binding. Semantic failures use `skill_not_found`, `skill_ambiguous`, `skill_unreadable`, `skill_content_mismatch`, `cwd_not_absolute`, `cwd_inaccessible`, or `cwd_not_directory` without returning partial bindings. Every `skill_*` rejection includes `failed_binding` with its zero-based canonical-array `index`, `skill_name`, and `expected_skill_sha256`; every `cwd_*` rejection omits `failed_binding` because no binding was evaluated. Malformed version, shape, count, order, duplicates, names, and digests are standard MCP input errors.

`resolve_skill_bindings` is the distinct version-1 authority for hashless semantic drafts. Its strict request is `{contract_version:1,cwd,skill_names}` with 1–64 unique canonical names in strict ASCII order. Success returns all requested `{skill_name,resolved_skill_path,resolved_skill_sha256}` entries and binds the full request with `cwd`, `count`, and a domain-separated `canonical_request_sha256`. Cwd failures omit `failed_skill`; `skill_not_found`, `skill_ambiguous`, and `skill_unreadable` include the exact zero-based `{index,skill_name}`. It has the same no-model, no-child, no-operational-write and point-in-time limits as verification; launch remains the authoritative drift recheck.

Every version-1 response binds the complete request through `request_binding.cwd`, `request_binding.count`, and lowercase `request_binding.canonical_request_sha256`. For verification, compute SHA-256 over the UTF-8 bytes of `subagent007.skill_binding_verification.request.v1\n` followed immediately by `JSON.stringify({contract_version:1,cwd,bindings})`. For resolution, use `subagent007.skill_binding_resolution.request.v1\n` followed by `JSON.stringify({contract_version:1,cwd,skill_names})`. Preserve the shown object-key order and the required canonical array order. Both operations are point-in-time only; callers must retain the launch-time digest recheck rather than caching either result as durable authority.

### Complete runtime bundles and immutable snapshots

The canonical digest is `subagent007.skill_runtime_bundle.sha256.v1`. It frames every admitted file by ASCII-sorted normalized relative path, executable bit, byte length, and exact bytes. The closure admits `SKILL.md`, root `license.txt`, plus runtime files under `agents/`, `assets/`, `references/`, `scripts/`, and `templates/`; symlinks, unsafe paths, and other unrecognized runtime roots reject. Hidden, test, eval, fixture, coverage, cache, and package-manager residue is excluded structurally. The default ceiling is 4,096 files and 128 MiB.

`validate_skill_runtime_bundle` validates one exact root without consulting the installed catalog:

```json
{"contract_version":1,"bundle_root":"/absolute/exact/root","expected_skill_name":"canonical-name"}
```

The root must be canonical and absolute. Settled creator staging and the copied canonical `skills/<name>` source are both valid; creator/projector flows must validate again after copying. Success is `kind:"skill_runtime_bundle_validated"` under `subagent007.skill_runtime_bundle_validation` v1 and returns `request_binding`, `skill_name`, owner `source_identity`, `bundle_sha256`, and complete `runtime_closure`. Rejection is `kind:"skill_runtime_bundle_validation_rejected"`, `validated:false`, `child_started:false`, and `model_invoked:false`, with `bundle_root_not_canonical_absolute`, `invalid_expected_skill_name`, `skill_runtime_bundle_name_mismatch`, `skill_runtime_bundle_metadata_invalid`, or a canonical `runtime_bundle_*` reason. The operation invokes no child/model and creates no state or temporary artifact.

`resolve_skill_runtime_bundles` is the catalog-resolving counterpart. Its strict `{contract_version:1,cwd,skill_names}` request accepts 1–64 unique ASCII-sorted names, performs one catalog load, and returns all-or-nothing source identity, closure evidence, and digest. It is read-only point-in-time freshness evidence, not executable identity.

`publish_skill_snapshots` accepts an absolute `cwd`, 1–64 sorted `{skill_name,expected_bundle_sha256}` bindings, and:

```json
{"project_id":"stable-project-id","publication_id":"persisted-route-command-id","lifecycle":"active"}
```

For a settled staged candidate that is not yet catalogue-visible, one binding may additionally carry `source_root`. It must be the canonical real directory of that exact bundle under `cwd`; symlinked, escaping, name-mismatched, or digest-mismatched roots reject before materialization. Omitting `source_root` preserves catalogue resolution. Both forms enter the same capture, content-addressed snapshot, reference, receipt, activation, and retention path.

`publication_id` is the stable Bendum command/publication identity persisted before the owner call. Crash retries must reuse it; it is deliberately not a later manifest hash or an unpersisted timestamp. One owner-durable claim binds `(project_id,publication_id)` to the complete canonical request and prepared snapshot set. Exact pending/committed replay resumes or returns that claim even after mutable source disappears; any different request under the same identity rejects as `publication_identity_conflict`. Any unknown, ambiguous, unreadable, changed, unsafe, incomplete, or mismatched new binding rejects without partial result bindings. Operational publication failure uses `snapshot_materialization_failed`.

Success is `subagent007.skill_snapshot_publication` v1, `kind:"skill_snapshots_published"`. Each binding returns owner `source_identity`; `{schema_version,snapshot_id,snapshot_path,metadata_sha256}` snapshot identity; bundle digest and full closure; and a publication receipt with `schema_version`, exact project reference, stable `reference_id`, and `receipt_sha256`. Snapshots default to `~/.codex/subagent007-pi/skill-snapshots` and may be relocated with `SUBAGENT007_SKILL_SNAPSHOTS_DIR`. Exact bytes are atomically materialized at `bundles/<snapshot_id>` and revalidated. Later source edits affect only future publications; concurrent projects may retain different versions.

Publication registers references as active. Project finalization calls:

```json
{"contract_version":1,"project_id":"stable-project-id","publication_id":"persisted-route-command-id","snapshot_ids":["<sorted snapshot id>"]}
```

`close_skill_snapshot_references` is `subagent007.skill_snapshot_reference_lifecycle` v1. `snapshot_ids` must exactly equal the complete committed publication set. It validates that set before mutation, idempotently changes active references to closed, preserves snapshot and `reference_id`, and returns request binding plus deterministic `closure_receipt`. Closed references remain retained and deletion-visible.

`resolve_retained_skill_snapshot_source` is the public `subagent007.skill_snapshot_source_resolution` v1 owner. It accepts one exact publication-issued `snapshot_binding` and canonical `skill_name`, resolves only the owner-controlled content-addressed immutable runtime source, and accepts active or closed retained references from a committed publication. It validates the exact runtime closure, immutable identity, and committed publication/reference membership, then returns existing source, snapshot, bundle, and runtime-closure identities plus current retained-reference lifecycle. It has no caller-selected destination, staging root, or private-store input and performs no copy, lock, cache, or other filesystem mutation. The result is point-in-time evidence; a consumer that copies the bytes must revalidate its copy inside its own transaction. Internal content-addressed bundle materialization remains part of publication ownership, while the former caller-path rollback staging operation is retired. Closure and impact-confirmed deletion remain separate operations.

`plan_skill_snapshot_deletion` reports every affected project lifecycle and exact reference (`reference_id`, skill, snapshot/bundle, publication request, and project/publication identity), bound by `impact_sha256`. `delete_skill_snapshot` recomputes under the snapshot lock and deletes only when `confirm_impact_sha256` exactly matches. Automatic garbage collection is disabled; active and closed references block unconfirmed deletion. This separate private MCP tool is the explicit administrative deletion boundary.

Launches pair canonical `skill_name` with:

```json
{
  "contract_version":1,
  "snapshot_id":"<64 lowercase hex>",
  "metadata_sha256":"<64 lowercase hex>",
  "publication_receipt_sha256":"<64 lowercase hex>",
  "reference_id":"<64 lowercase hex>",
  "project_id":"stable-project-id",
  "publication_id":"persisted-route-command-id"
}
```

The parent derives the path and validates the complete immutable closure and active reference before run registration/child launch, then revalidates at execution. The Pi child independently revalidates before prompt submission and emits `subagent007.skill_snapshot_activation_confirmed`. Strict `skill_snapshot_activation_receipt` fields are `schema_version`, `confirmed_before_prompt`, `skill_name`, `snapshot_id`, `metadata_sha256`, `bundle_sha256`, `publication_receipt_sha256`, `reference_id`, `project_id`, `publication_id`, `resolved_skill_path`, and `runtime_closure_sha256`. Missing, altered, incomplete, mismatched, closed, or unreceipted snapshots fail before prompt with typed `skill_snapshot_*` reasons.

Snapshot bindings support `run_subagent`, `start_run`, and `schedule_run` with ephemeral, fresh, and raw-resume continuity; raw resume still requires recursive-delegation reauthorization. Named sessions reject them. Enabled descendants inherit only the confirmed ancestor snapshot binding and cannot widen to another skill. All effect profiles exclude delegation. This is owner filesystem integrity plus Pi pre-prompt enforcement, not an OS sandbox or hostile-runtime claim.

The older `expected_skill_sha256` source-file pin remains only as the currently sponsored Bendum migration seam; it is not complete-bundle or immutable-snapshot evidence. New Project Mode publication and launch integrations must consume owner-issued bundle/snapshot identities and activation receipts.

For raw Pi `continuity`, use `mode: "ephemeral"`, `mode: "fresh"`, or `mode: "resume"` with absolute `continuity.session_id`. Resume session ids must point to an existing, readable, nonempty session file. The session file does not retain `effect_profile`; send the profile on every constrained resume invocation. Prefer named sessions for unconstrained durable project work; named-session APIs do not accept the constrained profile.

When `effect_profile` is omitted, installed Pi extension/MCP tools remain active. Recursive `delegate` is separate: `recursive_delegation` defaults to `disabled` and must be explicitly `enabled`. Legacy startup still fails if `web_search` or `web_read` is unavailable from the registered Pi tools. Subagent007 does not import Codex MCP registrations; install legacy capabilities in the Pi environment.

`effect_profile:"workspace_read_only"` is an additive fail-closed exception. Before the first prompt, Subagent007 disables ambient project/global extension discovery, explicitly loads `pi-search-hub` from the resolved Pi agent directory, constructs the Pi session with the exact seven-tool allowlist, verifies the active tool set, and emits `subagent007.activation_confirmed`. `web_search`, `web_read`, and `request_input` each have a provider identity and implementation SHA-256 in `activation_receipt.tool_bindings`; missing providers, missing receipts, conflicting toolsets, or digest-shape failures produce `reason_code:"effect_profile_activation_failed"`.

`effect_profile:"skill_creator_authoring_v1"` is the opt-in Skill Creator packaging profile. Before the first prompt, it disables ambient extension discovery, constructs Pi with only `read`, `grep`, `find`, `ls`, `write`, and `edit`, and overrides those filesystem tools with dispatch-time guards. `write` and `edit` reject lexical escapes and resolved symlink escapes outside the exact real run `cwd`. `read`, `grep`, `find`, and `ls` have that same task-root scope plus, only on a validated active `skill_snapshot_binding`, the exact real immutable runtime root derived from the revalidated snapshot `SKILL.md`; relative sidecars such as `references/guide.md` resolve there only when absent from the task root. Source-pinned and unbound launches receive no additional read root. Read is capped at 2,000 requested lines; find/grep/list are capped at 200 results; grep context is capped at 50 lines. It provides no general shell, no recursive delegation, no web/caller-input capability, and no ambient extension capability. The receipt precedes `child_prompt_submitted` and is copied into active/terminal durable views. Enforcement is Pi callable-tool dispatch plus these path guards; it does not claim an OS sandbox or hostile-runtime containment.

Activation receipt schema `1` remains strict for `workspace_read_only`, historical `skill_creator_authoring_v1`, and digest-only activation. Its exact top-level fields are `schema_version`, `confirmed_before_prompt`, `requested_effect_profile`, `resolved_effect_profile`, `active_tool_names`, `tool_bindings`, `toolset_sha256`, and `skill_binding`. Neutral `task_root_authoring_v1` and AJ use strict schema `2`, adding only `effect_scope_binding`. Researcher live ingress requires exact schema `4`, which also adds `controller_state_discovery:"researchctl_state_paths_v1"` and `controller_protocol:"researchctl_strict_v2"`; exact historical schema `3` is accepted only when validating already-durable projections and is never produced, coerced, or upgraded. The effect-scope binding proves the exact task-root path/device/inode, profile, disabled recursion, bounded initial immutable-tree SHA-256, exact writable scope, mandatory terminal reinspection, and the honest `pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox` claim ceiling. Parent and child compare the exact binding before prompt. Terminal reinspection runs after every settled child result—including failure, timeout, cancellation, and resource exhaustion—without replacing the primary status or `stop_reason`; detected drift is surfaced as `reason_code:"authoring_effect_scope_drift"`.

Initial immutable inputs are limited to 128 regular files, 64 MiB per file, and 128 MiB total. Sparse and multi-link regular files reject. Writable closure is separately limited to 16 MiB per file and 32 MiB aggregate; sparse, symlinked, special, or multi-link outputs/state reject. Neutral closure requires every declared output and no undeclared task-root entry while preserving every initial file/directory identity and byte digest. Bounded closure permits only run-created state in the one fixed subtree and preserves everything outside it. These guarantees apply to Subagent007-owned Pi tool dispatch, paths, controllers, and terminal observation; they are not an OS sandbox against arbitrary native code.

`system_skill_name` uses that same canonical catalogue authority. In this opt-in mode the governing entry is excluded from specialist discovery while every other catalogue skill remains model-discoverable and fully readable; an optional different `skill_name` still expands as the ordinary user-level specialist invocation. For a governed recursive lineage, the root's resolved model class is private inherited control data: the model-facing `delegate` schema omits `model_class`, the server rejects a governed selector or forged class context, and every descendant launches with that root class. Existing unguided recursive delegation retains its `model_class` selector. Recursive descendants inherit the governing name through the same private caller context. The child emits `subagent007.system_skill_activation_confirmed` before `child_prompt_submitted`; `system_skill_activation_receipt` reports the governing name, canonical source path, current body SHA-256, final Pi system-prompt SHA-256, exactly one body occurrence, suffix placement `after_all_other_before_agent_start_handlers`, and the explicit observation ceiling `pi_system_prompt_after_before_agent_start_not_provider_payload_or_model_obedience`. Missing or invalid confirmation fails as `system_skill_activation_failed`. This witnesses host composition only—not later `before_provider_request` payload rewrites, provider serialization, or model obedience.

`skill_name` must resolve to exactly one bare skill name before model invocation. Configured skill roots include their platform-owned `.system` child roots (for example `~/.codex/skills/.system/skill-creator`) explicitly because Pi skips dot-directories during recursive discovery; the same canonical bare-name resolver preserves ambiguity failures. Unknown, ambiguous, prompt-syntax, markdown, prose, and path forms reject with `child_started:false`; terminal metadata records the resolved path and content hash. When `expected_skill_sha256` is supplied, Subagent007 compares it with the resolved `SKILL.md` content before launch, gives Pi a run-owned read-only snapshot of those bytes, and the child re-verifies that snapshot before prompt submission. A mismatch fails closed as `skill_content_mismatch`; a match is included under `activation_receipt.skill_binding`, whose path remains the canonical source path rather than the private snapshot.

Result semantics:

- `get_runtime_readiness` returns the concrete runtime snapshot from inside the running MCP server: resolved project root, server entrypoint, build/dist facts, loaded/current versioned-release identities when applicable, git/source facts, durable-run contract compatibility, and public tool/capability surface. For pre-launch checks, use `npm run runtime:readiness`; it verifies `dist/server.js` exists before launching MCP, then calls `get_runtime_readiness`. A blocked result includes `status:"blocked"`, `ready:false`, and machine-readable `blocks[].class`. A live versioned process whose `build.loaded_release` differs from `build.current_release` is blocked with `class:"loaded_release_mismatch"` and `reason_code:"loaded_release_not_current"`; its release identities come from the loaded server module and `dist/current`, not the stable launcher bytes.
  The default source policy is `require_clean`, which blocks dirty or unknown git state; `allow_dirty` permits dirty checkouts while still blocking unknown source state, and `allow_unknown` permits both dirty and unknown source state for package-style or exploratory probes.
- `get_run_contract` is durable-run contract version `3`. A caller may omit `client_start_id` on convenience launches, but that is current v3 behavior, not a v2 persisted-record reader or compatibility promise. The contract retains the creator-named profile unchanged and advertises `task_root_authoring_v1_effect_profile`, `authoring_effect_scope_binding`, `idempotent_start_by_client_id`, `retained_skill_snapshot_source_resolution`, and `event_driven_get_run_wait`. Its `observation` facts define immediate omission/zero semantics, actionable return statuses, the shared wait cap, and the nonresident immediate-snapshot ceiling. Version-gating callers must update their expected contract version and require only the capabilities they use.
- Terminal child output has exactly one provider-issued primary `output_references` entry and may add one `{name:"packet"}` entry; both otherwise use `{kind:"file",relative_path,size_bytes,content_sha256,content_type:"text/markdown",encoding:"utf-8",output_mode}`. `relative_path` is one canonical provider basename beneath the configured runs root; it is never absolute, nested, dotted, or traversal-bearing. `content_sha256` is 64 lowercase hex and identifies the exact finalized bytes. There is no public top-level `output_path` or reference `path`. Terminal final documents and transcripts are capped at 1 MiB each. Strict Researcher success ignores model closing prose and instead requires controller validation plus byte-stable `primary` and Bendum `packet` renders from one unchanged complete job; one shared control-free byte projection feeds both receipt hashes and durable publication. Both documents are prepared and verified before publication, and the durable run owner records their exact private staging/public identities before the first rename. Terminal commit atomically replaces that private pending ownership with public references; failure or owner-loss reconciliation removes the recorded pair when cleanup succeeds and otherwise retains retryable durable ownership. Other requested `final` output succeeds only when a final message is captured. A clean child exit without the required final artifact fails with `reason_code:"missing_final_output"` and writes the public transcript only as diagnostic output; timeout, cancellation, disk-reserve termination, and other failures can also expose transcript output. Schema and preflight rejections do not create output artifacts.
- Failed, timed-out, restart-drift, and structured rejection views include `error_class` and `reason_code` when the server can classify the failure; adapters should branch on those fields instead of parsing `error`.
- Provider usage-limit failures use `reason_code:"usage_limit_reached"` and may include provider reset/retry fields such as `provider_status_code`, `provider_error_message`, `usage_limit_resets_in_seconds`, `usage_limit_retry_after_seconds`, and primary/secondary usage percentages. The same fields are copied to failure-log records.
- SDK input-schema errors—such as missing required fields, invalid enum values, or unrecognized inputs—return standard MCP `isError` responses before the server handler or child starts. They do not carry `kind:"preflight_rejected"` or `child_started`; correct the input and retry.
- Child-invocation preflight rejections return structured content with `kind:"preflight_rejected"`, `success:false`, and `child_started:false`; no child model work ran.
- Operation-only semantic rejections from `get_run`, `answer_run_input`, and `cancel_run` return structured content with `kind:"operation_rejected"`, `success:false`, and a typed `reason_code`; these views do not include `child_started` because the target run may already have launched.
- Skill-bound terminal results include `requested_skill`, `resolved_skill_path`, and `resolved_skill_sha256`; pinned runs also include `expected_skill_sha256` and the confirmed binding in `activation_receipt`; unbound runs use `null` for the skill audit fields. System-skill runs additionally include `requested_system_skill` and the narrow `system_skill_activation_receipt`.
- A strict Researcher v4 result includes the exact v2 `controller_terminal_receipt` only when the bounded job is controller state `complete`, uses `research_web_dispatch_v1`, the exact snapshot controller passes `validate`, and primary plus Bendum renders succeed without changing the job. One shared terminal-projection validator joins the receipt hashes to the correspondingly named finalized references on producer return and durable readback; list order is not evidence. A strict completed result requires that receipt and exactly one primary plus one packet. Failed, cancelled, or timed-out results may retain the same joined pair only when materialization succeeded; activation failure or non-complete controller state has no receipt or packet and keeps one diagnostic primary. Historical v3 durable projections admit exactly one primary and either no controller receipt or the exact weaker v1 receipt, whose render hash is not treated as an output join. Non-Researcher results admit neither controller receipts nor packet references. These are structural/projection guarantees, not proof that controller execution ran.
- `run_subagent`, `schedule_run`, `start_run`, `start_session_run`, and `run_subagent_session` create durable run-task snapshots inspectable with `get_run` by `run_id`.
- `recursive_delegation:"disabled"|"enabled"` is accepted only by `run_subagent`, `start_run`, and `schedule_run`; omission resolves `disabled`, raw resume requires explicit reauthorization each turn, and named-session schemas reject the field. `enabled` conflicts with either effect profile before launch. A strict `subagent007.recursive_delegation_confirmed` receipt precedes the prompt and reports requested/resolved authorization plus whether `delegate` is active. Enabled authority, any confirmed `system_skill_name`, and its root-resolved model class are inherited through the existing depth-bounded subtree and cannot be widened by a descendant; terminal results retain the existing `resolved_model_class` reporting. Root/ancestor views expose ordered `descendant_run_ids` and exact `descendant_terminal_statuses`; parent terminal publication waits for the subtree to settle.
- Optional `recursive_edge_witness:"prompt_sha256_v1"` requires enabled recursion and is inherited privately across the subtree; the model-facing `delegate` schema cannot select, disable, or widen it. Each non-root run then exposes `recursive_edge_prompt_witness` with the SHA-256 and UTF-8 byte count of the exact raw `delegate.prompt` received before host normalization or child-prompt composition. The witness adds no durable raw-prompt copy and makes no semantic or model-obedience claim. This public unsalted digest can reveal equality and enable guessing of low-entropy inputs; use it only for controlled prompts without secrets.
- Active `get_run` views expose sanitized `recent_events` and `last_public_output_excerpt`; internal partial-output locators are not public. Raw thinking, private tool payloads, backend Pi session IDs, internal mailbox/output paths, caller prompt text, full packet instructions, composed child prompts, and input answer values are not exposed in public event views. Callers address input through `run_id` and `request_id`, never a filesystem path. After a server restart, reconciliation safely finalizes an owned partial file into the failed run's diagnostic `output_references` instead of leaving an orphan.
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

`run_kind` asserts that work is bounded, non-interactive, and deadline-compatible. `run_subagent` does not infer workload breadth, duration, write intent, or routing from prompt text. Every valid request remains a synchronous one-shot and passes the one-shot health gate. Call `schedule_run` or `start_run` directly when work needs durable asynchronous execution, polling, cancellation, or caller input.

`run_subagent` rejects caller-provided `timeout_ms`. Its internal default deadline is 110 seconds and can be changed with `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`; every admitted request uses that bounded one-shot deadline. If it times out, use `schedule_run` or `start_run` for a new caller-authorized attempt when appropriate; use `schedule_run.wait_ms` for the initial wait and `timeout_ms` only for a real kill deadline. Inspect the original `run_id` with `get_run`.

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

`start_run` alone additionally accepts optional `client_start_id` (1–200 canonical identifier characters). This is an exact-attempt admission key, not a caller objective or retry-series identity. Subagent007 strictly schema-normalizes the start request, excludes only that key, orders object keys by deterministic byte/code-point order, and hashes the resulting canonical JSON. Before queue or child admission it atomically persists and fsyncs the unique key binding `{request_sha256,run_id}` inside the existing run-task store. Exact replay in the same or a later server process returns that run; reuse with any changed validated body rejects before child launch as `client_start_id_conflict`. If the execution-owner instance is gone, replay returns the owner-issued terminal `restart_drift` result for the same run rather than claiming reattachment. There is no lookup tool, objective ledger, retry controller, second run store, or duplicate child admission.

`schedule_run` creates the durable task before waiting. If the child completes or requests caller input within the effective wait window, it returns that state; otherwise it returns the active run view. Default `wait_ms` is 1000; set `wait_ms:0` to return the task handle immediately. The server caps the initial wait at 30000 ms by default and always includes:

- `requested_wait_ms`: the caller's requested wait
- `effective_wait_ms`: the wait the server actually used
- `wait_truncated`: true when the server shortened the requested wait

If `wait_truncated:true`, continue with `get_run` instead of retrying the same request.

Flow:

1. Call `schedule_run` or `start_run`.
2. Call `get_run` with the returned `run_id`; omit `wait_ms` for an immediate snapshot or provide a bounded positive value to wait for an actionable state.
3. If status is `input_required`, read `input_requests`.
4. Call `answer_run_input` with `run_id`, `request_id`, stable `response_id`, and `answer`; retain `input_response_receipt` for an exact idempotent retry.
5. Continue observing until status is `completed`, `failed`, `cancelled`, or `timed_out`, then validate the exact primary `output_references` entry plus any additive packet and read configured-runs-root/`relative_path`.

For a run resident in the serving owner process, positive `get_run.wait_ms` waits on authoritative resident-state publications and returns when status becomes `input_required` or terminal, or when the bounded window expires with the current truthful `working` snapshot. Heartbeats and progress publications may wake the internal condition check but are not themselves return states. The wait uses no interval or repeated `get_run` polling. It is capped by the same `SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS` ceiling used by `schedule_run` (30000 ms by default). Omitted or zero `wait_ms` preserves immediate snapshot semantics.

A nonresident/persisted run has no authoritative owner-record event stream in the observing process. Subagent007 therefore returns its current persisted snapshot immediately even when positive `wait_ms` was supplied; it does not poll the filesystem or claim cross-process live observation. A later call may observe newer persisted truth. `input_required` and every terminal status return immediately because they are already actionable.

After `cancel_run`, an in-flight cancellation reports `status:"working"` with `active_phase:"cancelling"`.
Continue polling until `status:"cancelled"` appears; that terminal view includes the settled cancellation metadata.

Active input requests are stored under `~/.codex/subagent007-pi/input-requests` by default. Each request has one terminal settlement: `answered`, `timed_out`, or `closed`. Multiple pending requests are legal; clients that auto-answer should do so only when exactly one request is pending and fail closed otherwise. Duplicate answers, stale request IDs, foreign request IDs, and late answers to closed or timed-out requests are rejected. A run serializes answer acceptance, cancellation, finalization, and pending-request closure; the first committed outcome wins. Cancelling a run or reaching any terminal run state closes remaining pending requests. After the authoritative terminal snapshot contains the settled input views, the run-owned mailbox directory is removed; `get_run` continues to return those canonical settled views.

`timeout_ms` is optional for `schedule_run`, `start_run`, `start_session_run`, and `run_subagent_session`; omit it unless the caller intentionally wants a hard kill deadline. When provided, it is a hard response-budget cap: the child process is stopped before that budget is exhausted so the MCP tool can return timeout metadata and any public transcript. Values must leave at least one millisecond of effective child runtime after configured response headroom, kill grace, and force grace are reserved. Timeout admission is purely numeric and does not inspect prompt meaning, breadth, length, skill binding, or write intent.

Run task snapshots and active public event ledgers are stored under `~/.codex/subagent007-pi/run-tasks` by default. Active runs expose progress fields, `active_phase`, `last_phase_at`, lifecycle fields such as `last_child_lifecycle_event`, no-output timing via `no_public_output_elapsed_ms`, and bounded public events immediately after task creation; `running_silent` means the child process has spawned or emitted status-only lifecycle events while the server is still waiting for first public child output. `status` reflects pending input immediately. Once a terminal snapshot is atomically persisted, it becomes the canonical bounded event/input view and the redundant per-run event ledger and mailbox directory are removed. Output artifacts and terminal snapshots remain durable, so terminal `run_subagent`, `schedule_run`, `start_run`, and session task snapshots can still be inspected by `get_run` after an MCP server restart. Startup reconciliation skips runs that still have a live child lease, so a second server cannot move another live owner's partial transcript. An unreadable legacy lease returns `kind:"operation_rejected"` with `reason_code:"run_liveness_unknown"` instead of claiming a specific run is live or terminalizing it. An ownerless run that was active during a restart is persisted as terminal `status:"failed"` with `error_class:"restart_drift"` and `reason_code:"server_restarted_active_run"` because the new server process cannot safely reattach to the old child process, while its bounded public event projection is preserved in the terminal snapshot. That terminal closes this attempt only; it neither authorizes a replacement attempt nor decides whether the caller's logical obligation is complete.

When the root explicitly enables recursive delegation, a child receives the native `delegate` tool. Its inputs intentionally cannot authorize or widen recursion; they contain `prompt` plus optional durable-run parameters, while inherited root authority and the server depth limit govern descendants. Depth and lineage rejections remain pre-launch and typed.

For controlled semantic-edge verification, opt the root into `recursive_edge_witness:"prompt_sha256_v1"`, freeze the exact UTF-8 child Task as a caller-owned artifact, and compare its ordinary SHA-256 and byte count with the child run's witness. The binding proves which raw Task bytes entered that recursive edge; it does not prove child comprehension, semantic narrowing, return consumption, or correct work.

The child-facing `delegate` has a different observation boundary from public `schedule_run`: a recursive child cannot poll with `get_run`. When `delegate.wait_ms` is omitted, the sequential tool call therefore requests up to 30000 ms for a terminal or input-required result, subject to any lower configured scheduler wait ceiling. Set `wait_ms:0` only for intentional parallel parent work; it returns the current run view immediately but does not detach ownership, and the parent cannot become terminal until the descendant subtree settles. Explicit positive waits retain their requested value before the existing server cap. `delegate.hard_timeout_ms` is the optional explicit authorization to terminate the descendant at that hard lifetime; omit it for no time-based termination. It maps to the durable run timeout mechanism and is not a response wait. If the bounded wait still returns `status:"working"`, the child must not claim an answer or repeat the same delegation, because this private tool currently has no polling operation.

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

The first successful run locks in `cwd` and the normalized skill binding from `skill_name`. Later runs with the same `session_key` must use the same real `cwd` and same normalized skill binding. Do not pass raw `continuity` or top-level `session_id` to named-session tools; named sessions derive Pi continuity from the manifest.

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

- Paths: `SUBAGENT007_CONFIG_PATH`, `SUBAGENT007_RUNS_DIR`, `SUBAGENT007_RUN_TASKS_DIR`, `SUBAGENT007_PI_RAW_SESSIONS_DIR`, `SUBAGENT007_SESSIONS_DIR`, `SUBAGENT007_INPUT_REQUESTS_DIR`, `SUBAGENT007_FAILURE_LOG_PATH`, `SUBAGENT007_MODEL_HEALTH_PATH`, `SUBAGENT007_ACTIVE_CHILDREN_DIR`, `SUBAGENT007_QUEUED_RUNS_DIR`, `SUBAGENT007_TEMP_DIR`, `SUBAGENT007_SKILL_SNAPSHOTS_DIR`
- Timeouts/progress/resources: `SUBAGENT007_INPUT_REQUEST_TIMEOUT_MS`, `SUBAGENT007_RUN_SUBAGENT_TIMEOUT_MS`, `SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS`, `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS`, `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS`, `SUBAGENT007_HEARTBEAT_INTERVAL_MS`, `SUBAGENT007_MIN_FREE_DISK_BYTES`
- Pi/runtime: `SUBAGENT007_PI_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `SUBAGENT007_PI_SKILL_PATHS`, `SUBAGENT007_PI_CHILD_PATH`, `SUBAGENT007_MAX_ACTIVE_CHILDREN`, `SUBAGENT007_MAX_QUEUED_RUNS`, `SUBAGENT007_MAX_RECURSION_DEPTH`
- Failure logging and campaigns: `SUBAGENT007_FAILURE_LOG=off`, `SUBAGENT007_FAILURE_STORAGE_MAX_BYTES`, `SUBAGENT007_BUILD_SHA`, `GIT_COMMIT`, `SUBAGENT007_RECORD_SOURCE`, `SUBAGENT007_CAMPAIGN_ID`, `SUBAGENT007_CAMPAIGN_LEDGER_PATH`, `SUBAGENT007_COVERAGE_MANIFEST_PATH`

`SUBAGENT007_PI_AGENT_DIR` wins over Pi's native `PI_CODING_AGENT_DIR`; otherwise the Pi agent directory defaults to `~/.pi/agent`. The resolved agent directory is used for Pi auth, custom models, settings/resources, and session behavior.
`SUBAGENT007_PI_CHILD_PATH` overrides the built child entrypoint and is intended for tests or controlled probes; do not set it for normal MCP use.

`SUBAGENT007_MAX_ACTIVE_CHILDREN` is the shared local execution ceiling and defaults to `24`. Top-level `start_run` and `schedule_run` requests above that ceiling enter a bounded owner-scoped queue and return `status:"working"`, `active_phase:"queued"`, `child_started:false`, and `queued_at`. Promotion adds `child_started_at` and `queue_wait_ms`; `timeout_ms` starts only after launch. `SUBAGENT007_MAX_QUEUED_RUNS` defaults to `96`; `0` disables queueing, and a full queue rejects before registration with `reason_code:"local_queue_exhausted"`. Queue tickets under `SUBAGENT007_QUEUED_RUNS_DIR` contain ownership metadata only, never prompts. One-shot, named-session, and recursive launches remain fail-fast with `local_capacity_exhausted` to preserve their contracts and avoid recursive deadlock. Setting `SUBAGENT007_MAX_ACTIVE_CHILDREN=0` disables both the execution ceiling and admission queue.

`SUBAGENT007_MIN_FREE_DISK_BYTES` protects host free space and defaults to 5 GiB. A run below the reserve rejects before child launch with `reason_code:"disk_reserve_exhausted"` and `child_started:false`; an active run checks the reserve once per second and terminates cleanly with `error_class:"resource_exhausted"` and the same reason code after publishing all public transcript content captured through that point. Durable-run and named-session failure logs preserve that classification even when process termination also produces a signal or nonzero exit. Set the reserve to `0` only when host-level disk protection is provided elsewhere.

Child stdout/stderr is projected directly into a sanitized `.partial` transcript in the durable runs directory with serialized, backpressured writes and a 1 MiB terminal-document ceiling. Normal execution does not create `subagent007-process-output-*` raw spools. One descriptor-level finalizer retains a no-follow single-link regular descriptor, captures an exact descriptor stat tuple before the rename boundary, requires it and the staging pathname to remain exact after the boundary hook, then renames. It captures post-rename `S0`, hashes exactly its bounded (at most 1 MiB) descriptor bytes with short-read rejection, requires exact stable `S1`, verifies the final pathname names `S1`, and only then emits the `S1` size/SHA-256 reference. Restart recovery uses that same bounded post-rename/final-path inspection. This is a point-in-time final-state witness; later mutation is recaptured by the caller from its configured runs root, not prevented by provider ceremony. Successful final-only output removes the redundant transcript staging file. Child-request/final-message scratch lives under `SUBAGENT007_TEMP_DIR` (default `~/.codex/subagent007-pi/tmp`), and server startup removes only owned directories whose recorded process is definitely gone.

`npm run build` compiles into a versioned release and atomically switches `dist/current`; stable JavaScript launchers remain present throughout publication and are reconciled to the exact published release set, so obsolete `.js` wrappers are removed while unrelated non-JavaScript operator files are preserved. Live servers lease their release, and build cleanup removes only inactive unleased releases while preserving the current and immediately previous release. `npm run clean:dist` now prunes inactive releases rather than deleting the live `dist/` entrypoints.

`SUBAGENT007_MAX_RECURSION_DEPTH` bounds child-to-child delegation depth; the default is 8 and `0` disables descendant launch. The parent server validates the private recursive control token and depth before scheduling a descendant run.

`SUBAGENT007_SCHEDULE_RUN_MAX_WAIT_MS` caps how long `schedule_run` or a resident positive-`wait_ms` `get_run` may keep the MCP call open; the default is 30000. Nonresident `get_run` observations return immediately instead of consuming that window. `SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS`, `SUBAGENT007_TIMEOUT_KILL_GRACE_MS`, and `SUBAGENT007_TIMEOUT_FORCE_GRACE_MS` reserve time inside caller-provided `timeout_ms` so the MCP server can terminate the child process and return metadata before the caller deadline. `SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS` can raise the mechanically accepted floor for timed tools. `SUBAGENT007_HEARTBEAT_INTERVAL_MS` controls active-run snapshot cadence and MCP progress notification cadence when the client provides a progress token.

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

Run the probe through `observed-campaign` for isolation. Direct probes require `SUBAGENT007_FAILURE_LOG_PATH` plus either `SUBAGENT007_RECORD_SOURCE=test` or `SUBAGENT007_CAMPAIGN_ID`; `SUBAGENT007_CAMPAIGN_LEDGER_PATH` selects the call-attempt ledger. Only that ledger proves MCP call-attempt coverage—`failures.jsonl` is handler/child failure telemetry. The probe defaults to `protocol-core`; `--profile full-current` covers the deterministic current surface defined in `scripts/observed-coverage-manifest.json`, including direct invocation of every public tool, batch/replay/conflict/deletion transitions for skill snapshots, active and terminal `client_start_id` replay, all three required-packet outcomes through both session entrypoints, and intermediate recursive lineage. Deterministic fake-child receipts prove protocol validation only, not real Pi activation or effect enforcement. For installed-Pi smoke evidence, leave `SUBAGENT007_PI_CHILD_PATH` unset and run `--profile live-current`; it is intentionally an integration smoke profile, not full edge coverage.

## Development

For repository work, read `AGENTS.md` and `.mex/ROUTER.md` first; they carry the current project rules and context map. In a fresh clone or new project-memory environment, run `mex setup` once before relying on `.mex/`. When README or project-memory facts change, run `mex sync` and `mex check`; use `mex log` for rationale future agents need.

```sh
npm run build
npm run typecheck
npm run docs:check
npm test
npm run models:reconcile
```

Run `npm run build` after changing `src/`; the registered MCP command uses `dist/server.js`. This private repository has no npm distribution contract: package metadata exposes no executable and its empty `files` allowlist keeps accidental tarballs inert. Use the built repository entrypoint directly.
Run `npm run docs:check` after changing README environment-variable docs, public model-class/internal-calibration guidance, `src/modelAllowlist.ts`, or runtime environment-variable handling in `src/` or `scripts/`; it fails when README leaks internal model IDs or environment-variable facts drift from source.
There is no lint script; use `npm run typecheck`, `npm run docs:check`, and `npm test` as the local gates.

Primary source boundaries:

- `src/server.ts` registers public MCP tools and preflight result shaping.
- `src/activeChildLease.ts` owns the shared active-child ceiling, bounded top-level admission queue, ticket-to-lease promotion, and abandoned-owner reconciliation.
- `src/runTask.ts` owns durable task state, immediate/event-driven observation views, cancellation, promotion, terminal-output ownership/reconciliation, and active-child lease release.
- `src/runSubagent.ts` owns the Pi child request-file contract, pre-launch skill hashing/snapshotting, result orchestration, timeout metadata, and provider error parsing.
- `src/output.ts` owns terminal artifact preparation, atomic publication, reference decoding, and pending-output cleanup; `src/terminalProjection.ts` validates the allowed relationship between activation class, controller receipt, and named output references.
- `src/toolProfile.ts` owns the constrained allowlist, explicit provider identities/digests, and activation receipt construction/validation.
- `src/authoringEffectScope.ts` owns initial-tree capture and terminal reinspection; `src/taskRootAuthoringTools.ts` enforces task-root read/write paths at Pi tool dispatch.
- `src/boundedController.ts` owns fixed Researcher/AJ controller execution and terminal materialization; `src/researchDispatchMediator.ts` owns strict Researcher reservation-to-web-dispatch accounting.
- `src/processRunner.ts` owns backpressured child output consumption and timeout/cancel/disk-reserve/parent-exit termination.
- `src/failureStorage.ts` owns locking, archival, the aggregate raw-byte budget, and whole-record compaction; `src/failureStorageWorker.ts` provides bounded asynchronous runtime writes.
- `src/session.ts` owns named-session manifests, packet policy, and local session locks.
- `src/skillBinding.ts` owns canonical skill-name validation and prompt-level specialist invocation rejection; `src/skillResources.ts` owns name-to-`SKILL.md` resolution and catalogue filtering; `src/systemSkill.ts` owns current-source governing-body composition and its narrow Pi system-prompt receipt.
- `src/skillVerification.ts` owns the versioned batch request digest and the shared skill-file read/hash/compare primitive used by both `verify_skill_bindings` and launch-time rechecks.
- `src/skillRuntimeBundle.ts` owns canonical admitted-closure capture and complete-bundle digesting; `src/skillRuntimeBundleValidation.ts` exposes exact-root read-only validation for staging and canonical source.
- `src/skillSnapshot.ts` owns public bundle resolution, publication, lifecycle, deletion, and activation contracts; `src/skillSnapshotStore.ts` owns materialization, durable references, locking, retention, and impact recomputation.
- `src/types.ts` is the public type/reason-code source; keep it synchronized with README and tests when public fields change.

Tests use `SUBAGENT007_PI_CHILD_PATH` to replace the real Pi child with a fake child process. Do not set it for normal MCP use. `npm test` runs bounded, process-isolated semantic targets in separate short runner-owned temporary roots. The default pool uses at most six workers, preserves two explicit dependency chains, and launches protected timing targets with bounded low-contention overlap capped at four active target processes rather than using a serial timing lane or waiting for the pool to finish. The run-owner suite remains one isolated target; its independent crash-cut subtests run concurrently within that target. Any explicit Subagent007 state, failure-ledger, or campaign-ledger path forces one worker and disables semantic splitting. On Unix, success or failure terminates processes whose command line is owned by the exact target root; every platform then removes the root. Unless explicitly overridden, config, run outputs, task snapshots, mailboxes, sessions, raw Pi sessions, model health, active-child leases, skill snapshots, scratch state, and the private failure ledger are scoped beneath that root. Each target ledger is fingerprinted before and after execution.
