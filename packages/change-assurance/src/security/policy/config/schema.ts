import { types } from "node:util";
import type {
  SecurityEntrypointSchema,
  SecurityImportAudit,
  SecurityInterfaceRule,
} from "../../contract.ts";
import { exactRecord, identity, stringArray } from "./values.ts";
import {
  isImportCapability,
  isInterfaceCapability,
  isMiddleware,
} from "./vocabulary.ts";

export function parseEntrypoints(
  value: unknown,
): readonly SecurityEntrypointSchema[] | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length === 0 ||
    value.length > 256
  )
    return;
  const result: SecurityEntrypointSchema[] = [];
  const paths = new Set<string>();
  for (const item of value) {
    const record = exactRecord(item, [
      "path",
      "exportName",
      "requiredMiddleware",
      "requiredSecureImports",
      "benchmarkIds",
    ]);
    if (record === undefined) return;
    const path = identity(record["path"]);
    const exportName = identity(record["exportName"]);
    const requiredMiddleware = stringArray(record["requiredMiddleware"]);
    const requiredSecureImports = stringArray(record["requiredSecureImports"]);
    const benchmarkIds = stringArray(record["benchmarkIds"]);
    if (
      path === undefined ||
      exportName === undefined ||
      requiredMiddleware === undefined ||
      requiredSecureImports === undefined ||
      benchmarkIds === undefined ||
      paths.has(path) ||
      requiredMiddleware.length !== 3 ||
      new Set(requiredMiddleware).size !== 3 ||
      requiredMiddleware.some((name) => !isMiddleware(name))
    )
      return;
    const typedMiddleware = requiredMiddleware.filter(isMiddleware);
    if (typedMiddleware.length !== requiredMiddleware.length) return;
    paths.add(path);
    result.push(
      Object.freeze({
        path,
        exportName,
        requiredMiddleware: Object.freeze(typedMiddleware),
        requiredSecureImports: Object.freeze(requiredSecureImports),
        benchmarkIds: Object.freeze(benchmarkIds),
      }),
    );
  }
  return Object.freeze(result);
}

export function parseAuditedImports(
  value: unknown,
): readonly SecurityImportAudit[] | undefined {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 512)
    return;
  const result: SecurityImportAudit[] = [];
  const modules = new Set<string>();
  for (const item of value) {
    const record = exactRecord(item, [
      "module",
      "allowedImports",
      "capability",
    ]);
    if (record === undefined) return;
    const module = identity(record["module"]);
    const allowedImports = stringArray(record["allowedImports"]);
    const parsedCapability = isImportCapability(record["capability"])
      ? record["capability"]
      : undefined;
    if (
      module === undefined ||
      allowedImports === undefined ||
      parsedCapability === undefined ||
      modules.has(module)
    )
      return;
    modules.add(module);
    result.push(
      Object.freeze({
        module,
        allowedImports: Object.freeze(allowedImports),
        capability: parsedCapability,
      }),
    );
  }
  return Object.freeze(result);
}

export function parseSecureInterfaces(
  value: unknown,
): readonly SecurityInterfaceRule[] | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length === 0 ||
    value.length > 256
  )
    return;
  const result: SecurityInterfaceRule[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    const record = exactRecord(item, [
      "interfaceId",
      "module",
      "imports",
      "capability",
    ]);
    if (record === undefined) return;
    const interfaceId = identity(record["interfaceId"]);
    const module = identity(record["module"]);
    const imports = stringArray(record["imports"]);
    const capabilityValue = isInterfaceCapability(record["capability"])
      ? record["capability"]
      : undefined;
    if (
      interfaceId === undefined ||
      module === undefined ||
      imports === undefined ||
      imports.length === 0 ||
      capabilityValue === undefined ||
      ids.has(interfaceId)
    )
      return;
    ids.add(interfaceId);
    result.push(
      Object.freeze({
        interfaceId,
        module,
        imports: Object.freeze(imports),
        capability: capabilityValue,
      }),
    );
  }
  return Object.freeze(result);
}
