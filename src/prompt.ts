import type { PromptProvenance, SessionPacketPolicy } from "./types.js";

export const PUBLIC_PROMPT_REDACTED_MARKER = "[prompt supplied; content redacted]";

export function composePrompt({
  prompt,
  skill,
}: {
  prompt: string;
  skill?: string;
}): string {
  if (skill) {
    // Pi recognizes the end of `/skill:name` only at the first literal space.
    // Keep the caller prompt as the command argument so Pi expands the selected
    // SKILL.md before the first model turn.
    return [`/skill:${skill} <prompt>`, prompt, "</prompt>"].join("\n");
  }

  return prompt;
}

export function serverContractSkillMarker(skill: string): string {
  return `[server_contract] skill_name=${skill}`;
}

export function serverContractPacketMarker(packetPolicy: SessionPacketPolicy): string {
  return `[server_contract] packet_policy=${packetPolicy} contract_packet_v1 instruction applied`;
}

export function createPromptProvenance({
  publicPrompt,
  childPrompt,
  skill,
  packetPolicy,
}: {
  publicPrompt: string;
  childPrompt?: string;
  skill?: string;
  packetPolicy?: SessionPacketPolicy;
}): PromptProvenance {
  const promptForChild = childPrompt ?? publicPrompt;
  return {
    public_prompt: PUBLIC_PROMPT_REDACTED_MARKER,
    ...(skill ? { skill_name: skill, skill_marker: serverContractSkillMarker(skill) } : {}),
    ...(packetPolicy && packetPolicy !== "none"
      ? { packet_policy: packetPolicy, packet_marker: serverContractPacketMarker(packetPolicy) }
      : {}),
    composed_child_prompt: composePrompt({ prompt: promptForChild, skill }),
  };
}
