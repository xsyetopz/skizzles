// biome-ignore-all lint/correctness/noUnresolvedImports: TypeScript 7 exposes its parsed AST through this unstable package export.
import { posix } from "node:path";
import {
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isInterfaceDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { type Digest, digestText } from "../digest.ts";
import { semanticDigest } from "./editor.ts";
import { parseTypeScriptSource } from "./parser.ts";

const maximumDocuments = 4096;
const maximumPackages = 4096;
const maximumDocumentBytes = 4 * 1024 * 1024;
const maximumTotalBytes = 64 * 1024 * 1024;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const packagePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;

export interface SymbolIndexCaptureRequest {
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: Digest;
  readonly configDigest: Digest;
}

export interface TypeScriptSymbolIndexAuthorityPort {
  capture(input: SymbolIndexCaptureRequest): unknown | Promise<unknown>;
}

export type IndexedDeclarationKind =
  | "class"
  | "enum"
  | "function"
  | "interface"
  | "type";

export interface IndexedTypeScriptDeclaration {
  readonly kind: IndexedDeclarationKind;
  readonly name: string;
  readonly path: string;
  readonly nodeDigest: Digest;
}

export interface IndexedTypeScriptModule {
  readonly kind: "export" | "import";
  readonly path: string;
  readonly specifier: string;
}

export interface LocalTypeScriptSymbolIndex extends SymbolIndexCaptureRequest {
  readonly advisory: true;
  readonly packages: readonly string[];
  readonly sourcePaths: readonly string[];
  readonly declarations: readonly IndexedTypeScriptDeclaration[];
  readonly modules: readonly IndexedTypeScriptModule[];
  readonly indexDigest: Digest;
}

export type SymbolIndexBuildResult =
  | Readonly<{ status: "indexed"; index: LocalTypeScriptSymbolIndex }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_INDEX_INPUT"
        | "INVALID_INDEX_AUTHORITY"
        | "INDEX_CAPTURE_REJECTED"
        | "INDEX_CAPTURE_INVALID"
        | "INDEX_CAPTURE_INCOMPLETE"
        | "INDEX_BINDING_STALE"
        | "INDEX_DOCUMENT_INVALID"
        | "INDEX_SYNTAX_REJECTED";
    }>;

export type ImportVerificationResult =
  | Readonly<{
      status: "verified";
      advisory: true;
      result: "found" | "missing";
      matchedBy: "package" | "source" | null;
    }>
  | Readonly<{
      status: "rejected";
      code: "INVALID_INDEX" | "INVALID_IMPORT_QUERY";
    }>;

interface CapturedDocument {
  readonly path: string;
  readonly text: string;
  readonly digest: Digest;
}

interface CapturedIndex extends SymbolIndexCaptureRequest {
  readonly complete: true;
  readonly packages: readonly string[];
  readonly documents: readonly CapturedDocument[];
}

const authenticIndexes = new WeakSet<object>();

export async function buildLocalTypeScriptSymbolIndex(
  authority: TypeScriptSymbolIndexAuthorityPort,
  input: unknown,
): Promise<SymbolIndexBuildResult> {
  const request = parseRequest(input);
  if (request === undefined) return rejected("INVALID_INDEX_INPUT");
  if (!validAuthority(authority)) return rejected("INVALID_INDEX_AUTHORITY");
  let rawCapture: unknown;
  try {
    rawCapture = await authority.capture(request);
  } catch {
    return rejected("INDEX_CAPTURE_REJECTED");
  }
  const capture = parseCapture(rawCapture);
  if (capture === "incomplete") return rejected("INDEX_CAPTURE_INCOMPLETE");
  if (capture === undefined) return rejected("INDEX_CAPTURE_INVALID");
  if (!sameBinding(request, capture)) return rejected("INDEX_BINDING_STALE");

  const declarations: IndexedTypeScriptDeclaration[] = [];
  const modules: IndexedTypeScriptModule[] = [];
  for (const document of capture.documents) {
    const parsed = await parseTypeScriptSource({
      targetPath: document.path,
      sourceText: document.text,
    });
    if (parsed.status !== "parsed") return rejected("INDEX_SYNTAX_REJECTED");
    declarations.push(
      ...collectDeclarations(document.path, parsed.parsed.sourceFile),
    );
    modules.push(...collectModules(document.path, parsed.parsed.sourceFile));
  }
  declarations.sort(compareDeclarations);
  modules.sort(compareModules);
  const packages = [...capture.packages].sort(compareText);
  const sourcePaths = capture.documents
    .map(({ path }) => path)
    .sort(compareText);
  const indexMaterial = {
    ...request,
    advisory: true,
    packages,
    sourcePaths,
    declarations: declarations.map(({ kind, name, path, nodeDigest }) => ({
      kind,
      name,
      path,
      nodeDigest,
    })),
    modules: modules.map(({ kind, path, specifier }) => ({
      kind,
      path,
      specifier,
    })),
  } as const;
  const index: LocalTypeScriptSymbolIndex = Object.freeze({
    ...indexMaterial,
    packages: Object.freeze(packages),
    sourcePaths: Object.freeze(sourcePaths),
    declarations: Object.freeze(
      declarations.map((declaration) => Object.freeze(declaration)),
    ),
    modules: Object.freeze(modules.map((module) => Object.freeze(module))),
    indexDigest: digestText(JSON.stringify(indexMaterial)),
  });
  authenticIndexes.add(index);
  return Object.freeze({ status: "indexed", index });
}

export function verifyImport(
  index: unknown,
  query: unknown,
): ImportVerificationResult {
  if (!isAuthenticIndex(index)) {
    return Object.freeze({ status: "rejected", code: "INVALID_INDEX" });
  }
  const parsed = parseImportQuery(query);
  if (parsed === undefined || !index.sourcePaths.includes(parsed.fromPath)) {
    return Object.freeze({ status: "rejected", code: "INVALID_IMPORT_QUERY" });
  }
  if (!parsed.specifier.startsWith(".")) {
    const packageName = packageNameOf(parsed.specifier);
    const found = index.packages.includes(packageName);
    return Object.freeze({
      status: "verified",
      advisory: true,
      result: found ? "found" : "missing",
      matchedBy: found ? "package" : null,
    });
  }
  const base = posix.normalize(
    posix.join(posix.dirname(parsed.fromPath), parsed.specifier),
  );
  if (base === ".." || base.startsWith("../")) {
    return Object.freeze({ status: "rejected", code: "INVALID_IMPORT_QUERY" });
  }
  const candidates = sourceCandidates(base);
  const found = candidates.some((candidate) =>
    index.sourcePaths.includes(candidate),
  );
  return Object.freeze({
    status: "verified",
    advisory: true,
    result: found ? "found" : "missing",
    matchedBy: found ? "source" : null,
  });
}

function isAuthenticIndex(value: unknown): value is LocalTypeScriptSymbolIndex {
  return (
    typeof value === "object" && value !== null && authenticIndexes.has(value)
  );
}

function collectDeclarations(
  path: string,
  sourceFile: SourceFile,
): IndexedTypeScriptDeclaration[] {
  const values: IndexedTypeScriptDeclaration[] = [];
  for (const node of sourceFile.statements) {
    const identity = declarationIdentity(node);
    if (identity !== undefined) {
      values.push(
        Object.freeze({ ...identity, path, nodeDigest: semanticDigest(node) }),
      );
    }
  }
  return values;
}

function declarationIdentity(
  node: Node,
):
  | { readonly kind: IndexedDeclarationKind; readonly name: string }
  | undefined {
  if (isFunctionDeclaration(node) && node.name !== undefined) {
    return { kind: "function", name: node.name.text };
  }
  if (isClassDeclaration(node) && node.name !== undefined) {
    return { kind: "class", name: node.name.text };
  }
  if (isInterfaceDeclaration(node))
    return { kind: "interface", name: node.name.text };
  if (isTypeAliasDeclaration(node))
    return { kind: "type", name: node.name.text };
  if (isEnumDeclaration(node)) return { kind: "enum", name: node.name.text };
  return;
}

function collectModules(
  path: string,
  sourceFile: SourceFile,
): IndexedTypeScriptModule[] {
  const values: IndexedTypeScriptModule[] = [];
  for (const node of sourceFile.statements) {
    const identity = moduleIdentity(node);
    if (identity !== undefined)
      values.push(Object.freeze({ ...identity, path }));
  }
  return values;
}

function moduleIdentity(
  node: Node,
):
  | { readonly kind: "export" | "import"; readonly specifier: string }
  | undefined {
  if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
    return { kind: "import", specifier: node.moduleSpecifier.text };
  }
  if (
    isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    isStringLiteral(node.moduleSpecifier)
  ) {
    return { kind: "export", specifier: node.moduleSpecifier.text };
  }
  if (
    isImportEqualsDeclaration(node) &&
    isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression !== undefined &&
    isStringLiteral(node.moduleReference.expression)
  ) {
    return { kind: "import", specifier: node.moduleReference.expression.text };
  }
  return;
}

function parseRequest(input: unknown): SymbolIndexCaptureRequest | undefined {
  const record = snapshotRecord(input);
  if (
    record === undefined ||
    !exactKeys(record, [
      "repositoryId",
      "rootIdentity",
      "treeDigest",
      "configDigest",
    ])
  )
    return;
  const repositoryId = record.get("repositoryId");
  const rootIdentity = record.get("rootIdentity");
  const treeDigest = record.get("treeDigest");
  const configDigest = record.get("configDigest");
  if (
    !(
      boundedIdentity(repositoryId) &&
      boundedIdentity(rootIdentity) &&
      isDigest(treeDigest) &&
      isDigest(configDigest)
    )
  )
    return;
  return Object.freeze({
    repositoryId,
    rootIdentity,
    treeDigest,
    configDigest,
  });
}

function parseCapture(
  value: unknown,
): CapturedIndex | "incomplete" | undefined {
  const record = snapshotRecord(value, true);
  if (
    record === undefined ||
    !exactKeys(record, [
      "repositoryId",
      "rootIdentity",
      "treeDigest",
      "configDigest",
      "complete",
      "packages",
      "documents",
    ])
  )
    return;
  if (record.get("complete") !== true) return "incomplete";
  const request = parseRequest(
    Object.fromEntries(
      [...record].filter(
        ([key]) =>
          key !== "complete" && key !== "packages" && key !== "documents",
      ),
    ),
  );
  const packages = record.get("packages");
  const documents = record.get("documents");
  if (
    request === undefined ||
    !Array.isArray(packages) ||
    !Object.isFrozen(packages) ||
    packages.length > maximumPackages ||
    !Array.isArray(documents) ||
    !Object.isFrozen(documents) ||
    documents.length === 0 ||
    documents.length > maximumDocuments
  )
    return;
  const parsedPackages: string[] = [];
  const seenPackages = new Set<string>();
  for (const item of packages) {
    if (
      typeof item !== "string" ||
      !packagePattern.test(item) ||
      seenPackages.has(item)
    )
      return;
    seenPackages.add(item);
    parsedPackages.push(item);
  }
  const parsedDocuments: CapturedDocument[] = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  for (const item of documents) {
    const document = parseDocument(item);
    if (document === undefined || seenPaths.has(document.path)) return;
    seenPaths.add(document.path);
    totalBytes += Buffer.byteLength(document.text);
    if (totalBytes > maximumTotalBytes) return;
    parsedDocuments.push(document);
  }
  return Object.freeze({
    ...request,
    complete: true,
    packages: Object.freeze(parsedPackages),
    documents: Object.freeze(parsedDocuments),
  });
}

function parseDocument(value: unknown): CapturedDocument | undefined {
  const record = snapshotRecord(value, true);
  if (record === undefined || !exactKeys(record, ["path", "text", "digest"]))
    return;
  const path = record.get("path");
  const text = record.get("text");
  const digest = record.get("digest");
  if (
    typeof path !== "string" ||
    !validSourcePath(path) ||
    typeof text !== "string" ||
    !validUtf8Text(text) ||
    Buffer.byteLength(text) > maximumDocumentBytes ||
    !isDigest(digest) ||
    digestText(text) !== digest
  )
    return;
  return Object.freeze({ path, text, digest });
}

function parseImportQuery(
  value: unknown,
): { fromPath: string; specifier: string } | undefined {
  const record = snapshotRecord(value);
  if (record === undefined || !exactKeys(record, ["fromPath", "specifier"]))
    return;
  const fromPath = record.get("fromPath");
  const specifier = record.get("specifier");
  if (
    typeof fromPath !== "string" ||
    !validSourcePath(fromPath) ||
    typeof specifier !== "string" ||
    specifier.length === 0 ||
    specifier.length > 1024 ||
    specifier.includes("\0") ||
    specifier.includes("\\")
  )
    return;
  return { fromPath, specifier };
}

function snapshotRecord(
  value: unknown,
  requireFrozen = false,
): ReadonlyMap<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return;
    if (requireFrozen && !Object.isFrozen(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const result = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return;
      result.set(key, descriptor.value);
    }
    return result;
  } catch {}
  return;
}

function exactKeys(
  record: ReadonlyMap<string, unknown>,
  keys: readonly string[],
): boolean {
  return record.size === keys.length && keys.every((key) => record.has(key));
}

function validAuthority(
  value: unknown,
): value is TypeScriptSymbolIndexAuthorityPort {
  const record = snapshotRecord(value);
  return (
    record !== undefined &&
    record.size === 1 &&
    typeof record.get("capture") === "function"
  );
}

function sameBinding(
  left: SymbolIndexCaptureRequest,
  right: SymbolIndexCaptureRequest,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.rootIdentity === right.rootIdentity &&
    left.treeDigest === right.treeDigest &&
    left.configDigest === right.configDigest
  );
}

function validSourcePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    ![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].some(
      (extension) => value.endsWith(extension),
    )
  )
    return false;
  const normalized = posix.normalize(value);
  return (
    normalized === value && normalized !== ".." && !normalized.startsWith("../")
  );
}

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\0")
  );
}

function validUtf8Text(value: string): boolean {
  try {
    const bytes = new TextEncoder().encode(value);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value;
  } catch {
    return false;
  }
}

function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

function sourceCandidates(base: string): readonly string[] {
  const extensions = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ] as const;
  if (extensions.some((extension) => base.endsWith(extension))) return [base];
  return [
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => `${base}/index${extension}`),
  ];
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDeclarations(
  left: IndexedTypeScriptDeclaration,
  right: IndexedTypeScriptDeclaration,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.kind, right.kind) ||
    compareText(left.name, right.name) ||
    compareText(left.nodeDigest, right.nodeDigest)
  );
}

function compareModules(
  left: IndexedTypeScriptModule,
  right: IndexedTypeScriptModule,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.kind, right.kind) ||
    compareText(left.specifier, right.specifier)
  );
}

function rejected(
  code: Extract<SymbolIndexBuildResult, { status: "rejected" }>["code"],
): SymbolIndexBuildResult {
  return Object.freeze({ status: "rejected", code });
}
