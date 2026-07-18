import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathEntryExists } from "../managed-files.ts";

export function ensurePrivateDirectory(path: string): void {
  if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `refusing to manage through a symlinked directory: ${path}`,
    );
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writePrivateJson(
  path: string,
  value: unknown,
  exclusive = false,
): void {
  ensurePrivateDirectory(dirname(path));
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`invalid ${label}: ${path}`);
  }
}
