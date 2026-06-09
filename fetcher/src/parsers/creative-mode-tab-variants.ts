import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type CreativeModeTabAcceptedEntry,
  type CreativeModeTabsParseResult,
} from "./creative-mode-tabs";
import {
  findMatchingToken,
  findStatementEnd,
  firstStringLiteral,
  isNameToken,
  readQualifiedNameAt,
  splitTopLevelArguments,
  tokenSource,
  unique,
  type ParserDiagnostic,
  type TokenSlice,
} from "../java/parser-utils";
import { tokenizeJava, type JavaToken } from "../java/tokenizer";
import {
  decompileMinecraftClassTargets,
  type DecompiledMinecraftClass,
  type DecompileMinecraftClassTargetsOptions,
  type MinecraftClassTarget,
  type MinecraftSourceBundle,
} from "../minecraft/source";

export type CreativeModeTabResolvedVariantResolution =
  | "exact"
  | "partial"
  | "symbolic";

export type CreativeModeTabReferencedVariant = {
  fieldName: string | null;
  id: string;
  sourceClassId: string;
  minLevel?: number | null;
  maxLevel?: number | null;
};

export type CreativeModeTabReferencedVariantData = {
  fireworkCraftableDurations: number[];
  potions: CreativeModeTabReferencedVariant[];
  enchantments: CreativeModeTabReferencedVariant[];
  instruments: CreativeModeTabReferencedVariant[];
  paintingVariants: CreativeModeTabReferencedVariant[];
  instrumentTags: Record<string, string[]>;
  paintingVariantTags: Record<string, string[]>;
  unresolvedClassIds: string[];
  diagnostics: ParserDiagnostic[];
};

export type CreativeModeTabResolvedGeneratedVariant = {
  tabId: string;
  tabFieldName: string;
  entry: CreativeModeTabAcceptedEntry;
  resolution: CreativeModeTabResolvedVariantResolution;
  sourceClassId: string | null;
  variantKind: string;
  itemField: string | null;
  variantId: string | null;
  variantFieldName: string | null;
  variantLevel: number | null;
  variantValueExpression: string;
  diagnostic: ParserDiagnostic | null;
};

export const CREATIVE_MODE_TAB_REFERENCED_CLASS_TARGETS: MinecraftClassTarget[] = [
  {
    id: "fireworkRocketItem",
    candidates: ["net/minecraft/world/item/FireworkRocketItem.class"],
    required: false,
  },
  {
    id: "potions",
    candidates: ["net/minecraft/world/item/alchemy/Potions.class"],
    required: false,
  },
  {
    id: "enchantments",
    candidates: ["net/minecraft/world/item/enchantment/Enchantments.class"],
    required: false,
  },
  {
    id: "instruments",
    candidates: ["net/minecraft/world/item/Instruments.class"],
    required: false,
  },
  {
    id: "instrumentTags",
    candidates: ["net/minecraft/tags/InstrumentTags.class"],
    required: false,
  },
  {
    id: "paintingVariants",
    candidates: ["net/minecraft/world/entity/decoration/painting/PaintingVariants.class"],
    required: false,
  },
  {
    id: "paintingVariantTags",
    candidates: ["net/minecraft/tags/PaintingVariantTags.class"],
    required: false,
  },
  {
    id: "suspiciousEffectHolder",
    candidates: ["net/minecraft/world/level/block/SuspiciousEffectHolder.class"],
    required: false,
  },
];

type FieldStringEntry = {
  fieldName: string;
  id: string;
};

type DataTagFile = {
  replace?: boolean;
  values?: Array<string | { id?: string; required?: boolean }>;
};

type GeneratedVariantValue = {
  resolution: CreativeModeTabResolvedVariantResolution;
  sourceClassId: string | null;
  variantId: string | null;
  fieldName: string | null;
  level: number | null;
  expression: string;
};

export async function decompileCreativeModeTabReferencedClasses(
  bundle: MinecraftSourceBundle,
  options: DecompileMinecraftClassTargetsOptions = {},
): Promise<Record<string, DecompiledMinecraftClass | null>> {
  return decompileMinecraftClassTargets(
    bundle,
    CREATIVE_MODE_TAB_REFERENCED_CLASS_TARGETS,
    options,
  );
}

function normalizeIdentifier(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

function classSource(
  classes: Record<string, DecompiledMinecraftClass | null>,
  id: string,
): string | null {
  return classes[id]?.javaSource ?? null;
}

function numericLiteralValue(value: string): number | null {
  const normalized = value.replace(/[lLfFdD]$/, "");
  if (!/^-?\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function numberFromSlice(
  source: string,
  tokens: JavaToken[],
  slice: TokenSlice | null,
): number | null {
  if (!slice) {
    return null;
  }
  const raw = tokenSource(source, tokens, slice.startIndex, slice.endIndex);
  return numericLiteralValue(raw);
}

function statementFieldName(
  tokens: JavaToken[],
  statementStart: number,
  equalsIndex: number,
): string | null {
  for (let index = equalsIndex - 1; index >= statementStart; index -= 1) {
    if (tokens[index].kind === "identifier") {
      return tokens[index].value;
    }
  }
  return null;
}

function parseFieldStringInitializers(source: string, ownerName: string): FieldStringEntry[] {
  const tokens = tokenizeJava(source);
  const entries: FieldStringEntry[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "=") {
      continue;
    }

    const resolvedStatementStart = (() => {
      let cursor = index;
      while (cursor > 0 && tokens[cursor - 1].value !== ";" && tokens[cursor - 1].value !== "{") {
        cursor -= 1;
      }
      return cursor;
    })();
    const statementEnd = findStatementEnd(tokens, resolvedStatementStart);
    if (statementEnd === -1) {
      continue;
    }

    const fieldName = statementFieldName(tokens, resolvedStatementStart, index);
    if (!fieldName) {
      continue;
    }

    let initializerBelongsToOwner = false;
    for (let cursor = index + 1; cursor < statementEnd; cursor += 1) {
      const qualified = readQualifiedNameAt(tokens, cursor);
      if (
        (qualified?.name === `${ownerName}.register` ||
          qualified?.name === `${ownerName}.create` ||
          qualified?.name === `${ownerName}.key`) &&
        tokens[qualified.endIndex]?.value === "("
      ) {
        initializerBelongsToOwner = true;
        break;
      }
    }
    if (!initializerBelongsToOwner) {
      continue;
    }

    const id = firstStringLiteral(tokens, index + 1, statementEnd);
    if (id) {
      const normalizedId = normalizeIdentifier(id);
      const key = `${fieldName}\0${normalizedId}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ fieldName, id: normalizedId });
      }
    }
  }

  return entries;
}

function parseFireworkDurations(source: string): number[] {
  const tokens = tokenizeJava(source);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "CRAFTABLE_DURATIONS") {
      continue;
    }

    let equalsIndex = index + 1;
    while (equalsIndex < tokens.length && tokens[equalsIndex].value !== "=") {
      equalsIndex += 1;
    }
    if (tokens[equalsIndex]?.value !== "=") {
      continue;
    }

    const statementEnd = findStatementEnd(tokens, index);
    if (statementEnd === -1) {
      continue;
    }

    return unique(
      tokens
        .slice(equalsIndex + 1, statementEnd)
        .filter((token) => token.kind === "number")
        .map((token) => numericLiteralValue(token.value))
        .filter((value): value is number => value !== null),
    );
  }
  return [];
}

function diagnosticForEmptyParsedValues(
  classId: string,
  label: string,
  values: unknown[],
): ParserDiagnostic[] {
  return values.length === 0
    ? [
        {
          code: "creative_tab_variants.empty_parsed_values",
          message: `Referenced class '${classId}' was available, but no ${label} were parsed from it.`,
          severity: "warning",
          details: { classId, label },
        },
      ]
    : [];
}

function fieldEntriesToVariants(
  entries: FieldStringEntry[],
  sourceClassId: string,
): CreativeModeTabReferencedVariant[] {
  return entries.map((entry) => ({
    fieldName: entry.fieldName,
    id: entry.id,
    sourceClassId,
  }));
}

function readNameFromSlice(tokens: JavaToken[], slice: TokenSlice): string | null {
  for (let index = slice.endIndex - 1; index >= slice.startIndex; index -= 1) {
    if (isNameToken(tokens[index])) {
      return tokens[index].value;
    }
  }
  return null;
}

function firstTwoConsecutiveNumericArgs(
  source: string,
  tokens: JavaToken[],
  args: TokenSlice[],
): [number, number] | null {
  for (let index = 0; index < args.length - 1; index += 1) {
    const first = numberFromSlice(source, tokens, args[index] ?? null);
    const second = numberFromSlice(source, tokens, args[index + 1] ?? null);
    if (first !== null && second !== null) {
      return [first, second];
    }
  }
  return null;
}

function addEnchantmentLevels(
  source: string,
  enchantments: CreativeModeTabReferencedVariant[],
): CreativeModeTabReferencedVariant[] {
  const tokens = tokenizeJava(source);
  const byFieldName = new Map(enchantments.map((entry) => [entry.fieldName, entry]));

  for (let index = 0; index < tokens.length; index += 1) {
    const qualified = readQualifiedNameAt(tokens, index);
    if (qualified?.name !== "Enchantments.register" || tokens[qualified.endIndex]?.value !== "(") {
      continue;
    }

    const closeIndex = findMatchingToken(tokens, qualified.endIndex);
    if (closeIndex === -1) {
      continue;
    }

    const args = splitTopLevelArguments(tokens, qualified.endIndex + 1, closeIndex);
    const keyArg = args[1];
    const builderArg = args[2];
    if (!keyArg || !builderArg) {
      continue;
    }

    const fieldName = readNameFromSlice(tokens, keyArg);
    const variant = fieldName ? byFieldName.get(fieldName) : null;
    if (!variant) {
      continue;
    }

    for (let cursor = builderArg.startIndex; cursor < builderArg.endIndex; cursor += 1) {
      const definition = readQualifiedNameAt(tokens, cursor);
      if (definition?.name !== "Enchantment.definition" || tokens[definition.endIndex]?.value !== "(") {
        continue;
      }

      const definitionCloseIndex = findMatchingToken(tokens, definition.endIndex);
      if (definitionCloseIndex === -1 || definitionCloseIndex > builderArg.endIndex) {
        continue;
      }

      const definitionArgs = splitTopLevelArguments(
        tokens,
        definition.endIndex + 1,
        definitionCloseIndex,
      );
      const weightAndMaxLevel = firstTwoConsecutiveNumericArgs(source, tokens, definitionArgs);
      if (weightAndMaxLevel) {
        variant.maxLevel = weightAndMaxLevel[1];
        variant.minLevel = 1;
      }
      break;
    }
  }

  return enchantments;
}

export function parseCreativeModeTabReferencedVariantData(
  classes: Record<string, DecompiledMinecraftClass | null>,
): CreativeModeTabReferencedVariantData {
  const unresolvedClassIds = CREATIVE_MODE_TAB_REFERENCED_CLASS_TARGETS
    .map((target) => target.id)
    .filter((id) => !classes[id]);
  const diagnostics: ParserDiagnostic[] = unresolvedClassIds.map((classId) => ({
    code: "creative_tab_variants.class_missing",
    message: `Referenced class '${classId}' was not decompiled; related generated variants may remain symbolic or partial.`,
    severity: "warning",
    details: { classId },
  }));

  const fireworkSource = classSource(classes, "fireworkRocketItem");
  const potionsSource = classSource(classes, "potions");
  const enchantmentsSource = classSource(classes, "enchantments");
  const instrumentsSource = classSource(classes, "instruments");
  const instrumentTagsSource = classSource(classes, "instrumentTags");
  const paintingVariantsSource = classSource(classes, "paintingVariants");
  const paintingVariantTagsSource = classSource(classes, "paintingVariantTags");

  const fireworkCraftableDurations = fireworkSource ? parseFireworkDurations(fireworkSource) : [];
  const potions = potionsSource
    ? fieldEntriesToVariants(parseFieldStringInitializers(potionsSource, "Potions"), "potions")
    : [];
  const enchantments = enchantmentsSource
    ? addEnchantmentLevels(
        enchantmentsSource,
        fieldEntriesToVariants(
          parseFieldStringInitializers(enchantmentsSource, "Enchantments"),
          "enchantments",
        ),
      )
    : [];
  const instruments = instrumentsSource
    ? fieldEntriesToVariants(
        parseFieldStringInitializers(instrumentsSource, "Instruments"),
        "instruments",
      )
    : [];
  const paintingVariants = paintingVariantsSource
    ? fieldEntriesToVariants(
        parseFieldStringInitializers(paintingVariantsSource, "PaintingVariants"),
        "paintingVariants",
      )
    : [];
  const instrumentTagEntries = instrumentTagsSource
    ? parseFieldStringInitializers(instrumentTagsSource, "InstrumentTags")
    : [];
  const paintingVariantTagEntries = paintingVariantTagsSource
    ? parseFieldStringInitializers(paintingVariantTagsSource, "PaintingVariantTags")
    : [];

  diagnostics.push(
    ...(fireworkSource
      ? diagnosticForEmptyParsedValues(
          "fireworkRocketItem",
          "craftable firework durations",
          fireworkCraftableDurations,
        )
      : []),
    ...(potionsSource ? diagnosticForEmptyParsedValues("potions", "potions", potions) : []),
    ...(enchantmentsSource
      ? diagnosticForEmptyParsedValues("enchantments", "enchantments", enchantments)
      : []),
    ...(instrumentsSource
      ? diagnosticForEmptyParsedValues("instruments", "instruments", instruments)
      : []),
    ...(paintingVariantsSource
      ? diagnosticForEmptyParsedValues("paintingVariants", "painting variants", paintingVariants)
      : []),
    ...(instrumentTagsSource
      ? diagnosticForEmptyParsedValues("instrumentTags", "instrument tags", instrumentTagEntries)
      : []),
    ...(paintingVariantTagsSource
      ? diagnosticForEmptyParsedValues(
          "paintingVariantTags",
          "painting variant tags",
          paintingVariantTagEntries,
        )
      : []),
  );

  return {
    fireworkCraftableDurations,
    potions,
    enchantments,
    instruments,
    paintingVariants,
    instrumentTags: Object.fromEntries(
      instrumentTagEntries.map((entry) => [entry.fieldName, []]),
    ),
    paintingVariantTags: Object.fromEntries(
      paintingVariantTagEntries.map((entry) => [entry.fieldName, []]),
    ),
    unresolvedClassIds,
    diagnostics,
  };
}

async function readDataTagValues(
  bundle: MinecraftSourceBundle,
  registryDirectory: string,
  tagId: string,
  seenTagIds = new Set<string>(),
): Promise<string[]> {
  if (!bundle.assetsRoot) {
    return [];
  }

  const normalizedTagId = normalizeIdentifier(tagId.replace(/^#/, ""));
  if (seenTagIds.has(normalizedTagId)) {
    return [];
  }
  seenTagIds.add(normalizedTagId);

  const [namespace, pathId] = normalizedTagId.split(":");
  const tagPath = path.join(
    bundle.assetsRoot,
    "data",
    namespace ?? "minecraft",
    "tags",
    registryDirectory,
    `${pathId}.json`,
  );

  let parsed: DataTagFile;
  try {
    parsed = JSON.parse(await readFile(tagPath, "utf8")) as DataTagFile;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  return unique(
    (
      await Promise.all(
        (parsed.values ?? [])
          .map((value) => (typeof value === "string" ? value : value.id))
          .filter((value): value is string => Boolean(value))
          .map((value) =>
            value.startsWith("#")
              ? readDataTagValues(bundle, registryDirectory, value.slice(1), seenTagIds)
              : Promise.resolve([normalizeIdentifier(value)]),
          ),
      )
    ).flat(),
  );
}

export async function addCreativeModeTabDataTagVariants(
  bundle: MinecraftSourceBundle,
  data: CreativeModeTabReferencedVariantData,
): Promise<CreativeModeTabReferencedVariantData> {
  const diagnostics = [...data.diagnostics];
  if (!bundle.assetsRoot) {
    diagnostics.push({
      code: "creative_tab_variants.data_tags.no_assets_root",
      message: "Source bundle has no extracted assets/data root; data tag variants cannot be resolved.",
      severity: "warning",
    });
  }

  const instrumentTags = { ...data.instrumentTags };
  for (const fieldName of Object.keys(instrumentTags)) {
    const tagId = fieldName.toLowerCase();
    instrumentTags[fieldName] = await readDataTagValues(bundle, "instrument", tagId);
    if (instrumentTags[fieldName].length === 0) {
      diagnostics.push({
        code: "creative_tab_variants.data_tags.empty_tag",
        message: `Instrument tag '${tagId}' resolved to no values.`,
        severity: "warning",
        details: { registryDirectory: "instrument", tagId },
      });
    }
  }

  const paintingVariantTags = { ...data.paintingVariantTags };
  for (const fieldName of Object.keys(paintingVariantTags)) {
    const tagId = fieldName.toLowerCase();
    paintingVariantTags[fieldName] = await readDataTagValues(bundle, "painting_variant", tagId);
    if (paintingVariantTags[fieldName].length === 0) {
      diagnostics.push({
        code: "creative_tab_variants.data_tags.empty_tag",
        message: `Painting variant tag '${tagId}' resolved to no values.`,
        severity: "warning",
        details: { registryDirectory: "painting_variant", tagId },
      });
    }
  }

  return {
    ...data,
    instrumentTags,
    paintingVariantTags,
    diagnostics,
  };
}

function tagFieldFromExpression(expression: string | null, ownerName: string): string | null {
  if (!expression) {
    return null;
  }
  const match = expression.match(new RegExp(`${ownerName}\\.([A-Z0-9_]+)`));
  return match?.[1] ?? null;
}

function valuesForEntry(
  entry: CreativeModeTabAcceptedEntry,
  data: CreativeModeTabReferencedVariantData,
): GeneratedVariantValue[] {
  if (entry.variantKind === "firework_craftable_duration") {
    return data.fireworkCraftableDurations.map((duration) => ({
      resolution: "exact",
      sourceClassId: "fireworkRocketItem",
      variantId: null,
      fieldName: null,
      level: duration,
      expression: String(duration),
    }));
  }

  if (entry.variantKind === "ominous_bottle_amplifier") {
    return [
      {
        resolution: "exact",
        sourceClassId: "creativeModeTabs",
        variantId: null,
        fieldName: null,
        level: numberFromEntryValue(entry),
        expression: entry.variantValueExpression ?? "",
      },
    ];
  }

  if (entry.variantKind === "potion_effect_type") {
    return data.potions.map((potion) => ({
      resolution: "exact",
      sourceClassId: potion.sourceClassId,
      variantId: potion.id,
      fieldName: potion.fieldName,
      level: null,
      expression: potion.id,
    }));
  }

  if (entry.variantKind === "enchantment_max_level") {
    return data.enchantments.map((enchantment) => ({
      resolution: enchantment.maxLevel ? "exact" : "partial",
      sourceClassId: enchantment.sourceClassId,
      variantId: enchantment.id,
      fieldName: enchantment.fieldName,
      level: enchantment.maxLevel ?? null,
      expression: enchantment.maxLevel
        ? `${enchantment.id} level ${enchantment.maxLevel}`
        : enchantment.id,
    }));
  }

  if (entry.variantKind === "enchantment_each_level") {
    return data.enchantments.flatMap<GeneratedVariantValue>((enchantment) => {
      if (!enchantment.maxLevel) {
        return [
          {
            resolution: "partial" as const,
            sourceClassId: enchantment.sourceClassId,
            variantId: enchantment.id,
            fieldName: enchantment.fieldName,
            level: null,
            expression: enchantment.id,
          },
        ];
      }
      return Array.from({ length: enchantment.maxLevel }, (_value, levelIndex) => {
        const level = levelIndex + 1;
        return {
          resolution: "exact" as const,
          sourceClassId: enchantment.sourceClassId,
          variantId: enchantment.id,
          fieldName: enchantment.fieldName,
          level,
          expression: `${enchantment.id} level ${level}`,
        };
      });
    });
  }

  if (entry.variantKind === "instrument_tag_entry") {
    const tagField = tagFieldFromExpression(entry.variantSourceExpression, "InstrumentTags");
    const tagValues = tagField ? data.instrumentTags[tagField] : null;
    const allById = new Map(data.instruments.map((instrument) => [instrument.id, instrument]));
    return (tagValues && tagValues.length > 0 ? tagValues : data.instruments.map((item) => item.id))
      .map((id) => {
        const instrument = allById.get(id) ?? null;
        return {
          resolution: tagValues && tagValues.length > 0 ? "exact" : "partial",
          sourceClassId: instrument?.sourceClassId ?? "instruments",
          variantId: id,
          fieldName: instrument?.fieldName ?? null,
          level: null,
          expression: id,
        };
      });
  }

  if (entry.variantKind === "painting_variant") {
    const tagField =
      tagFieldFromExpression(entry.variantValueExpression, "PaintingVariantTags") ??
      tagFieldFromExpression(entry.variantSourceExpression, "PaintingVariantTags");
    const tagValues = tagField ? data.paintingVariantTags[tagField] : null;
    const allById = new Map(data.paintingVariants.map((variant) => [variant.id, variant]));
    const inverseTag = entry.variantValueExpression?.includes("!") ?? false;
    const ids =
      tagValues && tagValues.length > 0
        ? inverseTag
          ? data.paintingVariants
              .map((variant) => variant.id)
              .filter((id) => !tagValues.includes(id))
          : tagValues
        : data.paintingVariants.map((variant) => variant.id);

    return ids.map((id) => {
      const variant = allById.get(id) ?? null;
      return {
        resolution: tagValues && tagValues.length > 0 ? "exact" : "partial",
        sourceClassId: variant?.sourceClassId ?? "paintingVariants",
        variantId: id,
        fieldName: variant?.fieldName ?? null,
        level: null,
        expression: id,
      };
    });
  }

  return [];
}

function numberFromEntryValue(entry: CreativeModeTabAcceptedEntry): number | null {
  return entry.variantValueExpression ? numericLiteralValue(entry.variantValueExpression) : null;
}

export function resolveCreativeModeTabGeneratedVariants(
  parsed: CreativeModeTabsParseResult,
  data: CreativeModeTabReferencedVariantData,
): CreativeModeTabResolvedGeneratedVariant[] {
  const variants: CreativeModeTabResolvedGeneratedVariant[] = [];

  for (const tab of parsed.tabs) {
    for (const entry of tab.displayItems?.entries ?? []) {
      if (entry.kind !== "generated_variant" || !entry.variantKind) {
        continue;
      }

      const values = valuesForEntry(entry, data);
      if (values.length === 0) {
        variants.push({
          tabId: tab.id,
          tabFieldName: tab.fieldName,
          entry,
          resolution: "symbolic",
          sourceClassId: null,
          variantKind: entry.variantKind,
          itemField: entry.itemField,
          variantId: null,
          variantFieldName: null,
          variantLevel: null,
          variantValueExpression: entry.variantValueExpression ?? "",
          diagnostic: {
            code: "creative_tab_variants.generated.symbolic",
            message: `Generated variant kind '${entry.variantKind}' could not be expanded exactly.`,
            severity: "warning",
            range: entry.range,
            source: entry.source,
            details: { variantKind: entry.variantKind },
          },
        });
        continue;
      }

      variants.push(
        ...values.map((value) => ({
          tabId: tab.id,
          tabFieldName: tab.fieldName,
          entry,
          resolution: value.resolution,
          sourceClassId: value.sourceClassId,
          variantKind: entry.variantKind ?? "generated_variant",
          itemField: entry.itemField,
          variantId: value.variantId,
          variantFieldName: value.fieldName,
          variantLevel: value.level,
          variantValueExpression: value.expression,
          diagnostic:
            value.resolution === "exact"
              ? null
              : {
                  code: "creative_tab_variants.generated.partial",
                  message: `Generated variant kind '${entry.variantKind}' was expanded with partial data.`,
                  severity: "warning" as const,
                  range: entry.range,
                  source: entry.source,
                  details: { variantKind: entry.variantKind ?? "generated_variant" },
                },
        })),
      );
    }
  }

  return variants;
}

export function expandCreativeModeTabsWithResolvedVariants(
  parsed: CreativeModeTabsParseResult,
  resolvedVariants: CreativeModeTabResolvedGeneratedVariant[],
): CreativeModeTabsParseResult {
  const variantsByEntry = new Map<CreativeModeTabAcceptedEntry, CreativeModeTabResolvedGeneratedVariant[]>();
  for (const variant of resolvedVariants) {
    variantsByEntry.set(variant.entry, [...(variantsByEntry.get(variant.entry) ?? []), variant]);
  }

  const tabs = parsed.tabs.map((tab) => {
    if (!tab.displayItems) {
      return tab;
    }

    const entries = tab.displayItems.entries.flatMap((entry) => {
      const variants = variantsByEntry.get(entry);
      if (!variants || variants.length === 0 || variants.some((variant) => variant.resolution === "symbolic")) {
        return [entry];
      }

      return variants.map((variant) => ({
        ...entry,
        variantValueExpression: variant.variantValueExpression,
      }));
    });

    const itemFields = unique(entries.flatMap((entry) => entry.itemFields));
    return {
      ...tab,
      displayItems: {
        ...tab.displayItems,
        entries,
      },
      itemFields,
    };
  });

  const tabByFieldName = Object.fromEntries(tabs.map((tab) => [tab.fieldName, tab]));
  const itemFieldToTabIds: Record<string, string[]> = {};
  for (const tab of tabs) {
    for (const itemField of tab.itemFields) {
      itemFieldToTabIds[itemField] = [...(itemFieldToTabIds[itemField] ?? []), tab.id];
    }
  }

  return {
    ...parsed,
    tabs,
    tabByFieldName,
    itemFieldToTabIds,
  };
}
