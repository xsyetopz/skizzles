// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type Expression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isDoStatement,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isIdentifier,
  isIfStatement,
  isReturnStatement,
  isSwitchStatement,
  isTryStatement,
  isVariableDeclarationList,
  isVariableStatement,
  isWhileStatement,
  type Node,
  type Statement,
  SyntaxKind,
} from "typescript/unstable/ast";
import type {
  ParsedSecuritySource,
  SecurityFinding,
  SecurityFindingCode,
  SecurityPolicyConfig,
} from "../contract.ts";
import {
  collectSinkAliases,
  resolveSinkDispatch,
  type SinkAliases,
} from "./dataflow/dispatch.ts";
import {
  collectSecurityFunctions,
  type SecurityFunctionEntry,
  visitSkippingFunctions,
} from "./dataflow/entries.ts";
import {
  bindTaint,
  clean,
  combine,
  evaluate,
  mergeEnvironments,
  type Taint,
  type TaintEnvironment,
  taintedAt,
} from "./dataflow/evaluate.ts";
import {
  bindLocationAlias,
  cloneLocationEnvironment,
  createLocationEnvironment,
  expressionLocation,
} from "./dataflow/locations.ts";
import { inspectMiddlewareDominance } from "./dominance.ts";
import { inspectDynamicResolution } from "./dynamic.ts";
import {
  addFlowFinding,
  callIdentity,
  type FlowContext,
  flowPoint,
  isFlowExpression,
  trustedCall,
} from "./flow.ts";
import { inspectRawPrimitiveReferences } from "./raw.ts";

interface AnalysisContext extends FlowContext {
  readonly functions: ReadonlySet<string>;
  readonly sinkAliases: SinkAliases;
}

type Environment = TaintEnvironment;
export function inspectSecurityDataflows(
  sources: readonly ParsedSecuritySource[],
  config: SecurityPolicyConfig,
): readonly SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const findingKeys = new Set<string>();
  for (const source of sources) {
    const entries = collectSecurityFunctions(source.sourceFile);
    const context: AnalysisContext = {
      source,
      config,
      functions: new Set(entries.map(({ name }) => name)),
      findings,
      findingKeys,
      sinkAliases: collectSinkAliases(source.sourceFile, source, config),
    };
    inspectRawPrimitiveReferences(source.sourceFile, context);
    for (const entry of entries) analyzeFunction(entry, context);
    inspectMiddlewareDominance(
      source,
      config,
      findings,
      findingKeys,
      context.sinkAliases,
    );
    inspectDynamicResolution(source.sourceFile, context, context.sinkAliases);
  }
  return Object.freeze(findings);
}

function analyzeFunction(
  entry: SecurityFunctionEntry,
  context: AnalysisContext,
): void {
  const environment = createLocationEnvironment<Taint>();
  for (const parameter of entry.node.parameters) {
    bindTaint(
      parameter.name,
      taintedAt(parameter.name, context, "parameter-source"),
      environment,
    );
  }
  const body = entry.node.body;
  if (body === undefined) return;
  if (isBlock(body)) scanStatements(body.statements, environment, context);
  else {
    inspectCalls(body, environment, context);
    evaluate(body, environment, context);
  }
}

function scanStatements(
  statements: readonly Statement[],
  environment: Environment,
  context: AnalysisContext,
): void {
  for (const statement of statements) {
    if (isVariableStatement(statement)) {
      scanDeclarations(statement.declarationList, environment, context);
      continue;
    }
    if (isExpressionStatement(statement)) {
      scanExpression(statement.expression, environment, context);
      continue;
    }
    if (isIfStatement(statement)) {
      inspectCalls(statement.expression, environment, context);
      const thenEnvironment = cloneLocationEnvironment(environment);
      scanStatement(statement.thenStatement, thenEnvironment, context);
      const elseEnvironment = cloneLocationEnvironment(environment);
      if (statement.elseStatement !== undefined)
        scanStatement(statement.elseStatement, elseEnvironment, context);
      mergeEnvironments(environment, thenEnvironment, elseEnvironment);
      continue;
    }
    if (
      isForStatement(statement) ||
      isForInStatement(statement) ||
      isForOfStatement(statement) ||
      isWhileStatement(statement) ||
      isDoStatement(statement)
    ) {
      scanLoop(statement, environment, context);
      continue;
    }
    if (isSwitchStatement(statement)) {
      inspectCalls(statement.expression, environment, context);
      let merged = cloneLocationEnvironment(environment);
      for (const clause of statement.caseBlock.clauses) {
        const branch = cloneLocationEnvironment(environment);
        if ("expression" in clause && clause.expression !== undefined)
          inspectCalls(clause.expression, branch, context);
        scanStatements(clause.statements, branch, context);
        mergeEnvironments(merged, merged, branch);
      }
      mergeEnvironments(environment, environment, merged);
      continue;
    }
    if (isTryStatement(statement)) {
      const attempted = cloneLocationEnvironment(environment);
      scanStatements(statement.tryBlock.statements, attempted, context);
      const caught = cloneLocationEnvironment(environment);
      if (statement.catchClause !== undefined) {
        const variable = statement.catchClause.variableDeclaration;
        if (variable !== undefined)
          bindTaint(
            variable.name,
            taintedAt(variable.name, context, "exception-source"),
            caught,
          );
        scanStatements(statement.catchClause.block.statements, caught, context);
      }
      mergeEnvironments(environment, attempted, caught);
      if (statement.finallyBlock !== undefined)
        scanStatements(statement.finallyBlock.statements, environment, context);
      continue;
    }
    if (isReturnStatement(statement)) {
      if (statement.expression !== undefined)
        inspectCalls(statement.expression, environment, context);
      continue;
    }
    if (isBlock(statement)) {
      scanStatements(statement.statements, environment, context);
      continue;
    }
    inspectCalls(statement, environment, context);
  }
}

function scanLoop(
  statement:
    | import("typescript/unstable/ast").ForStatement
    | import("typescript/unstable/ast").ForInStatement
    | import("typescript/unstable/ast").ForOfStatement
    | import("typescript/unstable/ast").WhileStatement
    | import("typescript/unstable/ast").DoStatement,
  environment: Environment,
  context: AnalysisContext,
): void {
  const iteration = cloneLocationEnvironment(environment);
  if (isForStatement(statement)) {
    const initializer = statement.initializer;
    if (initializer !== undefined) {
      if (isVariableDeclarationList(initializer))
        scanDeclarations(initializer, iteration, context);
      else if (isFlowExpression(initializer))
        scanExpression(initializer, iteration, context);
    }
    if (statement.condition !== undefined)
      inspectCalls(statement.condition, iteration, context);
    scanStatement(statement.statement, iteration, context);
    if (statement.incrementor !== undefined)
      scanExpression(statement.incrementor, iteration, context);
  } else if (isForInStatement(statement) || isForOfStatement(statement)) {
    const sourceTaint = evaluate(statement.expression, iteration, context);
    inspectCalls(statement.expression, iteration, context);
    if (isVariableDeclarationList(statement.initializer)) {
      for (const declaration of statement.initializer.declarations)
        bindTaint(declaration.name, sourceTaint, iteration);
    } else if (isFlowExpression(statement.initializer)) {
      const target = expressionLocation(statement.initializer, iteration);
      if (target !== undefined) iteration.values.set(target, sourceTaint);
    }
    scanStatement(statement.statement, iteration, context);
  } else {
    inspectCalls(statement.expression, iteration, context);
    scanStatement(statement.statement, iteration, context);
  }
  mergeEnvironments(environment, environment, iteration);
}

function scanDeclarations(
  declarations: import("typescript/unstable/ast").VariableDeclarationList,
  environment: Environment,
  context: AnalysisContext,
): void {
  for (const declaration of declarations.declarations) {
    bindTaint(
      declaration.name,
      declaration.initializer === undefined
        ? clean
        : evaluate(declaration.initializer, environment, context),
      environment,
    );
    if (isIdentifier(declaration.name))
      bindLocationAlias(
        declaration.name.text,
        declaration.initializer,
        environment,
      );
  }
}

function scanExpression(
  expression: Expression,
  environment: Environment,
  context: AnalysisContext,
): void {
  if (
    isBinaryExpression(expression) &&
    expression.operatorToken.kind === SyntaxKind.EqualsToken
  ) {
    const target = expressionLocation(expression.left, environment);
    if (target !== undefined)
      environment.values.set(
        target,
        evaluate(expression.right, environment, context),
      );
    if (isIdentifier(expression.left))
      bindLocationAlias(expression.left.text, expression.right, environment);
  }
  inspectCalls(expression, environment, context);
}

function scanStatement(
  statement: Statement,
  environment: Environment,
  context: AnalysisContext,
): void {
  if (isBlock(statement))
    scanStatements(statement.statements, environment, context);
  else scanStatements([statement], environment, context);
}

function inspectCalls(
  node: Node,
  environment: Environment,
  context: AnalysisContext,
): void {
  visitSkippingFunctions(node, (current) => {
    if (!isCallExpression(current)) return;
    const argumentTaint = combine(
      current.arguments.map((argument) =>
        evaluate(argument, environment, context),
      ),
    );
    const identity = callIdentity(current, context.source);
    const dispatch = resolveSinkDispatch(
      current,
      context.source,
      context.config,
      context.sinkAliases,
    );
    const capability = dispatch.capability;
    if (capability !== undefined && dispatch.raw) {
      const code: SecurityFindingCode =
        capability === "execution"
          ? "RAW_EXECUTION_PRIMITIVE"
          : capability === "database"
            ? "RAW_DATABASE_PRIMITIVE"
            : "RAW_NETWORK_PRIMITIVE";
      addFlowFinding(
        code,
        current,
        `Raw ${capability} primitive ${dispatch.semanticName} is forbidden; use a capability-matched secure interface.`,
        [flowPoint(current, context, `raw-${capability}-sink`)],
        context,
      );
    }
    if (capability !== undefined && argumentTaint.tainted) {
      const code: SecurityFindingCode =
        capability === "execution"
          ? "TAINTED_EXECUTION_FLOW"
          : capability === "database"
            ? "TAINTED_DATABASE_FLOW"
            : "TAINTED_NETWORK_FLOW";
      addFlowFinding(
        code,
        current,
        `Untrusted data reaches the ${capability} sink ${dispatch.semanticName}.`,
        [
          ...argumentTaint.trace,
          flowPoint(current, context, `${capability}-sink`),
        ],
        context,
      );
      return;
    }
    if (
      argumentTaint.tainted &&
      !identity.dynamic &&
      !trustedCall(identity, context) &&
      !context.functions.has(identity.localName)
    ) {
      addFlowFinding(
        "UNKNOWN_SECURITY_FLOW",
        current,
        "Untrusted data reaches a call whose security semantics cannot be resolved.",
        [...argumentTaint.trace, flowPoint(current, context, "unknown-call")],
        context,
      );
    }
  });
}
