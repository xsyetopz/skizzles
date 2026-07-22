import { dirname, resolve } from "node:path";
import {
  addFinding,
  type WorkspaceFinding,
  type WorkspacePackage,
} from "../contract.ts";

export interface SourceModule {
  path: string;
  relativePath: string;
  specifiers: readonly string[];
}

export function validateSourceModuleCycles(
  item: WorkspacePackage,
  modules: readonly SourceModule[],
  findings: WorkspaceFinding[],
): void {
  const modulesByPath = new Map(modules.map((module) => [module.path, module]));
  const edges = new Map<string, string[]>();
  for (const module of modules) {
    const targets = module.specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolve(dirname(module.path), specifier))
      .filter((target) => modulesByPath.has(target));
    edges.set(
      module.path,
      [...new Set(targets)].sort((left, right) => left.localeCompare(right)),
    );
  }
  for (const component of stronglyConnectedComponents(edges)) {
    const [first] = component;
    const cyclic =
      component.length > 1 ||
      (first !== undefined && (edges.get(first) ?? []).includes(first));
    if (cyclic) {
      reportComponent(item, component, modulesByPath, findings);
    }
  }
}

function reportComponent(
  item: WorkspacePackage,
  component: readonly string[],
  modulesByPath: ReadonlyMap<string, SourceModule>,
  findings: WorkspaceFinding[],
): void {
  const members = component
    .map((path) => modulesByPath.get(path)?.relativePath)
    .filter((path): path is string => path !== undefined)
    .sort((left, right) => left.localeCompare(right));
  const [owner] = members;
  if (owner !== undefined) {
    addFinding(
      findings,
      "source-module-cycle",
      `${item.relativeRoot}/${owner}`,
      `source dependency SCC: ${members.join(" <-> ")}`,
    );
  }
}

interface TarjanState {
  nextIndex: number;
  indexByNode: Map<string, number>;
  lowLinkByNode: Map<string, number>;
  stack: string[];
  active: Set<string>;
  components: string[][];
}

function stronglyConnectedComponents(
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const state: TarjanState = {
    nextIndex: 0,
    indexByNode: new Map(),
    lowLinkByNode: new Map(),
    stack: [],
    active: new Set(),
    components: [],
  };
  const visit = (node: string): void => {
    const index = state.nextIndex;
    state.nextIndex += 1;
    state.indexByNode.set(node, index);
    state.lowLinkByNode.set(node, index);
    state.stack.push(node);
    state.active.add(node);
    for (const target of edges.get(node) ?? []) {
      visitEdge(node, target, index, state, visit);
    }
    if (state.lowLinkByNode.get(node) === state.indexByNode.get(node)) {
      state.components.push(popComponent(node, state));
    }
  };
  for (const node of [...edges.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (!state.indexByNode.has(node)) {
      visit(node);
    }
  }
  return state.components;
}

function visitEdge(
  node: string,
  target: string,
  fallback: number,
  state: TarjanState,
  visit: (node: string) => void,
): void {
  if (!state.indexByNode.has(target)) {
    visit(target);
    state.lowLinkByNode.set(
      node,
      Math.min(
        state.lowLinkByNode.get(node) ?? fallback,
        state.lowLinkByNode.get(target) ?? fallback,
      ),
    );
  } else if (state.active.has(target)) {
    state.lowLinkByNode.set(
      node,
      Math.min(
        state.lowLinkByNode.get(node) ?? fallback,
        state.indexByNode.get(target) ?? fallback,
      ),
    );
  }
}

function popComponent(node: string, state: TarjanState): string[] {
  const component: string[] = [];
  while (state.stack.length > 0) {
    const member = state.stack.pop();
    if (member === undefined) {
      break;
    }
    state.active.delete(member);
    component.push(member);
    if (member === node) {
      break;
    }
  }
  return component.sort((left, right) => left.localeCompare(right));
}
