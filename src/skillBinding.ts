import type { RunSubagentRequest } from "./types.js";
import { ValidationError } from "./types.js";

export const SKILL_NAME_INPUT_DESCRIPTION =
  "Preferred bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.";
export const LEGACY_SKILL_INPUT_DESCRIPTION =
  "Legacy alias for skill_name; prefer skill_name for new callers. Bare skill name only, such as pda-lite or plugin:skill-name; null means no skill.";

const SKILL_NAME_ERROR =
  "skill must be a bare skill name such as pda-lite or plugin:skill-name; pass pda-lite, not $pda-lite, /skill:pda-lite, a path, markdown link, or prose";
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?$/;
const PROMPT_SKILL_INVOCATION_PATTERNS = [
  /^\/skill:[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?:\b|\s|$)/,
  /^\$[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?:\b|\s|$)/,
  /^\[\$[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?\]\([^)]+\)/,
  /^(?:use|run|invoke)\s+\$[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?:\b|\s|$)/i,
];

export function validateSkillName(value: unknown, key = "skill"): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ValidationError(`${key} must be a string or null`, "invalid_skill");
  }
  if (!SKILL_NAME_PATTERN.test(value)) {
    throw new ValidationError(SKILL_NAME_ERROR, "invalid_skill");
  }
  return value;
}

function assertNoUnstructuredSkillInvocation(prompt: string, resolvedSkill: string | undefined): void {
  if (resolvedSkill) {
    return;
  }
  const firstLine = prompt.trimStart().split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  if (PROMPT_SKILL_INVOCATION_PATTERNS.some((pattern) => pattern.test(firstLine))) {
    throw new ValidationError(
      "Pass skill_name instead of putting skill invocation syntax in prompt.",
      "invalid_skill",
    );
  }
}

export function resolveSkillBinding(request: Pick<RunSubagentRequest, "skill" | "skill_name">, prompt: string): string | undefined {
  const legacySkill = validateSkillName(request.skill, "skill");
  const canonicalSkill = validateSkillName(request.skill_name, "skill_name");
  if (legacySkill && canonicalSkill && legacySkill !== canonicalSkill) {
    throw new ValidationError("skill and skill_name must match when both are provided", "invalid_skill");
  }
  const resolvedSkill = canonicalSkill ?? legacySkill;
  assertNoUnstructuredSkillInvocation(prompt, resolvedSkill);
  return resolvedSkill;
}

export function skillBindingForPublicMarker(request: Pick<RunSubagentRequest, "skill" | "skill_name">): string | undefined {
  return typeof request.skill_name === "string" && request.skill_name.trim() !== ""
    ? request.skill_name.trim()
    : typeof request.skill === "string" && request.skill.trim() !== ""
      ? request.skill.trim()
      : undefined;
}
