import { readdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "./contract.ts";

const MAX_AUTHORED_FILES_PER_DIRECTORY = 10;
const EXCLUDED_DIRECTORIES = new Set([
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);

/** Enforce the navigation limit for every authored package directory. */
export async function validatePackageDirectoryFileCounts(
  item: WorkspacePackage,
  findings: WorkspaceFinding[],
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const fileCount = entries.filter((entry) => entry.isFile()).length;
    if (fileCount > MAX_AUTHORED_FILES_PER_DIRECTORY) {
      addFinding(
        findings,
        "directory-file-limit",
        `${item.relativeRoot}/${toPortablePath(relative(item.root, directory))}`,
        `directory contains ${fileCount} authored files; maximum is ${MAX_AUTHORED_FILES_PER_DIRECTORY}`,
      );
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name),
        )
        .map((entry) => visit(`${directory}/${entry.name}`)),
    );
  };

  await visit(item.root);
}

function toPortablePath(path: string): string {
  const normalized = path.split(sep).join("/");
  return normalized === "" ? "." : normalized;
}
