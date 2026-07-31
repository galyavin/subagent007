import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { composePrompt } from "../src/prompt.js";
import { runSubagentCore } from "../src/runSubagent.js";
import { createRecursiveDelegateTool } from "../src/recursiveDelegateTool.js";
import { createSkillScopedResourceLoader } from "../src/skillResources.js";
import {
  appendSystemSkillToPrompt,
  createSystemSkillExtension,
  resolveSystemSkillSource,
  systemSkillPromptBlock,
  validatedSystemSkillActivationReceipt,
} from "../src/systemSkill.js";
import { validateAndResolveRequest } from "../src/validate.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl, withEnv } from "./helpers/testUtils.js";

async function writeSkill(root: string, dir: string, name: string, body: string): Promise<string> {
  const skillPath = path.join(root, dir, "SKILL.md");
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, [
    "---",
    `name: ${name}`,
    `description: Test ${name}`,
    "---",
    "",
    `# ${name}`,
    "",
    body,
    "",
  ].join("\n"), "utf8");
  return skillPath;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

test("omitted system-skill mode preserves selected-skill-only loading and resolution", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-system-skill-omitted-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const skillsRoot = path.join(tmp, "skills");
  await fs.mkdir(cwd, { recursive: true });
  await writeSkill(skillsRoot, "selected", "selected-skill", "SELECTED FULL BODY");
  await writeSkill(skillsRoot, "ambient", "ambient-skill", "AMBIENT FULL BODY");

  const loader = createSkillScopedResourceLoader({
    cwd,
    agentDir,
    skill: "selected-skill",
    lookupPaths: [skillsRoot],
  });
  await loader.reload();
  assert.deepEqual(loader.getSkills().skills.map((skill) => skill.name), ["selected-skill"]);

  const resolved = await validateAndResolveRequest({
    prompt: "Do bounded work",
    cwd,
    skill_name: "selected-skill",
  }, { default_model_class: "C" });
  assert.equal(resolved.skill, "selected-skill");
  assert.equal(resolved.systemSkill, undefined);
});

test("system-skill mode keeps the full specialist catalogue except the governor and preserves selected snapshots", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-system-skill-catalog-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const skillsRoot = path.join(tmp, "skills");
  const snapshotRoot = path.join(tmp, "selected-snapshot");
  await fs.mkdir(cwd, { recursive: true });
  await writeSkill(skillsRoot, "governor", "governor-skill", "GOVERNOR CANONICAL BODY");
  await writeSkill(skillsRoot, "selected", "selected-skill", "MUTABLE SELECTED BODY");
  const otherPath = await writeSkill(skillsRoot, "other", "other-specialist", "OTHER FULL SPECIALIST BODY");
  const selectedSnapshotPath = await writeSkill(snapshotRoot, "selected", "selected-skill", "SNAPSHOT SELECTED FULL BODY");

  const ambientTransform: InlineExtension = { name: "ambient-transform", factory: () => {} };
  const source = await withEnv({ SUBAGENT007_PI_SKILL_PATHS: skillsRoot }, () =>
    resolveSystemSkillSource({
      systemSkillName: "governor-skill",
      cwd,
      agentDir,
      expectedPath: path.join(skillsRoot, "governor", "SKILL.md"),
    }));
  const finalizer = createSystemSkillExtension({ source, onActivation: () => {} });
  const loader = createSkillScopedResourceLoader({
    cwd,
    agentDir,
    skill: "selected-skill",
    skillFilePath: selectedSnapshotPath,
    systemSkill: "governor-skill",
    lookupPaths: [skillsRoot],
    extensionFactories: [ambientTransform, finalizer],
  });
  await loader.reload();

  const skills = loader.getSkills().skills;
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ["other-specialist", "selected-skill"]);
  assert.equal(skills.find((skill) => skill.name === "selected-skill")?.filePath, selectedSnapshotPath);
  assert.equal(await fs.readFile(otherPath, "utf8"), (await fs.readFile(skills.find((skill) => skill.name === "other-specialist")!.filePath, "utf8")));
  assert.match(await fs.readFile(selectedSnapshotPath, "utf8"), /SNAPSHOT SELECTED FULL BODY/);
  assert.equal(loader.getExtensions().extensions.at(-1)?.path, "<inline:subagent007-system-skill-finalizer>");

  const specialistPrompt = composePrompt({ prompt: "Use the bounded specialist", skill: "selected-skill" });
  assert.match(specialistPrompt, /^\/skill:selected-skill\n/);
  const composed = appendSystemSkillToPrompt({ currentSystemPrompt: "PI BASE\n\nAMBIENT TRANSFORM", source });
  assert.ok(composed.systemPrompt.indexOf("AMBIENT TRANSFORM") < composed.systemPrompt.indexOf(source.content));
  assert.equal(composed.systemPrompt.includes("SNAPSHOT SELECTED FULL BODY"), false);
  assert.equal(composed.systemPrompt.endsWith(systemSkillPromptBlock(source)), true);
});

test("final system-skill transform de-duplicates the governing body and emits a truthful narrow receipt", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-system-skill-receipt-"));
  const sourcePath = await writeSkill(tmp, "governor", "governor-skill", "UNIQUE GOVERNING BODY 7319");
  const content = await fs.readFile(sourcePath, "utf8");
  const source = {
    name: "governor-skill",
    path: sourcePath,
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  };
  const transformedEarlier = `PI BASE\n\n${content}\nEARLIER EXTENSION SUFFIX`;
  const { systemPrompt, receipt } = appendSystemSkillToPrompt({
    currentSystemPrompt: transformedEarlier,
    source,
  });

  assert.equal(occurrences(systemPrompt, content), 1);
  assert.ok(systemPrompt.indexOf("EARLIER EXTENSION SUFFIX") < systemPrompt.indexOf(content));
  assert.equal(systemPrompt.endsWith(systemSkillPromptBlock(source)), true);
  assert.equal(receipt.content_sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(receipt.final_system_prompt_sha256, createHash("sha256").update(systemPrompt).digest("hex"));
  assert.equal(receipt.system_skill_content_occurrences, 1);
  assert.equal(receipt.final_system_prompt_ends_with_system_skill, true);
  assert.equal(
    validatedSystemSkillActivationReceipt({ value: receipt, expectedName: source.name, expectedPath: source.path }),
    receipt,
  );
  assert.equal(receipt.observation_scope.includes("model_obedience"), true);
});

test("fresh and raw-resume launches reread the current governing source without a prompt snapshot", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-system-skill-reentry-"));
  const cwd = path.join(tmp, "project");
  const skillsRoot = path.join(tmp, "skills");
  const runsDir = path.join(tmp, "runs");
  const configPath = path.join(tmp, "config.json");
  const fake = await createFakePiChild("subagent007-system-skill-reentry-child-");
  await fs.mkdir(cwd, { recursive: true });
  const systemSkillPath = await writeSkill(skillsRoot, "governor", "governor-skill", "GOVERNING SOURCE VERSION ONE");
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));

  await withEnv({
    SUBAGENT007_CONFIG_PATH: configPath,
    SUBAGENT007_PI_CHILD_PATH: fake.childPath,
    FAKE_PI_LOG_PATH: fake.logPath,
    SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
    SUBAGENT007_RUNS_DIR: runsDir,
    SUBAGENT007_INPUT_REQUESTS_DIR: path.join(tmp, "input"),
    SUBAGENT007_PI_RAW_SESSIONS_DIR: path.join(tmp, "pi-sessions"),
    SUBAGENT007_FAILURE_LOG: "off",
  }, async () => {
    const first = await runSubagentCore({
      prompt: "FAST",
      cwd,
      system_skill_name: "governor-skill",
      continuity: { mode: "fresh" },
    }, { allowTimeout: true, runsDir });
    assert.equal(first.success, true);
    assert.ok(first.session_id);
    const firstDigest = first.system_skill_activation_receipt?.content_sha256;
    assert.ok(firstDigest);

    await writeSkill(skillsRoot, "governor", "governor-skill", "GOVERNING SOURCE VERSION TWO");
    const second = await runSubagentCore({
      prompt: "FAST",
      cwd,
      system_skill_name: "governor-skill",
      continuity: { mode: "resume", session_id: first.session_id! },
      recursive_delegation: "disabled",
    }, { allowTimeout: true, runsDir });
    assert.equal(second.success, true);
    assert.notEqual(second.system_skill_activation_receipt?.content_sha256, firstDigest);
    assert.equal(
      second.system_skill_activation_receipt?.content_sha256,
      createHash("sha256").update(await fs.readFile(systemSkillPath)).digest("hex"),
    );
    const logs = await readJsonl<{ request: { expectedSystemSkillPath?: string } }>(fake.logPath);
    assert.deepEqual(logs.map((entry) => entry.request.expectedSystemSkillPath), [systemSkillPath, systemSkillPath]);
  });
});

test("system_skill_name must differ from the ordinary specialist and is absent from model-controlled delegate parameters", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-system-skill-validation-"));
  await assert.rejects(
    validateAndResolveRequest({
      prompt: "Do work",
      cwd: tmp,
      skill_name: "same-skill",
      system_skill_name: "same-skill",
    }, { default_model_class: "C" }),
    /must differ from skill_name/,
  );
  await assert.rejects(
    validateAndResolveRequest({
      prompt: "Do work",
      cwd: tmp,
      system_skill_name: "governor-skill",
      effect_profile: "workspace_read_only",
    }, { default_model_class: "C" }),
    (error: unknown) => (error as { reasonCode?: string }).reasonCode === "effect_profile_unsupported",
  );

  const tool = createRecursiveDelegateTool({
    cwd: tmp,
    recursiveControl: {
      socket_path: path.join(tmp, "control.sock"),
      token: "test-token",
      parent_run_id: "parent",
      root_run_id: "root",
      recursion_depth: 0,
      system_skill_name: "governor-skill",
    },
  });
  assert.ok(tool);
  const schema = tool.parameters as unknown as { properties?: Record<string, unknown> };
  assert.equal(Object.hasOwn(schema.properties ?? {}, "system_skill_name"), false);
  assert.equal(Object.hasOwn(schema.properties ?? {}, "model_class"), false);

  const genericTool = createRecursiveDelegateTool({
    cwd: tmp,
    recursiveControl: {
      socket_path: path.join(tmp, "generic-control.sock"),
      token: "generic-test-token",
      parent_run_id: "generic-parent",
      root_run_id: "generic-root",
      recursion_depth: 0,
    },
  });
  assert.ok(genericTool);
  const genericSchema = genericTool.parameters as unknown as { properties?: Record<string, unknown> };
  assert.equal(Object.hasOwn(genericSchema.properties ?? {}, "model_class"), true);
});
