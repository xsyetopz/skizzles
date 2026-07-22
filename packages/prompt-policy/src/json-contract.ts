import { PromptLayerError } from "./lifecycle/contract.ts";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PromptLayerError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertKeys(
  object: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new PromptLayerError(`${label} has missing or unsupported fields.`);
  }
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PromptLayerError(`${label} must be a string.`);
  }
  return value;
}

export function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new PromptLayerError(`${label} must be a number.`);
  }
  return value;
}
