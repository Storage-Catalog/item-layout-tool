import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import {
  findMatchingToken,
  findStatementEnd,
  findStatementStart,
  isNameToken,
  readQualifiedNameAt,
  splitTopLevelArguments,
  tokenRange,
  tokenSource,
  type ParserDiagnostic,
  type SourceRange,
  type TokenSlice,
} from "../java/parser-utils";

export type FoodPropertyCall = {
  name: string;
  qualifiedName: string;
  args: string[];
  source: string;
  range: SourceRange;
};

export type FoodBuilderHelper = {
  name: string;
  parameters: string[];
  returnExpression: string;
  propertyCalls: FoodPropertyCall[];
  source: string;
  range: SourceRange;
};

export type FoodEffect = {
  effectExpression: string;
  probability: number | null;
};

export type FoodDefinition = {
  fieldName: string;
  id: string;
  reference: string;
  initializer: string;
  source: string;
  range: SourceRange;
  helperName: string | null;
  nutrition: number | null;
  saturationModifier: number | null;
  alwaysEdible: boolean;
  usingConvertsTo: string | null;
  effects: FoodEffect[];
  propertyCalls: FoodPropertyCall[];
  unhandledPropertyCalls: FoodPropertyCall[];
};

export type FoodsParseResult = {
  foods: FoodDefinition[];
  helpers: FoodBuilderHelper[];
  foodByFieldName: Record<string, FoodDefinition>;
  foodByReference: Record<string, FoodDefinition>;
  diagnostics: ParserDiagnostic[];
};

type StaticFoodField = {
  fieldName: string;
  initializer: string;
  initializerStartIndex: number;
  initializerEndIndex: number;
  source: string;
  range: SourceRange;
};

const HANDLED_FOOD_PROPERTY_CALLS = new Set([
  "build",
  "effect",
  "nutrition",
  "saturationModifier",
  "alwaysEdible",
  "usingConvertsTo",
]);

function toSnakeCaseFromConstant(value: string): string {
  return value.toLowerCase();
}

function unqualifiedName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function normalizeNumberLiteral(source: string): string {
  return source.replace(/_/g, "").replace(/[fFdDlL]$/, "");
}

function parseNumberLiteral(source: string): number | null {
  const normalized = normalizeNumberLiteral(source.trim());
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntegerLiteral(source: string): number | null {
  const parsed = parseNumberLiteral(source);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function sourceForArg(source: string, tokens: JavaToken[], arg: TokenSlice): string {
  return tokenSource(source, tokens, arg.startIndex, arg.endIndex);
}

function parseMethodCalls(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): FoodPropertyCall[] {
  const calls: FoodPropertyCall[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }
    if (
      qualified.name === "FoodProperties.Builder" ||
      (qualified.name === "Builder" &&
        tokens[index - 1]?.value === "." &&
        tokens[index - 2]?.value === "FoodProperties")
    ) {
      continue;
    }

    const openIndex = qualified.endIndex;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1 || closeIndex >= endIndex) {
      continue;
    }

    const args = splitTopLevelArguments(tokens, openIndex + 1, closeIndex).map((arg) =>
      sourceForArg(source, tokens, arg),
    );
    calls.push({
      name: unqualifiedName(qualified.name),
      qualifiedName: qualified.name,
      args,
      source: tokenSource(source, tokens, index, closeIndex + 1),
      range: tokenRange(tokens, index, closeIndex + 1),
    });

    index = closeIndex;
  }

  return calls;
}

function extractStaticFoodFields(source: string, tokens: JavaToken[]): StaticFoodField[] {
  const fields: StaticFoodField[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=") {
      continue;
    }

    const statementStart = findStatementStart(tokens, index);
    const statementEnd = findStatementEnd(tokens, statementStart);
    if (statementEnd === -1) {
      continue;
    }

    const declaresFoodProperties = tokens
      .slice(statementStart, index)
      .some(
        (token, relativeIndex, slicedTokens) =>
          token.value === "FoodProperties" &&
          slicedTokens[relativeIndex + 1]?.value !== ".",
      );
    if (!declaresFoodProperties) {
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
      initializer: tokenSource(source, tokens, index + 1, statementEnd),
      initializerStartIndex: index + 1,
      initializerEndIndex: statementEnd,
      source: tokenSource(source, tokens, statementStart, statementEnd + 1),
      range: tokenRange(tokens, statementStart, statementEnd + 1),
    });
  }

  return fields;
}

function parseParameters(tokens: JavaToken[], startIndex: number, endIndex: number): string[] {
  return splitTopLevelArguments(tokens, startIndex, endIndex)
    .map((arg) => {
      for (let index = arg.endIndex - 1; index >= arg.startIndex; index -= 1) {
        if (tokens[index].kind === "identifier") {
          return tokens[index].value;
        }
      }
      return null;
    })
    .filter((value): value is string => value !== null);
}

function extractBuilderHelpers(
  source: string,
  tokens: JavaToken[],
  diagnostics: ParserDiagnostic[],
): FoodBuilderHelper[] {
  const helpers: FoodBuilderHelper[] = [];

  for (let index = 0; index < tokens.length - 4; index += 1) {
    if (
      tokens[index].value !== "FoodProperties" ||
      tokens[index + 1]?.value !== "." ||
      tokens[index + 2]?.value !== "Builder" ||
      tokens[index + 4]?.value !== "(" ||
      tokens[index + 3]?.kind !== "identifier"
    ) {
      continue;
    }

    const name = tokens[index + 3].value;
    const parameterCloseIndex = findMatchingToken(tokens, index + 4);
    if (parameterCloseIndex === -1 || tokens[parameterCloseIndex + 1]?.value !== "{") {
      diagnostics.push({
        code: "foods.helper.malformed_signature",
        message: `Could not parse FoodProperties.Builder helper '${name}' signature or body.`,
        severity: "warning",
        range: tokenRange(tokens, index, index + 4),
        source: tokenSource(source, tokens, index, Math.min(index + 5, tokens.length)),
      });
      continue;
    }

    const bodyOpenIndex = parameterCloseIndex + 1;
    const bodyCloseIndex = findMatchingToken(tokens, bodyOpenIndex);
    if (bodyCloseIndex === -1) {
      diagnostics.push({
        code: "foods.helper.unclosed_body",
        message: `Could not find closing body for FoodProperties.Builder helper '${name}'.`,
        severity: "warning",
        range: tokenRange(tokens, index, bodyOpenIndex + 1),
        source: tokenSource(source, tokens, index, bodyOpenIndex + 1),
      });
      continue;
    }

    let returnExpression: string | null = null;
    let returnStartIndex = -1;
    let returnEndIndex = -1;
    for (let cursor = bodyOpenIndex + 1; cursor < bodyCloseIndex; cursor += 1) {
      if (tokens[cursor].value !== "return") {
        continue;
      }
      const returnStatementEnd = findStatementEnd(tokens, cursor);
      if (returnStatementEnd === -1 || returnStatementEnd > bodyCloseIndex) {
        continue;
      }
      returnStartIndex = cursor + 1;
      returnEndIndex = returnStatementEnd;
      returnExpression = tokenSource(source, tokens, returnStartIndex, returnEndIndex);
      break;
    }

    if (returnExpression === null) {
      diagnostics.push({
        code: "foods.helper.no_return",
        message: `FoodProperties.Builder helper '${name}' did not have a parseable return expression.`,
        severity: "warning",
        range: tokenRange(tokens, index, bodyCloseIndex + 1),
        source: tokenSource(source, tokens, index, bodyCloseIndex + 1),
      });
      continue;
    }

    helpers.push({
      name,
      parameters: parseParameters(tokens, index + 5, parameterCloseIndex),
      returnExpression,
      propertyCalls: parseMethodCalls(source, tokens, returnStartIndex, returnEndIndex),
      source: tokenSource(source, tokens, index, bodyCloseIndex + 1),
      range: tokenRange(tokens, index, bodyCloseIndex + 1),
    });
    index = bodyCloseIndex;
  }

  return helpers;
}

function substituteParameterArg(
  value: string,
  parameters: string[],
  args: string[],
): string {
  const parameterIndex = parameters.indexOf(value.trim());
  return parameterIndex === -1 ? value : (args[parameterIndex] ?? value);
}

function expandCallsWithHelper(
  calls: FoodPropertyCall[],
  helpersByName: Map<string, FoodBuilderHelper>,
  diagnostics: ParserDiagnostic[],
): { calls: FoodPropertyCall[]; helperName: string | null } {
  const helperCallIndex = calls.findIndex((call) => helpersByName.has(call.name));
  const potentialHelperCall = calls.find((call) => {
    if (HANDLED_FOOD_PROPERTY_CALLS.has(call.name)) {
      return false;
    }
    if (call.qualifiedName.includes(".") && !call.qualifiedName.startsWith("Foods.")) {
      return false;
    }
    return true;
  });

  if (helperCallIndex === -1) {
    if (potentialHelperCall) {
      diagnostics.push({
        code: "foods.helper.unresolved",
        message: `Food builder helper '${potentialHelperCall.qualifiedName}' was called but no matching helper was parsed.`,
        severity: "warning",
        range: potentialHelperCall.range,
        source: potentialHelperCall.source,
      });
    }
    return { calls, helperName: null };
  }

  const helperCall = calls[helperCallIndex];
  const helper = helpersByName.get(helperCall.name);
  if (!helper) {
    return { calls, helperName: null };
  }

  const helperCalls = helper.propertyCalls.map((call) => ({
    ...call,
    args: call.args.map((arg) =>
      substituteParameterArg(arg, helper.parameters, helperCall.args),
    ),
  }));

  return {
    calls: [
      ...calls.slice(0, helperCallIndex),
      ...helperCalls,
      ...calls.slice(helperCallIndex + 1),
    ],
    helperName: helper.name,
  };
}

function parseFoodFromField(
  source: string,
  tokens: JavaToken[],
  field: StaticFoodField,
  helpersByName: Map<string, FoodBuilderHelper>,
  diagnostics: ParserDiagnostic[],
): FoodDefinition {
  const rawCalls = parseMethodCalls(
    source,
    tokens,
    field.initializerStartIndex,
    field.initializerEndIndex,
  );
  const expanded = expandCallsWithHelper(rawCalls, helpersByName, diagnostics);

  let nutrition: number | null = null;
  let saturationModifier: number | null = null;
  let alwaysEdible = false;
  let usingConvertsTo: string | null = null;
  const effects: FoodEffect[] = [];
  const unhandledPropertyCalls: FoodPropertyCall[] = [];

  for (const call of expanded.calls) {
    if (call.name === "nutrition" && call.args[0]) {
      nutrition = parseIntegerLiteral(call.args[0]);
      if (nutrition === null) {
        diagnostics.push({
          code: "foods.property.invalid_nutrition",
          message: `Food '${field.fieldName}' has a nutrition call that is not a parseable integer literal.`,
          severity: "warning",
          range: call.range,
          source: call.source,
        });
      }
    } else if (call.name === "saturationModifier" && call.args[0]) {
      saturationModifier = parseNumberLiteral(call.args[0]);
      if (saturationModifier === null) {
        diagnostics.push({
          code: "foods.property.invalid_saturation_modifier",
          message: `Food '${field.fieldName}' has a saturationModifier call that is not a parseable number literal.`,
          severity: "warning",
          range: call.range,
          source: call.source,
        });
      }
    } else if (call.name === "alwaysEdible") {
      alwaysEdible = true;
    } else if (call.name === "usingConvertsTo" && call.args[0]) {
      usingConvertsTo = call.args[0];
    } else if (call.name === "effect" && call.args[0]) {
      const probability = call.args[1] ? parseNumberLiteral(call.args[1]) : null;
      if (call.args[1] && probability === null) {
        diagnostics.push({
          code: "foods.property.invalid_effect_probability",
          message: `Food '${field.fieldName}' has an effect probability that is not a parseable number literal.`,
          severity: "warning",
          range: call.range,
          source: call.source,
        });
      }
      effects.push({
        effectExpression: call.args[0],
        probability,
      });
    } else if (!HANDLED_FOOD_PROPERTY_CALLS.has(call.name)) {
      unhandledPropertyCalls.push(call);
      diagnostics.push({
        code: "foods.property.unhandled_call",
        message: `Food '${field.fieldName}' has an unhandled FoodProperties builder call '${call.qualifiedName}'.`,
        severity: "warning",
        range: call.range,
        source: call.source,
      });
    }
  }

  if (nutrition === null) {
    diagnostics.push({
      code: "foods.property.missing_nutrition",
      message: `Food '${field.fieldName}' did not resolve a nutrition value.`,
      severity: "warning",
      range: field.range,
      source: field.source,
    });
  }
  if (saturationModifier === null) {
    diagnostics.push({
      code: "foods.property.missing_saturation_modifier",
      message: `Food '${field.fieldName}' did not resolve a saturation modifier value.`,
      severity: "warning",
      range: field.range,
      source: field.source,
    });
  }

  return {
    fieldName: field.fieldName,
    id: toSnakeCaseFromConstant(field.fieldName),
    reference: `Foods.${field.fieldName}`,
    initializer: field.initializer,
    source: field.source,
    range: field.range,
    helperName: expanded.helperName,
    nutrition,
    saturationModifier,
    alwaysEdible,
    usingConvertsTo,
    effects,
    propertyCalls: expanded.calls,
    unhandledPropertyCalls,
  };
}

export function parseFoodsSource(source: string): FoodsParseResult {
  const tokens = tokenizeJava(source);
  const diagnostics: ParserDiagnostic[] = [];
  const helpers = extractBuilderHelpers(source, tokens, diagnostics);
  const helpersByName = new Map(helpers.map((helper) => [helper.name, helper]));
  const foods = extractStaticFoodFields(source, tokens).map((field) =>
    parseFoodFromField(source, tokens, field, helpersByName, diagnostics),
  );

  return {
    foods,
    helpers,
    foodByFieldName: Object.fromEntries(foods.map((food) => [food.fieldName, food])),
    foodByReference: Object.fromEntries(foods.map((food) => [food.reference, food])),
    diagnostics,
  };
}
