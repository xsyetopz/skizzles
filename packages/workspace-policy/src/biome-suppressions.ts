import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

const forbiddenSuppression = /^\s*\/\/\s*biome-ignore\s+\S+:\s*.*$/u;
const lineBreak = /\r?\n/u;
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);

function findLineSuppressions(
  source: string,
  path: string,
  workspaceRoot: string,
): string[] {
  const findings: string[] = [];
  for (const [index, line] of source.split(lineBreak).entries()) {
    if (forbiddenSuppression.test(line)) {
      findings.push(
        `${relative(workspaceRoot, path)}:${index + 1}:${line.trim()}`,
      );
    }
  }
  return findings;
}

async function findSuppressions(
  directory: string,
  workspaceRoot: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const directories = entries
    .filter(
      (entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name),
    )
    .map((entry) => join(directory, entry.name));
  const directoryFindings = await Promise.all(
    directories.map((child) => findSuppressions(child, workspaceRoot)),
  );

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name));
  const fileFindings = await Promise.all(
    files.map(async (path) => {
      const source = await readFile(path, "utf8");
      return findLineSuppressions(source, path, workspaceRoot);
    }),
  );
  return [...directoryFindings.flat(), ...fileFindings.flat()];
}

const root = process.cwd();
const findings = (await findSuppressions(root, root)).sort((left, right) =>
  left.localeCompare(right),
);

if (findings.length > 0) {
  console.error(
    `Forbidden single-line Biome suppressions found (${findings.length}):`,
  );
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log("Biome suppression check passed: no forbidden directives found.");
}
