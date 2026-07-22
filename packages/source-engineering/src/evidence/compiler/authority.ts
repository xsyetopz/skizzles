import { digestText } from "../../digest.ts";
import { inspectSymbols } from "./advisory.ts";
import type { TrustedCompilerState } from "./authority-state.ts";
import { currentConfigMatches, parseAuthorityConfig } from "./config.ts";
import type {
  CompilerEvidenceReceipt,
  CompilerEvidenceResult,
  TypeScriptCompilerAuthority,
  TypeScriptCompilerAuthorityCreationResult,
} from "./contract.ts";
import { parseCompilerInput } from "./input.ts";
import { runTypeScriptCompiler } from "./typescript.ts";

const authorities = new WeakMap<object, TrustedCompilerState>();

export function createTypeScriptCompilerAuthority(
  input: unknown,
): TypeScriptCompilerAuthorityCreationResult {
  const state = parseAuthorityConfig(input);
  if (state === undefined)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_COMPILER_CONFIG",
    });
  const authority: TypeScriptCompilerAuthority = Object.freeze({
    kind: "typescript-7-compiler-authority",
  });
  authorities.set(authority, state);
  return Object.freeze({ status: "created", authority });
}

export function isTypeScriptCompilerAuthority(
  value: unknown,
): value is TypeScriptCompilerAuthority {
  return typeof value === "object" && value !== null && authorities.has(value);
}

export async function captureCompilerEvidence(
  authority: unknown,
  value: unknown,
): Promise<CompilerEvidenceResult> {
  if (!isTypeScriptCompilerAuthority(authority))
    return rejected("UNAUTHENTIC_COMPILER_AUTHORITY");
  const state = authorities.get(authority);
  if (state === undefined) return rejected("UNAUTHENTIC_COMPILER_AUTHORITY");
  const input = parseCompilerInput(value, state);
  if (input === undefined) return rejected("INVALID_COMPILER_EVIDENCE_INPUT");
  if (input === "stale") return rejected("STALE_COMPILER_BINDINGS");
  if (input === "candidate-stale") return rejected("STALE_CANDIDATE");
  if (!currentConfigMatches(state)) return rejected("STALE_COMPILER_BINDINGS");
  try {
    const compiler = await runTypeScriptCompiler(state, input);
    if (!compiler.allTargetsIncluded) {
      return rejected("STALE_CANDIDATE");
    }
    if (!compiler.strict)
      return rejected("STRICT_FLAGS_REJECTED", compiler.diagnostics);
    if (compiler.diagnostics.some(({ severity }) => severity === "error"))
      return rejected("COMPILER_REJECTED", compiler.diagnostics);
    const symbolIndex = await inspectSymbols(state.symbols, input);
    const targets = Object.freeze(
      input.targets.map(({ path, candidateDigest, semanticDigest }) =>
        Object.freeze({ path, candidateDigest, semanticDigest }),
      ),
    );
    const strictFlags: CompilerEvidenceReceipt["strictFlags"] = Object.freeze({
      strict: true,
      noImplicitAny: true,
      strictNullChecks: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      useUnknownInCatchVariables: true,
    });
    const compilerReceipt: CompilerEvidenceReceipt["compiler"] = Object.freeze({
      passed: true,
      exitCode: 0,
      diagnostics: compiler.diagnostics,
      outputDigest: compiler.outputDigest,
    });
    const material = {
      ...input.bindings,
      targets,
      strictFlags,
      compiler: compilerReceipt,
      symbolIndex,
    };
    const receipt: CompilerEvidenceReceipt = Object.freeze({
      ...material,
      receiptDigest: digestText(JSON.stringify(material)),
    });
    return Object.freeze({ status: "accepted", receipt });
  } catch {
    return rejected("COMPILER_AUTHORITY_REJECTED");
  }
}

function rejected(
  code: Extract<CompilerEvidenceResult, { status: "rejected" }>["code"],
  diagnostics?: CompilerEvidenceReceipt["compiler"]["diagnostics"],
): CompilerEvidenceResult {
  return diagnostics === undefined
    ? Object.freeze({ status: "rejected", code })
    : Object.freeze({ status: "rejected", code, diagnostics });
}
