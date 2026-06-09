import { readFile } from "node:fs/promises";

import {
  findMatchingToken,
  findStatementEnd,
  findStatementStart,
  firstStringLiteral,
  isNameToken,
  readQualifiedNameAt,
  splitTopLevelArguments,
  tokenRange,
  tokenSource,
  unique,
  type ParserDiagnostic,
  type SourceRange,
  type TokenSlice,
} from "../java/parser-utils";
import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import type { ParsedBlockStateDefinition } from "./block-states";
import type { BlockShapeBehavior } from "./block-shapes";

export type BlockPropertyCall = {
  name: string;
  qualifiedName: string;
  args: string[];
  source: string;
  range: SourceRange;
};

export type BlockRegistrationKind =
  | "register"
  | "registerLegacyStair"
  | "registerStair"
  | "registerBed"
  | "registerStainedGlass"
  | "weatheringGroup"
  | "unknown";

export type BlockPropertyHelper = {
  name: string;
  parameters: string[];
  returnExpression: string;
  propertyCalls: BlockPropertyCall[];
  source: string;
  range: SourceRange;
};

export type BlockDefinition = {
  fieldName: string;
  id: string | null;
  reference: string;
  declarationType: string;
  registrationKind: BlockRegistrationKind;
  registrationCall: string | null;
  blockClass: string | null;
  factoryExpression: string | null;
  propertiesExpression: string | null;
  propertyHelperName: string | null;
  initializer: string;
  source: string;
  range: SourceRange;
  copiedFromBlockId: string | null;
  blockRefs: string[];
  itemRefs: string[];
  entityTypeRefs: string[];
  fluidRefs: string[];
  mapColor: string | null;
  instrument: string | null;
  soundType: string | null;
  pushReaction: string | null;
  strength: number | null;
  explosionResistance: number | null;
  lightLevelExpression: string | null;
  requiresCorrectToolForDrops: boolean;
  noLootTable: boolean;
  overrideLootTable: string | null;
  noCollision: boolean;
  noOcclusion: boolean;
  replaceable: boolean;
  air: boolean;
  liquid: boolean;
  randomTicks: boolean;
  ignitedByLava: boolean;
  dynamicShape: boolean;
  forceSolidOn: boolean;
  forceSolidOff: boolean;
  offsetType: string | null;
  shapeBehavior?: BlockShapeBehavior | null;
  blockStateDefinition?: ParsedBlockStateDefinition | null;
  rendering?: unknown;
  propertyCalls: BlockPropertyCall[];
  unhandledPropertyCalls: BlockPropertyCall[];
  diagnostics: ParserDiagnostic[];
};

export type BlocksParseResult = {
  blocks: BlockDefinition[];
  helpers: BlockPropertyHelper[];
  blockByFieldName: Record<string, BlockDefinition>;
  blockById: Record<string, BlockDefinition>;
  registrationKindCounts: Record<string, number>;
  blockClassCounts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
};

type StaticBlockField = {
  fieldName: string;
  declarationType: string;
  initializer: string;
  initializerStartIndex: number;
  initializerEndIndex: number;
  source: string;
  range: SourceRange;
};

type RegistrationCall = {
  kind: BlockRegistrationKind;
  qualifiedName: string;
  args: TokenSlice[];
  source: string;
  openIndex: number;
  closeIndex: number;
};

const HANDLED_BLOCK_PROPERTY_CALLS = new Set([
  "air",
  "dynamicShape",
  "explosionResistance",
  "forceSolidOff",
  "forceSolidOn",
  "ignitedByLava",
  "instabreak",
  "instrument",
  "isCollisionShapeFullBlock",
  "isRedstoneConductor",
  "isSuffocating",
  "isValidSpawn",
  "isViewBlocking",
  "lightLevel",
  "liquid",
  "mapColor",
  "noCollision",
  "noLootTable",
  "noOcclusion",
  "offsetType",
  "of",
  "ofFullCopy",
  "ofLegacyCopy",
  "overrideDescription",
  "overrideLootTable",
  "pushReaction",
  "randomTicks",
  "replaceable",
  "requiresCorrectToolForDrops",
  "sound",
  "strength",
]);

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

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function toMinecraftIdFromConstant(value: string): string {
  return `minecraft:${value.toLowerCase()}`;
}

function normalizeNumberLiteral(source: string): string {
  return source.trim().replace(/_/g, "").replace(/[fFdDlL]$/, "");
}

function parseNumberLiteral(source: string): number | null {
  const normalized = normalizeNumberLiteral(source);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceForArg(source: string, tokens: JavaToken[], arg: TokenSlice): string {
  return tokenSource(source, tokens, arg.startIndex, arg.endIndex);
}

function unqualifiedName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function normalizeQualifiedEnum(value: string): string {
  return value.trim().replace(/^\(?/, "").replace(/\)?$/, "");
}

function blockIdFromExpression(expression: string | null | undefined): string | null {
  if (!expression) {
    return null;
  }
  const trimmed = expression.trim();
  const block = /^(?:Blocks\.)?([A-Z][A-Z0-9_]*)$/.exec(trimmed);
  if (block) {
    return toMinecraftIdFromConstant(block[1]);
  }
  const blockIds = /^BlockIds\.([A-Z][A-Z0-9_]*)$/.exec(trimmed);
  if (blockIds) {
    return toMinecraftIdFromConstant(blockIds[1]);
  }
  const stringLiteral = /^"([^"]+)"$/.exec(trimmed);
  if (stringLiteral) {
    return `minecraft:${stringLiteral[1]}`;
  }
  return null;
}

function collectQualifiedRefs(source: string, root: string): string[] {
  const regex = new RegExp(`\\b${root}\\.([A-Z][A-Z0-9_]*)\\b`, "g");
  return unique([...source.matchAll(regex)].map((match) => toMinecraftIdFromConstant(match[1])));
}

function extractStaticBlockFields(source: string, tokens: JavaToken[]): StaticBlockField[] {
  const fields: StaticBlockField[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=") {
      continue;
    }

    const statementStart = findStatementStart(tokens, index);
    const statementEnd = findStatementEnd(tokens, statementStart);
    if (statementEnd === -1) {
      continue;
    }

    const prefix = tokens.slice(statementStart, index).map((token) => token.value);
    const publicStaticFinal =
      prefix.includes("public") &&
      prefix.includes("static") &&
      prefix.includes("final");
    if (!publicStaticFinal) {
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
    if (finalIndex === -1) {
      continue;
    }

    const declarationType = tokenSource(source, tokens, finalIndex + 1, fieldIndex).trim();
    if (declarationType !== "Block" && declarationType !== "WeatheringCopperBlocks") {
      continue;
    }

    fields.push({
      fieldName: tokens[fieldIndex].value,
      declarationType,
      initializer: tokenSource(source, tokens, index + 1, statementEnd),
      initializerStartIndex: index + 1,
      initializerEndIndex: statementEnd,
      source: tokenSource(source, tokens, statementStart, statementEnd + 1),
      range: tokenRange(tokens, statementStart, statementEnd + 1),
    });
  }

  return fields;
}

function parseMethodCalls(
  source: string,
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
): BlockPropertyCall[] {
  const calls: BlockPropertyCall[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    if (
      tokens[index - 1]?.value === "." &&
      (tokens[index].value === "Properties" || tokens[index - 2]?.value === "Properties")
    ) {
      continue;
    }
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }
    if (
      qualified.name === "BlockBehaviour.Properties" ||
      (qualified.name === "Properties" &&
        tokens[index - 1]?.value === "." &&
        tokens[index - 2]?.value === "BlockBehaviour")
    ) {
      continue;
    }

    const openIndex = qualified.endIndex;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1 || closeIndex >= endIndex) {
      continue;
    }

    calls.push({
      name: unqualifiedName(qualified.name),
      qualifiedName: qualified.name,
      args: splitTopLevelArguments(tokens, openIndex + 1, closeIndex).map((arg) =>
        sourceForArg(source, tokens, arg),
      ),
      source: tokenSource(source, tokens, index, closeIndex + 1),
      range: tokenRange(tokens, index, closeIndex + 1),
    });
  }

  return calls;
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

function extractPropertyHelpers(
  source: string,
  tokens: JavaToken[],
  diagnostics: ParserDiagnostic[],
): BlockPropertyHelper[] {
  const helpers: BlockPropertyHelper[] = [];

  for (let index = 0; index < tokens.length - 4; index += 1) {
    const returnsProperties =
      tokens[index].value === "BlockBehaviour" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "Properties" &&
      tokens[index + 4]?.value === "(" &&
      tokens[index + 3]?.kind === "identifier";
    const returnsBlock =
      tokens[index].value === "Block" &&
      tokens[index + 2]?.value === "(" &&
      tokens[index + 1]?.kind === "identifier";
    if (!returnsProperties && !returnsBlock) {
      continue;
    }

    const nameIndex = returnsProperties ? index + 3 : index + 1;
    const parameterOpenIndex = returnsProperties ? index + 4 : index + 2;
    const name = tokens[nameIndex].value;
    if (returnsBlock && name === "register") {
      continue;
    }
    const parameterCloseIndex = findMatchingToken(tokens, parameterOpenIndex);
    if (parameterCloseIndex === -1 || tokens[parameterCloseIndex + 1]?.value !== "{") {
      continue;
    }

    const bodyOpenIndex = parameterCloseIndex + 1;
    const bodyCloseIndex = findMatchingToken(tokens, bodyOpenIndex);
    if (bodyCloseIndex === -1) {
      diagnostics.push(
        diagnostic({
          code: "blocks.helper.unclosed_body",
          message: `Could not find closing body for BlockBehaviour.Properties helper '${name}'.`,
          range: tokenRange(tokens, index, bodyOpenIndex + 1),
          source: tokenSource(source, tokens, index, bodyOpenIndex + 1),
        }),
      );
      continue;
    }

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
      break;
    }

    if (returnStartIndex === -1) {
      continue;
    }

    helpers.push({
      name,
      parameters: parseParameters(tokens, parameterOpenIndex + 1, parameterCloseIndex),
      returnExpression: tokenSource(source, tokens, returnStartIndex, returnEndIndex),
      propertyCalls: parseMethodCalls(source, tokens, returnStartIndex, returnEndIndex)
        .filter((call) => HANDLED_BLOCK_PROPERTY_CALLS.has(call.name)),
      source: tokenSource(source, tokens, index, bodyCloseIndex + 1),
      range: tokenRange(tokens, index, bodyCloseIndex + 1),
    });
    index = bodyCloseIndex;
  }

  return helpers;
}

function substituteParameterArg(value: string, parameters: string[], args: string[]): string {
  const parameterIndex = parameters.indexOf(value.trim());
  return parameterIndex === -1 ? value : (args[parameterIndex] ?? value);
}

function expandCallsWithPropertyHelper(input: {
  calls: BlockPropertyCall[];
  helpersByName: Map<string, BlockPropertyHelper>;
}): { calls: BlockPropertyCall[]; helperName: string | null } {
  const helperCallIndex = input.calls.findIndex((call) => input.helpersByName.has(call.name));
  if (helperCallIndex === -1) {
    return { calls: input.calls, helperName: null };
  }

  const helperCall = input.calls[helperCallIndex];
  const helper = input.helpersByName.get(helperCall.name);
  if (!helper) {
    return { calls: input.calls, helperName: null };
  }

  const helperCalls = helper.propertyCalls.map((call) => ({
    ...call,
    args: call.args.map((arg) => substituteParameterArg(arg, helper.parameters, helperCall.args)),
  }));

  return {
    calls: [
      ...input.calls.slice(0, helperCallIndex),
      ...helperCalls,
      ...input.calls.slice(helperCallIndex + 1),
    ],
    helperName: helper.name,
  };
}

function findRegistrationCall(
  source: string,
  tokens: JavaToken[],
  field: StaticBlockField,
): RegistrationCall | null {
  for (let index = field.initializerStartIndex; index < field.initializerEndIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    let kind: BlockRegistrationKind | null = null;
    if (qualified.name === "Blocks.register") {
      kind = "register";
    } else if (qualified.name === "Blocks.registerLegacyStair") {
      kind = "registerLegacyStair";
    } else if (qualified.name === "Blocks.registerStair") {
      kind = "registerStair";
    } else if (qualified.name === "Blocks.registerBed") {
      kind = "registerBed";
    } else if (qualified.name === "Blocks.registerStainedGlass") {
      kind = "registerStainedGlass";
    } else if (qualified.name === "WeatheringCopperBlocks.create") {
      kind = "weatheringGroup";
    }

    if (!kind) {
      continue;
    }

    const openIndex = qualified.endIndex;
    const closeIndex = findMatchingToken(tokens, openIndex);
    if (closeIndex === -1 || closeIndex > field.initializerEndIndex) {
      continue;
    }

    return {
      kind,
      qualifiedName: qualified.name,
      args: splitTopLevelArguments(tokens, openIndex + 1, closeIndex),
      source: tokenSource(source, tokens, index, closeIndex + 1),
      openIndex,
      closeIndex,
    };
  }

  return null;
}

function factoryClassFromExpression(expression: string | null): string | null {
  if (!expression) {
    return null;
  }
  const methodRefNew = /\b([A-Za-z_$][A-Za-z0-9_$]*)::new\b/.exec(expression);
  if (methodRefNew) {
    return methodRefNew[1];
  }
  const constructor = /\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]+>)?\s*\(/.exec(expression);
  if (constructor) {
    return constructor[1];
  }
  return null;
}

function looksLikePropertiesExpression(expression: string): boolean {
  return (
    /\bBlockBehaviour\.Properties\./.test(expression) ||
    /\bBlocks\.[A-Za-z_$][A-Za-z0-9_$]*Properties\s*\(/.test(expression) ||
    /\bBlocks\.(?:wallVariant|flowerPotProperties|buttonProperties)\s*\(/.test(expression)
  );
}

function classifyRegistrationArgs(input: {
  source: string;
  tokens: JavaToken[];
  registration: RegistrationCall | null;
}): {
  factoryExpression: string | null;
  propertiesExpression: string | null;
  registrationArgSources: string[];
} {
  if (!input.registration) {
    return { factoryExpression: null, propertiesExpression: null, registrationArgSources: [] };
  }

  const args = input.registration.args.map((arg) => sourceForArg(input.source, input.tokens, arg));
  let factoryExpression: string | null = null;
  let propertiesExpression: string | null = null;

  for (const arg of args.slice(1)) {
    if (looksLikePropertiesExpression(arg)) {
      propertiesExpression = arg;
    } else if (!factoryExpression && (/::/.test(arg) || /->/.test(arg))) {
      factoryExpression = arg;
    }
  }

  return {
    factoryExpression,
    propertiesExpression,
    registrationArgSources: args,
  };
}

function inferBlockClass(input: {
  registrationKind: BlockRegistrationKind;
  factoryExpression: string | null;
  registrationArgSources: string[];
}): string | null {
  const factoryClass = factoryClassFromExpression(input.factoryExpression);
  if (factoryClass) {
    return factoryClass;
  }
  if (input.registrationKind === "registerLegacyStair" || input.registrationKind === "registerStair") {
    return "StairBlock";
  }
  if (input.registrationKind === "registerBed") {
    return "BedBlock";
  }
  if (input.registrationKind === "registerStainedGlass") {
    return "StainedGlassBlock";
  }
  if (input.registrationKind === "register") {
    const factoryArg = input.registrationArgSources.find((arg) => /::new|->\s*new\b/.test(arg));
    return factoryClassFromExpression(factoryArg ?? null) ?? "Block";
  }
  if (input.registrationKind === "weatheringGroup") {
    return "WeatheringCopperBlocks";
  }
  return null;
}

function blockIdFromRegistration(input: {
  fieldName: string;
  registrationKind: BlockRegistrationKind;
  registrationArgSources: string[];
}): string | null {
  const firstArg = input.registrationArgSources[0];
  if (!firstArg) {
    return null;
  }
  const fromExpression = blockIdFromExpression(firstArg);
  if (fromExpression) {
    return fromExpression;
  }
  const tokenized = tokenizeJava(firstArg);
  const stringLiteral = firstStringLiteral(tokenized, 0, tokenized.length);
  if (stringLiteral) {
    return `minecraft:${stringLiteral}`;
  }
  return toMinecraftIdFromConstant(input.fieldName);
}

function propertiesCallsFromField(
  source: string,
  tokens: JavaToken[],
  field: StaticBlockField,
  helpersByName: Map<string, BlockPropertyHelper>,
): { calls: BlockPropertyCall[]; helperName: string | null } {
  const rawCalls = parseMethodCalls(source, tokens, field.initializerStartIndex, field.initializerEndIndex)
    .filter((call) => (
      HANDLED_BLOCK_PROPERTY_CALLS.has(call.name) ||
      helpersByName.has(call.name)
    ));
  return expandCallsWithPropertyHelper({ calls: rawCalls, helpersByName });
}

function parseBlockFromField(
  source: string,
  tokens: JavaToken[],
  field: StaticBlockField,
  helpersByName: Map<string, BlockPropertyHelper>,
): BlockDefinition {
  const diagnostics: ParserDiagnostic[] = [];
  const registration = findRegistrationCall(source, tokens, field);
  const classified = classifyRegistrationArgs({ source, tokens, registration });
  const registrationKind = registration?.kind ?? "unknown";
  const registrationArgSources = classified.registrationArgSources;
  const expanded = propertiesCallsFromField(source, tokens, field, helpersByName);
  const propertyCalls = expanded.calls;
  const unhandledPropertyCalls: BlockPropertyCall[] = [];
  const callNames = new Set(propertyCalls.map((call) => call.name));
  const blockClass = inferBlockClass({
    registrationKind,
    factoryExpression: classified.factoryExpression,
    registrationArgSources,
  });
  const strengthCall = propertyCalls.find((call) => call.name === "strength");
  const strength = strengthCall?.args[0] ? parseNumberLiteral(strengthCall.args[0]) : null;
  const explosionResistanceFromStrength = strengthCall?.args[1] ? parseNumberLiteral(strengthCall.args[1]) : null;
  const explosionResistanceCall = propertyCalls.find((call) => call.name === "explosionResistance");
  const explicitExplosionResistance = explosionResistanceCall?.args[0]
    ? parseNumberLiteral(explosionResistanceCall.args[0])
    : null;
  const copiedFromBlockId =
    propertyCalls.find((call) => call.name === "ofLegacyCopy" || call.name === "ofFullCopy")?.args[0]
      ? blockIdFromExpression(propertyCalls.find((call) => call.name === "ofLegacyCopy" || call.name === "ofFullCopy")?.args[0])
      : blockIdFromExpression(registrationKind === "registerLegacyStair" || registrationKind === "registerStair"
        ? registrationArgSources[1]
        : null);

  for (const call of propertyCalls) {
    if (!HANDLED_BLOCK_PROPERTY_CALLS.has(call.name) && !helpersByName.has(call.name)) {
      unhandledPropertyCalls.push(call);
      diagnostics.push(
        diagnostic({
          code: "blocks.property.unhandled_call",
          message: `Block '${field.fieldName}' has an unhandled BlockBehaviour.Properties call '${call.qualifiedName}'.`,
          range: call.range,
          source: call.source,
          details: { fieldName: field.fieldName, call: call.qualifiedName },
        }),
      );
    }
  }

  if (!registration) {
    diagnostics.push(
      diagnostic({
        code: "blocks.registration.unresolved",
        message: `Block field '${field.fieldName}' did not use a handled registration helper.`,
        range: field.range,
        source: field.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }

  if (strengthCall && strength === null && strengthCall.args[0]) {
    diagnostics.push(
      diagnostic({
        code: "blocks.property.invalid_strength",
        message: `Block '${field.fieldName}' has a strength call whose first argument is not a parseable number literal.`,
        range: strengthCall.range,
        source: strengthCall.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }

  return {
    fieldName: field.fieldName,
    id: blockIdFromRegistration({ fieldName: field.fieldName, registrationKind, registrationArgSources }),
    reference: `Blocks.${field.fieldName}`,
    declarationType: field.declarationType,
    registrationKind,
    registrationCall: registration?.qualifiedName ?? null,
    blockClass,
    factoryExpression: classified.factoryExpression,
    propertiesExpression: classified.propertiesExpression,
    propertyHelperName: expanded.helperName,
    initializer: field.initializer,
    source: field.source,
    range: field.range,
    copiedFromBlockId,
    blockRefs: collectQualifiedRefs(field.initializer, "Blocks"),
    itemRefs: collectQualifiedRefs(field.initializer, "Items"),
    entityTypeRefs: collectQualifiedRefs(field.initializer, "EntityType"),
    fluidRefs: collectQualifiedRefs(field.initializer, "Fluids"),
    mapColor: propertyCalls.find((call) => call.name === "mapColor")?.args[0]?.trim() ?? null,
    instrument: propertyCalls.find((call) => call.name === "instrument")?.args[0]?.trim() ?? null,
    soundType: propertyCalls.find((call) => call.name === "sound")?.args[0]?.trim() ?? null,
    pushReaction: propertyCalls.find((call) => call.name === "pushReaction")?.args[0]?.trim() ?? null,
    strength,
    explosionResistance: explicitExplosionResistance ?? explosionResistanceFromStrength,
    lightLevelExpression: propertyCalls.find((call) => call.name === "lightLevel")?.args[0]?.trim() ?? null,
    requiresCorrectToolForDrops: callNames.has("requiresCorrectToolForDrops"),
    noLootTable: callNames.has("noLootTable"),
    overrideLootTable: propertyCalls.find((call) => call.name === "overrideLootTable")?.args[0]?.trim() ?? null,
    noCollision: callNames.has("noCollision"),
    noOcclusion: callNames.has("noOcclusion"),
    replaceable: callNames.has("replaceable"),
    air: callNames.has("air"),
    liquid: callNames.has("liquid"),
    randomTicks: callNames.has("randomTicks"),
    ignitedByLava: callNames.has("ignitedByLava"),
    dynamicShape: callNames.has("dynamicShape"),
    forceSolidOn: callNames.has("forceSolidOn"),
    forceSolidOff: callNames.has("forceSolidOff"),
    offsetType: propertyCalls.find((call) => call.name === "offsetType")?.args[0]
      ? normalizeQualifiedEnum(propertyCalls.find((call) => call.name === "offsetType")?.args[0] ?? "")
      : null,
    propertyCalls,
    unhandledPropertyCalls,
    diagnostics,
  };
}

export function parseBlocksSource(source: string): BlocksParseResult {
  const tokens = tokenizeJava(source);
  const diagnostics: ParserDiagnostic[] = [];
  const helpers = extractPropertyHelpers(source, tokens, diagnostics);
  const helpersByName = new Map(helpers.map((helper) => [helper.name, helper]));
  const blocks = extractStaticBlockFields(source, tokens).map((field) =>
    parseBlockFromField(source, tokens, field, helpersByName),
  );
  const allDiagnostics = [...diagnostics, ...blocks.flatMap((block) => block.diagnostics)];

  return {
    blocks,
    helpers,
    blockByFieldName: Object.fromEntries(blocks.map((block) => [block.fieldName, block])),
    blockById: Object.fromEntries(blocks.flatMap((block) => block.id ? [[block.id, block]] : [])),
    registrationKindCounts: countBy(blocks.map((block) => block.registrationKind)),
    blockClassCounts: countBy(blocks.map((block) => block.blockClass ?? "unknown")),
    diagnostics: allDiagnostics,
  };
}

export async function loadBlocksFromFile(filePath: string): Promise<BlocksParseResult> {
  return parseBlocksSource(await readFile(filePath, "utf8"));
}
