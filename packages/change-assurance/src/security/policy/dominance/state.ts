import type { SecurityMiddleware } from "../../contract.ts";

export interface DominanceState {
  readonly middleware: Set<SecurityMiddleware>;
  readonly interfaces: Set<string>;
}

export function emptyState(): DominanceState {
  return { middleware: new Set(), interfaces: new Set() };
}

export function copyState(state: DominanceState): DominanceState {
  return {
    middleware: new Set(state.middleware),
    interfaces: new Set(state.interfaces),
  };
}

export function intersectStates(
  left: DominanceState,
  right: DominanceState,
): DominanceState {
  return {
    middleware: new Set(
      [...left.middleware].filter((item) => right.middleware.has(item)),
    ),
    interfaces: new Set(
      [...left.interfaces].filter((item) => right.interfaces.has(item)),
    ),
  };
}
