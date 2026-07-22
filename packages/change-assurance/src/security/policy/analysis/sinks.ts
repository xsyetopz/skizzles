import type {
  ParsedSecuritySource,
  SecurityFinding,
  SecurityPolicyConfig,
} from "../../contract.ts";
import { finding } from "./receipts.ts";
import {
  cryptoDeclarationNames,
  cryptoModules,
  cryptoNames,
  hasConfiguredSecureInterface,
  isAuditedCapability,
  rawCapabilityFor,
  sensitiveModule,
  sessionDeclarationNames,
  sessionModules,
  sessionNames,
} from "./rules.ts";

export function inspectImports(
  source: ParsedSecuritySource,
  path: string,
  config: SecurityPolicyConfig,
  findings: SecurityFinding[],
): void {
  for (const [module, importedNames] of source.imports) {
    const audited = config.auditedImports.find(
      (candidate) => candidate.module === module,
    );
    if (
      audited !== undefined &&
      importedNames.some(
        (name) => name !== "*" && !audited.allowedImports.includes(name),
      )
    ) {
      findings.push(
        finding(
          "UNAUDITED_SECURITY_IMPORT",
          path,
          `Import from ${module} is outside its audited allowlist.`,
        ),
      );
    }
    if (
      cryptoModules.has(module) ||
      importedNames.some((name) => cryptoNames.has(name))
    ) {
      findings.push(
        finding(
          "CUSTOM_CRYPTOGRAPHY",
          path,
          `Custom cryptography import ${module} is forbidden.`,
        ),
      );
    }
    if (
      (sessionModules.has(module) ||
        importedNames.some((name) => sessionNames.has(name))) &&
      !isAuditedCapability(audited, "session")
    )
      findings.push(
        finding(
          "CUSTOM_SESSION_MANAGEMENT",
          path,
          `Custom session-management import ${module} is forbidden.`,
        ),
      );
    const rawCapability = rawCapabilityFor(module);
    if (rawCapability !== undefined) {
      const code =
        rawCapability === "execution"
          ? "RAW_EXECUTION_PRIMITIVE"
          : rawCapability === "database"
            ? "RAW_DATABASE_PRIMITIVE"
            : "RAW_NETWORK_PRIMITIVE";
      findings.push(
        finding(
          code,
          path,
          `Raw ${rawCapability} primitive ${module} is forbidden; use a configured secure interface.`,
        ),
      );
    }
    if (audited === undefined && sensitiveModule(module)) {
      findings.push(
        finding(
          "UNAUDITED_SECURITY_IMPORT",
          path,
          `Security-sensitive module ${module} is not in the audited registry.`,
        ),
      );
    }
  }
}

export function inspectDeclarations(
  source: ParsedSecuritySource,
  path: string,
  findings: SecurityFinding[],
): void {
  for (const name of source.declaredNames) {
    const normalized = name.toLowerCase();
    if (
      cryptoDeclarationNames.has(name) ||
      normalized.includes("cryptography")
    ) {
      findings.push(
        finding(
          "CUSTOM_CRYPTOGRAPHY",
          path,
          `Custom cryptography declaration ${name} is forbidden.`,
        ),
      );
    }
    if (
      sessionDeclarationNames.has(name) ||
      normalized.includes("sessionmanagement")
    ) {
      findings.push(
        finding(
          "CUSTOM_SESSION_MANAGEMENT",
          path,
          `Custom session declaration ${name} is forbidden.`,
        ),
      );
    }
  }
}

export function inspectSinks(
  source: ParsedSecuritySource,
  path: string,
  config: SecurityPolicyConfig,
  findings: SecurityFinding[],
): void {
  for (const call of source.callSites) {
    if (call.capability === "unknown") continue;
    const rule = config.sinks.find(
      ({ capability }) => capability === call.capability,
    );
    if (rule === undefined || !rule.names.includes(call.name)) continue;
    if (
      !hasConfiguredSecureInterface(source, config, rule.secureInterfaceIds)
    ) {
      findings.push(
        finding(
          "MISSING_SECURE_INTERFACE",
          path,
          `Sink ${call.name} requires one configured secure interface import.`,
          call.line,
          call.column,
        ),
      );
    }
    if (!call.hasDynamicArgument) continue;
    if (call.hasTemplateSubstitution)
      findings.push(
        finding(
          "UNSAFE_TEMPLATE_TAINT",
          path,
          `Template substitution reaches ${call.capability} sink ${call.name}.`,
          call.line,
          call.column,
        ),
      );
    const code =
      call.capability === "execution"
        ? "UNSAFE_EXECUTION_CONCATENATION"
        : call.capability === "database"
          ? "UNSAFE_DATABASE_CONCATENATION"
          : "UNSAFE_NETWORK_CONCATENATION";
    findings.push(
      finding(
        code,
        path,
        `Dynamic string construction reaches ${call.capability} sink ${call.name}; use a secure interface.`,
        call.line,
        call.column,
      ),
    );
  }
}
