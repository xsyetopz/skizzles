// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import type { CallExpression, Node } from "typescript/unstable/ast";
import type {
  ParsedSecuritySource,
  SecurityFinding,
  SecurityPolicyConfig,
} from "../contract.ts";
import { finding } from "./analysis/receipts.ts";
import type { SinkCapability } from "./dataflow/dispatch.ts";
import { callIdentity } from "./flow.ts";

interface InterfaceContext {
  readonly source: ParsedSecuritySource;
  readonly config: SecurityPolicyConfig;
  readonly findings: SecurityFinding[];
  readonly findingKeys: Set<string>;
}

export function activateSecureInterfaces(
  call: CallExpression,
  active: Set<string>,
  context: InterfaceContext,
): void {
  for (const interfaceId of secureInterfacesFor(call, context))
    active.add(interfaceId);
}

export function hasSecureInterfaceCall(
  call: CallExpression,
  context: InterfaceContext,
): boolean {
  return secureInterfacesFor(call, context).length > 0;
}

export function reportSinkInterface(
  call: CallExpression,
  active: ReadonlySet<string>,
  context: InterfaceContext,
  sinkName: string,
  capability: SinkCapability,
): void {
  const required = context.config.sinks.find(({ names }) =>
    names.includes(sinkName),
  )?.secureInterfaceIds;
  const matched = (required ?? []).filter((interfaceId) =>
    context.config.secureInterfaces.some(
      (secureInterface) =>
        secureInterface.interfaceId === interfaceId &&
        secureInterface.capability === capability,
    ),
  );
  if (matched.some((id) => active.has(id))) return;
  if (matched.length > 0) {
    reportMissingInterfaces(new Set(matched), active, call, context);
    return;
  }
  reportMissingCapabilityInterface(call, sinkName, capability, context);
}

function reportMissingCapabilityInterface(
  call: CallExpression,
  sinkName: string,
  capability: SinkCapability,
  context: InterfaceContext,
): void {
  const location = context.source.sourceFile.getLineAndCharacterOfPosition(
    call.getStart(context.source.sourceFile),
  );
  const key = `MISSING_SECURE_INTERFACE\0${capability}\0${context.source.path}\0${location.line + 1}\0${location.character + 1}`;
  if (context.findingKeys.has(key)) return;
  context.findingKeys.add(key);
  context.findings.push(
    finding(
      "MISSING_SECURE_INTERFACE",
      context.source.path,
      `Sink ${sinkName} requires a dominating secure interface with ${capability} capability.`,
      location.line + 1,
      location.character + 1,
    ),
  );
}

export function reportMissingInterfaces(
  required: ReadonlySet<string>,
  active: ReadonlySet<string>,
  node: Node,
  context: InterfaceContext,
): void {
  const location = context.source.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(context.source.sourceFile),
  );
  for (const interfaceId of required) {
    if (active.has(interfaceId)) continue;
    const key = `MISSING_SECURE_INTERFACE\0${interfaceId}\0${context.source.path}\0${location.line + 1}\0${location.character + 1}`;
    if (context.findingKeys.has(key)) continue;
    context.findingKeys.add(key);
    context.findings.push(
      finding(
        "MISSING_SECURE_INTERFACE",
        context.source.path,
        `Required secure interface ${interfaceId} does not dominate this entrypoint path.`,
        location.line + 1,
        location.character + 1,
        Object.freeze([
          Object.freeze({
            path: context.source.path,
            line: location.line + 1,
            column: location.character + 1,
            kind: "unused-secure-interface",
          }),
        ]),
      ),
    );
  }
}

function secureInterfacesFor(
  call: CallExpression,
  context: InterfaceContext,
): readonly string[] {
  const identity = callIdentity(call, context.source);
  const binding = context.source.importBindings.get(identity.bindingName);
  if (binding === undefined) return Object.freeze([]);
  return Object.freeze(
    context.config.secureInterfaces
      .filter(
        ({ module, imports }) =>
          module === binding.module && imports.includes(identity.semanticName),
      )
      .map(({ interfaceId }) => interfaceId),
  );
}
