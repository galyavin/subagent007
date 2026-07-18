import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SKILL_RUNTIME_BUNDLE_ALGORITHM = "subagent007.skill_runtime_bundle.sha256.v1" as const;
export const MAX_SKILL_RUNTIME_BUNDLE_FILES = 4_096;
export const MAX_SKILL_RUNTIME_BUNDLE_BYTES = 128 * 1024 * 1024;
const BUNDLE_DIGEST_DOMAIN = `${SKILL_RUNTIME_BUNDLE_ALGORITHM}\n`;
const ADMITTED_DIRECTORIES = new Set(["agents", "assets", "references", "scripts", "templates"]);
const RESIDUE_DIRECTORIES = new Set([
  "__pycache__",
  "coverage",
  "eval",
  "evals",
  "fixtures",
  "node_modules",
  "test",
  "tests",
]);
const ROOT_RESIDUE_FILES = new Set([".DS_Store"]);
const RESIDUE_FILE_PATTERNS = [
  /^test[_-]/i,
  /[_-]test\.[^.]+$/i,
  /\.test\.[^.]+$/i,
  /\.spec\.[^.]+$/i,
  /[_-]selftest\.[^.]+$/i,
  /^coverage[.-]/i,
];

export type RuntimeBundleFailureCode =
  | "runtime_bundle_missing_skill"
  | "runtime_bundle_unreadable"
  | "runtime_bundle_unsafe_path"
  | "runtime_bundle_unadmitted_path"
  | "runtime_bundle_changed"
  | "runtime_bundle_too_large";

export class RuntimeBundleValidationError extends Error {
  constructor(
    public readonly failureCode: RuntimeBundleFailureCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "RuntimeBundleValidationError";
  }
}

export interface RuntimeBundleFileEvidence {
  relative_path: string;
  size_bytes: number;
  content_sha256: string;
  executable: boolean;
}

export interface SkillRuntimeBundleEvidence {
  algorithm: typeof SKILL_RUNTIME_BUNDLE_ALGORITHM;
  bundle_sha256: string;
  complete: true;
  file_count: number;
  total_bytes: number;
  files: RuntimeBundleFileEvidence[];
}

export interface CapturedSkillRuntimeBundle extends SkillRuntimeBundleEvidence {
  source_root_path: string;
  resolved_skill_path: string;
  contents: ReadonlyMap<string, Buffer>;
}

interface CapturedFile extends RuntimeBundleFileEvidence {
  content: Buffer;
}

function isResidueDirectory(name: string): boolean {
  return name.startsWith(".") || RESIDUE_DIRECTORIES.has(name.toLowerCase());
}

function isResidueFile(name: string): boolean {
  return name.startsWith(".") || RESIDUE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function assertCanonicalRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath !== relativePath.normalize("NFC") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new RuntimeBundleValidationError(
      "runtime_bundle_unsafe_path",
      `unsafe runtime bundle path ${JSON.stringify(relativePath)}`,
    );
  }
}

async function collectAdmittedPaths(sourceRoot: string): Promise<string[]> {
  let rootEntries;
  try {
    rootEntries = await fs.readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    throw new RuntimeBundleValidationError(
      "runtime_bundle_unreadable",
      "runtime bundle root could not be read",
      { cause: error },
    );
  }

  const paths: string[] = [];
  for (const entry of rootEntries) {
    if (entry.name === "SKILL.md") {
      if (!entry.isFile()) {
        throw new RuntimeBundleValidationError(
          "runtime_bundle_missing_skill",
          "runtime bundle SKILL.md must be a regular file",
        );
      }
      paths.push("SKILL.md");
      continue;
    }
    if (ROOT_RESIDUE_FILES.has(entry.name) || isResidueDirectory(entry.name)) continue;
    if (!ADMITTED_DIRECTORIES.has(entry.name)) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_unadmitted_path",
        `unadmitted runtime bundle path ${JSON.stringify(entry.name)}`,
      );
    }
    if (!entry.isDirectory()) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_unsafe_path",
        `runtime bundle path ${JSON.stringify(entry.name)} must be a directory and cannot be a symbolic link`,
      );
    }
    await collectDirectory(sourceRoot, entry.name, paths);
  }
  if (!paths.includes("SKILL.md")) {
    throw new RuntimeBundleValidationError(
      "runtime_bundle_missing_skill",
      "runtime bundle requires SKILL.md",
    );
  }
  return paths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

async function collectDirectory(sourceRoot: string, relativeDirectory: string, paths: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(path.join(sourceRoot, relativeDirectory), { withFileTypes: true });
  } catch (error) {
    throw new RuntimeBundleValidationError(
      "runtime_bundle_unreadable",
      `runtime bundle directory ${JSON.stringify(relativeDirectory)} could not be read`,
      { cause: error },
    );
  }
  for (const entry of entries) {
    if (entry.isDirectory() && isResidueDirectory(entry.name)) continue;
    if (entry.isFile() && isResidueFile(entry.name)) continue;
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    assertCanonicalRelativePath(relativePath);
    if (entry.isSymbolicLink()) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_unsafe_path",
        `runtime bundle path ${JSON.stringify(relativePath)} cannot be a symbolic link`,
      );
    }
    if (entry.isDirectory()) {
      await collectDirectory(sourceRoot, relativePath, paths);
    } else if (entry.isFile()) {
      paths.push(relativePath);
    } else {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_unsafe_path",
        `runtime bundle path ${JSON.stringify(relativePath)} must be a regular file`,
      );
    }
  }
}

function uint32(value: number): Buffer {
  const framed = Buffer.allocUnsafe(4);
  framed.writeUInt32BE(value);
  return framed;
}

function uint64(value: number): Buffer {
  const framed = Buffer.allocUnsafe(8);
  framed.writeBigUInt64BE(BigInt(value));
  return framed;
}

function canonicalRuntimeBundleDigest(files: readonly RuntimeBundleFileEvidence[], contents: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256").update(BUNDLE_DIGEST_DOMAIN);
  for (const file of files) {
    const relativePath = Buffer.from(file.relative_path, "utf8");
    const content = contents.get(file.relative_path);
    if (!content) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_unreadable",
        `exact bytes are required to digest ${JSON.stringify(file.relative_path)}`,
      );
    }
    hash.update(uint32(relativePath.length));
    hash.update(relativePath);
    hash.update(Buffer.from([file.executable ? 1 : 0]));
    hash.update(uint64(content.length));
    hash.update(content);
  }
  return hash.digest("hex");
}

async function captureOnce(
  sourceRoot: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<CapturedSkillRuntimeBundle> {
  const realRoot = await fs.realpath(sourceRoot).catch((error) => {
    throw new RuntimeBundleValidationError("runtime_bundle_unreadable", "runtime bundle root could not be resolved", { cause: error });
  });
  const relativePaths = await collectAdmittedPaths(realRoot);
  if (relativePaths.length > limits.maxFiles) {
    throw new RuntimeBundleValidationError(
      "runtime_bundle_too_large",
      `runtime bundle exceeds the ${limits.maxFiles}-file limit`,
    );
  }
  const captured: CapturedFile[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(realRoot, ...relativePath.split("/"));
    const before = await fs.lstat(absolutePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_unsafe_path",
        `runtime bundle path ${JSON.stringify(relativePath)} must remain a regular file and cannot be a symbolic link`,
      );
    }
    const realFile = await fs.realpath(absolutePath);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw new RuntimeBundleValidationError("runtime_bundle_unsafe_path", "runtime bundle file escaped its source root");
    }
    const content = await fs.readFile(absolutePath);
    const after = await fs.lstat(absolutePath, { bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.mode !== after.mode
    ) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_changed",
        "source changed while the runtime bundle was being read",
      );
    }
    contents.set(relativePath, content);
    totalBytes += content.length;
    captured.push({
      relative_path: relativePath,
      size_bytes: content.length,
      content_sha256: createHash("sha256").update(content).digest("hex"),
      executable: (Number(after.mode) & 0o111) !== 0,
      content,
    });
    if (totalBytes > limits.maxBytes) {
      throw new RuntimeBundleValidationError(
        "runtime_bundle_too_large",
        `runtime bundle exceeds the ${limits.maxBytes}-byte limit`,
      );
    }
  }
  const files = captured.map(({ content: _content, ...evidence }) => evidence);
  return {
    algorithm: SKILL_RUNTIME_BUNDLE_ALGORITHM,
    bundle_sha256: canonicalRuntimeBundleDigest(files, contents),
    complete: true,
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.size_bytes, 0),
    files,
    source_root_path: realRoot,
    resolved_skill_path: path.join(realRoot, "SKILL.md"),
    contents,
  };
}

export async function captureSkillRuntimeBundle(
  sourceRoot: string,
  options: {
    beforeFinalIdentityCheck?: () => Promise<void>;
    maxFiles?: number;
    maxBytes?: number;
  } = {},
): Promise<CapturedSkillRuntimeBundle> {
  const limits = {
    maxFiles: options.maxFiles ?? MAX_SKILL_RUNTIME_BUNDLE_FILES,
    maxBytes: options.maxBytes ?? MAX_SKILL_RUNTIME_BUNDLE_BYTES,
  };
  const first = await captureOnce(sourceRoot, limits);
  await options.beforeFinalIdentityCheck?.();
  const second = await captureOnce(sourceRoot, limits);
  if (
    first.source_root_path !== second.source_root_path ||
    first.bundle_sha256 !== second.bundle_sha256 ||
    JSON.stringify(first.files) !== JSON.stringify(second.files)
  ) {
    throw new RuntimeBundleValidationError(
      "runtime_bundle_changed",
      "source changed while the runtime bundle was being read",
    );
  }
  return second;
}

export async function validateSkillRuntimeBundle(
  sourceRoot: string,
  options: {
    beforeFinalIdentityCheck?: () => Promise<void>;
    maxFiles?: number;
    maxBytes?: number;
  } = {},
): Promise<SkillRuntimeBundleEvidence> {
  const { source_root_path: _root, resolved_skill_path: _skill, contents: _contents, ...evidence } =
    await captureSkillRuntimeBundle(sourceRoot, options);
  return evidence;
}
