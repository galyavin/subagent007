import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { readJsonl } from "./helpers/testUtils.js";

test("bounded researcher profile activates through every supported start surface and fails closed before launch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-bounded-mcp-"));
  const projectDir = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const skillsRoot = path.join(root, "skills");
  const snapshotsRoot = path.join(root, "snapshots");
  const agentDir = path.join(root, "agent");
  const skillDir = path.join(skillsRoot, "researcher");
  const ajSkillDir = path.join(skillsRoot, "assumption-judge");
  const fake = await createFakePiChild("subagent007-bounded-fake-");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.mkdir(path.join(ajSkillDir, "scripts"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "npm", "node_modules", "pi-search-hub", "extensions"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: researcher\ndescription: bounded\n---\n# researcher\n", "utf8");
  await fs.writeFile(path.join(skillDir, "scripts", "researchctl.py"), "print('research controller snapshot')\n", "utf8");
  await fs.writeFile(path.join(ajSkillDir, "SKILL.md"), "---\nname: assumption-judge\ndescription: bounded\n---\n# assumption-judge\n", "utf8");
  await fs.writeFile(path.join(ajSkillDir, "scripts", "aj.py"), "print('aj controller snapshot')\n", "utf8");
  await fs.writeFile(
    path.join(agentDir, "npm", "node_modules", "pi-search-hub", "package.json"),
    JSON.stringify({ name: "pi-search-hub", version: "fixture" }),
    "utf8",
  );
  await fs.writeFile(path.join(agentDir, "npm", "node_modules", "pi-search-hub", "extensions", "search-hub.ts"), "export default {};\n", "utf8");
  const configPath = path.join(stateDir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ default_model_class: "C" }), "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      SUBAGENT007_CONFIG_PATH: configPath,
      SUBAGENT007_PI_CHILD_PATH: fake.childPath,
      FAKE_PI_LOG_PATH: fake.logPath,
      SUBAGENT007_PI_SKILL_PATHS: skillsRoot,
      SUBAGENT007_SKILL_SNAPSHOTS_DIR: snapshotsRoot,
      SUBAGENT007_PI_AGENT_DIR: agentDir,
      SUBAGENT007_FAILURE_LOG: "off",
      SUBAGENT007_RECORD_SOURCE: "test",
      SUBAGENT007_MODEL_HEALTH_PATH: path.join(stateDir, "model-health.json"),
    },
  });
  const client = new Client({ name: "bounded-profile-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const resolved = await client.callTool({
      name: "resolve_skill_runtime_bundles",
      arguments: { contract_version: 1, cwd: projectDir, skill_names: ["researcher"] },
    });
    assert.notEqual(resolved.isError, true, JSON.stringify(resolved));
    assert.ok(resolved.structuredContent, JSON.stringify(resolved));
    assert.ok((resolved.structuredContent as { bindings?: unknown }).bindings, JSON.stringify(resolved));
    const bundle = (resolved.structuredContent as { bindings: Array<{ bundle_sha256: string }> }).bindings[0]!;
    const published = await client.callTool({
      name: "publish_skill_snapshots",
      arguments: {
        contract_version: 1,
        cwd: projectDir,
        project_reference: { project_id: "bounded", publication_id: "researcher-v1", lifecycle: "active" },
        bindings: [{ skill_name: "researcher", expected_bundle_sha256: bundle.bundle_sha256 }],
      },
    });
    const item = (published.structuredContent as {
      bindings: Array<{
        snapshot_identity: { snapshot_id: string; metadata_sha256: string };
        publication_receipt: { receipt_sha256: string; reference_id: string; project_reference: { project_id: string; publication_id: string } };
      }>;
    }).bindings[0]!;
    const binding = {
      contract_version: 1,
      snapshot_id: item.snapshot_identity.snapshot_id,
      metadata_sha256: item.snapshot_identity.metadata_sha256,
      publication_receipt_sha256: item.publication_receipt.receipt_sha256,
      reference_id: item.publication_receipt.reference_id,
      project_id: item.publication_receipt.project_reference.project_id,
      publication_id: item.publication_receipt.project_reference.publication_id,
    };
    for (const name of ["run_subagent", "start_run", "schedule_run"] as const) {
      const response = await client.callTool({
        name,
        arguments: {
          cwd: projectDir,
          prompt: "FAST",
          skill_name: "researcher",
          effect_profile: "researcher_bounded_v1",
          skill_snapshot_binding: binding,
          ...(name === "run_subagent" ? { run_kind: "quick_noninteractive" } : {}),
          ...(name === "schedule_run" ? { wait_ms: 2_000 } : {}),
        },
      });
      assert.notEqual(response.isError, true, name);
      const view = response.structuredContent as { run_id?: string; status: string; activation_receipt?: { active_tool_names?: string[]; tool_bindings?: Array<{ tool_name: string }> } };
      const terminal = view.status === "working" || view.status === "input_required"
        ? await waitForTerminal(client, view.run_id!)
        : view;
      assert.equal((terminal.activation_receipt?.active_tool_names ?? []).join(","), "read,grep,find,ls,write,edit,web_search,web_read,researchctl", `${name}: ${JSON.stringify(terminal)}`);
      assert.deepEqual(terminal.activation_receipt?.tool_bindings?.map((entry) => entry.tool_name), ["web_read", "web_search", "researchctl"]);
    }
    const ajResolved = await client.callTool({
      name: "resolve_skill_runtime_bundles",
      arguments: { contract_version: 1, cwd: projectDir, skill_names: ["assumption-judge"] },
    });
    const ajBundle = (ajResolved.structuredContent as { bindings: Array<{ bundle_sha256: string }> }).bindings[0]!;
    const ajPublished = await client.callTool({
      name: "publish_skill_snapshots",
      arguments: {
        contract_version: 1,
        cwd: projectDir,
        project_reference: { project_id: "bounded", publication_id: "aj-v1", lifecycle: "active" },
        bindings: [{ skill_name: "assumption-judge", expected_bundle_sha256: ajBundle.bundle_sha256 }],
      },
    });
    const ajItem = (ajPublished.structuredContent as { bindings: Array<{ snapshot_identity: { snapshot_id: string; metadata_sha256: string }; publication_receipt: { receipt_sha256: string; reference_id: string; project_reference: { project_id: string; publication_id: string } } }> }).bindings[0]!;
    const ajBinding = {
      contract_version: 1,
      snapshot_id: ajItem.snapshot_identity.snapshot_id,
      metadata_sha256: ajItem.snapshot_identity.metadata_sha256,
      publication_receipt_sha256: ajItem.publication_receipt.receipt_sha256,
      reference_id: ajItem.publication_receipt.reference_id,
      project_id: ajItem.publication_receipt.project_reference.project_id,
      publication_id: ajItem.publication_receipt.project_reference.publication_id,
    };
    const ajResponse = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "FAST",
        skill_name: "assumption-judge",
        effect_profile: "assumption_audit_bounded_v1",
        skill_snapshot_binding: ajBinding,
      },
    });
    const ajView = ajResponse.structuredContent as { run_id?: string; status: string; activation_receipt?: { active_tool_names?: string[]; tool_bindings?: Array<{ tool_name: string }> } };
    const ajTerminal = ajView.status === "working" || ajView.status === "input_required" ? await waitForTerminal(client, ajView.run_id!) : ajView;
    assert.equal(ajTerminal.activation_receipt?.active_tool_names?.join(","), "read,grep,find,ls,write,edit,web_search,web_read,aj_switchboard");
    assert.deepEqual(ajTerminal.activation_receipt?.tool_bindings?.map((entry) => entry.tool_name), ["web_read", "web_search", "aj_switchboard"]);
    assert.equal((await readJsonl(fake.logPath)).length, 4);

    for (const prompt of ["OMIT_CONTROLLER_BINDING", "MUTATE_CONTROLLER_BINDING"]) {
      const rejectedBinding = await client.callTool({
        name: "start_run",
        arguments: {
          cwd: projectDir,
          prompt,
          skill_name: "researcher",
          effect_profile: "researcher_bounded_v1",
          skill_snapshot_binding: binding,
        },
      });
      const rejectedView = rejectedBinding.structuredContent as { run_id?: string; status: string; reason_code?: string };
      const terminal = rejectedView.status === "working" || rejectedView.status === "input_required"
        ? await waitForTerminal(client, rejectedView.run_id!)
        : rejectedView;
      assert.equal(terminal.status, "failed", `${prompt}: ${JSON.stringify(terminal)}`);
      assert.equal(terminal.reason_code, "effect_profile_activation_failed", `${prompt}: ${JSON.stringify(terminal)}`);
    }
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    const missing = await client.callTool({
      name: "start_run",
      arguments: { cwd: projectDir, prompt: "NO CHILD", skill_name: "researcher", effect_profile: "researcher_bounded_v1" },
    });
    assert.equal((missing.structuredContent as { kind: string; child_started: boolean; reason_code: string }).kind, "preflight_rejected");
    assert.equal((missing.structuredContent as { child_started: boolean }).child_started, false);
    assert.equal((missing.structuredContent as { reason_code: string }).reason_code, "invalid_skill_snapshot_binding");
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    const wrongSkill = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "NO CHILD",
        skill_name: "assumption-judge",
        effect_profile: "researcher_bounded_v1",
        skill_snapshot_binding: binding,
      },
    });
    assert.equal((wrongSkill.structuredContent as { child_started: boolean }).child_started, false);
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    const wrongSnapshot = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "NO CHILD",
        skill_name: "researcher",
        effect_profile: "researcher_bounded_v1",
        skill_snapshot_binding: { ...binding, metadata_sha256: "0".repeat(64) },
      },
    });
    assert.equal((wrongSnapshot.structuredContent as { kind: string; child_started: boolean }).kind, "preflight_rejected");
    assert.equal((wrongSnapshot.structuredContent as { child_started: boolean }).child_started, false);
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    const recursive = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "NO CHILD",
        skill_name: "researcher",
        effect_profile: "researcher_bounded_v1",
        skill_snapshot_binding: binding,
        recursive_delegation: "enabled",
      },
    });
    assert.equal((recursive.structuredContent as { kind: string; child_started: boolean }).kind, "preflight_rejected");
    assert.equal((recursive.structuredContent as { child_started: boolean }).child_started, false);
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    const sessionFile = path.join(root, "resume.jsonl");
    await fs.writeFile(sessionFile, "{}\n", "utf8");
    const resume = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "NO CHILD",
        continuity: { mode: "resume", session_id: sessionFile },
        skill_name: "researcher",
        effect_profile: "researcher_bounded_v1",
        skill_snapshot_binding: binding,
      },
    });
    assert.equal((resume.structuredContent as { child_started: boolean }).child_started, false);
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    await fs.rm(path.join(agentDir, "npm", "node_modules", "pi-search-hub"), { recursive: true, force: true });
    const noProvider = await client.callTool({
      name: "start_run",
      arguments: {
        cwd: projectDir,
        prompt: "NO CHILD",
        skill_name: "researcher",
        effect_profile: "researcher_bounded_v1",
        skill_snapshot_binding: binding,
      },
    });
    const noProviderView = noProvider.structuredContent as { run_id?: string; status: string; reason_code?: string };
    const noProviderTerminal = noProviderView.status === "working" || noProviderView.status === "input_required"
      ? await waitForTerminal(client, noProviderView.run_id!)
      : noProviderView;
    assert.equal(noProviderTerminal.reason_code, "effect_profile_activation_failed", JSON.stringify(noProviderTerminal));
    assert.equal((await readJsonl(fake.logPath)).length, 6);

    const named = await client.callTool({
      name: "start_session_run",
      arguments: {
        cwd: projectDir,
        prompt: "NO CHILD",
        session_key: "named",
        skill_name: "researcher",
        effect_profile: "researcher_bounded_v1",
      },
    });
    assert.equal(named.isError, true);
  } finally {
    await client.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function waitForTerminal(client: Client, runId: string): Promise<{ status: string; reason_code?: string; activation_receipt?: { active_tool_names?: string[]; tool_bindings?: Array<{ tool_name: string }> } }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await client.callTool({ name: "get_run", arguments: { run_id: runId } });
    const view = response.structuredContent as { status: string; reason_code?: string; activation_receipt?: { active_tool_names?: string[]; tool_bindings?: Array<{ tool_name: string }> } };
    if (["completed", "failed", "cancelled", "timed_out"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${runId}`);
}
