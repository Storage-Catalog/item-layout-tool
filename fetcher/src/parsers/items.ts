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

export type ItemPropertyCall = {
  name: string;
  qualifiedName: string;
  args: string[];
  source: string;
  range: SourceRange;
};

export type ItemRegistrationKind =
  | "registerBlock"
  | "registerItem"
  | "registerSpawnEgg"
  | "weatheringGroup"
  | "unknown";

export type ItemDefinition = {
  fieldName: string;
  id: string | null;
  reference: string;
  declarationType: string;
  registrationKind: ItemRegistrationKind;
  registrationCall: string | null;
  itemClass: string | null;
  factoryExpression: string | null;
  propertiesExpression: string | null;
  initializer: string;
  source: string;
  range: SourceRange;
  hasBlock: boolean;
  blockId: string | null;
  alternativeBlockIds: string[];
  entityTypeIds: string[];
  fluidIds: string[];
  maxStackSize: number | null;
  maxStackSource: "explicit" | "damageable" | "default" | "unknown";
  durability: number | null;
  rarity: string | null;
  foodIds: string[];
  consumableIds: string[];
  componentIds: string[];
  craftRemainder: string | null;
  usingConvertsTo: string | null;
  fireResistant: boolean;
  isDamageable: boolean;
  isSpawnEgg: boolean;
  toolMaterial: string | null;
  armorMaterial: string | null;
  armorType: string | null;
  trimMaterial: string | null;
  rendering?: unknown;
  propertyCalls: ItemPropertyCall[];
  unhandledPropertyCalls: ItemPropertyCall[];
  diagnostics: ParserDiagnostic[];
};

export type ItemsParseResult = {
  items: ItemDefinition[];
  itemByFieldName: Record<string, ItemDefinition>;
  itemById: Record<string, ItemDefinition>;
  registrationKindCounts: Record<string, number>;
  itemClassCounts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
};

type StaticItemsField = {
  fieldName: string;
  declarationType: string;
  initializer: string;
  initializerStartIndex: number;
  initializerEndIndex: number;
  source: string;
  range: SourceRange;
};

type RegistrationCall = {
  kind: ItemRegistrationKind;
  qualifiedName: string;
  args: TokenSlice[];
  source: string;
  openIndex: number;
  closeIndex: number;
};

const HANDLED_ITEM_PROPERTY_CALLS = new Set([
  "archerWeapon",
  "axe",
  "breakSound",
  "component",
  "craftRemainder",
  "durability",
  "fireResistant",
  "food",
  "humanoidArmor",
  "jukeboxPlayable",
  "pickaxe",
  "rarity",
  "repairable",
  "shield",
  "shovel",
  "spawnEgg",
  "stacksTo",
  "sword",
  "trimMaterial",
  "useBlockDescriptionPrefix",
  "useItemDescriptionPrefix",
  "usingConvertsTo",
]);

const DAMAGEABLE_PROPERTY_CALLS = new Set([
  "archerWeapon",
  "axe",
  "durability",
  "humanoidArmor",
  "pickaxe",
  "shield",
  "shovel",
  "sword",
]);

const DAMAGEABLE_ITEM_CLASSES = new Set([
  "AxeItem",
  "BowItem",
  "BrushItem",
  "CrossbowItem",
  "FishingRodItem",
  "FlintAndSteelItem",
  "HoeItem",
  "MaceItem",
  "ShearsItem",
  "ShieldItem",
  "ShovelItem",
  "SpyglassItem",
  "TridentItem",
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

function normalizeItemReference(value: string): string | null {
  const trimmed = value.trim();
  const qualified = /^(?:Items\.)?([A-Z][A-Z0-9_]*)$/.exec(trimmed);
  if (qualified) {
    return toMinecraftIdFromConstant(qualified[1]);
  }
  const stringLiteral = /^"([^"]+)"$/.exec(trimmed);
  if (stringLiteral) {
    return `minecraft:${stringLiteral[1]}`;
  }
  return null;
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

function parseIntegerLiteral(source: string): number | null {
  const parsed = parseNumberLiteral(source);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function sourceForArg(source: string, tokens: JavaToken[], arg: TokenSlice): string {
  return tokenSource(source, tokens, arg.startIndex, arg.endIndex);
}

function unqualifiedName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function collectQualifiedRefs(source: string, root: string): string[] {
  const regex = new RegExp(`\\b${root}\\.([A-Z][A-Z0-9_]*)\\b`, "g");
  return unique([...source.matchAll(regex)].map((match) => toMinecraftIdFromConstant(match[1])));
}

function collectRawQualifiedRefs(source: string, root: string): string[] {
  const regex = new RegExp(`\\b${root}\\.([A-Z][A-Z0-9_]*)\\b`, "g");
  return unique([...source.matchAll(regex)].map((match) => match[1]));
}

function extractStaticItemsFields(source: string, tokens: JavaToken[]): StaticItemsField[] {
  const fields: StaticItemsField[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=") {
      continue;
    }

    const statementStart = findStatementStart(tokens, index);
    const statementEnd = findStatementEnd(tokens, statementStart);
    if (statementEnd === -1) {
      continue;
    }

    const statementPrefix = tokens.slice(statementStart, index).map((token) => token.value);
    const publicStaticFinal =
      statementPrefix.includes("public") &&
      statementPrefix.includes("static") &&
      statementPrefix.includes("final");
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
    if (!/(^|[<,\s])Item($|[>,\s])/.test(declarationType) && declarationType !== "WeatheringCopperItems") {
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
): ItemPropertyCall[] {
  const calls: ItemPropertyCall[] = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }
    if (
      qualified.name === "Item.Properties" ||
      (qualified.name === "Properties" &&
        tokens[index - 1]?.value === "." &&
        tokens[index - 2]?.value === "Item")
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

function findRegistrationCall(
  source: string,
  tokens: JavaToken[],
  field: StaticItemsField,
): RegistrationCall | null {
  for (let index = field.initializerStartIndex; index < field.initializerEndIndex; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (!qualified || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    const name = qualified.name;
    let kind: ItemRegistrationKind | null = null;
    if (name === "Items.registerBlock") {
      kind = "registerBlock";
    } else if (name === "Items.registerItem") {
      kind = "registerItem";
    } else if (name === "Items.registerSpawnEgg") {
      kind = "registerSpawnEgg";
    } else if (name === "WeatheringCopperItems.create") {
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
      qualifiedName: name,
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
  const staticFactory = /\b([A-Za-z_$][A-Za-z0-9_$]*)::([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(expression);
  if (staticFactory) {
    return `${staticFactory[1]}::${staticFactory[2]}`;
  }
  return null;
}

function looksLikePropertiesExpression(expression: string): boolean {
  const trimmed = expression.trim();
  return (
    /\bnew\s+Item\.Properties\s*\(/.test(trimmed) ||
    /^[A-Za-z_$][A-Za-z0-9_$]*\s*->\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\./.test(trimmed) ||
    /^\([^)]*Item\.Properties[^)]*\)\s*->/.test(trimmed)
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
      propertiesExpression = propertiesExpression ? `${propertiesExpression}; ${arg}` : arg;
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

function inferItemClass(input: {
  registrationKind: ItemRegistrationKind;
  declarationType: string;
  factoryExpression: string | null;
  registrationArgSources: string[];
}): string | null {
  const explicitFactoryClass = factoryClassFromExpression(input.factoryExpression);
  if (explicitFactoryClass) {
    return explicitFactoryClass;
  }

  if (input.registrationKind === "registerSpawnEgg") {
    return "SpawnEggItem";
  }
  if (input.registrationKind === "registerBlock") {
    const factoryArg = input.registrationArgSources.find((arg) => /::new|->\s*new\b/.test(arg));
    return factoryClassFromExpression(factoryArg ?? null) ?? "BlockItem";
  }
  if (input.registrationKind === "registerItem") {
    const factoryArg = input.registrationArgSources.find((arg) => /::new|::[A-Za-z_$]|->\s*new\b/.test(arg));
    return factoryClassFromExpression(factoryArg ?? null) ?? "Item";
  }
  if (input.registrationKind === "weatheringGroup") {
    return input.declarationType;
  }
  return null;
}

function itemIdFromRegistration(input: {
  fieldName: string;
  registrationKind: ItemRegistrationKind;
  registrationArgSources: string[];
  initializer: string;
}): string | null {
  if (input.registrationKind === "registerBlock" || input.registrationKind === "weatheringGroup") {
    const block = /^Blocks\.([A-Z0-9_]+)$/.exec(input.registrationArgSources[0]?.trim() ?? "")?.[1];
    return block ? toMinecraftIdFromConstant(block) : null;
  }

  if (input.registrationKind === "registerSpawnEgg") {
    const entity = /^EntityType\.([A-Z0-9_]+)$/.exec(input.registrationArgSources[0]?.trim() ?? "")?.[1];
    return entity ? `minecraft:${entity.toLowerCase()}_spawn_egg` : null;
  }

  if (input.registrationKind === "registerItem") {
    const firstArg = input.registrationArgSources[0];
    if (!firstArg) {
      return null;
    }
    const stringLiteral = /^"([^"]+)"$/.exec(firstArg.trim());
    if (stringLiteral) {
      return `minecraft:${stringLiteral[1]}`;
    }
    const resourceKeyName = firstStringLiteral(tokenizeJava(firstArg), 0, tokenizeJava(firstArg).length);
    if (resourceKeyName) {
      return `minecraft:${resourceKeyName}`;
    }
  }

  return toMinecraftIdFromConstant(input.fieldName);
}

function propertyCallsFromInitializer(
  source: string,
  tokens: JavaToken[],
  field: StaticItemsField,
): ItemPropertyCall[] {
  return parseMethodCalls(source, tokens, field.initializerStartIndex, field.initializerEndIndex)
    .filter((call) => HANDLED_ITEM_PROPERTY_CALLS.has(call.name));
}

function parseItemFromField(
  source: string,
  tokens: JavaToken[],
  field: StaticItemsField,
): ItemDefinition {
  const diagnostics: ParserDiagnostic[] = [];
  const registration = findRegistrationCall(source, tokens, field);
  const classified = classifyRegistrationArgs({ source, tokens, registration });
  const registrationKind = registration?.kind ?? "unknown";
  const propertyCalls = propertyCallsFromInitializer(source, tokens, field);
  const callNames = new Set(propertyCalls.map((call) => call.name));
  const blockIds = collectQualifiedRefs(field.initializer, "Blocks");
  const entityTypeIds = collectQualifiedRefs(field.initializer, "EntityType");
  const fluidIds = collectQualifiedRefs(field.initializer, "Fluids");
  const componentIds = unique(
    propertyCalls
      .filter((call) => call.name === "component")
      .flatMap((call) => collectRawQualifiedRefs(call.source, "DataComponents").map(toMinecraftIdFromConstant)),
  );
  const foodIds = unique(
    propertyCalls
      .filter((call) => call.name === "food")
      .flatMap((call) => collectRawQualifiedRefs(call.source, "Foods").map(toMinecraftIdFromConstant)),
  );
  const consumableIds = unique(
    propertyCalls
      .filter((call) => call.name === "food" || call.name === "component")
      .flatMap((call) => collectRawQualifiedRefs(call.source, "Consumables").map(toMinecraftIdFromConstant)),
  );
  const registrationArgSources = classified.registrationArgSources;
  const itemClass = inferItemClass({
    registrationKind,
    declarationType: field.declarationType,
    factoryExpression: classified.factoryExpression,
    registrationArgSources,
  });
  const explicitStackCall = propertyCalls.find((call) => call.name === "stacksTo");
  const explicitMaxStack = explicitStackCall?.args[0] ? parseIntegerLiteral(explicitStackCall.args[0]) : null;
  const durabilityCall = propertyCalls.find((call) => call.name === "durability");
  const durability = durabilityCall?.args[0] ? parseIntegerLiteral(durabilityCall.args[0]) : null;
  const isDamageable =
    durability !== null ||
    [...callNames].some((name) => DAMAGEABLE_PROPERTY_CALLS.has(name)) ||
    (itemClass !== null && DAMAGEABLE_ITEM_CLASSES.has(itemClass));
  const maxStackSize = explicitMaxStack ?? (isDamageable ? 1 : 64);
  const maxStackSource = explicitMaxStack !== null ? "explicit" : isDamageable ? "damageable" : "default";
  const rarity = propertyCalls.find((call) => call.name === "rarity")?.args[0]?.trim() ?? null;
  const craftRemainder = propertyCalls.find((call) => call.name === "craftRemainder")?.args[0] ?? null;
  const usingConvertsTo = propertyCalls.find((call) => call.name === "usingConvertsTo")?.args[0] ?? null;
  const trimMaterial = propertyCalls.find((call) => call.name === "trimMaterial")?.args[0]?.trim() ?? null;
  const armorCall = propertyCalls.find((call) => call.name === "humanoidArmor");
  const toolCall = propertyCalls.find((call) =>
    ["sword", "pickaxe", "axe", "hoe", "shovel"].includes(call.name),
  );

  if (!registration) {
    diagnostics.push(
      diagnostic({
        code: "items.registration.unresolved",
        message: `Item field '${field.fieldName}' did not use a handled registration helper.`,
        range: field.range,
        source: field.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }

  if (explicitStackCall && explicitMaxStack === null) {
    diagnostics.push(
      diagnostic({
        code: "items.property.invalid_stacks_to",
        message: `Item '${field.fieldName}' has a stacksTo call that is not a parseable integer literal.`,
        range: explicitStackCall.range,
        source: explicitStackCall.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }

  if (durabilityCall && durability === null) {
    diagnostics.push(
      diagnostic({
        code: "items.property.invalid_durability",
        message: `Item '${field.fieldName}' has a durability call that is not a parseable integer literal.`,
        range: durabilityCall.range,
        source: durabilityCall.source,
        details: { fieldName: field.fieldName },
      }),
    );
  }

  return {
    fieldName: field.fieldName,
    id: itemIdFromRegistration({
      fieldName: field.fieldName,
      registrationKind,
      registrationArgSources,
      initializer: field.initializer,
    }),
    reference: `Items.${field.fieldName}`,
    declarationType: field.declarationType,
    registrationKind,
    registrationCall: registration?.qualifiedName ?? null,
    itemClass,
    factoryExpression: classified.factoryExpression,
    propertiesExpression: classified.propertiesExpression,
    initializer: field.initializer,
    source: field.source,
    range: field.range,
    hasBlock: registrationKind === "registerBlock" || blockIds.length > 0,
    blockId: blockIds[0] ?? null,
    alternativeBlockIds: blockIds.slice(1),
    entityTypeIds,
    fluidIds,
    maxStackSize,
    maxStackSource,
    durability,
    rarity,
    foodIds,
    consumableIds,
    componentIds,
    craftRemainder: craftRemainder ? normalizeItemReference(craftRemainder) ?? craftRemainder.trim() : null,
    usingConvertsTo: usingConvertsTo ? normalizeItemReference(usingConvertsTo) ?? usingConvertsTo.trim() : null,
    fireResistant: callNames.has("fireResistant"),
    isDamageable,
    isSpawnEgg: registrationKind === "registerSpawnEgg" || callNames.has("spawnEgg") || (itemClass === "SpawnEggItem"),
    toolMaterial: toolCall?.args[0]?.trim() ?? null,
    armorMaterial: armorCall?.args[0]?.trim() ?? null,
    armorType: armorCall?.args[1]?.trim() ?? null,
    trimMaterial,
    propertyCalls,
    unhandledPropertyCalls: [],
    diagnostics,
  };
}

export function parseItemsSource(source: string): ItemsParseResult {
  const tokens = tokenizeJava(source);
  const fields = extractStaticItemsFields(source, tokens);
  const items = fields.map((field) => parseItemFromField(source, tokens, field));
  const diagnostics = items.flatMap((item) => item.diagnostics);

  return {
    items,
    itemByFieldName: Object.fromEntries(items.map((item) => [item.fieldName, item])),
    itemById: Object.fromEntries(items.flatMap((item) => item.id ? [[item.id, item]] : [])),
    registrationKindCounts: countBy(items.map((item) => item.registrationKind)),
    itemClassCounts: countBy(items.map((item) => item.itemClass ?? "unknown")),
    diagnostics,
  };
}

export async function loadItemsFromFile(filePath: string): Promise<ItemsParseResult> {
  return parseItemsSource(await readFile(filePath, "utf8"));
}
