import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { runtimeReadinessSnapshot } from "../src/runtimeReadiness.js";
import { withEnv } from "./helpers/testUtils.js";

const execFileAsync = promisify(execFile);

async function writeFixtureProject(options: { dist?: boolean } = {}): Promise<{
  root: string;
  serverEntrypoint: string;
  childEntrypoint: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-runtime-readiness-"));
  const srcDir = path.join(root, "src");
  const distDir = path.join(root, "dist");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }), "utf8");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8");
  await fs.writeFile(path.join(root, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json" }), "utf8");
  await fs.writeFile(path.join(srcDir, "server.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(srcDir, "piChild.ts"), "export const value = 2;\n", "utf8");
  const serverEntrypoint = path.join(distDir, "server.js");
  const childEntrypoint = path.join(distDir, "piChild.js");
  if (options.dist !== false) {
    await fs.writeFile(serverEntrypoint, "console.log('server');\n", "utf8");
    await fs.writeFile(childEntrypoint, "console.log('child');\n", "utf8");
  }
  return { root, serverEntrypoint, childEntrypoint };
}

function blockClasses(snapshot: Awaited<ReturnType<typeof runtimeReadinessSnapshot>>): string[] {
  return snapshot.blocks.map((block) => block.class);
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: root });
}

async function commitFixture(root: string): Promise<void> {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "subagent007-test@example.com"]);
  await git(root, ["config", "user.name", "Subagent007 Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
}

test("runtime readiness blocks when the built server entrypoint is missing", async () => {
  const { root, serverEntrypoint } = await writeFixtureProject({ dist: false });
  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "allow_unknown",
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.status, "blocked");
  assert.equal(blockClasses(snapshot).includes("missing_build"), true);
  assert.equal(snapshot.blocks.find((block) => block.class === "missing_build")?.reason_code, "server_entrypoint_missing");
});

test("runtime readiness blocks when the built child entrypoint is missing", async () => {
  const { root, serverEntrypoint, childEntrypoint } = await writeFixtureProject();
  await fs.rm(childEntrypoint);

  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "allow_unknown",
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.status, "blocked");
  assert.equal(blockClasses(snapshot).includes("missing_build"), true);
  assert.equal(snapshot.blocks.find((block) => block.reason_code === "child_entrypoint_missing")?.class, "missing_build");
});

test("runtime readiness honors the configured child entrypoint path", async () => {
  const { root, serverEntrypoint } = await writeFixtureProject();
  const configuredChildEntrypoint = path.join(root, "dist", "configured-missing-piChild.js");

  await withEnv({ SUBAGENT007_PI_CHILD_PATH: configuredChildEntrypoint }, async () => {
    const snapshot = await runtimeReadinessSnapshot({
      projectRoot: root,
      serverEntrypoint,
      processArgv: ["node", serverEntrypoint],
      source_state_policy: "allow_unknown",
    });

    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.status, "blocked");
    assert.equal(snapshot.build.child_entrypoint.path, configuredChildEntrypoint);
    assert.equal(snapshot.build.child_entrypoint_source, "env");
    assert.equal(
      snapshot.blocks.find((block) => block.reason_code === "child_entrypoint_missing")?.evidence?.child_entrypoint,
      configuredChildEntrypoint,
    );
  });
});

test("runtime readiness blocks stale dist output when source is newer", async () => {
  const { root, serverEntrypoint } = await writeFixtureProject();
  const old = new Date(Date.now() - 10_000);
  const fresh = new Date(Date.now());
  await fs.utimes(serverEntrypoint, old, old);
  await fs.utimes(path.join(root, "src", "server.ts"), fresh, fresh);

  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "allow_unknown",
  });

  assert.equal(snapshot.ready, false);
  assert.equal(blockClasses(snapshot).includes("stale_build"), true);
  assert.equal(
    snapshot.blocks.find((block) => block.class === "stale_build")?.reason_code,
    "build_input_newer_than_server_entrypoint",
  );
});

test("runtime readiness blocks when the built child entrypoint is stale", async () => {
  const { root, serverEntrypoint, childEntrypoint } = await writeFixtureProject();
  const old = new Date(Date.now() - 10_000);
  const fresh = new Date(Date.now());
  await fs.utimes(childEntrypoint, old, old);
  await fs.utimes(path.join(root, "src", "piChild.ts"), fresh, fresh);

  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "allow_unknown",
  });

  assert.equal(snapshot.ready, false);
  assert.equal(blockClasses(snapshot).includes("stale_build"), true);
  assert.equal(
    snapshot.blocks.find((block) => block.reason_code === "build_input_newer_than_child_entrypoint")?.class,
    "stale_build",
  );
});

test("runtime readiness reports unknown git source state as a typed block", async () => {
  const { root, serverEntrypoint } = await writeFixtureProject();
  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "require_clean",
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.git.source_state, "unknown");
  assert.equal(blockClasses(snapshot).includes("source_state_unknown"), true);
});

test("runtime readiness reports dirty git source state as a typed block", async () => {
  if (!(await gitAvailable())) {
    return;
  }
  const { root, serverEntrypoint } = await writeFixtureProject();
  await commitFixture(root);
  await fs.writeFile(path.join(root, "README.md"), "dirty\n", "utf8");

  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "require_clean",
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.git.source_state, "dirty");
  assert.equal(blockClasses(snapshot).includes("dirty_source"), true);
});

test("runtime readiness returns a ready snapshot for a clean current build", async () => {
  if (!(await gitAvailable())) {
    return;
  }
  const { root, serverEntrypoint } = await writeFixtureProject();
  await commitFixture(root);

  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "require_clean",
    expected_contract_name: "subagent007.durable_run",
    expected_contract_version: 2,
  });

  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.blocks, []);
  assert.equal(snapshot.contract.compatible, true);
  assert.equal(snapshot.capabilities.public_tools.includes("get_runtime_readiness"), true);
  assert.equal(snapshot.capabilities.public_tools.includes("verify_skill_bindings"), true);
  assert.equal(snapshot.capabilities.public_tools.includes("resolve_skill_bindings"), true);
  assert.equal(snapshot.capabilities.public_tools.includes("validate_skill_runtime_bundle"), true);
  assert.equal(snapshot.capabilities.public_tools.includes("publish_skill_snapshots"), true);
  assert.equal(snapshot.capabilities.public_tools.includes("close_skill_snapshot_references"), true);
  assert.equal(snapshot.capabilities.public_tools.length, 20);
  assert.equal(snapshot.capabilities.durable_run.includes("batch_skill_binding_verification"), true);
  assert.equal(snapshot.capabilities.durable_run.includes("batch_skill_binding_resolution"), true);
  assert.equal(snapshot.capabilities.durable_run.includes("explicit_recursive_delegation"), true);
  assert.equal(snapshot.capabilities.durable_run.includes("terminal_recursive_subtree_closure"), true);
  assert.equal(snapshot.build.child_entrypoint.exists, true);
  assert.deepEqual(
    snapshot.contract.effect_profiles.workspace_read_only.supported_tools,
    ["read", "grep", "find", "ls", "web_search", "web_read", "request_input"],
  );
  assert.deepEqual(
    snapshot.contract.effect_profiles.skill_creator_authoring_v1.supported_tools,
    ["read", "grep", "find", "ls", "write", "edit"],
  );
  assert.equal(snapshot.contract.effect_profiles.skill_creator_authoring_v1.task_root, "exact_run_cwd");
  assert.equal(snapshot.contract.effect_profiles.skill_creator_authoring_v1.task_root_write_scope, "exact_real_run_cwd");
  assert.equal(
    snapshot.contract.effect_profiles.skill_creator_authoring_v1.snapshot_runtime_read_scope,
    "active_validated_snapshot_runtime_root_or_none",
  );
});

test("runtime readiness blocks incompatible durable-run contract expectations", async () => {
  const { root, serverEntrypoint } = await writeFixtureProject();
  const snapshot = await runtimeReadinessSnapshot({
    projectRoot: root,
    serverEntrypoint,
    processArgv: ["node", serverEntrypoint],
    source_state_policy: "allow_unknown",
    expected_contract_name: "subagent007.durable_run",
    expected_contract_version: 999,
  });

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.contract.compatible, false);
  assert.equal(blockClasses(snapshot).includes("incompatible_contract"), true);
});

test("runtime readiness CLI reports missing build before launching MCP", async () => {
  const missingServer = path.join(os.tmpdir(), `subagent007-missing-${Date.now()}`, "dist", "server.js");
  try {
    await execFileAsync(process.execPath, [
      "scripts/check-runtime-readiness.mjs",
      "--server",
      missingServer,
      "--source-state-policy",
      "allow_unknown",
    ], { cwd: path.resolve(".") });
    assert.fail("expected readiness CLI to exit nonzero");
  } catch (error) {
    const failed = error as { stdout?: string };
    const snapshot = JSON.parse(failed.stdout ?? "{}") as {
      ready?: boolean;
      blocks?: Array<{ class?: string; reason_code?: string }>;
    };
    assert.equal(snapshot.ready, false);
    assert.equal(snapshot.blocks?.[0]?.class, "missing_build");
    assert.equal(snapshot.blocks?.[0]?.reason_code, "server_entrypoint_missing");
  }
});
