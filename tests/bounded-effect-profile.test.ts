import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  boundedControllerActivationBindings,
  skillCreatorAuthoringV1ActivationReceipt,
  validatedActivationReceipt,
} from "../src/toolProfile.js";
import { captureAuthoringEffectScope } from "../src/authoringEffectScope.js";
import {
  assertResolvedBoundedControllerPython,
  createBoundedControllerTool,
  resolveBoundedControllerPython,
} from "../src/boundedController.js";
import { validateAndResolveRequest } from "../src/validate.js";
import { durableRunContractView } from "../src/durableRunContract.js";
import type { ActivationToolBinding } from "../src/types.js";

const SNAPSHOT_BINDING = {
  contract_version: 1 as const,
  snapshot_id: "a".repeat(64),
  metadata_sha256: "b".repeat(64),
  publication_receipt_sha256: "c".repeat(64),
  reference_id: "d".repeat(64),
  project_id: "project",
  publication_id: "publication",
};

async function boundedFixture(): Promise<{
  root: string;
  taskRoot: string;
  skillFile: string;
  scriptPath: string;
  childEntrypoint: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-bounded-profile-"));
  const taskRoot = path.join(root, "task");
  const runtimeRoot = path.join(root, "snapshot", "runtime");
  const releaseRoot = path.join(root, "release");
  await fs.mkdir(path.join(taskRoot, "state"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "scripts"), { recursive: true });
  await fs.mkdir(releaseRoot, { recursive: true });
  const skillFile = path.join(runtimeRoot, "SKILL.md");
  const scriptPath = path.join(runtimeRoot, "scripts", "researchctl.py");
  const childEntrypoint = path.join(releaseRoot, "piChild.js");
  await fs.writeFile(skillFile, "# researcher\n", "utf8");
  await fs.writeFile(path.join(runtimeRoot, "scripts", "sidecar.py"), "VALUE = 'sidecar'\n", "utf8");
  await fs.writeFile(scriptPath, "import sidecar\nimport sys\nprint('controller:' + '|'.join(sys.argv[1:]))\n", "utf8");
  await fs.writeFile(path.join(runtimeRoot, "scripts", "aj.py"), "import sys\nprint('aj:' + '|'.join(sys.argv[1:]))\n", "utf8");
  await fs.writeFile(path.join(releaseRoot, "boundedController.js"), "export const fixed = true;\n", "utf8");
  await fs.writeFile(childEntrypoint, "export const child = true;\n", "utf8");
  return { root, taskRoot, skillFile, scriptPath, childEntrypoint };
}

test("bounded profiles expose the exact ordered tool ceilings and strict controller bindings", async () => {
  const fixture = await boundedFixture();
  try {
    const webProvider = {
      extensionPath: "/provider/search-hub.ts",
      providerId: "pi-search-hub@fixture",
      implementationSha256: "e".repeat(64),
    };
    const controllerPython = await resolveBoundedControllerPython("researcher_bounded_v1");
    const bindings = await boundedControllerActivationBindings({
      effectProfile: "researcher_bounded_v1",
      skillName: "researcher",
      snapshotSkillFilePath: fixture.skillFile,
      childEntrypoint: fixture.childEntrypoint,
      webProvider,
      controllerPython,
    });
    assert.deepEqual(bindings.map((binding) => binding.tool_name), ["web_read", "web_search", "researchctl"]);
    assert.equal(bindings[2]!.provider_id, "subagent007-pi/researchctl");
    const effectScope = await captureAuthoringEffectScope({
      taskRoot: await fs.realpath(fixture.taskRoot),
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    const receipt = {
      schema_version: 2,
      confirmed_before_prompt: true,
      requested_effect_profile: "researcher_bounded_v1",
      resolved_effect_profile: "researcher_bounded_v1",
      active_tool_names: ["read", "grep", "find", "ls", "write", "edit", "web_search", "web_read", "researchctl"],
      tool_bindings: bindings,
      toolset_sha256: "unused",
      skill_binding: null,
      effect_scope_binding: effectScope.binding,
    };
    assert.equal(validatedActivationReceipt({
      value: receipt,
      effectProfile: "researcher_bounded_v1",
      skillBinding: null,
      expectedToolBindings: bindings,
      expectedEffectScopeBinding: effectScope.binding,
    }), undefined, "toolset digest is intentionally required");
    const validReceipt = {
      ...receipt,
      toolset_sha256: (await import("node:crypto")).createHash("sha256").update(JSON.stringify({
        profile: "researcher_bounded_v1",
        active_tool_names: receipt.active_tool_names,
        tool_bindings: bindings,
      })).digest("hex"),
    };
    assert.ok(validatedActivationReceipt({
      value: validReceipt,
      effectProfile: "researcher_bounded_v1",
      skillBinding: null,
      expectedToolBindings: bindings,
      expectedEffectScopeBinding: effectScope.binding,
    }));
    const { effect_scope_binding: _binding, ...missingBindingReceipt } = validReceipt;
    assert.equal(validatedActivationReceipt({
      value: { ...missingBindingReceipt, schema_version: 1 },
      effectProfile: "researcher_bounded_v1",
      skillBinding: null,
      expectedToolBindings: bindings,
    }), undefined, "effect-scoped profile cannot downgrade to schema 1 when the expected binding argument is omitted");
    assert.equal(validatedActivationReceipt({
      value: {
        ...validReceipt,
        effect_scope_binding: {
          ...effectScope.binding,
          immutable_tree_sha256: "f".repeat(64),
        },
      },
      effectProfile: "researcher_bounded_v1",
      skillBinding: null,
      expectedToolBindings: bindings,
      expectedEffectScopeBinding: effectScope.binding,
    }), undefined, "mismatched effect-scope binding must reject");
    const legacyReceipt = skillCreatorAuthoringV1ActivationReceipt(null);
    assert.equal(validatedActivationReceipt({
      value: { ...legacyReceipt, schema_version: 2, effect_scope_binding: effectScope.binding },
      effectProfile: "skill_creator_authoring_v1",
      skillBinding: null,
    }), undefined, "non-effect-scoped profile must reject an unexpected receipt binding");
    assert.equal(validatedActivationReceipt({
      value: legacyReceipt,
      effectProfile: "skill_creator_authoring_v1",
      skillBinding: null,
      expectedEffectScopeBinding: effectScope.binding,
    }), undefined, "non-effect-scoped profile must reject an unexpected expected binding");
    await fs.writeFile(fixture.scriptPath, "import sys\nprint('drift')\n", "utf8");
    const drifted = await boundedControllerActivationBindings({
      effectProfile: "researcher_bounded_v1",
      skillName: "researcher",
      snapshotSkillFilePath: fixture.skillFile,
      childEntrypoint: fixture.childEntrypoint,
      webProvider,
      controllerPython,
    });
    assert.notEqual(drifted[2]!.implementation_sha256, bindings[2]!.implementation_sha256);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("AJ interpreter admission rejects Python without yaml, selects a capable exact binary, and rechecks bound bytes", async () => {
  const fixture = await boundedFixture();
  const originalPath = process.env.PATH;
  const missingYamlDir = path.join(fixture.root, "missing-yaml");
  const capableDir = path.join(fixture.root, "capable-yaml");
  const writeProbePython = async (directory: string, hasYaml: boolean): Promise<string> => {
    await fs.mkdir(directory, { recursive: true });
    const candidate = path.join(directory, "python3");
    await fs.writeFile(candidate, [
      "#!/bin/sh",
      "if [ \"$1\" = \"-c\" ]; then",
      `  case \"$2\" in *yaml*) exit ${hasYaml ? "0" : "1"} ;; *) exit 0 ;; esac`,
      "fi",
      "exit 1",
      "",
    ].join("\n"), "utf8");
    await fs.chmod(candidate, 0o755);
    return candidate;
  };
  try {
    const missingYaml = await writeProbePython(missingYamlDir, false);
    const capableYaml = await writeProbePython(capableDir, true);
    process.env.PATH = missingYamlDir;
    await assert.rejects(
      () => resolveBoundedControllerPython("assumption_audit_bounded_v1"),
      /no capable python3 interpreter.*yaml/,
    );

    process.env.PATH = [missingYamlDir, capableDir].join(path.delimiter);
    const selected = await resolveBoundedControllerPython("assumption_audit_bounded_v1");
    assert.equal(selected.realpath, await fs.realpath(capableYaml));
    assert.equal(
      selected.file_sha256,
      (await import("node:crypto")).createHash("sha256").update(await fs.readFile(capableYaml)).digest("hex"),
    );
    await assertResolvedBoundedControllerPython(selected, "assumption_audit_bounded_v1");
    await fs.appendFile(capableYaml, "# identity drift\n", "utf8");
    await assert.rejects(
      () => assertResolvedBoundedControllerPython(selected, "assumption_audit_bounded_v1"),
      /identity changed/,
    );
    assert.notEqual(await fs.realpath(missingYaml), selected.realpath);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("resolved controller interpreter fails closed when its parent-bound bytes drift", async () => {
  const fixture = await boundedFixture();
  try {
    const source = await resolveBoundedControllerPython("researcher_bounded_v1");
    const copiedPython = path.join(await fs.realpath(fixture.root), "python3");
    await fs.copyFile(source.realpath, copiedPython);
    await fs.chmod(copiedPython, 0o755);
    const digest = (await import("node:crypto")).createHash("sha256").update(await fs.readFile(copiedPython)).digest("hex");
    await assertResolvedBoundedControllerPython({ realpath: copiedPython, file_sha256: digest }, "researcher_bounded_v1");
    await fs.appendFile(copiedPython, "drift", "utf8");
    await assert.rejects(
      () => assertResolvedBoundedControllerPython({ realpath: copiedPython, file_sha256: digest }, "researcher_bounded_v1"),
      /identity changed/,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded controller uses fixed python3 execFile and rejects path escapes while treating URLs as data", async () => {
  const fixture = await boundedFixture();
  try {
    const tool = createBoundedControllerTool(
      fixture.taskRoot, "researchctl", fixture.scriptPath, await resolveBoundedControllerPython("researcher_bounded_v1"),
    );
    const allowed = await tool.execute("call", { subcommand: "status", argv: ["state/job.json", "--ref", "https://example.test/a/../b"] }, undefined, undefined, {} as never) as { content: Array<{ text: string }> };
    assert.match(allowed.content[0]!.text, /controller:status\|state\/job\.json/);
    await assert.rejects(
      () => tool.execute("call", { subcommand: "status", argv: ["../outside.json"] }, undefined, undefined, {} as never),
      /lexical traversal|exact task root/,
    );
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(fixture.taskRoot, "escape"));
    await assert.rejects(
      () => tool.execute("call", { subcommand: "status", argv: ["escape/file.json"] }, undefined, undefined, {} as never),
      /symlink|exact task root/,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("AJ run mediation-receipt path uses the task-root guard", async () => {
  const fixture = await boundedFixture();
  try {
    const ajScript = path.join(path.dirname(fixture.scriptPath), "aj.py");
    const tool = createBoundedControllerTool(
      fixture.taskRoot, "aj_switchboard", ajScript, await resolveBoundedControllerPython("assumption_audit_bounded_v1"),
    );
    await assert.rejects(
      () => tool.execute(
        "call",
        { subcommand: "run", argv: ["commit", "--mediation-receipt", "../outside-receipt.json"] },
        undefined,
        undefined,
        {} as never,
      ),
      /lexical traversal|exact task root/,
    );
    await assert.rejects(
      () => tool.execute(
        "call",
        { subcommand: "run", argv: ["commit", "--mediation-receipt", "https://outside.example/receipt.json"] },
        undefined,
        undefined,
        {} as never,
      ),
      /absolute local path|exact task root/,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded controller cannot create Python bytecode in immutable snapshot scripts", async () => {
  const fixture = await boundedFixture();
  try {
    const tool = createBoundedControllerTool(
      fixture.taskRoot, "researchctl", fixture.scriptPath, await resolveBoundedControllerPython("researcher_bounded_v1"),
    );
    await tool.execute("call", { subcommand: "status", argv: ["state/job.json"] }, undefined, undefined, {} as never);
    await assert.rejects(
      () => fs.stat(path.join(path.dirname(fixture.scriptPath), "__pycache__")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded controller returns bounded timeout failure without shell fallback", async () => {
  const fixture = await boundedFixture();
  try {
    await fs.writeFile(fixture.scriptPath, "import time\ntime.sleep(3)\n", "utf8");
    const tool = createBoundedControllerTool(
      fixture.taskRoot, "researchctl", fixture.scriptPath, await resolveBoundedControllerPython("researcher_bounded_v1"),
    );
    const result = await tool.execute("call", { subcommand: "status", argv: ["state/job.json"] }, undefined, undefined, {} as never) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as { success: boolean; timed_out?: boolean };
    assert.equal(payload.success, false);
    assert.equal(payload.timed_out, true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded effect profiles reject legacy skill aliases, missing snapshots, resume, and recursion before launch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-bounded-validation-"));
  const session = path.join(root, "session.jsonl");
  try {
    await fs.writeFile(session, "{}\n", "utf8");
    const base = {
      prompt: "FAST",
      cwd: root,
      model_class: "C" as const,
      effect_profile: "researcher_bounded_v1" as const,
      skill_name: "researcher",
      skill_snapshot_binding: SNAPSHOT_BINDING,
    };
    const resolved = await validateAndResolveRequest(base, {});
    assert.equal(resolved.cwd, await fs.realpath(root));
    await assert.rejects(
      () => validateAndResolveRequest({ ...base, skill_name: undefined, skill: "researcher" }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "invalid_skill",
    );
    await assert.rejects(
      () => validateAndResolveRequest({ ...base, continuity: { mode: "resume", session_id: session } }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "effect_profile_unsupported",
    );
    await assert.rejects(
      () => validateAndResolveRequest({ ...base, recursive_delegation: "enabled" }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "recursive_delegation_effect_conflict",
    );
    await assert.rejects(
      () => validateAndResolveRequest({ ...base, skill_snapshot_binding: undefined }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "invalid_skill_snapshot_binding",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounded public descriptors state the exact controller/interpreter enforcement ceiling", () => {
  const profiles = durableRunContractView().effect_profiles;
  for (const profile of [profiles.researcher_bounded_v1, profiles.assumption_audit_bounded_v1]) {
    assert.equal(profile.provider_binding, "explicit_identity_and_sha256");
    assert.equal(profile.controller_binding, "fixed_wrapper_exact_snapshot_script_and_resolved_python_sha256");
    assert.equal(profile.enforcement_boundary, "pi_create_agent_session_tools_allowlist_and_task_root_path_guards_and_execfile_controller");
    assert.equal(profile.snapshot_runtime_read_scope, "active_validated_snapshot_runtime_root");
    assert.match(profile.state_scope, /^\.subagent007\/(researcher_bounded_v1|assumption_audit_bounded_v1)$/u);
    assert.equal(profile.state_initialization, "state_root_absent_at_parent_and_child_pre_prompt_capture");
    assert.equal(profile.task_root_write_scope, "exact_fixed_profile_state_subtree");
    assert.equal(profile.controller_mutation_scope, "exact_fixed_profile_state_subtree");
    assert.equal(profile.immutable_input_scope, "bounded_initial_task_root_tree_outside_fixed_state_subtree");
    assert.equal(profile.terminal_reinspection, "every_settled_child_outcome");
    assert.equal(profile.activation_receipt.schema_version, 2);
    assert.equal(profile.activation_receipt.fields.includes("effect_scope_binding"), true);
    assert.equal(profile.claim_ceiling, "pi_tool_dispatch_path_controller_and_terminal_reinspection_not_os_sandbox");
  }
});

test("controller binding type remains restricted to the two bounded tools", () => {
  const binding: ActivationToolBinding = {
    tool_name: "aj_switchboard",
    provider_id: "subagent007-pi/aj_switchboard",
    implementation_sha256: "f".repeat(64),
  };
  assert.equal(binding.tool_name, "aj_switchboard");
});
