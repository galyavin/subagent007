export function composePrompt({
  prompt,
  skill,
}: {
  prompt: string;
  skill?: string;
}): string {
  if (skill) {
    return [`/skill:${skill}`, "", "<prompt>", prompt, "</prompt>"].join("\n");
  }

  return prompt;
}
