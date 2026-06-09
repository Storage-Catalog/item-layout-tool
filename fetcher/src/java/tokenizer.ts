export type JavaTokenKind =
  | "identifier"
  | "keyword"
  | "number"
  | "string"
  | "character"
  | "text_block"
  | "operator"
  | "punctuation"
  | "comment"
  | "whitespace"
  | "unknown"
  | "eof";

export type JavaToken = {
  kind: JavaTokenKind;
  value: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export type JavaTokenizerOptions = {
  includeWhitespace?: boolean;
  includeComments?: boolean;
  includeEof?: boolean;
};

const JAVA_KEYWORDS = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "exports",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "module",
  "native",
  "new",
  "non-sealed",
  "open",
  "opens",
  "package",
  "permits",
  "private",
  "protected",
  "provides",
  "public",
  "record",
  "requires",
  "return",
  "sealed",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "to",
  "transient",
  "transitive",
  "try",
  "uses",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
  "true",
  "false",
  "null",
]);

const MULTI_CHAR_OPERATORS = [
  ">>>=",
  "...",
  ">>>",
  "<<=",
  ">>=",
  "->",
  "::",
  "++",
  "--",
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
] as const;

const SINGLE_CHAR_OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "<",
  ">",
  "!",
  "~",
  "?",
  ":",
  "&",
  "|",
  "^",
]);

const PUNCTUATION = new Set(["(", ")", "{", "}", "[", "]", ";", ",", ".", "@"]);

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function isLineBreakAt(source: string, index: number): boolean {
  return source[index] === "\n" || source[index] === "\r";
}

function lineBreakLengthAt(source: string, index: number): number {
  return source[index] === "\r" && source[index + 1] === "\n" ? 2 : 1;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char) || char.charCodeAt(0) > 0x7f;
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 0x7f;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isHexDigit(char: string): boolean {
  return /[0-9A-Fa-f]/.test(char);
}

function advancePosition(
  source: string,
  start: number,
  end: number,
  position: { line: number; column: number },
): void {
  let index = start;
  while (index < end) {
    if (isLineBreakAt(source, index)) {
      index += lineBreakLengthAt(source, index);
      position.line += 1;
      position.column = 1;
    } else {
      index += 1;
      position.column += 1;
    }
  }
}

function makeToken(
  source: string,
  kind: JavaTokenKind,
  start: number,
  end: number,
  line: number,
  column: number,
): JavaToken {
  const endPosition = { line, column };
  advancePosition(source, start, end, endPosition);
  return {
    kind,
    value: source.slice(start, end),
    start,
    end,
    line,
    column,
    endLine: endPosition.line,
    endColumn: endPosition.column,
  };
}

function scanWhitespace(source: string, index: number): number {
  while (index < source.length && isWhitespace(source[index])) {
    index += lineBreakLengthAt(source, index);
  }
  return index;
}

function scanLineComment(source: string, index: number): number {
  index += 2;
  while (index < source.length && !isLineBreakAt(source, index)) {
    index += 1;
  }
  return index;
}

function scanBlockComment(source: string, index: number): number {
  index += 2;
  while (index < source.length) {
    if (source[index] === "*" && source[index + 1] === "/") {
      return index + 2;
    }
    index += 1;
  }
  return source.length;
}

function scanIdentifier(source: string, index: number): number {
  index += 1;
  while (index < source.length && isIdentifierPart(source[index])) {
    index += 1;
  }
  return index;
}

function scanNumber(source: string, index: number): number {
  if (source[index] === ".") {
    index += 1;
    while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
      index += 1;
    }
    if (source[index] === "e" || source[index] === "E") {
      index += 1;
      if (source[index] === "+" || source[index] === "-") {
        index += 1;
      }
      while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
        index += 1;
      }
    }
    if (/[fFdD]/.test(source[index] ?? "")) {
      index += 1;
    }
    return index;
  }

  if (source[index] === "0" && (source[index + 1] === "x" || source[index + 1] === "X")) {
    index += 2;
    while (index < source.length && (isHexDigit(source[index]) || source[index] === "_")) {
      index += 1;
    }
    if (source[index] === ".") {
      index += 1;
      while (index < source.length && (isHexDigit(source[index]) || source[index] === "_")) {
        index += 1;
      }
    }
    if (source[index] === "p" || source[index] === "P") {
      index += 1;
      if (source[index] === "+" || source[index] === "-") {
        index += 1;
      }
      while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
        index += 1;
      }
    }
  } else if (source[index] === "0" && (source[index + 1] === "b" || source[index + 1] === "B")) {
    index += 2;
    while (
      index < source.length &&
      (source[index] === "0" || source[index] === "1" || source[index] === "_")
    ) {
      index += 1;
    }
  } else {
    while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
      index += 1;
    }
    if (source[index] === "." && source[index + 1] !== ".") {
      index += 1;
      while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
        index += 1;
      }
    }
    if (source[index] === "e" || source[index] === "E") {
      index += 1;
      if (source[index] === "+" || source[index] === "-") {
        index += 1;
      }
      while (index < source.length && (isDigit(source[index]) || source[index] === "_")) {
        index += 1;
      }
    }
  }

  if (/[fFdDlL]/.test(source[index] ?? "")) {
    index += 1;
  }

  return index;
}

function scanStringLike(source: string, index: number, quote: "\"" | "'"): number {
  index += 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    if (isLineBreakAt(source, index) && quote === "\"") {
      return index;
    }
    index += 1;
  }
  return source.length;
}

function scanTextBlock(source: string, index: number): number {
  index += 3;
  while (index < source.length) {
    if (source[index] === "\\" && source[index + 1] === "\"") {
      index += 2;
      continue;
    }
    if (source.startsWith("\"\"\"", index)) {
      return index + 3;
    }
    index += 1;
  }
  return source.length;
}

function scanOperator(
  source: string,
  index: number,
): { kind: "operator" | "punctuation" | "unknown"; end: number } {
  for (const operator of MULTI_CHAR_OPERATORS) {
    if (source.startsWith(operator, index)) {
      return { kind: "operator", end: index + operator.length };
    }
  }

  const char = source[index];
  if (SINGLE_CHAR_OPERATORS.has(char)) {
    return { kind: "operator", end: index + 1 };
  }
  if (PUNCTUATION.has(char)) {
    return { kind: "punctuation", end: index + 1 };
  }
  return { kind: "unknown", end: index + 1 };
}

export function tokenizeJava(
  source: string,
  options: JavaTokenizerOptions = {},
): JavaToken[] {
  const tokens: JavaToken[] = [];
  const position = { line: 1, column: 1 };
  let index = 0;

  function push(kind: JavaTokenKind, start: number, end: number): void {
    const token = makeToken(source, kind, start, end, position.line, position.column);
    advancePosition(source, start, end, position);
    if (
      (kind === "whitespace" && !options.includeWhitespace) ||
      (kind === "comment" && !options.includeComments)
    ) {
      return;
    }
    tokens.push(token);
  }

  while (index < source.length) {
    const start = index;
    const char = source[index];

    if (isWhitespace(char)) {
      index = scanWhitespace(source, index);
      push("whitespace", start, index);
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      index = scanLineComment(source, index);
      push("comment", start, index);
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      index = scanBlockComment(source, index);
      push("comment", start, index);
      continue;
    }

    if (isIdentifierStart(char)) {
      index = scanIdentifier(source, index);
      const value = source.slice(start, index);
      push(JAVA_KEYWORDS.has(value) ? "keyword" : "identifier", start, index);
      continue;
    }

    if (isDigit(char) || (char === "." && isDigit(source[index + 1] ?? ""))) {
      index = scanNumber(source, index);
      push("number", start, index);
      continue;
    }

    if (char === "\"" && source.startsWith("\"\"\"", index)) {
      index = scanTextBlock(source, index);
      push("text_block", start, index);
      continue;
    }

    if (char === "\"") {
      index = scanStringLike(source, index, "\"");
      push("string", start, index);
      continue;
    }

    if (char === "'") {
      index = scanStringLike(source, index, "'");
      push("character", start, index);
      continue;
    }

    const scanned = scanOperator(source, index);
    index = scanned.end;
    push(scanned.kind, start, index);
  }

  if (options.includeEof) {
    tokens.push({
      kind: "eof",
      value: "",
      start: source.length,
      end: source.length,
      line: position.line,
      column: position.column,
      endLine: position.line,
      endColumn: position.column,
    });
  }

  return tokens;
}

export class JavaTokenStream {
  private readonly tokens: JavaToken[];
  private index = 0;

  constructor(tokens: JavaToken[]) {
    this.tokens = tokens.at(-1)?.kind === "eof" ? tokens : [...tokens, this.createEof(tokens)];
  }

  peek(offset = 0): JavaToken {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  consume(): JavaToken {
    const token = this.peek();
    if (token.kind !== "eof") {
      this.index += 1;
    }
    return token;
  }

  match(value: string): JavaToken | null {
    const token = this.peek();
    if (token.value !== value) {
      return null;
    }
    return this.consume();
  }

  matchKind(kind: JavaTokenKind): JavaToken | null {
    const token = this.peek();
    if (token.kind !== kind) {
      return null;
    }
    return this.consume();
  }

  expect(value: string): JavaToken {
    const token = this.consume();
    if (token.value !== value) {
      throw new Error(
        `Expected token '${value}' at ${token.line}:${token.column}, got '${token.value || token.kind}'`,
      );
    }
    return token;
  }

  expectKind(kind: JavaTokenKind): JavaToken {
    const token = this.consume();
    if (token.kind !== kind) {
      throw new Error(
        `Expected ${kind} token at ${token.line}:${token.column}, got ${token.kind}`,
      );
    }
    return token;
  }

  isEof(): boolean {
    return this.peek().kind === "eof";
  }

  private createEof(tokens: JavaToken[]): JavaToken {
    const last = tokens.at(-1);
    return {
      kind: "eof",
      value: "",
      start: last?.end ?? 0,
      end: last?.end ?? 0,
      line: last?.endLine ?? 1,
      column: last?.endColumn ?? 1,
      endLine: last?.endLine ?? 1,
      endColumn: last?.endColumn ?? 1,
    };
  }
}

export function createJavaTokenStream(
  source: string,
  options: Omit<JavaTokenizerOptions, "includeEof"> = {},
): JavaTokenStream {
  return new JavaTokenStream(tokenizeJava(source, { ...options, includeEof: true }));
}
