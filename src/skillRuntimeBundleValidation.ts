import { createHash } from "node:crypto";
import path from "node:path";
import {
  captureSkillRuntimeBundle,
  RuntimeBundleValidationError,
  type SkillRuntimeBundleEvidence,
} from "./skillRuntimeBundle.js";

export const SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME =
  "subagent007.skill_runtime_bundle_validation" as const;
const REQUEST_DOMAIN = `${SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME}.request.v1\n`;
const SOURCE_DOMAIN = "subagent007.exact_skill_runtime_source.v1\n";
const CANONICAL_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface SkillRuntimeBundleValidationRequest {
  contract_version: 1;
  bundle_root: string;
  expected_skill_name: string;
}

export function declaredSkillName(skillBytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(skillBytes);
  if (!text.startsWith("---\n")) throw new Error("SKILL.md requires YAML frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is unterminated");
  const matches = text.slice(4, end).split("\n").filter((line) => /^name\s*:/.test(line));
  if (matches.length !== 1) throw new Error("SKILL.md must declare exactly one top-level name");
  const raw = matches[0]!.replace(/^name\s*:\s*/, "").trim();
  let name = raw;
  if (raw.startsWith('"') && raw.endsWith('"')) name = JSON.parse(raw) as string;
  else if (raw.startsWith("'") && raw.endsWith("'")) name = raw.slice(1, -1).replace(/''/g, "'");
  if (!CANONICAL_SKILL_NAME.test(name)) throw new Error("SKILL.md name is not canonical");
  return name;
}

function requestBinding(request: SkillRuntimeBundleValidationRequest) {
  return {
    bundle_root: request.bundle_root,
    expected_skill_name: request.expected_skill_name,
    canonical_request_sha256: createHash("sha256")
      .update(REQUEST_DOMAIN)
      .update(JSON.stringify(request))
      .digest("hex"),
  };
}

export async function validateSkillRuntimeBundleRequest(request: SkillRuntimeBundleValidationRequest) {
  const binding = requestBinding(request);
  const reject = (reason_code: string, message: string) => ({
    contract_name: SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME,
    contract_version: 1 as const,
    kind: "skill_runtime_bundle_validation_rejected" as const,
    success: false as const,
    validated: false as const,
    child_started: false as const,
    model_invoked: false as const,
    request_binding: binding,
    reason_code,
    message,
  });
  if (!path.isAbsolute(request.bundle_root) || path.resolve(request.bundle_root) !== request.bundle_root) {
    return reject("bundle_root_not_canonical_absolute", "bundle_root must be a canonical absolute path");
  }
  if (!CANONICAL_SKILL_NAME.test(request.expected_skill_name)) {
    return reject("invalid_expected_skill_name", "expected_skill_name must be canonical lowercase ASCII kebab-case");
  }
  try {
    const captured = await captureSkillRuntimeBundle(request.bundle_root);
    const actualName = declaredSkillName(captured.contents.get("SKILL.md")!);
    if (actualName !== request.expected_skill_name) {
      return reject("skill_runtime_bundle_name_mismatch", "SKILL.md name does not match expected_skill_name");
    }
    const { source_root_path: _root, resolved_skill_path: _path, contents: _contents, ...runtime_closure } = captured;
    const source_identity = {
      schema_version: 1 as const,
      source_id: createHash("sha256").update(SOURCE_DOMAIN).update(JSON.stringify({
        expected_skill_name: request.expected_skill_name,
        bundle_root: request.bundle_root,
        bundle_sha256: captured.bundle_sha256,
      })).digest("hex"),
      bundle_root: request.bundle_root,
      resolved_skill_path: captured.resolved_skill_path,
    };
    return {
      contract_name: SKILL_RUNTIME_BUNDLE_VALIDATION_CONTRACT_NAME,
      contract_version: 1 as const,
      kind: "skill_runtime_bundle_validated" as const,
      success: true as const,
      validated: true as const,
      child_started: false as const,
      model_invoked: false as const,
      request_binding: binding,
      skill_name: actualName,
      source_identity,
      bundle_sha256: captured.bundle_sha256,
      runtime_closure: runtime_closure as SkillRuntimeBundleEvidence,
    };
  } catch (error) {
    return reject(
      error instanceof RuntimeBundleValidationError ? error.failureCode : "skill_runtime_bundle_metadata_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
}
