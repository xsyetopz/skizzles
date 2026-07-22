import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: TypeScript 7's parser is an unstable package export.
import { API } from "typescript/unstable/async";
import {
  analyzeSourcePolicy,
  createLiteralRegistry,
  type LiteralRegistrySnapshot,
  type ParsedPolicyChange,
  type PolicyAnalysisInput,
  type PolicyFinding,
  type PolicyFindingCode,
} from "../../../src/policy/index.ts";

export interface LiteralSourceCase {
  readonly path: string;
  readonly ownership: "production" | "test";
  readonly baseline?: string;
  readonly candidate: string;
}

interface ParsedDocument {
  readonly sourceCase: LiteralSourceCase;
  readonly candidatePath: string;
  readonly baselinePath?: string;
}

export async function analyzeLiteralCases(
  cases: readonly LiteralSourceCase[],
  faultFirst: PolicyAnalysisInput["faultFirst"],
  literalRegistry: LiteralRegistrySnapshot = registeredSnapshot([]),
): Promise<readonly PolicyFinding[]> {
  const root = mkdtempSync(join(tmpdir(), "skizzles-literal-policy-"));
  const api = new API();
  try {
    const documents = cases.map((sourceCase, index) =>
      writeDocument(root, sourceCase, index),
    );
    const openFiles = documents.flatMap(({ candidatePath, baselinePath }) =>
      baselinePath === undefined
        ? [candidatePath]
        : [candidatePath, baselinePath],
    );
    const snapshot = await api.updateSnapshot({ openFiles });
    try {
      const changes = await Promise.all(
        documents.map(async ({ sourceCase, candidatePath, baselinePath }) => ({
          path: sourceCase.path,
          ownership: sourceCase.ownership,
          baselineText: sourceCase.baseline ?? null,
          baseline:
            baselinePath === undefined
              ? null
              : await sourceFile(snapshot, baselinePath),
          candidateText: sourceCase.candidate,
          candidate: await sourceFile(snapshot, candidatePath),
        })),
      );
      return analyzeSourcePolicy({ changes, faultFirst, literalRegistry });
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
    rmSync(root, { force: true, recursive: true });
  }
}

export function registeredSnapshot(
  entries: readonly Readonly<{
    key: string;
    value: string | number;
    description: string;
  }>[],
): LiteralRegistrySnapshot {
  const created = createLiteralRegistry(
    Object.freeze({
      registryId: "source-parameters",
      registryPath: "src/config/parameters.ts",
      exportName: "SOURCE_PARAMETERS",
    }),
  );
  if (created.status !== "created") throw new Error(created.code);
  let snapshot = created.registry.snapshot();
  for (const entry of entries) {
    const registered = created.registry.register(Object.freeze(entry));
    if (registered.status !== "registered") throw new Error(registered.code);
    snapshot = registered.snapshot;
  }
  return snapshot;
}

export function findingCodes(
  findings: readonly PolicyFinding[],
): PolicyFindingCode[] {
  return findings.map(({ code }) => code);
}

function writeDocument(
  root: string,
  sourceCase: LiteralSourceCase,
  index: number,
): ParsedDocument {
  const candidatePath = join(root, `${index}-candidate.ts`);
  writeFileSync(candidatePath, sourceCase.candidate);
  if (sourceCase.baseline === undefined) return { sourceCase, candidatePath };
  const baselinePath = join(root, `${index}-baseline.ts`);
  writeFileSync(baselinePath, sourceCase.baseline);
  return { sourceCase, candidatePath, baselinePath };
}

async function sourceFile(
  snapshot: Awaited<ReturnType<API["updateSnapshot"]>>,
  path: string,
): Promise<ParsedPolicyChange["candidate"]> {
  const project = await snapshot.getDefaultProjectForFile(path);
  const source = await project?.program.getSourceFile(path);
  if (source === undefined) throw new Error(`TypeScript did not parse ${path}`);
  return source;
}
