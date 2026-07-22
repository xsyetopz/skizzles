import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requiredTestArray, requiredTestRecord } from "../plugin/fixture.ts";

export async function mutateJson(
  root: string,
  relativePath: string,
  mutation: (document: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(root, relativePath);
  const document = requiredTestRecord(
    JSON.parse(await readFile(path, "utf8")),
    relativePath,
  );
  mutation(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

export async function replaceRaw(
  root: string,
  relativePath: string,
  expected: string,
  replacement: string,
): Promise<void> {
  const path = join(root, relativePath);
  const source = await readFile(path, "utf8");
  if (!source.includes(expected)) {
    throw new Error(`Missing raw fixture fragment in ${relativePath}.`);
  }
  await writeFile(path, source.replace(expected, replacement));
}

export function corpusCase(
  corpus: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const cases = requiredTestArray(corpus["cases"], "cases");
  return requiredTestRecord(cases[index], `case ${index}`);
}

export function objectAt(
  root: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  let current = root;
  for (const segment of path.split(".")) {
    current = requiredTestRecord(current[segment], path);
  }
  return current;
}

export async function rejectionMessage(
  operation: Promise<void>,
): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to reject.");
}
