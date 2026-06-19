const REQUIRED_WEB_TOOLS = ["web_search", "web_read"] as const;

export interface SessionToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

export function activateAllRegisteredTools(session: SessionToolRegistry): string[] {
  const allToolNames = session.getAllTools().map((tool) => tool.name);
  session.setActiveToolsByName(allToolNames);
  const activeToolNames = session.getActiveToolNames();
  const activeToolNameSet = new Set(activeToolNames);
  const missingWebTools = REQUIRED_WEB_TOOLS.filter((name) => !activeToolNameSet.has(name));
  if (missingWebTools.length > 0) {
    throw new Error(
      `required Pi web search tools unavailable: ${missingWebTools.join(", ")}; install/configure the Pi web search extension before running Subagent007`,
    );
  }
  return activeToolNames;
}
