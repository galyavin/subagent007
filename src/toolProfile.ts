import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ActivationReceipt,
  ActivationSkillBinding,
  ActivationToolBinding,
  AuthoringEffectScopeBinding,
  EffectProfile,
} from "./types.js";
import {
  controllerScriptName,
  controllerToolForEffectProfile,
  type BoundedControllerToolName,
  type ResolvedBoundedControllerPython,
} from "./boundedController.js";
import {
  assertAuthoringEffectScopeBinding,
  isEffectScopedAuthoringProfile,
} from "./authoringEffectScope.js";
import { canonicalJson } from "./clientStartAdmission.js";

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
export const SKILL_CREATOR_AUTHORING_V1_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
] as const;
export const TASK_ROOT_AUTHORING_V1_TOOL_NAMES = ["read", "write"] as const;
export const RESEARCHER_BOUNDED_V1_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "web_search",
  "web_read",
  "researchctl",
] as const;
export const ASSUMPTION_AUDIT_BOUNDED_V1_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "web_search",
  "web_read",
  "aj_switchboard",
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function effectProfileToolNames(effectProfile: EffectProfile): readonly string[] {
  switch (effectProfile) {
    case "workspace_read_only":
      return WORKSPACE_READ_ONLY_TOOL_NAMES;
    case "task_root_authoring_v1":
      return TASK_ROOT_AUTHORING_V1_TOOL_NAMES;
    case "skill_creator_authoring_v1":
      return SKILL_CREATOR_AUTHORING_V1_TOOL_NAMES;
    case "researcher_bounded_v1":
      return RESEARCHER_BOUNDED_V1_TOOL_NAMES;
    case "assumption_audit_bounded_v1":
      return ASSUMPTION_AUDIT_BOUNDED_V1_TOOL_NAMES;
  }
}

export function isBoundedEffectProfile(effectProfile: EffectProfile | undefined): effectProfile is Extract<
  EffectProfile,
  "researcher_bounded_v1" | "assumption_audit_bounded_v1"
> {
  return effectProfile === "researcher_bounded_v1" || effectProfile === "assumption_audit_bounded_v1";
}

export function boundedEffectProfileSkill(effectProfile: EffectProfile): "researcher" | "assumption-judge" | undefined {
  if (effectProfile === "researcher_bounded_v1") return "researcher";
  if (effectProfile === "assumption_audit_bounded_v1") return "assumption-judge";
  return undefined;
}

function effectProfileBindingNames(effectProfile: EffectProfile): readonly ActivationToolBinding["tool_name"][] {
  switch (effectProfile) {
    case "workspace_read_only":
      return ["request_input", "web_read", "web_search"];
    case "researcher_bounded_v1":
      return ["web_read", "web_search", "researchctl"];
    case "assumption_audit_bounded_v1":
      return ["web_read", "web_search", "aj_switchboard"];
    case "skill_creator_authoring_v1":
    case "task_root_authoring_v1":
      return [];
  }
}

export interface SessionToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
}

export function activateAllRegisteredTools(
  session: SessionToolRegistry,
  recursiveDelegation: "disabled" | "enabled",
): void {
  const registeredToolNames = session.getAllTools().map((tool) => tool.name);
  const allToolNames = recursiveDelegation === "enabled"
    ? registeredToolNames
    : registeredToolNames.filter((name) => name !== "delegate");
  session.setActiveToolsByName(allToolNames);
  const activeToolNames = session.getActiveToolNames();
  const activeToolNameSet = new Set(activeToolNames);
  const missingWebTools = REQUIRED_WEB_TOOLS.filter((name) => !activeToolNameSet.has(name));
  if (missingWebTools.length > 0) {
    throw new Error(
      `required Pi web search tools unavailable: ${missingWebTools.join(", ")}; install/configure the Pi web search extension before running Subagent007`,
    );
  }
  if (recursiveDelegation === "enabled" && !activeToolNameSet.has("delegate")) {
    throw new Error("recursive delegation was enabled but the native delegate tool is unavailable");
  }
  if (recursiveDelegation === "disabled" && activeToolNameSet.has("delegate")) {
    throw new Error("recursive delegation was disabled but delegate remained active");
  }
}

export function activateEffectProfileTools(session: SessionToolRegistry, effectProfile: EffectProfile): void {
  const expected = effectProfileToolNames(effectProfile);
  const registered = new Set(session.getAllTools().map((tool) => tool.name));
  const unavailable = expected.filter((name) => !registered.has(name));
  if (unavailable.length > 0) {
    throw new Error(`${effectProfile} tools unavailable: ${unavailable.join(", ")}`);
  }
  session.setActiveToolsByName([...expected]);
  const active = session.getActiveToolNames();
  if (
    active.length !== expected.length ||
    active.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `${effectProfile} activation mismatch: expected ${expected.join(", ")}; got ${active.join(", ")}`,
    );
  }
}

/** Compatibility helper retained for existing workspace-read-only callers/tests. */
export function activateWorkspaceReadOnlyTools(session: SessionToolRegistry): void {
  activateEffectProfileTools(session, "workspace_read_only");
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

const BOUNDED_CONTROLLER_BINDING_DOMAIN = "subagent007.bounded_controller_binding.v2\n";

async function boundedControllerImplementationSha256(
  childEntrypoint: string,
  snapshotSkillFilePath: string,
  scriptName: string,
  controllerPython: ResolvedBoundedControllerPython,
): Promise<string> {
  const releaseRoot = path.dirname(childEntrypoint);
  const wrapperName = "boundedController.js";
  const wrapperPath = path.join(releaseRoot, wrapperName);
  const scriptPath = path.join(path.dirname(snapshotSkillFilePath), "scripts", scriptName);
  const [wrapper, script] = await Promise.all([
    fs.readFile(wrapperPath),
    fs.readFile(scriptPath),
  ]);
  return createHash("sha256")
    .update(BOUNDED_CONTROLLER_BINDING_DOMAIN)
    .update(wrapperName)
    .update("\0")
    .update(wrapper)
    .update("\0")
    .update(`scripts/${scriptName}`)
    .update("\0")
    .update(script)
    .update("\0")
    .update("resolved_python_realpath")
    .update("\0")
    .update(controllerPython.realpath)
    .update("\0")
    .update("resolved_python_sha256")
    .update("\0")
    .update(controllerPython.file_sha256)
    .digest("hex");
}

export interface BoundedControllerActivationInput {
  effectProfile: Extract<EffectProfile, "researcher_bounded_v1" | "assumption_audit_bounded_v1">;
  skillName: string;
  snapshotSkillFilePath: string;
  childEntrypoint: string;
  webProvider: WorkspaceReadOnlyWebProvider;
  controllerPython: ResolvedBoundedControllerPython;
}

export async function boundedControllerActivationBindings(
  input: BoundedControllerActivationInput,
): Promise<ActivationToolBinding[]> {
  const expectedSkill = boundedEffectProfileSkill(input.effectProfile);
  const controllerTool = controllerToolForEffectProfile(input.effectProfile);
  if (!expectedSkill || !controllerTool || input.skillName !== expectedSkill) {
    throw new Error(`${input.effectProfile} requires canonical skill ${expectedSkill ?? "unknown"}`);
  }
  const scriptName = controllerScriptName(controllerTool);
  const implementationSha256 = await boundedControllerImplementationSha256(
    input.childEntrypoint,
    input.snapshotSkillFilePath,
    scriptName,
    input.controllerPython,
  );
  return [
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
    {
      tool_name: controllerTool,
      provider_id: `subagent007-pi/${controllerTool}`,
      implementation_sha256: implementationSha256,
    },
  ];
}

export function assertExactBoundedActivationToolBindings(
  expected: readonly ActivationToolBinding[] | undefined,
  derived: readonly ActivationToolBinding[],
): void {
  if (!expected || JSON.stringify(expected) !== JSON.stringify(derived)) {
    throw new Error("bounded controller or provider binding differs from parent preflight");
  }
}

export function explicitWebProviderExtensionPaths(
  effectProfile: EffectProfile | undefined,
  webProvider: WorkspaceReadOnlyWebProvider | undefined,
): string[] {
  return effectProfile === "workspace_read_only" || isBoundedEffectProfile(effectProfile)
    ? webProvider ? [webProvider.extensionPath] : []
    : [];
}

export async function boundedControllerScriptPath(
  effectProfile: Extract<EffectProfile, "researcher_bounded_v1" | "assumption_audit_bounded_v1">,
  skillName: string,
  snapshotSkillFilePath: string,
): Promise<{ tool: BoundedControllerToolName; scriptPath: string }> {
  const expectedSkill = boundedEffectProfileSkill(effectProfile);
  const tool = controllerToolForEffectProfile(effectProfile);
  if (!expectedSkill || !tool || skillName !== expectedSkill) {
    throw new Error(`${effectProfile} requires canonical skill ${expectedSkill ?? "unknown"}`);
  }
  const snapshotSkill = await fs.realpath(snapshotSkillFilePath);
  if (path.basename(snapshotSkill) !== "SKILL.md") {
    throw new Error("bounded controller skill snapshot must resolve to SKILL.md");
  }
  const runtimeRoot = await fs.realpath(path.dirname(snapshotSkill));
  const scriptPath = path.join(runtimeRoot, "scripts", controllerScriptName(tool));
  const resolvedScript = await fs.realpath(scriptPath);
  if (resolvedScript !== scriptPath || !resolvedScript.startsWith(`${runtimeRoot}${path.sep}`)) {
    throw new Error("bounded controller script must remain in the exact immutable snapshot runtime root");
  }
  const stat = await fs.stat(resolvedScript);
  if (!stat.isFile()) {
    throw new Error("bounded controller script must be a regular file");
  }
  return { tool, scriptPath: resolvedScript };
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
  expectedToolBindings?: readonly ActivationToolBinding[];
  expectedEffectScopeBinding?: AuthoringEffectScopeBinding;
}): ActivationReceipt | undefined {
  const receipt = record(input.value);
  const requiresEffectScope = isEffectScopedAuthoringProfile(input.effectProfile);
  if (requiresEffectScope !== Boolean(input.expectedEffectScopeBinding)) {
    return undefined;
  }
  const expectedKeys = [
    "schema_version",
    "confirmed_before_prompt",
    "requested_effect_profile",
    "resolved_effect_profile",
    "active_tool_names",
    "tool_bindings",
    "toolset_sha256",
    "skill_binding",
    ...(requiresEffectScope ? ["effect_scope_binding"] : []),
  ];
  if (!receipt || !exactKeys(receipt, expectedKeys)) {
    return undefined;
  }
  if (
    receipt.schema_version !== (requiresEffectScope ? 2 : 1) ||
    receipt.confirmed_before_prompt !== true
  ) {
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
  const expectedActive = input.effectProfile ? [...effectProfileToolNames(input.effectProfile)] : [];
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
      !["request_input", "web_read", "web_search", "researchctl", "aj_switchboard"].includes(String(binding.tool_name)) ||
      typeof binding.provider_id !== "string" || binding.provider_id.trim() === "" ||
      typeof binding.implementation_sha256 !== "string" || !SHA256_PATTERN.test(binding.implementation_sha256)
    ) {
      return undefined;
    }
    toolBindings.push(binding as unknown as ActivationToolBinding);
  }
  const expectedBindingNames = input.effectProfile ? effectProfileBindingNames(input.effectProfile) : [];
  if (
    toolBindings.length !== expectedBindingNames.length ||
    toolBindings.some((binding, index) => binding.tool_name !== expectedBindingNames[index])
  ) {
    return undefined;
  }
  if (input.effectProfile === "workspace_read_only") {
    const [requestInput, webRead, webSearch] = toolBindings;
    if (
      requestInput.provider_id !== "subagent007-pi/request_input" ||
      webRead.provider_id !== webSearch.provider_id ||
      webRead.implementation_sha256 !== webSearch.implementation_sha256
    ) {
      return undefined;
    }
  }
  if (isBoundedEffectProfile(input.effectProfile)) {
    try {
      assertExactBoundedActivationToolBindings(input.expectedToolBindings, toolBindings);
    } catch {
      return undefined;
    }
  }
  const expectedToolsetSha256 = input.effectProfile
    ? canonicalToolsetDigest({ profile: input.effectProfile, activeToolNames, bindings: toolBindings })
    : null;
  if (receipt.toolset_sha256 !== expectedToolsetSha256) {
    return undefined;
  }
  if (requiresEffectScope) {
    try {
      assertAuthoringEffectScopeBinding(input.expectedEffectScopeBinding!);
    } catch {
      return undefined;
    }
    if (
      input.expectedEffectScopeBinding!.effect_profile !== input.effectProfile ||
      canonicalJson(receipt.effect_scope_binding) !== canonicalJson(input.expectedEffectScopeBinding)
    ) {
      return undefined;
    }
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

/**
 * Revalidates a durable/public activation projection with the same strict
 * receipt owner used at child ingress. Mutable launch preflights are not
 * repeated here; the receipt's exact self-contained bindings are the inputs.
 */
export function validatedProjectedActivationReceipt(input: {
  value: unknown;
  requestedEffectProfile?: EffectProfile;
  expectedSkillSha256?: string;
}): ActivationReceipt | undefined {
  const receipt = record(input.value);
  if (!receipt) return undefined;
  const rawSkillBinding = receipt.skill_binding;
  const skillBinding = rawSkillBinding === null
    ? null
    : record(rawSkillBinding) as unknown as ActivationSkillBinding | undefined;
  if (skillBinding === undefined || (input.expectedSkillSha256 !== undefined && skillBinding === null)) {
    return undefined;
  }
  const requiresEffectScope = isEffectScopedAuthoringProfile(input.requestedEffectProfile);
  const expectedEffectScopeBinding = requiresEffectScope
    ? record(receipt.effect_scope_binding) as unknown as AuthoringEffectScopeBinding | undefined
    : undefined;
  const expectedToolBindings = isBoundedEffectProfile(input.requestedEffectProfile) && Array.isArray(receipt.tool_bindings)
    ? receipt.tool_bindings as ActivationToolBinding[]
    : undefined;
  return validatedActivationReceipt({
    value: receipt,
    effectProfile: input.requestedEffectProfile,
    skillBinding,
    expectedSkillSha256: input.expectedSkillSha256,
    expectedToolBindings,
    expectedEffectScopeBinding,
  });
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

export function skillCreatorAuthoringV1ActivationReceipt(skillBinding: ActivationSkillBinding | null): ActivationReceipt {
  const activeToolNames = [...SKILL_CREATOR_AUTHORING_V1_TOOL_NAMES];
  return {
    schema_version: 1,
    confirmed_before_prompt: true,
    requested_effect_profile: "skill_creator_authoring_v1",
    resolved_effect_profile: "skill_creator_authoring_v1",
    active_tool_names: activeToolNames,
    tool_bindings: [],
    toolset_sha256: canonicalToolsetDigest({
      profile: "skill_creator_authoring_v1",
      activeToolNames,
      bindings: [],
    }),
    skill_binding: skillBinding,
  };
}

export function taskRootAuthoringV1ActivationReceipt(
  skillBinding: ActivationSkillBinding | null,
  effectScopeBinding: AuthoringEffectScopeBinding,
): ActivationReceipt {
  const activeToolNames = [...TASK_ROOT_AUTHORING_V1_TOOL_NAMES];
  return {
    schema_version: 2,
    confirmed_before_prompt: true,
    requested_effect_profile: "task_root_authoring_v1",
    resolved_effect_profile: "task_root_authoring_v1",
    active_tool_names: activeToolNames,
    tool_bindings: [],
    toolset_sha256: canonicalToolsetDigest({
      profile: "task_root_authoring_v1",
      activeToolNames,
      bindings: [],
    }),
    skill_binding: skillBinding,
    effect_scope_binding: effectScopeBinding,
  };
}

export function boundedAuthoringActivationReceipt(input: {
  effectProfile: Extract<EffectProfile, "researcher_bounded_v1" | "assumption_audit_bounded_v1">;
  skillBinding: ActivationSkillBinding | null;
  toolBindings: ActivationToolBinding[];
  effectScopeBinding: AuthoringEffectScopeBinding;
}): ActivationReceipt {
  assertAuthoringEffectScopeBinding(input.effectScopeBinding);
  if (input.effectScopeBinding.effect_profile !== input.effectProfile) {
    throw new Error("bounded activation receipt effect scope does not match its profile");
  }
  const activeToolNames = [...effectProfileToolNames(input.effectProfile)];
  return {
    schema_version: 2,
    confirmed_before_prompt: true,
    requested_effect_profile: input.effectProfile,
    resolved_effect_profile: input.effectProfile,
    active_tool_names: activeToolNames,
    tool_bindings: input.toolBindings,
    toolset_sha256: canonicalToolsetDigest({
      profile: input.effectProfile,
      activeToolNames,
      bindings: input.toolBindings,
    }),
    skill_binding: input.skillBinding,
    effect_scope_binding: input.effectScopeBinding,
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
