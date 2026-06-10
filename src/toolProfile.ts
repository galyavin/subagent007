import type { ToolProfile } from "./types.js";

const INSPECT_TOOLS = ["read", "grep", "find", "ls", "request_input"] as const;
const SHELL_TOOLS = [...INSPECT_TOOLS, "bash"] as const;
const WORKSPACE_WRITE_TOOLS = [...SHELL_TOOLS, "edit", "write"] as const;

export function toolsForProfile(profile: ToolProfile): string[] {
  switch (profile) {
    case "inspect":
      return [...INSPECT_TOOLS];
    case "shell":
      return [...SHELL_TOOLS];
    case "workspace_write":
      return [...WORKSPACE_WRITE_TOOLS];
  }
}
