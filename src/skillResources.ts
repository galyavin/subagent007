import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  loadSkills,
  type InlineExtension,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { ValidationError } from "./types.js";

interface SkillCollisionDiagnostic {
  collision?: {
    resourceType?: string;
    name?: string;
  };
}

export interface SkillResourceOptions {
  cwd: string;
  agentDir: string;
  skill?: string;
  skillFilePath?: string;
  lookupPaths?: string[];
  noAmbientExtensions?: boolean;
  explicitExtensionPaths?: string[];
  extensionFactories?: InlineExtension[];
  systemSkill?: string;
}

export type SkillResolutionFailureCode = "skill_not_found" | "skill_ambiguous";

export class SkillResolutionError extends ValidationError {
  constructor(
    message: string,
    public readonly resolutionCode: SkillResolutionFailureCode,
  ) {
    super(message, "invalid_skill");
  }
}

export type LoadedSkillCatalog = ReturnType<typeof loadSkills>;

function defaultSkillLookupPaths(home = os.homedir()): string[] {
  const envPaths = process.env.SUBAGENT007_PI_SKILL_PATHS
    ?.split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? [];
  return [
    ...envPaths,
    path.join(home, ".codex", "skills"),
    path.join(home, ".codex", "plugins", "cache"),
    path.join(home, ".codex", "gstack", ".agents", "skills"),
  ].filter((entry, index, all) => fsSync.existsSync(entry) && all.indexOf(entry) === index);
}

function collisionName(diagnostic: unknown): string | undefined {
  const collision = (diagnostic as SkillCollisionDiagnostic).collision;
  if (collision?.resourceType === "skill" && typeof collision.name === "string") {
    return collision.name;
  }
  return undefined;
}

function ambiguousSkillError(skillName: string): SkillResolutionError {
  return new SkillResolutionError(
    `skill ${JSON.stringify(skillName)} is ambiguous across configured Subagent007 skill paths`,
    "skill_ambiguous",
  );
}

function configuredSkillLookupPaths(paths: readonly string[]): string[] {
  return paths.flatMap((lookupPath) => {
    const systemPath = path.join(lookupPath, ".system");
    return fsSync.existsSync(systemPath) ? [lookupPath, systemPath] : [lookupPath];
  });
}

export function loadSkillCatalog(
  options: Pick<SkillResourceOptions, "cwd" | "agentDir" | "lookupPaths">,
): LoadedSkillCatalog {
  return loadSkills({
    cwd: options.cwd,
    agentDir: options.agentDir,
    // Pi intentionally skips dot-directories during recursive discovery. Platform
    // skills live under configured roots/.system, so add that root explicitly and
    // retain loadSkills' normal collision diagnostics and canonical bare-name lookup.
    skillPaths: configuredSkillLookupPaths(options.lookupPaths ?? defaultSkillLookupPaths()),
    includeDefaults: true,
  });
}

export function resolveRequestedSkillFromCatalog(
  skillName: string,
  result: LoadedSkillCatalog,
): Skill {
  if (result.diagnostics.some((diagnostic) => collisionName(diagnostic) === skillName)) {
    throw ambiguousSkillError(skillName);
  }

  const matches = result.skills.filter((skill) => skill.name === skillName);
  if (matches.length === 0) {
    throw new SkillResolutionError(
      `unknown skill ${JSON.stringify(skillName)}; requested skills must resolve to exactly one configured Subagent007 skill`,
      "skill_not_found",
    );
  }
  if (matches.length > 1) {
    throw ambiguousSkillError(skillName);
  }
  return matches[0];
}

export function resolveRequestedSkill(skillName: string, options: Omit<SkillResourceOptions, "skill">): Skill {
  return resolveRequestedSkillFromCatalog(skillName, loadSkillCatalog(options));
}

export function skillResourcePathsForRequest(options: SkillResourceOptions): string[] {
  if (options.skillFilePath) {
    return [options.skillFilePath];
  }
  if (!options.skill) {
    return [];
  }
  return [resolveRequestedSkill(options.skill, options).filePath];
}

export function createSkillScopedResourceLoader(options: SkillResourceOptions): DefaultResourceLoader {
  if (!options.systemSkill) {
    return new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      additionalSkillPaths: skillResourcePathsForRequest(options),
      noSkills: true,
      extensionFactories: options.extensionFactories,
      ...(options.noAmbientExtensions
        ? {
            noExtensions: true,
            additionalExtensionPaths: options.explicitExtensionPaths ?? [],
          }
        : {}),
    });
  }

  const catalog = loadSkillCatalog(options);
  // A run-owned selected-skill snapshot remains the first authority for that
  // specialist name. Every other catalogue skill stays discoverable, except
  // the governing skill whose body is promoted by the final inline extension.
  const skillPaths = [
    ...(options.skillFilePath ? [options.skillFilePath] : []),
    ...catalog.skills.map((skill) => skill.filePath),
  ].filter((entry, index, all) => all.indexOf(entry) === index);
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalSkillPaths: skillPaths,
    noSkills: true,
    extensionFactories: options.extensionFactories,
    skillsOverride: (current) => ({
      skills: current.skills.filter((skill) => skill.name !== options.systemSkill),
      diagnostics: current.diagnostics,
    }),
    ...(options.noAmbientExtensions
      ? {
          noExtensions: true,
          additionalExtensionPaths: options.explicitExtensionPaths ?? [],
        }
      : {}),
  });
}
