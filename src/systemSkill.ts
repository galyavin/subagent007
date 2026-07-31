import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { resolveRequestedSkill } from "./skillResources.js";
import type { SystemSkillActivationReceipt } from "./types.js";

export const SYSTEM_SKILL_PLACEMENT = "after_all_other_before_agent_start_handlers" as const;
export const SYSTEM_SKILL_OBSERVATION_SCOPE =
  "pi_system_prompt_after_before_agent_start_not_provider_payload_or_model_obedience" as const;

export interface ResolvedSystemSkillSource {
  name: string;
  path: string;
  content: string;
  contentSha256: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, skillName: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`system skill ${JSON.stringify(skillName)} is not valid UTF-8`);
  }
}

export async function resolveSystemSkillSource(input: {
  systemSkillName: string;
  cwd: string;
  agentDir: string;
  expectedPath?: string;
}): Promise<ResolvedSystemSkillSource> {
  const resolved = resolveRequestedSkill(input.systemSkillName, {
    cwd: input.cwd,
    agentDir: input.agentDir,
  });
  const resolvedPath = path.resolve(resolved.filePath);
  if (input.expectedPath !== undefined && path.resolve(input.expectedPath) !== resolvedPath) {
    throw new Error(
      `system skill ${JSON.stringify(input.systemSkillName)} canonical source changed before child activation`,
    );
  }
  const bytes = await fs.readFile(resolvedPath);
  const content = decodeUtf8(bytes, input.systemSkillName);
  if (content.length === 0) {
    throw new Error(`system skill ${JSON.stringify(input.systemSkillName)} is empty`);
  }
  return {
    name: input.systemSkillName,
    path: resolvedPath,
    content,
    contentSha256: sha256(bytes),
  };
}

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export function systemSkillPromptBlock(source: ResolvedSystemSkillSource): string {
  return [
    "<subagent007-system-skill>",
    `Name: ${source.name}`,
    `Canonical source: ${source.path}`,
    "",
    source.content,
    "</subagent007-system-skill>",
  ].join("\n");
}

export function appendSystemSkillToPrompt(input: {
  currentSystemPrompt: string;
  source: ResolvedSystemSkillSource;
}): { systemPrompt: string; receipt: SystemSkillActivationReceipt } {
  // The governing catalogue entry is filtered from Pi discovery. If an ambient
  // prompt transformer nevertheless copied the exact body, remove only those
  // duplicate body bytes before adding the canonical final section.
  const withoutDuplicateBodies = input.currentSystemPrompt
    .split(input.source.content)
    .join("")
    .trimEnd();
  const block = systemSkillPromptBlock(input.source);
  const systemPrompt = `${withoutDuplicateBodies}\n\n${block}`;
  const occurrenceCount = countOccurrences(systemPrompt, input.source.content);
  if (occurrenceCount !== 1 || !systemPrompt.endsWith(block)) {
    throw new Error("system skill could not be placed exactly once at the end of Pi's system prompt");
  }
  return {
    systemPrompt,
    receipt: {
      schema_version: 1,
      confirmed_before_prompt: true,
      system_skill_name: input.source.name,
      resolved_skill_path: input.source.path,
      content_sha256: input.source.contentSha256,
      final_system_prompt_sha256: sha256(systemPrompt),
      system_skill_content_occurrences: 1,
      final_system_prompt_ends_with_system_skill: true,
      placement: SYSTEM_SKILL_PLACEMENT,
      observation_scope: SYSTEM_SKILL_OBSERVATION_SCOPE,
    },
  };
}

export function createSystemSkillExtension(input: {
  source: ResolvedSystemSkillSource;
  onActivation: (receipt: SystemSkillActivationReceipt) => void;
}): InlineExtension {
  return {
    name: "subagent007-system-skill-finalizer",
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        const composed = appendSystemSkillToPrompt({
          currentSystemPrompt: event.systemPrompt,
          source: input.source,
        });
        input.onActivation(composed.receipt);
        return { systemPrompt: composed.systemPrompt };
      });
    },
  };
}

export function validatedSystemSkillActivationReceipt(input: {
  value: unknown;
  expectedName: string;
  expectedPath: string;
}): SystemSkillActivationReceipt | undefined {
  if (typeof input.value !== "object" || input.value === null || Array.isArray(input.value)) return undefined;
  const receipt = input.value as Record<string, unknown>;
  const expectedKeys = [
    "schema_version",
    "confirmed_before_prompt",
    "system_skill_name",
    "resolved_skill_path",
    "content_sha256",
    "final_system_prompt_sha256",
    "system_skill_content_occurrences",
    "final_system_prompt_ends_with_system_skill",
    "placement",
    "observation_scope",
  ].sort();
  if (Object.keys(receipt).sort().join("\0") !== expectedKeys.join("\0")) return undefined;
  if (
    receipt.schema_version !== 1 ||
    receipt.confirmed_before_prompt !== true ||
    receipt.system_skill_name !== input.expectedName ||
    receipt.resolved_skill_path !== path.resolve(input.expectedPath) ||
    typeof receipt.content_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.content_sha256) ||
    typeof receipt.final_system_prompt_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.final_system_prompt_sha256) ||
    receipt.system_skill_content_occurrences !== 1 ||
    receipt.final_system_prompt_ends_with_system_skill !== true ||
    receipt.placement !== SYSTEM_SKILL_PLACEMENT ||
    receipt.observation_scope !== SYSTEM_SKILL_OBSERVATION_SCOPE
  ) return undefined;
  return receipt as unknown as SystemSkillActivationReceipt;
}
