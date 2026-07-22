import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { WorkspacePackage } from "../contract.ts";
import { listFiles } from "../filesystem.ts";
import type { SourceDocument } from "./parser.ts";

interface OwnedSource {
  document: SourceDocument;
  item: WorkspacePackage;
  relativePath: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IMPORT_DISCOVERY_EXCLUSIONS = new Set(["dist", "node_modules", "vendor"]);
const GENERATED_FILE_PATTERN = /(?:\.d|\.gen|\.generated)\.ts$/u;
const PATH_SEPARATOR_PATTERN = /[\\/]/u;

async function discoverOwnedSources(
  packages: readonly WorkspacePackage[],
): Promise<OwnedSource[]> {
  const byPackage = await Promise.all(
    packages.map(async (item) => {
      const files = await listFiles(item.root, IMPORT_DISCOVERY_EXCLUSIONS);
      const eligible = files.filter((path) => {
        const relativePath = relative(item.root, path);
        return (
          SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))) &&
          !isGeneratedOwnership(relativePath)
        );
      });
      return Promise.all(
        eligible.map(
          async (path): Promise<OwnedSource> => ({
            document: {
              path,
              source: await readFile(path),
              loader: sourceLoader(path),
            },
            item,
            relativePath: toPortablePath(relative(item.root, path)),
          }),
        ),
      );
    }),
  );
  return byPackage.flat();
}

function isGeneratedOwnership(path: string): boolean {
  return (
    path.split(PATH_SEPARATOR_PATTERN).includes("generated") ||
    GENERATED_FILE_PATTERN.test(path)
  );
}

function toPortablePath(path: string): string {
  return path.split(PATH_SEPARATOR_PATTERN).join("/");
}

function sourceLoader(path: string): "ts" | "tsx" {
  if (path.endsWith(".tsx")) {
    return "tsx";
  }
  return "ts";
}

export { discoverOwnedSources, isGeneratedOwnership, type OwnedSource };
