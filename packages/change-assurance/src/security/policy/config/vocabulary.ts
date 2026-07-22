import type {
  SecurityImportAudit,
  SecurityInterfaceRule,
  SecurityMiddleware,
  SecuritySinkRule,
} from "../../contract.ts";

const middleware: ReadonlySet<string> = new Set([
  "rate-limit",
  "audit-log",
  "sanitize",
]);

export function isMiddleware(value: string): value is SecurityMiddleware {
  return middleware.has(value);
}

export function isImportCapability(
  value: unknown,
): value is SecurityImportAudit["capability"] {
  return (
    value === "middleware" ||
    value === "session" ||
    value === "execution" ||
    value === "database" ||
    value === "network"
  );
}

export function isInterfaceCapability(
  value: unknown,
): value is SecurityInterfaceRule["capability"] {
  return (
    value === "session" ||
    value === "execution" ||
    value === "database" ||
    value === "network"
  );
}

export function isSinkCapability(
  value: unknown,
): value is SecuritySinkRule["capability"] {
  return value === "execution" || value === "database" || value === "network";
}
