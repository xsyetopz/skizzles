import { digestText } from "../digest.ts";
import type {
  FaultFirstInspection,
  ObservedNegativePathEvidence,
  ParsedPolicyChange,
  PolicyAnalysisInput,
  PolicyFinding,
} from "./contract.ts";
import { observeFailureCodes } from "./fault-evidence.ts";

export function inspectFaultFirst(
  input: PolicyAnalysisInput,
): FaultFirstInspection {
  const findings: PolicyFinding[] = [];
  const observedEvidence: ObservedNegativePathEvidence[] = [];
  const productionChanges = changedByOwnership(input, "production");
  const testChanges = changedByOwnership(input, "test");
  const declarations = declarationsByPath(input, productionChanges, findings);
  const seenAssociations = new Set<string>();

  for (const association of input.faultFirst.negativeTests) {
    const key = `${association.productionPath}\u0000${association.testPath}`;
    const declaration = declarations.get(association.productionPath);
    const testChange = testChanges.get(association.testPath);
    if (
      seenAssociations.has(key) ||
      !productionChanges.has(association.productionPath) ||
      declaration === undefined ||
      testChange === undefined
    ) {
      addFinding(findings, missingEvidence(association.productionPath));
      continue;
    }
    seenAssociations.add(key);
    const observed = observeFailureCodes(
      testChange,
      new Set(declaration.failureCodes),
    );
    if (observed.length === 0) {
      addFinding(findings, missingEvidence(association.productionPath));
      continue;
    }
    observedEvidence.push(
      Object.freeze({
        productionPath: association.productionPath,
        testPath: association.testPath,
        failureCodes: observed,
      }),
    );
  }

  for (const [path] of productionChanges) {
    const declaration = declarations.get(path);
    if (declaration === undefined) {
      addFinding(findings, missingDeclaration(path));
      continue;
    }
    const covered = new Set(
      observedEvidence
        .filter(({ productionPath }) => productionPath === path)
        .flatMap(({ failureCodes }) => failureCodes),
    );
    if (declaration.failureCodes.some((code) => !covered.has(code))) {
      addFinding(findings, missingEvidence(path));
    }
  }

  const sortedEvidence = Object.freeze(
    observedEvidence.sort((left, right) =>
      compareText(
        `${left.productionPath}\u0000${left.testPath}`,
        `${right.productionPath}\u0000${right.testPath}`,
      ),
    ),
  );
  return Object.freeze({
    findings: Object.freeze(findings),
    observedEvidence: sortedEvidence,
    evidenceDigest: digestText(JSON.stringify(sortedEvidence)),
  });
}

function changedByOwnership(
  input: PolicyAnalysisInput,
  ownership: ParsedPolicyChange["ownership"],
): ReadonlyMap<string, ParsedPolicyChange> {
  return new Map(
    input.changes
      .filter(
        (change) =>
          change.ownership === ownership &&
          change.baselineText !== change.candidateText,
      )
      .map((change) => [change.path, change]),
  );
}

function declarationsByPath(
  input: PolicyAnalysisInput,
  productionChanges: ReadonlyMap<string, ParsedPolicyChange>,
  findings: PolicyFinding[],
): ReadonlyMap<
  string,
  PolicyAnalysisInput["faultFirst"]["declarations"][number]
> {
  const declarations = new Map<
    string,
    PolicyAnalysisInput["faultFirst"]["declarations"][number]
  >();
  for (const declaration of input.faultFirst.declarations) {
    if (
      declarations.has(declaration.productionPath) ||
      !productionChanges.has(declaration.productionPath) ||
      declaration.failureCodes.length === 0 ||
      new Set(declaration.failureCodes).size !== declaration.failureCodes.length
    ) {
      addFinding(findings, missingDeclaration(declaration.productionPath));
      continue;
    }
    declarations.set(declaration.productionPath, declaration);
  }
  return declarations;
}

function addFinding(findings: PolicyFinding[], finding: PolicyFinding): void {
  if (
    !findings.some(
      (existing) =>
        existing.path === finding.path && existing.code === finding.code,
    )
  ) {
    findings.push(finding);
  }
}

function missingDeclaration(path: string): PolicyFinding {
  return Object.freeze({
    path,
    start: 0,
    end: 0,
    code: "FAULT_FIRST_DECLARATION_MISSING",
    message:
      "Declare the expected failure modes before editing production source.",
  });
}

function missingEvidence(path: string): PolicyFinding {
  return Object.freeze({
    path,
    start: 0,
    end: 0,
    code: "NEGATIVE_PATH_EVIDENCE_MISSING",
    message:
      "Changed production source requires AST-observed negative-path evidence for every declared failure mode.",
  });
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
