import type {
  MigrationOperationKind,
  ParsedStatement,
  SqlToken,
} from "./contracts.ts";

export function splitStatements(
  tokens: readonly SqlToken[],
): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  let current: SqlToken[] = [];
  let index = 0;
  for (const token of tokens) {
    if (token.value === ";") {
      if (current.length > 0) {
        statements.push({ tokens: current, statementIndex: index });
        index += 1;
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0)
    statements.push({ tokens: current, statementIndex: index });
  return statements;
}

export function hasToken(tokens: readonly SqlToken[], value: string): boolean {
  return tokens.some((token) => token.value === value);
}

function startsWith(
  tokens: readonly SqlToken[],
  values: readonly string[],
): boolean {
  return values.every((value, index) => tokens[index]?.value === value);
}

export function statementKind(
  tokens: readonly SqlToken[],
): MigrationOperationKind | undefined {
  if (
    startsWith(tokens, ["CREATE", "TABLE"]) ||
    startsWith(tokens, ["CREATE", "TABLE", "IF", "NOT", "EXISTS"])
  )
    return "create-table";
  if (
    startsWith(tokens, ["CREATE", "INDEX"]) ||
    startsWith(tokens, ["CREATE", "UNIQUE", "INDEX"]) ||
    startsWith(tokens, ["CREATE", "INDEX", "CONCURRENTLY"])
  )
    return "create-index";
  if (startsWith(tokens, ["CREATE", "SEQUENCE"])) return "create-sequence";
  if (startsWith(tokens, ["CREATE", "TYPE"])) return "create-type";
  if (startsWith(tokens, ["UPDATE"])) return "update";
  if (startsWith(tokens, ["INSERT"]) && hasToken(tokens, "SELECT"))
    return "insert-select";
  if (startsWith(tokens, ["DROP", "TABLE"])) return "drop-table";
  if (startsWith(tokens, ["DROP", "INDEX"])) return "drop-index";
  if (startsWith(tokens, ["DROP", "TYPE"])) return "drop-type";
  return undefined;
}

export function canonicalTokens(tokens: readonly SqlToken[]): string {
  return tokens.map((token) => `${token.kind}:${token.value}`).join("|");
}
