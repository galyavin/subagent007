import { createHash } from "node:crypto";
import { resolvePiAgentDir } from "./piAgentDir.js";
import { loadSkillCatalog, resolveRequestedSkillFromCatalog, SkillResolutionError } from "./skillResources.js";
import { SkillBindingVerificationError, verifySkillFileBinding } from "./skillVerification.js";
import type {
  SkillBindingResolutionCwdReasonCode,
  SkillBindingResolutionRequest,
  SkillBindingResolutionResult,
  SkillBindingResolutionSkillReasonCode,
} from "./types.js";
import { ValidationError } from "./types.js";
import { validateCwd } from "./validate.js";

export const SKILL_BINDING_RESOLUTION_CONTRACT_NAME = "subagent007.skill_binding_resolution" as const;
export const SKILL_BINDING_RESOLUTION_CONTRACT_VERSION = 1 as const;
export const MAX_SKILL_BINDING_RESOLUTION_ENTRIES = 64;
const REQUEST_DIGEST_DOMAIN = "subagent007.skill_binding_resolution.request.v1\n";

export function canonicalSkillBindingResolutionRequestSha256(request: SkillBindingResolutionRequest): string {
  return createHash("sha256").update(REQUEST_DIGEST_DOMAIN).update(JSON.stringify({
    contract_version: request.contract_version,
    cwd: request.cwd,
    skill_names: request.skill_names,
  })).digest("hex");
}

function requestBinding(request: SkillBindingResolutionRequest) {
  return {
    cwd: request.cwd,
    count: request.skill_names.length,
    canonical_request_sha256: canonicalSkillBindingResolutionRequestSha256(request),
  };
}

function rejected(
  request: SkillBindingResolutionRequest,
  reason_code: SkillBindingResolutionCwdReasonCode | SkillBindingResolutionSkillReasonCode,
  message: string,
  failed_skill?: { index: number; skill_name: string },
): SkillBindingResolutionResult {
  return {
    contract_name: SKILL_BINDING_RESOLUTION_CONTRACT_NAME,
    contract_version: SKILL_BINDING_RESOLUTION_CONTRACT_VERSION,
    kind: "skill_binding_resolution_rejected",
    success: false,
    resolved: false,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    reason_code,
    ...(failed_skill ? { failed_skill } : {}),
    message,
  } as SkillBindingResolutionResult;
}

export async function resolveSkillBindingsRequest(
  request: SkillBindingResolutionRequest,
  options: { agentDir?: string; lookupPaths?: string[]; readFile?: (filePath: string) => Promise<Buffer> } = {},
): Promise<SkillBindingResolutionResult> {
  let cwd: string;
  try {
    cwd = await validateCwd(request.cwd);
  } catch (error) {
    if (error instanceof ValidationError && (
      error.reasonCode === "cwd_not_absolute" || error.reasonCode === "cwd_inaccessible" || error.reasonCode === "cwd_not_directory"
    )) return rejected(request, error.reasonCode, error.message);
    throw error;
  }
  const catalog = loadSkillCatalog({
    cwd,
    agentDir: options.agentDir ?? resolvePiAgentDir(),
    ...(options.lookupPaths ? { lookupPaths: options.lookupPaths } : {}),
  });
  const bindings = [];
  for (const [index, skill_name] of request.skill_names.entries()) {
    let skill;
    try {
      skill = resolveRequestedSkillFromCatalog(skill_name, catalog);
    } catch (error) {
      if (error instanceof SkillResolutionError) {
        return rejected(request, error.resolutionCode, error.message, { index, skill_name });
      }
      throw error;
    }
    try {
      const resolved = await verifySkillFileBinding({ skill_name, skillFilePath: skill.filePath }, options.readFile);
      bindings.push({ skill_name, resolved_skill_path: resolved.path, resolved_skill_sha256: resolved.content_sha256 });
    } catch (error) {
      if (error instanceof SkillBindingVerificationError) {
        return rejected(request, "skill_unreadable", error.message, { index, skill_name });
      }
      throw error;
    }
  }
  return {
    contract_name: SKILL_BINDING_RESOLUTION_CONTRACT_NAME,
    contract_version: SKILL_BINDING_RESOLUTION_CONTRACT_VERSION,
    kind: "skill_bindings_resolved",
    success: true,
    resolved: true,
    child_started: false,
    model_invoked: false,
    request_binding: requestBinding(request),
    bindings,
  };
}
