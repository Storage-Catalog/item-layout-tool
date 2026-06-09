import {
  findMatchingToken,
  findStatementEnd,
  findStatementStart,
  isNameToken,
  tokenRange,
  tokenSource,
  unique,
  type ParserDiagnostic,
  type SourceRange,
} from "../java/parser-utils";
import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import type { BlocksParseResult } from "./blocks";

export const BLOCK_SHAPE_METHOD_NAMES = [
  "getShape",
  "getCollisionShape",
  "getInteractionShape",
  "getVisualShape",
  "getOcclusionShape",
  "getBlockSupportShape",
  "getCameraCollisionShape",
] as const;

export type BlockShapeMethodName = (typeof BLOCK_SHAPE_METHOD_NAMES)[number];

export type VoxelShapeExpressionKind =
  | "empty"
  | "full_block"
  | "box"
  | "column"
  | "cube"
  | "array"
  | "boxes"
  | "composite"
  | "transformed"
  | "field_reference"
  | "state_dependent"
  | "delegated"
  | "symbolic";

export type VoxelShapeBox = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type ParsedVoxelShapeExpression = {
  expression: string;
  kind: VoxelShapeExpressionKind;
  numericArgs: number[];
  boxes: VoxelShapeBox[];
  referencedShapeFields: string[];
  shapeFactoryCalls: string[];
};

export type BlockShapeField = {
  fieldName: string;
  declarationType: string;
  initializer: string;
  parsed: ParsedVoxelShapeExpression;
  source: string;
  range: SourceRange;
};

export type BlockShapeReturn = {
  expression: string;
  parsed: ParsedVoxelShapeExpression;
  range: SourceRange;
  source: string;
};

export type BlockShapeMethod = {
  name: BlockShapeMethodName;
  returnExpressions: BlockShapeReturn[];
  referencedShapeFields: string[];
  referencedStateProperties: string[];
  usesState: boolean;
  usesLevel: boolean;
  usesPosition: boolean;
  usesCollisionContext: boolean;
  returnsEmpty: boolean;
  returnsFullBlock: boolean;
  source: string;
  range: SourceRange;
};

export type BlockShapeClass = {
  className: string;
  superClassName: string | null;
  shapeFields: BlockShapeField[];
  shapeMethods: Partial<Record<BlockShapeMethodName, BlockShapeMethod>>;
  diagnostics: ParserDiagnostic[];
};

export type ResolvedBlockShapeMethod = {
  methodName: BlockShapeMethodName;
  sourceClassName: string;
  inherited: boolean;
  method: BlockShapeMethod;
};

export type BlockShapeBehavior = {
  blockClass: string;
  shapeClassName: string | null;
  noCollision: boolean;
  noOcclusion: boolean;
  dynamicShape: boolean;
  forceSolidOn: boolean;
  forceSolidOff: boolean;
  hasCollision: boolean;
  collisionSource: "property_noCollision" | "custom_method" | "default_getShape";
  occlusionSource: "property_noOcclusion" | "custom_method" | "default_getShape";
  methods: Partial<Record<BlockShapeMethodName, ResolvedBlockShapeMethod>>;
  shapeFieldNames: string[];
  notes: string[];
};

export type BlockShapesParseResult = {
  classes: BlockShapeClass[];
  classByName: Record<string, BlockShapeClass>;
  diagnostics: ParserDiagnostic[];
};

function diagnostic(input: {
  code: string;
  message: string;
  range?: SourceRange;
  source?: string;
  details?: Record<string, string | number | boolean | null>;
}): ParserDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity: "warning",
    range: input.range,
    source: input.source,
    details: input.details,
  };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseNumberLiteral(value: string): number | null {
  const normalized = value.trim().replace(/_/g, "").replace(/[fFdDlL]$/, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericArgs(expression: string): number[] {
  return [...expression.matchAll(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdDlL]?/g)]
    .map((match) => parseNumberLiteral(match[0]))
    .filter((value): value is number => value !== null);
}

function shapeFactoryCalls(expression: string): string[] {
  return unique(
    [...expression.matchAll(/\b(?:Block|Shapes)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
      .map((match) => `${expression.slice(match.index ?? 0, (match.index ?? 0) + match[0].length - 1)}`),
  );
}

function referencedShapeFields(expression: string, knownShapeFieldNames: Set<string>): string[] {
  return unique(
    [...expression.matchAll(/\b[A-Z][A-Z0-9_]*\b/g)]
      .map((match) => match[0])
      .filter((name) => knownShapeFieldNames.has(name)),
  );
}

function boxFromColumn(args: number[]): VoxelShapeBox[] {
  if (args.length !== 3) {
    return [];
  }
  const [diameter, minY, maxY] = args;
  const inset = (16 - diameter) / 2;
  return [{ minX: inset, minY, minZ: inset, maxX: 16 - inset, maxY, maxZ: 16 - inset }];
}

function parseVoxelShapeExpression(
  expression: string,
  knownShapeFieldNames: Set<string>,
): ParsedVoxelShapeExpression {
  const normalized = normalizeWhitespace(expression);
  const numbers = numericArgs(normalized);
  const calls = shapeFactoryCalls(normalized);
  const fields = referencedShapeFields(normalized, knownShapeFieldNames);

  if (/^Shapes\.empty\(\)$/.test(normalized)) {
    return { expression: normalized, kind: "empty", numericArgs: [], boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (/^Shapes\.block\(\)$/.test(normalized)) {
    return {
      expression: normalized,
      kind: "full_block",
      numericArgs: [],
      boxes: [{ minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 }],
      referencedShapeFields: fields,
      shapeFactoryCalls: calls,
    };
  }
  if (/^Block\.box\s*\(/.test(normalized) && numbers.length === 6) {
    return {
      expression: normalized,
      kind: "box",
      numericArgs: numbers,
      boxes: [{ minX: numbers[0], minY: numbers[1], minZ: numbers[2], maxX: numbers[3], maxY: numbers[4], maxZ: numbers[5] }],
      referencedShapeFields: fields,
      shapeFactoryCalls: calls,
    };
  }
  if (/^Block\.column\s*\(/.test(normalized)) {
    return {
      expression: normalized,
      kind: "column",
      numericArgs: numbers,
      boxes: boxFromColumn(numbers),
      referencedShapeFields: fields,
      shapeFactoryCalls: calls,
    };
  }
  if (/^Block\.cube\s*\(/.test(normalized) && numbers.length === 1) {
    const inset = (16 - numbers[0]) / 2;
    return {
      expression: normalized,
      kind: "cube",
      numericArgs: numbers,
      boxes: [{ minX: inset, minY: inset, minZ: inset, maxX: 16 - inset, maxY: 16 - inset, maxZ: 16 - inset }],
      referencedShapeFields: fields,
      shapeFactoryCalls: calls,
    };
  }
  if (/^new VoxelShape\s*\[\]/.test(normalized) || /^\{/.test(normalized)) {
    return { expression: normalized, kind: "array", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (/^Block\.boxes\s*\(/.test(normalized)) {
    return { expression: normalized, kind: "boxes", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (/\bShapes\.(?:or|join|joinUnoptimized)\s*\(/.test(normalized)) {
    return { expression: normalized, kind: "composite", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (/\.(?:move|optimize)\s*\(|\bShapes\.rotate/.test(normalized)) {
    return { expression: normalized, kind: "transformed", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (/^state\.get[A-Za-z]*Shape\s*\(/.test(normalized) || /\bstate\.getValue\s*\(/.test(normalized)) {
    return { expression: normalized, kind: "state_dependent", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (/^super\.get[A-Za-z]*Shape\s*\(/.test(normalized) || /^this\.get[A-Za-z]*Shape\s*\(/.test(normalized)) {
    return { expression: normalized, kind: "delegated", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  if (fields.length > 0 && /^[A-Z][A-Z0-9_]*(?:\[[^\]]+\])?$/.test(normalized)) {
    return { expression: normalized, kind: "field_reference", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
  }
  return { expression: normalized, kind: "symbolic", numericArgs: numbers, boxes: [], referencedShapeFields: fields, shapeFactoryCalls: calls };
}

function classNameFromSource(tokens: JavaToken[]): { className: string; superClassName: string | null } | null {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!["class", "interface", "enum"].includes(tokens[index].value) || !isNameToken(tokens[index + 1])) {
      continue;
    }

    let superClassName: string | null = null;
    for (let cursor = index + 2; cursor < tokens.length && tokens[cursor].value !== "{"; cursor += 1) {
      if (tokens[cursor].value === "extends" && isNameToken(tokens[cursor + 1])) {
        superClassName = tokens[cursor + 1].value;
        break;
      }
    }

    return { className: tokens[index + 1].value, superClassName };
  }
  return null;
}

function extractShapeFields(source: string, tokens: JavaToken[]): BlockShapeField[] {
  const fieldSlices: Array<Omit<BlockShapeField, "parsed">> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=") {
      continue;
    }

    const statementStart = findStatementStart(tokens, index);
    const statementEnd = findStatementEnd(tokens, statementStart);
    if (statementEnd === -1) {
      continue;
    }
    const statementPrefix = tokenSource(source, tokens, statementStart, index);
    if (!/\bVoxelShape\b/.test(statementPrefix)) {
      continue;
    }

    let fieldIndex = index - 1;
    while (fieldIndex >= statementStart && !isNameToken(tokens[fieldIndex])) {
      fieldIndex -= 1;
    }
    if (fieldIndex < statementStart || tokens[fieldIndex].kind !== "identifier") {
      continue;
    }

    const finalIndex = tokens.findIndex((token, tokenIndex) =>
      tokenIndex >= statementStart && tokenIndex < fieldIndex && token.value === "final",
    );
    const typeStart = finalIndex === -1 ? statementStart : finalIndex + 1;
    fieldSlices.push({
      fieldName: tokens[fieldIndex].value,
      declarationType: tokenSource(source, tokens, typeStart, fieldIndex).trim(),
      initializer: tokenSource(source, tokens, index + 1, statementEnd),
      source: tokenSource(source, tokens, statementStart, statementEnd + 1),
      range: tokenRange(tokens, statementStart, statementEnd + 1),
    });
  }

  const knownShapeFieldNames = new Set(fieldSlices.map((field) => field.fieldName));
  return fieldSlices.map((field) => ({
    ...field,
    parsed: parseVoxelShapeExpression(field.initializer, knownShapeFieldNames),
  }));
}

function methodNameFromToken(token: JavaToken | undefined): BlockShapeMethodName | null {
  return BLOCK_SHAPE_METHOD_NAMES.find((name) => token?.value === name) ?? null;
}

function referencedStateProperties(source: string): string[] {
  return unique(
    [...source.matchAll(/\bstate\.getValue\s*\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)/g)]
      .map((match) => match[1]),
  );
}

function extractShapeMethods(
  source: string,
  tokens: JavaToken[],
  knownShapeFieldNames: Set<string>,
): Partial<Record<BlockShapeMethodName, BlockShapeMethod>> {
  const methods: Partial<Record<BlockShapeMethodName, BlockShapeMethod>> = {};

  for (let index = 0; index < tokens.length - 2; index += 1) {
    const methodName = methodNameFromToken(tokens[index]);
    if (!methodName || tokens[index + 1]?.value !== "(") {
      continue;
    }

    const prefixStart = Math.max(0, index - 10);
    const prefix = tokenSource(source, tokens, prefixStart, index);
    if (!/\bVoxelShape\b/.test(prefix)) {
      continue;
    }

    const closeParametersIndex = findMatchingToken(tokens, index + 1);
    if (closeParametersIndex === -1 || tokens[closeParametersIndex + 1]?.value !== "{") {
      continue;
    }

    const bodyOpenIndex = closeParametersIndex + 1;
    const bodyCloseIndex = findMatchingToken(tokens, bodyOpenIndex);
    if (bodyCloseIndex === -1) {
      continue;
    }

    const returns: BlockShapeReturn[] = [];
    for (let cursor = bodyOpenIndex + 1; cursor < bodyCloseIndex; cursor += 1) {
      if (tokens[cursor].value !== "return") {
        continue;
      }
      const statementEnd = findStatementEnd(tokens, cursor);
      if (statementEnd === -1 || statementEnd > bodyCloseIndex) {
        continue;
      }
      const expression = tokenSource(source, tokens, cursor + 1, statementEnd);
      returns.push({
        expression: normalizeWhitespace(expression),
        parsed: parseVoxelShapeExpression(expression, knownShapeFieldNames),
        range: tokenRange(tokens, cursor, statementEnd + 1),
        source: tokenSource(source, tokens, cursor, statementEnd + 1),
      });
    }

    const methodSource = tokenSource(source, tokens, index, bodyCloseIndex + 1);
    const referencedFields = unique(returns.flatMap((entry) => entry.parsed.referencedShapeFields));
    methods[methodName] = {
      name: methodName,
      returnExpressions: returns,
      referencedShapeFields: referencedFields,
      referencedStateProperties: referencedStateProperties(methodSource),
      usesState: /\bstate\./.test(methodSource),
      usesLevel: /\blevel\./.test(methodSource),
      usesPosition: /\bpos\./.test(methodSource),
      usesCollisionContext: /\bcontext\./.test(methodSource),
      returnsEmpty: returns.length > 0 && returns.every((entry) => entry.parsed.kind === "empty"),
      returnsFullBlock: returns.length > 0 && returns.every((entry) => entry.parsed.kind === "full_block"),
      source: methodSource,
      range: tokenRange(tokens, index, bodyCloseIndex + 1),
    };
    index = bodyCloseIndex;
  }

  return methods;
}

export function parseBlockShapeClassSource(source: string): BlockShapeClass {
  const tokens = tokenizeJava(source);
  const classNames = classNameFromSource(tokens);
  const diagnostics: ParserDiagnostic[] = [];
  if (!classNames) {
    diagnostics.push(
      diagnostic({
        code: "block_shapes.class_name_missing",
        message: "Could not identify class name while parsing block shape source.",
      }),
    );
  }

  const shapeFields = extractShapeFields(source, tokens);
  const knownShapeFieldNames = new Set(shapeFields.map((field) => field.fieldName));
  const shapeMethods = extractShapeMethods(source, tokens, knownShapeFieldNames);

  if (shapeFields.length === 0 && Object.keys(shapeMethods).length === 0) {
    diagnostics.push(
      diagnostic({
        code: "block_shapes.no_shape_members",
        message: `Block class '${classNames?.className ?? "unknown"}' has no parsed VoxelShape fields or shape methods.`,
        details: { className: classNames?.className ?? null },
      }),
    );
  }

  return {
    className: classNames?.className ?? "unknown",
    superClassName: classNames?.superClassName ?? null,
    shapeFields,
    shapeMethods,
    diagnostics,
  };
}

export function parseBlockShapeClassSources(sources: string[]): BlockShapesParseResult {
  const classes = sources.map(parseBlockShapeClassSource);
  return {
    classes,
    classByName: Object.fromEntries(classes.map((entry) => [entry.className, entry])),
    diagnostics: classes.flatMap((entry) => entry.diagnostics),
  };
}

function resolveShapeMethod(input: {
  classByName: Record<string, BlockShapeClass>;
  className: string;
  methodName: BlockShapeMethodName;
  originClassName?: string;
  seen?: Set<string>;
}): ResolvedBlockShapeMethod | null {
  const seen = input.seen ?? new Set<string>();
  const originClassName = input.originClassName ?? input.className;
  if (seen.has(input.className)) {
    return null;
  }
  seen.add(input.className);

  const shapeClass = input.classByName[input.className];
  if (!shapeClass) {
    return null;
  }

  const method = shapeClass.shapeMethods[input.methodName];
  if (method) {
    return {
      methodName: input.methodName,
      sourceClassName: shapeClass.className,
      inherited: shapeClass.className !== originClassName,
      method,
    };
  }

  if (!shapeClass.superClassName || shapeClass.superClassName === "Block") {
    return null;
  }

  return resolveShapeMethod({
    classByName: input.classByName,
    className: shapeClass.superClassName,
    methodName: input.methodName,
    originClassName,
    seen,
  });
}

export function resolveBlockShapeBehavior(input: {
  blockClass: string | null;
  noCollision: boolean;
  noOcclusion: boolean;
  dynamicShape: boolean;
  forceSolidOn: boolean;
  forceSolidOff: boolean;
  blockShapes: BlockShapesParseResult;
}): BlockShapeBehavior | null {
  if (!input.blockClass) {
    return null;
  }

  const methods = Object.fromEntries(
    BLOCK_SHAPE_METHOD_NAMES
      .map((methodName) => [
        methodName,
        resolveShapeMethod({
          classByName: input.blockShapes.classByName,
          className: input.blockClass ?? "",
          methodName,
        }),
      ])
      .filter((entry): entry is [BlockShapeMethodName, ResolvedBlockShapeMethod] => entry[1] !== null),
  ) as Partial<Record<BlockShapeMethodName, ResolvedBlockShapeMethod>>;
  const shapeClass = input.blockShapes.classByName[input.blockClass] ?? null;
  const shapeMethod = methods.getShape;
  const collisionMethod = methods.getCollisionShape;
  const occlusionMethod = methods.getOcclusionShape;
  const methodShapeFieldNames = Object.values(methods).flatMap((entry) => {
    const sourceClass = input.blockShapes.classByName[entry.sourceClassName];
    return sourceClass?.shapeFields.map((field) => field.fieldName) ?? [];
  });
  const notes: string[] = [];

  if (input.noCollision) {
    notes.push("BlockBehaviour.Properties.noCollision makes the default collision shape empty.");
  }
  if (!collisionMethod && shapeMethod && !input.noCollision) {
    notes.push("Collision shape defaults to getShape because getCollisionShape is not overridden.");
  }
  if (input.noOcclusion) {
    notes.push("BlockBehaviour.Properties.noOcclusion disables normal occlusion.");
  }

  return {
    blockClass: input.blockClass,
    shapeClassName: shapeClass?.className ?? null,
    noCollision: input.noCollision,
    noOcclusion: input.noOcclusion,
    dynamicShape: input.dynamicShape,
    forceSolidOn: input.forceSolidOn,
    forceSolidOff: input.forceSolidOff,
    hasCollision: !input.noCollision,
    collisionSource: input.noCollision
      ? "property_noCollision"
      : collisionMethod
        ? "custom_method"
        : "default_getShape",
    occlusionSource: input.noOcclusion
      ? "property_noOcclusion"
      : occlusionMethod
        ? "custom_method"
        : "default_getShape",
    methods,
    shapeFieldNames: unique([
      ...(shapeClass?.shapeFields.map((field) => field.fieldName) ?? []),
      ...methodShapeFieldNames,
    ]),
    notes,
  };
}

export function applyBlockShapeDataToBlocks(
  blocks: BlocksParseResult,
  blockShapes: BlockShapesParseResult,
): BlocksParseResult {
  const shapedBlocks = blocks.blocks.map((block) => ({
    ...block,
    shapeBehavior: resolveBlockShapeBehavior({
      blockClass: block.blockClass,
      noCollision: block.noCollision,
      noOcclusion: block.noOcclusion,
      dynamicShape: block.dynamicShape,
      forceSolidOn: block.forceSolidOn,
      forceSolidOff: block.forceSolidOff,
      blockShapes,
    }),
  }));

  return {
    ...blocks,
    blocks: shapedBlocks,
    blockByFieldName: Object.fromEntries(shapedBlocks.map((block) => [block.fieldName, block])),
    blockById: Object.fromEntries(shapedBlocks.flatMap((block) => block.id ? [[block.id, block]] : [])),
    diagnostics: [...blocks.diagnostics, ...blockShapes.diagnostics],
  };
}
