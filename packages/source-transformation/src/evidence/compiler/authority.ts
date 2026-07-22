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
const issuedReceipts = new WeakMap<
  CompilerEvidenceReceipt,
  Readonly<{ authority: TypeScriptCompilerAuthority }>
>();
const advancedReceipts = new WeakSet<CompilerEvidenceReceipt>();

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
  if (!validPredecessor(authority, input)) {
    return rejected("COMPILER_CHAIN_REJECTED");
  }
  if (input.predecessor !== null) advancedReceipts.add(input.predecessor);
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
      predecessorReceiptDigest: input.predecessor?.receiptDigest ?? null,
      targets,
      strictFlags,
      compiler: compilerReceipt,
      symbolIndex,
    };
    const receipt: CompilerEvidenceReceipt = Object.freeze({
      ...material,
      receiptDigest: digestText(JSON.stringify(material)),
    });
    issuedReceipts.set(receipt, Object.freeze({ authority }));
    return Object.freeze({ status: "accepted", receipt });
  } catch {
    return rejected("COMPILER_AUTHORITY_REJECTED");
  }
}

function validPredecessor(
  authority: TypeScriptCompilerAuthority,
  input: import("./authority-state.ts").ParsedCompilerInput,
): boolean {
  const predecessor = input.predecessor;
  if (predecessor === null) return input.bindings.epoch === 1;
  const issued = issuedReceipts.get(predecessor);
  return (
    issued?.authority === authority &&
    !advancedReceipts.has(predecessor) &&
    predecessor.epochKind !== "format" &&
    input.bindings.epoch === predecessor.epoch + 1 &&
    input.bindings.predecessorCandidateSetDigest ===
      predecessor.candidateSetDigest &&
    input.bindings.targetSetDigest === predecessor.targetSetDigest &&
    input.bindings.requestDigest === predecessor.requestDigest &&
    input.bindings.repositoryId === predecessor.repositoryId &&
    input.bindings.rootIdentity === predecessor.rootIdentity &&
    input.bindings.treeDigest === predecessor.treeDigest &&
    input.bindings.configDigest === predecessor.configDigest
  );
}

function rejected(
  code: Extract<CompilerEvidenceResult, { status: "rejected" }>["code"],
  diagnostics?: CompilerEvidenceReceipt["compiler"]["diagnostics"],
): CompilerEvidenceResult {
  return diagnostics === undefined
    ? Object.freeze({ status: "rejected", code })
    : Object.freeze({ status: "rejected", code, diagnostics });
}
