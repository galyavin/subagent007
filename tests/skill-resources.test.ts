import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSkillScopedResourceLoader,
  resolveRequestedSkill,
  skillResourcePathsForRequest,
} from "../src/skillResources.js";

async function writeSkill(root: string, dirname: string, name: string): Promise<string> {
  const skillDir = path.join(root, dirname);
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    skillPath,
    [
      "---",
      `name: ${name}`,
      `description: Test skill ${name}`,
      "---",
      "",
      `# ${name}`,
      "",
      "Use only for tests.",
      "",
    ].join("\n"),
    "utf8",
  );
  return skillPath;
}

test("skill-scoped resource loader exposes no ambient skills without a requested skill", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-resources-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await writeSkill(path.join(agentDir, "skills"), "ambient", "ambient-skill");

  const loader = createSkillScopedResourceLoader({ cwd, agentDir });
  await loader.reload();

  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(skillResourcePathsForRequest({ cwd, agentDir }), []);
});

test("skill-scoped resource loader exposes only the requested skill", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-resources-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const skillsRoot = path.join(tmp, "skills");
  await fs.mkdir(cwd, { recursive: true });
  await writeSkill(skillsRoot, "ambient", "ambient-skill");
  const requestedPath = await writeSkill(skillsRoot, "requested", "requested-skill");

  const loader = createSkillScopedResourceLoader({
    cwd,
    agentDir,
    skill: "requested-skill",
    lookupPaths: [skillsRoot],
  });
  await loader.reload();

  const skills = loader.getSkills().skills;
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "requested-skill");
  assert.equal(skills[0].filePath, requestedPath);
});

test("requested skill resolution fails fast for unknown or ambiguous skills", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-resources-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const firstRoot = path.join(tmp, "skills-a");
  const secondRoot = path.join(tmp, "skills-b");
  await fs.mkdir(cwd, { recursive: true });
  await writeSkill(firstRoot, "one", "duplicate-skill");
  await writeSkill(secondRoot, "two", "duplicate-skill");

  assert.throws(
    () => resolveRequestedSkill("missing-skill", { cwd, agentDir, lookupPaths: [firstRoot] }),
    /unknown skill "missing-skill"/,
  );
  assert.throws(
    () => resolveRequestedSkill("duplicate-skill", { cwd, agentDir, lookupPaths: [firstRoot, secondRoot] }),
    /ambiguous/,
  );
});

test("platform-owned .system skills resolve by bare name and remain ambiguous on configured collisions", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-platform-system-skills-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const skillsRoot = path.join(tmp, "skills");
  const systemSkillPath = await writeSkill(path.join(skillsRoot, ".system"), "skill-creator", "skill-creator");
  await fs.mkdir(cwd, { recursive: true });

  const resolved = resolveRequestedSkill("skill-creator", { cwd, agentDir, lookupPaths: [skillsRoot] });
  assert.equal(resolved.filePath, systemSkillPath);

  await writeSkill(skillsRoot, "duplicate", "skill-creator");
  assert.throws(
    () => resolveRequestedSkill("skill-creator", { cwd, agentDir, lookupPaths: [skillsRoot] }),
    /ambiguous/,
  );
});

test("workspace_read_only resource loading excludes ambient extensions and binds only explicit providers", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-resources-extensions-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const explicitExtension = path.join(tmp, "explicit-extension.ts");
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "extensions", "ambient.ts"), "export default () => {};\n");
  await fs.writeFile(path.join(cwd, ".pi", "extensions", "project.ts"), "export default () => {};\n");
  await fs.writeFile(explicitExtension, "export default () => {};\n");

  const loader = createSkillScopedResourceLoader({
    cwd,
    agentDir,
    noAmbientExtensions: true,
    explicitExtensionPaths: [explicitExtension],
  });
  await loader.reload();
  const extensions = loader.getExtensions().extensions;
  assert.equal(extensions.length, 1);
  assert.equal(extensions[0].sourceInfo?.path, explicitExtension);
});
