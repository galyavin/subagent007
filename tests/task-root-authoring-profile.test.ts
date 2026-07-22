import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { durableRunContractView } from "../src/durableRunContract.js";
import { runSubagentCore } from "../src/runSubagent.js";
import { createTaskRootAuthoringTools } from "../src/taskRootAuthoringTools.js";
import { effectProfileToolNames } from "../src/toolProfile.js";
import { validateAndResolveRequest } from "../src/validate.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, withEnv } from "./helpers/testUtils.js";

test("task_root_authoring_v1 is a neutral exact two-tool profile while creator compatibility remains unchanged", async () => {
  const contract = durableRunContractView() as ReturnType<typeof durableRunContractView> & {
    effect_profiles: Record<string, { supported_tools: readonly string[]; recursive_delegate: string }>;
  };
  assert.equal(contract.contract_version, 3);
  assert.equal(contract.capabilities.includes("task_root_authoring_v1_effect_profile" as never), true);
  assert.equal(contract.capabilities.includes("authoring_effect_scope_binding" as never), true);
  assert.equal(contract.capabilities.includes("idempotent_start_by_client_id" as never), true);
  assert.deepEqual(contract.effect_profiles.task_root_authoring_v1?.supported_tools, ["read", "write"]);
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.recursive_delegate, "excluded");
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.request_field, "allowed_output_paths");
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.request_field_required, true);
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.task_root_write_scope, "exact_declared_new_output_files");
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.terminal_reinspection, "every_settled_child_outcome");
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.activation_receipt.schema_version, 2);
  assert.equal(contract.effect_profiles.task_root_authoring_v1?.activation_receipt.fields.includes("effect_scope_binding"), true);
  assert.deepEqual(effectProfileToolNames("task_root_authoring_v1" as never), ["read", "write"]);
  assert.deepEqual(contract.effect_profiles.skill_creator_authoring_v1?.supported_tools, [
    "read", "grep", "find", "ls", "write", "edit",
  ]);
});

test("task_root_authoring_v1 rejects recursion and activates before prompt with no ambient tools", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-neutral-authoring-"));
  const root = path.join(parent, "task");
  const runsDir = path.join(parent, "runs");
  await fs.mkdir(root);
  const fake = await createFakePiChild();
  try {
    const resolved = await validateAndResolveRequest({
      cwd: root,
      prompt: "FAST",
      effect_profile: "task_root_authoring_v1" as never,
      allowed_output_paths: [],
      recursive_delegation: "disabled",
    }, {});
    assert.equal(resolved.effectProfile, "task_root_authoring_v1");
    await assert.rejects(
      () => validateAndResolveRequest({
        cwd: root,
        prompt: "FAST",
        effect_profile: "task_root_authoring_v1" as never,
        allowed_output_paths: [],
        recursive_delegation: "enabled",
      }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "recursive_delegation_effect_conflict",
    );

    await withEnv({
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
    }, async () => {
      const result = await runSubagentCore({
        cwd: root,
        prompt: "FAST",
        effect_profile: "task_root_authoring_v1" as never,
        allowed_output_paths: [],
        recursive_delegation: "disabled",
      }, { runsDir });
      assert.equal(result.success, true);
      assert.deepEqual(result.activation_receipt?.active_tool_names, ["read", "write"]);
      assert.deepEqual(result.activation_receipt?.tool_bindings, []);
      const log = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(log.length, 1);
      assert.equal(log[0]!.request.effectProfile, "task_root_authoring_v1");
      assert.equal(Object.hasOwn(log[0]!.request, "recursiveControl"), false);
    });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("neutral authoring tools read task/snapshot roots and reject every write escape", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-neutral-roots-"));
  const taskRoot = path.join(parent, "task");
  const snapshotRoot = path.join(parent, "snapshot", "runtime");
  const outside = path.join(parent, "outside");
  try {
    await fs.mkdir(taskRoot, { recursive: true });
    await fs.mkdir(snapshotRoot, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(snapshotRoot, "SKILL.md"), "snapshot\n");
    await fs.writeFile(path.join(snapshotRoot, "guide.md"), "guide\n");
    await fs.symlink(outside, path.join(taskRoot, "escape"));
    const tools = createTaskRootAuthoringTools(
      taskRoot,
      path.join(snapshotRoot, "SKILL.md"),
      ["read", "write"] as never,
    );
    assert.deepEqual(tools.map((tool) => tool.name), ["read", "write"]);
    const read = tools[0]!;
    const write = tools[1]!;
    const context = {} as never;
    await read.execute("read", { path: "guide.md" }, undefined, undefined, context);
    await write.execute("write", { path: "bundle/SKILL.md", content: "bundle\n" }, undefined, undefined, context);
    await assert.rejects(
      () => write.execute("snapshot-write", { path: path.join(snapshotRoot, "guide.md"), content: "changed\n" }, undefined, undefined, context),
      /exact task root/,
    );
    await assert.rejects(
      () => write.execute("outside-write", { path: path.join(outside, "file.md"), content: "changed\n" }, undefined, undefined, context),
      /exact task root/,
    );
    await assert.rejects(
      () => write.execute("symlink-write", { path: "escape/file.md", content: "changed\n" }, undefined, undefined, context),
      /exact task root/,
    );
    assert.equal(await fs.readFile(path.join(snapshotRoot, "guide.md"), "utf8"), "guide\n");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
