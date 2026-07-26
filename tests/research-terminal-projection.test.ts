import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  materializeResearchControllerCompletion,
  resolveBoundedControllerPython,
} from "../src/boundedController.js";
import {
  boundedProfileStateRoot,
  captureAuthoringEffectScope,
} from "../src/authoringEffectScope.js";
import { writeRunOutput } from "../src/output.js";
import {
  boundedAuthoringActivationReceipt,
  validatedActivationReceipt,
  validatedProjectedActivationReceipt,
} from "../src/toolProfile.js";
import { assertCurrentRunTaskSnapshot } from "../src/runTask.js";
import {
  terminalProjectionIsValid,
  type TerminalProjectionInput,
} from "../src/terminalProjection.js";
import type {
  ActivationReceipt,
  ActivationToolBinding,
  ResearchControllerTerminalReceipt,
  RunOutputReference,
} from "../src/types.js";

const TOOL_BINDINGS: ActivationToolBinding[] = [
  {
    tool_name: "web_read",
    provider_id: "pi-search-hub@fixture",
    implementation_sha256: "1".repeat(64),
  },
  {
    tool_name: "web_search",
    provider_id: "pi-search-hub@fixture",
    implementation_sha256: "1".repeat(64),
  },
  {
    tool_name: "researchctl",
    provider_id: "subagent007-pi/researchctl",
    implementation_sha256: "2".repeat(64),
  },
];

async function producerBaseline(): Promise<{
  cleanup: () => Promise<void>;
  strictActivation: ActivationReceipt;
  legacyActivation: ActivationReceipt;
  primary: RunOutputReference;
  packet: RunOutputReference;
  receipt: ResearchControllerTerminalReceipt;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-terminal-projection-"));
  const taskRoot = path.join(root, "task");
  const runtimeRoot = path.join(root, "runtime");
  const scriptPath = path.join(runtimeRoot, "scripts", "researchctl.py");
  const runsDir = path.join(root, "runs");
  await fs.mkdir(taskRoot);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const taskRootReal = await fs.realpath(taskRoot);
  await fs.writeFile(scriptPath, [
    "import json, sys",
    "with open(sys.argv[2], 'r', encoding='utf-8') as handle:",
    "    job = json.load(handle)",
    "if sys.argv[1] == 'validate':",
    "    assert job['state'] == 'complete'",
    "    assert job['dispatch_protocol'] == 'research_web_dispatch_v1'",
    "elif sys.argv[1] == 'render':",
    "    profile = sys.argv[4]",
    "    print('# primary producer bytes' if profile == 'primary' else '# bendum packet producer bytes')",
    "else:",
    "    raise SystemExit(2)",
  ].join("\n"), "utf8");
  const scope = await captureAuthoringEffectScope({
    taskRoot: taskRootReal,
    effectProfile: "researcher_bounded_v1",
    recursiveDelegation: "disabled",
  });
  const stateRoot = boundedProfileStateRoot(taskRootReal, "researcher_bounded_v1");
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, "job.json"),
    '{"state":"complete","dispatch_protocol":"research_web_dispatch_v1"}\n',
    "utf8",
  );
  const product = await materializeResearchControllerCompletion({
    taskRoot: taskRootReal,
    scriptPath,
    controllerPython: await resolveBoundedControllerPython("researcher_bounded_v1"),
    effectScopeBinding: scope.binding,
  });
  assert.ok(product, "real controller producer must materialize the baseline");
  const primaryOutput = await writeRunOutput(product.primaryMarkdown, runsDir);
  const packetOutput = await writeRunOutput(product.packetMarkdown, runsDir);
  const primary = { ...primaryOutput.reference, name: "primary" as const };
  const packet = { ...packetOutput.reference, name: "packet" as const };
  assert.notEqual(primary.content_sha256, packet.content_sha256);
  const strictActivation = boundedAuthoringActivationReceipt({
    effectProfile: "researcher_bounded_v1",
    skillBinding: null,
    toolBindings: TOOL_BINDINGS,
    effectScopeBinding: scope.binding,
  });
  const legacyActivation = {
    ...strictActivation,
    schema_version: 3,
    controller_protocol: undefined,
  } as unknown as ActivationReceipt;
  delete (legacyActivation as unknown as Record<string, unknown>).controller_protocol;
  return {
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
    strictActivation,
    legacyActivation,
    primary,
    packet,
    receipt: product.receipt,
  };
}

function valid(input: Partial<TerminalProjectionInput> & Pick<TerminalProjectionInput, "requestedEffectProfile" | "activationClass" | "status" | "outputReferences">): boolean {
  return terminalProjectionIsValid(input as TerminalProjectionInput);
}

test("terminal projection joins the real strict producer receipt to named output roles and rejects negative mutations", async () => {
  const baseline = await producerBaseline();
  try {
    const strict: TerminalProjectionInput = {
      requestedEffectProfile: "researcher_bounded_v1",
      activationClass: "researcher_v4_strict",
      status: "completed",
      outputReferences: [baseline.primary, baseline.packet],
      controllerTerminalReceipt: baseline.receipt,
    };
    assert.equal(terminalProjectionIsValid(strict), true);
    const mutations: Array<[string, Partial<TerminalProjectionInput>]> = [
      ["missing receipt", { controllerTerminalReceipt: undefined }],
      ["missing packet", { outputReferences: [baseline.primary] }],
      ["transcript primary", { outputReferences: [{ ...baseline.primary, output_mode: "transcript" }, baseline.packet] }],
      ["duplicate role", { outputReferences: [baseline.primary, { ...baseline.packet, name: "primary" }] }],
      ["duplicate path", { outputReferences: [baseline.primary, { ...baseline.packet, relative_path: baseline.primary.relative_path }] }],
      ["extra reference", { outputReferences: [baseline.primary, baseline.packet, { ...baseline.packet }] }],
      ["unequal swapped hashes", {
        controllerTerminalReceipt: {
          ...(baseline.receipt as Extract<ResearchControllerTerminalReceipt, { schema_version: 2 }>),
          primary_sha256: baseline.packet.content_sha256,
          packet_sha256: baseline.primary.content_sha256,
        },
      }],
      ["extra receipt key", {
        controllerTerminalReceipt: {
          ...baseline.receipt,
          forged: true,
        } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["missing receipt key", {
        controllerTerminalReceipt: {
          ...(baseline.receipt as Extract<ResearchControllerTerminalReceipt, { schema_version: 2 }>),
          job_sha256: undefined,
        } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["wrong schema", {
        controllerTerminalReceipt: { ...baseline.receipt, schema_version: 7 } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["wrong protocol", {
        controllerTerminalReceipt: { ...baseline.receipt, dispatch_protocol: "other" } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["wrong controller", {
        controllerTerminalReceipt: { ...baseline.receipt, controller: "other" } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["wrong state", {
        controllerTerminalReceipt: { ...baseline.receipt, state: "blocked" } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["wrong primary profile", {
        controllerTerminalReceipt: { ...baseline.receipt, primary_profile: "full" } as unknown as ResearchControllerTerminalReceipt,
      }],
      ["uppercase hash", {
        controllerTerminalReceipt: {
          ...(baseline.receipt as Extract<ResearchControllerTerminalReceipt, { schema_version: 2 }>),
          primary_sha256: baseline.primary.content_sha256.toUpperCase(),
        },
      }],
      ["packet profile full", {
        controllerTerminalReceipt: {
          ...(baseline.receipt as Extract<ResearchControllerTerminalReceipt, { schema_version: 2 }>),
          packet_profile: "full",
        } as unknown as ResearchControllerTerminalReceipt,
      }],
    ];
    for (const [name, mutation] of mutations) {
      assert.equal(terminalProjectionIsValid({ ...strict, ...mutation }), false, name);
    }
    assert.equal(valid({
      requestedEffectProfile: "assumption_audit_bounded_v1",
      activationClass: "other",
      status: "completed",
      outputReferences: [baseline.primary],
      controllerTerminalReceipt: baseline.receipt,
    }), false, "cross-profile receipt");
    assert.equal(valid({
      requestedEffectProfile: "assumption_audit_bounded_v1",
      activationClass: "other",
      status: "completed",
      outputReferences: [baseline.primary, baseline.packet],
    }), false, "cross-profile packet");
  } finally {
    await baseline.cleanup();
  }
});

test("terminal projection preserves legacy v3 and strict v4 status ceilings without counterfeit compatibility", async () => {
  const baseline = await producerBaseline();
  try {
    const legacyV1: ResearchControllerTerminalReceipt = {
      schema_version: 1,
      controller: "researchctl",
      state: "complete",
      validation: "passed",
      job_sha256: "3".repeat(64),
      render_profile: "full",
      render_sha256: "4".repeat(64),
    };
    const legacy = {
      requestedEffectProfile: "researcher_bounded_v1" as const,
      activationClass: "researcher_v3_legacy" as const,
      status: "completed" as const,
      outputReferences: [baseline.primary],
    };
    assert.equal(terminalProjectionIsValid(legacy), true);
    assert.equal(terminalProjectionIsValid({ ...legacy, controllerTerminalReceipt: legacyV1 }), true);
    assert.equal(terminalProjectionIsValid({ ...legacy, controllerTerminalReceipt: baseline.receipt }), false);
    assert.equal(terminalProjectionIsValid({ ...legacy, outputReferences: [baseline.primary, baseline.packet] }), false);

    const diagnostic = [baseline.primary];
    for (const status of ["failed", "cancelled", "timed_out"] as const) {
      assert.equal(valid({
        requestedEffectProfile: "researcher_bounded_v1",
        activationClass: "researcher_v4_strict",
        status,
        outputReferences: diagnostic,
      }), true, `${status} non-complete`);
      assert.equal(valid({
        requestedEffectProfile: "researcher_bounded_v1",
        activationClass: "researcher_v4_strict",
        status,
        outputReferences: [baseline.primary, baseline.packet],
        controllerTerminalReceipt: baseline.receipt,
      }), true, `${status} materialized`);
    }
    assert.equal(valid({
      requestedEffectProfile: "researcher_bounded_v1",
      activationClass: "other",
      status: "failed",
      outputReferences: diagnostic,
    }), true, "activation failure diagnostic");
    assert.equal(valid({
      requestedEffectProfile: "researcher_bounded_v1",
      activationClass: "other",
      status: "failed",
      outputReferences: [baseline.primary, baseline.packet],
      controllerTerminalReceipt: baseline.receipt,
    }), false, "activation failure cannot claim strict materialization");
    assert.equal(valid({
      requestedEffectProfile: undefined,
      activationClass: "other",
      status: "completed",
      outputReferences: diagnostic,
    }), true, "ordinary terminal");
  } finally {
    await baseline.cleanup();
  }
});

test("legacy Researcher v3 is durable-readback-only while live ingress remains exact v4", async () => {
  const baseline = await producerBaseline();
  try {
    const expectedEffectScopeBinding = (
      baseline.strictActivation as Extract<ActivationReceipt, { schema_version: 4 }>
    ).effect_scope_binding;
    assert.equal(validatedActivationReceipt({
      value: baseline.legacyActivation,
      effectProfile: "researcher_bounded_v1",
      skillBinding: null,
      expectedToolBindings: TOOL_BINDINGS,
      expectedEffectScopeBinding,
    }), undefined, "live ingress must reject v3");
    assert.ok(validatedProjectedActivationReceipt({
      value: baseline.legacyActivation,
      requestedEffectProfile: "researcher_bounded_v1",
    }), "durable projection must retain exact pre-delta v3");
  } finally {
    await baseline.cleanup();
  }
});

test("current durable snapshot readback and replay reject persisted strict projection forgery", async () => {
  const baseline = await producerBaseline();
  try {
    const runId = "2026-07-25T000000000Z-research-projection";
    const startedAt = "2026-07-25T00:00:00.000Z";
    const finishedAt = "2026-07-25T00:00:01.000Z";
    const snapshotBinding = {
      contract_version: 1,
      snapshot_id: "5".repeat(64),
      metadata_sha256: "6".repeat(64),
      publication_receipt_sha256: "7".repeat(64),
      reference_id: "8".repeat(64),
      project_id: "producer-project",
      publication_id: "producer-publication",
    };
    const view = {
      contract_name: "subagent007.durable_run",
      contract_version: 3,
      run_id: runId,
      task_id: runId,
      task_kind: "run",
      root_run_id: runId,
      recursion_depth: 0,
      child_run_ids: [],
      descendant_run_ids: [],
      descendant_terminal_statuses: {},
      status: "completed",
      started_at: startedAt,
      finished_at: finishedAt,
      input_requests_dir: `/tmp/${runId}`,
      input_requests: [],
      child_started: true,
      active_phase: "completed",
      last_phase_at: finishedAt,
      success: true,
      exit_code: 0,
      timed_out: false,
      partial_output_available: false,
      resume_possible: false,
      duration_ms: 1000,
      requested_timeout_ms: null,
      resolved_timeout_ms: null,
      timeout_floor_ms: 0,
      effective_timeout_ms: null,
      timeout_headroom_ms: 0,
      kill_grace_ms: 0,
      force_grace_ms: 0,
      output_references: [baseline.primary, baseline.packet],
      size_bytes: baseline.primary.size_bytes,
      resolved_model_class: "C",
      requested_skill: "researcher",
      resolved_skill_path: "/tmp/researcher/SKILL.md",
      resolved_skill_sha256: "9".repeat(64),
      requested_effect_profile: "researcher_bounded_v1",
      resolved_effect_profile: "researcher_bounded_v1",
      activation_receipt: baseline.strictActivation,
      controller_terminal_receipt: baseline.receipt,
      skill_snapshot_binding: snapshotBinding,
      requested_output_mode: "final",
      written_output_mode: "final",
      stop_reason: "completed",
      stop_signal: null,
      session_id: null,
      session_established: false,
    };
    const persisted = JSON.parse(JSON.stringify(view));
    assert.doesNotThrow(() => assertCurrentRunTaskSnapshot(persisted));
    const forged = JSON.parse(JSON.stringify(persisted));
    forged.controller_terminal_receipt.primary_sha256 = baseline.packet.content_sha256;
    forged.controller_terminal_receipt.packet_sha256 = baseline.primary.content_sha256;
    assert.throws(
      () => assertCurrentRunTaskSnapshot(forged),
      /snapshot|terminal|projection/i,
    );
    const replayedLegacy = JSON.parse(JSON.stringify({
      ...view,
      output_references: [baseline.primary],
      activation_receipt: baseline.legacyActivation,
      controller_terminal_receipt: undefined,
    }));
    assert.doesNotThrow(() => assertCurrentRunTaskSnapshot(replayedLegacy));
  } finally {
    await baseline.cleanup();
  }
});
