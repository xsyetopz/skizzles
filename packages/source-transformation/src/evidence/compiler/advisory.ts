import { digestBytes, digestText } from "../../digest.ts";
import type { ParsedCompilerInput } from "./authority-state.ts";
import type {
  CompilerEvidenceReceipt,
  CompilerSymbolAuthorityPort,
} from "./contract.ts";
import { exactRecord } from "./input-validation.ts";

export async function inspectSymbols(
  authority: CompilerSymbolAuthorityPort | undefined,
  input: ParsedCompilerInput,
): Promise<CompilerEvidenceReceipt["symbolIndex"]> {
  if (authority === undefined)
    return result("missing", [], digestText("missing"));
  const request = Object.freeze({
    ...input.bindings,
    targets: Object.freeze(
      input.targets.map(({ path, candidateDigest, semanticDigest }) =>
        Object.freeze({ path, candidateDigest, semanticDigest }),
      ),
    ),
  });
  try {
    const raw = await authority.inspect(request);
    const parsed = parseResult(raw);
    if (parsed === undefined)
      return result("failed", [], digestText("invalid"));
    return result(parsed.status, parsed.unresolved, parsed.outputDigest);
  } catch {
    return result("failed", [], digestText("rejected"));
  }
}

function parseResult(value: unknown):
  | Readonly<{
      status: "passed" | "failed" | "missing";
      unresolved: readonly string[];
      outputDigest: `sha256:${string}`;
    }>
  | undefined {
  const record = exactRecord(value, ["status", "unresolved", "outputBytes"]);
  const status = record?.get("status");
  const unresolved = record?.get("unresolved");
  const bytes = record?.get("outputBytes");
  if (
    (status !== "passed" && status !== "failed" && status !== "missing") ||
    !Array.isArray(unresolved) ||
    !Array.isArray(bytes)
  )
    return;
  const names: string[] = [];
  for (const name of unresolved) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 512 ||
      names.includes(name)
    )
      return;
    names.push(name);
  }
  const output = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255
    )
      return;
    output[index] = byte;
  }
  if (status === "passed" && names.length !== 0) return;
  return Object.freeze({
    status,
    unresolved: Object.freeze(
      names.sort((left, right) => left.localeCompare(right)),
    ),
    outputDigest: digestBytes(output),
  });
}

function result(
  status: "passed" | "failed" | "missing",
  unresolved: readonly string[],
  outputDigest: `sha256:${string}`,
): CompilerEvidenceReceipt["symbolIndex"] {
  return Object.freeze({
    status,
    unresolved: Object.freeze([...unresolved]),
    outputDigest,
    discrepancy: status !== "passed",
  });
}
