import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import {
  findMatchingToken,
  firstQualifiedReference,
  findQualifiedReferences,
  readQualifiedNameAt,
  splitTopLevelArguments,
  stripJavaStringQuotes,
  tokenRange,
  tokenSource,
  type ParserDiagnostic,
  type SourceRange,
  type TokenSlice,
} from "../java/parser-utils";

export type TradeSourceKind = "vanilla" | "trade_rebalance" | "unknown";

export type TradeItemStack = {
  itemField: string | null;
  itemId: string | null;
  count: string | null;
  source: string;
};

export type TradeOfferDefinition = {
  fieldName: string | null;
  id: string | null;
  sourceKind: TradeSourceKind;
  registrationKind: "direct" | "generated" | "symbolic";
  primaryCost: TradeItemStack | null;
  secondaryCost: TradeItemStack | null;
  result: TradeItemStack | null;
  maxUses: string | null;
  villagerXp: string | null;
  priceMultiplier: string | null;
  villagerTypes: string[];
  lootFunctionKinds: string[];
  enchantmentFields: string[];
  enchantmentTagFields: string[];
  potionFields: string[];
  potionTagFields: string[];
  mobEffectFields: string[];
  structureTagFields: string[];
  mapDecorationFields: string[];
  translationKeys: string[];
  rawConstructor: string;
  source: string;
  range: SourceRange;
};

export type TradeKeyDefinition = {
  fieldName: string;
  id: string;
  sourceKind: TradeSourceKind;
  source: string;
  range: SourceRange;
};

export type TradeTagDefinition = {
  fieldName: string;
  id: string;
  replace: boolean;
  tradeFields: string[];
  includedTagFields: string[];
  sourceKind: TradeSourceKind;
  source: string;
  range: SourceRange;
};

export type TradeSetDefinition = {
  fieldName: string;
  id: string;
  tradeTagField: string | null;
  tradeTagId: string | null;
  amount: string | null;
  allowDuplicates: boolean;
  source: string;
  range: SourceRange;
};

export type ProfessionTradeSetDefinition = {
  professionField: string;
  professionId: string;
  levelTradeSets: Record<string, string>;
  source: string;
  range: SourceRange;
};

export type TradeRuntimeReference = {
  kind: "villager" | "wandering_trader";
  tradeSetField: string;
  source: string;
  range: SourceRange;
};

export type TradeProfessionLevel = {
  professionField: string;
  professionId: string;
  level: number;
};

export type ExtractedTrade = {
  fieldName: string;
  id: string;
  sourceKind: TradeSourceKind;
  offer: TradeOfferDefinition | null;
  tagFields: string[];
  tagIds: string[];
  tradeSetFields: string[];
  tradeSetIds: string[];
  professionLevels: TradeProfessionLevel[];
  wanderingTraderPools: string[];
};

export type TradesParseResult = {
  trades: ExtractedTrade[];
  tradeKeys: TradeKeyDefinition[];
  tradeOffers: TradeOfferDefinition[];
  tradeTags: TradeTagDefinition[];
  tradeSets: TradeSetDefinition[];
  professionTradeSets: ProfessionTradeSetDefinition[];
  runtimeReferences: TradeRuntimeReference[];
  diagnostics: ParserDiagnostic[];
};

export type ParseTradesSourcesInput = {
  villagerTradesSource?: string;
  tradeRebalanceVillagerTradesSource?: string;
  villagerTradeTagsSource?: string;
  villagerTradesTagsProviderSource?: string;
  tradeRebalanceTradeTagsProviderSource?: string;
  tradeSetsSource?: string;
  villagerProfessionSource?: string;
  abstractVillagerSource?: string;
  wanderingTraderSource?: string;
  villagerSource?: string;
};

type RegisterCall = {
  sourceKind: TradeSourceKind;
  callName: string;
  args: TokenSlice[];
  source: string;
  range: SourceRange;
};

const TRADE_LOOT_FUNCTION_KINDS = [
  "SetStewEffectFunction",
  "SetRandomPotionFunction",
  "SetPotionFunction",
  "EnchantRandomlyFunction",
  "EnchantWithLevelsFunction",
  "SetEnchantmentsFunction",
  "ExplorationMapFunction",
  "SetNameFunction",
  "SetRandomDyesFunction",
  "FilteredFunction",
  "DiscardItem",
];

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

function toId(path: string): string {
  return path.includes(":") ? path : `minecraft:${path}`;
}

function idFromField(fieldName: string): string {
  return `minecraft:${fieldName.toLowerCase()}`;
}

function expressionSource(source: string, tokens: JavaToken[], slice: TokenSlice | undefined): string {
  return slice ? tokenSource(source, tokens, slice.startIndex, slice.endIndex) : "";
}

function expressionText(source: string, tokens: JavaToken[], slice: TokenSlice | undefined): string | null {
  const text = expressionSource(source, tokens, slice).trim();
  return text.length > 0 ? text : null;
}

function isSimpleIdentifier(text: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(text);
}

function numericText(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.trim().replace(/[fFdDlL]$/, "");
  return /^-?\d+(?:\.\d+)?$/.test(normalized) ? normalized : text.trim();
}

function parseConstantFields(input: {
  source: string;
  sourceKind: TradeSourceKind;
  typeName: "VillagerTrade" | "TradeSet";
  factoryName: string;
}): TradeKeyDefinition[] {
  const tokens = tokenizeJava(input.source);
  const keys: TradeKeyDefinition[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "ResourceKey") {
      continue;
    }

    const genericOpen = tokens[index + 1]?.value === "<" ? index + 1 : -1;
    const genericClose = genericOpen === -1 ? -1 : findMatchingGeneric(tokens, genericOpen);
    if (
      genericOpen === -1 ||
      genericClose === -1 ||
      tokens[genericOpen + 1]?.value !== input.typeName
    ) {
      continue;
    }

    const fieldToken = tokens[genericClose + 1];
    if (!fieldToken || !isSimpleIdentifier(fieldToken.value)) {
      continue;
    }

    const equalsIndex = genericClose + 2;
    if (tokens[equalsIndex]?.value !== "=") {
      continue;
    }

    const qualified = readQualifiedNameAt(tokens, equalsIndex + 1);
    if (qualified?.name !== input.factoryName || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    const idPath = closeIndex === -1
      ? null
      : firstStringInRange(tokens, qualified.endIndex + 1, closeIndex);
    if (!idPath) {
      continue;
    }

    const statementEnd = findSemicolon(tokens, closeIndex);
    keys.push({
      fieldName: fieldToken.value,
      id: toId(idPath),
      sourceKind: input.sourceKind,
      source: tokenSource(input.source, tokens, index, statementEnd === -1 ? closeIndex + 1 : statementEnd + 1),
      range: tokenRange(tokens, index, statementEnd === -1 ? closeIndex + 1 : statementEnd + 1),
    });
    index = closeIndex;
  }

  return keys;
}

function findMatchingGeneric(tokens: JavaToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "<") {
      depth += 1;
    } else if (value === ">") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function firstStringInRange(tokens: JavaToken[], startIndex: number, endIndex: number): string | null {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].kind === "string") {
      return stripJavaStringQuotes(tokens[index].value);
    }
  }
  return null;
}

function findSemicolon(tokens: JavaToken[], startIndex: number): number {
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === ";") {
      return index;
    }
  }
  return -1;
}

function findRegisterCalls(source: string, sourceKind: TradeSourceKind): RegisterCall[] {
  const tokens = tokenizeJava(source);
  const calls: RegisterCall[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (
      !qualified ||
      tokens[qualified.endIndex]?.value !== "(" ||
      (qualified.name !== "VillagerTrades.register" && qualified.name !== "context.register")
    ) {
      continue;
    }

    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    if (closeIndex === -1) {
      continue;
    }

    const callSource = tokenSource(source, tokens, index, closeIndex + 1);
    if (!callSource.includes("new VillagerTrade")) {
      index = closeIndex;
      continue;
    }

    calls.push({
      sourceKind,
      callName: qualified.name,
      args: splitTopLevelArguments(tokens, qualified.endIndex + 1, closeIndex),
      source: callSource,
      range: tokenRange(tokens, index, closeIndex + 1),
    });
    index = closeIndex;
  }

  return calls;
}

function parseTradeItemStack(source: string, tokens: JavaToken[], slice: TokenSlice | undefined): TradeItemStack | null {
  if (!slice) {
    return null;
  }
  const itemField = firstQualifiedReference(tokens, slice.startIndex, slice.endIndex, "Items");
  const text = expressionSource(source, tokens, slice);
  const args = firstConstructorArguments(tokens, slice, "TradeCost")
    ?? firstConstructorArguments(tokens, slice, "ItemStackTemplate");
  const count = args ? expressionText(source, tokens, args[1]) ?? "1" : null;
  return {
    itemField,
    itemId: itemField ? idFromField(itemField) : null,
    count,
    source: text,
  };
}

function firstConstructorArguments(
  tokens: JavaToken[],
  slice: TokenSlice,
  constructorName: string,
): TokenSlice[] | null {
  for (let index = slice.startIndex; index < slice.endIndex - 1; index += 1) {
    if (
      tokens[index].value === "new" &&
      tokens[index + 1]?.value === constructorName &&
      tokens[index + 2]?.value === "("
    ) {
      const closeIndex = findMatchingToken(tokens, index + 2);
      if (closeIndex !== -1 && closeIndex <= slice.endIndex) {
        return splitTopLevelArguments(tokens, index + 3, closeIndex);
      }
    }
  }
  return null;
}

function findNewVillagerTradeArguments(
  tokens: JavaToken[],
  slice: TokenSlice,
): { args: TokenSlice[]; constructorSlice: TokenSlice } | null {
  for (let index = slice.startIndex; index < slice.endIndex - 2; index += 1) {
    if (
      tokens[index].value === "new" &&
      tokens[index + 1]?.value === "VillagerTrade" &&
      tokens[index + 2]?.value === "("
    ) {
      const closeIndex = findMatchingToken(tokens, index + 2);
      if (closeIndex !== -1 && closeIndex <= slice.endIndex) {
        return {
          args: splitTopLevelArguments(tokens, index + 3, closeIndex),
          constructorSlice: { startIndex: index, endIndex: closeIndex + 1 },
        };
      }
    }
  }
  return null;
}

function parseTradeOfferFromCall(
  source: string,
  tokens: JavaToken[],
  call: RegisterCall,
  keyMap: Map<string, TradeKeyDefinition>,
  diagnostics: ParserDiagnostic[],
): TradeOfferDefinition | null {
  const keySlice = call.callName === "VillagerTrades.register" ? call.args[1] : call.args[0];
  const tradeSlice = call.callName === "VillagerTrades.register" ? call.args[2] : call.args[1];
  const keyExpression = expressionText(source, tokens, keySlice);
  const fieldName = keyExpression && isSimpleIdentifier(keyExpression) ? keyExpression : null;
  const registeredKey = fieldName ? keyMap.get(fieldName) : null;
  const parsedConstructor = tradeSlice ? findNewVillagerTradeArguments(tokens, tradeSlice) : null;

  if (!parsedConstructor) {
    diagnostics.push(
      diagnostic({
        code: "trades.unhandled_registration",
        message: "Trade registration contains no parseable VillagerTrade constructor.",
        range: call.range,
        source: call.source,
        details: { key: keyExpression },
      }),
    );
    return null;
  }

  const constructorArgs = parsedConstructor.args;
  const secondArgText = expressionText(source, tokens, constructorArgs[1]);
  const hasSecondaryCost = secondArgText?.startsWith("Optional.of") ?? false;
  const resultIndex = hasSecondaryCost ? 2 : 1;
  const maxUsesIndex = hasSecondaryCost ? 3 : 2;
  const villagerXpIndex = hasSecondaryCost ? 4 : 3;
  const priceMultiplierIndex = hasSecondaryCost ? 5 : 4;
  const trailingSlices = constructorArgs.slice(hasSecondaryCost ? 6 : 5);
  const trailingSource = trailingSlices.map((slice) => expressionSource(source, tokens, slice)).join(", ");

  return {
    fieldName,
    id: registeredKey?.id ?? (fieldName ? idFromField(fieldName) : null),
    sourceKind: call.sourceKind,
    registrationKind: fieldName ? "direct" : "symbolic",
    primaryCost: parseTradeItemStack(source, tokens, constructorArgs[0]),
    secondaryCost: hasSecondaryCost ? parseTradeItemStack(source, tokens, constructorArgs[1]) : null,
    result: parseTradeItemStack(source, tokens, constructorArgs[resultIndex]),
    maxUses: numericText(expressionText(source, tokens, constructorArgs[maxUsesIndex])),
    villagerXp: numericText(expressionText(source, tokens, constructorArgs[villagerXpIndex])),
    priceMultiplier: numericText(expressionText(source, tokens, constructorArgs[priceMultiplierIndex])),
    villagerTypes: findQualifiedReferencesInSlices(tokens, trailingSlices, "VillagerType").map(idFromField),
    lootFunctionKinds: TRADE_LOOT_FUNCTION_KINDS.filter((kind) => trailingSource.includes(kind)),
    enchantmentFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "Enchantments"),
    enchantmentTagFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "EnchantmentTags").map(idFromField),
    potionFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "Potions").map(idFromField),
    potionTagFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "PotionTags").map(idFromField),
    mobEffectFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "MobEffects").map(idFromField),
    structureTagFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "StructureTags").map(idFromField),
    mapDecorationFields: findQualifiedReferencesInSlices(tokens, trailingSlices, "MapDecorationTypes").map(idFromField),
    translationKeys: findStringLiteralsContaining(tokens, trailingSlices, "."),
    rawConstructor: expressionSource(source, tokens, parsedConstructor.constructorSlice),
    source: call.source,
    range: call.range,
  };
}

function findQualifiedReferencesInSlices(
  tokens: JavaToken[],
  slices: TokenSlice[],
  root: string,
): string[] {
  return Array.from(
    new Set(slices.flatMap((slice) => findQualifiedReferences(tokens, slice.startIndex, slice.endIndex, root))),
  );
}

function findStringLiteralsContaining(
  tokens: JavaToken[],
  slices: TokenSlice[],
  marker: string,
): string[] {
  const values: string[] = [];
  for (const slice of slices) {
    for (let index = slice.startIndex; index < slice.endIndex; index += 1) {
      if (tokens[index].kind !== "string") {
        continue;
      }
      const value = stripJavaStringQuotes(tokens[index].value);
      if (value?.includes(marker)) {
        values.push(value);
      }
    }
  }
  return Array.from(new Set(values));
}

export function parseTradeOffersSource(input: {
  source: string;
  sourceKind: TradeSourceKind;
  knownTradeKeys?: TradeKeyDefinition[];
}): { tradeKeys: TradeKeyDefinition[]; tradeOffers: TradeOfferDefinition[]; diagnostics: ParserDiagnostic[] } {
  const tradeKeys = parseConstantFields({
    source: input.source,
    sourceKind: input.sourceKind,
    typeName: "VillagerTrade",
    factoryName: "VillagerTrades.resourceKey",
  });
  const keyMap = new Map([...(input.knownTradeKeys ?? []), ...tradeKeys].map((key) => [key.fieldName, key]));
  const tokens = tokenizeJava(input.source);
  const diagnostics: ParserDiagnostic[] = [];
  const tradeOffers = findRegisterCalls(input.source, input.sourceKind)
    .map((call) => parseTradeOfferFromCall(input.source, tokens, call, keyMap, diagnostics))
    .filter((offer): offer is TradeOfferDefinition => offer !== null);
  const generatedOffers = parseGeneratedLoopTradeOffers(input.source, input.sourceKind, keyMap);
  const existingOfferFields = new Set(tradeOffers.flatMap((offer) => offer.fieldName ? [offer.fieldName] : []));

  return {
    tradeKeys,
    tradeOffers: [
      ...tradeOffers,
      ...generatedOffers.filter((offer) => offer.fieldName && !existingOfferFields.has(offer.fieldName)),
    ],
    diagnostics,
  };
}

function parseGeneratedLoopTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  return [
    ...parseGeneratedNamedPairMethodTradeOffers(source, sourceKind, keyMap),
    ...parseGeneratedPairLoopTradeOffers(source, sourceKind, keyMap),
    ...parseGeneratedTripleLoopTradeOffers(source, sourceKind, keyMap),
    ...parseGeneratedNamedTripleMethodTradeOffers(source, sourceKind, keyMap),
    ...parseGeneratedImmutableTripleLoopTradeOffers(source, sourceKind, keyMap),
    ...parseGeneratedExplorerMapTradeOffers(source, sourceKind, keyMap),
    ...parseGeneratedBookDefinitionTradeOffers(source, sourceKind, keyMap),
  ];
}

function sourceRangeFromOffset(source: string, start: number, end: number): SourceRange {
  const prefix = source.slice(0, Math.max(0, start));
  const lines = prefix.split("\n");
  return {
    start,
    end,
    line: lines.length,
    column: lines.at(-1)?.length ? (lines.at(-1)?.length ?? 0) + 1 : 1,
  };
}

function generatedStack(itemField: string, count: string, source: string): TradeItemStack {
  return {
    itemField,
    itemId: idFromField(itemField),
    count,
    source,
  };
}

function generatedOffer(input: {
  source: string;
  sourceKind: TradeSourceKind;
  keyMap: Map<string, TradeKeyDefinition>;
  fieldName: string;
  sourceIndex: number;
  primaryCost: TradeItemStack;
  secondaryCost?: TradeItemStack | null;
  result: TradeItemStack;
  maxUses: string;
  villagerXp: string;
  priceMultiplier: string;
  villagerTypes?: string[];
  lootFunctionKinds?: string[];
  enchantmentFields?: string[];
  enchantmentTagFields?: string[];
  potionFields?: string[];
  potionTagFields?: string[];
  structureTagFields?: string[];
  mapDecorationFields?: string[];
  translationKeys?: string[];
  rawConstructor?: string;
}): TradeOfferDefinition {
  const key = input.keyMap.get(input.fieldName);
  const end = Math.min(input.source.length, input.sourceIndex + input.fieldName.length);
  return {
    fieldName: input.fieldName,
    id: key?.id ?? idFromField(input.fieldName),
    sourceKind: input.sourceKind,
    registrationKind: "generated",
    primaryCost: input.primaryCost,
    secondaryCost: input.secondaryCost ?? null,
    result: input.result,
    maxUses: input.maxUses,
    villagerXp: input.villagerXp,
    priceMultiplier: input.priceMultiplier,
    villagerTypes: input.villagerTypes ?? [],
    lootFunctionKinds: input.lootFunctionKinds ?? [],
    enchantmentFields: input.enchantmentFields ?? [],
    enchantmentTagFields: input.enchantmentTagFields ?? [],
    potionFields: input.potionFields ?? [],
    potionTagFields: input.potionTagFields ?? [],
    mobEffectFields: [],
    structureTagFields: input.structureTagFields ?? [],
    mapDecorationFields: input.mapDecorationFields ?? [],
    translationKeys: input.translationKeys ?? [],
    rawConstructor: input.rawConstructor ?? "",
    source: input.rawConstructor ?? input.fieldName,
    range: sourceRangeFromOffset(input.source, input.sourceIndex, end),
  };
}

function parsePairEntries(source: string): Array<{ fieldName: string; itemField: string; index: number }> {
  return Array.from(source.matchAll(/Pair\.of\(([A-Z][A-Z0-9_]*),\s*(?:\(Object\))?Items\.([A-Z][A-Z0-9_]*)\)/g))
    .map((match) => ({
      fieldName: match[1],
      itemField: match[2],
      index: match.index ?? 0,
    }));
}

function parseGeneratedNamedPairMethodTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  const configs = [
    { method: "registerWoolSales", itemAs: "cost", costCount: "18", resultCount: "1", maxUses: "16", xp: "2", multiplier: "0.05" },
    { method: "registerLevelTwoDyeTrades", itemAs: "cost", costCount: "12", resultCount: "1", maxUses: "16", xp: "10", multiplier: "0.05" },
    { method: "registerLevelThreeDyeTrades", itemAs: "cost", costCount: "12", resultCount: "1", maxUses: "16", xp: "20", multiplier: "0.05" },
    { method: "registerLevelFourDyeTrades", itemAs: "cost", costCount: "12", resultCount: "1", maxUses: "16", xp: "30", multiplier: "0.05" },
    { method: "registerWoolPurchases", itemAs: "result", costCount: "1", resultCount: "1", maxUses: "16", xp: "5", multiplier: "0.05" },
    { method: "registerCarpetPurchases", itemAs: "result", costCount: "1", resultCount: "4", maxUses: "16", xp: "5", multiplier: "0.05" },
    { method: "registerBedTrades", itemAs: "result", costCount: "3", resultCount: "1", maxUses: "12", xp: "10", multiplier: "0.05" },
    { method: "registerShepherdBannerTrades", itemAs: "result", costCount: "3", resultCount: "1", maxUses: "12", xp: "15", multiplier: "0.05" },
    { method: "registerMasonLevelFourTerracotta", itemAs: "result", costCount: "1", resultCount: "1", maxUses: "12", xp: "15", multiplier: "0.05" },
    { method: "registerMasonLevelThreeBlocks", itemAs: "result", costCount: "1", resultCount: "4", maxUses: "16", xp: "10", multiplier: "0.05" },
    { method: "registerMasonLevelThreeStones", itemAs: "cost", costCount: "16", resultCount: "1", maxUses: "16", xp: "20", multiplier: "0.05" },
  ] as const;
  const offers: TradeOfferDefinition[] = [];

  for (const config of configs) {
    const method = extractMethodSource(source, config.method);
    if (!method) {
      continue;
    }
    for (const entry of parsePairEntries(method.source)) {
      offers.push(generatedOffer({
        source,
        sourceKind,
        keyMap,
        fieldName: entry.fieldName,
        sourceIndex: method.start + entry.index,
        primaryCost: config.itemAs === "cost"
          ? generatedStack(entry.itemField, config.costCount, "entry.getRight()")
          : generatedStack("EMERALD", config.costCount, "Items.EMERALD"),
        result: config.itemAs === "result"
          ? generatedStack(entry.itemField, config.resultCount, "entry.getRight()")
          : generatedStack("EMERALD", config.resultCount, "Items.EMERALD"),
        maxUses: config.maxUses,
        villagerXp: config.xp,
        priceMultiplier: config.multiplier,
        rawConstructor: method.source,
      }));
    }
  }

  return offers;
}

function parseVillagerTypeList(source: string): string[] {
  return Array.from(source.matchAll(/VillagerType\.([A-Z][A-Z0-9_]*)/g))
    .map((match) => idFromField(match[1]));
}

function parseGeneratedPairLoopTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  const offers: TradeOfferDefinition[] = [];
  const loopPattern = /for \(Pair ([a-zA-Z_][a-zA-Z0-9_]*) : List\.of\(([\s\S]*?)\)\) \{([\s\S]*?)\n\s*\}/g;
  for (const match of source.matchAll(loopPattern)) {
    const variable = match[1];
    const entriesSource = match[2];
    const body = match[3];
    const fullSource = match[0];
    if (!body.includes(`${variable}.getLeft()`) || !body.includes(`${variable}.getRight()`)) {
      continue;
    }
    const numbers = body.match(/new VillagerTrade\([\s\S]*?new ItemStackTemplate[\s\S]*?\),\s*(\d+),\s*(\d+),\s*([0-9.]+)f/);
    const maxUses = numbers?.[1] ?? null;
    const villagerXp = numbers?.[2] ?? null;
    const priceMultiplier = numbers?.[3] ?? null;
    if (!maxUses || !villagerXp || !priceMultiplier) {
      continue;
    }

    const itemAsCost = new RegExp(`new TradeCost\\(\\(ItemLike\\)${variable}\\.getRight\\(\\),\\s*([^\\)]+)\\)`).exec(body);
    const itemAsResult = new RegExp(`new ItemStackTemplate\\(\\(Item\\)${variable}\\.getRight\\(\\)(?:,\\s*([^\\)]+))?\\)`).exec(body);
    const emeraldCost = /new TradeCost\(\(ItemLike\)Items\.EMERALD,\s*([^)]+)\)/.exec(body);
    const emeraldResult = /new ItemStackTemplate\(Items\.EMERALD(?:,\s*([^)]+))?\)/.exec(body);
    if ((!itemAsCost && !itemAsResult) || (!emeraldCost && !emeraldResult)) {
      continue;
    }

    for (const entry of parsePairEntries(entriesSource)) {
      const sourceIndex = (match.index ?? 0) + entry.index;
      offers.push(generatedOffer({
        source,
        sourceKind,
        keyMap,
        fieldName: entry.fieldName,
        sourceIndex,
        primaryCost: itemAsCost
          ? generatedStack(entry.itemField, itemAsCost[1].trim(), `(ItemLike)${variable}.getRight()`)
          : generatedStack("EMERALD", emeraldCost?.[1]?.trim() ?? "1", "Items.EMERALD"),
        result: itemAsResult
          ? generatedStack(entry.itemField, itemAsResult[1]?.trim() ?? "1", `(Item)${variable}.getRight()`)
          : generatedStack("EMERALD", emeraldResult?.[1]?.trim() ?? "1", "Items.EMERALD"),
        maxUses,
        villagerXp,
        priceMultiplier,
        rawConstructor: fullSource,
      }));
    }
  }
  return offers;
}

function parseGeneratedTripleLoopTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  const offers: TradeOfferDefinition[] = [];
  const loopPattern = /for \(Triple ([a-zA-Z_][a-zA-Z0-9_]*) : List\.of\(([\s\S]*?)\)\) \{([\s\S]*?)\n\s*\}/g;
  const entryPattern = /Triple\.of\(([A-Z][A-Z0-9_]*),\s*(?:\(Object\))?Items\.([A-Z][A-Z0-9_]*),\s*List\.of\(([\s\S]*?)\)\)/g;
  for (const match of source.matchAll(loopPattern)) {
    const variable = match[1];
    const entriesSource = match[2];
    const body = match[3];
    if (!body.includes(`${variable}.getLeft()`) || !body.includes(`${variable}.getMiddle()`)) {
      continue;
    }
    const numbers = body.match(/new VillagerTrade\([\s\S]*?new ItemStackTemplate[\s\S]*?\),\s*(\d+),\s*(\d+),\s*([0-9.]+)f/);
    if (!numbers) {
      continue;
    }
    const emeraldCost = /new TradeCost\(\(ItemLike\)Items\.EMERALD,\s*([^)]+)\)/.exec(body);
    if (!emeraldCost) {
      continue;
    }
    for (const entry of entriesSource.matchAll(entryPattern)) {
      offers.push(generatedOffer({
        source,
        sourceKind,
        keyMap,
        fieldName: entry[1],
        sourceIndex: (match.index ?? 0) + (entry.index ?? 0),
        primaryCost: generatedStack("EMERALD", emeraldCost[1].trim(), "Items.EMERALD"),
        result: generatedStack(entry[2], "1", `(Item)${variable}.getMiddle()`),
        maxUses: numbers[1],
        villagerXp: numbers[2],
        priceMultiplier: numbers[3],
        villagerTypes: parseVillagerTypeList(entry[3]),
        rawConstructor: match[0],
      }));
    }
  }
  return offers;
}

function parseGeneratedNamedTripleMethodTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  const method = extractMethodSource(source, "registerCartographerBannerTrades");
  if (!method) {
    return [];
  }
  const entryPattern = /Triple\.of\(([A-Z][A-Z0-9_]*),\s*(?:\(Object\))?Items\.([A-Z][A-Z0-9_]*),\s*List\.of\(([\s\S]*?)\)\)/g;
  return Array.from(method.source.matchAll(entryPattern)).map((entry) => generatedOffer({
    source,
    sourceKind,
    keyMap,
    fieldName: entry[1],
    sourceIndex: method.start + (entry.index ?? 0),
    primaryCost: generatedStack("EMERALD", "2", "Items.EMERALD"),
    result: generatedStack(entry[2], "1", "entry.getMiddle()"),
    maxUses: "12",
    villagerXp: "15",
    priceMultiplier: "0.05",
    villagerTypes: parseVillagerTypeList(entry[3]),
    rawConstructor: method.source,
  }));
}

function parseGeneratedImmutableTripleLoopTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  const offers: TradeOfferDefinition[] = [];
  const method = extractMethodSource(source, "registerBoatTrades");
  if (!method) {
    return offers;
  }
  const entryPattern = /ImmutableTriple\.of\(([A-Z][A-Z0-9_]*),\s*(?:\(Object\))?Items\.([A-Z][A-Z0-9_]*),\s*List\.of\(([\s\S]*?)\)\)/g;
  for (const entry of method.source.matchAll(entryPattern)) {
    offers.push(generatedOffer({
      source,
      sourceKind,
      keyMap,
      fieldName: entry[1],
      sourceIndex: method.start + (entry.index ?? 0),
      primaryCost: generatedStack(entry[2], "1", "entry.middle"),
      result: generatedStack("EMERALD", "1", "Items.EMERALD"),
      maxUses: "12",
      villagerXp: "30",
      priceMultiplier: "0.05",
      villagerTypes: parseVillagerTypeList(entry[3]),
      rawConstructor: method.source,
    }));
  }
  return offers;
}

function parseGeneratedExplorerMapTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  const method = extractMethodSource(source, "registerBasicExplorerMapTrades");
  if (!method) {
    return [];
  }
  const entryPattern = /new VillagerExplorerMapEntry\(([A-Z][A-Z0-9_]*),\s*StructureTags\.([A-Z][A-Z0-9_]*),\s*MapDecorationTypes\.([A-Z][A-Z0-9_]*),\s*"([^"]+)",\s*List\.of\(([\s\S]*?)\)\)/g;
  return Array.from(method.source.matchAll(entryPattern)).map((entry) => generatedOffer({
    source,
    sourceKind,
    keyMap,
    fieldName: entry[1],
    sourceIndex: method.start + (entry.index ?? 0),
    primaryCost: generatedStack("EMERALD", "8", "Items.EMERALD"),
    secondaryCost: generatedStack("COMPASS", "1", "Items.COMPASS"),
    result: generatedStack("MAP", "1", "Items.MAP"),
    maxUses: "12",
    villagerXp: "5",
    priceMultiplier: "0.2",
    villagerTypes: parseVillagerTypeList(entry[5]),
    lootFunctionKinds: ["ExplorationMapFunction", "SetNameFunction", "FilteredFunction", "DiscardItem"],
    structureTagFields: [idFromField(entry[2])],
    mapDecorationFields: [idFromField(entry[3])],
    translationKeys: [`filled_map.${entry[4]}`],
    rawConstructor: method.source,
  }));
}

function parseGeneratedBookDefinitionTradeOffers(
  source: string,
  sourceKind: TradeSourceKind,
  keyMap: Map<string, TradeKeyDefinition>,
): TradeOfferDefinition[] {
  if (sourceKind !== "trade_rebalance") {
    return [];
  }
  const offers: TradeOfferDefinition[] = [];
  const bookPattern = /new BookTradeDefinition\(([A-Z][A-Z0-9_]*),\s*VillagerType\.([A-Z][A-Z0-9_]*),\s*Enchantments\.([A-Z][A-Z0-9_]*),\s*(\d+)\)/g;
  const biomeTagPattern = /ImmutableTriple\.of\(([A-Z][A-Z0-9_]*),\s*VillagerType\.([A-Z][A-Z0-9_]*),\s*EnchantmentTags\.([A-Z][A-Z0-9_]*)\)/g;
  for (const entry of source.matchAll(biomeTagPattern)) {
    const levelMatch = entry[1].match(/LIBRARIAN_(\d+)_/);
    const villagerXp = levelMatch?.[1] === "1" ? "1" : levelMatch?.[1] === "2" ? "5" : "10";
    offers.push(generatedOffer({
      source,
      sourceKind,
      keyMap,
      fieldName: entry[1],
      sourceIndex: entry.index ?? 0,
      primaryCost: generatedStack("EMERALD", "0", "Items.EMERALD"),
      secondaryCost: generatedStack("BOOK", "1", "Items.BOOK"),
      result: generatedStack("ENCHANTED_BOOK", "1", "Items.ENCHANTED_BOOK"),
      maxUses: "12",
      villagerXp,
      priceMultiplier: "0.2",
      villagerTypes: [idFromField(entry[2])],
      lootFunctionKinds: ["EnchantRandomlyFunction"],
      enchantmentTagFields: [idFromField(entry[3])],
      rawConstructor: entry[0],
    }));
  }
  for (const entry of source.matchAll(bookPattern)) {
    offers.push(generatedOffer({
      source,
      sourceKind,
      keyMap,
      fieldName: entry[1],
      sourceIndex: entry.index ?? 0,
      primaryCost: generatedStack("EMERALD", "Sum.sum(ConstantValue.exactly(3 * level + 2), UniformGenerator.between(0.0f, 5 + level * 10))", "Items.EMERALD"),
      secondaryCost: generatedStack("BOOK", "1", "Items.BOOK"),
      result: generatedStack("ENCHANTED_BOOK", "1", "Items.ENCHANTED_BOOK"),
      maxUses: "12",
      villagerXp: "30",
      priceMultiplier: "0.2",
      villagerTypes: [idFromField(entry[2])],
      lootFunctionKinds: ["SetEnchantmentsFunction"],
      enchantmentFields: [entry[3]],
      rawConstructor: entry[0],
    }));
  }
  const triplePattern = /Triple\.of\(([A-Z][A-Z0-9_]*),\s*VillagerType\.([A-Z][A-Z0-9_]*),\s*Enchantments\.([A-Z][A-Z0-9_]*)\)/g;
  for (const entry of source.matchAll(triplePattern)) {
    offers.push(generatedOffer({
      source,
      sourceKind,
      keyMap,
      fieldName: entry[1],
      sourceIndex: entry.index ?? 0,
      primaryCost: generatedStack("EMERALD", "0", "Items.EMERALD"),
      secondaryCost: generatedStack("BOOK", "1", "Items.BOOK"),
      result: generatedStack("ENCHANTED_BOOK", "1", "Items.ENCHANTED_BOOK"),
      maxUses: "12",
      villagerXp: "30",
      priceMultiplier: "0.2",
      villagerTypes: [idFromField(entry[2])],
      lootFunctionKinds: ["EnchantRandomlyFunction"],
      enchantmentFields: [entry[3]],
      rawConstructor: entry[0],
    }));
  }
  return offers;
}

function extractMethodSource(source: string, methodName: string): { source: string; start: number; end: number } | null {
  const tokens = tokenizeJava(source);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== methodName || tokens[index + 1]?.value !== "(") {
      continue;
    }
    const parameterClose = findMatchingToken(tokens, index + 1);
    if (parameterClose === -1 || tokens[parameterClose + 1]?.value !== "{") {
      continue;
    }
    const close = findMatchingToken(tokens, parameterClose + 1);
    if (close === -1) {
      continue;
    }
    return {
      source: tokenSource(source, tokens, index, close + 1),
      start: tokens[index].start,
      end: tokens[close].end,
    };
  }
  return null;
}

export function parseVillagerTradeTagsSource(source: string): Map<string, string> {
  const tokens = tokenizeJava(source);
  const tags = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "TagKey") {
      continue;
    }
    const genericOpen = tokens[index + 1]?.value === "<" ? index + 1 : -1;
    const genericClose = genericOpen === -1 ? -1 : findMatchingGeneric(tokens, genericOpen);
    const fieldToken = genericClose === -1 ? undefined : tokens[genericClose + 1];
    if (!fieldToken || !isSimpleIdentifier(fieldToken.value)) {
      continue;
    }
    const qualified = readQualifiedNameAt(tokens, genericClose + 3);
    if (qualified?.name !== "VillagerTradeTags.create") {
      continue;
    }
    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    const idPath = closeIndex === -1 ? null : firstStringInRange(tokens, qualified.endIndex + 1, closeIndex);
    if (idPath) {
      tags.set(fieldToken.value, toId(idPath));
    }
  }
  return tags;
}

export function parseTradeTagsProviderSource(input: {
  source: string;
  sourceKind: TradeSourceKind;
  tagIds?: Map<string, string>;
}): TradeTagDefinition[] {
  const tokens = tokenizeJava(input.source);
  const tags: TradeTagDefinition[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index].value !== "this" ||
      tokens[index + 1]?.value !== "." ||
      tokens[index + 2]?.value !== "tag" ||
      tokens[index + 3]?.value !== "("
    ) {
      continue;
    }

    const tagClose = findMatchingToken(tokens, index + 3);
    if (tagClose === -1) {
      continue;
    }
    const tagArgs = splitTopLevelArguments(tokens, index + 4, tagClose);
    const tagField = firstQualifiedReference(tokens, tagArgs[0]?.startIndex ?? 0, tagArgs[0]?.endIndex ?? 0, "VillagerTradeTags");
    if (!tagField) {
      continue;
    }

    const statementEnd = findSemicolon(tokens, tagClose);
    if (statementEnd === -1) {
      continue;
    }

    const sourceSlice = tokenSource(input.source, tokens, index, statementEnd + 1);
    const range = tokenRange(tokens, index, statementEnd + 1);
    const tradeFields = [
      ...findQualifiedReferences(tokens, tagClose + 1, statementEnd, "VillagerTrades"),
      ...findQualifiedReferences(tokens, tagClose + 1, statementEnd, "TradeRebalanceVillagerTrades"),
    ];
    const includedTagFields = findQualifiedReferencesInMethodCalls(tokens, tagClose + 1, statementEnd, "addTag", "VillagerTradeTags");
    tags.push({
      fieldName: tagField,
      id: input.tagIds?.get(tagField) ?? idFromField(tagField),
      replace: sourceSlice.includes(", true"),
      tradeFields: Array.from(new Set(tradeFields)),
      includedTagFields: Array.from(new Set(includedTagFields)),
      sourceKind: input.sourceKind,
      source: sourceSlice,
      range,
    });
    index = statementEnd;
  }

  return tags;
}

function findQualifiedReferencesInMethodCalls(
  tokens: JavaToken[],
  startIndex: number,
  endIndex: number,
  methodName: string,
  root: string,
): string[] {
  const values: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].value !== "." || tokens[index + 1]?.value !== methodName || tokens[index + 2]?.value !== "(") {
      continue;
    }
    const closeIndex = findMatchingToken(tokens, index + 2);
    if (closeIndex === -1 || closeIndex > endIndex) {
      continue;
    }
    values.push(...findQualifiedReferences(tokens, index + 3, closeIndex, root));
    index = closeIndex;
  }
  return values;
}

export function parseTradeSetsSource(source: string, tagIds?: Map<string, string>): TradeSetDefinition[] {
  const tradeSetKeys = parseConstantFields({
    source,
    sourceKind: "vanilla",
    typeName: "TradeSet",
    factoryName: "TradeSets.resourceKey",
  });
  const keyMap = new Map(tradeSetKeys.map((key) => [key.fieldName, key]));
  const tokens = tokenizeJava(source);
  const tradeSets: TradeSetDefinition[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (qualified?.name !== "TradeSets.register" || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }
    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    if (closeIndex === -1) {
      continue;
    }
    const args = splitTopLevelArguments(tokens, qualified.endIndex + 1, closeIndex);
    if (args.length < 3 || expressionText(source, tokens, args[0]) !== "context") {
      index = closeIndex;
      continue;
    }
    const fieldName = expressionText(source, tokens, args[1]);
    const tagField = firstQualifiedReference(tokens, args[2].startIndex, args[2].endIndex, "VillagerTradeTags");
    if (!fieldName || !isSimpleIdentifier(fieldName)) {
      index = closeIndex;
      continue;
    }
    tradeSets.push({
      fieldName,
      id: keyMap.get(fieldName)?.id ?? idFromField(fieldName),
      tradeTagField: tagField,
      tradeTagId: tagField ? tagIds?.get(tagField) ?? idFromField(tagField) : null,
      amount: args[3] ? numericText(expressionText(source, tokens, args[3])) : "2",
      allowDuplicates: false,
      source: tokenSource(source, tokens, index, closeIndex + 1),
      range: tokenRange(tokens, index, closeIndex + 1),
    });
    index = closeIndex;
  }

  return tradeSets;
}

export function parseVillagerProfessionTradeSetsSource(source: string): ProfessionTradeSetDefinition[] {
  const tokens = tokenizeJava(source);
  const professions: ProfessionTradeSetDefinition[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (qualified?.name !== "VillagerProfession.register" || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }
    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    if (closeIndex === -1) {
      continue;
    }
    const args = splitTopLevelArguments(tokens, qualified.endIndex + 1, closeIndex);
    const profession = expressionText(source, tokens, args[1]);
    if (!profession || !isSimpleIdentifier(profession)) {
      index = closeIndex;
      continue;
    }
    const levelTradeSets: Record<string, string> = {};
    for (let cursor = qualified.endIndex + 1; cursor < closeIndex; cursor += 1) {
      const entryQualified = readQualifiedNameAt(tokens, cursor);
      if (entryQualified?.name !== "Int2ObjectMap.entry" || tokens[entryQualified.endIndex]?.value !== "(") {
        continue;
      }
      const entryClose = findMatchingToken(tokens, entryQualified.endIndex);
      if (entryClose === -1 || entryClose > closeIndex) {
        continue;
      }
      const entryArgs = splitTopLevelArguments(tokens, entryQualified.endIndex + 1, entryClose);
      const level = expressionText(source, tokens, entryArgs[0])?.replace(/^\(int\)/, "").trim();
      const tradeSet = firstQualifiedReference(tokens, entryArgs[1]?.startIndex ?? 0, entryArgs[1]?.endIndex ?? 0, "TradeSets");
      if (level && tradeSet) {
        levelTradeSets[level] = tradeSet;
      }
      cursor = entryClose;
    }
    if (Object.keys(levelTradeSets).length > 0) {
      professions.push({
        professionField: profession,
        professionId: idFromField(profession),
        levelTradeSets,
        source: tokenSource(source, tokens, index, closeIndex + 1),
        range: tokenRange(tokens, index, closeIndex + 1),
      });
    }
    index = closeIndex;
  }

  return professions;
}

export function parseTradeRuntimeReferencesSource(input: {
  source: string;
  kind: "villager" | "wandering_trader";
}): TradeRuntimeReference[] {
  const tokens = tokenizeJava(input.source);
  const references: TradeRuntimeReference[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const tradeSetField = firstQualifiedReference(tokens, index, Math.min(index + 6, tokens.length), "TradeSets");
    if (!tradeSetField) {
      continue;
    }
    references.push({
      kind: input.kind,
      tradeSetField,
      source: tokenSource(input.source, tokens, index, Math.min(index + 3, tokens.length)),
      range: tokenRange(tokens, index, Math.min(index + 3, tokens.length)),
    });
    index += 2;
  }
  return references;
}

function expandTradeTagFields(tradeTags: TradeTagDefinition[]): Map<string, Set<string>> {
  const byField = new Map(tradeTags.map((tag) => [tag.fieldName, tag]));
  const expanded = new Map<string, Set<string>>();

  function visit(tagField: string, stack: Set<string>): Set<string> {
    const existing = expanded.get(tagField);
    if (existing) {
      return existing;
    }
    if (stack.has(tagField)) {
      return new Set();
    }

    const tag = byField.get(tagField);
    if (!tag) {
      return new Set();
    }

    const tradeFields = new Set(tag.tradeFields);
    const nextStack = new Set(stack);
    nextStack.add(tagField);
    for (const includedTag of tag.includedTagFields) {
      for (const tradeField of visit(includedTag, nextStack)) {
        tradeFields.add(tradeField);
      }
    }

    expanded.set(tagField, tradeFields);
    return tradeFields;
  }

  for (const tag of tradeTags) {
    visit(tag.fieldName, new Set());
  }

  return expanded;
}

function buildExtractedTrades(input: {
  tradeKeys: TradeKeyDefinition[];
  tradeOffers: TradeOfferDefinition[];
  tradeTags: TradeTagDefinition[];
  tradeSets: TradeSetDefinition[];
  professionTradeSets: ProfessionTradeSetDefinition[];
}): ExtractedTrade[] {
  const offerByField = new Map(
    input.tradeOffers
      .filter((offer): offer is TradeOfferDefinition & { fieldName: string } => offer.fieldName !== null)
      .map((offer) => [offer.fieldName, offer]),
  );
  const tagsByTrade = new Map<string, TradeTagDefinition[]>();
  const expandedTagsBySourceKind = new Map<TradeSourceKind, Map<string, Set<string>>>();
  for (const sourceKind of new Set(input.tradeTags.map((tag) => tag.sourceKind))) {
    const sourceTags = input.tradeTags.filter((tag) => tag.sourceKind === sourceKind);
    const expandedTags = expandTradeTagFields(sourceTags);
    expandedTagsBySourceKind.set(sourceKind, expandedTags);
    for (const tag of sourceTags) {
      for (const tradeField of expandedTags.get(tag.fieldName) ?? []) {
        const existing = tagsByTrade.get(tradeField) ?? [];
        existing.push(tag);
        tagsByTrade.set(tradeField, existing);
      }
    }
  }

  const tradeSetsByTrade = new Map<string, TradeSetDefinition[]>();
  for (const tradeSet of input.tradeSets) {
    if (!tradeSet.tradeTagField) {
      continue;
    }
    for (const expandedTags of expandedTagsBySourceKind.values()) {
      for (const tradeField of expandedTags.get(tradeSet.tradeTagField) ?? []) {
        const existing = tradeSetsByTrade.get(tradeField) ?? [];
        existing.push(tradeSet);
        tradeSetsByTrade.set(tradeField, existing);
      }
    }
  }

  const professionLevelsByTradeSet = new Map<string, TradeProfessionLevel[]>();
  for (const profession of input.professionTradeSets) {
    for (const [level, tradeSetField] of Object.entries(profession.levelTradeSets)) {
      const existing = professionLevelsByTradeSet.get(tradeSetField) ?? [];
      existing.push({
        professionField: profession.professionField,
        professionId: profession.professionId,
        level: Number(level),
      });
      professionLevelsByTradeSet.set(tradeSetField, existing);
    }
  }

  return input.tradeKeys.map((tradeKey) => {
    const tags = tagsByTrade.get(tradeKey.fieldName) ?? [];
    const tradeSets = tradeSetsByTrade.get(tradeKey.fieldName) ?? [];
    const professionLevels = tradeSets.flatMap((tradeSet) => professionLevelsByTradeSet.get(tradeSet.fieldName) ?? []);
    return {
      fieldName: tradeKey.fieldName,
      id: tradeKey.id,
      sourceKind: tradeKey.sourceKind,
      offer: offerByField.get(tradeKey.fieldName) ?? null,
      tagFields: tags.map((tag) => tag.fieldName),
      tagIds: tags.map((tag) => tag.id),
      tradeSetFields: tradeSets.map((tradeSet) => tradeSet.fieldName),
      tradeSetIds: tradeSets.map((tradeSet) => tradeSet.id),
      professionLevels,
      wanderingTraderPools: tradeSets
        .filter((tradeSet) => tradeSet.fieldName.startsWith("WANDERING_TRADER_"))
        .map((tradeSet) => tradeSet.fieldName),
    };
  });
}

export function parseTradesSources(input: ParseTradesSourcesInput): TradesParseResult {
  const diagnostics: ParserDiagnostic[] = [];
  const tagIds = input.villagerTradeTagsSource
    ? parseVillagerTradeTagsSource(input.villagerTradeTagsSource)
    : new Map<string, string>();

  const vanilla = input.villagerTradesSource
    ? parseTradeOffersSource({ source: input.villagerTradesSource, sourceKind: "vanilla" })
    : { tradeKeys: [], tradeOffers: [], diagnostics: [] };
  diagnostics.push(...vanilla.diagnostics);

  const rebalance = input.tradeRebalanceVillagerTradesSource
    ? parseTradeOffersSource({
      source: input.tradeRebalanceVillagerTradesSource,
      sourceKind: "trade_rebalance",
      knownTradeKeys: vanilla.tradeKeys,
    })
    : { tradeKeys: [], tradeOffers: [], diagnostics: [] };
  diagnostics.push(...rebalance.diagnostics);

  const tradeTags = [
    ...(input.villagerTradesTagsProviderSource
      ? parseTradeTagsProviderSource({
        source: input.villagerTradesTagsProviderSource,
        sourceKind: "vanilla",
        tagIds,
      })
      : []),
    ...(input.tradeRebalanceTradeTagsProviderSource
      ? parseTradeTagsProviderSource({
        source: input.tradeRebalanceTradeTagsProviderSource,
        sourceKind: "trade_rebalance",
        tagIds,
      })
      : []),
  ];

  const tradeKeys = [...vanilla.tradeKeys, ...rebalance.tradeKeys];
  const tradeOffers = [...vanilla.tradeOffers, ...rebalance.tradeOffers];
  const tradeSets = input.tradeSetsSource ? parseTradeSetsSource(input.tradeSetsSource, tagIds) : [];
  const professionTradeSets = input.villagerProfessionSource
    ? parseVillagerProfessionTradeSetsSource(input.villagerProfessionSource)
    : [];

  return {
    trades: buildExtractedTrades({
      tradeKeys,
      tradeOffers,
      tradeTags,
      tradeSets,
      professionTradeSets,
    }),
    tradeKeys,
    tradeOffers,
    tradeTags,
    tradeSets,
    professionTradeSets,
    runtimeReferences: [
      ...(input.villagerSource
        ? parseTradeRuntimeReferencesSource({ source: input.villagerSource, kind: "villager" })
        : []),
      ...(input.wanderingTraderSource
        ? parseTradeRuntimeReferencesSource({ source: input.wanderingTraderSource, kind: "wandering_trader" })
        : []),
    ],
    diagnostics,
  };
}
