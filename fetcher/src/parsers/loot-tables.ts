import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ParserDiagnostic } from "../java/parser-utils";
import {
  loadLootDatagenFromSourceRoot,
  type LootDatagenParseResult,
  type LootDatagenRule,
} from "./loot-datagen";

export type LootJsonPrimitive = string | number | boolean | null;
export type LootJsonValue =
  | LootJsonPrimitive
  | LootJsonValue[]
  | { [key: string]: LootJsonValue };
export type LootJsonObject = { [key: string]: LootJsonValue };

export type LootNumberProvider = {
  type: string | null;
  value: LootJsonValue;
};

export type ParsedLootCondition = {
  type: string | null;
  inverted: boolean;
  referencedLootTables: string[];
  itemIds: string[];
  itemTagIds: string[];
  blockIds: string[];
  enchantmentIds: string[];
  raw: LootJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedLootFunction = {
  type: string | null;
  itemIds: string[];
  itemTagIds: string[];
  lootTableIds: string[];
  enchantmentIds: string[];
  potionIds: string[];
  instrumentIds: string[];
  raw: LootJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedLootEntry = {
  type: string | null;
  name: string | null;
  itemId: string | null;
  itemTagId: string | null;
  lootTableId: string | null;
  dynamicDropId: string | null;
  expandTag: boolean | null;
  weight: number | null;
  quality: number | null;
  conditions: ParsedLootCondition[];
  functions: ParsedLootFunction[];
  children: ParsedLootEntry[];
  raw: LootJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedLootPool = {
  rolls: LootNumberProvider | null;
  bonusRolls: LootNumberProvider | null;
  entries: ParsedLootEntry[];
  conditions: ParsedLootCondition[];
  functions: ParsedLootFunction[];
  raw: LootJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedLootTable = {
  id: string;
  namespace: string;
  path: string;
  category: string | null;
  filePath: string | null;
  type: string | null;
  randomSequence: string | null;
  pools: ParsedLootPool[];
  functions: ParsedLootFunction[];
  itemIds: string[];
  itemTagIds: string[];
  referencedLootTables: string[];
  dynamicDropIds: string[];
  conditionTypes: string[];
  functionTypes: string[];
  entryTypes: string[];
  datagenRules: LootDatagenRule[];
  datagenSemantics: ParsedLootDatagenSemantics;
  raw: LootJsonObject;
  diagnostics: ParserDiagnostic[];
};

export type ParsedLootDatagenSemantics = {
  sourceClasses: string[];
  ruleNames: string[];
  helperNames: string[];
  customGenerators: string[];
  hasNoDrop: boolean;
  hasDropSelf: boolean;
  hasOtherWhenSilkTouch: boolean;
  hasDropWhenSilkTouch: boolean;
  hasSilkTouch: boolean;
  hasShears: boolean;
  hasExplosionCondition: boolean;
};

export type LootTablesParseResult = {
  lootTables: ParsedLootTable[];
  lootTableById: Record<string, ParsedLootTable>;
  datagen: LootDatagenParseResult | null;
  tableTypeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  entryTypeCounts: Record<string, number>;
  functionTypeCounts: Record<string, number>;
  conditionTypeCounts: Record<string, number>;
  diagnostics: ParserDiagnostic[];
};

const KNOWN_TABLE_KEYS = new Set(["type", "random_sequence", "pools", "functions"]);
const KNOWN_POOL_KEYS = new Set(["rolls", "bonus_rolls", "entries", "conditions", "functions"]);
const KNOWN_ENTRY_KEYS = new Set([
  "type",
  "name",
  "weight",
  "quality",
  "conditions",
  "functions",
  "children",
  "expand",
]);
const KNOWN_CONDITION_KEYS = new Set([
  "condition",
  "term",
  "terms",
  "chance",
  "enchantment",
  "enchanted_chance",
  "entity",
  "predicate",
  "scores",
  "block",
  "properties",
  "tool",
  "enchantment",
  "chances",
  "damage_source",
  "offsetX",
  "offsetY",
  "offsetZ",
  "period",
  "value",
  "range",
  "reference",
  "attribute",
]);
const KNOWN_FUNCTION_KEYS = new Set([
  "function",
  "conditions",
  "count",
  "item",
  "levels",
  "options",
  "enchantments",
  "components",
  "tag",
  "damage",
  "modifiers",
  "name",
  "decoration",
  "destination",
  "search_radius",
  "skip_existing_chunks",
  "duration",
  "effect",
  "source",
  "contents",
  "entry",
  "limit",
  "formula",
  "parameters",
  "loot_table",
  "entity",
  "target",
  "source",
  "ops",
  "pattern",
  "patterns",
  "potion",
  "potions",
  "instrument",
  "sequence",
  "include",
  "exclude",
  "mode",
  "explosions",
  "flight_duration",
  "pages",
  "title",
  "author",
  "generation",
  "filtered_pages",
  "toggle",
  "amplifier",
  "model",
  "raw",
]);

const KNOWN_ENTRY_TYPES = new Set([
  "minecraft:empty",
  "minecraft:item",
  "minecraft:loot_table",
  "minecraft:dynamic",
  "minecraft:tag",
  "minecraft:slots",
  "minecraft:alternatives",
  "minecraft:sequence",
  "minecraft:group",
]);

const KNOWN_CONDITION_TYPES = new Set([
  "minecraft:inverted",
  "minecraft:any_of",
  "minecraft:all_of",
  "minecraft:random_chance",
  "minecraft:random_chance_with_enchanted_bonus",
  "minecraft:entity_properties",
  "minecraft:killed_by_player",
  "minecraft:entity_scores",
  "minecraft:block_state_property",
  "minecraft:match_tool",
  "minecraft:table_bonus",
  "minecraft:survives_explosion",
  "minecraft:damage_source_properties",
  "minecraft:location_check",
  "minecraft:weather_check",
  "minecraft:reference",
  "minecraft:time_check",
  "minecraft:value_check",
  "minecraft:enchantment_active_check",
  "minecraft:environment_attribute_check",
]);

const KNOWN_FUNCTION_TYPES = new Set([
  "minecraft:set_count",
  "minecraft:set_item",
  "minecraft:enchant_with_levels",
  "minecraft:enchant_randomly",
  "minecraft:set_enchantments",
  "minecraft:set_custom_data",
  "minecraft:set_components",
  "minecraft:furnace_smelt",
  "minecraft:enchanted_count_increase",
  "minecraft:set_damage",
  "minecraft:set_attributes",
  "minecraft:set_name",
  "minecraft:exploration_map",
  "minecraft:set_stew_effect",
  "minecraft:copy_name",
  "minecraft:set_contents",
  "minecraft:modify_contents",
  "minecraft:filtered",
  "minecraft:limit_count",
  "minecraft:apply_bonus",
  "minecraft:set_loot_table",
  "minecraft:explosion_decay",
  "minecraft:set_lore",
  "minecraft:fill_player_head",
  "minecraft:copy_custom_data",
  "minecraft:copy_state",
  "minecraft:set_banner_pattern",
  "minecraft:set_potion",
  "minecraft:set_random_dyes",
  "minecraft:set_random_potion",
  "minecraft:set_instrument",
  "minecraft:reference",
  "minecraft:sequence",
  "minecraft:copy_components",
  "minecraft:set_fireworks",
  "minecraft:set_firework_explosion",
  "minecraft:set_book_cover",
  "minecraft:set_written_book_pages",
  "minecraft:set_writable_book_pages",
  "minecraft:toggle_tooltips",
  "minecraft:set_ominous_bottle_amplifier",
  "minecraft:set_custom_model_data",
  "minecraft:discard",
]);

function isObject(value: unknown): value is LootJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: LootJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: LootJsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: LootJsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeIdentifier(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function normalizeOptionalIdentifier(value: LootJsonValue | undefined): string | null {
  return typeof value === "string" ? normalizeIdentifier(value) : null;
}

function lootTableIdFromFile(namespace: string, relativePath: string): string {
  return `${namespace}:${relativePath.replace(/\.json$/, "").replace(/\\/g, "/")}`;
}

function categoryFromRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  return slash === -1 ? null : normalized.slice(0, slash);
}

function diagnostic(input: {
  code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}): ParserDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity: "warning",
    details: input.details,
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function emptyDatagenSemantics(): ParsedLootDatagenSemantics {
  return {
    sourceClasses: [],
    ruleNames: [],
    helperNames: [],
    customGenerators: [],
    hasNoDrop: false,
    hasDropSelf: false,
    hasOtherWhenSilkTouch: false,
    hasDropWhenSilkTouch: false,
    hasSilkTouch: false,
    hasShears: false,
    hasExplosionCondition: false,
  };
}

function summarizeDatagenSemantics(rules: LootDatagenRule[]): ParsedLootDatagenSemantics {
  return {
    sourceClasses: unique(rules.map((rule) => rule.sourceClass)),
    ruleNames: unique(rules.map((rule) => rule.ruleName)),
    helperNames: unique(rules.flatMap((rule) => rule.helperNames)),
    customGenerators: unique(rules.flatMap((rule) => rule.customGenerator ? [rule.customGenerator] : [])),
    hasNoDrop: rules.some((rule) => rule.hasNoDrop),
    hasDropSelf: rules.some((rule) => rule.hasDropSelf),
    hasOtherWhenSilkTouch: rules.some((rule) => rule.hasOtherWhenSilkTouch),
    hasDropWhenSilkTouch: rules.some((rule) => rule.hasDropWhenSilkTouch),
    hasSilkTouch: rules.some((rule) => rule.hasSilkTouch),
    hasShears: rules.some((rule) => rule.hasShears),
    hasExplosionCondition: rules.some((rule) => rule.hasExplosionCondition),
  };
}

function collectIdentifierValues(raw: LootJsonValue, keys: Set<string>): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((value) => collectIdentifierValues(value, keys));
  }

  if (!isObject(raw)) {
    return [];
  }

  const values: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && keys.has(key)) {
      values.push(normalizeIdentifier(value.startsWith("#") ? value.slice(1) : value));
    }
    values.push(...collectIdentifierValues(value, keys));
  }
  return values;
}

function collectTagValues(raw: LootJsonValue): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap(collectTagValues);
  }
  if (!isObject(raw)) {
    return [];
  }

  const values: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "tag" && typeof value === "string") {
      values.push(normalizeIdentifier(value.startsWith("#") ? value.slice(1) : value));
    }
    if (typeof value === "string" && value.startsWith("#")) {
      values.push(normalizeIdentifier(value.slice(1)));
    }
    values.push(...collectTagValues(value));
  }
  return values;
}

function parseNumberProvider(raw: LootJsonValue | undefined): LootNumberProvider | null {
  if (raw === undefined) {
    return null;
  }

  if (typeof raw === "number") {
    return { type: "minecraft:constant", value: raw };
  }

  if (isObject(raw)) {
    return {
      type: normalizeOptionalIdentifier(raw.type),
      value: raw,
    };
  }

  return { type: null, value: raw };
}

function validateUnknownKeys(input: {
  raw: LootJsonObject;
  knownKeys: Set<string>;
  diagnostics: ParserDiagnostic[];
  code: string;
  messagePrefix: string;
  id: string;
  type?: string | null;
}): void {
  for (const key of Object.keys(input.raw)) {
    if (!input.knownKeys.has(key)) {
      input.diagnostics.push(
        diagnostic({
          code: input.code,
          message: `${input.messagePrefix} '${input.id}' has unhandled key '${key}'.`,
          details: {
            lootTableId: input.id,
            key,
            type: input.type ?? null,
          },
        }),
      );
    }
  }
}

export function parseLootCondition(raw: LootJsonValue, lootTableId = "unknown"): ParsedLootCondition {
  const diagnostics: ParserDiagnostic[] = [];
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic({
        code: "loot.condition_invalid",
        message: `Loot table '${lootTableId}' has a condition that is not an object.`,
        details: { lootTableId },
      }),
    );
    return {
      type: null,
      inverted: false,
      referencedLootTables: [],
      itemIds: [],
      itemTagIds: [],
      blockIds: [],
      enchantmentIds: [],
      raw: {},
      diagnostics,
    };
  }

  const type = normalizeOptionalIdentifier(raw.condition);
  if (!type) {
    diagnostics.push(
      diagnostic({
        code: "loot.condition_missing_type",
        message: `Loot table '${lootTableId}' has a condition without a condition type.`,
        details: { lootTableId },
      }),
    );
  } else if (!KNOWN_CONDITION_TYPES.has(type)) {
    diagnostics.push(
      diagnostic({
        code: "loot.condition_unknown_type",
        message: `Loot table '${lootTableId}' uses unknown loot condition '${type}'.`,
        details: { lootTableId, type },
      }),
    );
  }

  validateUnknownKeys({
    raw,
    knownKeys: KNOWN_CONDITION_KEYS,
    diagnostics,
    code: "loot.condition_unhandled_key",
    messagePrefix: "Condition in loot table",
    id: lootTableId,
    type,
  });

  const childConditions = [
    ...(Array.isArray(raw.terms) ? raw.terms : []),
    ...(raw.term !== undefined ? [raw.term] : []),
  ].map((value) => parseLootCondition(value, lootTableId));

  return {
    type,
    inverted: type === "minecraft:inverted",
    referencedLootTables: unique([
      ...collectIdentifierValues(raw, new Set(["reference"])),
      ...childConditions.flatMap((condition) => condition.referencedLootTables),
    ]),
    itemIds: unique([
      ...collectIdentifierValues(raw, new Set(["items", "item"])),
      ...childConditions.flatMap((condition) => condition.itemIds),
    ]),
    itemTagIds: unique([
      ...collectTagValues(raw),
      ...childConditions.flatMap((condition) => condition.itemTagIds),
    ]),
    blockIds: unique([
      ...collectIdentifierValues(raw, new Set(["block"])),
      ...childConditions.flatMap((condition) => condition.blockIds),
    ]),
    enchantmentIds: unique([
      ...collectIdentifierValues(raw, new Set(["enchantment", "enchantments"])),
      ...childConditions.flatMap((condition) => condition.enchantmentIds),
    ]),
    raw,
    diagnostics: [...diagnostics, ...childConditions.flatMap((condition) => condition.diagnostics)],
  };
}

export function parseLootFunction(raw: LootJsonValue, lootTableId = "unknown"): ParsedLootFunction {
  const diagnostics: ParserDiagnostic[] = [];
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic({
        code: "loot.function_invalid",
        message: `Loot table '${lootTableId}' has a function that is not an object.`,
        details: { lootTableId },
      }),
    );
    return {
      type: null,
      itemIds: [],
      itemTagIds: [],
      lootTableIds: [],
      enchantmentIds: [],
      potionIds: [],
      instrumentIds: [],
      raw: {},
      diagnostics,
    };
  }

  const type = normalizeOptionalIdentifier(raw.function);
  if (!type) {
    diagnostics.push(
      diagnostic({
        code: "loot.function_missing_type",
        message: `Loot table '${lootTableId}' has a function without a function type.`,
        details: { lootTableId },
      }),
    );
  } else if (!KNOWN_FUNCTION_TYPES.has(type)) {
    diagnostics.push(
      diagnostic({
        code: "loot.function_unknown_type",
        message: `Loot table '${lootTableId}' uses unknown loot function '${type}'.`,
        details: { lootTableId, type },
      }),
    );
  }

  validateUnknownKeys({
    raw,
    knownKeys: KNOWN_FUNCTION_KEYS,
    diagnostics,
    code: "loot.function_unhandled_key",
    messagePrefix: "Function in loot table",
    id: lootTableId,
    type,
  });

  const nestedConditions = Array.isArray(raw.conditions)
    ? raw.conditions.map((condition) => parseLootCondition(condition, lootTableId))
    : [];
  const nestedFunctions = [
    ...(Array.isArray(raw.sequence) ? raw.sequence : []),
    ...(raw.entry !== undefined ? [raw.entry] : []),
  ].map((value) => parseLootFunction(value, lootTableId));

  return {
    type,
    itemIds: unique([
      ...collectIdentifierValues(raw, new Set(["item", "items"])),
      ...nestedConditions.flatMap((condition) => condition.itemIds),
      ...nestedFunctions.flatMap((func) => func.itemIds),
    ]),
    itemTagIds: unique([
      ...collectTagValues(raw),
      ...nestedConditions.flatMap((condition) => condition.itemTagIds),
      ...nestedFunctions.flatMap((func) => func.itemTagIds),
    ]),
    lootTableIds: unique([
      ...collectIdentifierValues(raw, new Set(["loot_table", "reference"])),
      ...nestedConditions.flatMap((condition) => condition.referencedLootTables),
      ...nestedFunctions.flatMap((func) => func.lootTableIds),
    ]),
    enchantmentIds: unique([
      ...collectIdentifierValues(raw, new Set(["enchantment", "enchantments"])),
      ...nestedConditions.flatMap((condition) => condition.enchantmentIds),
      ...nestedFunctions.flatMap((func) => func.enchantmentIds),
    ]),
    potionIds: unique([
      ...collectIdentifierValues(raw, new Set(["potion", "potions"])),
      ...nestedFunctions.flatMap((func) => func.potionIds),
    ]),
    instrumentIds: unique([
      ...collectIdentifierValues(raw, new Set(["instrument"])),
      ...nestedFunctions.flatMap((func) => func.instrumentIds),
    ]),
    raw,
    diagnostics: [
      ...diagnostics,
      ...nestedConditions.flatMap((condition) => condition.diagnostics),
      ...nestedFunctions.flatMap((func) => func.diagnostics),
    ],
  };
}

export function parseLootEntry(raw: LootJsonValue, lootTableId = "unknown"): ParsedLootEntry {
  const diagnostics: ParserDiagnostic[] = [];
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic({
        code: "loot.entry_invalid",
        message: `Loot table '${lootTableId}' has an entry that is not an object.`,
        details: { lootTableId },
      }),
    );
    return {
      type: null,
      name: null,
      itemId: null,
      itemTagId: null,
      lootTableId: null,
      dynamicDropId: null,
      expandTag: null,
      weight: null,
      quality: null,
      conditions: [],
      functions: [],
      children: [],
      raw: {},
      diagnostics,
    };
  }

  const type = normalizeOptionalIdentifier(raw.type);
  if (!type) {
    diagnostics.push(
      diagnostic({
        code: "loot.entry_missing_type",
        message: `Loot table '${lootTableId}' has an entry without an entry type.`,
        details: { lootTableId },
      }),
    );
  } else if (!KNOWN_ENTRY_TYPES.has(type)) {
    diagnostics.push(
      diagnostic({
        code: "loot.entry_unknown_type",
        message: `Loot table '${lootTableId}' uses unknown loot entry '${type}'.`,
        details: { lootTableId, type },
      }),
    );
  }

  validateUnknownKeys({
    raw,
    knownKeys: KNOWN_ENTRY_KEYS,
    diagnostics,
    code: "loot.entry_unhandled_key",
    messagePrefix: "Entry in loot table",
    id: lootTableId,
    type,
  });

  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions.map((condition) => parseLootCondition(condition, lootTableId))
    : [];
  const functions = Array.isArray(raw.functions)
    ? raw.functions.map((func) => parseLootFunction(func, lootTableId))
    : [];
  const children = Array.isArray(raw.children)
    ? raw.children.map((child) => parseLootEntry(child, lootTableId))
    : [];
  const name = stringValue(raw.name);

  return {
    type,
    name,
    itemId: type === "minecraft:item" && name ? normalizeIdentifier(name) : null,
    itemTagId: type === "minecraft:tag" && name ? normalizeIdentifier(name) : null,
    lootTableId: type === "minecraft:loot_table" && name ? normalizeIdentifier(name) : null,
    dynamicDropId: type === "minecraft:dynamic" && name ? normalizeIdentifier(name) : null,
    expandTag: booleanValue(raw.expand),
    weight: numberValue(raw.weight),
    quality: numberValue(raw.quality),
    conditions,
    functions,
    children,
    raw,
    diagnostics: [
      ...diagnostics,
      ...conditions.flatMap((condition) => condition.diagnostics),
      ...functions.flatMap((func) => func.diagnostics),
      ...children.flatMap((entry) => entry.diagnostics),
    ],
  };
}

export function parseLootPool(raw: LootJsonValue, lootTableId = "unknown"): ParsedLootPool {
  const diagnostics: ParserDiagnostic[] = [];
  if (!isObject(raw)) {
    diagnostics.push(
      diagnostic({
        code: "loot.pool_invalid",
        message: `Loot table '${lootTableId}' has a pool that is not an object.`,
        details: { lootTableId },
      }),
    );
    return {
      rolls: null,
      bonusRolls: null,
      entries: [],
      conditions: [],
      functions: [],
      raw: {},
      diagnostics,
    };
  }

  validateUnknownKeys({
    raw,
    knownKeys: KNOWN_POOL_KEYS,
    diagnostics,
    code: "loot.pool_unhandled_key",
    messagePrefix: "Pool in loot table",
    id: lootTableId,
  });

  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((entry) => parseLootEntry(entry, lootTableId))
    : [];
  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions.map((condition) => parseLootCondition(condition, lootTableId))
    : [];
  const functions = Array.isArray(raw.functions)
    ? raw.functions.map((func) => parseLootFunction(func, lootTableId))
    : [];

  if (raw.entries !== undefined && !Array.isArray(raw.entries)) {
    diagnostics.push(
      diagnostic({
        code: "loot.pool_entries_invalid",
        message: `Loot table '${lootTableId}' has a pool entries field that is not an array.`,
        details: { lootTableId },
      }),
    );
  }

  return {
    rolls: parseNumberProvider(raw.rolls),
    bonusRolls: parseNumberProvider(raw.bonus_rolls),
    entries,
    conditions,
    functions,
    raw,
    diagnostics: [
      ...diagnostics,
      ...entries.flatMap((entry) => entry.diagnostics),
      ...conditions.flatMap((condition) => condition.diagnostics),
      ...functions.flatMap((func) => func.diagnostics),
    ],
  };
}

function flattenEntries(entries: ParsedLootEntry[]): ParsedLootEntry[] {
  return entries.flatMap((entry) => [entry, ...flattenEntries(entry.children)]);
}

export function parseLootTableJson(input: {
  id: string;
  raw: LootJsonValue;
  filePath?: string | null;
  category?: string | null;
}): ParsedLootTable {
  const raw = isObject(input.raw) ? input.raw : {};
  const [namespace, ...pathParts] = input.id.split(":");
  const diagnostics: ParserDiagnostic[] = [];

  if (!isObject(input.raw)) {
    diagnostics.push(
      diagnostic({
        code: "loot.table_invalid",
        message: `Loot table '${input.id}' is not a JSON object.`,
        details: { lootTableId: input.id },
      }),
    );
  }

  validateUnknownKeys({
    raw,
    knownKeys: KNOWN_TABLE_KEYS,
    diagnostics,
    code: "loot.table_unhandled_key",
    messagePrefix: "Loot table",
    id: input.id,
    type: normalizeOptionalIdentifier(raw.type),
  });

  const pools = Array.isArray(raw.pools)
    ? raw.pools.map((pool) => parseLootPool(pool, input.id))
    : [];
  const functions = Array.isArray(raw.functions)
    ? raw.functions.map((func) => parseLootFunction(func, input.id))
    : [];

  if (raw.pools !== undefined && !Array.isArray(raw.pools)) {
    diagnostics.push(
      diagnostic({
        code: "loot.table_pools_invalid",
        message: `Loot table '${input.id}' has a pools field that is not an array.`,
        details: { lootTableId: input.id },
      }),
    );
  }

  const entries = pools.flatMap((pool) => flattenEntries(pool.entries));
  const conditions = [
    ...pools.flatMap((pool) => pool.conditions),
    ...entries.flatMap((entry) => entry.conditions),
  ];
  const allFunctions = [
    ...functions,
    ...pools.flatMap((pool) => pool.functions),
    ...entries.flatMap((entry) => entry.functions),
  ];

  const itemIds = unique([
    ...entries.flatMap((entry) => entry.itemId ? [entry.itemId] : []),
    ...conditions.flatMap((condition) => condition.itemIds),
    ...allFunctions.flatMap((func) => func.itemIds),
  ]);
  const itemTagIds = unique([
    ...entries.flatMap((entry) => entry.itemTagId ? [entry.itemTagId] : []),
    ...conditions.flatMap((condition) => condition.itemTagIds),
    ...allFunctions.flatMap((func) => func.itemTagIds),
  ]);

  return {
    id: input.id,
    namespace: namespace || "minecraft",
    path: pathParts.join(":"),
    category: input.category ?? null,
    filePath: input.filePath ?? null,
    type: normalizeOptionalIdentifier(raw.type),
    randomSequence: normalizeOptionalIdentifier(raw.random_sequence),
    pools,
    functions,
    itemIds,
    itemTagIds,
    referencedLootTables: unique([
      ...entries.flatMap((entry) => entry.lootTableId ? [entry.lootTableId] : []),
      ...conditions.flatMap((condition) => condition.referencedLootTables),
      ...allFunctions.flatMap((func) => func.lootTableIds),
    ]),
    dynamicDropIds: unique(entries.flatMap((entry) => entry.dynamicDropId ? [entry.dynamicDropId] : [])),
    conditionTypes: unique(conditions.flatMap((condition) => condition.type ? [condition.type] : [])),
    functionTypes: unique(allFunctions.flatMap((func) => func.type ? [func.type] : [])),
    entryTypes: unique(entries.flatMap((entry) => entry.type ? [entry.type] : [])),
    datagenRules: [],
    datagenSemantics: emptyDatagenSemantics(),
    raw,
    diagnostics: [
      ...diagnostics,
      ...pools.flatMap((pool) => pool.diagnostics),
      ...functions.flatMap((func) => func.diagnostics),
    ],
  };
}

async function collectJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectJsonFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

async function pathExists(directory: string): Promise<boolean> {
  try {
    await readdir(directory);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function withDatagenRules(
  lootTables: ParsedLootTable[],
  datagen: LootDatagenParseResult | null,
): ParsedLootTable[] {
  if (!datagen) {
    return lootTables;
  }

  return lootTables.map((lootTable) => {
    const datagenRules = datagen.rulesByTableId[lootTable.id] ?? [];
    const datagenSemantics = summarizeDatagenSemantics(datagenRules);
    return {
      ...lootTable,
      datagenRules,
      datagenSemantics: {
        ...datagenSemantics,
        hasShears: datagenSemantics.hasShears || lootTable.itemIds.includes("minecraft:shears"),
      },
      diagnostics: [
        ...lootTable.diagnostics,
        ...datagenRules.flatMap((rule) => rule.diagnostics),
      ],
    };
  });
}

function summarizeLootTables(
  lootTables: ParsedLootTable[],
  datagen: LootDatagenParseResult | null = null,
): LootTablesParseResult {
  const enrichedLootTables = withDatagenRules(lootTables, datagen);
  return {
    lootTables: enrichedLootTables,
    lootTableById: Object.fromEntries(enrichedLootTables.map((lootTable) => [lootTable.id, lootTable])),
    datagen,
    tableTypeCounts: countBy(enrichedLootTables.map((lootTable) => lootTable.type ?? "unknown")),
    categoryCounts: countBy(enrichedLootTables.map((lootTable) => lootTable.category ?? "uncategorized")),
    entryTypeCounts: countBy(enrichedLootTables.flatMap((lootTable) => lootTable.entryTypes)),
    functionTypeCounts: countBy(enrichedLootTables.flatMap((lootTable) => lootTable.functionTypes)),
    conditionTypeCounts: countBy(enrichedLootTables.flatMap((lootTable) => lootTable.conditionTypes)),
    diagnostics: [
      ...enrichedLootTables.flatMap((lootTable) => lootTable.diagnostics),
      ...(datagen?.diagnostics ?? []),
    ],
  };
}

export async function loadLootTablesFromLootDirectory(input: {
  lootDirectory: string;
  namespace?: string;
  datagenSourceRoot?: string | null;
}): Promise<LootTablesParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const files = (await collectJsonFiles(input.lootDirectory)).sort();
  const lootTables = await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(input.lootDirectory, filePath);
      const id = lootTableIdFromFile(namespace, relativePath);
      return parseLootTableJson({
        id,
        raw: JSON.parse(await readFile(filePath, "utf8")) as LootJsonValue,
        filePath,
        category: categoryFromRelativePath(relativePath),
      });
    }),
  );

  const datagen = input.datagenSourceRoot
    ? await loadLootDatagenFromSourceRoot({
      sourceRoot: input.datagenSourceRoot,
      knownLootTableIds: lootTables.map((lootTable) => lootTable.id),
    })
    : null;
  return summarizeLootTables(lootTables, datagen);
}

export async function loadLootTablesFromDataRoot(input: {
  dataRoot: string;
  namespace?: string;
  datagenSourceRoot?: string | null;
}): Promise<LootTablesParseResult> {
  const namespace = input.namespace ?? "minecraft";
  const candidates = [
    path.join(input.dataRoot, "data", namespace, "loot_table"),
    path.join(input.dataRoot, "data", namespace, "loot_tables"),
    path.join(input.dataRoot, "data", namespace, "loot"),
    path.join(input.dataRoot, namespace, "loot_table"),
    path.join(input.dataRoot, namespace, "loot_tables"),
    path.join(input.dataRoot, namespace, "loot"),
    path.join(input.dataRoot, "loot_table"),
    path.join(input.dataRoot, "loot_tables"),
    path.join(input.dataRoot, "loot"),
  ];
  const datagenCandidates = [
    input.datagenSourceRoot,
    path.join(input.dataRoot, "net", "minecraft", "data", "loot", "packs"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      let datagenSourceRoot: string | null = null;
      for (const datagenCandidate of datagenCandidates) {
        if (await pathExists(datagenCandidate)) {
          datagenSourceRoot = datagenCandidate;
          break;
        }
      }
      return loadLootTablesFromLootDirectory({
        lootDirectory: candidate,
        namespace,
        datagenSourceRoot,
      });
    }
  }

  return {
    lootTables: [],
    lootTableById: {},
    datagen: null,
    tableTypeCounts: {},
    categoryCounts: {},
    entryTypeCounts: {},
    functionTypeCounts: {},
    conditionTypeCounts: {},
    diagnostics: [
      diagnostic({
        code: "loot.directory_missing",
        message: `Could not find loot table directory under '${input.dataRoot}'.`,
        details: { dataRoot: input.dataRoot, namespace },
      }),
    ],
  };
}
