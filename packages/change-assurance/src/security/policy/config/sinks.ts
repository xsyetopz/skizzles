import { types } from "node:util";
import type { SecuritySinkRule } from "../../contract.ts";
import { exactRecord, stringArray } from "./values.ts";
import { isSinkCapability } from "./vocabulary.ts";

export function parseSinks(
  value: unknown,
): readonly SecuritySinkRule[] | undefined {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length === 0 ||
    value.length > 32
  )
    return;
  const result: SecuritySinkRule[] = [];
  const capabilitiesSeen = new Set<string>();
  for (const item of value) {
    const record = exactRecord(item, [
      "capability",
      "names",
      "secureInterfaceIds",
    ]);
    if (record === undefined) return;
    const capabilityValue = isSinkCapability(record["capability"])
      ? record["capability"]
      : undefined;
    const names = stringArray(record["names"]);
    const secureInterfaceIds = stringArray(record["secureInterfaceIds"]);
    if (
      capabilityValue === undefined ||
      names === undefined ||
      names.length === 0 ||
      secureInterfaceIds === undefined ||
      secureInterfaceIds.length === 0 ||
      capabilitiesSeen.has(capabilityValue)
    )
      return;
    capabilitiesSeen.add(capabilityValue);
    result.push(
      Object.freeze({
        capability: capabilityValue,
        names: Object.freeze(names),
        secureInterfaceIds: Object.freeze(secureInterfaceIds),
      }),
    );
  }
  return Object.freeze(result);
}
