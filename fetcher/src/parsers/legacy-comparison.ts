import { readFile } from "node:fs/promises";

import type { ParserDiagnostic } from "../java/parser-utils";
import type { BlockPropertiesParseResult } from "./block-properties";

type ManualProperty = {
  property_name?: string;
  default_value?: unknown;
  entries?: Record<string, unknown>;
};

type ManualBlockData = {
  properties?: Record<string, ManualProperty>;
};

const EXCLUDED_PROPERTY_IDS = new Set(["wiki_page", "variants", "block_render_type"]);

export type LegacyPropertyMismatch = {
  blockId: string;
  blockName: string;
  propertyId: string;
  expected: unknown;
  actual: unknown;
};

export type LegacyPropertyComparison = {
  propertyId: string;
  manualName: string | null;
  compared: number;
  mismatches: number;
  missingGenerated: number;
  skippedComplex: number;
  examples: LegacyPropertyMismatch[];
};

export type LegacyComparisonResult = {
  properties: LegacyPropertyComparison[];
  mismatchCount: number;
  comparedCount: number;
  missingGeneratedCount: number;
  skippedComplexCount: number;
  diagnostics: ParserDiagnostic[];
};

function diagnostic(input: { code: string; message: string; details?: Record<string, string | number | boolean | null> }): ParserDiagnostic {
  return {
    code: input.code,
    message: input.message,
    severity: "warning",
    details: input.details,
  };
}

function titleCaseWord(value: string): string {
  if (["of", "and"].includes(value)) {
    return value;
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function blockNameFromId(blockId: string): string {
  return blockId
    .replace(/^minecraft:/, "")
    .split("_")
    .map(titleCaseWord)
    .join(" ");
}

function colorlessName(blockName: string): string {
  return blockName.replace(
    /^(?:White|Orange|Magenta|Light Blue|Yellow|Lime|Pink|Gray|Light Gray|Cyan|Purple|Blue|Brown|Green|Red|Black|Oak|Spruce|Birch|Jungle|Acacia|Cherry|Dark Oak|Pale Oak|Mangrove|Bamboo|Crimson|Warped|Iron|Copper|Exposed Copper|Weathered Copper|Oxidized Copper|Waxed Copper|Waxed Exposed Copper|Waxed Weathered Copper|Waxed Oxidized Copper) /,
    "",
  );
}

function pluralizeName(name: string): string {
  if (name.endsWith("s")) {
    return name;
  }
  if (name.endsWith("y")) {
    return `${name.slice(0, -1)}ies`;
  }
  return `${name}s`;
}

function manualNameCandidates(blockName: string): string[] {
  const base = colorlessName(blockName);
  const candidates = [
    blockName,
    base,
    pluralizeName(base),
  ];
  const suffixGroups: Array<[RegExp, string]> = [
    [/ Sapling$/, "Saplings"],
    [/ Leaves$/, "Leaves"],
    [/ Log$/, "Logs"],
    [/ Wood$/, "Wood"],
    [/ Stem$/, "Stems"],
    [/ Hyphae$/, "Hyphae"],
    [/ Stairs$/, "Stairs"],
    [/ Slab$/, "Slabs"],
    [/ Button$/, "Buttons"],
    [/ Pressure Plate$/, "Pressure Plates"],
    [/ Door$/, "Doors"],
    [/ Trapdoor$/, "Trapdoors"],
    [/ Fence Gate$/, "Fence Gates"],
    [/ Fence$/, "Fences"],
    [/ Wall$/, "Walls"],
    [/ Carpet$/, "Carpets"],
    [/ Candle$/, "Candles"],
    [/ Banner$/, "Banners"],
    [/ Bed$/, "Beds"],
    [/(?: Sign|Wall Sign)$/, "Signs"],
    [/ Hanging Sign$/, "Hanging Signs"],
    [/ Glass Pane$/, "Glass Pane"],
    [/ Stained Glass Pane$/, "Stained Glass Panes"],
    [/ Stained Glass$/, "Stained Glass"],
    [/ Torch$/, "Torch"],
    [/ Rail$/, "Rail"],
    [/ Coral Fan$/, "Coral Fans"],
    [/ Coral$/, "Corals"],
    [/ Flower$/, "Flowers"],
    [/ Mushroom$/, "Mushrooms"],
    [/ Fungus$/, "Fungi"],
    [/ Roots$/, "Roots"],
    [/ Vine$/, "Vines"],
    [/ Vine Plant$/, "Vines"],
  ];
  for (const [pattern, groupName] of suffixGroups) {
    if (pattern.test(blockName) || pattern.test(base)) {
      candidates.push(groupName);
    }
  }
  if (/^(?:Dandelion|Golden Dandelion|Poppy|Blue Orchid|Allium|Azure Bluet|Red Tulip|Orange Tulip|White Tulip|Pink Tulip|Oxeye Daisy|Cornflower|Lily of the Valley|Wither Rose|Open Eyeblossom|Closed Eyeblossom)$/.test(blockName)) {
    candidates.push("Flowers");
  }
  if (/Seagrass$/.test(blockName)) {
    candidates.push("Seagrass");
  }
  if (/Piston Head$/.test(blockName)) {
    candidates.push("Piston");
  }
  if (blockName === "Bamboo Block") {
    candidates.push("Block of Bamboo");
  }
  if (blockName === "Stripped Bamboo Block") {
    candidates.push("Block of Stripped Bamboo");
  }
  return Array.from(new Set(candidates));
}

function manualValueForBlock(property: ManualProperty, blockName: string): unknown {
  const entries = property.entries ?? {};
  for (const candidate of manualNameCandidates(blockName)) {
    if (Object.hasOwn(entries, candidate)) {
      return entries[candidate];
    }
  }
  return property.default_value;
}

function isDeprecatedProperty(property: ManualProperty): boolean {
  return JSON.stringify(property).toLowerCase().includes("deprecated");
}

function comparableManualValue(value: unknown): boolean {
  return (
    typeof value === "boolean" ||
    typeof value === "number" ||
    value === null ||
    value === "Yes" ||
    value === "No" ||
    value === "Not Applicable" ||
    typeof value === "string"
  );
}

function normalizeValue(value: unknown): unknown {
  if (value === "Yes") {
    return true;
  }
  if (value === "No") {
    return false;
  }
  if (value === "None") {
    return null;
  }
  if (value === "Not Applicable") {
    return null;
  }
  if (typeof value === "string") {
    return value
      .replace(/^\{\{mapColor\|([^}]+)\}\}$/, "$1")
      .replace(/^MapColor\./, "")
      .replace(/^NoteBlockInstrument\./, "")
      .replace(/^SoundType\./, "")
      .replace(/^PushReaction\./, "")
      .toLowerCase()
      .replace(/_/g, " ");
  }
  return value;
}

function valuesMatch(expected: unknown, actual: unknown): boolean {
  const normalizedExpected = normalizeValue(expected);
  const normalizedActual = normalizeValue(actual);
  if (Array.isArray(normalizedActual)) {
    return normalizedActual.map(normalizeValue).includes(normalizedExpected);
  }
  return normalizedExpected === normalizedActual;
}

export async function compareBlockPropertiesToLegacyData(input: {
  blockProperties: BlockPropertiesParseResult;
  manualDataPath: string;
}): Promise<LegacyComparisonResult> {
  let manual: ManualBlockData;
  try {
    manual = JSON.parse(await readFile(input.manualDataPath, "utf8")) as ManualBlockData;
  } catch (error) {
    return {
      properties: [],
      mismatchCount: 0,
      comparedCount: 0,
      missingGeneratedCount: 0,
      skippedComplexCount: 0,
      diagnostics: [
        diagnostic({
          code: "legacy_comparison.manual_data_unavailable",
          message: `Could not read manual block data from '${input.manualDataPath}'.`,
          details: { error: error instanceof Error ? error.message : String(error) },
        }),
      ],
    };
  }

  const manualProperties = manual.properties ?? {};
  const comparisons = Object.entries(manualProperties)
    .filter(([propertyId, property]) => !EXCLUDED_PROPERTY_IDS.has(propertyId) && !isDeprecatedProperty(property))
    .map(([propertyId, property]): LegacyPropertyComparison => {
      let compared = 0;
      let mismatches = 0;
      let missingGenerated = 0;
      let skippedComplex = 0;
      const examples: LegacyPropertyMismatch[] = [];

      for (const block of input.blockProperties.blocks) {
        const blockName = blockNameFromId(block.id);
        const expected = manualValueForBlock(property, blockName);
        if (!comparableManualValue(expected)) {
          skippedComplex += 1;
          continue;
        }
        const hasGenerated = Object.hasOwn(block.derivedLegacyProperties, propertyId);
        if (!hasGenerated && propertyId.startsWith("tag_")) {
          compared += 1;
          if (!valuesMatch(expected, false)) {
            mismatches += 1;
            if (examples.length < 25) {
              examples.push({ blockId: block.id, blockName, propertyId, expected, actual: false });
            }
          }
          continue;
        }
        if (!hasGenerated) {
          missingGenerated += 1;
          continue;
        }
        compared += 1;
        const actual = block.derivedLegacyProperties[propertyId];
        if (!valuesMatch(expected, actual)) {
          mismatches += 1;
          if (examples.length < 25) {
            examples.push({ blockId: block.id, blockName, propertyId, expected, actual });
          }
        }
      }

      return {
        propertyId,
        manualName: property.property_name ?? null,
        compared,
        mismatches,
        missingGenerated,
        skippedComplex,
        examples,
      };
    })
    .sort((left, right) => right.mismatches - left.mismatches || right.missingGenerated - left.missingGenerated);

  return {
    properties: comparisons,
    mismatchCount: comparisons.reduce((sum, entry) => sum + entry.mismatches, 0),
    comparedCount: comparisons.reduce((sum, entry) => sum + entry.compared, 0),
    missingGeneratedCount: comparisons.reduce((sum, entry) => sum + entry.missingGenerated, 0),
    skippedComplexCount: comparisons.reduce((sum, entry) => sum + entry.skippedComplex, 0),
    diagnostics: [],
  };
}
