import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import {
  findMatchingToken,
  findQualifiedReferences,
  findStatementEnd,
  findStatementStart,
  firstQualifiedReference,
  firstStringLiteral,
  isNameToken,
  readQualifiedNameAt,
  splitTopLevelArguments,
  tokenRange,
  tokenSource,
  type ParserDiagnostic,
  type SourceRange,
  type TokenSlice,
} from "../java/parser-utils";

export type BlockFamilyBuilderCall = {
  name: string;
  qualifiedName: string;
  args: string[];
  blockFields: string[];
  source: string;
  range: SourceRange;
};

export type BlockFamilyVariantName =
  | "BUTTON"
  | "CHISELED"
  | "CRACKED"
  | "CUT"
  | "DOOR"
  | "CUSTOM_FENCE"
  | "FENCE"
  | "CUSTOM_FENCE_GATE"
  | "FENCE_GATE"
  | "MOSAIC"
  | "SIGN"
  | "SLAB"
  | "STAIRS"
  | "PRESSURE_PLATE"
  | "POLISHED"
  | "TRAPDOOR"
  | "WALL"
  | "WALL_SIGN"
  | "BRICKS"
  | "COBBLED"
  | "TILES";

export type BlockFamilyVariant = {
  variant: BlockFamilyVariantName;
  blockField: string;
  sourceCall: string;
};

export type BlockFamilyDefinition = {
  fieldName: string;
  id: string;
  baseBlockField: string | null;
  baseBlockExpression: string | null;
  variants: Partial<Record<BlockFamilyVariantName, string>>;
  variantEntries: BlockFamilyVariant[];
  generateModel: boolean;
  generateCraftingRecipe: boolean;
  generateStonecutterRecipe: boolean;
  recipeGroupPrefix: string | null;
  recipeUnlockedBy: string | null;
  source: string;
  range: SourceRange;
  builderCalls: BlockFamilyBuilderCall[];
  unhandledBuilderCalls: BlockFamilyBuilderCall[];
};

export type BlockFamiliesParseResult = {
  families: BlockFamilyDefinition[];
  familyByFieldName: Record<string, BlockFamilyDefinition>;
  familyByBaseBlockField: Record<string, BlockFamilyDefinition>;
  diagnostics: ParserDiagnostic[];
};

type StaticBlockFamilyField = {
  fieldName: string;
  initializerStartIndex: number;
  initializerEndIndex: number;
  source: string;
  range: SourceRange;
};

const BLOCK_FAMILY_VARIANT_METHODS: Record<
  string,
  BlockFamilyVariantName | BlockFamilyVariantName[]
> = {
  button: "BUTTON",
  chiseled: "CHISELED",
  mosaic: "MOSAIC",
  cracked: "CRACKED",
  tiles: "TILES",
  cut: "CUT",
  door: "DOOR",
  customFence: "CUSTOM_FENCE",
  fence: "FENCE",
  customFenceGate: "CUSTOM_FENCE_GATE",
  fenceGate: "FENCE_GATE",
  sign: ["SIGN", "WALL_SIGN"],
  slab: "SLAB",
  stairs: "STAIRS",
  pressurePlate: "PRESSURE_PLATE",
  polished: "POLISHED",
  trapdoor: "TRAPDOOR",
  wall: "WALL",
  cobbled: "COBBLED",
  bricks: "BRICKS",
};

const HANDLED_BLOCK_FAMILY_BUILDER_CALLS = new Set([
  "familyBuilder",
  "getFamily",
  "dontGenerateModel",
  "dontGenerateCraftingRecipe",
  "generateStonecutterRecipe",
  "recipeGroupPrefix",
  "recipeUnlockedBy",
  ...Object.keys(BLOCK_FAMILY_VARIANT_METHODS),
]);

function toSnakeCaseFromConstant(value: string): string {
  return value.toLowerCase();
}

function unqualifiedName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function sourceForArg(source: string, tokens: JavaToken[], arg: TokenSlice): string {
  return tokenSource(source, tokens, arg.startIndex, arg.endIndex);
}

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

function parseBuilderCalls(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): BlockFamilyBuilderCall[] {
  const calls: BlockFamilyBuilderCall[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    const openIndex = qualified.endIndex;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1 || closeIndex > endIndex) {
      continue;
    }

    const args = splitTopLevelArguments(tokens, openIndex + 1, closeIndex);
    calls.push({
      name: unqualifiedName(qualified.name),
      qualifiedName: qualified.name,
      args: args.map((arg) => sourceForArg(source, tokens, arg)),
      blockFields: args.flatMap((arg) =>
        findQualifiedReferences(tokens, arg.startIndex, arg.endIndex, "Blocks"),
      ),
      source: tokenSource(source, tokens, index, closeIndex + 1),
      range: tokenRange(tokens, index, closeIndex + 1),
    });

    index = closeIndex;
  }

  return calls;
}

function extractStaticBlockFamilyFields(
  source: string,
  tokens: JavaToken[],
): StaticBlockFamilyField[] {
  const fields: StaticBlockFamilyField[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=") {
      continue;
    }

    const statementStart = findStatementStart(tokens, index);
    const statementEnd = findStatementEnd(tokens, statementStart);
    if (statementEnd === -1) {
      continue;
    }

    const declarationTokens = tokens.slice(statementStart, index);
    const isPublicStaticFinal = ["public", "static", "final"].every((keyword) =>
      declarationTokens.some((token) => token.value === keyword),
    );
    const declaresBlockFamily = declarationTokens.some(
      (token, relativeIndex) =>
        token.value === "BlockFamily" && declarationTokens[relativeIndex + 1]?.value !== ">",
    );
    if (!isPublicStaticFinal || !declaresBlockFamily) {
      continue;
    }

    let fieldIndex = index - 1;
    while (fieldIndex >= statementStart && !isNameToken(tokens[fieldIndex])) {
      fieldIndex -= 1;
    }
    if (fieldIndex < statementStart || tokens[fieldIndex].kind !== "identifier") {
      continue;
    }

    fields.push({
      fieldName: tokens[fieldIndex].value,
      initializerStartIndex: index + 1,
      initializerEndIndex: statementEnd,
      source: tokenSource(source, tokens, statementStart, statementEnd + 1),
      range: tokenRange(tokens, statementStart, statementEnd + 1),
    });
  }

  return fields;
}

function blockFieldFromExpression(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): string | null {
  return firstQualifiedReference(tokens, startIndex, endIndex, "Blocks");
}

function parseBaseBlock(
  source: string,
  tokens: JavaToken[],
  field: StaticBlockFamilyField,
  calls: BlockFamilyBuilderCall[],
): { blockField: string | null; expression: string | null } {
  const familyBuilderCall = calls.find((call) => call.name === "familyBuilder");
  if (!familyBuilderCall) {
    return { blockField: null, expression: null };
  }

  for (let index = field.initializerStartIndex; index < field.initializerEndIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (
      qualified?.name !== "BlockFamilies.familyBuilder" ||
      tokens[qualified.endIndex]?.value !== "("
    ) {
      continue;
    }
    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    if (closeIndex === -1) {
      continue;
    }
    const args = splitTopLevelArguments(tokens, qualified.endIndex + 1, closeIndex);
    const firstArg = args[0] ?? null;
    return {
      blockField: firstArg
        ? blockFieldFromExpression(tokens, firstArg.startIndex, firstArg.endIndex)
        : null,
      expression: firstArg ? tokenSource(source, tokens, firstArg.startIndex, firstArg.endIndex) : null,
    };
  }

  return {
    blockField: familyBuilderCall.blockFields[0] ?? null,
    expression: familyBuilderCall.args[0] ?? null,
  };
}

function addVariantEntries(
  input: {
    fieldName: string;
    call: BlockFamilyBuilderCall;
    variants: Partial<Record<BlockFamilyVariantName, string>>;
    variantEntries: BlockFamilyVariant[];
    diagnostics: ParserDiagnostic[];
  },
): void {
  const variantNames = BLOCK_FAMILY_VARIANT_METHODS[input.call.name];
  if (!variantNames) {
    return;
  }

  const variants = Array.isArray(variantNames) ? variantNames : [variantNames];
  variants.forEach((variant, index) => {
    const blockField = input.call.blockFields[index] ?? null;
    if (!blockField) {
      input.diagnostics.push(
        diagnostic({
          code: "block_families.variant.unresolved_block",
          message: `Block family '${input.fieldName}' variant '${variant}' did not have a parseable Blocks.* argument.`,
          range: input.call.range,
          source: input.call.source,
          details: { fieldName: input.fieldName, variant },
        }),
      );
      return;
    }

    if (input.variants[variant] && input.variants[variant] !== blockField) {
      input.diagnostics.push(
        diagnostic({
          code: "block_families.variant.duplicate",
          message: `Block family '${input.fieldName}' assigns variant '${variant}' more than once.`,
          range: input.call.range,
          source: input.call.source,
          details: {
            fieldName: input.fieldName,
            variant,
            previousBlockField: input.variants[variant] ?? null,
            blockField,
          },
        }),
      );
    }

    input.variants[variant] = blockField;
    input.variantEntries.push({
      variant,
      blockField,
      sourceCall: input.call.source,
    });
  });
}

function parseBlockFamilyField(
  source: string,
  tokens: JavaToken[],
  field: StaticBlockFamilyField,
  diagnostics: ParserDiagnostic[],
): BlockFamilyDefinition {
  const calls = parseBuilderCalls(source, tokens, field.initializerStartIndex, field.initializerEndIndex);
  const baseBlock = parseBaseBlock(source, tokens, field, calls);
  const variants: Partial<Record<BlockFamilyVariantName, string>> = {};
  const variantEntries: BlockFamilyVariant[] = [];
  const unhandledBuilderCalls: BlockFamilyBuilderCall[] = [];
  let generateModel = true;
  let generateCraftingRecipe = true;
  let generateStonecutterRecipe = false;
  let recipeGroupPrefix: string | null = null;
  let recipeUnlockedBy: string | null = null;

  if (!calls.some((call) => call.name === "familyBuilder")) {
    diagnostics.push(
      diagnostic({
        code: "block_families.missing_family_builder",
        message: `Block family '${field.fieldName}' does not call BlockFamilies.familyBuilder.`,
        range: field.range,
        source: field.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }
  if (!calls.some((call) => call.name === "getFamily")) {
    diagnostics.push(
      diagnostic({
        code: "block_families.missing_get_family",
        message: `Block family '${field.fieldName}' does not terminate with getFamily().`,
        range: field.range,
        source: field.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }
  if (!baseBlock.blockField) {
    diagnostics.push(
      diagnostic({
        code: "block_families.unresolved_base_block",
        message: `Block family '${field.fieldName}' base block could not be resolved to a Blocks.* field.`,
        range: field.range,
        source: field.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }

  for (const call of calls) {
    if (BLOCK_FAMILY_VARIANT_METHODS[call.name]) {
      addVariantEntries({
        fieldName: field.fieldName,
        call,
        variants,
        variantEntries,
        diagnostics,
      });
      continue;
    }

    if (call.name === "dontGenerateModel") {
      generateModel = false;
    } else if (call.name === "dontGenerateCraftingRecipe") {
      generateCraftingRecipe = false;
    } else if (call.name === "generateStonecutterRecipe") {
      generateStonecutterRecipe = true;
    } else if (call.name === "recipeGroupPrefix") {
      recipeGroupPrefix = firstStringLiteral(
        tokenizeJava(call.source),
        0,
        tokenizeJava(call.source).length,
      );
      if (recipeGroupPrefix === null) {
        diagnostics.push(
          diagnostic({
            code: "block_families.recipe_group_prefix.unresolved",
            message: `Block family '${field.fieldName}' recipeGroupPrefix was not a parseable string literal.`,
            range: call.range,
            source: call.source,
            details: { fieldName: field.fieldName },
          }),
        );
      }
    } else if (call.name === "recipeUnlockedBy") {
      recipeUnlockedBy = firstStringLiteral(
        tokenizeJava(call.source),
        0,
        tokenizeJava(call.source).length,
      );
      if (recipeUnlockedBy === null) {
        diagnostics.push(
          diagnostic({
            code: "block_families.recipe_unlocked_by.unresolved",
            message: `Block family '${field.fieldName}' recipeUnlockedBy was not a parseable string literal.`,
            range: call.range,
            source: call.source,
            details: { fieldName: field.fieldName },
          }),
        );
      }
    } else if (!HANDLED_BLOCK_FAMILY_BUILDER_CALLS.has(call.name)) {
      unhandledBuilderCalls.push(call);
      diagnostics.push(
        diagnostic({
          code: "block_families.builder.unhandled_call",
          message: `Block family '${field.fieldName}' has unhandled builder call '${call.qualifiedName}'.`,
          range: call.range,
          source: call.source,
          details: { fieldName: field.fieldName, call: call.qualifiedName },
        }),
      );
    }
  }

  return {
    fieldName: field.fieldName,
    id: toSnakeCaseFromConstant(field.fieldName),
    baseBlockField: baseBlock.blockField,
    baseBlockExpression: baseBlock.expression,
    variants,
    variantEntries,
    generateModel,
    generateCraftingRecipe,
    generateStonecutterRecipe,
    recipeGroupPrefix,
    recipeUnlockedBy,
    source: field.source,
    range: field.range,
    builderCalls: calls,
    unhandledBuilderCalls,
  };
}

export function parseBlockFamiliesSource(source: string): BlockFamiliesParseResult {
  const tokens = tokenizeJava(source);
  const diagnostics: ParserDiagnostic[] = [];
  const families = extractStaticBlockFamilyFields(source, tokens).map((field) =>
    parseBlockFamilyField(source, tokens, field, diagnostics),
  );

  const familyByBaseBlockField: Record<string, BlockFamilyDefinition> = {};
  for (const family of families) {
    if (family.baseBlockField) {
      if (familyByBaseBlockField[family.baseBlockField]) {
        diagnostics.push(
          diagnostic({
            code: "block_families.duplicate_base_block",
            message: `Multiple block families use base block '${family.baseBlockField}'.`,
            range: family.range,
            source: family.source,
            details: { baseBlockField: family.baseBlockField, fieldName: family.fieldName },
          }),
        );
      }
      familyByBaseBlockField[family.baseBlockField] = family;
    }
  }

  return {
    families,
    familyByFieldName: Object.fromEntries(
      families.map((family) => [family.fieldName, family]),
    ),
    familyByBaseBlockField,
    diagnostics,
  };
}
