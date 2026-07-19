import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import {
  manifestName as labManifestName,
  type RuntimeConfig as ManifestRuntimeConfig,
  parseLabManifest,
} from "./lab/manifest.ts";

export const manifestName: typeof labManifestName = labManifestName;

/** Resolve a project-owned path and reject lexical traversal outside the repository. */
export function resolveRepoPath(repoRoot: string, candidate: string): string {
  if (isAbsolute(candidate)) {
    throw new Error(`project path must be relative: ${candidate}`);
  }
  const root = resolve(repoRoot);
  const resolved = resolve(root, candidate);
  const fromRoot = relative(root, resolved);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`project path escapes repository: ${candidate}`);
  }
  return resolved;
}

export interface DeclaredPort {
  name: string;
  service: string;
  target: number;
  scheme?: string;
}

export interface ComposeMode {
  kind: "compose";
  files: string[];
  commandService: string;
}

export interface DockerfileMode {
  kind: "dockerfile";
  dockerfile: string;
  context: string;
  commandService: string;
}

export interface ImageMode {
  kind: "image";
  image: string;
  commandService: string;
}

export type LabMode = ComposeMode | DockerfileMode | ImageMode;

export interface LabConfig {
  repoRoot: string;
  manifestPath: string;
  mode: LabMode;
  runtime: ManifestRuntimeConfig;
  ports: DeclaredPort[];
  forwardEnvironment: string[];
  composeEnvironment: string[];
  secretEnvironment: string[];
}

export function parseLabConfig(
  source: string,
  repoRoot: string,
  sourcePath = resolve(repoRoot, manifestName),
): LabConfig {
  const value = parseLabManifest(source, sourcePath);
  const root = resolve(repoRoot);
  let mode: LabMode;
  if (value.compose) {
    mode = {
      kind: "compose",
      files: value.compose.files.map((file) => resolveRepoPath(root, file)),
      commandService: value.compose.command_service,
    };
  } else if (value.dockerfile) {
    mode = {
      kind: "dockerfile",
      dockerfile: resolveRepoPath(root, value.dockerfile.path),
      context: resolveRepoPath(root, value.dockerfile.context),
      commandService: value.dockerfile.service,
    };
  } else if (value.image) {
    mode = {
      kind: "image",
      image: value.image.name,
      commandService: value.image.service,
    };
  } else {
    // The schema refinement makes this unreachable and keeps the discriminated output total.
    throw new Error(`invalid ${manifestName}: no mode configured`);
  }

  return {
    repoRoot: root,
    manifestPath: resolve(sourcePath),
    mode,
    runtime: value.runtime,
    ports: Object.entries(value.ports).map(([name, port]) => ({
      name,
      ...port,
    })),
    forwardEnvironment: [...value.environment],
    composeEnvironment: [...value.compose_environment],
    secretEnvironment: [...value.secret_environment],
  };
}

export async function loadLabConfig(
  repoRoot: string,
  sourcePath = resolve(repoRoot, manifestName),
): Promise<LabConfig> {
  const root = resolve(repoRoot);
  const manifestPath = resolveRepoPath(
    root,
    relative(root, resolve(sourcePath)),
  );
  await assertRealPathInside(root, manifestPath);
  if (!(await stat(manifestPath)).isFile()) {
    throw new Error("lab manifest must be a regular file");
  }
  const config = parseLabConfig(
    await readFile(manifestPath, "utf8"),
    root,
    manifestPath,
  );
  await assertComposeInputPolicy(config);
  const paths =
    config.mode.kind === "compose"
      ? config.mode.files
      : config.mode.kind === "dockerfile"
        ? [config.mode.dockerfile, config.mode.context]
        : [];
  for (const projectPath of paths) {
    await assertRealPathInside(root, projectPath);
  }
  if (config.mode.kind === "dockerfile") {
    if (!(await stat(config.mode.context)).isDirectory()) {
      throw new Error("dockerfile context must be a directory");
    }
    if (!(await stat(config.mode.dockerfile)).isFile()) {
      throw new Error("dockerfile path must be a regular file");
    }
  }
  return config;
}

/** Reject implicit project interpolation inputs that are not durably bound. */
export async function assertComposeInputPolicy(
  config: LabConfig,
): Promise<void> {
  if (config.mode.kind !== "compose") {
    return;
  }
  try {
    await lstat(resolve(config.repoRoot, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(
    "project .env is not supported; declare non-secret inputs with compose_environment",
  );
}

async function assertRealPathInside(
  repoRoot: string,
  projectPath: string,
): Promise<void> {
  const [realRoot, realProjectPath] = await Promise.all([
    realpath(repoRoot),
    realpath(projectPath),
  ]);
  const fromRoot = relative(realRoot, realProjectPath);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`project path resolves outside repository: ${projectPath}`);
  }
}
