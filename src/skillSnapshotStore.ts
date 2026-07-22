import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { processIsDefinitelyGone } from "./processLiveness.js";
import {
  captureSkillRuntimeBundle,
  type CapturedSkillRuntimeBundle,
  type SkillRuntimeBundleEvidence,
} from "./skillRuntimeBundle.js";

export const SKILL_SNAPSHOTS_DIR_ENV = "SUBAGENT007_SKILL_SNAPSHOTS_DIR";
const SNAPSHOT_METADATA_FILE = "snapshot.json";
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_MS = 10;
const IMPACT_DIGEST_DOMAIN = "subagent007.skill_snapshot_deletion_impact.v1\n";

export interface RuntimeBundleSourceIdentity {
  schema_version: 1;
  source_id: string;
  resolved_skill_path: string;
  source_root_path: string;
}

export interface SkillSnapshotIdentity {
  schema_version: 1;
  snapshot_id: string;
  snapshot_path: string;
  metadata_sha256: string;
}

export interface SkillSnapshotProjectReference {
  project_id: string;
  publication_id: string;
  lifecycle: "active" | "closed";
}

export interface SkillSnapshotMetadata {
  schema_version: 1;
  snapshot_identity: SkillSnapshotIdentity;
  bundle_sha256: string;
  runtime_closure: SkillRuntimeBundleEvidence;
}

export interface SkillSnapshotReferenceRecord {
  schema_version: 1;
  reference_id: string;
  skill_name: string;
  snapshot_id: string;
  bundle_sha256: string;
  publication_request_sha256: string;
  project_reference: SkillSnapshotProjectReference;
}

export interface SkillSnapshotDeletionImpactReport {
  schema_version: 1;
  snapshot_id: string;
  affected_project_count: number;
  affected_projects: SkillSnapshotProjectReference[];
  affected_reference_count: number;
  affected_references: SkillSnapshotReferenceRecord[];
  impact_sha256: string;
}

export interface SkillSnapshotPublicationPreparedBinding {
  skill_name: string;
  source_identity: RuntimeBundleSourceIdentity;
  snapshot_identity: SkillSnapshotIdentity;
  bundle_sha256: string;
  runtime_closure: SkillRuntimeBundleEvidence;
}

export interface SkillSnapshotPublicationReceiptBinding extends SkillSnapshotPublicationPreparedBinding {
  publication_receipt: {
    schema_version: 1;
    receipt_sha256: string;
    project_reference: SkillSnapshotProjectReference;
    reference_id: string;
  };
}

export interface SkillSnapshotPublicationRecord {
  schema_version: 1;
  project_id: string;
  publication_id: string;
  publication_request_sha256: string;
  status: "pending" | "committed";
  prepared_bindings: SkillSnapshotPublicationPreparedBinding[];
  committed_bindings?: SkillSnapshotPublicationReceiptBinding[];
  record_sha256: string;
}

export class SkillSnapshotPublicationConflictError extends Error {
  constructor() {
    super("publication identity is already bound to a different canonical request");
    this.name = "SkillSnapshotPublicationConflictError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultSkillSnapshotsRoot(): string {
  return process.env[SKILL_SNAPSHOTS_DIR_ENV]
    ? path.resolve(process.env[SKILL_SNAPSHOTS_DIR_ENV]!)
    : path.join(os.homedir(), ".codex", "subagent007-pi", "skill-snapshots");
}

function bundlePath(root: string, snapshotId: string): string {
  return path.join(root, "bundles", snapshotId);
}

function referenceDirectory(root: string, snapshotId: string): string {
  return path.join(root, "references", snapshotId);
}

function publicationKey(projectId: string, publicationId: string): string {
  return createHash("sha256")
    .update("subagent007.skill_snapshot_publication.identity.v1\n")
    .update(JSON.stringify({ project_id: projectId, publication_id: publicationId }))
    .digest("hex");
}

function publicationRecordPath(root: string, projectId: string, publicationId: string): string {
  return path.join(root, "publications", `${publicationKey(projectId, publicationId)}.json`);
}

function publicationRecordSha256(record: unknown): string {
  return createHash("sha256")
    .update("subagent007.skill_snapshot_publication.record.v1\n")
    .update(JSON.stringify(record))
    .digest("hex");
}

function lockPath(root: string, snapshotId: string): string {
  return path.join(root, "locks", `${snapshotId}.lock`);
}

async function writeJsonExclusive(filePath: string, value: unknown): Promise<void> {
  const payload = `${JSON.stringify(value)}\n`;
  try {
    await fs.writeFile(filePath, payload, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await fs.readFile(filePath, "utf8") !== payload) {
      throw new Error(`existing durable record differs at ${filePath}`);
    }
  }
}

async function acquireSnapshotLock(root: string, snapshotId: string): Promise<() => Promise<void>> {
  const locksDir = path.dirname(lockPath(root, snapshotId));
  await fs.mkdir(locksDir, { recursive: true });
  const target = lockPath(root, snapshotId);
  const token = randomUUID();
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      await fs.writeFile(target, `${JSON.stringify({ schema_version: 1, pid: process.pid, token })}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return async () => {
        const current = await fs.readFile(target, "utf8").catch(() => undefined);
        if (current === `${JSON.stringify({ schema_version: 1, pid: process.pid, token })}\n`) {
          await fs.rm(target, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await fs.readFile(target, "utf8")) as { schema_version?: unknown; pid?: unknown };
        if (
          owner.schema_version === 1 && typeof owner.pid === "number" &&
          Number.isSafeInteger(owner.pid) && owner.pid > 0 && processIsDefinitelyGone(owner.pid)
        ) {
          await fs.rm(target, { force: true });
          continue;
        }
      } catch {
        // An unreadable live lock fails closed until the bounded acquisition window expires.
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(`skill snapshot ${snapshotId} is locked`);
}

export async function withSkillSnapshotLock<T>(
  snapshotId: string,
  operation: (root: string) => Promise<T>,
  options: { snapshotsRoot?: string } = {},
): Promise<T> {
  const root = path.resolve(options.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const release = await acquireSnapshotLock(root, snapshotId);
  try {
    return await operation(root);
  } finally {
    await release();
  }
}

async function chmodSnapshotTree(root: string, relativeDirectory = "runtime"): Promise<void> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      await chmodSnapshotTree(root, relativePath);
    } else {
      const executable = ((await fs.stat(absolutePath)).mode & 0o111) !== 0;
      await fs.chmod(absolutePath, executable ? 0o555 : 0o444);
    }
  }
  await fs.chmod(absoluteDirectory, 0o555);
}

async function makeSnapshotTreeRemovable(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await fs.chmod(root, 0o755).catch(() => undefined);
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeSnapshotTreeRemovable(target);
    else await fs.chmod(target, 0o644).catch(() => undefined);
  }
}

export async function materializeSkillSnapshot(input: {
  captured: CapturedSkillRuntimeBundle;
  snapshotsRoot?: string;
}): Promise<SkillSnapshotMetadata> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const snapshotId = input.captured.bundle_sha256;
  const target = bundlePath(root, snapshotId);
  const { source_root_path: _sourceRoot, resolved_skill_path: _skillPath, contents: _contents, ...runtime_closure } = input.captured;
  const identityBase = {
    schema_version: 1 as const,
    snapshot_id: snapshotId,
    snapshot_path: target,
  };
  const metadataSha256 = createHash("sha256")
    .update("subagent007.skill_snapshot.metadata.v1\n")
    .update(JSON.stringify({
      schema_version: 1 as const,
      snapshot_identity: identityBase,
      bundle_sha256: snapshotId,
      runtime_closure,
    }))
    .digest("hex");
  const identity: SkillSnapshotIdentity = { ...identityBase, metadata_sha256: metadataSha256 };
  const metadata: SkillSnapshotMetadata = {
    schema_version: 1,
    snapshot_identity: identity,
    bundle_sha256: snapshotId,
    runtime_closure,
  };
  const release = await acquireSnapshotLock(root, snapshotId);
  try {
    try {
      return await validateRecordedSkillSnapshot(identity, { snapshotsRoot: root });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stagingRoot = path.join(root, "staging");
    await fs.mkdir(stagingRoot, { recursive: true });
    const stage = await fs.mkdtemp(path.join(stagingRoot, `${snapshotId}-`));
    try {
      for (const file of input.captured.files) {
        const destination = path.join(stage, "runtime", ...file.relative_path.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, input.captured.contents.get(file.relative_path)!, {
          flag: "wx",
          mode: file.executable ? 0o755 : 0o644,
        });
      }
      await writeJsonExclusive(path.join(stage, SNAPSHOT_METADATA_FILE), metadata);
      await chmodSnapshotTree(stage);
      await fs.chmod(path.join(stage, SNAPSHOT_METADATA_FILE), 0o444);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(stage, target);
      await fs.chmod(target, 0o555);
    } finally {
      await makeSnapshotTreeRemovable(stage);
      await fs.rm(stage, { recursive: true, force: true });
    }
    return await validateRecordedSkillSnapshot(identity, { snapshotsRoot: root });
  } finally {
    await release();
  }
}

function exactSnapshotPath(identity: SkillSnapshotIdentity, root: string): string {
  if (
    !/^[0-9a-f]{64}$/.test(identity.snapshot_id) ||
    !/^[0-9a-f]{64}$/.test(identity.metadata_sha256) ||
    identity.schema_version !== 1
  ) {
    throw new Error("skill snapshot identity is malformed");
  }
  const expected = bundlePath(root, identity.snapshot_id);
  if (path.resolve(identity.snapshot_path) !== expected) {
    throw new Error("skill snapshot path does not match owner-derived identity");
  }
  return expected;
}

export async function validateRecordedSkillSnapshot(
  identity: SkillSnapshotIdentity,
  options: { snapshotsRoot?: string } = {},
): Promise<SkillSnapshotMetadata> {
  const root = path.resolve(options.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const target = exactSnapshotPath(identity, root);
  let metadata: SkillSnapshotMetadata;
  try {
    const entries = (await fs.readdir(target)).sort();
    if (JSON.stringify(entries) !== JSON.stringify([SNAPSHOT_METADATA_FILE, "runtime"].sort())) {
      throw new Error("recorded skill snapshot contains unexpected or missing root entries");
    }
    metadata = JSON.parse(await fs.readFile(path.join(target, SNAPSHOT_METADATA_FILE), "utf8")) as SkillSnapshotMetadata;
  } catch (error) {
    const wrapped = new Error("recorded skill snapshot does not exist or metadata is unreadable", { cause: error });
    (wrapped as NodeJS.ErrnoException).code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  }
  const runtime = await captureSkillRuntimeBundle(path.join(target, "runtime"));
  const { source_root_path: _root, resolved_skill_path: _path, contents: _contents, ...runtimeEvidence } = runtime;
  const metadataIdentityBase = {
    schema_version: metadata.snapshot_identity?.schema_version,
    snapshot_id: metadata.snapshot_identity?.snapshot_id,
    snapshot_path: metadata.snapshot_identity?.snapshot_path,
  };
  const metadataSha256 = createHash("sha256")
    .update("subagent007.skill_snapshot.metadata.v1\n")
    .update(JSON.stringify({
      schema_version: metadata.schema_version,
      snapshot_identity: metadataIdentityBase,
      bundle_sha256: metadata.bundle_sha256,
      runtime_closure: metadata.runtime_closure,
    }))
    .digest("hex");
  if (
    metadata.schema_version !== 1 || metadata.bundle_sha256 !== identity.snapshot_id ||
    JSON.stringify(metadata.snapshot_identity) !== JSON.stringify(identity) ||
    runtime.bundle_sha256 !== identity.snapshot_id ||
    metadataSha256 !== identity.metadata_sha256 ||
    JSON.stringify(metadata.runtime_closure) !== JSON.stringify(runtimeEvidence)
  ) {
    throw new Error("recorded skill snapshot is altered, incomplete, or mismatched");
  }
  return metadata;
}

function referenceId(input: {
  skill_name: string;
  snapshot_id: string;
  bundle_sha256: string;
  publication_request_sha256: string;
  project_id: string;
  publication_id: string;
}): string {
  return createHash("sha256").update("subagent007.skill_snapshot_reference.v1\n").update(JSON.stringify(input)).digest("hex");
}

export async function registerSkillSnapshotReference(input: {
  skill_name: string;
  metadata: SkillSnapshotMetadata;
  project_reference: SkillSnapshotProjectReference;
  publication_request_sha256: string;
  snapshotsRoot?: string;
}): Promise<SkillSnapshotReferenceRecord> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const snapshotId = input.metadata.snapshot_identity.snapshot_id;
  const recordBase = {
    skill_name: input.skill_name,
    snapshot_id: snapshotId,
    bundle_sha256: input.metadata.bundle_sha256,
    publication_request_sha256: input.publication_request_sha256,
    project_reference: input.project_reference,
  };
  const record: SkillSnapshotReferenceRecord = {
    schema_version: 1,
    reference_id: referenceId({
      skill_name: recordBase.skill_name,
      snapshot_id: recordBase.snapshot_id,
      bundle_sha256: recordBase.bundle_sha256,
      publication_request_sha256: recordBase.publication_request_sha256,
      project_id: recordBase.project_reference.project_id,
      publication_id: recordBase.project_reference.publication_id,
    }),
    ...recordBase,
  };
  const release = await acquireSnapshotLock(root, snapshotId);
  try {
    await validateRecordedSkillSnapshot(input.metadata.snapshot_identity, { snapshotsRoot: root });
    const dir = referenceDirectory(root, snapshotId);
    await fs.mkdir(dir, { recursive: true });
    const recordPath = path.join(dir, `${record.reference_id}.json`);
    try {
      await writeJsonExclusive(recordPath, record);
      return record;
    } catch (error) {
      const existing = await fs.readFile(recordPath, "utf8").then((value) => JSON.parse(value) as SkillSnapshotReferenceRecord).catch(() => undefined);
      if (
        existing && existing.reference_id === record.reference_id &&
        existing.project_reference.lifecycle === "closed" &&
        JSON.stringify({ ...existing, project_reference: { ...existing.project_reference, lifecycle: "active" } }) === JSON.stringify(record)
      ) return existing;
      throw error;
    }
  } finally {
    await release();
  }
}

async function referenceRecords(root: string, snapshotId: string): Promise<SkillSnapshotReferenceRecord[]> {
  const dir = referenceDirectory(root, snapshotId);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as SkillSnapshotReferenceRecord;
    const expectedId = referenceId({
      skill_name: record.skill_name,
      snapshot_id: record.snapshot_id,
      bundle_sha256: record.bundle_sha256,
      publication_request_sha256: record.publication_request_sha256,
      project_id: record.project_reference?.project_id,
      publication_id: record.project_reference?.publication_id,
    });
    if (
      record.schema_version !== 1 || record.snapshot_id !== snapshotId || record.bundle_sha256 !== snapshotId ||
      !/^[0-9a-f]{64}$/.test(record.publication_request_sha256) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(record.skill_name) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.project_reference?.project_id ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(record.project_reference?.publication_id ?? "") ||
      !["active", "closed"].includes(record.project_reference?.lifecycle) ||
      record.reference_id !== expectedId || name !== `${record.reference_id}.json`
    ) throw new Error(`invalid skill snapshot reference record ${name}`);
    return record;
  }));
  return records;
}

export async function validateSkillSnapshotReference(input: {
  snapshot_id: string;
  reference_id: string;
  project_id: string;
  publication_id: string;
  snapshotsRoot?: string;
}): Promise<SkillSnapshotReferenceRecord> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const matches = (await referenceRecords(root, input.snapshot_id)).filter((record) =>
    record.reference_id === input.reference_id &&
    record.project_reference.project_id === input.project_id &&
    record.project_reference.publication_id === input.publication_id);
  if (matches.length !== 1) {
    throw new Error("skill snapshot reference does not exactly match the recorded project binding");
  }
  return matches[0]!;
}

async function replaceJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readPublicationRecord(
  root: string,
  projectId: string,
  publicationId: string,
): Promise<SkillSnapshotPublicationRecord | undefined> {
  const filePath = publicationRecordPath(root, projectId, publicationId);
  try {
    const record = JSON.parse(await fs.readFile(filePath, "utf8")) as SkillSnapshotPublicationRecord;
    const { record_sha256, ...recordBase } = record;
    const expectedRecordSha256 = publicationRecordSha256(recordBase);
    if (
      record.schema_version !== 1 || record.project_id !== projectId || record.publication_id !== publicationId ||
      !/^[0-9a-f]{64}$/.test(record.publication_request_sha256) ||
      !["pending", "committed"].includes(record.status) || !Array.isArray(record.prepared_bindings) ||
      (record.status === "committed" && !Array.isArray(record.committed_bindings)) ||
      record_sha256 !== expectedRecordSha256
    ) throw new Error("skill snapshot publication record is invalid");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function getSkillSnapshotPublicationRecord(input: {
  project_id: string;
  publication_id: string;
  publication_request_sha256: string;
  snapshotsRoot?: string;
}): Promise<SkillSnapshotPublicationRecord | undefined> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const record = await readPublicationRecord(root, input.project_id, input.publication_id);
  if (record && record.publication_request_sha256 !== input.publication_request_sha256) {
    throw new SkillSnapshotPublicationConflictError();
  }
  return record;
}

export async function claimSkillSnapshotPublication(input: {
  project_id: string;
  publication_id: string;
  publication_request_sha256: string;
  prepared_bindings: SkillSnapshotPublicationPreparedBinding[];
  snapshotsRoot?: string;
}): Promise<SkillSnapshotPublicationRecord> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const key = publicationKey(input.project_id, input.publication_id);
  const release = await acquireSnapshotLock(root, key);
  try {
    const existing = await readPublicationRecord(root, input.project_id, input.publication_id);
    if (existing) {
      if (existing.publication_request_sha256 !== input.publication_request_sha256) {
        throw new SkillSnapshotPublicationConflictError();
      }
      return existing;
    }
    const recordBase = {
      schema_version: 1 as const,
      project_id: input.project_id,
      publication_id: input.publication_id,
      publication_request_sha256: input.publication_request_sha256,
      status: "pending" as const,
      prepared_bindings: input.prepared_bindings,
    };
    const record: SkillSnapshotPublicationRecord = {
      ...recordBase,
      record_sha256: publicationRecordSha256(recordBase),
    };
    const filePath = publicationRecordPath(root, input.project_id, input.publication_id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeJsonExclusive(filePath, record);
    return record;
  } finally {
    await release();
  }
}

export async function commitSkillSnapshotPublication(input: {
  record: SkillSnapshotPublicationRecord;
  committed_bindings: SkillSnapshotPublicationReceiptBinding[];
  snapshotsRoot?: string;
}): Promise<SkillSnapshotPublicationRecord> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const key = publicationKey(input.record.project_id, input.record.publication_id);
  const release = await acquireSnapshotLock(root, key);
  try {
    const current = await readPublicationRecord(root, input.record.project_id, input.record.publication_id);
    if (!current || current.publication_request_sha256 !== input.record.publication_request_sha256) {
      throw new Error("publication claim disappeared or changed before commit");
    }
    if (current.status === "committed") {
      if (JSON.stringify(current.committed_bindings) !== JSON.stringify(input.committed_bindings)) {
        throw new Error("committed publication differs from idempotent replay");
      }
      return current;
    }
    const { record_sha256: _recordSha256, ...currentBase } = current;
    const committedBase = {
      ...currentBase,
      status: "committed" as const,
      committed_bindings: input.committed_bindings,
    };
    const committed: SkillSnapshotPublicationRecord = {
      ...committedBase,
      record_sha256: publicationRecordSha256(committedBase),
    };
    await replaceJson(publicationRecordPath(root, current.project_id, current.publication_id), committed);
    return committed;
  } finally {
    await release();
  }
}

export async function closeSkillSnapshotReferences(input: {
  project_id: string;
  publication_id: string;
  snapshot_ids: string[];
  snapshotsRoot?: string;
}): Promise<SkillSnapshotReferenceRecord[]> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const publication = await readPublicationRecord(root, input.project_id, input.publication_id);
  const expectedSnapshotIds = publication?.committed_bindings
    ?.map((binding) => binding.snapshot_identity.snapshot_id)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (
    publication?.status !== "committed" ||
    JSON.stringify(expectedSnapshotIds) !== JSON.stringify(input.snapshot_ids)
  ) {
    throw new Error("snapshot_ids must exactly match the complete committed publication set");
  }
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const snapshotId of input.snapshot_ids) {
      releases.push(await acquireSnapshotLock(root, snapshotId));
    }
    const matched: Array<{ filePath: string; record: SkillSnapshotReferenceRecord }> = [];
    for (const snapshotId of input.snapshot_ids) {
      const records = (await referenceRecords(root, snapshotId)).filter((record) =>
        record.project_reference.project_id === input.project_id &&
        record.project_reference.publication_id === input.publication_id);
      if (records.length !== 1) {
        throw new Error(`snapshot ${snapshotId} does not have exactly one matching project reference`);
      }
      matched.push({
        filePath: path.join(referenceDirectory(root, snapshotId), `${records[0]!.reference_id}.json`),
        record: records[0]!,
      });
    }
    const closed = [];
    for (const item of matched) {
      const record = item.record.project_reference.lifecycle === "closed"
        ? item.record
        : {
            ...item.record,
            project_reference: { ...item.record.project_reference, lifecycle: "closed" as const },
          };
      if (record !== item.record) await replaceJson(item.filePath, record);
      closed.push(record);
    }
    return closed;
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

function deletionImpact(snapshotId: string, records: SkillSnapshotReferenceRecord[]): SkillSnapshotDeletionImpactReport {
  const projects = [...new Map(records.map((record) => [
    JSON.stringify(record.project_reference),
    record.project_reference,
  ])).values()].sort((left, right) => {
    const byProject = left.project_id.localeCompare(right.project_id, "en");
    return byProject || left.publication_id.localeCompare(right.publication_id, "en");
  });
  const base = {
    schema_version: 1 as const,
    snapshot_id: snapshotId,
    affected_project_count: projects.length,
    affected_projects: projects,
    affected_reference_count: records.length,
    affected_references: records,
  };
  return {
    ...base,
    impact_sha256: createHash("sha256").update(IMPACT_DIGEST_DOMAIN).update(JSON.stringify(base)).digest("hex"),
  };
}

export async function planSkillSnapshotDeletion(
  snapshotId: string,
  options: { snapshotsRoot?: string } = {},
): Promise<SkillSnapshotDeletionImpactReport> {
  const root = path.resolve(options.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  await fs.access(bundlePath(root, snapshotId)).catch((error) => {
    const wrapped = new Error("recorded skill snapshot does not exist", { cause: error });
    (wrapped as NodeJS.ErrnoException).code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  });
  return deletionImpact(snapshotId, await referenceRecords(root, snapshotId));
}

export async function deleteSkillSnapshot(input: {
  snapshotId: string;
  confirmImpactSha256: string;
  snapshotsRoot?: string;
}): Promise<{ deleted: boolean; impact_report: SkillSnapshotDeletionImpactReport }> {
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const release = await acquireSnapshotLock(root, input.snapshotId);
  try {
    const impact = await planSkillSnapshotDeletion(input.snapshotId, { snapshotsRoot: root });
    if (impact.impact_sha256 !== input.confirmImpactSha256) {
      return { deleted: false, impact_report: impact };
    }
    const target = bundlePath(root, input.snapshotId);
    await makeSnapshotTreeRemovable(target);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rm(referenceDirectory(root, input.snapshotId), { recursive: true, force: true });
    return { deleted: true, impact_report: impact };
  } finally {
    await release();
  }
}
