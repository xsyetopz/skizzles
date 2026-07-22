import { relative, sep } from "node:path";
import type {
  RunWorkspace,
  WorkspaceUsageLimits,
} from "@skizzles/run-workspace";
import { digestValue } from "../../../digest.ts";
import type { CommandDependencyReceipt } from "../../contract.ts";
import { copyTrustedTree } from "../tree/materialization.ts";
import { type MutableStage, pathInRoot } from "../tree/state.ts";
import { createInternalLink } from "../tree/writer.ts";
import {
  containedBy,
  type PackageManifest,
  readPackageManifest,
  validPackageName,
} from "./package-input.ts";
import {
  type DependencyBoundary,
  findDependencyBoundary,
  resolveDependency,
} from "./resolution.ts";

const excludedPackageDirectories = new Set([".git", "node_modules"]);

interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
  readonly realRoot: string;
  readonly kind: "external" | "workspace";
  readonly destinationPath: string;
  readonly destinationRoot: string;
  readonly manifest: PackageManifest;
  direct: boolean;
}

interface ResolutionEdge {
  readonly from: string;
  readonly dependency: string;
  readonly to: string;
}

interface ClosureInput {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly dependencyPackages: readonly string[];
  readonly stage: MutableStage;
  readonly workspace: RunWorkspace;
  readonly limits: WorkspaceUsageLimits;
}

export interface DependencyStage {
  readonly dependencies: readonly CommandDependencyReceipt[];
  readonly dependencyDigest: ReturnType<typeof digestValue>;
}

export async function stageDependencyClosure(
  input: ClosureInput,
): Promise<DependencyStage | undefined> {
  if (input.dependencyPackages.length === 0) return emptyClosure();
  const roots = normalizedRoots(input.dependencyPackages);
  const boundary = await findDependencyBoundary(input.sourceRoot);
  if (roots === undefined || boundary === undefined) return;
  const builder = new ClosureBuilder(input, boundary);
  if (!(await builder.stageRoots(roots))) return;
  if (!(await builder.stageTransitiveDependencies())) return;
  return builder.receipt(roots);
}

class ClosureBuilder {
  readonly #queue: ResolvedPackage[] = [];
  readonly #packages = new Map<string, ResolvedPackage>();
  readonly #edges: ResolutionEdge[] = [];
  readonly #input: ClosureInput;
  readonly #boundary: DependencyBoundary;
  #sequence = 0;

  constructor(input: ClosureInput, boundary: DependencyBoundary) {
    this.#input = input;
    this.#boundary = boundary;
  }

  async stageRoots(roots: readonly string[]): Promise<boolean> {
    for (const name of roots) {
      const dependency = await this.discover(
        name,
        this.#input.sourceRoot,
        true,
      );
      if (
        dependency === undefined ||
        !(await this.link(`node_modules/${name}`, dependency.destinationRoot))
      ) {
        return false;
      }
    }
    return true;
  }

  async stageTransitiveDependencies(): Promise<boolean> {
    for (let index = 0; index < this.#queue.length; index += 1) {
      const owner = this.#queue[index];
      if (owner === undefined) return false;
      for (const declaration of owner.manifest.dependencies) {
        const dependency = await this.discover(
          declaration.name,
          owner.realRoot,
          false,
        );
        if (dependency === undefined) {
          if (declaration.optional) continue;
          return false;
        }
        const linkPath = `${owner.destinationPath}/node_modules/${declaration.name}`;
        if (!(await this.link(linkPath, dependency.destinationRoot))) {
          return false;
        }
        this.#edges.push(
          Object.freeze({
            from: packageIdentity(owner),
            dependency: declaration.name,
            to: packageIdentity(dependency),
          }),
        );
      }
    }
    return true;
  }

  receipt(roots: readonly string[]): DependencyStage {
    const dependencies = Object.freeze(
      [...this.#packages.values()]
        .map((dependency) =>
          Object.freeze({
            name: dependency.name,
            version: dependency.version,
            kind: dependency.kind,
            direct: dependency.direct,
            packageDigest: digestPackage(
              this.#input.stage,
              dependency.destinationPath,
            ),
          }),
        )
        .sort((left, right) =>
          packageReceiptIdentity(left).localeCompare(
            packageReceiptIdentity(right),
          ),
        ),
    );
    const edges = Object.freeze(
      this.#edges.sort((left, right) =>
        `${left.from}\0${left.dependency}\0${left.to}`.localeCompare(
          `${right.from}\0${right.dependency}\0${right.to}`,
        ),
      ),
    );
    return Object.freeze({
      dependencies,
      dependencyDigest: digestValue({ roots, packages: dependencies, edges }),
    });
  }

  private async discover(
    name: string,
    fromDirectory: string,
    direct: boolean,
  ): Promise<ResolvedPackage | undefined> {
    const resolution = await resolveDependency(
      name,
      fromDirectory,
      this.#boundary,
    );
    if (resolution === undefined) return;
    const existing = this.#packages.get(resolution.realRoot);
    if (existing !== undefined) {
      if (existing.name !== name) return;
      existing.direct ||= direct;
      return existing;
    }
    const manifest = await readPackageManifest(resolution.realRoot, name);
    if (manifest === undefined) return;
    const destinationPath = this.allocateDestination(
      resolution.realRoot,
      resolution.kind,
      name,
    );
    if (destinationPath === undefined) return;
    if (
      !usesRepositoryCopy(
        this.#input.sourceRoot,
        resolution.realRoot,
        resolution.kind,
      ) &&
      !(await copyTrustedTree({
        sourceRoot: resolution.realRoot,
        destinationRoot: this.#input.destinationRoot,
        destinationPath,
        stage: this.#input.stage,
        workspace: this.#input.workspace,
        limits: this.#input.limits,
        excludedDirectories: excludedPackageDirectories,
      }))
    ) {
      return;
    }
    const created: ResolvedPackage = {
      name,
      version: manifest.version,
      realRoot: resolution.realRoot,
      kind: resolution.kind,
      destinationPath,
      destinationRoot: pathInRoot(this.#input.destinationRoot, destinationPath),
      manifest,
      direct,
    };
    this.#packages.set(resolution.realRoot, created);
    this.#queue.push(created);
    return created;
  }

  private allocateDestination(
    realRoot: string,
    kind: "external" | "workspace",
    name: string,
  ): string | undefined {
    if (usesRepositoryCopy(this.#input.sourceRoot, realRoot, kind)) {
      return portableRelative(this.#input.sourceRoot, realRoot);
    }
    const sequence = this.#sequence.toString().padStart(4, "0");
    this.#sequence += 1;
    return `.skizzles-dependencies/${sequence}/node_modules/${name}`;
  }

  private link(path: string, destination: string): Promise<boolean> {
    return createInternalLink({
      root: this.#input.destinationRoot,
      path,
      resolvedPath: destination,
      stage: this.#input.stage,
      workspace: this.#input.workspace,
      limits: this.#input.limits,
    });
  }
}

function usesRepositoryCopy(
  sourceRoot: string,
  packageRoot: string,
  kind: "external" | "workspace",
): boolean {
  return kind === "workspace" && containedBy(sourceRoot, packageRoot);
}

function emptyClosure(): DependencyStage {
  return Object.freeze({
    dependencies: Object.freeze([]),
    dependencyDigest: digestValue({ roots: [], packages: [], edges: [] }),
  });
}

function normalizedRoots(
  dependencies: readonly string[],
): readonly string[] | undefined {
  const roots = [...new Set(dependencies)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    roots.length !== dependencies.length ||
    roots.some((name) => !validPackageName(name))
  ) {
    return;
  }
  return Object.freeze(roots);
}

function digestPackage(stage: MutableStage, packagePath: string) {
  const prefix = `${packagePath}/`;
  return digestValue(
    [...stage.files.values()]
      .filter((file) => file.path.startsWith(prefix))
      .map((file) =>
        Object.freeze({
          path: file.path.slice(prefix.length),
          digest: file.digest,
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
}

function packageIdentity(value: ResolvedPackage): string {
  return `${value.name}@${value.version}:${value.destinationPath}`;
}

function packageReceiptIdentity(value: CommandDependencyReceipt): string {
  return `${value.name}\0${value.version}\0${value.packageDigest}`;
}

function portableRelative(root: string, path: string): string | undefined {
  const result = relative(root, path).split(sep).join("/");
  if (result === "" || result === ".." || result.startsWith("../")) return;
  return result;
}
