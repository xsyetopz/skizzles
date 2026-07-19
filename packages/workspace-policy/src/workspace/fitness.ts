import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "./contract.ts";
import { listFiles } from "./filesystem.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const GENERATED_DIRECTORIES = new Set([
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);
const GENERATED_FILE_PATTERN = /(?:\.d|\.gen|\.generated)\.ts$/u;
const PACKAGE_PATH_PATTERN =
  /(?:^|["'`\\/])packages[\\/]+([a-z0-9-]+)(?:[\\/]+|["'`])/gu;
const MAX_PUBLIC_EXPORTS = 3;
const MAX_PUBLIC_BINARIES = 2;
const MAX_EXECUTABLE_ENTRYPOINT_LINES = 200;
const REVIEW_LINE_THRESHOLD = 650;
const ERROR_LINE_THRESHOLD = 800;
const ARTIFACT_COMPOSITION_OWNERS = new Set(["@skizzles/plugin-builder"]);

interface FileReview {
  owner: string;
  responsibilities: string[];
  reviewTrigger: string;
}

export async function validateWorkspaceFitness(
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): Promise<void> {
  const packagesByName = new Map(
    packages.map((item) => [item.manifest.name, item]),
  );
  validatePublicSurfaceBudgets(packages, findings);
  validateWorkspaceDependencyBins(packages, packagesByName, findings);
  validatePackageCycles(packages, packagesByName, findings);
  for (const item of packages) {
    await validateOwnedSources(item, packagesByName, findings);
  }
}

function validateWorkspaceDependencyBins(
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): void {
  const consumersByDependency = new Map<string, Set<string>>();
  for (const { manifest } of packages) {
    for (const dependency of [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ]) {
      if (!packagesByName.has(dependency)) {
        continue;
      }
      const consumers = consumersByDependency.get(dependency) ?? new Set();
      consumers.add(manifest.name);
      consumersByDependency.set(dependency, consumers);
    }
  }
  for (const item of packages) {
    if (Object.keys(item.manifest.bin).length === 0) {
      continue;
    }
    const consumers = consumersByDependency.get(item.manifest.name);
    if (consumers === undefined || consumers.size === 0) {
      continue;
    }
    addFinding(
      findings,
      "workspace-dependency-bin-linker-risk",
      item.relativeRoot,
      `${item.manifest.name} is consumed by ${[...consumers].sort().join(", ")} and must not declare bin: Bun 1.3.14 chmods dereferenced workspace binary targets during install`,
    );
  }
}

function validatePublicSurfaceBudgets(
  packages: readonly WorkspacePackage[],
  findings: WorkspaceFinding[],
): void {
  for (const { manifest, relativeRoot } of packages) {
    const exportCount = Object.keys(manifest.exports).length;
    if (exportCount > MAX_PUBLIC_EXPORTS) {
      addFinding(
        findings,
        "public-export-budget",
        relativeRoot,
        `${manifest.name} declares ${exportCount} exports; the workspace baseline permits ${MAX_PUBLIC_EXPORTS}`,
      );
    }
    const binaryCount = Object.keys(manifest.bin).length;
    if (binaryCount > MAX_PUBLIC_BINARIES) {
      addFinding(
        findings,
        "public-bin-budget",
        relativeRoot,
        `${manifest.name} declares ${binaryCount} binaries; the workspace baseline permits ${MAX_PUBLIC_BINARIES}`,
      );
    }
  }
}

function validatePackageCycles(
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): void {
  const edges = new Map<string, string[]>();
  for (const { manifest } of packages) {
    edges.set(
      manifest.name,
      [
        ...new Set([
          ...Object.keys(manifest.dependencies),
          ...Object.keys(manifest.devDependencies),
        ]),
      ]
        .filter((name) => packagesByName.has(name))
        .sort(),
    );
  }
  const complete = new Set<string>();
  const active: string[] = [];
  const activeSet = new Set<string>();
  const reported = new Set<string>();
  const visit = (name: string): void => {
    if (complete.has(name)) {
      return;
    }
    if (activeSet.has(name)) {
      const start = active.indexOf(name);
      const cycle = [...active.slice(start), name];
      const key = [...new Set(cycle)].sort().join("\0");
      if (!reported.has(key)) {
        reported.add(key);
        const owner = packagesByName.get(name);
        if (owner !== undefined) {
          addFinding(
            findings,
            "package-dependency-cycle",
            owner.relativeRoot,
            cycle.join(" -> "),
          );
        }
      }
      return;
    }
    active.push(name);
    activeSet.add(name);
    for (const dependency of edges.get(name) ?? []) {
      visit(dependency);
    }
    active.pop();
    activeSet.delete(name);
    complete.add(name);
  };
  for (const name of [...edges.keys()].sort()) {
    visit(name);
  }
}

async function validateOwnedSources(
  item: WorkspacePackage,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): Promise<void> {
  const files = (await listFiles(item.root, GENERATED_DIRECTORIES)).filter(
    (path) =>
      SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) &&
      !GENERATED_FILE_PATTERN.test(path),
  );
  const relativeFiles = files.map((path) =>
    toPortablePath(relative(item.root, path)),
  );
  if (!relativeFiles.some((path) => path.startsWith("src/"))) {
    addFinding(
      findings,
      "missing-owned-source",
      item.relativeRoot,
      "src must own at least one authored TypeScript file",
    );
  }
  if (!relativeFiles.some((path) => path.startsWith("test/"))) {
    addFinding(
      findings,
      "missing-owned-test",
      item.relativeRoot,
      "test must own at least one authored TypeScript file",
    );
  }
  const reviews = await readFileReviews(item.root, findings);
  for (const [index, sourcePath] of files.entries()) {
    const relativePath = relativeFiles[index] ?? toPortablePath(sourcePath);
    if (
      !(relativePath.startsWith("src/") || relativePath.startsWith("test/"))
    ) {
      addFinding(
        findings,
        "unowned-package-source",
        `${item.relativeRoot}/${relativePath}`,
        "authored TypeScript must be owned by src or test",
      );
    }
    const source = await readFile(sourcePath, "utf8");
    validateFileSize(item, relativePath, source, reviews, findings);
    if (relativePath.startsWith("src/")) {
      validateStaticPackagePaths(
        item,
        relativePath,
        source,
        packagesByName,
        findings,
      );
    }
  }
  await validateExecutableEntrypoints(item, findings);
}

function validateFileSize(
  item: WorkspacePackage,
  relativePath: string,
  source: string,
  reviews: ReadonlyMap<string, FileReview>,
  findings: WorkspaceFinding[],
): void {
  const lines = physicalLineCount(source);
  const findingPath = `${item.relativeRoot}/${relativePath}`;
  if (lines > ERROR_LINE_THRESHOLD) {
    addFinding(
      findings,
      "authored-file-too-large",
      findingPath,
      `${lines} physical lines exceeds the ${ERROR_LINE_THRESHOLD}-line hard maximum`,
    );
    return;
  }
  if (lines > REVIEW_LINE_THRESHOLD && !reviews.has(relativePath)) {
    addFinding(
      findings,
      "missing-file-size-review",
      findingPath,
      `${lines} physical lines requires an architecture-file-reviews.json responsibility record`,
    );
  }
}

async function validateExecutableEntrypoints(
  item: WorkspacePackage,
  findings: WorkspaceFinding[],
): Promise<void> {
  for (const [name, target] of Object.entries(item.manifest.bin)) {
    if (!SOURCE_EXTENSIONS.has(target.slice(target.lastIndexOf(".")))) {
      continue;
    }
    try {
      const lines = physicalLineCount(
        await readFile(resolve(item.root, target), "utf8"),
      );
      if (lines > MAX_EXECUTABLE_ENTRYPOINT_LINES) {
        addFinding(
          findings,
          "thick-executable-entrypoint",
          `${item.relativeRoot}/${toPortablePath(target).replace(/^\.\//u, "")}`,
          `${name} has ${lines} physical lines; executable entrypoints must stay within ${MAX_EXECUTABLE_ENTRYPOINT_LINES}`,
        );
      }
    } catch {
      // Entrypoint existence is owned by package-policy.
    }
  }
}

function validateStaticPackagePaths(
  item: WorkspacePackage,
  relativePath: string,
  source: string,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): void {
  if (ARTIFACT_COMPOSITION_OWNERS.has(item.manifest.name)) {
    return;
  }
  const reportedDirectories = new Set<string>();
  for (const match of source.matchAll(PACKAGE_PATH_PATTERN)) {
    const directory = match[1];
    if (
      directory === undefined ||
      reportedDirectories.has(directory) ||
      item.relativeRoot === `packages/${directory}`
    ) {
      continue;
    }
    const target = [...packagesByName.values()].find(
      ({ relativeRoot }) => relativeRoot === `packages/${directory}`,
    );
    if (target !== undefined) {
      reportedDirectories.add(directory);
      addFinding(
        findings,
        "hidden-package-filesystem-reach-through",
        `${item.relativeRoot}/${relativePath}`,
        `static path reaches ${target.relativeRoot} without artifact composition authority`,
      );
    }
  }
}

async function readFileReviews(
  packageRoot: string,
  findings: WorkspaceFinding[],
): Promise<ReadonlyMap<string, FileReview>> {
  const path = resolve(packageRoot, "architecture-file-reviews.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Map();
    }
    addFinding(
      findings,
      "invalid-file-size-review",
      toPortablePath(path),
      error instanceof Error ? error.message : String(error),
    );
    return new Map();
  }
  if (!(isRecord(value) && isRecord(value["files"]))) {
    addFinding(
      findings,
      "invalid-file-size-review",
      toPortablePath(path),
      "record must contain a files object",
    );
    return new Map();
  }
  const reviews = new Map<string, FileReview>();
  for (const [file, candidate] of Object.entries(value["files"])) {
    if (
      !isRecord(candidate) ||
      typeof candidate["owner"] !== "string" ||
      !stringArray(candidate["responsibilities"]) ||
      candidate["responsibilities"].length === 0 ||
      typeof candidate["reviewTrigger"] !== "string"
    ) {
      addFinding(
        findings,
        "invalid-file-size-review",
        toPortablePath(path),
        `${file} must name an owner, responsibilities, and reviewTrigger`,
      );
      continue;
    }
    reviews.set(file, {
      owner: candidate["owner"],
      responsibilities: candidate["responsibilities"],
      reviewTrigger: candidate["reviewTrigger"],
    });
  }
  return reviews;
}

function physicalLineCount(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  const content = source.endsWith("\n") ? source.slice(0, -1) : source;
  return content.split("\n").length;
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
