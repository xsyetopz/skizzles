// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes the AST through an unstable package export.
import {
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isClassStaticBlockDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isDecorator,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isHeritageClause,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isParameterDeclaration,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { type Digest, digestText } from "../digest.ts";
import type { StructuralPolicy } from "../engine/workflow-state.ts";
import type {
  ExecutableVersionEvidence,
  ModifiedExecutableNodeEvidence,
} from "../evidence/structural-contract.ts";
import { analyzeExecutableRegion, analyzeExecutableVersion } from "./sites.ts";

interface FunctionAnalysis {
  readonly nodeId: Digest;
  readonly path: string;
  readonly pathDigest: Digest;
  readonly functionKey: string;
  readonly kind: ModifiedExecutableNodeEvidence["kind"];
  readonly version: ExecutableVersionEvidence;
}

export type StructuralAnalysisResult =
  | Readonly<{
      status: "accepted";
      modifiedNodes: readonly ModifiedExecutableNodeEvidence[];
      baselineAggregateComplexity: number;
      candidateAggregateComplexity: number;
      aggregateIncrease: number;
    }>
  | Readonly<{ status: "rejected" }>;

export function analyzeModifiedExecutables(input: {
  readonly baseline: readonly Readonly<{
    path: string;
    sourceFile: SourceFile;
  }>[];
  readonly candidate: readonly Readonly<{
    path: string;
    sourceFile: SourceFile;
  }>[];
  readonly policy: StructuralPolicy;
}): StructuralAnalysisResult {
  const baseline = collectSet(input.baseline);
  const candidate = collectSet(input.candidate);
  if (baseline === undefined || candidate === undefined) return rejected();
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const modifiedNodes: ModifiedExecutableNodeEvidence[] = [];
  for (const key of keys) {
    const before = baseline.get(key);
    const after = candidate.get(key);
    if (before?.version.nodeDigest === after?.version.nodeDigest) continue;
    const current = after ?? before;
    if (current === undefined) return rejected();
    const baselineComplexity = before?.version.complexity ?? 0;
    const candidateComplexity = after?.version.complexity ?? 0;
    const increase = candidateComplexity - baselineComplexity;
    const currentVersion = after?.version ?? before?.version;
    if (currentVersion === undefined) return rejected();
    const material = {
      nodeId: current.nodeId,
      path: current.path,
      pathDigest: current.pathDigest,
      functionKey: current.functionKey,
      kind: current.kind,
      nodeDigest: currentVersion.nodeDigest,
      span: currentVersion.span,
      lineIds: currentVersion.lineIds,
      branchIds: currentVersion.branchIds,
      mutationSites: currentVersion.mutationSites,
      baseline: before?.version ?? null,
      candidate: after?.version ?? null,
      baselineComplexity,
      candidateComplexity,
      increase,
    };
    modifiedNodes.push(
      Object.freeze({
        ...material,
        complexityReceiptDigest: digestText(
          JSON.stringify({
            metricVersion: input.policy.metricVersion,
            nodeId: current.nodeId,
            baselineComplexity,
            candidateComplexity,
            increase,
            baselineVersionDigest: before?.version.versionDigest ?? null,
            candidateVersionDigest: after?.version.versionDigest ?? null,
          }),
        ),
      }),
    );
  }
  const baselineAggregateComplexity = modifiedNodes.reduce(
    (sum, node) => sum + node.baselineComplexity,
    0,
  );
  const candidateAggregateComplexity = modifiedNodes.reduce(
    (sum, node) => sum + node.candidateComplexity,
    0,
  );
  const aggregateIncrease =
    candidateAggregateComplexity - baselineAggregateComplexity;
  if (
    modifiedNodes.some(
      ({ candidateComplexity, increase }) =>
        candidateComplexity > input.policy.maxFunctionComplexity ||
        increase > input.policy.maxFunctionIncrease,
    ) ||
    aggregateIncrease > input.policy.maxAggregateIncrease
  ) {
    return rejected();
  }
  return Object.freeze({
    status: "accepted",
    modifiedNodes: Object.freeze(modifiedNodes),
    baselineAggregateComplexity,
    candidateAggregateComplexity,
    aggregateIncrease,
  });
}

function collectSet(
  files: readonly Readonly<{ path: string; sourceFile: SourceFile }>[],
): Map<string, FunctionAnalysis> | undefined {
  const result = new Map<string, FunctionAnalysis>();
  for (const file of files) {
    const collected = collectExecutables(file.path, file.sourceFile);
    if (collected === undefined) return;
    for (const value of collected) {
      const key = `${value.path}\0${value.functionKey}`;
      if (result.has(key)) return;
      result.set(key, value);
    }
  }
  return result;
}

function collectExecutables(
  path: string,
  sourceFile: SourceFile,
): readonly FunctionAnalysis[] | undefined {
  const result: FunctionAnalysis[] = [];
  const siblingLabels = new Map<string, Set<string>>();
  let ambiguous = false;
  const addAnalysis = (
    functionKey: string,
    kind: ModifiedExecutableNodeEvidence["kind"],
    version: ExecutableVersionEvidence,
  ): void => {
    const nodeId = digestText(
      JSON.stringify({ metricVersion: "cyclomatic-v1", path, functionKey }),
    );
    result.push(
      Object.freeze({
        nodeId,
        path,
        pathDigest: digestText(path),
        functionKey,
        kind,
        version,
      }),
    );
  };
  const moduleNodes = sourceFile.statements.filter(moduleRuntimeStatement);
  if (moduleNodes.length > 0) {
    const functionKey = "module-initializer";
    const nodeId = digestText(
      JSON.stringify({ metricVersion: "cyclomatic-v1", path, functionKey }),
    );
    addAnalysis(
      functionKey,
      "module-initializer",
      analyzeExecutableRegion(moduleNodes, nodeId),
    );
  }
  const claimLabel = (parentKey: string, label: string): boolean => {
    const labels = siblingLabels.get(parentKey) ?? new Set<string>();
    if (labels.has(label)) {
      ambiguous = true;
      return false;
    }
    labels.add(label);
    siblingLabels.set(parentKey, labels);
    return true;
  };
  const visit = (node: Node, parentKey: string, route: string): void => {
    const classLabel = classDescriptor(node, route);
    if (classLabel !== undefined) {
      if (!claimLabel(parentKey, classLabel)) return;
      const classKey =
        parentKey.length === 0 ? classLabel : `${parentKey}/${classLabel}`;
      const initializerNodes = classInitializerNodes(node);
      if (initializerNodes.length > 0) {
        const functionKey = `${classKey}/initializer`;
        const nodeId = digestText(
          JSON.stringify({ metricVersion: "cyclomatic-v1", path, functionKey }),
        );
        addAnalysis(
          functionKey,
          "class-initializer",
          analyzeExecutableRegion(initializerNodes, nodeId),
        );
      }
      let childIndex = 0;
      node.forEachChild((child) => {
        visit(child, classKey, `${route}.${childIndex}`);
        childIndex += 1;
      });
      return;
    }
    const descriptor = functionDescriptor(node, route);
    if (descriptor !== undefined) {
      if (!claimLabel(parentKey, descriptor.label)) return;
      const functionKey =
        parentKey.length === 0
          ? descriptor.label
          : `${parentKey}/${descriptor.label}`;
      const nodeId = digestText(
        JSON.stringify({ metricVersion: "cyclomatic-v1", path, functionKey }),
      );
      const version = analyzeExecutableVersion(node, nodeId);
      addAnalysis(functionKey, descriptor.kind, version);
      let childIndex = 0;
      node.forEachChild((child) => {
        visit(child, functionKey, `${route}.${childIndex}`);
        childIndex += 1;
      });
      return;
    }
    let childIndex = 0;
    node.forEachChild((child) => {
      visit(child, parentKey, `${route}.${childIndex}`);
      childIndex += 1;
    });
  };
  visit(sourceFile, "", "0");
  return ambiguous ? undefined : Object.freeze(result);
}

function classInitializerNodes(node: Node): readonly Node[] {
  if (!(isClassDeclaration(node) || isClassExpression(node))) return [];
  const result: Node[] = [];
  node.forEachChild((child) => {
    if (isDecorator(child) || isHeritageClause(child)) result.push(child);
  });
  for (const member of node.members) {
    if (isClassStaticBlockDeclaration(member)) {
      result.push(member);
      continue;
    }
    member.forEachChild((child) => {
      if (isDecorator(child) || isComputedPropertyName(child)) {
        result.push(child);
      } else if (isParameterDeclaration(child)) {
        child.forEachChild((parameterChild) => {
          if (isDecorator(parameterChild)) result.push(parameterChild);
        });
      }
    });
    if (isPropertyDeclaration(member) && member.initializer !== undefined) {
      result.push(member.initializer);
    }
  }
  return Object.freeze(result);
}

function moduleRuntimeStatement(node: Node): boolean {
  return !(
    isClassDeclaration(node) ||
    isFunctionDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeAliasDeclaration(node) ||
    isImportDeclaration(node) ||
    isExportDeclaration(node)
  );
}

function classDescriptor(node: Node, route: string): string | undefined {
  if (!isClassDeclaration(node) && !isClassExpression(node)) return;
  return `class:${node.name?.text ?? contextualName(node, route)}`;
}

function functionDescriptor(
  node: Node,
  route: string,
):
  | Readonly<{
      label: string;
      kind: ModifiedExecutableNodeEvidence["kind"];
    }>
  | undefined {
  if (isFunctionDeclaration(node) && node.body !== undefined) {
    return Object.freeze({
      label: `function:${node.name?.text ?? "<anonymous>"}`,
      kind: "function",
    });
  }
  if (isMethodDeclaration(node) && node.body !== undefined) {
    return Object.freeze({
      label: `method:${node.name.getText()}`,
      kind: "method",
    });
  }
  if (isConstructorDeclaration(node) && node.body !== undefined) {
    return Object.freeze({ label: "constructor", kind: "constructor" });
  }
  if (isGetAccessorDeclaration(node) && node.body !== undefined) {
    return Object.freeze({
      label: `get:${node.name.getText()}`,
      kind: "get-accessor",
    });
  }
  if (isSetAccessorDeclaration(node) && node.body !== undefined) {
    return Object.freeze({
      label: `set:${node.name.getText()}`,
      kind: "set-accessor",
    });
  }
  if (isFunctionExpression(node)) {
    return Object.freeze({
      label: `function-expression:${node.name?.text ?? contextualName(node, route)}`,
      kind: "function-expression",
    });
  }
  if (isArrowFunction(node)) {
    return Object.freeze({
      label: `arrow:${contextualName(node, route)}`,
      kind: "arrow-function",
    });
  }
  return;
}

function contextualName(node: Node, route: string): string {
  const parent = node.parent;
  if (isVariableDeclaration(parent) && parent.initializer === node) {
    return `binding:${parent.name.getText()}`;
  }
  if (isPropertyAssignment(parent) && parent.initializer === node) {
    return `property:${parent.name.getText()}`;
  }
  return `anonymous@${route}`;
}

function rejected(): StructuralAnalysisResult {
  return Object.freeze({ status: "rejected" });
}
