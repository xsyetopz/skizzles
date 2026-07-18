export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function secretComposeEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = scrubSecretEnvironment(names, environment);
  for (const name of names) {
    if (
      Object.hasOwn(environment, name) &&
      typeof environment[name] === "string"
    ) {
      result[name] = environment[name];
    }
  }
  return result;
}

export function scrubSecretEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of names) delete result[name];
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
