import type {
  ParsedSecuritySource,
  SecurityImportAudit,
} from "../../contract.ts";

export const cryptoModules = new Set(["crypto", "node:crypto"]);
export const sessionModules = new Set([
  "express-session",
  "express-session-cookie-store",
  "jsonwebtoken",
  "jose",
  "passport",
]);
export const rawExecutionModules = new Set([
  "child_process",
  "node:child_process",
]);
export const rawDatabaseModules = new Set([
  "pg",
  "mysql",
  "mysql2",
  "better-sqlite3",
  "drizzle-orm",
]);
export const rawNetworkModules = new Set([
  "http",
  "https",
  "node:http",
  "node:https",
  "node:net",
]);
export const cryptoNames = new Set([
  "createHash",
  "createHmac",
  "createCipheriv",
  "createDecipheriv",
  "randomBytes",
  "randomUUID",
  "pbkdf2",
  "scrypt",
  "timingSafeEqual",
]);
export const sessionNames = new Set([
  "createSession",
  "rotateSession",
  "refreshSession",
  "destroySession",
  "serializeSession",
  "parseSession",
  "signSession",
  "verifySession",
]);
export const cryptoDeclarationNames = new Set([
  "encrypt",
  "decrypt",
  "hashPassword",
  "verifyPassword",
  "deriveKey",
  "generateToken",
]);
export const sessionDeclarationNames = new Set([
  "createSession",
  "rotateSession",
  "refreshSession",
  "destroySession",
  "serializeSession",
  "parseSession",
]);
export const rateNames = new Set(["rateLimit", "rateLimiter", "withRateLimit"]);
export const auditNames = new Set([
  "auditLog",
  "auditLogger",
  "withAuditLog",
  "recordAudit",
]);
export const sanitizerNames = new Set([
  "sanitize",
  "sanitizeInput",
  "withSanitize",
  "withSanitization",
  "validateInput",
]);

export function hasMiddleware(
  source: ParsedSecuritySource,
  middleware: string,
): boolean {
  const names =
    middleware === "rate-limit"
      ? rateNames
      : middleware === "audit-log"
        ? auditNames
        : sanitizerNames;
  return [...source.middlewareNames].some((name) => names.has(name));
}

export function hasImport(
  source: ParsedSecuritySource,
  module: string,
  names: readonly string[],
): boolean {
  const imported = source.imports.get(module);
  return (
    imported !== undefined && names.every((name) => imported.includes(name))
  );
}

export function isAuditedCapability(
  audit: SecurityImportAudit | undefined,
  capability: SecurityImportAudit["capability"],
): boolean {
  return audit?.capability === capability;
}

export function rawCapabilityFor(
  module: string,
): "execution" | "database" | "network" | undefined {
  if (rawExecutionModules.has(module)) return "execution";
  if (rawDatabaseModules.has(module)) return "database";
  if (rawNetworkModules.has(module)) return "network";
}

export function sensitiveModule(module: string): boolean {
  return (
    cryptoModules.has(module) ||
    sessionModules.has(module) ||
    module.includes("/auth") ||
    module.includes("/crypto") ||
    module.includes("/session")
  );
}

export function hasConfiguredSecureInterface(
  source: ParsedSecuritySource,
  config: {
    readonly secureInterfaces: readonly {
      readonly interfaceId: string;
      readonly module: string;
      readonly imports: readonly string[];
    }[];
  },
  interfaceIds: readonly string[],
): boolean {
  return interfaceIds.some((interfaceId) => {
    const rule = config.secureInterfaces.find(
      ({ interfaceId: candidateId }) => candidateId === interfaceId,
    );
    return rule !== undefined && hasImport(source, rule.module, rule.imports);
  });
}
