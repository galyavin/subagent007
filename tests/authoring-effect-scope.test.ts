import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertAuthoringEffectScopeTerminal,
  assertAuthoringEffectScopeBinding,
  boundedProfileStateRoot,
  captureAuthoringEffectScope,
  MAX_AUTHORING_INITIAL_FILE_BYTES,
  MAX_AUTHORING_WRITABLE_FILE_BYTES,
  MAX_AUTHORING_WRITABLE_TOTAL_BYTES,
} from "../src/authoringEffectScope.js";
import { createBoundedControllerTool, resolveBoundedControllerPython } from "../src/boundedController.js";
import { canonicalClientStartRequestSha256 } from "../src/clientStartAdmission.js";
import { runSubagentCore } from "../src/runSubagent.js";
import { publishSkillSnapshotsRequest, resolveSkillRuntimeBundlesRequest } from "../src/skillSnapshot.js";
import { createTaskRootAuthoringTools } from "../src/taskRootAuthoringTools.js";
import { validateAndResolveRequest } from "../src/validate.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { withEnv } from "./helpers/testUtils.js";

async function tempTaskRoot(prefix: string): Promise<{ parent: string; root: string }> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const root = path.join(parent, "task");
  await fs.mkdir(root);
  return { parent, root };
}

async function makeTreeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    await fs.chmod(target, 0o644).catch(() => undefined);
    return;
  }
  await fs.chmod(target, 0o755).catch(() => undefined);
  for (const entry of await fs.readdir(target).catch(() => [])) {
    await makeTreeWritable(path.join(target, entry));
  }
}

test("task_root_authoring_v1 requires canonical sorted exact allowed output paths", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-schema-");
  try {
    const first = path.join(fixture.root, "bundle", "SKILL.md");
    const second = path.join(fixture.root, "bundle", "tests", "contract.test.ts");
    await assert.rejects(
      () => validateAndResolveRequest({
        cwd: fixture.root,
        prompt: "author",
        effect_profile: "task_root_authoring_v1",
      }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid",
    );
    await assert.rejects(
      () => validateAndResolveRequest({
        cwd: fixture.root,
        prompt: "author",
        effect_profile: "task_root_authoring_v1",
        allowed_output_paths: [second, first],
      }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid",
    );
    await assert.rejects(
      () => validateAndResolveRequest({
        cwd: fixture.root,
        prompt: "author",
        effect_profile: "task_root_authoring_v1",
        allowed_output_paths: [path.join(fixture.parent, "outside.md")],
      }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid",
    );
    const resolved = await validateAndResolveRequest({
      cwd: fixture.root,
      prompt: "author",
      effect_profile: "task_root_authoring_v1",
      allowed_output_paths: [first, second],
    }, {});
    assert.deepEqual(resolved.allowedOutputPaths, [first, second]);
    await assert.rejects(
      () => validateAndResolveRequest({
        cwd: fixture.root,
        prompt: "legacy",
        effect_profile: "skill_creator_authoring_v1",
        allowed_output_paths: [],
      }, {}),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid",
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("neutral authoring guard permits only exact outputs and makes captured inputs non-writable", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-tools-");
  try {
    const input = path.join(fixture.root, "input.json");
    const output = path.join(fixture.root, "bundle", "SKILL.md");
    await fs.writeFile(input, "original\n");
    const captured = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "task_root_authoring_v1",
      recursiveDelegation: "disabled",
      allowedOutputPaths: [output],
    });
    const tools = createTaskRootAuthoringTools(
      fixture.root,
      undefined,
      ["read", "write"],
      captured.binding,
    );
    const write = tools.find((tool) => tool.name === "write")!;
    const context = {} as never;
    await assert.rejects(
      () => write.execute("input-substitute", { path: input, content: "substitute\n" }, undefined, undefined, context),
      /immutable|writable scope|declared output/i,
    );
    assert.equal(await fs.readFile(input, "utf8"), "original\n");
    await assert.rejects(
      () => write.execute("undeclared", { path: path.join(fixture.root, "extra.md"), content: "extra\n" }, undefined, undefined, context),
      /writable scope|declared output/i,
    );
    const oversizedPayload = "x".repeat(MAX_AUTHORING_WRITABLE_FILE_BYTES + 1);
    await assert.rejects(
      () => write.execute("oversized-write", { path: output, content: oversizedPayload }, undefined, undefined, context),
      /payload exceeds/i,
    );
    await assert.rejects(fs.lstat(output), { code: "ENOENT" });
    await write.execute("declared", { path: output, content: "# Skill\n" }, undefined, undefined, context);
    await assertAuthoringEffectScopeTerminal(captured);
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("mutation payload cap applies only to effect-scoped tools and preserves legacy creator parity", async () => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-effect-scope-payload-parity-")));
  const legacyRoot = path.join(parent, "legacy");
  const neutralRoot = path.join(parent, "neutral");
  await fs.mkdir(legacyRoot);
  await fs.mkdir(neutralRoot);
  try {
    const payload = "x".repeat(MAX_AUTHORING_WRITABLE_FILE_BYTES + 1);
    const legacyOutput = path.join(legacyRoot, "large.txt");
    const legacyWrite = createTaskRootAuthoringTools(legacyRoot, undefined, ["write"])[0]!;
    await legacyWrite.execute("legacy-large-write", {
      path: legacyOutput,
      content: payload,
    }, undefined, undefined, {} as never);
    assert.equal((await fs.stat(legacyOutput)).size, Buffer.byteLength(payload));

    const neutralOutput = path.join(neutralRoot, "large.txt");
    const captured = await captureAuthoringEffectScope({
      taskRoot: neutralRoot,
      effectProfile: "task_root_authoring_v1",
      recursiveDelegation: "disabled",
      allowedOutputPaths: [neutralOutput],
    });
    const neutralWrite = createTaskRootAuthoringTools(
      neutralRoot,
      undefined,
      ["write"],
      captured.binding,
    )[0]!;
    await assert.rejects(
      () => neutralWrite.execute("neutral-large-write", {
        path: neutralOutput,
        content: payload,
      }, undefined, undefined, {} as never),
      /payload exceeds/i,
    );
    await assert.rejects(fs.lstat(neutralOutput), { code: "ENOENT" });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("neutral authoring may create declared outputs sequentially before terminal closure", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-sequential-outputs-");
  try {
    const first = path.join(fixture.root, "bundle", "SKILL.md");
    const second = path.join(fixture.root, "bundle", "references", "guide.md");
    const captured = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "task_root_authoring_v1",
      recursiveDelegation: "disabled",
      allowedOutputPaths: [first, second],
    });
    const write = createTaskRootAuthoringTools(
      fixture.root,
      undefined,
      ["write"],
      captured.binding,
    )[0]!;
    await write.execute("first", { path: first, content: "# Skill\n" }, undefined, undefined, {} as never);
    await write.execute("second", { path: second, content: "guide\n" }, undefined, undefined, {} as never);
    await assertAuthoringEffectScopeTerminal(captured);
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("authoring preflight rejects materially sparse regular inputs", async (t) => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-sparse-");
  try {
    const sparse = path.join(fixture.root, "sparse-input.bin");
    const handle = await fs.open(sparse, "w");
    try {
      await handle.truncate(8 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    const stat = await fs.stat(sparse);
    const allocatedBytes = (stat.blocks ?? 0) * 512;
    if (stat.blocks === undefined || allocatedBytes >= stat.size / 2) {
      t.skip("fixture filesystem did not create a materially sparse extent");
      return;
    }
    await assert.rejects(
      () => captureAuthoringEffectScope({
        taskRoot: fixture.root,
        effectProfile: "task_root_authoring_v1",
        recursiveDelegation: "disabled",
        allowedOutputPaths: [],
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid" && /sparse/i.test(String((error as Error).message)),
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("authoring preflight rejects an oversized regular input before reading", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-oversize-");
  try {
    const oversized = path.join(fixture.root, "oversized-input.bin");
    const handle = await fs.open(oversized, "w");
    try {
      await handle.truncate(MAX_AUTHORING_INITIAL_FILE_BYTES + 1);
    } finally {
      await handle.close();
    }
    await assert.rejects(
      () => captureAuthoringEffectScope({
        taskRoot: fixture.root,
        effectProfile: "task_root_authoring_v1",
        recursiveDelegation: "disabled",
        allowedOutputPaths: [],
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid" && /bounded regular file/i.test(String((error as Error).message)),
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("bounded preflight rejects a writable-state hardlink alias to immutable input", async (t) => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-hardlink-");
  try {
    const input = path.join(fixture.root, "semantic-input.json");
    const stateRoot = boundedProfileStateRoot(fixture.root, "researcher_bounded_v1");
    const alias = path.join(stateRoot, "input-alias.json");
    await fs.writeFile(input, "immutable\n");
    await fs.mkdir(stateRoot, { recursive: true });
    try {
      await fs.link(input, alias);
    } catch (error) {
      if (["EPERM", "EOPNOTSUPP", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("fixture filesystem does not support hardlinks");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => captureAuthoringEffectScope({
        taskRoot: fixture.root,
        effectProfile: "researcher_bounded_v1",
        recursiveDelegation: "disabled",
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid" && /hardlink|link count/i.test(String((error as Error).message)),
    );
    assert.equal(await fs.readFile(input, "utf8"), "immutable\n");
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("bounded profile state root must be absent before parent and child pre-prompt capture", async (t) => {
  for (const mode of ["stale-file", "symlink", "hardlink"] as const) {
    const fixture = await tempTaskRoot(`subagent007-effect-scope-stale-state-${mode}-`);
    try {
      const input = path.join(fixture.root, "semantic-input.json");
      const stateRoot = boundedProfileStateRoot(fixture.root, "researcher_bounded_v1");
      await fs.writeFile(input, "immutable\n");
      if (mode === "symlink") {
        await fs.mkdir(path.dirname(stateRoot), { recursive: true });
        await fs.symlink(fixture.parent, stateRoot);
      } else {
        await fs.mkdir(stateRoot, { recursive: true });
        if (mode === "stale-file") {
          await fs.writeFile(path.join(stateRoot, "caller-state.json"), "{}\n");
        } else {
          try {
            await fs.link(input, path.join(stateRoot, "input-alias.json"));
          } catch (error) {
            if (["EPERM", "EOPNOTSUPP", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
              t.diagnostic("fixture filesystem does not support hardlinks; stale-file and symlink cases remain decisive");
              continue;
            }
            throw error;
          }
        }
      }
      await assert.rejects(
        () => captureAuthoringEffectScope({
          taskRoot: fixture.root,
          effectProfile: "researcher_bounded_v1",
          recursiveDelegation: "disabled",
        }),
        (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid" && /state root.*absent/i.test(String((error as Error).message)),
        mode,
      );
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("bounded child pre-prompt recapture rejects state created after the parent capture", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-child-stale-state-");
  try {
    await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    const stateRoot = boundedProfileStateRoot(fixture.root, "researcher_bounded_v1");
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(path.join(stateRoot, "injected.json"), "{}\n");
    await assert.rejects(
      () => captureAuthoringEffectScope({
        taskRoot: fixture.root,
        effectProfile: "researcher_bounded_v1",
        recursiveDelegation: "disabled",
      }),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_invalid" && /state root.*absent/i.test(String((error as Error).message)),
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("terminal writable closure rejects oversized and sparse neutral outputs and bounded state", async (t) => {
  for (const scope of ["neutral", "bounded"] as const) {
    for (const mode of ["oversized", "sparse"] as const) {
      const fixture = await tempTaskRoot(`subagent007-effect-scope-writable-${scope}-${mode}-`);
      try {
        const target = scope === "neutral"
          ? path.join(fixture.root, "bundle", "SKILL.md")
          : path.join(boundedProfileStateRoot(fixture.root, "researcher_bounded_v1"), "job.json");
        const captured = await captureAuthoringEffectScope({
          taskRoot: fixture.root,
          effectProfile: scope === "neutral" ? "task_root_authoring_v1" : "researcher_bounded_v1",
          recursiveDelegation: "disabled",
          ...(scope === "neutral" ? { allowedOutputPaths: [target] } : {}),
        });
        await fs.mkdir(path.dirname(target), { recursive: true });
        const handle = await fs.open(target, "w");
        try {
          await handle.truncate(mode === "oversized" ? MAX_AUTHORING_WRITABLE_FILE_BYTES + 1 : 8 * 1024 * 1024);
        } finally {
          await handle.close();
        }
        if (mode === "sparse") {
          const stat = await fs.stat(target);
          const allocatedBytes = (stat.blocks ?? 0) * 512;
          if (stat.blocks === undefined || allocatedBytes >= stat.size / 2) {
            t.diagnostic(`fixture filesystem did not create a materially sparse ${scope} file`);
            continue;
          }
        }
        await assert.rejects(
          () => assertAuthoringEffectScopeTerminal(captured),
          (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_drift" && new RegExp(mode === "oversized" ? "bounded|size" : "sparse", "i").test(String((error as Error).message)),
          `${scope}-${mode}`,
        );
      } finally {
        await fs.rm(fixture.parent, { recursive: true, force: true });
      }
    }
  }
});

test("terminal writable closure enforces a separate aggregate logical-size cap", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-writable-total-");
  try {
    const stateRoot = boundedProfileStateRoot(fixture.root, "researcher_bounded_v1");
    const captured = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    await fs.mkdir(stateRoot, { recursive: true });
    const fileBytes = Math.floor(MAX_AUTHORING_WRITABLE_TOTAL_BYTES / 3) + 1;
    assert.ok(fileBytes <= MAX_AUTHORING_WRITABLE_FILE_BYTES);
    const bytes = Buffer.alloc(fileBytes, 0x61);
    await Promise.all(["a.bin", "b.bin", "c.bin"].map((name) => fs.writeFile(path.join(stateRoot, name), bytes)));
    await assert.rejects(
      () => assertAuthoringEffectScopeTerminal(captured),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_drift" && /writable.*total|aggregate/i.test(String((error as Error).message)),
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("effect-scope binding profile and writable-scope shape are exact", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-binding-");
  try {
    const neutral = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "task_root_authoring_v1",
      recursiveDelegation: "disabled",
      allowedOutputPaths: [],
    });
    assert.doesNotThrow(() => assertAuthoringEffectScopeBinding(neutral.binding));
    assert.throws(
      () => assertAuthoringEffectScopeBinding({
        ...neutral.binding,
        writable_scope: {
          kind: "fixed_state_subtree",
          paths: [path.join(fixture.root, ".subagent007", "researcher_bounded_v1")],
        },
      }),
      /binding|scope|profile/i,
    );
    const bounded = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    assert.doesNotThrow(() => assertAuthoringEffectScopeBinding(bounded.binding));
    assert.throws(
      () => assertAuthoringEffectScopeBinding({
        ...bounded.binding,
        writable_scope: { kind: "exact_output_files", paths: [] },
      }),
      /binding|scope|profile/i,
    );
    assert.throws(
      () => assertAuthoringEffectScopeBinding({
        ...bounded.binding,
        writable_scope: {
          kind: "fixed_state_subtree",
          paths: [path.join(fixture.root, ".subagent007", "wrong-profile")],
        },
      }),
      /binding|scope|profile/i,
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("neutral terminal closure rejects missing outputs, extras, leaf swaps, and parent swaps", async () => {
  for (const mode of ["missing", "extra", "leaf-swap", "parent-swap"] as const) {
    const fixture = await tempTaskRoot(`subagent007-effect-scope-${mode}-`);
    try {
      const inputDir = path.join(fixture.root, "inputs");
      const input = path.join(inputDir, "request.json");
      const output = path.join(fixture.root, "bundle", "SKILL.md");
      await fs.mkdir(inputDir);
      await fs.writeFile(input, "same bytes\n");
      const captured = await captureAuthoringEffectScope({
        taskRoot: fixture.root,
        effectProfile: "task_root_authoring_v1",
        recursiveDelegation: "disabled",
        allowedOutputPaths: [output],
      });
      if (mode !== "missing") {
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, "# Skill\n");
      }
      if (mode === "extra") {
        await fs.writeFile(path.join(fixture.root, "extra.md"), "undeclared\n");
      } else if (mode === "leaf-swap") {
        const replacement = path.join(inputDir, "replacement");
        await fs.writeFile(replacement, "same bytes\n");
        await fs.rename(replacement, input);
      } else if (mode === "parent-swap") {
        const moved = path.join(fixture.root, "inputs-original");
        await fs.rename(inputDir, moved);
        await fs.mkdir(inputDir);
        await fs.writeFile(input, "same bytes\n");
      }
      await assert.rejects(
        () => assertAuthoringEffectScopeTerminal(captured),
        (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_drift",
        mode,
      );
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
    }
  }
});

test("neutral runtime emits bound v2 activation evidence and terminalizes child-side closure drift", async () => {
  for (const mode of ["success", "missing", "extra", "leaf-swap", "parent-swap"] as const) {
    const fixture = await tempTaskRoot(`subagent007-effect-scope-runtime-${mode}-`);
    const fake = await createFakePiChild(`subagent007-effect-scope-runtime-child-${mode}-`);
    try {
      const output = path.join(fixture.root, "bundle", "SKILL.md");
      if (mode === "parent-swap") {
        await fs.mkdir(path.join(fixture.root, "inputs"));
        await fs.writeFile(path.join(fixture.root, "inputs", "request.json"), "same bytes\n");
      } else {
        await fs.writeFile(path.join(fixture.root, "input.txt"), "same bytes\n");
      }
      const prompt = {
        success: "AUTHORING_WRITE_OUTPUT",
        missing: "FAST",
        extra: "AUTHORING_EXTRA_OUTPUT",
        "leaf-swap": "AUTHORING_SWAP_INPUT_LEAF",
        "parent-swap": "AUTHORING_SWAP_INPUT_PARENT",
      }[mode];
      const result = await withEnv({
        SUBAGENT007_PI_CHILD_PATH: fake.childPath,
        FAKE_PI_LOG_PATH: fake.logPath,
        SUBAGENT007_FAILURE_LOG: "off",
      }, () => runSubagentCore({
        cwd: fixture.root,
        prompt,
        effect_profile: "task_root_authoring_v1",
        allowed_output_paths: [output],
      }, { runsDir: path.join(fixture.parent, "runs") }));
      assert.equal(result.activation_receipt?.schema_version, 2);
      assert.equal(result.activation_receipt?.effect_scope_binding?.task_root, fixture.root);
      assert.deepEqual(result.activation_receipt?.effect_scope_binding?.writable_scope, {
        kind: "exact_output_files",
        paths: [output],
      });
      if (mode === "success") {
        assert.equal(result.status, "completed", JSON.stringify(result));
      } else {
        assert.equal(result.status, "failed", `${mode}: ${JSON.stringify(result)}`);
        assert.equal(result.reason_code, "authoring_effect_scope_drift", mode);
      }
    } finally {
      await fs.rm(fixture.parent, { recursive: true, force: true });
      await fs.rm(path.dirname(fake.childPath), { recursive: true, force: true });
    }
  }
});

test("authoring terminal reinspection rejects immutable skill snapshot mutation", async () => {
  const fixture = await tempTaskRoot("subagent007-effect-scope-snapshot-");
  const skillsRoot = path.join(fixture.parent, "skills");
  const snapshotsRoot = path.join(fixture.parent, "snapshots");
  const configPath = path.join(fixture.parent, "config.json");
  const skillName = "effect-scope-snapshot-fixture";
  const skillRoot = path.join(skillsRoot, skillName);
  const fake = await createFakePiChild("subagent007-effect-scope-snapshot-child-");
  try {
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), `---\nname: ${skillName}\ndescription: fixture\n---\n# Fixture\n`);
    await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }));
    const resolved = await resolveSkillRuntimeBundlesRequest(
      { contract_version: 1, cwd: fixture.root, skill_names: [skillName] },
      { lookupPaths: [skillsRoot] },
    );
    assert.equal(resolved.kind, "skill_runtime_bundles_resolved");
    if (resolved.kind !== "skill_runtime_bundles_resolved") throw new Error("fixture bundle did not resolve");
    const published = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd: fixture.root,
      project_reference: { project_id: "effect-scope", publication_id: "snapshot-drift", lifecycle: "active" },
      bindings: [{
        skill_name: skillName,
        expected_bundle_sha256: resolved.bindings[0]!.bundle_sha256,
      }],
    }, { lookupPaths: [skillsRoot], snapshotsRoot });
    assert.equal(published.kind, "skill_snapshots_published");
    if (published.kind !== "skill_snapshots_published") throw new Error("fixture snapshot did not publish");
    const item = published.bindings[0]!;
    const binding = {
      contract_version: 1 as const,
      snapshot_id: item.snapshot_identity.snapshot_id,
      metadata_sha256: item.snapshot_identity.metadata_sha256,
      publication_receipt_sha256: item.publication_receipt.receipt_sha256,
      reference_id: item.publication_receipt.reference_id,
      project_id: item.publication_receipt.project_reference.project_id,
      publication_id: item.publication_receipt.project_reference.publication_id,
    };
    const result = await withEnv({
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: snapshotsRoot,
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
    }, () => runSubagentCore({
      cwd: fixture.root,
      prompt: "MUTATE_SKILL_SNAPSHOT_AFTER_ACTIVATION",
      skill_name: skillName,
      skill_snapshot_binding: binding,
      effect_profile: "task_root_authoring_v1",
      allowed_output_paths: [],
    }, { runsDir: path.join(fixture.parent, "runs") }));
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.reason_code, "authoring_effect_scope_drift");
  } finally {
    await makeTreeWritable(fixture.parent);
    await fs.rm(fixture.parent, { recursive: true, force: true });
    await fs.rm(path.dirname(fake.childPath), { recursive: true, force: true });
  }
});

test("bounded profiles own one fixed state subtree and keep the remaining task tree immutable", async () => {
  const fixture = await tempTaskRoot("subagent007-bounded-state-scope-");
  try {
    const input = path.join(fixture.root, "semantic-input.json");
    await fs.writeFile(input, "bound input\n");
    const captured = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    const expectedStateRoot = path.join(fixture.root, ".subagent007", "researcher_bounded_v1");
    assert.equal(boundedProfileStateRoot(fixture.root, "researcher_bounded_v1"), expectedStateRoot);
    assert.deepEqual(captured.binding.writable_scope, {
      kind: "fixed_state_subtree",
      paths: [expectedStateRoot],
    });
    const tools = createTaskRootAuthoringTools(
      fixture.root,
      undefined,
      ["read", "write", "edit"],
      captured.binding,
    );
    const write = tools.find((tool) => tool.name === "write")!;
    const edit = tools.find((tool) => tool.name === "edit")!;
    const context = {} as never;
    await write.execute("state", { path: path.join(expectedStateRoot, "job.json"), content: "{}\n" }, undefined, undefined, context);
    await assert.rejects(
      () => write.execute("outside-state", { path: input, content: "changed\n" }, undefined, undefined, context),
      /state subtree|writable scope|immutable/i,
    );
    await assert.rejects(
      () => edit.execute("outside-state-edit", {
        path: input,
        edits: [{ oldText: "bound input", newText: "transient substitute" }],
      }, undefined, undefined, context),
      /state subtree|writable scope|immutable/i,
    );
    assert.equal(await fs.readFile(input, "utf8"), "bound input\n");
    await assertAuthoringEffectScopeTerminal(captured);
    await fs.writeFile(path.join(fixture.root, "undeclared-outside-state.txt"), "bad\n");
    await assert.rejects(
      () => assertAuthoringEffectScopeTerminal(captured),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_drift",
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("terminal effect-scope reinspection runs after mutation followed by failure or cancellation", async () => {
  for (const mode of ["failure", "cancel"] as const) {
    const fixture = await tempTaskRoot(`subagent007-effect-scope-terminal-${mode}-`);
    const fake = await createFakePiChild(`subagent007-effect-scope-terminal-child-${mode}-`);
    const abortController = new AbortController();
    try {
      const input = path.join(fixture.root, "input.txt");
      await fs.writeFile(input, "original\n");
      const run = withEnv({
        SUBAGENT007_PI_CHILD_PATH: fake.childPath,
        FAKE_PI_LOG_PATH: fake.logPath,
        SUBAGENT007_FAILURE_LOG: "off",
      }, () => runSubagentCore({
        cwd: fixture.root,
        prompt: mode === "failure" ? "AUTHORING_MUTATE_THEN_FAIL" : "AUTHORING_MUTATE_THEN_CANCEL_WAIT",
        effect_profile: "task_root_authoring_v1",
        allowed_output_paths: [],
      }, {
        runsDir: path.join(fixture.parent, "runs"),
        abortSignal: abortController.signal,
      }));
      if (mode === "cancel") {
        const deadline = Date.now() + 5_000;
        while (await fs.readFile(input, "utf8") === "original\n") {
          if (Date.now() >= deadline) throw new Error("fake child did not mutate the input before cancellation");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        abortController.abort();
      }
      const result = await run;
      assert.equal(result.status, mode === "cancel" ? "cancelled" : "failed", JSON.stringify(result));
      assert.equal(result.stop_reason, mode === "cancel" ? "cancelled" : "failed");
      assert.equal(result.reason_code, "authoring_effect_scope_drift");
    } finally {
      abortController.abort();
      await fs.rm(fixture.parent, { recursive: true, force: true });
      await fs.rm(path.dirname(fake.childPath), { recursive: true, force: true });
    }
  }
});

test("controller mutation paths stay in the fixed profile state subtree while read paths may use inputs", async () => {
  const fixture = await tempTaskRoot("subagent007-controller-state-scope-");
  const runtime = path.join(fixture.parent, "runtime", "scripts");
  try {
    await fs.mkdir(runtime, { recursive: true });
    const researcherScript = path.join(runtime, "researchctl.py");
    const ajScript = path.join(runtime, "aj.py");
    await fs.writeFile(researcherScript, "import sys\nprint('|'.join(sys.argv[1:]))\n");
    await fs.writeFile(ajScript, "import sys\nprint('|'.join(sys.argv[1:]))\n");
    const input = path.join(fixture.root, "semantic-input.json");
    await fs.writeFile(input, "{}\n");
    const researcher = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    const researchTool = createBoundedControllerTool(
      fixture.root,
      "researchctl",
      researcherScript,
      await resolveBoundedControllerPython("researcher_bounded_v1"),
      researcher.binding,
    );
    await assert.rejects(
      () => researchTool.execute("outside-job", { subcommand: "status", argv: [input] }, undefined, undefined, {} as never),
      /state subtree|writable scope/i,
    );
    const researchState = boundedProfileStateRoot(fixture.root, "researcher_bounded_v1");
    await researchTool.execute("state-job", { subcommand: "status", argv: [path.join(researchState, "job.json")] }, undefined, undefined, {} as never);

    const aj = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "assumption_audit_bounded_v1",
      recursiveDelegation: "disabled",
    });
    const ajTool = createBoundedControllerTool(
      fixture.root,
      "aj_switchboard",
      ajScript,
      await resolveBoundedControllerPython("assumption_audit_bounded_v1"),
      aj.binding,
    );
    await ajTool.execute("read-input", { subcommand: "gate", argv: [input] }, undefined, undefined, {} as never);
    await assert.rejects(
      () => ajTool.execute("outside-root", { subcommand: "run", argv: ["status", "--root", fixture.root] }, undefined, undefined, {} as never),
      /state subtree|writable scope/i,
    );
    const ajState = boundedProfileStateRoot(fixture.root, "assumption_audit_bounded_v1");
    await ajTool.execute("state-root", { subcommand: "run", argv: ["status", "--root", ajState] }, undefined, undefined, {} as never);
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("bounded controller reinspects profile state before returning control", async () => {
  const fixture = await tempTaskRoot("subagent007-controller-writable-reinspection-");
  const runtime = path.join(fixture.parent, "runtime", "scripts");
  try {
    await fs.mkdir(runtime, { recursive: true });
    const researcherScript = path.join(runtime, "researchctl.py");
    await fs.writeFile(researcherScript, [
      "import os, sys",
      "target = sys.argv[2]",
      "os.makedirs(os.path.dirname(target), exist_ok=True)",
      "with open(target, 'wb') as output:",
      `    output.truncate(${MAX_AUTHORING_WRITABLE_FILE_BYTES + 1})`,
      "print('created oversized state')",
    ].join("\n"));
    const captured = await captureAuthoringEffectScope({
      taskRoot: fixture.root,
      effectProfile: "researcher_bounded_v1",
      recursiveDelegation: "disabled",
    });
    const stateFile = path.join(boundedProfileStateRoot(fixture.root, "researcher_bounded_v1"), "job.json");
    const tool = createBoundedControllerTool(
      fixture.root,
      "researchctl",
      researcherScript,
      await resolveBoundedControllerPython("researcher_bounded_v1"),
      captured.binding,
    );
    await assert.rejects(
      () => tool.execute("oversized-state", { subcommand: "status", argv: [stateFile] }, undefined, undefined, {} as never),
      (error: unknown) => (error as { reasonCode?: string }).reasonCode === "authoring_effect_scope_drift" && /bounded logical size/i.test(String((error as Error).message)),
    );
  } finally {
    await fs.rm(fixture.parent, { recursive: true, force: true });
  }
});

test("client_start_id identity binds the exact allowed output closure", () => {
  const base = {
    cwd: "/tmp/task-root",
    prompt: "author",
    effect_profile: "task_root_authoring_v1" as const,
    allowed_output_paths: ["/tmp/task-root/bundle/SKILL.md"],
    client_start_id: "same-key",
  };
  assert.notEqual(
    canonicalClientStartRequestSha256(base),
    canonicalClientStartRequestSha256({
      ...base,
      allowed_output_paths: ["/tmp/task-root/bundle/OTHER.md"],
    }),
  );
});
