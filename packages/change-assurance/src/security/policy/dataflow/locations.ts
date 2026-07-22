// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes AST APIs through unstable package exports.
import {
  type Expression,
  isElementAccessExpression,
  isIdentifier,
  isNumericLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
} from "typescript/unstable/ast";

export interface LocationEnvironment<Value> {
  readonly aliases: Map<string, string>;
  readonly values: Map<string, Value>;
}

export function createLocationEnvironment<Value>(): LocationEnvironment<Value> {
  return { aliases: new Map(), values: new Map() };
}

export function cloneLocationEnvironment<Value>(
  environment: LocationEnvironment<Value>,
): LocationEnvironment<Value> {
  return {
    aliases: new Map(environment.aliases),
    values: new Map(environment.values),
  };
}

export function bindLocationAlias<Value>(
  name: string,
  initializer: Expression | undefined,
  environment: LocationEnvironment<Value>,
): void {
  let location: string | undefined;
  if (initializer !== undefined) {
    location = expressionLocation(initializer, environment);
  }
  environment.aliases.set(name, location ?? name);
}

export function expressionLocation<Value>(
  expression: Expression,
  environment: LocationEnvironment<Value>,
): string | undefined {
  if (isParenthesizedExpression(expression)) {
    return expressionLocation(expression.expression, environment);
  }
  if (isIdentifier(expression)) {
    return resolveAlias(expression.text, environment.aliases);
  }
  if (isPropertyAccessExpression(expression)) {
    const base = expressionLocation(expression.expression, environment);
    if (base === undefined) return;
    return `${base}.${expression.name.text}`;
  }
  if (isElementAccessExpression(expression)) {
    const base = expressionLocation(expression.expression, environment);
    if (base === undefined) return;
    const argument = expression.argumentExpression;
    if (argument === undefined) return `${base}.*`;
    if (isStringLiteral(argument) || isNumericLiteral(argument)) {
      return `${base}.${argument.text}`;
    }
    return `${base}.*`;
  }
  return undefined;
}

export function locationValues<Value>(
  expression: Expression,
  environment: LocationEnvironment<Value>,
): readonly Value[] {
  const location = expressionLocation(expression, environment);
  if (location === undefined) return [];
  if (location.endsWith(".*")) {
    const prefix = location.slice(0, -1);
    return [...environment.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value);
  }
  const exact = environment.values.get(location);
  const separator = location.lastIndexOf(".");
  const wildcard =
    separator < 0
      ? undefined
      : environment.values.get(`${location.slice(0, separator)}.*`);
  return [exact, wildcard].filter(
    (value): value is Value => value !== undefined,
  );
}

function resolveAlias(
  name: string,
  aliases: ReadonlyMap<string, string>,
): string {
  let current = name;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const next = aliases.get(current);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}
