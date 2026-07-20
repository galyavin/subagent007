import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureSkillRuntimeBundle,
  validateSkillRuntimeBundle,
} from "../src/skillRuntimeBundle.js";
import {
  closeSkillSnapshotReferencesRequest,
  deleteSkillSnapshotRequest,
  planSkillSnapshotDeletionRequest,
  publishSkillSnapshotsRequest,
  resolveSkillRuntimeBundlesRequest,
  resolveSkillSnapshotLaunchBinding,
  validateRecordedSkillSnapshot,
} from "../src/skillSnapshot.js";
import { runSubagentCore } from "../src/runSubagent.js";
import { createFakePiChild } from "./helpers/fakePiChild.js";
import { validateSkillRuntimeBundleRequest } from "../src/skillRuntimeBundleValidation.js";
import { claimSkillSnapshotPublication, materializeSkillSnapshot } from "../src/skillSnapshotStore.js";
import { createTaskRootAuthoringTools } from "../src/taskRootAuthoringTools.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-skill-bundle-test-"));
  try {
    await run(dir);
  } finally {
    async function makeRemovable(current: string): Promise<void> {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      await fs.chmod(current, 0o755).catch(() => undefined);
      for (const entry of entries) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) await makeRemovable(target);
        else await fs.chmod(target, 0o644).catch(() => undefined);
      }
    }
    await makeRemovable(dir);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeBundle(root: string, skillName = "alpha"): Promise<void> {
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "templates"), { recursive: true });
  await fs.mkdir(path.join(root, "agents"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), `---\nname: ${skillName}\ndescription: Test skill.\n---\n# ${skillName}\nRead references/guide.md before authoring.\n`);
  await fs.writeFile(path.join(root, "scripts", "run.sh"), "#!/bin/sh\necho alpha\n", { mode: 0o755 });
  await fs.writeFile(path.join(root, "references", "guide.md"), "guide\n");
  await fs.writeFile(path.join(root, "assets", "input.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(root, "templates", "output.md"), "{{value}}\n");
  await fs.writeFile(path.join(root, "agents", "openai.yaml"), "interface:\n  display_name: Alpha\n");
}

test("runtime bundle digest covers every admitted exact byte in canonical path order", async () => {
  await withTempDir(async (root) => {
    await writeBundle(root);
    const bundle = await validateSkillRuntimeBundle(root);

    assert.equal(bundle.algorithm, "subagent007.skill_runtime_bundle.sha256.v1");
    assert.deepEqual(bundle.files.map((file) => file.relative_path), [
      "SKILL.md",
      "agents/openai.yaml",
      "assets/input.bin",
      "references/guide.md",
      "scripts/run.sh",
      "templates/output.md",
    ]);
    assert.equal(bundle.files.find((file) => file.relative_path === "scripts/run.sh")?.executable, true);
    assert.equal((await validateSkillRuntimeBundle(root)).bundle_sha256, bundle.bundle_sha256);

    const originalDigest = bundle.bundle_sha256;
    await fs.writeFile(path.join(root, "references", "guide.md"), "changed\n");
    assert.notEqual((await validateSkillRuntimeBundle(root)).bundle_sha256, originalDigest);
    await fs.writeFile(path.join(root, "references", "guide.md"), "guide\n");
    await fs.chmod(path.join(root, "scripts", "run.sh"), 0o644);
    assert.notEqual((await validateSkillRuntimeBundle(root)).bundle_sha256, originalDigest);
  });
});

test("runtime bundle admits and digests root license text without admitting arbitrary root files", async () => {
  await withTempDir(async (root) => {
    await writeBundle(root);
    await fs.writeFile(path.join(root, "license.txt"), "platform license\n");

    const initial = await validateSkillRuntimeBundle(root);
    assert.ok(initial.files.some((file) => file.relative_path === "license.txt"));
    await fs.writeFile(path.join(root, "license.txt"), "changed platform license\n");
    assert.notEqual((await validateSkillRuntimeBundle(root)).bundle_sha256, initial.bundle_sha256);

    await fs.rm(path.join(root, "license.txt"));
    await fs.writeFile(path.join(root, "runtime-helper.md"), "unadmitted runtime candidate\n");
    await assert.rejects(validateSkillRuntimeBundle(root), /unadmitted runtime bundle path/);
  });
});

test("runtime bundle structurally excludes development residue and rejects unsafe closure", async () => {
  await withTempDir(async (root) => {
    await writeBundle(root);
    await fs.mkdir(path.join(root, "tests"));
    await fs.writeFile(path.join(root, "tests", "bundle.test.ts"), "not runtime\n");
    await fs.mkdir(path.join(root, "scripts", "__pycache__"));
    await fs.writeFile(path.join(root, "scripts", "__pycache__", "run.pyc"), "cache\n");
    await fs.writeFile(path.join(root, "scripts", "test_run.py"), "test residue\n");
    const bundle = await validateSkillRuntimeBundle(root);
    assert.equal(bundle.files.some((file) => /tests|__pycache__|test_run/.test(file.relative_path)), false);

    await fs.writeFile(path.join(root, "runtime-helper.md"), "unadmitted runtime candidate\n");
    await assert.rejects(validateSkillRuntimeBundle(root), /unadmitted runtime bundle path/);
    await fs.rm(path.join(root, "runtime-helper.md"));

    await fs.symlink("../SKILL.md", path.join(root, "references", "escape.md"));
    await assert.rejects(validateSkillRuntimeBundle(root), /symbolic link/);
  });
});

test("runtime bundle validation detects same-path source swaps", async () => {
  await withTempDir(async (root) => {
    await writeBundle(root);
    await assert.rejects(
      validateSkillRuntimeBundle(root, {
        beforeFinalIdentityCheck: async () => {
          await fs.rename(path.join(root, "references", "guide.md"), path.join(root, "references", "old.md"));
          await fs.writeFile(path.join(root, "references", "guide.md"), "replacement\n");
        },
      }),
      /changed while the runtime bundle was being read/,
    );
  });
});

test("runtime bundle validation is bounded before publication", async () => {
  await withTempDir(async (root) => {
    await writeBundle(root);
    await assert.rejects(validateSkillRuntimeBundle(root, { maxFiles: 5 }), /file limit/);
    await assert.rejects(validateSkillRuntimeBundle(root, { maxBytes: 8 }), /byte limit/);
  });
});

test("resolve_skill_runtime_bundles returns owner-issued source identity and full closure", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const root = path.join(lookup, "alpha");
    await fs.mkdir(cwd);
    await fs.mkdir(root, { recursive: true });
    await writeBundle(root);

    const result = await resolveSkillRuntimeBundlesRequest({
      contract_version: 1,
      cwd,
      skill_names: ["alpha"],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent") });

    assert.equal(result.contract_name, "subagent007.skill_runtime_bundle_resolution");
    assert.equal(result.contract_version, 1);
    assert.equal(result.kind, "skill_runtime_bundles_resolved");
    assert.equal(result.child_started, false);
    assert.equal(result.model_invoked, false);
    if (result.kind !== "skill_runtime_bundles_resolved") throw new Error("expected success");
    assert.equal(result.bindings[0]?.skill_name, "alpha");
    assert.equal(result.bindings[0]?.source_identity.schema_version, 1);
    assert.equal(result.bindings[0]?.source_identity.source_id.length, 64);
    assert.equal(result.bindings[0]?.runtime_closure.complete, true);
    assert.equal(result.bindings[0]?.runtime_closure.files.length, 6);

    const expectedRequestDigest = createHash("sha256")
      .update("subagent007.skill_runtime_bundle_resolution.request.v1\n")
      .update(JSON.stringify({ contract_version: 1, cwd, skill_names: ["alpha"] }))
      .digest("hex");
    assert.equal(result.request_binding.canonical_request_sha256, expectedRequestDigest);
  });
});

test("exact-root bundle validation supports settled staging and canonical source without catalog visibility or writes", async () => {
  await withTempDir(async (tmp) => {
    const staged = path.join(tmp, "settled-stage");
    await fs.mkdir(staged);
    await writeBundle(staged);
    const before = (await fs.readdir(tmp)).sort();
    const result = await validateSkillRuntimeBundleRequest({
      contract_version: 1,
      bundle_root: staged,
      expected_skill_name: "alpha",
    });
    assert.equal(result.kind, "skill_runtime_bundle_validated");
    assert.equal(result.contract_name, "subagent007.skill_runtime_bundle_validation");
    assert.equal(result.child_started, false);
    assert.equal(result.model_invoked, false);
    if (result.kind !== "skill_runtime_bundle_validated") throw new Error("expected validation");
    assert.equal(result.bundle_sha256, (await validateSkillRuntimeBundle(staged)).bundle_sha256);
    assert.equal(result.runtime_closure.complete, true);
    assert.deepEqual((await fs.readdir(tmp)).sort(), before);

    const canonicalSource = path.join(tmp, "skills", "alpha");
    await fs.mkdir(path.dirname(canonicalSource));
    await fs.cp(staged, canonicalSource, { recursive: true });
    const canonical = await validateSkillRuntimeBundleRequest({
      contract_version: 1,
      bundle_root: canonicalSource,
      expected_skill_name: "alpha",
    });
    assert.equal(canonical.kind, "skill_runtime_bundle_validated");
    if (canonical.kind !== "skill_runtime_bundle_validated") throw new Error("expected canonical validation");
    assert.equal(canonical.bundle_sha256, result.bundle_sha256);

    const mismatch = await validateSkillRuntimeBundleRequest({
      contract_version: 1,
      bundle_root: staged,
      expected_skill_name: "beta",
    });
    assert.equal(mismatch.kind, "skill_runtime_bundle_validation_rejected");
    assert.equal(mismatch.reason_code, "skill_runtime_bundle_name_mismatch");
  });
});

test("snapshot publication freezes exact bytes and later source edits create only future versions", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const root = path.join(lookup, "alpha");
    const snapshotsRoot = path.join(tmp, "snapshots");
    await fs.mkdir(cwd);
    await fs.mkdir(root, { recursive: true });
    await writeBundle(root);
    const firstDigest = (await validateSkillRuntimeBundle(root)).bundle_sha256;
    const projectReference = {
      project_id: "project-alpha",
      publication_id: "publication-alpha",
      lifecycle: "active" as const,
    };

    const first = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: projectReference,
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: firstDigest }],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    assert.equal(first.kind, "skill_snapshots_published");
    if (first.kind !== "skill_snapshots_published") throw new Error("expected publication");
    assert.equal(first.bindings[0]?.snapshot_identity.snapshot_id, firstDigest);
    assert.equal(first.bindings[0]?.publication_receipt.project_reference.project_id, "project-alpha");

    await fs.writeFile(path.join(root, "references", "guide.md"), "future edition\n");
    const secondDigest = (await validateSkillRuntimeBundle(root)).bundle_sha256;
    const conflictingReplay = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: projectReference,
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: secondDigest }],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    assert.equal(conflictingReplay.kind, "skill_snapshot_publication_rejected");
    if (conflictingReplay.kind !== "skill_snapshot_publication_rejected") throw new Error("expected conflict");
    assert.equal(conflictingReplay.reason_code, "publication_identity_conflict");
    const second = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: {
        project_id: "project-beta",
        publication_id: "publication-beta",
        lifecycle: "active",
      },
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: secondDigest }],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    assert.equal(second.kind, "skill_snapshots_published");
    assert.notEqual(secondDigest, firstDigest);

    const firstSnapshot = await validateRecordedSkillSnapshot(first.bindings[0]!.snapshot_identity, { snapshotsRoot });
    assert.equal(firstSnapshot.bundle_sha256, firstDigest);
    assert.equal(
      await fs.readFile(path.join(first.bindings[0]!.snapshot_identity.snapshot_path, "runtime", "references", "guide.md"), "utf8"),
      "guide\n",
    );
  });
});

test("pending publication claim resumes after source loss without splitting publication identity", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const root = path.join(lookup, "alpha");
    const snapshotsRoot = path.join(tmp, "snapshots");
    await fs.mkdir(cwd);
    await fs.mkdir(root, { recursive: true });
    await writeBundle(root);
    const resolved = await resolveSkillRuntimeBundlesRequest({ contract_version: 1, cwd, skill_names: ["alpha"] }, {
      lookupPaths: [lookup], agentDir: path.join(tmp, "agent"),
    });
    assert.equal(resolved.kind, "skill_runtime_bundles_resolved");
    if (resolved.kind !== "skill_runtime_bundles_resolved") throw new Error("expected resolution");
    const resolvedBinding = resolved.bindings[0]!;
    const captured = await captureSkillRuntimeBundle(root);
    const metadata = await materializeSkillSnapshot({ captured, snapshotsRoot });
    const request = {
      contract_version: 1 as const,
      cwd,
      project_reference: { project_id: "project-recovery", publication_id: "publication-recovery", lifecycle: "active" as const },
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: captured.bundle_sha256 }],
    };
    const requestSha = createHash("sha256")
      .update("subagent007.skill_snapshot_publication.request.v1\n")
      .update(JSON.stringify(request))
      .digest("hex");
    await claimSkillSnapshotPublication({
      project_id: request.project_reference.project_id,
      publication_id: request.project_reference.publication_id,
      publication_request_sha256: requestSha,
      prepared_bindings: [{
        skill_name: "alpha",
        source_identity: resolvedBinding.source_identity,
        snapshot_identity: metadata.snapshot_identity,
        bundle_sha256: metadata.bundle_sha256,
        runtime_closure: metadata.runtime_closure,
      }],
      snapshotsRoot,
    });
    await fs.rename(root, `${root}.gone`);
    const recovered = await publishSkillSnapshotsRequest(request, {
      lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot,
    });
    assert.equal(recovered.kind, "skill_snapshots_published");
    if (recovered.kind !== "skill_snapshots_published") throw new Error("expected recovery");
    assert.equal(recovered.bindings[0]?.snapshot_identity.snapshot_id, captured.bundle_sha256);
    assert.deepEqual(await publishSkillSnapshotsRequest(request, {
      lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot,
    }), recovered);
  });
});

test("concurrent publication claims permit exactly one canonical request per publication identity", async () => {
  await withTempDir(async (tmp) => {
    const cwdA = path.join(tmp, "cwd-a");
    const cwdB = path.join(tmp, "cwd-b");
    const lookup = path.join(tmp, "skills");
    const root = path.join(lookup, "alpha");
    const snapshotsRoot = path.join(tmp, "snapshots");
    await fs.mkdir(cwdA);
    await fs.mkdir(cwdB);
    await fs.mkdir(root, { recursive: true });
    await writeBundle(root);
    const digest = (await validateSkillRuntimeBundle(root)).bundle_sha256;
    const publication = { project_id: "project-race", publication_id: "publication-race", lifecycle: "active" as const };
    const publish = (cwd: string) => publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: publication,
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: digest }],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    const outcomes = await Promise.all([publish(cwdA), publish(cwdB)]);
    assert.deepEqual(outcomes.map((result) => result.kind).sort(), [
      "skill_snapshot_publication_rejected",
      "skill_snapshots_published",
    ]);
    const rejected = outcomes.find((result) => result.kind === "skill_snapshot_publication_rejected");
    assert.equal(rejected?.reason_code, "publication_identity_conflict");
    const impact = await planSkillSnapshotDeletionRequest({ contract_version: 1, snapshot_id: digest }, { snapshotsRoot });
    assert.equal(impact.kind, "skill_snapshot_deletion_planned");
    if (impact.kind !== "skill_snapshot_deletion_planned") throw new Error("expected impact");
    assert.equal(impact.impact_report.affected_reference_count, 1);
  });
});

test("publication is all-or-nothing before writes and detects source drift", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const root = path.join(lookup, "alpha");
    const snapshotsRoot = path.join(tmp, "snapshots");
    await fs.mkdir(cwd);
    await fs.mkdir(root, { recursive: true });
    await writeBundle(root);
    const actual = (await validateSkillRuntimeBundle(root)).bundle_sha256;
    const result = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: {
        project_id: "project-alpha",
        publication_id: "publication-rejected",
        lifecycle: "active",
      },
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: "0".repeat(64) }],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    assert.equal(result.kind, "skill_snapshot_publication_rejected");
    if (result.kind !== "skill_snapshot_publication_rejected") throw new Error("expected rejection");
    assert.equal(result.reason_code, "runtime_bundle_content_mismatch");
    assert.equal(result.failed_binding?.actual_bundle_sha256, actual);
    await assert.rejects(fs.access(path.join(snapshotsRoot, "bundles")), /ENOENT/);
  });
});

test("snapshot references survive retries and exact deletion reports every affected project", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const root = path.join(lookup, "alpha");
    const snapshotsRoot = path.join(tmp, "snapshots");
    await fs.mkdir(cwd);
    await fs.mkdir(root, { recursive: true });
    await writeBundle(root);
    const digest = (await validateSkillRuntimeBundle(root)).bundle_sha256;
    const publish = async (project_id: string, publication_id: string, lifecycle: "active") =>
      publishSkillSnapshotsRequest({
        contract_version: 1,
        cwd,
        project_reference: { project_id, publication_id, lifecycle },
        bindings: [{ skill_name: "alpha", expected_bundle_sha256: digest }],
      }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });

    const active = await publish("project-active", "publication-active", "active");
    const closed = await publish("project-closed", "publication-closed", "active");
    assert.equal(active.kind, "skill_snapshots_published");
    assert.equal(closed.kind, "skill_snapshots_published");
    assert.deepEqual(await publish("project-active", "publication-active", "active"), active);

    const closure = await closeSkillSnapshotReferencesRequest({
      contract_version: 1,
      project_id: "project-closed",
      publication_id: "publication-closed",
      snapshot_ids: [digest],
    }, { snapshotsRoot });
    assert.equal(closure.kind, "skill_snapshot_references_closed");
    assert.equal(closure.references?.[0]?.project_reference.lifecycle, "closed");
    assert.deepEqual(await closeSkillSnapshotReferencesRequest({
      contract_version: 1,
      project_id: "project-closed",
      publication_id: "publication-closed",
      snapshot_ids: [digest],
    }, { snapshotsRoot }), closure);

    const plan = await planSkillSnapshotDeletionRequest({ contract_version: 1, snapshot_id: digest }, { snapshotsRoot });
    assert.equal(plan.kind, "skill_snapshot_deletion_planned");
    if (plan.kind !== "skill_snapshot_deletion_planned") throw new Error("expected plan");
    assert.deepEqual(plan.impact_report.affected_projects.map((item) => item.project_id), [
      "project-active",
      "project-closed",
    ]);
    assert.equal(plan.impact_report.affected_projects[1]?.lifecycle, "closed");
    assert.equal(plan.impact_report.affected_reference_count, 2);
    assert.deepEqual(plan.impact_report.affected_references.map((item) => item.skill_name), ["alpha", "alpha"]);
    assert.deepEqual(plan.impact_report.affected_projects.map((item) => item.publication_id), [
      "publication-active",
      "publication-closed",
    ]);

    const denied = await deleteSkillSnapshotRequest({
      contract_version: 1,
      snapshot_id: digest,
      confirm_impact_sha256: "0".repeat(64),
    }, { snapshotsRoot });
    assert.equal(denied.kind, "skill_snapshot_deletion_rejected");
    if (active.kind !== "skill_snapshots_published") throw new Error("expected active publication");
    await validateRecordedSkillSnapshot(active.bindings[0]!.snapshot_identity, { snapshotsRoot });

    const deleted = await deleteSkillSnapshotRequest({
      contract_version: 1,
      snapshot_id: digest,
      confirm_impact_sha256: plan.impact_report.impact_sha256,
    }, { snapshotsRoot });
    assert.equal(deleted.kind, "skill_snapshot_deleted");
    await assert.rejects(fs.access(path.join(snapshotsRoot, "bundles", digest)), /ENOENT/);
  });
});

test("reference closure requires the complete committed publication snapshot set", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const snapshotsRoot = path.join(tmp, "snapshots");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(lookup, "alpha"), { recursive: true });
    await fs.mkdir(path.join(lookup, "beta"), { recursive: true });
    await writeBundle(path.join(lookup, "alpha"), "alpha");
    await writeBundle(path.join(lookup, "beta"), "beta");
    const alpha = (await validateSkillRuntimeBundle(path.join(lookup, "alpha"))).bundle_sha256;
    const beta = (await validateSkillRuntimeBundle(path.join(lookup, "beta"))).bundle_sha256;
    const published = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: { project_id: "project-complete-close", publication_id: "publication-complete-close", lifecycle: "active" },
      bindings: [
        { skill_name: "alpha", expected_bundle_sha256: alpha },
        { skill_name: "beta", expected_bundle_sha256: beta },
      ],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    assert.equal(published.kind, "skill_snapshots_published");
    const partial = await closeSkillSnapshotReferencesRequest({
      contract_version: 1,
      project_id: "project-complete-close",
      publication_id: "publication-complete-close",
      snapshot_ids: [alpha],
    }, { snapshotsRoot });
    assert.equal(partial.kind, "skill_snapshot_reference_closure_rejected");
    const complete = await closeSkillSnapshotReferencesRequest({
      contract_version: 1,
      project_id: "project-complete-close",
      publication_id: "publication-complete-close",
      snapshot_ids: [alpha, beta].sort(),
    }, { snapshotsRoot });
    assert.equal(complete.kind, "skill_snapshot_references_closed");
    assert.equal(complete.references?.every((reference) => reference.project_reference.lifecycle === "closed"), true);
  });
});

test("snapshot-bound launch uses immutable closure, receipts before prompt, and fails closed on alteration", async () => {
  await withTempDir(async (tmp) => {
    const cwd = path.join(tmp, "cwd");
    const lookup = path.join(tmp, "skills");
    const skillRoot = path.join(lookup, "alpha");
    const snapshotsRoot = path.join(tmp, "snapshots");
    const runsDir = path.join(tmp, "runs");
    await fs.mkdir(cwd);
    await fs.mkdir(skillRoot, { recursive: true });
    await writeBundle(skillRoot);
    const digest = (await validateSkillRuntimeBundle(skillRoot)).bundle_sha256;
    const published = await publishSkillSnapshotsRequest({
      contract_version: 1,
      cwd,
      project_reference: {
        project_id: "project-launch",
        publication_id: "publication-launch",
        lifecycle: "active",
      },
      bindings: [{ skill_name: "alpha", expected_bundle_sha256: digest }],
    }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
    assert.equal(published.kind, "skill_snapshots_published");
    if (published.kind !== "skill_snapshots_published") throw new Error("expected publication");
    const binding = published.bindings[0]!;
    const launchBinding = {
      contract_version: 1 as const,
      snapshot_id: binding.snapshot_identity.snapshot_id,
      metadata_sha256: binding.snapshot_identity.metadata_sha256,
      publication_receipt_sha256: binding.publication_receipt.receipt_sha256,
      reference_id: binding.publication_receipt.reference_id,
      project_id: binding.publication_receipt.project_reference.project_id,
      publication_id: binding.publication_receipt.project_reference.publication_id,
    };
    const activation = await resolveSkillSnapshotLaunchBinding({
      skill_name: "alpha",
      binding: launchBinding,
      snapshotsRoot,
    });
    assert.equal(activation.receipt.confirmed_before_prompt, true);
    assert.equal(activation.receipt.bundle_sha256, digest);

    const fake = await createFakePiChild();
    const prior = {
      child: process.env.SUBAGENT007_PI_CHILD_PATH,
      log: process.env.FAKE_PI_LOG_PATH,
      snapshots: process.env.SUBAGENT007_SKILL_SNAPSHOTS_DIR,
    };
    process.env.SUBAGENT007_PI_CHILD_PATH = fake.childPath;
    process.env.FAKE_PI_LOG_PATH = fake.logPath;
    process.env.SUBAGENT007_SKILL_SNAPSHOTS_DIR = snapshotsRoot;
    try {
      await fs.writeFile(path.join(skillRoot, "references", "guide.md"), "future mutable source\n");
      const observedLines: string[] = [];
      const result = await runSubagentCore({
        cwd,
        prompt: "FAST",
        skill_name: "alpha",
        skill_snapshot_binding: launchBinding,
      }, { runsDir, onOutputLine: (line) => { observedLines.push(line); } });
      assert.equal(result.success, true);
      assert.deepEqual(result.skill_snapshot_activation_receipt, activation.receipt);
      assert.ok(observedLines.findIndex((line) => line.includes("skill_snapshot_activation_confirmed")) >= 0);
      assert.ok(
        observedLines.findIndex((line) => line.includes("skill_snapshot_activation_confirmed")) <
        observedLines.findIndex((line) => line.includes("child_prompt_submitted")),
      );
      const firstChildRequest = JSON.parse((await fs.readFile(fake.logPath, "utf8")).trim().split("\n")[0]!) as {
        request: { skillFilePath?: string };
      };
      assert.equal(firstChildRequest.request.skillFilePath, activation.receipt.resolved_skill_path);
      const runtimeRoot = path.dirname(firstChildRequest.request.skillFilePath!);
      assert.equal(await fs.readFile(path.join(runtimeRoot, "references", "guide.md"), "utf8"), "guide\n");
      assert.equal(await fs.readFile(path.join(runtimeRoot, "scripts", "run.sh"), "utf8"), "#!/bin/sh\necho alpha\n");

      // An isolated task root can still follow the immutable SKILL.md sidecar
      // reference, but its authoring tools cannot mutate or escape that bundle.
      const authoringTools = createTaskRootAuthoringTools(cwd, activation.receipt.resolved_skill_path);
      const authoringRead = authoringTools.find((tool) => tool.name === "read")!;
      const authoringLs = authoringTools.find((tool) => tool.name === "ls")!;
      const authoringWrite = authoringTools.find((tool) => tool.name === "write")!;
      const authoringEdit = authoringTools.find((tool) => tool.name === "edit")!;
      const toolContext = undefined as never;
      const guide = await authoringRead.execute("read-guide", { path: "references/guide.md" }, undefined, undefined, toolContext);
      assert.match(JSON.stringify(guide.content), /guide/);
      const guideListing = await authoringLs.execute("list-guide", { path: "references" }, undefined, undefined, toolContext);
      assert.match(JSON.stringify(guideListing.content), /guide\.md/);
      const snapshotGuide = path.join(runtimeRoot, "references", "guide.md");
      await assert.rejects(
        authoringWrite.execute("write-guide", { path: snapshotGuide, content: "changed\n" }, undefined, undefined, toolContext),
        /task root/,
      );
      await assert.rejects(
        authoringEdit.execute("edit-guide", { path: snapshotGuide, edits: [{ oldText: "guide", newText: "changed" }] }, undefined, undefined, toolContext),
        /task root/,
      );
      const unrelatedOutside = path.join(tmp, "unrelated.md");
      await fs.writeFile(unrelatedOutside, "outside\n");
      await assert.rejects(
        authoringRead.execute("read-outside", { path: unrelatedOutside }, undefined, undefined, toolContext),
        /task root/,
      );
      const fresh = await runSubagentCore({
        cwd,
        prompt: "FAST",
        skill_name: "alpha",
        skill_snapshot_binding: launchBinding,
        continuity: { mode: "fresh" },
      }, { runsDir });
      assert.equal(fresh.session_established, true);
      assert.ok(fresh.session_id);
      const resumed = await runSubagentCore({
        cwd,
        prompt: "FAST",
        skill_name: "alpha",
        skill_snapshot_binding: launchBinding,
        continuity: { mode: "resume", session_id: fresh.session_id! },
        recursive_delegation: "disabled",
      }, { runsDir });
      assert.equal(resumed.skill_snapshot_activation_receipt?.snapshot_id, digest);

      const futureDigest = (await validateSkillRuntimeBundle(skillRoot)).bundle_sha256;
      const future = await publishSkillSnapshotsRequest({
        contract_version: 1,
        cwd,
        project_reference: { project_id: "project-future", publication_id: "publication-future", lifecycle: "active" },
        bindings: [{ skill_name: "alpha", expected_bundle_sha256: futureDigest }],
      }, { lookupPaths: [lookup], agentDir: path.join(tmp, "agent"), snapshotsRoot });
      assert.equal(future.kind, "skill_snapshots_published");
      if (future.kind !== "skill_snapshots_published") throw new Error("expected future publication");
      const futureItem = future.bindings[0]!;
      const futureBinding = {
        contract_version: 1 as const,
        snapshot_id: futureItem.snapshot_identity.snapshot_id,
        metadata_sha256: futureItem.snapshot_identity.metadata_sha256,
        publication_receipt_sha256: futureItem.publication_receipt.receipt_sha256,
        reference_id: futureItem.publication_receipt.reference_id,
        project_id: futureItem.publication_receipt.project_reference.project_id,
        publication_id: futureItem.publication_receipt.project_reference.publication_id,
      };
      const futureResult = await runSubagentCore({
        cwd,
        prompt: "FAST",
        skill_name: "alpha",
        skill_snapshot_binding: futureBinding,
      }, { runsDir });
      assert.equal(futureResult.skill_snapshot_activation_receipt?.snapshot_id, futureDigest);
      assert.notEqual(futureDigest, digest);

      const runtimeGuide = path.join(binding.snapshot_identity.snapshot_path, "runtime", "references", "guide.md");
      await fs.chmod(path.dirname(runtimeGuide), 0o755);
      await fs.chmod(runtimeGuide, 0o644);
      await fs.writeFile(runtimeGuide, "altered snapshot\n");
      await assert.rejects(
        runSubagentCore({ cwd, prompt: "MUST NOT START", skill_name: "alpha", skill_snapshot_binding: launchBinding }, { runsDir }),
        /skill snapshot activation rejected before child launch/,
      );
      await fs.rename(binding.snapshot_identity.snapshot_path, `${binding.snapshot_identity.snapshot_path}.missing`);
      await assert.rejects(
        runSubagentCore({ cwd, prompt: "MUST NOT START", skill_name: "alpha", skill_snapshot_binding: launchBinding }, { runsDir }),
        (error: unknown) => error instanceof Error && "reasonCode" in error && error.reasonCode === "skill_snapshot_not_found",
      );
      const logs = (await fs.readFile(fake.logPath, "utf8")).trim().split("\n");
      assert.equal(logs.length, 4);
    } finally {
      if (prior.child === undefined) delete process.env.SUBAGENT007_PI_CHILD_PATH; else process.env.SUBAGENT007_PI_CHILD_PATH = prior.child;
      if (prior.log === undefined) delete process.env.FAKE_PI_LOG_PATH; else process.env.FAKE_PI_LOG_PATH = prior.log;
      if (prior.snapshots === undefined) delete process.env.SUBAGENT007_SKILL_SNAPSHOTS_DIR; else process.env.SUBAGENT007_SKILL_SNAPSHOTS_DIR = prior.snapshots;
    }
  });
});
