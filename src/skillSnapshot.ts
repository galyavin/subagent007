import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { loadSkillCatalog, resolveRequestedSkillFromCatalog, SkillResolutionError } from "./skillResources.js";
import {
  captureSkillRuntimeBundle,
  RuntimeBundleValidationError,
  type SkillRuntimeBundleEvidence,
} from "./skillRuntimeBundle.js";
import {
  closeSkillSnapshotReferences,
  claimSkillSnapshotPublication,
  commitSkillSnapshotPublication,
  defaultSkillSnapshotsRoot,
  deleteSkillSnapshot,
  materializeSkillSnapshot,
  getSkillSnapshotPublicationRecord,
  planSkillSnapshotDeletion,
  registerSkillSnapshotReference,
  validateRecordedSkillSnapshot,
  validateSkillSnapshotReference,
  type RuntimeBundleSourceIdentity,
  type SkillSnapshotIdentity,
  type SkillSnapshotProjectReference,
  type SkillSnapshotMetadata,
  type SkillSnapshotPublicationPreparedBinding,
  type SkillSnapshotPublicationRecord,
  type SkillSnapshotPublicationReceiptBinding,
  SkillSnapshotPublicationConflictError,
} from "./skillSnapshotStore.js";
import { ValidationError, type SkillSnapshotActivationReceipt, type SkillSnapshotLaunchBinding } from "./types.js";
import { validateCwd } from "./validate.js";
import { declaredSkillName } from "./skillRuntimeBundleValidation.js";

export const SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME =
  "subagent007.skill_runtime_bundle_resolution" as const;
export const SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_VERSION = 1 as const;
export const MAX_SKILL_RUNTIME_BUNDLE_RESOLUTION_ENTRIES = 64;
const REQUEST_DIGEST_DOMAIN = `${SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME}.request.v1\n`;
const SOURCE_ID_DOMAIN = "subagent007.skill_runtime_source.v1\n";

export interface SkillRuntimeBundleResolutionRequest {
  contract_version: 1;
  cwd: string;
  skill_names: string[];
}

export { validateRecordedSkillSnapshot };

interface ResolvedRuntimeBundleBinding {
  skill_name: string;
  source_identity: RuntimeBundleSourceIdentity;
  bundle_sha256: string;
  runtime_closure: SkillRuntimeBundleEvidence;
}

interface RuntimeBundleResolutionBase {
  contract_name: typeof SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME;
  contract_version: 1;
  success: boolean;
  resolved: boolean;
  child_started: false;
  model_invoked: false;
  request_binding: { cwd: string; count: number; canonical_request_sha256: string };
}

export type SkillRuntimeBundleResolutionResult =
  | (RuntimeBundleResolutionBase & {
      kind: "skill_runtime_bundles_resolved";
      success: true;
      resolved: true;
      bindings: ResolvedRuntimeBundleBinding[];
    })
  | (RuntimeBundleResolutionBase & {
      kind: "skill_runtime_bundle_resolution_rejected";
      success: false;
      resolved: false;
      reason_code: string;
      message: string;
      failed_skill?: { index: number; skill_name: string };
    });

export function canonicalRuntimeBundleResolutionRequestSha256(request: SkillRuntimeBundleResolutionRequest): string {
  return createHash("sha256").update(REQUEST_DIGEST_DOMAIN).update(JSON.stringify({
    contract_version: request.contract_version,
    cwd: request.cwd,
    skill_names: request.skill_names,
  })).digest("hex");
}

function requestBinding(request: SkillRuntimeBundleResolutionRequest) {
  return {
    cwd: request.cwd,
    count: request.skill_names.length,
    canonical_request_sha256: canonicalRuntimeBundleResolutionRequestSha256(request),
  };
}

function rejected(
  request: SkillRuntimeBundleResolutionRequest,
  reason_code: string,
  message: string,
  failed_skill?: { index: number; skill_name: string },
): SkillRuntimeBundleResolutionResult {
  return {
    contract_name: SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME,
    contract_version: 1,
    kind: "skill_runtime_bundle_resolution_rejected",
    success: false,
    resolved: false,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    reason_code,
    ...(failed_skill ? { failed_skill } : {}),
    message,
  };
}

function sourceIdentity(input: {
  skill_name: string;
  resolved_skill_path: string;
  source_root_path: string;
  bundle_sha256: string;
}): RuntimeBundleSourceIdentity {
  return {
    schema_version: 1,
    source_id: createHash("sha256").update(SOURCE_ID_DOMAIN).update(JSON.stringify(input)).digest("hex"),
    resolved_skill_path: input.resolved_skill_path,
    source_root_path: input.source_root_path,
  };
}

export interface SkillSnapshotPublicationRequest {
  contract_version: 1;
  cwd: string;
  project_reference: SkillSnapshotProjectReference & { lifecycle: "active" };
  bindings: Array<{ skill_name: string; expected_bundle_sha256: string; source_root?: string }>;
}

async function exactPublicationSourceRoot(cwd: string, sourceRoot: string): Promise<string> {
  const reject = (message: string, cause?: unknown): never => {
    throw new RuntimeBundleValidationError("runtime_bundle_unsafe_path", message, cause === undefined ? {} : { cause });
  };
  if (!path.isAbsolute(sourceRoot) || path.resolve(sourceRoot) !== sourceRoot) {
    return reject("staged runtime bundle source_root must be a canonical absolute path");
  }
  let rootStat;
  let realRoot;
  let realCwd;
  try {
    rootStat = await fs.lstat(sourceRoot);
    [realRoot, realCwd] = await Promise.all([fs.realpath(sourceRoot), fs.realpath(cwd)]);
  } catch (error) {
    return reject("staged runtime bundle source_root could not be inspected", error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realRoot !== sourceRoot) {
    return reject("staged runtime bundle source_root must be an exact real directory, not a symlink");
  }
  if (realRoot !== realCwd && !realRoot.startsWith(`${realCwd}${path.sep}`)) {
    return reject("staged runtime bundle source_root must remain under cwd");
  }
  return realRoot;
}

export type SkillSnapshotPublicationResult =
  | {
      contract_name: "subagent007.skill_snapshot_publication";
      contract_version: 1;
      kind: "skill_snapshots_published";
      success: true;
      published: true;
      child_started: false;
      model_invoked: false;
      request_binding: { cwd: string; count: number; canonical_request_sha256: string };
      bindings: Array<{
        skill_name: string;
        source_identity: RuntimeBundleSourceIdentity;
        snapshot_identity: SkillSnapshotIdentity;
        bundle_sha256: string;
        runtime_closure: SkillRuntimeBundleEvidence;
        publication_receipt: {
          schema_version: 1;
          receipt_sha256: string;
          project_reference: SkillSnapshotProjectReference;
          reference_id: string;
        };
      }>;
    }
  | {
      contract_name: "subagent007.skill_snapshot_publication";
      contract_version: 1;
      kind: "skill_snapshot_publication_rejected";
      success: false;
      published: false;
      child_started: false;
      model_invoked: false;
      request_binding: { cwd: string; count: number; canonical_request_sha256: string };
      reason_code: string;
      message: string;
      failed_binding?: {
        index: number;
        skill_name: string;
        expected_bundle_sha256: string;
        actual_bundle_sha256?: string;
      };
    };

const SNAPSHOT_PUBLICATION_REQUEST_DOMAIN = "subagent007.skill_snapshot_publication.request.v1\n";
export const SNAPSHOT_PUBLICATION_RECEIPT_DOMAIN = "subagent007.skill_snapshot_publication.receipt.v1\n";

export function skillSnapshotPublicationReceiptSha256(input: {
  snapshot_identity: SkillSnapshotIdentity;
  project_reference: SkillSnapshotProjectReference;
  reference_id: string;
}): string {
  return createHash("sha256")
    .update(SNAPSHOT_PUBLICATION_RECEIPT_DOMAIN)
    .update(JSON.stringify({
      schema_version: 1,
      project_reference: input.project_reference,
      reference_id: input.reference_id,
      snapshot_identity: input.snapshot_identity,
    }))
    .digest("hex");
}

export type SkillSnapshotLaunchReasonCode =
  | "skill_snapshot_not_found"
  | "skill_snapshot_altered"
  | "skill_snapshot_reference_mismatch"
  | "skill_snapshot_reference_closed";

export class SkillSnapshotLaunchError extends Error {
  constructor(readonly reasonCode: SkillSnapshotLaunchReasonCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "SkillSnapshotLaunchError";
  }
}

function publicationRequestBinding(request: SkillSnapshotPublicationRequest) {
  return {
    cwd: request.cwd,
    count: request.bindings.length,
    canonical_request_sha256: createHash("sha256")
      .update(SNAPSHOT_PUBLICATION_REQUEST_DOMAIN)
      .update(JSON.stringify(request))
      .digest("hex"),
  };
}

function publicationRejected(
  request: SkillSnapshotPublicationRequest,
  reason_code: string,
  message: string,
  failed_binding?: {
    index: number;
    skill_name: string;
    expected_bundle_sha256: string;
    actual_bundle_sha256?: string;
  },
): SkillSnapshotPublicationResult {
  return {
    contract_name: "subagent007.skill_snapshot_publication",
    contract_version: 1,
    kind: "skill_snapshot_publication_rejected",
    success: false,
    published: false,
    child_started: false,
    model_invoked: false,
    request_binding: publicationRequestBinding(request),
    reason_code,
    ...(failed_binding ? { failed_binding } : {}),
    message,
  };
}

function publicationSuccess(
  request: SkillSnapshotPublicationRequest,
  bindings: SkillSnapshotPublicationReceiptBinding[],
): SkillSnapshotPublicationResult {
  return {
    contract_name: "subagent007.skill_snapshot_publication",
    contract_version: 1,
    kind: "skill_snapshots_published",
    success: true,
    published: true,
    child_started: false,
    model_invoked: false,
    request_binding: publicationRequestBinding(request),
    bindings,
  };
}

async function finalizePublicationRecord(
  request: SkillSnapshotPublicationRequest,
  record: SkillSnapshotPublicationRecord,
  snapshotsRoot?: string,
): Promise<SkillSnapshotPublicationResult> {
  if (record.status === "committed") {
    for (const binding of record.committed_bindings!) {
      await validateRecordedSkillSnapshot(binding.snapshot_identity, { snapshotsRoot });
      const reference = await validateSkillSnapshotReference({
        snapshot_id: binding.snapshot_identity.snapshot_id,
        reference_id: binding.publication_receipt.reference_id,
        project_id: request.project_reference.project_id,
        publication_id: request.project_reference.publication_id,
        snapshotsRoot,
      });
      if (reference.skill_name !== binding.skill_name) throw new Error("committed publication reference changed");
    }
    return publicationSuccess(request, record.committed_bindings!);
  }
  const committedBindings: SkillSnapshotPublicationReceiptBinding[] = [];
  for (const binding of record.prepared_bindings) {
    const metadata = await validateRecordedSkillSnapshot(binding.snapshot_identity, { snapshotsRoot });
    const reference = await registerSkillSnapshotReference({
      skill_name: binding.skill_name,
      metadata,
      project_reference: request.project_reference,
      publication_request_sha256: record.publication_request_sha256,
      snapshotsRoot,
    });
    const publication_receipt = {
      schema_version: 1 as const,
      project_reference: reference.project_reference,
      reference_id: reference.reference_id,
      receipt_sha256: skillSnapshotPublicationReceiptSha256({
        snapshot_identity: metadata.snapshot_identity,
        project_reference: reference.project_reference,
        reference_id: reference.reference_id,
      }),
    };
    committedBindings.push({ ...binding, publication_receipt });
  }
  const committed = await commitSkillSnapshotPublication({
    record,
    committed_bindings: committedBindings,
    snapshotsRoot,
  });
  return publicationSuccess(request, committed.committed_bindings!);
}

export async function publishSkillSnapshotsRequest(
  request: SkillSnapshotPublicationRequest,
  options: { agentDir?: string; lookupPaths?: string[]; snapshotsRoot?: string } = {},
): Promise<SkillSnapshotPublicationResult> {
  let cwd: string;
  try {
    cwd = await validateCwd(request.cwd);
  } catch (error) {
    if (error instanceof ValidationError && (
      error.reasonCode === "cwd_not_absolute" || error.reasonCode === "cwd_inaccessible" ||
      error.reasonCode === "cwd_not_directory"
    )) return publicationRejected(request, error.reasonCode, error.message);
    throw error;
  }
  const request_binding = publicationRequestBinding(request);
  try {
    const replay = await getSkillSnapshotPublicationRecord({
      project_id: request.project_reference.project_id,
      publication_id: request.project_reference.publication_id,
      publication_request_sha256: request_binding.canonical_request_sha256,
      snapshotsRoot: options.snapshotsRoot,
    });
    if (replay) return await finalizePublicationRecord(request, replay, options.snapshotsRoot);
  } catch (error) {
    return publicationRejected(
      request,
      error instanceof SkillSnapshotPublicationConflictError
        ? "publication_identity_conflict"
        : "publication_recovery_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  const catalog = request.bindings.some((binding) => binding.source_root === undefined)
    ? loadSkillCatalog({
        cwd,
        agentDir: options.agentDir ?? resolvePiAgentDir(),
        ...(options.lookupPaths ? { lookupPaths: options.lookupPaths } : {}),
      })
    : null;
  const prepared = [];
  for (const [index, binding] of request.bindings.entries()) {
    const failed = {
      index,
      skill_name: binding.skill_name,
      expected_bundle_sha256: binding.expected_bundle_sha256,
    };
    let sourceRoot: string;
    if (binding.source_root === undefined) {
      let skill;
      try {
        skill = resolveRequestedSkillFromCatalog(binding.skill_name, catalog!);
      } catch (error) {
        if (error instanceof SkillResolutionError) {
          return publicationRejected(request, error.resolutionCode, error.message, failed);
        }
        throw error;
      }
      sourceRoot = path.dirname(skill.filePath);
    } else {
      try {
        sourceRoot = await exactPublicationSourceRoot(cwd, binding.source_root);
      } catch (error) {
        if (error instanceof RuntimeBundleValidationError) {
          return publicationRejected(request, error.failureCode, error.message, failed);
        }
        throw error;
      }
    }
    try {
      const captured = await captureSkillRuntimeBundle(sourceRoot);
      if (binding.source_root !== undefined) {
        const recheckedRoot = await exactPublicationSourceRoot(cwd, binding.source_root);
        if (captured.source_root_path !== sourceRoot || recheckedRoot !== sourceRoot) {
          throw new RuntimeBundleValidationError(
            "runtime_bundle_changed",
            "staged runtime bundle source_root changed while it was being captured",
          );
        }
        if (declaredSkillName(captured.contents.get("SKILL.md")!) !== binding.skill_name) {
          return publicationRejected(
            request,
            "skill_runtime_bundle_name_mismatch",
            "SKILL.md name does not match the publication skill_name",
            failed,
          );
        }
      }
      if (captured.bundle_sha256 !== binding.expected_bundle_sha256) {
        return publicationRejected(
          request,
          "runtime_bundle_content_mismatch",
          "current runtime bundle does not match the publication freshness digest",
          { ...failed, actual_bundle_sha256: captured.bundle_sha256 },
        );
      }
      prepared.push({
        index,
        binding,
        captured,
        source_identity: sourceIdentity({
          skill_name: binding.skill_name,
          resolved_skill_path: captured.resolved_skill_path,
          source_root_path: captured.source_root_path,
          bundle_sha256: captured.bundle_sha256,
        }),
      });
    } catch (error) {
      if (error instanceof RuntimeBundleValidationError) {
        return publicationRejected(request, error.failureCode, error.message, failed);
      }
      throw error;
    }
  }

  const materialized: SkillSnapshotPublicationPreparedBinding[] = [];
  for (const item of prepared) {
    let metadata;
    try {
      metadata = await materializeSkillSnapshot({
        captured: item.captured,
        snapshotsRoot: options.snapshotsRoot,
      });
    } catch (error) {
      return publicationRejected(
        request,
        "snapshot_materialization_failed",
        error instanceof Error ? error.message : String(error),
        { index: item.index, ...item.binding },
      );
    }
    materialized.push({
      skill_name: item.binding.skill_name,
      source_identity: item.source_identity,
      snapshot_identity: metadata.snapshot_identity,
      bundle_sha256: metadata.bundle_sha256,
      runtime_closure: metadata.runtime_closure,
    });
  }
  try {
    const claim = await claimSkillSnapshotPublication({
      project_id: request.project_reference.project_id,
      publication_id: request.project_reference.publication_id,
      publication_request_sha256: request_binding.canonical_request_sha256,
      prepared_bindings: materialized,
      snapshotsRoot: options.snapshotsRoot,
    });
    return await finalizePublicationRecord(request, claim, options.snapshotsRoot);
  } catch (error) {
    return publicationRejected(
      request,
      error instanceof SkillSnapshotPublicationConflictError
        ? "publication_identity_conflict"
        : "snapshot_materialization_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface RetainedSkillSnapshotSourceResolutionRequest {
  contract_version: 1;
  skill_name: string;
  snapshot_binding: SkillSnapshotLaunchBinding;
}

type RetainedSnapshotSourceResolutionReasonCode =
  | "skill_snapshot_not_found"
  | "skill_snapshot_altered"
  | "skill_snapshot_reference_mismatch"
  | "snapshot_source_resolution_failed";

class RetainedSnapshotSourceResolutionError extends Error {
  constructor(
    readonly reasonCode: RetainedSnapshotSourceResolutionReasonCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "RetainedSnapshotSourceResolutionError";
  }
}

function canonicalRetainedSnapshotSourceResolutionRequest(
  request: RetainedSkillSnapshotSourceResolutionRequest,
) {
  return {
    contract_version: request.contract_version,
    skill_name: request.skill_name,
    snapshot_binding: {
      contract_version: request.snapshot_binding.contract_version,
      snapshot_id: request.snapshot_binding.snapshot_id,
      metadata_sha256: request.snapshot_binding.metadata_sha256,
      publication_receipt_sha256: request.snapshot_binding.publication_receipt_sha256,
      reference_id: request.snapshot_binding.reference_id,
      project_id: request.snapshot_binding.project_id,
      publication_id: request.snapshot_binding.publication_id,
    },
  };
}

function retainedSnapshotSourceResolutionRequestBinding(
  request: RetainedSkillSnapshotSourceResolutionRequest,
) {
  return {
    canonical_request_sha256: createHash("sha256")
      .update("subagent007.skill_snapshot_source_resolution.request.v1\n")
      .update(JSON.stringify(canonicalRetainedSnapshotSourceResolutionRequest(request)))
      .digest("hex"),
  };
}

function retainedSnapshotSourceResolutionRejected(
  request: RetainedSkillSnapshotSourceResolutionRequest,
  reasonCode: RetainedSnapshotSourceResolutionReasonCode,
  message: string,
) {
  return {
    contract_name: "subagent007.skill_snapshot_source_resolution" as const,
    contract_version: 1 as const,
    kind: "skill_snapshot_source_resolution_rejected" as const,
    success: false as const,
    resolved: false as const,
    child_started: false as const,
    model_invoked: false as const,
    request_binding: retainedSnapshotSourceResolutionRequestBinding(request),
    reason_code: reasonCode,
    message,
  };
}

interface ExactSnapshotSourcePathState {
  snapshot_path: string;
  runtime_path: string;
  metadata_path: string;
  snapshot_device: bigint;
  snapshot_inode: bigint;
  runtime_device: bigint;
  runtime_inode: bigint;
  metadata_device: bigint;
  metadata_inode: bigint;
}

async function exactSnapshotSourcePathState(
  identity: SkillSnapshotIdentity,
  snapshotsRoot: string,
): Promise<ExactSnapshotSourcePathState> {
  const snapshotPath = path.join(snapshotsRoot, "bundles", identity.snapshot_id);
  const runtimePath = path.join(snapshotPath, "runtime");
  const metadataPath = path.join(snapshotPath, "snapshot.json");
  if (identity.snapshot_path !== snapshotPath) {
    throw new Error("snapshot identity path is not the owner-derived content-addressed path");
  }
  const [
    snapshotStat,
    snapshotRealPath,
    runtimeStat,
    runtimeRealPath,
    metadataStat,
    metadataRealPath,
  ] = await Promise.all([
    fs.lstat(snapshotPath, { bigint: true }),
    fs.realpath(snapshotPath),
    fs.lstat(runtimePath, { bigint: true }),
    fs.realpath(runtimePath),
    fs.lstat(metadataPath, { bigint: true }),
    fs.realpath(metadataPath),
  ]);
  if (
    !snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() || snapshotRealPath !== snapshotPath ||
    !runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeRealPath !== runtimePath ||
    !metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataRealPath !== metadataPath
  ) {
    throw new Error("snapshot source path is not exact owner-controlled regular state");
  }
  return {
    snapshot_path: snapshotPath,
    runtime_path: runtimePath,
    metadata_path: metadataPath,
    snapshot_device: snapshotStat.dev,
    snapshot_inode: snapshotStat.ino,
    runtime_device: runtimeStat.dev,
    runtime_inode: runtimeStat.ino,
    metadata_device: metadataStat.dev,
    metadata_inode: metadataStat.ino,
  };
}

function sameSnapshotSourcePathState(
  left: ExactSnapshotSourcePathState,
  right: ExactSnapshotSourcePathState,
): boolean {
  return left.snapshot_path === right.snapshot_path &&
    left.runtime_path === right.runtime_path &&
    left.metadata_path === right.metadata_path &&
    left.snapshot_device === right.snapshot_device &&
    left.snapshot_inode === right.snapshot_inode &&
    left.runtime_device === right.runtime_device &&
    left.runtime_inode === right.runtime_inode &&
    left.metadata_device === right.metadata_device &&
    left.metadata_inode === right.metadata_inode;
}

async function validateExactRetainedSnapshotSource(input: {
  identity: SkillSnapshotIdentity;
  skill_name: string;
  snapshotsRoot: string;
}): Promise<{
  metadata: SkillSnapshotMetadata;
  pathState: ExactSnapshotSourcePathState;
}> {
  const before = await exactSnapshotSourcePathState(input.identity, input.snapshotsRoot);
  const metadata = await validateRecordedSkillSnapshot(input.identity, {
    snapshotsRoot: input.snapshotsRoot,
  });
  const captured = await captureSkillRuntimeBundle(before.runtime_path);
  const {
    source_root_path,
    resolved_skill_path,
    contents,
    ...runtimeClosure
  } = captured;
  if (
    source_root_path !== before.runtime_path ||
    resolved_skill_path !== path.join(before.runtime_path, "SKILL.md") ||
    declaredSkillName(contents.get("SKILL.md")!) !== input.skill_name ||
    captured.bundle_sha256 !== metadata.bundle_sha256 ||
    JSON.stringify(runtimeClosure) !== JSON.stringify(metadata.runtime_closure)
  ) {
    throw new Error("snapshot source bytes, canonical skill name, or runtime closure do not match");
  }
  const after = await exactSnapshotSourcePathState(input.identity, input.snapshotsRoot);
  if (!sameSnapshotSourcePathState(before, after)) {
    throw new Error("snapshot source path identity changed during validation");
  }
  return { metadata, pathState: after };
}

export async function resolveRetainedSkillSnapshotSourceRequest(
  request: RetainedSkillSnapshotSourceResolutionRequest,
  options: { snapshotsRoot?: string } = {},
) {
  const snapshotsRoot = path.resolve(options.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const identity: SkillSnapshotIdentity = {
    schema_version: 1,
    snapshot_id: request.snapshot_binding.snapshot_id,
    snapshot_path: path.join(snapshotsRoot, "bundles", request.snapshot_binding.snapshot_id),
    metadata_sha256: request.snapshot_binding.metadata_sha256,
  };
  try {
    let validated;
    try {
      validated = await validateExactRetainedSnapshotSource({
        identity,
        skill_name: request.skill_name,
        snapshotsRoot,
      });
    } catch (error) {
      throw new RetainedSnapshotSourceResolutionError(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "skill_snapshot_not_found"
          : "skill_snapshot_altered",
        "retained skill snapshot source is missing, altered, incomplete, symlinked, or mismatched",
        { cause: error },
      );
    }
    let reference;
    try {
      reference = await validateSkillSnapshotReference({
        snapshot_id: request.snapshot_binding.snapshot_id,
        reference_id: request.snapshot_binding.reference_id,
        project_id: request.snapshot_binding.project_id,
        publication_id: request.snapshot_binding.publication_id,
        snapshotsRoot,
      });
    } catch (error) {
      throw new RetainedSnapshotSourceResolutionError(
        "skill_snapshot_reference_mismatch",
        "retained snapshot reference does not exactly match owner records",
        { cause: error },
      );
    }
    const publication = await getSkillSnapshotPublicationRecord({
      project_id: reference.project_reference.project_id,
      publication_id: reference.project_reference.publication_id,
      publication_request_sha256: reference.publication_request_sha256,
      snapshotsRoot,
    });
    const publicationBinding = publication?.status === "committed"
      ? publication.committed_bindings?.find((binding) =>
          binding.skill_name === request.skill_name &&
          binding.snapshot_identity.snapshot_id === identity.snapshot_id &&
          binding.snapshot_identity.metadata_sha256 === identity.metadata_sha256 &&
          binding.publication_receipt.reference_id === reference.reference_id &&
          binding.publication_receipt.receipt_sha256 === request.snapshot_binding.publication_receipt_sha256)
      : undefined;
    if (
      !publicationBinding ||
      reference.skill_name !== request.skill_name ||
      reference.bundle_sha256 !== validated.metadata.bundle_sha256
    ) {
      throw new RetainedSnapshotSourceResolutionError(
        "skill_snapshot_reference_mismatch",
        "retained snapshot identity is not part of the exact committed publication",
      );
    }
    const finalValidation = await validateExactRetainedSnapshotSource({
      identity,
      skill_name: request.skill_name,
      snapshotsRoot,
    });
    if (
      !sameSnapshotSourcePathState(validated.pathState, finalValidation.pathState) ||
      JSON.stringify(validated.metadata) !== JSON.stringify(finalValidation.metadata)
    ) {
      throw new RetainedSnapshotSourceResolutionError(
        "skill_snapshot_altered",
        "retained snapshot source changed during resolution",
      );
    }
    return {
      contract_name: "subagent007.skill_snapshot_source_resolution" as const,
      contract_version: 1 as const,
      kind: "skill_snapshot_source_resolved" as const,
      success: true as const,
      resolved: true as const,
      child_started: false as const,
      model_invoked: false as const,
      request_binding: retainedSnapshotSourceResolutionRequestBinding(request),
      skill_name: request.skill_name,
      source_identity: sourceIdentity({
        skill_name: request.skill_name,
        source_root_path: finalValidation.pathState.runtime_path,
        resolved_skill_path: path.join(finalValidation.pathState.runtime_path, "SKILL.md"),
        bundle_sha256: finalValidation.metadata.bundle_sha256,
      }),
      snapshot_identity: finalValidation.metadata.snapshot_identity,
      bundle_sha256: finalValidation.metadata.bundle_sha256,
      runtime_closure: finalValidation.metadata.runtime_closure,
      retained_reference: {
        reference_id: reference.reference_id,
        project_id: reference.project_reference.project_id,
        publication_id: reference.project_reference.publication_id,
        lifecycle: reference.project_reference.lifecycle,
      },
    };
  } catch (error) {
    if (error instanceof RetainedSnapshotSourceResolutionError) {
      return retainedSnapshotSourceResolutionRejected(request, error.reasonCode, error.message);
    }
    return retainedSnapshotSourceResolutionRejected(
      request,
      "snapshot_source_resolution_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function resolveSkillSnapshotLaunchBinding(input: {
  skill_name: string;
  binding: SkillSnapshotLaunchBinding;
  snapshotsRoot?: string;
}): Promise<{ metadata: SkillSnapshotMetadata; receipt: SkillSnapshotActivationReceipt }> {
  if (!validatedSkillSnapshotLaunchBinding(input.binding)) {
    throw new SkillSnapshotLaunchError(
      "skill_snapshot_reference_mismatch",
      "skill snapshot launch binding has an invalid exact owner shape",
    );
  }
  const root = path.resolve(input.snapshotsRoot ?? defaultSkillSnapshotsRoot());
  const identity: SkillSnapshotIdentity = {
    schema_version: 1,
    snapshot_id: input.binding.snapshot_id,
    snapshot_path: path.join(root, "bundles", input.binding.snapshot_id),
    metadata_sha256: input.binding.metadata_sha256,
  };
  let metadata: SkillSnapshotMetadata;
  try {
    metadata = await validateRecordedSkillSnapshot(identity, { snapshotsRoot: root });
  } catch (error) {
    throw new SkillSnapshotLaunchError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "skill_snapshot_not_found" : "skill_snapshot_altered",
      "recorded skill snapshot is missing, altered, incomplete, or mismatched",
      { cause: error },
    );
  }
  let reference;
  try {
    reference = await validateSkillSnapshotReference({
      snapshot_id: input.binding.snapshot_id,
      reference_id: input.binding.reference_id,
      project_id: input.binding.project_id,
      publication_id: input.binding.publication_id,
      snapshotsRoot: root,
    });
  } catch (error) {
    throw new SkillSnapshotLaunchError(
      "skill_snapshot_reference_mismatch",
      "skill snapshot reference does not exactly match owner records",
      { cause: error },
    );
  }
  if (reference.project_reference.lifecycle !== "active") {
    throw new SkillSnapshotLaunchError("skill_snapshot_reference_closed", "skill snapshot reference is closed");
  }
  if (reference.skill_name !== input.skill_name || reference.bundle_sha256 !== metadata.bundle_sha256) {
    throw new SkillSnapshotLaunchError(
      "skill_snapshot_reference_mismatch",
      "skill snapshot reference does not match the requested canonical skill name and bundle",
    );
  }
  const expectedReceipt = skillSnapshotPublicationReceiptSha256({
    snapshot_identity: metadata.snapshot_identity,
    project_reference: reference.project_reference,
    reference_id: reference.reference_id,
  });
  if (expectedReceipt !== input.binding.publication_receipt_sha256) {
    throw new SkillSnapshotLaunchError(
      "skill_snapshot_reference_mismatch",
      "skill snapshot publication receipt does not match owner records",
    );
  }
  const runtimeClosureSha256 = createHash("sha256")
    .update("subagent007.skill_runtime_closure.v1\n")
    .update(JSON.stringify(metadata.runtime_closure))
    .digest("hex");
  return {
    metadata,
    receipt: {
      schema_version: 1,
      confirmed_before_prompt: true,
      skill_name: input.skill_name,
      snapshot_id: identity.snapshot_id,
      metadata_sha256: identity.metadata_sha256,
      bundle_sha256: metadata.bundle_sha256,
      publication_receipt_sha256: input.binding.publication_receipt_sha256,
      reference_id: reference.reference_id,
      project_id: reference.project_reference.project_id,
      publication_id: reference.project_reference.publication_id,
      resolved_skill_path: path.join(identity.snapshot_path, "runtime", "SKILL.md"),
      runtime_closure_sha256: runtimeClosureSha256,
    },
  };
}

const SKILL_SNAPSHOT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SKILL_SNAPSHOT_PUBLICATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function snapshotExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function validatedSkillSnapshotLaunchBinding(value: unknown): SkillSnapshotLaunchBinding | undefined {
  const binding = snapshotRecord(value);
  if (!binding || !snapshotExactKeys(binding, [
    "contract_version", "snapshot_id", "metadata_sha256", "publication_receipt_sha256",
    "reference_id", "project_id", "publication_id",
  ])) return undefined;
  if (
    binding.contract_version !== 1 ||
    typeof binding.snapshot_id !== "string" || !SKILL_SNAPSHOT_SHA256_PATTERN.test(binding.snapshot_id) ||
    typeof binding.metadata_sha256 !== "string" || !SKILL_SNAPSHOT_SHA256_PATTERN.test(binding.metadata_sha256) ||
    typeof binding.publication_receipt_sha256 !== "string" || !SKILL_SNAPSHOT_SHA256_PATTERN.test(binding.publication_receipt_sha256) ||
    typeof binding.reference_id !== "string" || !SKILL_SNAPSHOT_SHA256_PATTERN.test(binding.reference_id) ||
    typeof binding.project_id !== "string" || binding.project_id.trim() === "" ||
    typeof binding.publication_id !== "string" || binding.publication_id.length > 200 ||
    !SKILL_SNAPSHOT_PUBLICATION_ID_PATTERN.test(binding.publication_id)
  ) return undefined;
  return binding as unknown as SkillSnapshotLaunchBinding;
}

export function validatedSkillSnapshotActivationReceipt(input: {
  value: unknown;
  binding: SkillSnapshotLaunchBinding;
}): SkillSnapshotActivationReceipt | undefined {
  const binding = validatedSkillSnapshotLaunchBinding(input.binding);
  const receipt = snapshotRecord(input.value);
  if (!binding || !receipt || !snapshotExactKeys(receipt, [
    "schema_version", "confirmed_before_prompt", "skill_name", "snapshot_id", "metadata_sha256",
    "bundle_sha256", "publication_receipt_sha256", "reference_id", "project_id", "publication_id",
    "resolved_skill_path", "runtime_closure_sha256",
  ])) return undefined;
  if (
    receipt.schema_version !== 1 || receipt.confirmed_before_prompt !== true ||
    typeof receipt.skill_name !== "string" || receipt.skill_name.trim() === "" ||
    receipt.snapshot_id !== binding.snapshot_id || receipt.metadata_sha256 !== binding.metadata_sha256 ||
    receipt.publication_receipt_sha256 !== binding.publication_receipt_sha256 ||
    receipt.reference_id !== binding.reference_id || receipt.project_id !== binding.project_id ||
    receipt.publication_id !== binding.publication_id ||
    typeof receipt.bundle_sha256 !== "string" || !SKILL_SNAPSHOT_SHA256_PATTERN.test(receipt.bundle_sha256) ||
    typeof receipt.runtime_closure_sha256 !== "string" || !SKILL_SNAPSHOT_SHA256_PATTERN.test(receipt.runtime_closure_sha256) ||
    typeof receipt.resolved_skill_path !== "string" || !path.isAbsolute(receipt.resolved_skill_path)
  ) return undefined;
  const runtimeRoot = path.dirname(receipt.resolved_skill_path);
  const snapshotRoot = path.dirname(runtimeRoot);
  if (
    path.basename(receipt.resolved_skill_path) !== "SKILL.md" ||
    path.basename(runtimeRoot) !== "runtime" ||
    path.basename(snapshotRoot) !== binding.snapshot_id
  ) return undefined;
  return receipt as unknown as SkillSnapshotActivationReceipt;
}

export async function planSkillSnapshotDeletionRequest(
  request: { contract_version: 1; snapshot_id: string },
  options: { snapshotsRoot?: string } = {},
) {
  try {
    const impact_report = await planSkillSnapshotDeletion(request.snapshot_id, options);
    return {
      contract_name: "subagent007.skill_snapshot_deletion",
      contract_version: 1 as const,
      kind: "skill_snapshot_deletion_planned" as const,
      success: true as const,
      deleted: false as const,
      impact_report,
    };
  } catch (error) {
    return {
      contract_name: "subagent007.skill_snapshot_deletion",
      contract_version: 1 as const,
      kind: "skill_snapshot_deletion_rejected" as const,
      success: false as const,
      deleted: false as const,
      reason_code: "skill_snapshot_not_found",
      message: (error as Error).message,
    };
  }
}

export async function closeSkillSnapshotReferencesRequest(
  request: {
    contract_version: 1;
    project_id: string;
    publication_id: string;
    snapshot_ids: string[];
  },
  options: { snapshotsRoot?: string } = {},
) {
  const requestBindingBase = {
    contract_version: request.contract_version,
    project_id: request.project_id,
    publication_id: request.publication_id,
    snapshot_ids: request.snapshot_ids,
  };
  const request_binding = {
    count: request.snapshot_ids.length,
    canonical_request_sha256: createHash("sha256")
      .update("subagent007.skill_snapshot_reference_lifecycle.request.v1\n")
      .update(JSON.stringify(requestBindingBase))
      .digest("hex"),
  };
  try {
    const references = await closeSkillSnapshotReferences({
      project_id: request.project_id,
      publication_id: request.publication_id,
      snapshot_ids: request.snapshot_ids,
      snapshotsRoot: options.snapshotsRoot,
    });
    return {
      contract_name: "subagent007.skill_snapshot_reference_lifecycle",
      contract_version: 1 as const,
      kind: "skill_snapshot_references_closed" as const,
      success: true as const,
      closed: true as const,
      project_id: request.project_id,
      publication_id: request.publication_id,
      snapshot_ids: request.snapshot_ids,
      references,
      request_binding,
      closure_receipt: {
        schema_version: 1 as const,
        lifecycle: "closed" as const,
        receipt_sha256: createHash("sha256")
          .update("subagent007.skill_snapshot_reference_lifecycle.receipt.v1\n")
          .update(JSON.stringify({
            request_binding,
            reference_ids: references.map((reference) => reference.reference_id),
            lifecycle: "closed",
          }))
          .digest("hex"),
      },
    };
  } catch (error) {
    return {
      contract_name: "subagent007.skill_snapshot_reference_lifecycle",
      contract_version: 1 as const,
      kind: "skill_snapshot_reference_closure_rejected" as const,
      success: false as const,
      closed: false as const,
      reason_code: "skill_snapshot_reference_mismatch",
      message: (error as Error).message,
      request_binding,
    };
  }
}

export async function deleteSkillSnapshotRequest(
  request: { contract_version: 1; snapshot_id: string; confirm_impact_sha256: string },
  options: { snapshotsRoot?: string } = {},
) {
  try {
    const outcome = await deleteSkillSnapshot({
      snapshotId: request.snapshot_id,
      confirmImpactSha256: request.confirm_impact_sha256,
      snapshotsRoot: options.snapshotsRoot,
    });
    return outcome.deleted
      ? {
          contract_name: "subagent007.skill_snapshot_deletion",
          contract_version: 1 as const,
          kind: "skill_snapshot_deleted" as const,
          success: true as const,
          deleted: true as const,
          impact_report: outcome.impact_report,
        }
      : {
          contract_name: "subagent007.skill_snapshot_deletion",
          contract_version: 1 as const,
          kind: "skill_snapshot_deletion_rejected" as const,
          success: false as const,
          deleted: false as const,
          reason_code: "skill_snapshot_deletion_impact_mismatch",
          message: "confirm_impact_sha256 does not match the current complete project impact",
          impact_report: outcome.impact_report,
        };
  } catch (error) {
    return {
      contract_name: "subagent007.skill_snapshot_deletion",
      contract_version: 1 as const,
      kind: "skill_snapshot_deletion_rejected" as const,
      success: false as const,
      deleted: false as const,
      reason_code: "skill_snapshot_not_found",
      message: (error as Error).message,
    };
  }
}

export async function resolveSkillRuntimeBundlesRequest(
  request: SkillRuntimeBundleResolutionRequest,
  options: { agentDir?: string; lookupPaths?: string[] } = {},
): Promise<SkillRuntimeBundleResolutionResult> {
  let cwd: string;
  try {
    cwd = await validateCwd(request.cwd);
  } catch (error) {
    if (error instanceof ValidationError && (
      error.reasonCode === "cwd_not_absolute" || error.reasonCode === "cwd_inaccessible" ||
      error.reasonCode === "cwd_not_directory"
    )) return rejected(request, error.reasonCode, error.message);
    throw error;
  }
  const catalog = loadSkillCatalog({
    cwd,
    agentDir: options.agentDir ?? resolvePiAgentDir(),
    ...(options.lookupPaths ? { lookupPaths: options.lookupPaths } : {}),
  });
  const bindings: ResolvedRuntimeBundleBinding[] = [];
  for (const [index, skill_name] of request.skill_names.entries()) {
    const failed_skill = { index, skill_name };
    let skill;
    try {
      skill = resolveRequestedSkillFromCatalog(skill_name, catalog);
    } catch (error) {
      if (error instanceof SkillResolutionError) {
        return rejected(request, error.resolutionCode, error.message, failed_skill);
      }
      throw error;
    }
    try {
      const captured = await captureSkillRuntimeBundle(path.dirname(skill.filePath));
      const { source_root_path, resolved_skill_path, contents: _contents, ...runtime_closure } = captured;
      bindings.push({
        skill_name,
        source_identity: sourceIdentity({
          skill_name,
          resolved_skill_path,
          source_root_path,
          bundle_sha256: runtime_closure.bundle_sha256,
        }),
        bundle_sha256: runtime_closure.bundle_sha256,
        runtime_closure,
      });
    } catch (error) {
      if (error instanceof RuntimeBundleValidationError) {
        return rejected(request, error.failureCode, error.message, failed_skill);
      }
      throw error;
    }
  }
  return {
    contract_name: SKILL_RUNTIME_BUNDLE_RESOLUTION_CONTRACT_NAME,
    contract_version: 1,
    kind: "skill_runtime_bundles_resolved",
    success: true,
    resolved: true,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    bindings,
  };
}
