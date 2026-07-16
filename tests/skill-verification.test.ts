import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalSkillBindingVerificationRequestSha256,
  verifySkillBindingsRequest,
} from "../src/skillVerification.js";
import { sha256File } from "./helpers/testUtils.js";

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
    ].join("\n"),
  );
  return skillPath;
}

test("skill binding request digest has a stable domain-separated known vector", () => {
  assert.equal(
    canonicalSkillBindingVerificationRequestSha256({
      contract_version: 1,
      cwd: "/workspace",
      bindings: [
        { skill_name: "alpha", expected_skill_sha256: "a".repeat(64) },
        { skill_name: "beta", expected_skill_sha256: "b".repeat(64) },
      ],
    }),
    "7574ec6f7984700d1d7ad01783cefd556374519c7a9039dd384b07ad74930181",
  );
});

test("batch verification resolves one catalog and returns exact canonical paths and hashes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-verification-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const skillsRoot = path.join(tmp, "skills");
  await fs.mkdir(cwd, { recursive: true });
  const alphaPath = await writeSkill(skillsRoot, "alpha", "alpha");
  const betaPath = await writeSkill(skillsRoot, "beta", "beta");
  const alphaDigest = await sha256File(alphaPath);
  const betaDigest = await sha256File(betaPath);

  const result = await verifySkillBindingsRequest({
    contract_version: 1,
    cwd,
    bindings: [
      { skill_name: "alpha", expected_skill_sha256: alphaDigest },
      { skill_name: "beta", expected_skill_sha256: betaDigest },
    ],
  }, { agentDir, lookupPaths: [skillsRoot] });

  assert.equal(result.kind, "skill_bindings_verified");
  assert.equal(result.verified, true);
  if (result.kind !== "skill_bindings_verified") throw new Error("expected verified bindings");
  assert.deepEqual(result.bindings, [
    {
      skill_name: "alpha",
      expected_skill_sha256: alphaDigest,
      resolved_skill_path: alphaPath,
      resolved_skill_sha256: alphaDigest,
    },
    {
      skill_name: "beta",
      expected_skill_sha256: betaDigest,
      resolved_skill_path: betaPath,
      resolved_skill_sha256: betaDigest,
    },
  ]);
});

test("batch verification distinguishes unknown, ambiguous, unreadable, and mismatched skills", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-verification-errors-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const firstRoot = path.join(tmp, "skills-a");
  const secondRoot = path.join(tmp, "skills-b");
  await fs.mkdir(cwd, { recursive: true });
  const uniquePath = await writeSkill(firstRoot, "unique", "unique-skill");
  const uniqueDigest = await sha256File(uniquePath);
  await writeSkill(firstRoot, "duplicate-a", "duplicate-skill");
  await writeSkill(secondRoot, "duplicate-b", "duplicate-skill");

  const unknown = await verifySkillBindingsRequest({
    contract_version: 1,
    cwd,
    bindings: [{ skill_name: "missing-skill", expected_skill_sha256: "a".repeat(64) }],
  }, { agentDir, lookupPaths: [firstRoot, secondRoot] });
  assert.equal(unknown.kind, "skill_binding_verification_rejected");
  if (unknown.kind !== "skill_binding_verification_rejected") throw new Error("expected rejection");
  assert.equal(unknown.reason_code, "skill_not_found");

  const ambiguous = await verifySkillBindingsRequest({
    contract_version: 1,
    cwd,
    bindings: [{ skill_name: "duplicate-skill", expected_skill_sha256: "a".repeat(64) }],
  }, { agentDir, lookupPaths: [firstRoot, secondRoot] });
  assert.equal(ambiguous.kind, "skill_binding_verification_rejected");
  if (ambiguous.kind !== "skill_binding_verification_rejected") throw new Error("expected rejection");
  assert.equal(ambiguous.reason_code, "skill_ambiguous");

  const unreadable = await verifySkillBindingsRequest({
    contract_version: 1,
    cwd,
    bindings: [{ skill_name: "unique-skill", expected_skill_sha256: uniqueDigest }],
  }, {
    agentDir,
    lookupPaths: [firstRoot],
    readFile: async () => { throw new Error("fixture read failure"); },
  });
  assert.equal(unreadable.kind, "skill_binding_verification_rejected");
  if (unreadable.kind !== "skill_binding_verification_rejected") throw new Error("expected rejection");
  assert.equal(unreadable.reason_code, "skill_unreadable");

  const mismatch = await verifySkillBindingsRequest({
    contract_version: 1,
    cwd,
    bindings: [{ skill_name: "unique-skill", expected_skill_sha256: "0".repeat(64) }],
  }, { agentDir, lookupPaths: [firstRoot] });
  assert.equal(mismatch.kind, "skill_binding_verification_rejected");
  if (mismatch.kind !== "skill_binding_verification_rejected") throw new Error("expected rejection");
  assert.equal(mismatch.reason_code, "skill_content_mismatch");
});
