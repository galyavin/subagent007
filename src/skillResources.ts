import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  loadSkills,
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
}

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

function ambiguousSkillError(skillName: string): Error {
  return new ValidationError(
    `skill ${JSON.stringify(skillName)} is ambiguous across configured Subagent007 skill paths`,
  );
}

export function resolveRequestedSkill(skillName: string, options: Omit<SkillResourceOptions, "skill">): Skill {
  const result = loadSkills({
    cwd: options.cwd,
    agentDir: options.agentDir,
    skillPaths: options.lookupPaths ?? defaultSkillLookupPaths(),
    includeDefaults: true,
  });
  if (result.diagnostics.some((diagnostic) => collisionName(diagnostic) === skillName)) {
    throw ambiguousSkillError(skillName);
  }

  const matches = result.skills.filter((skill) => skill.name === skillName);
  if (matches.length === 0) {
    throw new ValidationError(
      `unknown skill ${JSON.stringify(skillName)}; requested skills must resolve to exactly one configured Subagent007 skill`,
    );
  }
  if (matches.length > 1) {
    throw ambiguousSkillError(skillName);
  }
  return matches[0];
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
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalSkillPaths: skillResourcePathsForRequest(options),
    noSkills: true,
  });
}
