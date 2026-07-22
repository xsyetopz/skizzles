import { createHash } from "node:crypto";

const targetPath = "test/value.test.ts";
const secondTargetPath = "test/second.test.ts";
const baseline = "export function value(): number { return 1; }\n";
const secondBaseline = "export function second(): number { return 1; }\n";
const replacement = "export function value(): number { return 2; }";
const secondReplacement = "export function second(): number { return 2; }";
const candidate = `${replacement}\n`;
const secondCandidate = `${secondReplacement}\n`;
const schemaText = "A complete TypeScript function declaration.";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function baselineFor(path: string) {
  if (path === targetPath) {
    return baseline;
  }
  return secondBaseline;
}

function candidateFor(path: string) {
  if (path === targetPath) {
    return candidate;
  }
  return secondCandidate;
}

function replacementFor(path: string) {
  if (path === targetPath) {
    return replacement;
  }
  return secondReplacement;
}

function functionNameFor(path: string) {
  if (path === targetPath) {
    return "value";
  }
  return "second";
}

export {
  baselineFor,
  candidate,
  candidateFor,
  digest,
  functionNameFor,
  replacement,
  replacementFor,
  schemaText,
  secondTargetPath,
  targetPath,
};
