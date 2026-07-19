const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Exact non-secret host capabilities accepted by Docker client processes. */
export const dockerClientEnvironmentNames = [
  "PATH",
  "HOME",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_DEFAULT_PLATFORM",
  "DOCKER_CUSTOM_HEADERS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SSH_AUTH_SOCK",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "BUILDKIT_PROGRESS",
] as const;

export function isDockerClientEnvironmentName(name: string): boolean {
  return (dockerClientEnvironmentNames as readonly string[]).includes(name);
}

export type ManifestEnvironmentIssue = {
  path: string[];
  message: string;
};

export type ManifestEnvironmentLists = {
  composeEnvironment: string[];
  environment: string[];
  secretEnvironment: string[];
  issues: ManifestEnvironmentIssue[];
};

/** Parse and cross-check the three manifest environment capability lists. */
export function parseManifestEnvironmentLists(
  manifest: Record<string, unknown>,
): ManifestEnvironmentLists {
  const issues: ManifestEnvironmentIssue[] = [];
  const environment = parseList(manifest["environment"], "environment", issues);
  requireUnique(
    environment,
    "environment",
    "environment forwarding names must be unique",
    issues,
  );
  const composeEnvironment = parseList(
    manifest["compose_environment"],
    "compose_environment",
    issues,
  );
  requireUnique(
    composeEnvironment,
    "compose_environment",
    "Compose environment names must be unique",
    issues,
  );
  const secretEnvironment = parseList(
    manifest["secret_environment"],
    "secret_environment",
    issues,
  );
  requireUnique(
    secretEnvironment,
    "secret_environment",
    "secret environment names must be unique",
    issues,
  );
  for (const name of secretEnvironment) {
    if (isDockerClientEnvironmentName(name)) {
      issues.push({
        path: ["secret_environment"],
        message: `must not overlap fixed Docker client environment: ${name}`,
      });
    }
  }
  rejectOverlap(secretEnvironment, environment, "environment", issues);
  rejectOverlap(
    secretEnvironment,
    composeEnvironment,
    "compose_environment",
    issues,
  );
  return { composeEnvironment, environment, secretEnvironment, issues };
}

function parseList(
  value: unknown,
  field: string,
  issues: ManifestEnvironmentIssue[],
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push({ path: [field], message: "must be an array" });
    return [];
  }
  if (value.length > 64) {
    issues.push({ path: [field], message: "must contain at most 64 items" });
  }
  const parsed: string[] = [];
  for (const [index, item] of value.entries()) {
    if (
      typeof item === "string" &&
      environmentNamePattern.test(item) &&
      !item.startsWith("COMPOSE_")
    ) {
      parsed.push(item);
    } else {
      issues.push({
        path: [field, String(index)],
        message:
          typeof item === "string" && item.startsWith("COMPOSE_")
            ? "must not use the reserved COMPOSE_ prefix"
            : "must be an environment variable name",
      });
    }
  }
  return parsed;
}

function requireUnique(
  names: readonly string[],
  field: string,
  message: string,
  issues: ManifestEnvironmentIssue[],
): void {
  if (new Set(names).size !== names.length) {
    issues.push({ path: [field], message });
  }
}

function rejectOverlap(
  secretNames: readonly string[],
  otherNames: readonly string[],
  otherField: string,
  issues: ManifestEnvironmentIssue[],
): void {
  const overlap = otherNames.filter((name) => secretNames.includes(name));
  if (overlap.length > 0) {
    issues.push({
      path: ["secret_environment"],
      message: `must not overlap ${otherField}: ${overlap.join(", ")}`,
    });
  }
}
