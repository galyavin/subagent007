import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { durableRunContractView } from "../src/durableRunContract.js";
import { runSubagentCore } from "../src/runSubagent.js";
import { getRunTask, startRunTask } from "../src/runTask.js";
import { createSkillScopedResourceLoader } from "../src/skillResources.js";
import { createTaskRootAuthoringTools } from "../src/taskRootAuthoringTools.js";
import {
  TASK_ROOT_READ_ONLY_PROVIDER_ID,
  TASK_ROOT_READ_ONLY_V1_TOOL_NAMES,
  effectProfileToolNames,
  taskRootReadOnlyActivationBindings,
  taskRootReadOnlyV1ActivationReceipt,
  validatedActivationReceipt,
} from "../src/toolProfile.js";
import { validateAndResolveRequest } from "../src/validate.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, withEnv } from "./helpers/testUtils.js";

const sourceRuntimeModule = fileURLToPath(new URL("../src/runSubagent.ts", import.meta.url));

test("task_root_read_only_v1 advertises and activates exactly four guarded tools", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-only-"));
  const root = path.join(fixture, "task");
  const runsDir = path.join(fixture, "runs");
  await fs.mkdir(root);
  const fake = await createFakePiChild();
  try {
    const contract = durableRunContractView();
    assert.equal(contract.capabilities.includes("task_root_read_only_v1_effect_profile" as never), true);
    assert.deepEqual(contract.effect_profiles.task_root_read_only_v1.supported_tools, ["read", "grep", "find", "ls"]);
    assert.equal(
      contract.effect_profiles.task_root_read_only_v1.snapshot_runtime_read_scope,
      "selected_run_owned_or_active_validated_snapshot_runtime_root_or_none",
    );
    assert.deepEqual(effectProfileToolNames("task_root_read_only_v1"), ["read", "grep", "find", "ls"]);

    const resolved = await validateAndResolveRequest({
      cwd: path.join(root, "."),
      prompt: "FAST",
      effect_profile: "task_root_read_only_v1",
      recursive_delegation: "disabled",
    }, {});
    assert.equal(resolved.cwd, await fs.realpath(root));
    await assert.rejects(
      () => validateAndResolveRequest({
        cwd: root,
        prompt: "FAST",
        effect_profile: "task_root_read_only_v1",
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
        effect_profile: "task_root_read_only_v1",
        recursive_delegation: "disabled",
      }, { runsDir });
      assert.equal(result.success, true);
      assert.deepEqual(result.activation_receipt?.active_tool_names, ["read", "grep", "find", "ls"]);
      assert.deepEqual(
        result.activation_receipt?.tool_bindings.map((binding) => binding.tool_name),
        ["read", "grep", "find", "ls"],
      );
      assert.equal(
        result.activation_receipt?.tool_bindings.every((binding) =>
          binding.provider_id === TASK_ROOT_READ_ONLY_PROVIDER_ID),
        true,
      );
      const log = await readJsonl<{ request: Record<string, unknown> }>(fake.logPath);
      assert.equal(log[0]!.request.effectProfile, "task_root_read_only_v1");
      assert.equal(Object.hasOwn(log[0]!.request, "recursiveControl"), false);
    });
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("task_root_read_only_v1 reaches durable terminal readback and releases capacity", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-terminal-"));
  const root = path.join(fixture, "task");
  const state = path.join(fixture, "state");
  const configPath = path.join(state, "config.json");
  const runTasksDir = path.join(state, "run-tasks");
  const activeChildrenDir = path.join(state, "active-children");
  const fake = await createFakePiChild();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }), "utf8");
  try {
    await withEnv({
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RECORD_SOURCE: "test",
      SUBAGENT007_MODEL_HEALTH_PATH: path.join(state, "model-health.json"),
      SUBAGENT007_RUNS_DIR: path.join(state, "runs"),
      SUBAGENT007_RUN_TASKS_DIR: runTasksDir,
      SUBAGENT007_INPUT_REQUESTS_DIR: path.join(state, "input-requests"),
      SUBAGENT007_ACTIVE_CHILDREN_DIR: activeChildrenDir,
      SUBAGENT007_QUEUED_RUNS_DIR: path.join(state, "queued-runs"),
      SUBAGENT007_SESSIONS_DIR: path.join(state, "sessions"),
      SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(state, "pi-raw-sessions"),
      SUBAGENT007_TEMP_DIR: path.join(state, "tmp"),
    }, async () => {
      const started = await startRunTask({
        cwd: root,
        prompt: "FAST",
        effect_profile: "task_root_read_only_v1",
        recursive_delegation: "disabled",
      });
      const deadline = Date.now() + 2_000;
      let terminal = await getRunTask(started.run_id);
      while (terminal.status === "working" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        terminal = await getRunTask(started.run_id);
      }
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.success, true);

      const persisted = JSON.parse(
        await fs.readFile(path.join(runTasksDir, `${started.run_id}.json`), "utf8"),
      ) as { status?: string };
      assert.equal(persisted.status, "completed");
      assert.equal((await getRunTask(started.run_id)).status, "completed");
      assert.deepEqual(await fs.readdir(activeChildrenDir).catch(() => []), []);
    });
  } finally {
    await Promise.all([
      fs.rm(fixture, { recursive: true, force: true }),
      fs.rm(path.dirname(fake.childPath), { recursive: true, force: true }),
    ]);
  }
});

test("task-root read-only bindings cover the guard configuration and fail closed on tampering", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-binding-"));
  const firstRoot = path.join(fixture, "first");
  const secondRoot = path.join(fixture, "second");
  await fs.mkdir(firstRoot);
  await fs.mkdir(secondRoot);
  try {
    const first = await taskRootReadOnlyActivationBindings(sourceRuntimeModule, firstRoot);
    const second = await taskRootReadOnlyActivationBindings(sourceRuntimeModule, secondRoot);
    assert.deepEqual(first.map((binding) => binding.tool_name), [...TASK_ROOT_READ_ONLY_V1_TOOL_NAMES]);
    assert.equal(new Set(first.map((binding) => binding.implementation_sha256)).size, 1);
    assert.notEqual(first[0]!.implementation_sha256, second[0]!.implementation_sha256);

    const receipt = taskRootReadOnlyV1ActivationReceipt({ skillBinding: null, toolBindings: first });
    assert.ok(validatedActivationReceipt({
      value: receipt,
      effectProfile: "task_root_read_only_v1",
      skillBinding: null,
      expectedToolBindings: first,
    }));
    const altered = structuredClone(receipt);
    altered.tool_bindings[0]!.implementation_sha256 = "f".repeat(64);
    assert.equal(validatedActivationReceipt({
      value: altered,
      effectProfile: "task_root_read_only_v1",
      skillBinding: null,
      expectedToolBindings: first,
    }), undefined);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("task-root read-only tools reject absolute, parent, and symlink escapes", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-guard-"));
  const root = path.join(fixture, "task");
  const outside = path.join(fixture, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "inside.txt"), "inside\n");
  const outsideFile = path.join(outside, "secret.txt");
  await fs.writeFile(outsideFile, "secret\n");
  await fs.symlink(outsideFile, path.join(root, "symlink.txt"));
  try {
    const tools = createTaskRootAuthoringTools(
      root,
      undefined,
      TASK_ROOT_READ_ONLY_V1_TOOL_NAMES,
    );
    const context = undefined as never;
    for (const tool of tools) {
      await assert.rejects(
        tool.execute(`${tool.name}-absolute`, { path: outsideFile }, undefined, undefined, context),
        /exact task root/,
      );
      await assert.rejects(
        tool.execute(`${tool.name}-parent`, { path: "../outside/secret.txt" }, undefined, undefined, context),
        /exact task root/,
      );
      await assert.rejects(
        tool.execute(`${tool.name}-symlink`, { path: "symlink.txt" }, undefined, undefined, context),
        /exact task root/,
      );
    }
    const read = tools.find((tool) => tool.name === "read")!;
    await read.execute("read-inside", { path: "inside.txt" }, undefined, undefined, context);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("task-root read-only tools admit only the selected immutable skill's support root", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-support-root-"));
  const root = path.join(fixture, "task");
  const selectedRoot = path.join(fixture, "selected-skill");
  const siblingRoot = path.join(fixture, "sibling-skill");
  const selectedSkillPath = path.join(selectedRoot, "SKILL.md");
  const selectedReference = path.join(selectedRoot, "references", "method.md");
  const siblingReference = path.join(siblingRoot, "references", "method.md");
  await fs.mkdir(root);
  await fs.mkdir(path.dirname(selectedReference), { recursive: true });
  await fs.mkdir(path.dirname(siblingReference), { recursive: true });
  await fs.writeFile(selectedSkillPath, "# selected\n");
  await fs.writeFile(selectedReference, "SELECTED_SUPPORT_METHOD\n");
  await fs.writeFile(siblingReference, "SIBLING_SUPPORT_MUST_STAY_HIDDEN\n");
  try {
    const tools = createTaskRootAuthoringTools(
      root,
      selectedSkillPath,
      TASK_ROOT_READ_ONLY_V1_TOOL_NAMES,
    );
    const read = tools.find((tool) => tool.name === "read")!;
    const selected = await read.execute(
      "read-selected-support",
      { path: "references/method.md" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.match(JSON.stringify(selected), /SELECTED_SUPPORT_METHOD/);
    await assert.rejects(
      read.execute(
        "read-sibling-support",
        { path: siblingReference },
        undefined,
        undefined,
        undefined as never,
      ),
      /exact task root/,
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("task-root read-only resource loading excludes ambient instructions", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-instructions-"));
  const ancestor = path.join(fixture, "ancestor");
  const root = path.join(ancestor, "task");
  const agentDir = path.join(fixture, "agent");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(agentDir);
  await fs.writeFile(path.join(ancestor, "AGENTS.md"), "ancestor secret\n");
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "global secret\n");
  await fs.writeFile(path.join(agentDir, "SYSTEM.md"), "custom system secret\n");
  await fs.writeFile(path.join(agentDir, "APPEND_SYSTEM.md"), "append secret\n");
  try {
    const loader = createSkillScopedResourceLoader({
      cwd: root,
      agentDir,
      noAmbientExtensions: true,
      noAmbientInstructions: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    assert.equal(loader.getSystemPrompt(), undefined);
    assert.deepEqual(loader.getAppendSystemPrompt(), []);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("task_root_read_only_v1 launches from one run-owned selected-skill bundle with readable support files", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-read-skill-bundle-"));
  const root = path.join(fixture, "task");
  const runsDir = path.join(fixture, "runs");
  const skillsRoot = path.join(fixture, "skills");
  const skillRoot = path.join(skillsRoot, "semantic-reader");
  const skillPath = path.join(skillRoot, "SKILL.md");
  const referencePath = path.join(skillRoot, "references", "method.md");
  const fake = await createFakePiChild();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.dirname(referencePath), { recursive: true });
  await fs.writeFile(skillPath, [
    "---",
    "name: semantic-reader",
    "description: Read one exact support method",
    "---",
    "",
    "Read references/method.md before answering.",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(referencePath, "SELECTED_SUPPORT_METHOD\n", "utf8");
  try {
    await withEnv({
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
    }, async () => {
      const result = await runSubagentCore({
        cwd: root,
        prompt: "SKILL_REFERENCE_PROBE",
        skill_name: "semantic-reader",
        effect_profile: "task_root_read_only_v1",
        recursive_delegation: "disabled",
      }, { runsDir });
      assert.equal(result.success, true);
      const primary = result.output_references.find((reference) => reference.name === "primary");
      assert.ok(primary);
      assert.equal(
        await fs.readFile(path.join(runsDir, primary.relative_path), "utf8"),
        "SELECTED_SUPPORT_METHOD\n",
      );

      const log = await readJsonl<{ request: { skillFilePath?: string } }>(fake.logPath);
      const runtimeSkillPath = log[0]?.request.skillFilePath;
      assert.ok(runtimeSkillPath);
      assert.notEqual(runtimeSkillPath, skillPath);
      assert.equal(path.basename(runtimeSkillPath), "SKILL.md");
    });
  } finally {
    await Promise.all([
      fs.rm(fixture, { recursive: true, force: true }),
      fs.rm(path.dirname(fake.childPath), { recursive: true, force: true }),
    ]);
  }
});
