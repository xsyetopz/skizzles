import { PackagingError } from "../plugin/contract.ts";
import { safeLanguageDiagnosticPath } from "./file-boundary.ts";

const SYNTAX_ERROR_NAME = "LanguageSurfaceSyntaxError";

export function syntaxError(path: string, format: string): PackagingError {
  const error = new PackagingError(
    `Shipped language surface ${safeLanguageDiagnosticPath(path)} is not valid bounded ${format}.`,
  );
  error.name = SYNTAX_ERROR_NAME;
  return error;
}

export function isLanguageSurfaceSyntaxError(error: unknown): boolean {
  return error instanceof PackagingError && error.name === SYNTAX_ERROR_NAME;
}

export function boundsError(path: string): PackagingError {
  return new PackagingError(
    `Shipped language surface ${safeLanguageDiagnosticPath(path)} exceeds semantic scan bounds.`,
  );
}

export function policyError(path: string, policy: string): PackagingError {
  return new PackagingError(
    `Shipped language surface ${safeLanguageDiagnosticPath(path)} violates bounded ${policy}.`,
  );
}
