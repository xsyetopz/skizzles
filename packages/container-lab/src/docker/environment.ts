import { dockerClientEnvironmentNames } from "../lab/environment.ts";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Construct the complete host environment visible to the Docker CLI process. */
export function dockerClientEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return selectPresentEnvironment(dockerClientEnvironmentNames, environment);
}

/**
 * Construct the non-secret environment for one persisted Compose runtime.
 * Manifest names are exact capabilities; ambient prefix matches are never used.
 */
export function composeInvocationEnvironment(
  composeNames: readonly string[],
  forwardNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = dockerClientEnvironment(environment);
  copyPresentEnvironment(result, composeNames, environment);
  copyPresentEnvironment(result, forwardNames, environment);
  return result;
}

/** Add required secret sources only at the resource-creating `compose up` boundary. */
export function composeUpEnvironment(
  composeNames: readonly string[],
  forwardNames: readonly string[],
  secretNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = composeInvocationEnvironment(
    composeNames,
    forwardNames,
    environment,
  );
  for (const name of secretNames) {
    if (name.startsWith("COMPOSE_")) {
      throw new Error(`reserved Compose environment variable: ${name}`);
    }
    if (Object.hasOwn(result, name)) {
      throw new Error(
        `secret environment variable conflicts with a non-secret Docker capability: ${name}`,
      );
    }
    const value = environment[name];
    if (!Object.hasOwn(environment, name) || typeof value !== "string") {
      throw new Error(`secret environment variable is unavailable: ${name}`);
    }
    Object.defineProperty(result, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return result;
}

function selectPresentEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  copyPresentEnvironment(result, names, environment);
  return result;
}

function copyPresentEnvironment(
  target: NodeJS.ProcessEnv,
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  for (const name of names) {
    if (name.startsWith("COMPOSE_")) {
      continue;
    }
    const value = environment[name];
    if (Object.hasOwn(environment, name) && typeof value === "string") {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
