import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  BUNDLED_ENTRYPOINTS,
  INSTALLER_CANONICAL_SOURCE_PATH,
  INSTALLER_PUBLIC_USAGE_PREFIX,
  PackagingError,
  RELATIVE_MODULE_PATTERN,
  WORKSPACE_MODULE_PATTERN,
} from "./contract.ts";
import { listFiles, readJsonObject } from "./distribution-files.ts";
import { runInstallerHelp } from "./runtime-process.ts";
import type { PluginWorkspace } from "./workspace.ts";

export async function bundleCanonicalEntrypoints(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  for (const entrypoint of BUNDLED_ENTRYPOINTS) {
    await bundleCanonicalEntrypoint(repoRoot, pluginRoot, entrypoint);
  }
}

export async function validatePackagedInstaller(
  repoRoot: string,
  pluginRoot: string,
  workspace: PluginWorkspace,
): Promise<void> {
  await writeInstallerRuntimeManifest(repoRoot, pluginRoot);
  await validatePackagedInstallerSurface(pluginRoot);
  await validateInstallerCliHelp(
    join(pluginRoot, "packages/installer"),
    workspace,
  );
}

async function bundleCanonicalEntrypoint(
  repoRoot: string,
  pluginRoot: string,
  entrypoint: (typeof BUNDLED_ENTRYPOINTS)[number],
): Promise<void> {
  const packageRootPath = join(repoRoot, entrypoint.packageRoot);
  const sourcePath = join(repoRoot, entrypoint.source);
  await assertContainedNonSymlinkFile(packageRootPath, sourcePath);
  const packageRoot = await realpath(packageRootPath);
  const source = await realpath(sourcePath);
  const buildConfig: Bun.BuildConfig & { write: false } = {
    entrypoints: [source],
    format: "esm",
    packages: "bundle",
    plugins: [packageContainmentPlugin(packageRoot, entrypoint.label)],
    target: "bun",
    throw: false,
    write: false,
  };
  const result = await Bun.build(buildConfig);
  const output = result.outputs[0];
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    const diagnostics = result.logs.map((log) => log.message).join("; ");
    throw new PackagingError(
      `Unable to create the dependency-self-contained ${entrypoint.label} bundle${
        diagnostics === "" ? "." : `: ${diagnostics}`
      }`,
    );
  }
  const destination = join(pluginRoot, entrypoint.destination);
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(destination, output);
  await chmod(destination, 0o644);
}

function packageContainmentPlugin(
  packageRoot: string,
  label: string,
): Bun.BunPlugin {
  return {
    name: `${label.replaceAll(" ", "-")}-runtime-containment`,
    setup(build) {
      build.onResolve(
        { filter: RELATIVE_MODULE_PATTERN },
        async ({ path, resolveDir }) => {
          if (!isContainedPath(packageRoot, resolveDir)) {
            return;
          }
          const resolvedPath = Bun.resolveSync(path, resolveDir);
          await assertContainedNonSymlinkFile(packageRoot, resolvedPath);
          return { path: resolvedPath };
        },
      );
      build.onResolve(
        { filter: WORKSPACE_MODULE_PATTERN },
        async ({ path, resolveDir }) => {
          if (!isContainedPath(packageRoot, resolveDir)) {
            return;
          }
          return {
            path: await resolveDeclaredWorkspaceExport(packageRoot, path),
          };
        },
      );
    },
  };
}

async function resolveDeclaredWorkspaceExport(
  packageRoot: string,
  specifier: string,
): Promise<string> {
  const [scope, name, ...subpath] = specifier.split("/");
  const dependencyName = `${scope}/${name}`;
  const packageManifest = await readJsonObject(
    join(packageRoot, "package.json"),
    "bundled workspace package manifest",
  );
  const dependencies = packageManifest["dependencies"];
  if (
    !isObject(dependencies) ||
    dependencies[dependencyName] !== "workspace:*"
  ) {
    throw new PackagingError(
      `Bundled workspace package imports undeclared dependency ${dependencyName}.`,
    );
  }

  let dependencyRoot: string;
  try {
    dependencyRoot = await realpath(
      join(packageRoot, "node_modules", scope ?? "", name ?? ""),
    );
  } catch {
    throw new PackagingError(
      `Declared workspace dependency ${dependencyName} is not installed.`,
    );
  }
  const dependencyManifest = await readJsonObject(
    join(dependencyRoot, "package.json"),
    `${dependencyName} package manifest`,
  );
  const exportName = subpath.length === 0 ? "." : `./${subpath.join("/")}`;
  const exports = dependencyManifest["exports"];
  const target =
    typeof exports === "string" && exportName === "."
      ? exports
      : isObject(exports)
        ? exports[exportName]
        : undefined;
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new PackagingError(
      `${dependencyName} does not export ${exportName} as a source path.`,
    );
  }
  const resolvedPath = resolve(dependencyRoot, target);
  await assertContainedNonSymlinkFile(dependencyRoot, resolvedPath);
  return resolvedPath;
}

function isContainedPath(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return !(
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeInstallerRuntimeManifest(
  repoRoot: string,
  pluginRoot: string,
): Promise<void> {
  const source = await readJsonObject(
    join(repoRoot, "packages/installer/package.json"),
    "installer package manifest",
  );
  const name = source["name"];
  const version = source["version"];
  if (
    name !== "@skizzles/installer" ||
    typeof version !== "string" ||
    source["type"] !== "module"
  ) {
    throw new PackagingError(
      "Installer package manifest must identify the private ESM workspace package.",
    );
  }
  const destination = join(pluginRoot, "packages/installer/package.json");
  await mkdir(dirname(destination), { recursive: true });
  await Bun.write(
    destination,
    `${JSON.stringify(
      { name, version, private: true, type: "module" },
      null,
      2,
    )}\n`,
  );
}

async function validatePackagedInstallerSurface(
  pluginRoot: string,
): Promise<void> {
  const files = await listFiles(join(pluginRoot, "packages/installer"));
  const expected = ["package.json", "src/cli.ts"];
  if (
    files.length !== expected.length ||
    expected.some((path, index) => files[index] !== path)
  ) {
    throw new PackagingError(
      "Packaged installer runtime must contain exactly package.json and src/cli.ts.",
    );
  }
}

async function validateInstallerCliHelp(
  installerRoot: string,
  workspace: PluginWorkspace,
): Promise<void> {
  const { exitCode, stderr, stdout } = await runInstallerHelp(
    installerRoot,
    workspace,
  );
  if (
    exitCode !== 2 ||
    stdout.overflow ||
    stdout.text !== "" ||
    stderr.overflow ||
    !stderr.text.startsWith(INSTALLER_PUBLIC_USAGE_PREFIX) ||
    stderr.text.includes(INSTALLER_CANONICAL_SOURCE_PATH)
  ) {
    throw installerValidationError();
  }
}

function installerValidationError(): PackagingError {
  return new PackagingError("Packaged installer runtime validation failed.");
}

async function assertContainedNonSymlinkFile(
  packageRoot: string,
  resolvedPath: string,
): Promise<void> {
  const lexicalRoot = resolve(packageRoot);
  const target = resolve(resolvedPath);
  const relativePath = relative(lexicalRoot, target);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(lexicalRoot, relativePath) !== target
  ) {
    throw new PackagingError(
      "Resolved package import escapes its source root.",
    );
  }
  const root = await realpath(lexicalRoot);
  let current = lexicalRoot;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new PackagingError("Resolved package import uses a symlink.");
    }
    const currentRealPath = await realpath(current);
    const currentRelativePath = relative(root, currentRealPath);
    if (
      currentRelativePath === ".." ||
      currentRelativePath.startsWith(`..${sep}`)
    ) {
      throw new PackagingError(
        "Resolved package import escapes its source root.",
      );
    }
  }
  if (!(await lstat(target)).isFile()) {
    throw new PackagingError("Resolved package import is not a file.");
  }
}
