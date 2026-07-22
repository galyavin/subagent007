import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as snapshotApi from "../src/skillSnapshot.js";
import { validateSkillRuntimeBundle } from "../src/skillRuntimeBundle.js";

async function writeBundle(root: string, text = "guide\n"): Promise<void> {
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "---\nname: alpha\ndescription: Test.\n---\n# Alpha\n");
  await fs.writeFile(path.join(root, "references", "guide.md"), text);
}

async function publishedFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-retained-source-")));
  const cwd = path.join(root, "cwd");
  const source = path.join(root, "skills", "alpha");
  const snapshotsRoot = path.join(root, "snapshots");
  await fs.mkdir(cwd);
  await writeBundle(source);
  const digest = (await validateSkillRuntimeBundle(source)).bundle_sha256;
  const published = await snapshotApi.publishSkillSnapshotsRequest({
    contract_version: 1,
    cwd,
    project_reference: { project_id: "project-alpha", publication_id: "publication-alpha", lifecycle: "active" },
    bindings: [{ skill_name: "alpha", expected_bundle_sha256: digest }],
  }, { lookupPaths: [path.dirname(source)], agentDir: path.join(root, "agent"), snapshotsRoot });
  assert.equal(published.kind, "skill_snapshots_published");
  if (published.kind !== "skill_snapshots_published") throw new Error("publication failed");
  const item = published.bindings[0]!;
  return {
    root, cwd, source, snapshotsRoot, digest, item,
    request: {
      contract_version: 1 as const,
      skill_name: "alpha",
      snapshot_binding: {
        contract_version: 1 as const,
        snapshot_id: item.snapshot_identity.snapshot_id,
        metadata_sha256: item.snapshot_identity.metadata_sha256,
        publication_receipt_sha256: item.publication_receipt.receipt_sha256,
        reference_id: item.publication_receipt.reference_id,
        project_id: item.publication_receipt.project_reference.project_id,
        publication_id: item.publication_receipt.project_reference.publication_id,
      },
    },
  };
}

async function resolveSource(request: Record<string, unknown>, options: Record<string, unknown>) {
  const fn = (snapshotApi as Record<string, unknown>).resolveRetainedSkillSnapshotSourceRequest;
  assert.equal(typeof fn, "function", "public retained-snapshot source-resolution owner must exist");
  return (fn as (
    request: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>)(request, options);
}

async function makeTreeRemovable(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await fs.chmod(root, 0o755).catch(() => undefined);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTreeRemovable(target);
    else if (!entry.isSymbolicLink()) await fs.chmod(target, 0o644).catch(() => undefined);
  }
}

async function durableTreeFingerprint(root: string): Promise<string> {
  const records: string[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = path.join(directory, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (entry.isDirectory()) {
        records.push(`d:${childRelative}:${stat.mode & 0o777}`);
        await visit(absolute, childRelative);
      } else if (entry.isSymbolicLink()) {
        records.push(`l:${childRelative}:${await fs.readlink(absolute)}`);
      } else {
        records.push(`f:${childRelative}:${stat.mode & 0o777}:${(await fs.readFile(absolute)).toString("base64")}`);
      }
    }
  }
  await visit(root);
  return createHash("sha256").update(records.join("\n")).digest("hex");
}

test("retained source resolution returns exact owner bytes for active and closed references without mutation", async () => {
  const f = await publishedFixture();
  try {
    const before = await durableTreeFingerprint(f.snapshotsRoot);
    const first = await resolveSource(f.request, { snapshotsRoot: f.snapshotsRoot });
    assert.equal(first.kind, "skill_snapshot_source_resolved", JSON.stringify(first));
    assert.equal(first.bundle_sha256, f.digest);
    assert.equal((first.retained_reference as { lifecycle?: string }).lifecycle, "active");
    const sourceIdentity = first.source_identity as {
      source_id: string;
      source_root_path: string;
      resolved_skill_path: string;
    };
    assert.equal(sourceIdentity.source_root_path, path.join(f.item.snapshot_identity.snapshot_path, "runtime"));
    assert.equal(sourceIdentity.resolved_skill_path, path.join(sourceIdentity.source_root_path, "SKILL.md"));
    assert.match(sourceIdentity.source_id, /^[0-9a-f]{64}$/);
    assert.equal(await fs.realpath(sourceIdentity.source_root_path), sourceIdentity.source_root_path);
    assert.deepEqual(await resolveSource(f.request, { snapshotsRoot: f.snapshotsRoot }), first);
    assert.equal(await durableTreeFingerprint(f.snapshotsRoot), before);

    await snapshotApi.closeSkillSnapshotReferencesRequest({
      contract_version: 1,
      project_id: f.request.snapshot_binding.project_id,
      publication_id: f.request.snapshot_binding.publication_id,
      snapshot_ids: [f.digest],
    }, { snapshotsRoot: f.snapshotsRoot });
    const afterClose = await durableTreeFingerprint(f.snapshotsRoot);
    const closed = await resolveSource(f.request, { snapshotsRoot: f.snapshotsRoot });
    assert.equal(closed.kind, "skill_snapshot_source_resolved");
    assert.equal((closed.retained_reference as { lifecycle?: string }).lifecycle, "closed");
    assert.deepEqual(closed.source_identity, first.source_identity);
    assert.equal(await durableTreeFingerprint(f.snapshotsRoot), afterClose);
  } finally {
    await makeTreeRemovable(f.root);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("retained source resolution rejects missing, altered, receipt-drifted, and mismatched references", async () => {
  const cases = [
    { field: "reference_id", value: "0".repeat(64), reason: "skill_snapshot_reference_mismatch" },
    { field: "publication_receipt_sha256", value: "0".repeat(64), reason: "skill_snapshot_reference_mismatch" },
    { field: "metadata_sha256", value: "0".repeat(64), reason: "skill_snapshot_altered" },
  ] as const;
  for (const item of cases) {
    const f = await publishedFixture();
    try {
      const result = await resolveSource({
        ...f.request,
        snapshot_binding: { ...f.request.snapshot_binding, [item.field]: item.value },
      }, { snapshotsRoot: f.snapshotsRoot });
      assert.equal(result.kind, "skill_snapshot_source_resolution_rejected");
      assert.equal(result.reason_code, item.reason);
    } finally {
      await makeTreeRemovable(f.root);
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }

  const missing = await publishedFixture();
  try {
    const result = await resolveSource({
      ...missing.request,
      snapshot_binding: {
        ...missing.request.snapshot_binding,
        snapshot_id: "0".repeat(64),
        metadata_sha256: "0".repeat(64),
      },
    }, { snapshotsRoot: missing.snapshotsRoot });
    assert.equal(result.reason_code, "skill_snapshot_not_found");
  } finally {
    await makeTreeRemovable(missing.root);
    await fs.rm(missing.root, { recursive: true, force: true });
  }

  const drifted = await publishedFixture();
  try {
    const guide = path.join(drifted.item.snapshot_identity.snapshot_path, "runtime", "references", "guide.md");
    await fs.chmod(path.dirname(guide), 0o755);
    await fs.chmod(guide, 0o644);
    await fs.writeFile(guide, "drift\n");
    const result = await resolveSource(drifted.request, { snapshotsRoot: drifted.snapshotsRoot });
    assert.equal(result.reason_code, "skill_snapshot_altered");
  } finally {
    await makeTreeRemovable(drifted.root);
    await fs.rm(drifted.root, { recursive: true, force: true });
  }
});

test("retained source resolution rejects a symlinked runtime even when the outside bytes are identical", async () => {
  const f = await publishedFixture();
  const runtime = path.join(f.item.snapshot_identity.snapshot_path, "runtime");
  const outside = path.join(f.root, "outside-runtime");
  try {
    await fs.cp(runtime, outside, { recursive: true });
    await makeTreeRemovable(f.item.snapshot_identity.snapshot_path);
    await fs.rm(runtime, { recursive: true });
    await fs.symlink(outside, runtime);

    const result = await resolveSource(f.request, { snapshotsRoot: f.snapshotsRoot });
    assert.equal(result.kind, "skill_snapshot_source_resolution_rejected");
    assert.equal(result.reason_code, "skill_snapshot_altered");
  } finally {
    await makeTreeRemovable(f.root);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("unsafe caller-path materialization is absent and caller-selected paths remain untouched", async () => {
  const f = await publishedFixture();
  const callerTarget = path.join(f.cwd, "alpha");
  const forgedStage = path.join(f.cwd, ".subagent007-retained-forged");
  try {
    await fs.mkdir(callerTarget);
    await fs.writeFile(path.join(callerTarget, "caller-target.txt"), "target\n");
    await fs.mkdir(path.join(forgedStage, "runtime"), { recursive: true });
    await fs.writeFile(path.join(forgedStage, "owner.json"), "forged\n");
    await fs.writeFile(path.join(forgedStage, "runtime", "caller-data.txt"), "caller\n");
    const before = await durableTreeFingerprint(f.cwd);

    assert.equal(
      typeof (snapshotApi as Record<string, unknown>).materializeRetainedSkillSnapshotRequest,
      "undefined",
      "retired caller-path implementation must be unreachable",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/server.js")],
      env: {
        ...process.env,
        SUBAGENT007_SKILL_SNAPSHOTS_DIR: f.snapshotsRoot,
        SUBAGENT007_FAILURE_LOG: "off",
      },
    });
    const client = new Client({ name: "retained-source-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      assert.equal(tools.includes("resolve_retained_skill_snapshot_source"), true);
      assert.equal(tools.includes("materialize_retained_skill_snapshot"), false);
      const resolved = await client.callTool({
        name: "resolve_retained_skill_snapshot_source",
        arguments: f.request,
      });
      assert.notEqual(resolved.isError, true);
      assert.equal((resolved.structuredContent as { kind?: string }).kind, "skill_snapshot_source_resolved");

      for (const extra of [
        { staging_root: callerTarget },
        { cwd: f.cwd },
        { snapshots_root: path.join(f.root, "private") },
      ]) {
        const rejected = await client.callTool({
          name: "resolve_retained_skill_snapshot_source",
          arguments: { ...f.request, ...extra },
        });
        assert.equal(rejected.isError, true);
      }
      const retired = await client.callTool({
        name: "materialize_retained_skill_snapshot",
        arguments: { ...f.request, cwd: f.cwd, staging_root: callerTarget },
      });
      assert.equal(retired.isError, true);
    } finally {
      await client.close().catch(() => undefined);
    }
    assert.equal(await durableTreeFingerprint(f.cwd), before);
  } finally {
    await makeTreeRemovable(f.root);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
