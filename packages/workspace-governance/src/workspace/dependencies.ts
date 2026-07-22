import {
  addFinding,
  type PackageManifest,
  type WorkspaceFinding,
  type WorkspaceManifest,
  type WorkspacePackage,
} from "./contract.ts";

const TOOL_DEPENDENCIES = ["@types/bun", "@types/node", "typescript"] as const;

function dependencyMaps(
  manifest: PackageManifest,
): readonly Record<string, string>[] {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
}

function dependencyNames(manifest: PackageManifest): readonly string[] {
  return [
    ...new Set(dependencyMaps(manifest).flatMap((item) => Object.keys(item))),
  ].sort();
}

function hasRuntimeDependency(
  manifest: PackageManifest,
  dependency: string,
): boolean {
  return (
    dependency in manifest.dependencies ||
    dependency in manifest.optionalDependencies ||
    dependency in manifest.peerDependencies
  );
}

function validatePackageDependencies(
  relativeRoot: string,
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): void {
  if (dependencyNames(manifest).includes("@biomejs/biome")) {
    addFinding(
      findings,
      "local-biome-dependency",
      relativeRoot,
      "Biome must not be installed as a workspace dependency",
    );
  }
  for (const dependency of TOOL_DEPENDENCIES) {
    if (
      !(
        dependency in manifest.dependencies ||
        dependency in manifest.devDependencies
      )
    ) {
      addFinding(
        findings,
        "missing-tool-dependency",
        relativeRoot,
        `missing direct ${dependency} dependency`,
      );
    }
  }
  for (const dependency of dependencyNames(manifest)) {
    const owners = dependencyMaps(manifest).filter(
      (dependencies) => dependency in dependencies,
    ).length;
    if (owners > 1) {
      addFinding(
        findings,
        "duplicate-dependency-metadata",
        relativeRoot,
        `${dependency} must be declared in exactly one dependency map`,
      );
    }
  }
  for (const dependency of ["@types/bun", "@types/node"] as const) {
    if (
      dependency in manifest.dependencies ||
      dependency in manifest.optionalDependencies ||
      dependency in manifest.peerDependencies
    ) {
      addFinding(
        findings,
        "runtime-dev-tool",
        relativeRoot,
        `${dependency} is compile-time tooling and must be a development dependency`,
      );
    }
  }
}

function validateRootDependencyPolicy(
  manifest: PackageManifest,
  findings: WorkspaceFinding[],
): void {
  if (Object.keys(manifest.dependencies).length > 0) {
    addFinding(
      findings,
      "root-runtime-dependency",
      "package.json",
      "the orchestration root must not own runtime dependencies",
    );
  }
  if (Object.keys(manifest.optionalDependencies).length > 0) {
    addFinding(
      findings,
      "root-optional-dependency",
      "package.json",
      "the orchestration root must not own optional dependencies",
    );
  }
  if (Object.keys(manifest.peerDependencies).length > 0) {
    addFinding(
      findings,
      "root-peer-dependency",
      "package.json",
      "the orchestration root must not own peer dependencies",
    );
  }
}

function validateWorkspaceDependencyRanges(
  rootManifest: WorkspaceManifest,
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  findings: WorkspaceFinding[],
): void {
  const consumers = [
    { manifest: rootManifest, path: "package.json" },
    ...packages.map(({ manifest, relativeRoot }) => ({
      manifest,
      path: relativeRoot,
    })),
  ];
  for (const consumer of consumers) {
    const invalid = new Set<string>();
    for (const dependencies of dependencyMaps(consumer.manifest)) {
      for (const [name, range] of Object.entries(dependencies)) {
        if (packagesByName.has(name) && range !== "workspace:*") {
          invalid.add(name);
        }
      }
    }
    for (const name of [...invalid].sort()) {
      addFinding(
        findings,
        "workspace-range",
        consumer.path,
        `${name} must use workspace:*`,
      );
    }
  }
}

export {
  dependencyNames,
  hasRuntimeDependency,
  validatePackageDependencies,
  validateRootDependencyPolicy,
  validateWorkspaceDependencyRanges,
};
