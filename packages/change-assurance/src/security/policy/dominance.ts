// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type Block,
  type CallExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isDoStatement,
  isExpressionStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isReturnStatement,
  isSwitchStatement,
  isTryStatement,
  isWhileStatement,
  type Node,
  type Statement,
} from "typescript/unstable/ast";
import type {
  ParsedSecuritySource,
  SecurityFinding,
  SecurityMiddleware,
  SecurityPolicyConfig,
} from "../contract.ts";
import { finding } from "./analysis/receipts.ts";
import { auditNames, rateNames, sanitizerNames } from "./analysis/rules.ts";
import {
  resolveSinkDispatch,
  type SinkAliases,
  type SinkCapability,
  type SinkDispatch,
} from "./dataflow/dispatch.ts";
import {
  copyState,
  type DominanceState,
  emptyState,
  intersectStates,
} from "./dominance/state.ts";
import {
  dominanceCallIdentity,
  trustedDominanceCall,
  visitDominanceNodes,
  visitSkippingNestedFunctions,
} from "./dominance/traversal.ts";
import {
  activateSecureInterfaces,
  hasSecureInterfaceCall,
  reportMissingInterfaces,
  reportSinkInterface,
} from "./interfaces.ts";

export function inspectMiddlewareDominance(
  source: ParsedSecuritySource,
  config: SecurityPolicyConfig,
  findings: SecurityFinding[],
  findingKeys: Set<string>,
  sinkAliases: SinkAliases,
): void {
  const entrypoint = config.entrypoints.find(
    ({ path }) => path === source.path,
  );
  if (entrypoint === undefined) return;
  const entry = findEntrypoint(source, entrypoint.exportName);
  if (entry?.body === undefined) return;
  const context = { source, config, findings, findingKeys, sinkAliases };
  const requiredMiddleware = new Set(entrypoint.requiredMiddleware);
  const requiredInterfaces = new Set(entrypoint.requiredSecureImports);
  const active = emptyState();
  if (!isBlock(entry.body)) {
    reportMissingMiddleware(
      requiredMiddleware,
      active.middleware,
      entry.body,
      context,
    );
    reportMissingInterfaces(
      requiredInterfaces,
      active.interfaces,
      entry.body,
      context,
    );
    return;
  }
  const final = inspectBlock(
    entry.body,
    active,
    requiredMiddleware,
    requiredInterfaces,
    context,
  );
  reportMissingMiddleware(
    requiredMiddleware,
    final.middleware,
    entry.body,
    context,
  );
  reportMissingInterfaces(
    requiredInterfaces,
    final.interfaces,
    entry.body,
    context,
  );
}

interface Context {
  readonly source: ParsedSecuritySource;
  readonly config: SecurityPolicyConfig;
  readonly findings: SecurityFinding[];
  readonly findingKeys: Set<string>;
  readonly sinkAliases: SinkAliases;
}

function findEntrypoint(source: ParsedSecuritySource, name: string) {
  let result:
    | import("typescript/unstable/ast").FunctionDeclaration
    | import("typescript/unstable/ast").ArrowFunction
    | import("typescript/unstable/ast").FunctionExpression
    | undefined;
  visitDominanceNodes(source.sourceFile, (node) => {
    if (result !== undefined) return;
    if (isFunctionDeclaration(node) && node.name?.text === name) result = node;
    if (!(isArrowFunction(node) || isFunctionExpression(node))) return;
    if (
      "name" in node.parent &&
      isIdentifier(node.parent.name as Node) &&
      (node.parent.name as { readonly text: string }).text === name
    )
      result = node;
  });
  return result;
}

function inspectBlock(
  block: Block,
  initial: DominanceState,
  requiredMiddleware: ReadonlySet<SecurityMiddleware>,
  requiredInterfaces: ReadonlySet<string>,
  context: Context,
): DominanceState {
  let active = copyState(initial);
  for (const statement of block.statements) {
    if (
      isExpressionStatement(statement) &&
      isCallExpression(statement.expression)
    ) {
      activateCall(statement.expression, active, context);
      const sink = sinkFor(statement.expression, context);
      if (sink !== undefined) {
        reportMissingMiddleware(
          requiredMiddleware,
          active.middleware,
          statement.expression,
          context,
        );
        reportSinkInterface(
          statement.expression,
          active.interfaces,
          context,
          sink.semanticName,
          sink.capability,
        );
      }
      continue;
    }
    if (isReturnStatement(statement)) {
      reportMissingMiddleware(
        requiredMiddleware,
        active.middleware,
        statement,
        context,
      );
      reportMissingInterfaces(
        requiredInterfaces,
        active.interfaces,
        statement,
        context,
      );
      continue;
    }
    if (isIfStatement(statement)) {
      const thenActive = inspectStatement(
        statement.thenStatement,
        active,
        requiredMiddleware,
        requiredInterfaces,
        context,
      );
      const elseActive =
        statement.elseStatement === undefined
          ? copyState(active)
          : inspectStatement(
              statement.elseStatement,
              active,
              requiredMiddleware,
              requiredInterfaces,
              context,
            );
      active = intersectStates(thenActive, elseActive);
      continue;
    }
    if (
      isForStatement(statement) ||
      isForInStatement(statement) ||
      isForOfStatement(statement) ||
      isWhileStatement(statement) ||
      isDoStatement(statement)
    ) {
      const iterated = inspectStatement(
        statement.statement,
        active,
        requiredMiddleware,
        requiredInterfaces,
        context,
      );
      active = intersectStates(active, iterated);
      continue;
    }
    if (isSwitchStatement(statement)) {
      let merged = copyState(active);
      for (const clause of statement.caseBlock.clauses) {
        let branch = copyState(active);
        for (const clauseStatement of clause.statements)
          branch = inspectStatement(
            clauseStatement,
            branch,
            requiredMiddleware,
            requiredInterfaces,
            context,
          );
        merged = intersectStates(merged, branch);
      }
      active = merged;
      continue;
    }
    if (isTryStatement(statement)) {
      const attempted = inspectBlock(
        statement.tryBlock,
        active,
        requiredMiddleware,
        requiredInterfaces,
        context,
      );
      const caught =
        statement.catchClause === undefined
          ? copyState(active)
          : inspectBlock(
              statement.catchClause.block,
              active,
              requiredMiddleware,
              requiredInterfaces,
              context,
            );
      active = intersectStates(attempted, caught);
      if (statement.finallyBlock !== undefined)
        active = inspectBlock(
          statement.finallyBlock,
          active,
          requiredMiddleware,
          requiredInterfaces,
          context,
        );
      continue;
    }
    if (isBlock(statement)) {
      active = inspectBlock(
        statement,
        active,
        requiredMiddleware,
        requiredInterfaces,
        context,
      );
      continue;
    }
    if (containsSecurityControl(statement, context))
      reportMissingMiddleware(
        requiredMiddleware,
        active.middleware,
        statement,
        context,
      );
  }
  return active;
}

function inspectStatement(
  statement: Statement,
  active: DominanceState,
  requiredMiddleware: ReadonlySet<SecurityMiddleware>,
  requiredInterfaces: ReadonlySet<string>,
  context: Context,
): DominanceState {
  if (isBlock(statement))
    return inspectBlock(
      statement,
      active,
      requiredMiddleware,
      requiredInterfaces,
      context,
    );
  const result = copyState(active);
  if (
    isExpressionStatement(statement) &&
    isCallExpression(statement.expression)
  ) {
    activateCall(statement.expression, result, context);
    const sink = sinkFor(statement.expression, context);
    if (sink !== undefined) {
      reportMissingMiddleware(
        requiredMiddleware,
        result.middleware,
        statement.expression,
        context,
      );
      reportSinkInterface(
        statement.expression,
        result.interfaces,
        context,
        sink.semanticName,
        sink.capability,
      );
    }
  } else if (isReturnStatement(statement)) {
    reportMissingMiddleware(
      requiredMiddleware,
      result.middleware,
      statement,
      context,
    );
    reportMissingInterfaces(
      requiredInterfaces,
      result.interfaces,
      statement,
      context,
    );
  } else if (containsSecurityControl(statement, context)) {
    reportMissingMiddleware(
      requiredMiddleware,
      result.middleware,
      statement,
      context,
    );
  }
  return result;
}

function reportMissingMiddleware(
  required: ReadonlySet<SecurityMiddleware>,
  active: ReadonlySet<SecurityMiddleware>,
  node: Node,
  context: Context,
): void {
  const location = context.source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(context.source.sourceFile),
  );
  for (const middleware of required) {
    if (active.has(middleware)) continue;
    const key = `MIDDLEWARE_NOT_DOMINANT\0${context.source.path}\0${location.line + 1}\0${location.character + 1}`;
    if (context.findingKeys.has(key)) continue;
    context.findingKeys.add(key);
    context.findings.push(
      finding(
        "MIDDLEWARE_NOT_DOMINANT",
        context.source.path,
        `Required ${middleware} middleware does not dominate this entrypoint path.`,
        location.line + 1,
        location.character + 1,
        Object.freeze([
          Object.freeze({
            path: context.source.path,
            line: location.line + 1,
            column: location.character + 1,
            kind: "unprotected-path",
          }),
        ]),
      ),
    );
  }
}

function activateCall(
  call: CallExpression,
  active: DominanceState,
  context: Context,
): void {
  const middleware = middlewareFor(call, context);
  if (middleware !== undefined) active.middleware.add(middleware);
  activateSecureInterfaces(call, active.interfaces, context);
}

function containsSecurityControl(node: Node, context: Context): boolean {
  let found = false;
  visitSkippingNestedFunctions(node, (current) => {
    if (isCallExpression(current))
      found ||=
        middlewareFor(current, context) !== undefined ||
        sinkFor(current, context) !== undefined ||
        hasSecureInterfaceCall(current, context);
  });
  return found;
}

function middlewareFor(
  call: CallExpression,
  context: Context,
): SecurityMiddleware | undefined {
  const identity = dominanceCallIdentity(call, context.source);
  if (!trustedDominanceCall(identity, context.source, context.config)) return;
  if (rateNames.has(identity.name)) return "rate-limit";
  if (auditNames.has(identity.name)) return "audit-log";
  if (sanitizerNames.has(identity.name)) return "sanitize";
  return undefined;
}

function sinkFor(
  call: CallExpression,
  context: Context,
): (SinkDispatch & { readonly capability: SinkCapability }) | undefined {
  const dispatch = resolveSinkDispatch(
    call,
    context.source,
    context.config,
    context.sinkAliases,
  );
  if (dispatch.capability === undefined) return;
  return { ...dispatch, capability: dispatch.capability };
}
