import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";

export const CONTAINER_LAB_SOURCE_PATH = "packages/container-lab";

const CONTAINER_LAB_PROVENANCE = "a2f44416ef467d9f54b3cb228e3bd050987a3c4c";
const CONTAINER_LAB_ENTRYPOINTS = ["src/cli.ts", "src/reaper-cli.ts"] as const;
export const CONTAINER_LAB_STATIC_INPUTS = [
  "LICENSE",
  "install/com.openai.codex-container-lab-reaper.plist",
  "docs/architecture.md",
  "docs/completion-contract.md",
  "docs/installation.md",
  "docs/manifest.md",
  "docs/safety.md",
] as const;
const CONTAINER_LAB_LAUNCHER =
  "skills/codex-container-lab/scripts/codex-container-lab";

export class ContainerLabPackageError extends Error {}

export async function stageContainerLabRuntime(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const sourceRoot = join(repoRoot, CONTAINER_LAB_SOURCE_PATH);
  const destinationRoot = join(pluginRoot, CONTAINER_LAB_SOURCE_PATH);
  const bundleRoot = join(destinationRoot, "src");
  await mkdir(bundleRoot, { recursive: true });

  for (const path of CONTAINER_LAB_ENTRYPOINTS) {
    const destination = join(bundleRoot, entrypointName(path));
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(CONTAINER_LAB_SOURCE_PATH, path),
        "--target=bun",
        "--format=esm",
        `--outfile=${destination}`,
      ],
      {
        cwd: repoRoot,
        env: { PATH: process.env["PATH"] ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (build.exitCode !== 0) {
      const details = Buffer.concat([
        Buffer.from(build.stdout),
        Buffer.from(build.stderr),
      ])
        .toString("utf8")
        .trim();
      throw new ContainerLabPackageError(
        `Unable to bundle Container Lab runtime ${path}:\n${details}`,
      );
    }
  }

  const bundledFiles = await listFiles(bundleRoot);
  const expectedFiles = CONTAINER_LAB_ENTRYPOINTS.map(entrypointName);
  if (
    bundledFiles.length !== expectedFiles.length ||
    expectedFiles.some((path) => !bundledFiles.includes(path))
  ) {
    throw new ContainerLabPackageError(
      `Container Lab bundling produced unexpected files: ${bundledFiles.join(
        ", ",
      )}.`,
    );
  }
  await Promise.all(
    expectedFiles.map((path) => chmod(join(bundleRoot, path), 0o755)),
  );

  for (const path of CONTAINER_LAB_STATIC_INPUTS) {
    await copyContainerLabInput(
      join(sourceRoot, path),
      join(destinationRoot, path),
      `${CONTAINER_LAB_SOURCE_PATH}/${path}`,
    );
  }
}

export async function validateContainerLabRuntime(
  pluginRoot: string,
): Promise<void> {
  const runtimeRoot = join(pluginRoot, CONTAINER_LAB_SOURCE_PATH);
  for (const path of CONTAINER_LAB_ENTRYPOINTS) {
    const bundledPath = join(runtimeRoot, path);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(bundledPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ContainerLabPackageError(
          `Container Lab runtime is missing ${path}.`,
        );
      }
      throw error;
    }
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new ContainerLabPackageError(
        `Container Lab runtime ${path} must be an executable regular file.`,
      );
    }
  }
}

export async function validateContainerLabDescriptor(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const descriptor = await readJsonObject(
    join(
      repoRoot,
      CONTAINER_LAB_SOURCE_PATH,
      "assets/integrations/container-lab.json",
    ),
    "Container Lab descriptor",
  );
  const packageMetadata = await readJsonObject(
    join(repoRoot, CONTAINER_LAB_SOURCE_PATH, "package.json"),
    "Container Lab package metadata",
  );
  const bundled = descriptor["bundled"];
  const ownership = descriptor["ownership"];
  const expectedDocumentation = CONTAINER_LAB_STATIC_INPUTS.filter((path) =>
    path.startsWith("docs/"),
  ).map((path) => `${CONTAINER_LAB_SOURCE_PATH}/${path}`);
  const expected = {
    operationalEntrypoint: `${CONTAINER_LAB_SOURCE_PATH}/src/cli.ts`,
    reaperEntrypoint: `${CONTAINER_LAB_SOURCE_PATH}/src/reaper-cli.ts`,
    launcher: CONTAINER_LAB_LAUNCHER,
    launchAgentTemplate: `${CONTAINER_LAB_SOURCE_PATH}/install/com.openai.codex-container-lab-reaper.plist`,
  };

  if (
    descriptor["configuredRuntime"] !== packageMetadata["version"] ||
    !isObject(ownership) ||
    ownership["runtimeOwner"] !== "skizzles" ||
    ownership["canonicalSource"] !== CONTAINER_LAB_SOURCE_PATH ||
    ownership["provenanceCommit"] !== CONTAINER_LAB_PROVENANCE ||
    !isObject(bundled) ||
    Object.entries(expected).some(([key, value]) => bundled[key] !== value) ||
    !Array.isArray(bundled["documentation"]) ||
    !sameStrings(bundled["documentation"], expectedDocumentation)
  ) {
    throw new ContainerLabPackageError(
      "Container Lab descriptor must match the canonical package metadata and staged plugin inputs.",
    );
  }

  for (const path of [
    expected.operationalEntrypoint,
    expected.reaperEntrypoint,
    expected.launcher,
    expected.launchAgentTemplate,
    ...expectedDocumentation,
  ]) {
    if (
      !(
        (await exists(join(repoRoot, path))) &&
        (await exists(join(pluginRoot, path)))
      )
    ) {
      throw new ContainerLabPackageError(
        `Container Lab descriptor path is not a canonical and staged input: ${path}.`,
      );
    }
  }
}

async function copyContainerLabInput(
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ContainerLabPackageError(
      `${label} must be a self-contained regular file.`,
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, metadata.mode & 0o777);
}

async function listFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new ContainerLabPackageError(`${root} must be a directory.`);
  }
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new ContainerLabPackageError(
          `${path} is an unsupported symlink.`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
      } else if (metadata.isFile()) {
        files.push(path);
      } else {
        throw new ContainerLabPackageError(
          `${path} is not a regular file or directory.`,
        );
      }
    }
  }

  await visit(root);
  return files;
}

function entrypointName(path: string): string {
  const name = path.split("/").at(-1);
  if (name === undefined) {
    throw new ContainerLabPackageError(
      `Container Lab runtime entrypoint has no filename: ${path}.`,
    );
  }
  return name;
}

async function readJsonObject(
  path: string,
  label: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ContainerLabPackageError(
      `Unable to read ${label} at ${path}: ${String(error)}`,
    );
  }
  if (!isObject(value)) {
    throw new ContainerLabPackageError(`${label} must contain a JSON object.`);
  }
  return value;
}

function sameStrings(actual: unknown[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
