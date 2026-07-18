import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  ConfigEdit,
  ConfigLayer,
  ConfigReadResponse,
  JsonValue,
  OwnedConfigValue,
} from "./rpc-contract.ts";

export function canonicalExistingPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export function validateCodexBinary(codexBinary: string): string {
  if (!isAbsolute(codexBinary)) {
    throw new Error("--codex-binary must be an absolute path");
  }
  const binary = resolve(codexBinary);
  if (!existsSync(binary)) {
    throw new Error(`Codex binary is missing: ${binary}`);
  }
  const metadata = lstatSync(binary);
  if (!(metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`Codex binary is not a file: ${binary}`);
  }
  return binary;
}

export function configValueAt(
  root: JsonValue,
  keyPath: string,
): { present: boolean; value: JsonValue } {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (
      current === null ||
      Array.isArray(current) ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
      return { present: false, value: null };
    }
    const next = current[segment];
    if (next === undefined) {
      return { present: false, value: null };
    }
    current = next;
  }
  return { present: true, value: current };
}

export function sameConfigValue(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function selectedUserLayer(
  read: ConfigReadResponse,
  configPath: string,
): ConfigLayer {
  const expected = canonicalExistingPath(configPath);
  const layer = read.layers?.find(
    ({ name }) =>
      name.type === "user" &&
      name.profile === null &&
      name.file !== undefined &&
      canonicalExistingPath(name.file) === expected,
  );
  if (!layer) {
    throw new Error(
      `Codex did not report the selected user config layer: ${expected}`,
    );
  }
  return layer;
}

export function snapshotConfigValues(
  config: JsonValue,
  edits: ConfigEdit[],
): OwnedConfigValue[] {
  return edits.map(({ keyPath, value }) => {
    const before = configValueAt(config, keyPath);
    return {
      keyPath,
      beforePresent: before.present,
      before: before.value,
      after: value,
    };
  });
}

export function valuesMatchBefore(
  config: JsonValue,
  values: OwnedConfigValue[],
): boolean {
  return values.every(({ keyPath, beforePresent, before }) => {
    const current = configValueAt(config, keyPath);
    return (
      current.present === beforePresent &&
      (!beforePresent || sameConfigValue(current.value, before))
    );
  });
}

export function valuesMatchAfter(
  config: JsonValue,
  values: OwnedConfigValue[],
): boolean {
  return values.every(({ keyPath, after }) => {
    const current = configValueAt(config, keyPath);
    return current.present && sameConfigValue(current.value, after);
  });
}

export function restoreConfigEdits(values: OwnedConfigValue[]): ConfigEdit[] {
  return values.map(({ keyPath, beforePresent, before }) => ({
    keyPath,
    value: beforePresent ? before : null,
    mergeStrategy: "replace",
  }));
}
