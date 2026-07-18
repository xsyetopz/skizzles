import { readFile } from "node:fs/promises";
import { AgentContractPackageError } from "./contract.ts";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export async function readJsonAsset(
  path: string,
  label: string,
): Promise<{ bytes: Buffer; value: JsonValue }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new AgentContractPackageError(
      `${label} is missing or unreadable: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as JsonValue };
  } catch (error) {
    throw new AgentContractPackageError(
      `${label} is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function assertRecord(
  value: JsonValue | undefined,
  label: string,
): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentContractPackageError(`${label} must be an object.`);
  }
  return value;
}

export function assertArray(
  value: JsonValue | undefined,
  label: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new AgentContractPackageError(`${label} must be an array.`);
  }
  return value;
}

export function assertString(
  value: JsonValue | undefined,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new AgentContractPackageError(`${label} must be a string.`);
  }
  return value;
}

export function assertInteger(
  value: JsonValue | undefined,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AgentContractPackageError(`${label} must be an integer.`);
  }
  return value;
}

export function assertBoolean(
  value: JsonValue | undefined,
  label: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new AgentContractPackageError(`${label} must be a boolean.`);
  }
  return value;
}

export function assertExactKeys(
  record: Record<string, JsonValue>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort(compareCodeUnits);
  const sortedExpected = [...expected].sort(compareCodeUnits);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new AgentContractPackageError(
      `${label} must contain exactly ${sortedExpected.join(", ")}.`,
    );
  }
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => {
        const member = value[key];
        if (member === undefined) {
          throw new AgentContractPackageError(
            `Canonical JSON object member ${key} is undefined.`,
          );
        }
        return `${JSON.stringify(key)}:${canonicalJson(member)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
