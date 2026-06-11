# Full Coherent Revised SAF Set: Subagent007 MCP Server

Date: 2026-06-11
Repo: `/Users/rgalyavin/myApps/003-subagent007-pi`
Branch: `main`
Inputs:

- `reports/observed-real-use-horc-saf-campaign-2026-06-11-codex-current.md`
- `reports/selected-saf-adversarial-stress-test-2026-06-11-codex-current.md`

Status: repaired SAF set after adversarial classification. This is a design/repair artifact, not an implementation record.

## Repair Rule

The adversarial review found no pseudo-SAFs, but two selected SAFs were asymptotic. This revision tightens them into atomic forms and keeps the two True SAFs with implementation guardrails.

Definitions used here:

- **True SAF**: smallest sufficient change that resolves the HORC without hiding complexity elsewhere.
- **Asymptotic SAF**: directionally right but incomplete, overbuilt, indirect, or not perfectly irreducible.
- **Pseudo-SAF**: symptom fix or complexity displacement.

## Revised Set

| ID | HORC | Repaired SAF | Classification After Repair | Implementation Horizon |
| --- | --- | --- | --- | --- |
| R-SAF-1 | Active progress truth is coupled to public child output or delayed heartbeat. | Immediate running-silent snapshot after successful child spawn. | True SAF | Near-term patch |
| R-SAF-2 | Coverage names encode historical compatibility more strongly than present coverage semantics. | Make `all` mean `full-current`; make `all-bundled` explicit/deprecated or rejected. | True SAF if ambiguity is removed; asymptotic if warning-only compatibility remains. | Near-term patch |
| R-SAF-3 | One-shot workload suitability is a lexical heuristic standing in for work semantics. | Scheduler-first execution primitive: always create a durable task; sync-return only as a fast-completion optimization. | True SAF | Contract migration |
| R-SAF-4 | Model health is a sparse cache presented beside default selection without basis. | Add explicit health-basis/action fields to structured model-class output. | True SAF | Near-term patch |

## R-SAF-1: Immediate Running-Silent Snapshot

### HORC

Active task progress is not derived from child process liveness as a first-class state. It is derived from startup events, parsed public output, and scheduled heartbeat callbacks. When the child is alive but silent, `get_run` can keep reporting `active_phase:"awaiting_child_event"` and `last_progress_message:"child process starting"`.

### Repaired SAF

After the child process is successfully spawned, immediately write an active snapshot that represents the child as alive and running silently.

Minimal shape:

- Add or use a phase equivalent to `running_silent`.
- Set `last_progress_message` to `child process running; waiting for output`.
- Write the task snapshot immediately after this transition.
- Keep existing output parsing and heartbeat behavior unchanged.
- Do not add periodic synthetic public events as part of this SAF unless a separate long-silent-run trial proves a second defect.

### Why This Is A True SAF

The observed defect was the stale startup state before first output or first heartbeat. One post-spawn state transition is sufficient. Periodic synthetic liveness events were overbuilt for that specific defect.

### Rejected Pseudo-SAFs

- Lower heartbeat interval: reduces the stale window but does not remove the initial false state.
- Add documentation: explains the symptom but leaves the state untruthful.
- Append repeated text-only liveness events without phase semantics: creates noise without making the state model sharper.

### Acceptance Checks

- Start a fake child that stays silent for less than the heartbeat interval. `get_run` must show running/running-silent, not `awaiting_child_event`.
- The first public event history still includes `run_started` and `child_spawned`.
- No answer text, raw thinking, private tool payloads, or internal prompt scaffold appears in the active excerpt.
- Existing input-required, cancellation, timeout, and terminal projections still pass.

## R-SAF-2: Explicit Coverage Alias Semantics

### HORC

Coverage aliases preserve historical compatibility semantics even after current coverage profiles became more precise. In particular, `all` and `all-bundled` currently map to `protocol-core`, while `full-current` is the deterministic current-surface profile. The word `all` therefore carries a false operator implication.

### Repaired SAF

Make ambiguous aliases stop behaving ambiguously.

Minimal shape:

- Remap `all` to `full-current`.
- Do not keep `all-bundled` as a normal silent alias.
- Choose one explicit treatment for `all-bundled`:
  - reject it with guidance: `use --profile protocol-core for bundled protocol-core coverage`; or
  - keep it temporarily but emit both a stderr warning and structured output such as `deprecated_alias:true`, `alias_target:"protocol-core"`, and `canonical_profile:"protocol-core"`.

### Why This Is A True SAF Only In The Tightened Form

The original selected SAF was asymptotic because a warning-only `all-bundled` alias still preserved the contradiction. The repaired version removes or machine-labels the ambiguity at the command semantic boundary.

### Rejected Pseudo-SAFs

- Usage text only: users can still run the misleading command.
- Rename `full-current`: does not change the misleading alias.
- Keep `all` mapped to `protocol-core` and rely on summary output: the error has already happened.

### Acceptance Checks

- `--scenario all` reports `scenario_set:"full-current"` and covers all deterministic current required surfaces.
- `--profile all` reports canonical `profile:"full-current"`.
- `all-bundled` either fails with targeted guidance or returns structured deprecation metadata.
- README and tests no longer state that `all` maps to `protocol-core`.

## R-SAF-3: Scheduler-First Execution Primitive

### HORC

One-shot suitability is currently approximated by lexical preflight rules. The server knows `run_subagent` requires quick, bounded, noninteractive work, but a prompt-string classifier cannot perfectly distinguish workload semantics. It will always risk false positives and false negatives.

### Repaired SAF

Replace caller-selected sync/async routing as the primary primitive with scheduler-first execution.

Minimal shape:

- Introduce a scheduler primitive that always creates a durable run task before child execution.
- The scheduler may wait for a short internal grace period.
- If the task finishes during the grace period, return the terminal result directly.
- If not, return the durable `run_id`, active state, and polling/cancellation/input paths.
- Existing `run_subagent` and `start_run` may remain compatibility wrappers, but they should no longer be the conceptual source of workload routing truth.

### Why This Is A True SAF

No lexical rule or caller-declared intent field can fully resolve the HORC because both preserve the need to classify work before execution. Durable-task-first execution removes that malformed primitive. Sync return becomes an optimization over the same execution model, not a separate caller bet.

### Rejected Pseudo-SAFs

- Add more broad-work keywords: narrows some misses while growing false positives.
- Ask callers for `expected_work_units`: shifts the same prediction burden to callers.
- Increase one-shot timeout: makes misroutes slower and more expensive.
- On regex rejection, internally call `start_run`: still leaves regex as the decisive semantic boundary.

### Acceptance Checks

- Broad synthesis work creates a durable task and returns a pollable state without relying on keyword rejection as the decisive mechanism.
- Short work can still return synchronously when it completes during the grace period.
- Caller input, cancellation, timeout, and `get_run` semantics are identical for sync-return and async-return paths because both are projections of the same task.
- Compatibility wrappers are documented as wrappers.

## R-SAF-4: Model Health Basis And Action Fields

### HORC

`one_shot_health` is a sparse cached probe result, but it is displayed next to default model-class selection without explaining its basis. `default_model_class:"C"` plus health `unknown` can look like a broken or incoherent default even when model inventory reconciliation passes and unknown health is not a gate.

### Repaired SAF

Add explicit basis and action fields to structured `list_model_classes` output.

Minimal shape:

Per class:

```json
{
  "one_shot_health": {
    "surface": "run_subagent_one_shot",
    "status": "unknown",
    "usable_for_one_shot": null,
    "last_checked_at": null,
    "health_basis": "never_probed",
    "health_gate": "blocks_only_known_unhealthy",
    "health_action": "Run npm run model-health:probe -- --model-class C --cwd /absolute/project/path"
  }
}
```

Top level:

- `default_one_shot_health_status`
- `default_one_shot_health_basis`
- `model_health_probe_command`

### Why This Is A True SAF

The defect is ambiguity, not absence of proof. Adding basis/action fields at the structured output boundary is the smallest sufficient correction that reaches all callers without making a read-only listing slow or side-effect-heavy.

### Rejected Pseudo-SAFs

- Auto-probe all classes during listing: expensive and side-effect-heavy.
- Hide unknown health: removes useful caution.
- README-only clarification: does not help programmatic callers.

### Acceptance Checks

- With no health file, `list_model_classes` explains `unknown` as `never_probed`.
- With a cached success, health basis is `cached_probe` and includes last success metadata.
- With a cached failure, known unhealthy still blocks one-shot use.
- `list_model_classes` performs no child/model probe.
- The default class health status and basis are visible without scanning the class array.

## Coherent Implementation Order

1. **R-SAF-1**: immediate running-silent snapshot. Low motion, directly improves live operator experience.
2. **R-SAF-4**: model health basis/action fields. Low motion, clarifies default readiness semantics.
3. **R-SAF-2**: alias semantics. Low code motion but may require compatibility notice because it changes CLI meaning.
4. **R-SAF-3**: scheduler-first primitive. Highest leverage and most complete, but it is a contract migration and should be planned separately.

## Non-Goals

- Do not attempt to expose private model thinking or internal tool payloads as progress.
- Do not make `list_model_classes` probe providers.
- Do not broaden live-model probes into deterministic failure tests.
- Do not remove existing compatibility tools before scheduler migration has an explicit transition plan.

## Final Coherent Claim

The repaired set contains three immediate True SAFs for present operational incoherences and one larger True SAF for the deeper sync/async routing frame. The prior asymptotic elements were removed: R-SAF-1 no longer includes unnecessary periodic synthetic events, and R-SAF-2 no longer treats warning-only alias preservation as sufficient.
