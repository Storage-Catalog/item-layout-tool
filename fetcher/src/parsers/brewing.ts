import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import {
  findMatchingToken,
  firstQualifiedReference,
  readQualifiedNameAt,
  splitTopLevelArguments,
  tokenRange,
  tokenSource,
  type ParserDiagnostic,
  type SourceRange,
  type TokenSlice,
} from "../java/parser-utils";

export type BrewingContainer = {
  itemField: string;
  itemId: string;
  source: string;
  range: SourceRange;
};

export type BrewingContainerRecipe = {
  fromItemField: string;
  fromItemId: string;
  ingredientItemField: string;
  ingredientItemId: string;
  toItemField: string;
  toItemId: string;
  source: string;
  range: SourceRange;
};

export type BrewingPotionMix = {
  fromPotionField: string;
  fromPotionId: string;
  ingredientItemField: string;
  ingredientItemId: string;
  toPotionField: string;
  toPotionId: string;
  sourceKind: "addMix" | "addStartMix_expanded";
  source: string;
  range: SourceRange;
};

export type BrewingStartMix = {
  ingredientItemField: string;
  ingredientItemId: string;
  toPotionField: string;
  toPotionId: string;
  expandedMixes: BrewingPotionMix[];
  source: string;
  range: SourceRange;
};

export type PotionBrewingParseResult = {
  containers: BrewingContainer[];
  containerRecipes: BrewingContainerRecipe[];
  potionMixes: BrewingPotionMix[];
  explicitPotionMixes: BrewingPotionMix[];
  startMixes: BrewingStartMix[];
  diagnostics: ParserDiagnostic[];
};

type BuilderCall = {
  name: string;
  args: TokenSlice[];
  source: string;
  range: SourceRange;
};

const HANDLED_BREWING_BUILDER_CALLS = new Set([
  "addContainer",
  "addContainerRecipe",
  "addMix",
  "addStartMix",
]);

function toIdFromField(fieldName: string): string {
  return `minecraft:${fieldName.toLowerCase()}`;
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

function findMethodBody(
  tokens: JavaToken[],
  methodName: string,
): { openIndex: number; closeIndex: number } | null {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== methodName || tokens[index + 1]?.value !== "(") {
      continue;
    }

    const parameterCloseIndex = findMatchingToken(tokens, index + 1);
    if (parameterCloseIndex === -1 || tokens[parameterCloseIndex + 1]?.value !== "{") {
      continue;
    }

    const openIndex = parameterCloseIndex + 1;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex !== -1) {
      return { openIndex, closeIndex };
    }
  }

  return null;
}

function parseBuilderCalls(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): BuilderCall[] {
  const calls: BuilderCall[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified?.name.startsWith("builder.") || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    const openIndex = qualified.endIndex;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1 || closeIndex > endIndex) {
      continue;
    }

    calls.push({
      name: qualified.name.split(".").at(-1) ?? qualified.name,
      args: splitTopLevelArguments(tokens, openIndex + 1, closeIndex),
      source: tokenSource(source, tokens, index, closeIndex + 1),
      range: tokenRange(tokens, index, closeIndex + 1),
    });
    index = closeIndex;
  }

  return calls;
}

function itemField(
  tokens: JavaToken[],
  arg: TokenSlice | undefined,
): string | null {
  return arg ? firstQualifiedReference(tokens, arg.startIndex, arg.endIndex, "Items") : null;
}

function potionField(
  tokens: JavaToken[],
  arg: TokenSlice | undefined,
): string | null {
  return arg ? firstQualifiedReference(tokens, arg.startIndex, arg.endIndex, "Potions") : null;
}

function hasMissingFields(
  fields: Record<string, string | null>,
  call: BuilderCall,
  diagnostics: ParserDiagnostic[],
): boolean {
  const missing = Object.entries(fields)
    .filter((entry) => entry[1] === null)
    .map(([key]) => key);
  if (missing.length === 0) {
    return false;
  }

  diagnostics.push(
    diagnostic({
      code: "brewing.unresolved_builder_args",
      message: `PotionBrewing builder call '${call.name}' has unresolved arguments: ${missing.join(", ")}.`,
      range: call.range,
      source: call.source,
      details: { call: call.name, missing: missing.join(", ") },
    }),
  );
  return true;
}

function expandedStartMixes(input: {
  ingredientItemField: string;
  toPotionField: string;
  source: string;
  range: SourceRange;
}): BrewingPotionMix[] {
  return [
    {
      fromPotionField: "WATER",
      fromPotionId: "minecraft:water",
      ingredientItemField: input.ingredientItemField,
      ingredientItemId: toIdFromField(input.ingredientItemField),
      toPotionField: "MUNDANE",
      toPotionId: "minecraft:mundane",
      sourceKind: "addStartMix_expanded",
      source: input.source,
      range: input.range,
    },
    {
      fromPotionField: "AWKWARD",
      fromPotionId: "minecraft:awkward",
      ingredientItemField: input.ingredientItemField,
      ingredientItemId: toIdFromField(input.ingredientItemField),
      toPotionField: input.toPotionField,
      toPotionId: toIdFromField(input.toPotionField),
      sourceKind: "addStartMix_expanded",
      source: input.source,
      range: input.range,
    },
  ];
}

export function parsePotionBrewingSource(source: string): PotionBrewingParseResult {
  const tokens = tokenizeJava(source);
  const diagnostics: ParserDiagnostic[] = [];
  const addVanillaMixesBody = findMethodBody(tokens, "addVanillaMixes");
  if (!addVanillaMixesBody) {
    return {
      containers: [],
      containerRecipes: [],
      potionMixes: [],
      explicitPotionMixes: [],
      startMixes: [],
      diagnostics: [
        diagnostic({
          code: "brewing.add_vanilla_mixes_missing",
          message: "Could not find PotionBrewing.addVanillaMixes method body.",
        }),
      ],
    };
  }

  const containers: BrewingContainer[] = [];
  const containerRecipes: BrewingContainerRecipe[] = [];
  const explicitPotionMixes: BrewingPotionMix[] = [];
  const startMixes: BrewingStartMix[] = [];

  for (const call of parseBuilderCalls(
    source,
    tokens,
    addVanillaMixesBody.openIndex + 1,
    addVanillaMixesBody.closeIndex,
  )) {
    if (call.name === "addContainer") {
      const item = itemField(tokens, call.args[0]);
      if (hasMissingFields({ item }, call, diagnostics) || item === null) {
        continue;
      }
      containers.push({
        itemField: item,
        itemId: toIdFromField(item),
        source: call.source,
        range: call.range,
      });
      continue;
    }

    if (call.name === "addContainerRecipe") {
      const from = itemField(tokens, call.args[0]);
      const ingredient = itemField(tokens, call.args[1]);
      const to = itemField(tokens, call.args[2]);
      if (
        hasMissingFields({ from, ingredient, to }, call, diagnostics) ||
        from === null ||
        ingredient === null ||
        to === null
      ) {
        continue;
      }
      containerRecipes.push({
        fromItemField: from,
        fromItemId: toIdFromField(from),
        ingredientItemField: ingredient,
        ingredientItemId: toIdFromField(ingredient),
        toItemField: to,
        toItemId: toIdFromField(to),
        source: call.source,
        range: call.range,
      });
      continue;
    }

    if (call.name === "addMix") {
      const from = potionField(tokens, call.args[0]);
      const ingredient = itemField(tokens, call.args[1]);
      const to = potionField(tokens, call.args[2]);
      if (
        hasMissingFields({ from, ingredient, to }, call, diagnostics) ||
        from === null ||
        ingredient === null ||
        to === null
      ) {
        continue;
      }
      explicitPotionMixes.push({
        fromPotionField: from,
        fromPotionId: toIdFromField(from),
        ingredientItemField: ingredient,
        ingredientItemId: toIdFromField(ingredient),
        toPotionField: to,
        toPotionId: toIdFromField(to),
        sourceKind: "addMix",
        source: call.source,
        range: call.range,
      });
      continue;
    }

    if (call.name === "addStartMix") {
      const ingredient = itemField(tokens, call.args[0]);
      const to = potionField(tokens, call.args[1]);
      if (
        hasMissingFields({ ingredient, to }, call, diagnostics) ||
        ingredient === null ||
        to === null
      ) {
        continue;
      }
      const expandedMixes = expandedStartMixes({
        ingredientItemField: ingredient,
        toPotionField: to,
        source: call.source,
        range: call.range,
      });
      startMixes.push({
        ingredientItemField: ingredient,
        ingredientItemId: toIdFromField(ingredient),
        toPotionField: to,
        toPotionId: toIdFromField(to),
        expandedMixes,
        source: call.source,
        range: call.range,
      });
      continue;
    }

    if (!HANDLED_BREWING_BUILDER_CALLS.has(call.name)) {
      diagnostics.push(
        diagnostic({
          code: "brewing.unhandled_builder_call",
          message: `Unhandled PotionBrewing builder call '${call.name}'.`,
          range: call.range,
          source: call.source,
          details: { call: call.name },
        }),
      );
    }
  }

  return {
    containers,
    containerRecipes,
    potionMixes: [...explicitPotionMixes, ...startMixes.flatMap((mix) => mix.expandedMixes)],
    explicitPotionMixes,
    startMixes,
    diagnostics,
  };
}
