import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePiAgentDir } from "./piAgentDir.js";
import {
  loadSkillCatalog,
  resolveRequestedSkillFromCatalog,
  SkillResolutionError,
} from "./skillResources.js";
import type {
  ActivationSkillBinding,
  SkillBindingVerificationEntry,
  SkillBindingVerificationCwdReasonCode,
  SkillBindingVerificationCwdRejectedResult,
  SkillBindingVerificationReasonCode,
  SkillBindingVerificationRequest,
  SkillBindingVerificationRequestBinding,
  SkillBindingVerificationResult,
  SkillBindingVerificationSkillReasonCode,
  SkillBindingVerificationSkillRejectedResult,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateCwd } from "./validate.js";

export const SKILL_BINDING_VERIFICATION_CONTRACT_NAME =
  "subagent007.skill_binding_verification" as const;
export const SKILL_BINDING_VERIFICATION_CONTRACT_VERSION = 1 as const;
export const MAX_SKILL_BINDING_VERIFICATION_ENTRIES = 64;
export const LOWERCASE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_DIGEST_DOMAIN = "subagent007.skill_binding_verification.request.v1\n";

type ReadFile = (filePath: string) => Promise<Buffer>;

export class SkillBindingVerificationError extends Error {
  constructor(
    public readonly failureCode: Extract<
      SkillBindingVerificationReasonCode,
      "skill_unreadable" | "skill_content_mismatch"
    >,
    public readonly skillName: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

export function canonicalSkillBindingVerificationRequestSha256(
  request: SkillBindingVerificationRequest,
): string {
  return createHash("sha256")
    .update(REQUEST_DIGEST_DOMAIN)
    .update(JSON.stringify({
      contract_version: request.contract_version,
      cwd: request.cwd,
      bindings: request.bindings,
    }))
    .digest("hex");
}

export async function verifySkillFileBinding(
  input: { skill_name: string; expected_skill_sha256?: string; skillFilePath: string },
  readFile: ReadFile = fs.readFile,
): Promise<ActivationSkillBinding> {
  const resolvedPath = path.resolve(input.skillFilePath);
  let content: Buffer;
  try {
    content = await readFile(resolvedPath);
  } catch (error) {
    throw new SkillBindingVerificationError(
      "skill_unreadable",
      input.skill_name,
      "Resolved skill content could not be read.",
      { cause: error },
    );
  }
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  if (input.expected_skill_sha256 && contentSha256 !== input.expected_skill_sha256) {
    throw new SkillBindingVerificationError(
      "skill_content_mismatch",
      input.skill_name,
      "Skill content does not match the expected digest.",
    );
  }
  return {
    name: input.skill_name,
    path: resolvedPath,
    content_sha256: contentSha256,
    expected_content_sha256: input.expected_skill_sha256 ?? null,
  };
}

function requestBinding(request: SkillBindingVerificationRequest): SkillBindingVerificationRequestBinding {
  return {
    cwd: request.cwd,
    count: request.bindings.length,
    canonical_request_sha256: canonicalSkillBindingVerificationRequestSha256(request),
  };
}

function cwdRejectedResult(
  request: SkillBindingVerificationRequest,
  reasonCode: SkillBindingVerificationCwdReasonCode,
  message: string,
): SkillBindingVerificationCwdRejectedResult {
  return {
    contract_name: SKILL_BINDING_VERIFICATION_CONTRACT_NAME,
    contract_version: SKILL_BINDING_VERIFICATION_CONTRACT_VERSION,
    kind: "skill_binding_verification_rejected",
    success: false,
    verified: false,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    reason_code: reasonCode,
    message,
  };
}

function skillRejectedResult(
  request: SkillBindingVerificationRequest,
  reasonCode: SkillBindingVerificationSkillReasonCode,
  message: string,
  failedBinding: SkillBindingVerificationEntry & { index: number },
): SkillBindingVerificationSkillRejectedResult {
  return {
    contract_name: SKILL_BINDING_VERIFICATION_CONTRACT_NAME,
    contract_version: SKILL_BINDING_VERIFICATION_CONTRACT_VERSION,
    kind: "skill_binding_verification_rejected",
    success: false,
    verified: false,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    reason_code: reasonCode,
    failed_binding: failedBinding,
    message,
  };
}

function cwdReasonCode(error: ValidationError): Extract<
  SkillBindingVerificationReasonCode,
  "cwd_not_absolute" | "cwd_inaccessible" | "cwd_not_directory"
> | undefined {
  return error.reasonCode === "cwd_not_absolute" ||
    error.reasonCode === "cwd_inaccessible" ||
    error.reasonCode === "cwd_not_directory"
    ? error.reasonCode
    : undefined;
}

export async function verifySkillBindingsRequest(
  request: SkillBindingVerificationRequest,
  options: {
    agentDir?: string;
    lookupPaths?: string[];
    readFile?: ReadFile;
  } = {},
): Promise<SkillBindingVerificationResult> {
  let cwd: string;
  try {
    cwd = await validateCwd(request.cwd);
  } catch (error) {
    if (error instanceof ValidationError) {
      const reasonCode = cwdReasonCode(error);
      if (reasonCode) {
        return cwdRejectedResult(request, reasonCode, error.message);
      }
    }
    throw error;
  }

  const catalog = loadSkillCatalog({
    cwd,
    agentDir: options.agentDir ?? resolvePiAgentDir(),
    ...(options.lookupPaths ? { lookupPaths: options.lookupPaths } : {}),
  });
  const verifiedBindings = [];
  for (const [index, binding] of request.bindings.entries()) {
    const failedBinding = { index, ...binding };
    let skill;
    try {
      skill = resolveRequestedSkillFromCatalog(binding.skill_name, catalog);
    } catch (error) {
      if (error instanceof SkillResolutionError) {
        const message = error.resolutionCode === "skill_not_found"
          ? "Skill name does not resolve to a configured skill."
          : "Skill name is ambiguous across configured skill paths.";
        return skillRejectedResult(request, error.resolutionCode, message, failedBinding);
      }
      throw error;
    }
    try {
      const resolved = await verifySkillFileBinding({
        ...binding,
        skillFilePath: skill.filePath,
      }, options.readFile);
      verifiedBindings.push({
        skill_name: binding.skill_name,
        expected_skill_sha256: binding.expected_skill_sha256,
        resolved_skill_path: resolved.path,
        resolved_skill_sha256: resolved.content_sha256,
      });
    } catch (error) {
      if (error instanceof SkillBindingVerificationError) {
        return skillRejectedResult(request, error.failureCode, error.message, failedBinding);
      }
      throw error;
    }
  }

  return {
    contract_name: SKILL_BINDING_VERIFICATION_CONTRACT_NAME,
    contract_version: SKILL_BINDING_VERIFICATION_CONTRACT_VERSION,
    kind: "skill_bindings_verified",
    success: true,
    verified: true,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    bindings: verifiedBindings,
  };
}
