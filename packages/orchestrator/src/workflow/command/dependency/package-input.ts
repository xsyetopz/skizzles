import { lstat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { readTrustedFile } from "../tree/file-io.ts";

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const maximumManifestBytes = 1_000_000n;

export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly DependencyDeclaration[];
}

export interface DependencyDeclaration {
  readonly name: string;
  readonly optional: boolean;
}

export function validPackageName(value: string): boolean {
  return packageNamePattern.test(value);
}

export async function readPackageManifest(
  root: string,
  expectedName: string,
): Promise<PackageManifest | undefined> {
  const value = await readJson(join(root, "package.json"));
  if (
    value === undefined ||
    value["name"] !== expectedName ||
    typeof value["version"] !== "string" ||
    value["version"].length === 0
  ) {
    return;
  }
  const required = dependencyNames(value["dependencies"], false);
  const optional = dependencyNames(value["optionalDependencies"], true);
  const peers = peerDependencyNames(
    value["peerDependencies"],
    value["peerDependenciesMeta"],
  );
  if (required === undefined || optional === undefined || peers === undefined) {
    return;
  }
  const declarations = new Map<string, boolean>();
  for (const dependency of [...required, ...peers, ...optional]) {
    const existing = declarations.get(dependency.name);
    declarations.set(
      dependency.name,
      existing === undefined
        ? dependency.optional
        : existing && dependency.optional,
    );
  }
  return Object.freeze({
    name: expectedName,
    version: value["version"],
    dependencies: Object.freeze(
      [...declarations]
        .map(([name, isOptional]) =>
          Object.freeze({ name, optional: isOptional }),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  });
}

export async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (stat.size > maximumManifestBytes) return;
    const bytes = await readTrustedFile(path, stat);
    if (bytes === undefined) return;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return record(value) ? value : undefined;
  } catch {
    return;
  }
}

export function containedBy(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  );
}

function dependencyNames(
  value: unknown,
  optional: boolean,
): readonly DependencyDeclaration[] | undefined {
  if (value === undefined) return Object.freeze([]);
  if (!record(value)) return;
  const dependencies: DependencyDeclaration[] = [];
  for (const [name, version] of Object.entries(value)) {
    if (!validPackageName(name) || typeof version !== "string") return;
    dependencies.push(Object.freeze({ name, optional }));
  }
  return Object.freeze(dependencies);
}

function peerDependencyNames(
  value: unknown,
  metadata: unknown,
): readonly DependencyDeclaration[] | undefined {
  const peers = dependencyNames(value, false);
  if (peers === undefined) return;
  if (metadata !== undefined && !record(metadata)) return;
  return Object.freeze(
    peers.map((peer) => {
      const entry = record(metadata) ? metadata[peer.name] : undefined;
      const optional = record(entry) && entry["optional"] === true;
      return Object.freeze({ name: peer.name, optional });
    }),
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
