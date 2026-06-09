import type { JavaToken } from "./tokenizer";

export type SourceRange = {
  start: number;
  end: number;
  line: number;
  column: number;
};

export type ParserDiagnosticSeverity = "info" | "warning" | "error";

export type ParserDiagnostic = {
  code: string;
  message: string;
  severity: ParserDiagnosticSeverity;
  range?: SourceRange;
  source?: string;
  details?: Record<string, string | number | boolean | null>;
};

export type TokenSlice = {
  startIndex: number;
  endIndex: number;
};

export type QualifiedName = {
  name: string;
  endIndex: number;
};

export function isNameToken(token: JavaToken | undefined): boolean {
  return token?.kind === "identifier" || token?.kind === "keyword";
}

export function tokenToRange(token: JavaToken, endToken: JavaToken = token): SourceRange {
  return {
    start: token.start,
    end: endToken.end,
    line: token.line,
    column: token.column,
  };
}

export function tokenSource(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): string {
  if (startIndex >= endIndex) {
    return "";
  }
  return source.slice(tokens[startIndex].start, tokens[endIndex - 1].end);
}

export function tokenRange(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): SourceRange {
  return tokenToRange(tokens[startIndex], tokens[endIndex - 1]);
}

export function stripJavaStringQuotes(value: string): string | null {
  if (value.length < 2 || value[0] !== "\"" || value[value.length - 1] !== "\"") {
    return null;
  }

  return value
    .slice(1, -1)
    .replace(/\\([btnfr"'\\])/g, (_match, escaped: string) => {
      switch (escaped) {
        case "b":
          return "\b";
        case "t":
          return "\t";
        case "n":
          return "\n";
        case "f":
          return "\f";
        case "r":
          return "\r";
        default:
          return escaped;
      }
    });
}

export function readQualifiedNameAt(
  tokens: JavaToken[],
  index: number,
): QualifiedName | null {
  if (!isNameToken(tokens[index])) {
    return null;
  }

  const parts = [tokens[index].value];
  let cursor = index + 1;
  while (tokens[cursor]?.value === "." && isNameToken(tokens[cursor + 1])) {
    parts.push(tokens[cursor + 1].value);
    cursor += 2;
  }
  return { name: parts.join("."), endIndex: cursor };
}

export function findMatchingToken(tokens: JavaToken[], openIndex: number): number {
  const open = tokens[openIndex]?.value;
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) {
    return -1;
  }

  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === open) {
      depth += 1;
    } else if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export function findStatementStart(tokens: JavaToken[], index: number): number {
  let cursor = index;
  while (cursor > 0 && tokens[cursor - 1].value !== ";" && tokens[cursor - 1].value !== "{") {
    cursor -= 1;
  }
  return cursor;
}

export function findStatementEnd(tokens: JavaToken[], index: number): number {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const value = tokens[cursor].value;
    if (value === "(") {
      parenDepth += 1;
    } else if (value === ")") {
      parenDepth -= 1;
    } else if (value === "{") {
      braceDepth += 1;
    } else if (value === "}") {
      braceDepth -= 1;
    } else if (value === "[") {
      bracketDepth += 1;
    } else if (value === "]") {
      bracketDepth -= 1;
    } else if (value === ";" && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      return cursor;
    }
  }

  return -1;
}

export function splitTopLevelArguments(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): TokenSlice[] {
  const slices: TokenSlice[] = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let sliceStart = startIndex;

  for (let index = startIndex; index < endIndex; index += 1) {
    const value = tokens[index].value;
    if (value === "(") {
      parenDepth += 1;
    } else if (value === ")") {
      parenDepth -= 1;
    } else if (value === "{") {
      braceDepth += 1;
    } else if (value === "}") {
      braceDepth -= 1;
    } else if (value === "[") {
      bracketDepth += 1;
    } else if (value === "]") {
      bracketDepth -= 1;
    } else if (
      value === "," &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      slices.push({ startIndex: sliceStart, endIndex: index });
      sliceStart = index + 1;
    }
  }

  if (sliceStart < endIndex) {
    slices.push({ startIndex: sliceStart, endIndex });
  }
  return slices;
}

export function findQualifiedReferences(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
  root: string,
): string[] {
  const values: string[] = [];
  for (let index = startIndex; index < endIndex - 2; index += 1) {
    if (
      tokens[index].value === root &&
      tokens[index + 1].value === "." &&
      isNameToken(tokens[index + 2])
    ) {
      values.push(tokens[index + 2].value);
    }
  }
  return values;
}

export function firstQualifiedReference(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
  root: string,
): string | null {
  return findQualifiedReferences(tokens, startIndex, endIndex, root)[0] ?? null;
}

export function firstStringLiteral(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): string | null {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].kind === "string") {
      return stripJavaStringQuotes(tokens[index].value);
    }
  }
  return null;
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
