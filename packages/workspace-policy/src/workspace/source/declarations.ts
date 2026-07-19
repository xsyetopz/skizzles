import { type SourceToken, tokenizeSource } from "./lexer.ts";

/** Extract static module declarations that Bun erases before `scanImports`. */
function scanStaticModuleSpecifiers(source: string): string[] {
  const tokens = tokenizeSource(source);
  const specifiers = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word") {
      continue;
    }
    if (token.value === "import") {
      const next = tokens[index + 1];
      if (next?.value === ".") {
        continue;
      }
      if (next?.value === "(") {
        const candidate = tokens[index + 2];
        if (candidate?.kind === "string") {
          specifiers.add(candidate.value);
        }
        continue;
      }
      if (next?.kind === "string") {
        specifiers.add(next.value);
        continue;
      }
      const specifier = declarationSpecifier(tokens, index + 1, true);
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    } else if (token.value === "export") {
      const specifier = declarationSpecifier(tokens, index + 1, false);
      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function declarationSpecifier(
  tokens: readonly SourceToken[],
  start: number,
  allowRequire: boolean,
): string | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return;
    }
    if (token.kind === "punctuation") {
      if (token.value === "(" || token.value === "[" || token.value === "{") {
        depth += 1;
      } else if (
        token.value === ")" ||
        token.value === "]" ||
        token.value === "}"
      ) {
        depth = Math.max(0, depth - 1);
      } else if (token.value === ";" && depth === 0) {
        return;
      }
      continue;
    }
    if (depth !== 0 || token.kind !== "word") {
      continue;
    }
    if (token.value === "import" || token.value === "export") {
      return;
    }
    if (token.value === "from") {
      const candidate = tokens[index + 1];
      return candidate?.kind === "string" ? candidate.value : undefined;
    }
    if (allowRequire && token.value === "require") {
      const open = tokens[index + 1];
      const candidate = tokens[index + 2];
      const close = tokens[index + 3];
      if (
        open?.value === "(" &&
        candidate?.kind === "string" &&
        close?.value === ")"
      ) {
        return candidate.value;
      }
    }
  }
  return;
}

export { scanStaticModuleSpecifiers };
