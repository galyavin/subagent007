import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ActivationReceipt,
  ActivationSkillBinding,
  ActivationToolBinding,
  EffectProfile,
} from "./types.js";

const REQUIRED_WEB_TOOLS = ["web_search", "web_read"] as const;
export const WORKSPACE_READ_ONLY_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_read",
  "request_input",
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface SessionToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

export function activateAllRegisteredTools(session: SessionToolRegistry): void {
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
}

export function activateWorkspaceReadOnlyTools(session: SessionToolRegistry): void {
  const registered = new Set(session.getAllTools().map((tool) => tool.name));
  const unavailable = WORKSPACE_READ_ONLY_TOOL_NAMES.filter((name) => !registered.has(name));
  if (unavailable.length > 0) {
    throw new Error(`workspace_read_only tools unavailable: ${unavailable.join(", ")}`);
  }
  session.setActiveToolsByName([...WORKSPACE_READ_ONLY_TOOL_NAMES]);
  const active = session.getActiveToolNames();
  if (
    active.length !== WORKSPACE_READ_ONLY_TOOL_NAMES.length ||
    active.some((name, index) => name !== WORKSPACE_READ_ONLY_TOOL_NAMES[index])
  ) {
    throw new Error(
      `workspace_read_only activation mismatch: expected ${WORKSPACE_READ_ONLY_TOOL_NAMES.join(", ")}; got ${active.join(", ")}`,
    );
  }
}

async function implementationTreeFiles(
  root: string,
  relative = "",
): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const relativePath = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await implementationTreeFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function hashImplementationFiles(root: string, relativePaths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    hash.update(relativePath.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await fs.readFile(path.join(root, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function hashImplementationTree(root: string): Promise<string> {
  return hashImplementationFiles(root, await implementationTreeFiles(root));
}

export interface WorkspaceReadOnlyWebProvider {
  extensionPath: string;
  providerId: string;
  implementationSha256: string;
}

export async function resolveWorkspaceReadOnlyWebProvider(
  agentDir: string,
): Promise<WorkspaceReadOnlyWebProvider> {
  const packageRoot = path.join(agentDir, "npm", "node_modules", "pi-search-hub");
  const extensionPath = path.join(packageRoot, "extensions", "search-hub.ts");
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (manifest.name !== "pi-search-hub" || typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("workspace_read_only web provider identity is invalid");
  }
  const stat = await fs.stat(extensionPath);
  if (!stat.isFile()) {
    throw new Error(`workspace_read_only web provider is not a file: ${extensionPath}`);
  }
  return {
    extensionPath,
    providerId: `${manifest.name}@${manifest.version}`,
    implementationSha256: await hashImplementationTree(packageRoot),
  };
}

export async function requestInputImplementationSha256(childEntrypoint: string): Promise<string> {
  const releaseRoot = path.dirname(childEntrypoint);
  const entrypointName = path.basename(childEntrypoint);
  const implementationFiles = [entrypointName, "inputMailbox.js", "output.js", "types.js"];
  for (const relativePath of implementationFiles) {
    const stat = await fs.stat(path.join(releaseRoot, relativePath)).catch(() => undefined);
    if (!stat?.isFile()) {
      throw new Error(`request_input implementation file unavailable: ${path.join(releaseRoot, relativePath)}`);
    }
  }
  return hashImplementationFiles(releaseRoot, implementationFiles);
}

function canonicalToolsetDigest(input: {
  profile: EffectProfile;
  activeToolNames: readonly string[];
  bindings: readonly ActivationToolBinding[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    profile: input.profile,
    active_tool_names: input.activeToolNames,
    tool_bindings: input.bindings,
  })).digest("hex");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function validatedActivationReceipt(input: {
  value: unknown;
  effectProfile?: EffectProfile;
  skillBinding: ActivationSkillBinding | null;
  expectedSkillSha256?: string;
}): ActivationReceipt | undefined {
  const receipt = record(input.value);
  if (!receipt || !exactKeys(receipt, [
    "schema_version",
    "confirmed_before_prompt",
    "requested_effect_profile",
    "resolved_effect_profile",
    "active_tool_names",
    "tool_bindings",
    "toolset_sha256",
    "skill_binding",
  ])) {
    return undefined;
  }
  if (receipt.schema_version !== 1 || receipt.confirmed_before_prompt !== true) {
    return undefined;
  }
  const expectedProfile = input.effectProfile ?? null;
  if (
    receipt.requested_effect_profile !== expectedProfile ||
    receipt.resolved_effect_profile !== expectedProfile
  ) {
    return undefined;
  }
  const activeToolNames = receipt.active_tool_names;
  const rawBindings = receipt.tool_bindings;
  if (!Array.isArray(activeToolNames) || !Array.isArray(rawBindings)) {
    return undefined;
  }
  const expectedActive = input.effectProfile ? [...WORKSPACE_READ_ONLY_TOOL_NAMES] : [];
  if (
    activeToolNames.length !== expectedActive.length ||
    activeToolNames.some((name, index) => name !== expectedActive[index])
  ) {
    return undefined;
  }
  const toolBindings: ActivationToolBinding[] = [];
  for (const rawBinding of rawBindings) {
    const binding = record(rawBinding);
    if (!binding || !exactKeys(binding, ["tool_name", "provider_id", "implementation_sha256"])) {
      return undefined;
    }
    if (
      !["request_input", "web_read", "web_search"].includes(String(binding.tool_name)) ||
      typeof binding.provider_id !== "string" || binding.provider_id.trim() === "" ||
      typeof binding.implementation_sha256 !== "string" || !SHA256_PATTERN.test(binding.implementation_sha256)
    ) {
      return undefined;
    }
    toolBindings.push(binding as unknown as ActivationToolBinding);
  }
  const expectedBindingNames = input.effectProfile ? ["request_input", "web_read", "web_search"] : [];
  if (
    toolBindings.length !== expectedBindingNames.length ||
    toolBindings.some((binding, index) => binding.tool_name !== expectedBindingNames[index])
  ) {
    return undefined;
  }
  if (input.effectProfile) {
    const [requestInput, webRead, webSearch] = toolBindings;
    if (
      requestInput.provider_id !== "subagent007-pi/request_input" ||
      webRead.provider_id !== webSearch.provider_id ||
      webRead.implementation_sha256 !== webSearch.implementation_sha256
    ) {
      return undefined;
    }
  }
  const expectedToolsetSha256 = input.effectProfile
    ? canonicalToolsetDigest({ profile: input.effectProfile, activeToolNames, bindings: toolBindings })
    : null;
  if (receipt.toolset_sha256 !== expectedToolsetSha256) {
    return undefined;
  }
  const rawSkillBinding = receipt.skill_binding;
  if (input.skillBinding === null) {
    if (rawSkillBinding !== null) {
      return undefined;
    }
  } else {
    const skillBinding = record(rawSkillBinding);
    if (!skillBinding || !exactKeys(skillBinding, [
      "name", "path", "content_sha256", "expected_content_sha256",
    ])) {
      return undefined;
    }
    if (
      skillBinding.name !== input.skillBinding.name ||
      skillBinding.path !== input.skillBinding.path ||
      skillBinding.content_sha256 !== input.skillBinding.content_sha256 ||
      skillBinding.expected_content_sha256 !== (input.expectedSkillSha256 ?? null)
    ) {
      return undefined;
    }
  }
  return receipt as unknown as ActivationReceipt;
}

export function workspaceReadOnlyActivationReceipt(input: {
  webProvider: WorkspaceReadOnlyWebProvider;
  requestInputSha256: string;
  skillBinding: ActivationSkillBinding | null;
}): ActivationReceipt {
  if (
    !SHA256_PATTERN.test(input.requestInputSha256) ||
    !SHA256_PATTERN.test(input.webProvider.implementationSha256) ||
    input.webProvider.providerId.trim() === ""
  ) {
    throw new Error("workspace_read_only provider identity or implementation digest is invalid");
  }
  const toolBindings: ActivationToolBinding[] = [
    {
      tool_name: "request_input",
      provider_id: "subagent007-pi/request_input",
      implementation_sha256: input.requestInputSha256,
    },
    {
      tool_name: "web_read",
      provider_id: input.webProvider.providerId,
      implementation_sha256: input.webProvider.implementationSha256,
    },
    {
      tool_name: "web_search",
      provider_id: input.webProvider.providerId,
      implementation_sha256: input.webProvider.implementationSha256,
    },
  ];
  return {
    schema_version: 1,
    confirmed_before_prompt: true,
    requested_effect_profile: "workspace_read_only",
    resolved_effect_profile: "workspace_read_only",
    active_tool_names: [...WORKSPACE_READ_ONLY_TOOL_NAMES],
    tool_bindings: toolBindings,
    toolset_sha256: canonicalToolsetDigest({
      profile: "workspace_read_only",
      activeToolNames: WORKSPACE_READ_ONLY_TOOL_NAMES,
      bindings: toolBindings,
    }),
    skill_binding: input.skillBinding,
  };
}

export function skillOnlyActivationReceipt(skillBinding: ActivationSkillBinding): ActivationReceipt {
  return {
    schema_version: 1,
    confirmed_before_prompt: true,
    requested_effect_profile: null,
    resolved_effect_profile: null,
    active_tool_names: [],
    tool_bindings: [],
    toolset_sha256: null,
    skill_binding: skillBinding,
  };
}
