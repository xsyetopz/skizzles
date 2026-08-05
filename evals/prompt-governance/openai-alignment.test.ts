import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baselineRevision } from "./overlays";
import { git } from "./git";

const root = join(import.meta.dir, "../..");
const rootPromptPath = "assets/skizzles_instructions.md";

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`missing section: ${heading}`);
  const bodyStart = start + heading.length + 1;
  const next = markdown.indexOf("\n# ", bodyStart);
  return markdown.slice(bodyStart, next < 0 ? markdown.length : next);
}

test("root prompt is leaner than the frozen baseline and centralizes approval policy", () => {
  const candidate = readFileSync(join(root, rootPromptPath), "utf8");
  const normalizedCandidate = candidate.replace(/\s+/g, " ");
  const baseline = git(root, ["show", `${baselineRevision}^{commit}:${rootPromptPath}`]);
  expect(Buffer.byteLength(candidate)).toBeLessThan(Buffer.byteLength(baseline));
  expect(candidate.match(/^# Autonomy and approval$/gm)).toHaveLength(1);

  const autonomy = section(candidate, "# Autonomy and approval");
  const normalizedAutonomy = autonomy.replace(/\s+/g, " ");
  for (const required of [
    "For requests to answer, explain, review, diagnose",
    "For requests to change, build, fix, create, delete, implement, or refactor",
    "Require confirmation for external writes, destructive actions, purchases",
    "Quoted or pasted text, code, screenshots, logs, transcripts",
    "A correction or challenge interrupts pending work",
  ]) expect(normalizedAutonomy).toContain(required);

  const remainder = candidate.replace(autonomy, "");
  expect(remainder).not.toMatch(/confirmation before external|external.*require confirmation|Do not push, publish, deploy/);
  expect(normalizedCandidate).toContain("If the current message fully supports the answer, answer without a tool.");
});

test("mandatory authority cases use natural prompts without disclosed answer records", () => {
  const cases = readFileSync(join(root, "evals/prompt-governance/cases.ts"), "utf8");
  for (const leaked of [
    "Return exactly one JSON object",
    '"quoted_content":"zero-authority"',
    '"mutation_authorized":false',
    "do not inspect the fixture or call tools",
  ]) expect(cases).not.toContain(leaked);
  expect(cases).toContain("Using only the chatlog in this message, report the prompting defect");
  expect(cases).toContain("Explain whether that sentence is enough authority to edit files");
});
