import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalSkillBindingResolutionRequestSha256,
  resolveSkillBindingsRequest,
} from "../src/skillResolution.js";
import { sha256File } from "./helpers/testUtils.js";

async function writeSkill(root: string, dirname: string, name: string): Promise<string> {
  const skillPath = path.join(root, dirname, "SKILL.md");
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: Test skill\n---\n# ${name}\n`);
  return skillPath;
}

test("skill resolution request digest has a stable domain-separated known vector", () => {
  assert.equal(canonicalSkillBindingResolutionRequestSha256({
    contract_version: 1,
    cwd: "/workspace",
    skill_names: ["alpha", "beta"],
  }), "bde92f3df6490a6b9bfa28454771f883c303ab4d9d5844cfc091d8074ed91581");
});

test("skill resolution binds the full canonical request and returns exact paths and hashes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-resolution-"));
  const cwd = path.join(tmp, "project");
  const skillsRoot = path.join(tmp, "skills");
  await fs.mkdir(cwd, { recursive: true });
  const alphaPath = await writeSkill(skillsRoot, "alpha", "alpha");
  const betaPath = await writeSkill(skillsRoot, "beta", "beta");
  const request = { contract_version: 1 as const, cwd, skill_names: ["alpha", "beta"] };

  const result = await resolveSkillBindingsRequest(request, {
    agentDir: path.join(tmp, "agent"),
    lookupPaths: [skillsRoot],
  });

  assert.equal(result.kind, "skill_bindings_resolved");
  if (result.kind !== "skill_bindings_resolved") throw new Error("expected success");
  assert.deepEqual(result.request_binding, {
    cwd,
    count: 2,
    canonical_request_sha256: canonicalSkillBindingResolutionRequestSha256(request),
  });
  assert.deepEqual(result.bindings, [
    { skill_name: "alpha", resolved_skill_path: alphaPath, resolved_skill_sha256: await sha256File(alphaPath) },
    { skill_name: "beta", resolved_skill_path: betaPath, resolved_skill_sha256: await sha256File(betaPath) },
  ]);
  assert.equal(result.child_started, false);
  assert.equal(result.model_invoked, false);
});

test("skill resolution is all-or-nothing with typed cwd and skill rejection", async () => {
  const request = { contract_version: 1 as const, cwd: "relative", skill_names: ["alpha"] };
  const cwdFailure = await resolveSkillBindingsRequest(request);
  assert.equal(cwdFailure.kind, "skill_binding_resolution_rejected");
  if (cwdFailure.kind !== "skill_binding_resolution_rejected") throw new Error("expected rejection");
  assert.equal(cwdFailure.reason_code, "cwd_not_absolute");
  assert.equal("failed_skill" in cwdFailure, false);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-resolution-fail-"));
  const cwd = path.join(tmp, "project");
  await fs.mkdir(cwd);
  const missing = await resolveSkillBindingsRequest(
    { contract_version: 1, cwd, skill_names: ["missing"] },
    { agentDir: path.join(tmp, "agent"), lookupPaths: [path.join(tmp, "skills")] },
  );
  assert.equal(missing.kind, "skill_binding_resolution_rejected");
  if (missing.kind !== "skill_binding_resolution_rejected") throw new Error("expected rejection");
  assert.equal(missing.reason_code, "skill_not_found");
  assert.deepEqual(missing.failed_skill, { index: 0, skill_name: "missing" });
});
