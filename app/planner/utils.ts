import {
  AISLE_GAP,
  BRICK_INDEX,
  BRICK_PREFIXES,
  COLOR_INDEX,
  COLOR_PREFIXES,
  MIS_CROSS,
  STONE_INDEX,
  STONE_PREFIXES,
  SLOT_GAP,
  SLOT_SIZE,
  WOOD_INDEX,
  WOOD_PREFIXES,
} from "./constants";
import type {
  CatalogItem,
  Category,
  DragPayload,
  FillDirection,
  HallConfig,
  HallId,
  HallOrientation,
  HallSideConfig,
} from "./types";

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export type MisComparatorPrimer = {
  itemCount: number;
  stacks: number;
  items: number;
  containerSlots: 27 | 54;
  isOverThreshold: boolean;
};

export type MisAssignedItemCount = {
  maxStackSize: number;
  count: number;
};

export function calculateMisComparatorPrimer(
  usableSlots: number,
  signalStrengthThreshold: number,
  assignedItems: readonly MisAssignedItemCount[] = [],
): MisComparatorPrimer {
  const containerSlots = usableSlots <= 27 ? 27 : 54;
  const threshold = clamp(Math.round(signalStrengthThreshold), 1, 15);
  const maxItemCount = containerSlots * 64;
  const thresholdItemCount = ((threshold - 1) * maxItemCount) / 14;
  const assignedItemEquivalentCount = assignedItems.reduce((total, item) => {
    const stackSize = clamp(Math.floor(item.maxStackSize), 1, 64);
    const count = clamp(Math.floor(item.count), 0, stackSize);
    return total + count * (64 / stackSize);
  }, 0);
  const assignedSignalStrength =
    assignedItemEquivalentCount <= 0
      ? 0
      : Math.floor((assignedItemEquivalentCount / maxItemCount) * 14) + 1;
  const itemCount = clamp(
    Math.ceil(thresholdItemCount - assignedItemEquivalentCount),
    0,
    maxItemCount,
  );

  return {
    itemCount,
    stacks: Math.floor(itemCount / 64),
    items: itemCount % 64,
    containerSlots,
    isOverThreshold: assignedSignalStrength > threshold,
  };
}

export function formatStackItemCount(itemCount: number): string {
  const normalized = Math.max(0, Math.floor(itemCount));
  return `${Math.floor(normalized / 64)} stacks + ${normalized % 64} items`;
}

export function toTitle(input: string): string {
  return input
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function startsWithVariantPrefix(
  id: string,
  prefixes: readonly string[],
): string | null {
  const ordered = [...prefixes].sort((a, b) => b.length - a.length);
  for (const prefix of ordered) {
    if (id === prefix || id.startsWith(`${prefix}_`)) {
      return prefix;
    }
  }
  return null;
}

type CustomCategoryMatch = {
  id: string;
  label: string;
  dragLabel: string;
};

function matchCustomMaterialCategory(itemId: string): CustomCategoryMatch | null {
  const brickItems = [
    "brick",
    "nether_brick",
    "resin_brick",
  ];
  if (brickItems.includes(itemId)) {
    return {
      id: "collection:brick_items",
      label: "Brick Items",
      dragLabel: "brick item set",
    };
  }

  const bambooItems = [
    "bamboo",
    "bamboo_block",
    "bamboo_mosaic",
  ];
  if (bambooItems.includes(itemId)) {
    return {
      id: "collection:bamboo",
      label: "Bamboo",
      dragLabel: "bamboo set",
    };
  }

  const fungusItems = [
    "crimson_fungus",
    "warped_fungus",
  ];
  if (fungusItems.includes(itemId)) {
    return {
      id: "collection:fungus",
      label: "Fungus",
      dragLabel: "fungus set",
    };
  }



  // dirt
  const dirtItems = [
    "grass_block",
    "dirt",
    "coarse_dirt",
    "rooted_dirt",
    "podzol",
    "dirt_path",
    "farmland",
    "mycelium"
  ];
  if (dirtItems.includes(itemId)) {
    return {
      id: "collection:dirt",
      label: "Dirt",
      dragLabel: "dirt set",
    };
  }
  // grass, minus grass_block
  const grassItems = [
    "short_dry_grass",
    "tall_dry_grass",
    "fern",
    "large_fern",
    "dead_bush",
    "tall_grass",
    "short_grass",
    "seagrass",
  ];
  if (grassItems.includes(itemId)) {
    return {
      id: "collection:grass",
      label: "Grass & Ferns",
      dragLabel: "grass & ferns set",
    };
  }

  // heads/skulls
  if (/(^|_)(player_)?head($|_)/.test(itemId) || /(^|_)skull($|_)/.test(itemId)) {
    return {
      id: "collection:heads",
      label: "Heads & Skulls",
      dragLabel: "heads & skulls set",
    };
  }

  // seeds
  if (/(^|_)seeds($|_)/.test(itemId)) {
    return {
      id: "collection:seeds",
      label: "Seeds",
      dragLabel: "seeds set",
    };
  }

  // sherds
  if (/(^|_)sherd($|_)/.test(itemId)) {
    return {
      id: "collection:sherds",
      label: "Sherds",
      dragLabel: "sherds set",
    };
  }

  if (/(^|_)sandstone($|_)/.test(itemId)) {
    return {
      id: "collection:sandstone",
      label: "Sandstone",
      dragLabel: "sandstone set",
    };
  }

  if (/(^|_)ice($|_)/.test(itemId)) {
    return {
      id: "collection:ice",
      label: "Ice",
      dragLabel: "ice set",
    };
  }

  if (/(^|_)copper($|_)/.test(itemId)) {
    return {
      id: "collection:copper",
      label: "Copper",
      dragLabel: "copper set",
    };
  }

  if (/(^|_)ore(s)?($|_)/.test(itemId)) {
    return {
      id: "collection:ores",
      label: "Ore",
      dragLabel: "ore set",
    };
  }

  if (/(^|_)dead_.*coral(s)?($|_)/.test(itemId)) {
    return {
      id: "collection:dead_coral",
      label: "Dead Coral",
      dragLabel: "dead coral set",
    };
  }

  if (/(^|_)coral(s)?($|_)/.test(itemId)) {
    return {
      id: "collection:coral",
      label: "Coral",
      dragLabel: "coral set",
    };
  }

  if (/(^|_)azalea($|_)/.test(itemId)) {
    return {
      id: "collection:azalea",
      label: "Azalea",
      dragLabel: "azalea set",
    };
  }

  // check if sand or red sand and suspicious sand, but not soul sand
  if ((/(^|_)(red_)?sand($|_)/.test(itemId) && !/(^|_)soul_sand($|_)/.test(itemId)) || /(^|_)gravel($|_)/.test(itemId)) {
    return {
      id: "collection:sand_gravel",
      label: "Sand & Gravel",
      dragLabel: "sand & gravel set",
    };
  }

  // egg category
  if (/(^|_)egg($|_)/.test(itemId)) {
    return {
      id: "collection:eggs",
      label: "Egg",
      dragLabel: "egg set",
    };
  }

  // candles
  if (/(^|_)candle($|_)/.test(itemId)) {
    return {
      id: "collection:candles",
      label: "Candles",
      dragLabel: "candle set",
    };
  }

  

  return null;
}

function resolvePrimaryCreativeTab(item: CatalogItem): string {
  // if (item.id.endsWith("sculk_sensor") && item.creativeTabs.includes("redstone_blocks")) {
  //   return "redstone_blocks";
  // }

  // if it has redstone blocks, always return it
  if (item.creativeTabs.includes("redstone_blocks")) {
    return "redstone_blocks";
  }

  return item.creativeTabs[0] ?? "uncategorized";
}

export function nonMisSlotId(
  hallId: HallId,
  slice: number,
  side: 0 | 1,
  row: number,
): string {
  return `${hallId}:g:${slice}:${side}:${row}`;
}

export function misSlotId(
  hallId: HallId,
  misSlice: number,
  side: 0 | 1,
  row: number,
  index: number,
): string {
  return `${hallId}:m:${misSlice}:${side}:${row}:${index}`;
}

export type HallSliceDescriptor = {
  globalSlice: number;
  sectionIndex: number;
  sectionSlice: number;
  mainStart: number;
  mainSize: number;
  sideLeft: HallSideConfig;
  sideRight: HallSideConfig;
};

function sideDepthPx(side: HallSideConfig): number {
  if (side.type === "mis") {
    return side.rowsPerSlice * MIS_CROSS + Math.max(0, side.rowsPerSlice - 1) * SLOT_GAP;
  }
  return side.rowsPerSlice * SLOT_SIZE + Math.max(0, side.rowsPerSlice - 1) * SLOT_GAP;
}

function sliceMainSize(): number {
  // Keep per-slice main width constant; MIS spans multiple slices via misWidth.
  return SLOT_SIZE;
}

export function resolveHallSlices(config: HallConfig): HallSliceDescriptor[] {
  const slices: HallSliceDescriptor[] = [];
  let mainCursor = 0;
  let globalSlice = 0;

  for (const [sectionIndex, section] of config.sections.entries()) {
    for (let sectionSlice = 0; sectionSlice < section.slices; sectionSlice += 1) {
      const mainSize = sliceMainSize();
      slices.push({
        globalSlice,
        sectionIndex,
        sectionSlice,
        mainStart: mainCursor,
        mainSize,
        sideLeft: section.sideLeft,
        sideRight: section.sideRight,
      });
      mainCursor += mainSize + SLOT_GAP;
      globalSlice += 1;
    }
  }

  return slices;
}

export function getHallSize(
  config: HallConfig,
  orientation: HallOrientation,
): { width: number; height: number } {
  const slices = resolveHallSlices(config);
  const main =
    slices.length === 0
      ? SLOT_SIZE
      : slices[slices.length - 1].mainStart + slices[slices.length - 1].mainSize;

  let maxLeftDepth = 0;
  let maxRightDepth = 0;
  for (const slice of slices) {
    maxLeftDepth = Math.max(maxLeftDepth, sideDepthPx(slice.sideLeft));
    maxRightDepth = Math.max(maxRightDepth, sideDepthPx(slice.sideRight));
  }
  const cross = maxLeftDepth + AISLE_GAP + maxRightDepth;

  if (orientation === "horizontal") {
    return { width: main, height: cross };
  }
  return { width: cross, height: main };
}

export function buildOrderedSlotIds(
  configs: Record<HallId, HallConfig>,
  fillDirection: FillDirection = "column",
): string[] {
  const ordered: string[] = [];
  const hallIds = Object.keys(configs).map((key) => Number(key));
  for (const hallId of hallIds) {
    const hall = configs[hallId];
    const slices = resolveHallSlices(hall);

    for (const side of [0, 1] as const) {
      if (fillDirection === "row") {
        const nonMisSlices = slices
          .map((slice) => ({
            slice,
            sideConfig: side === 0 ? slice.sideLeft : slice.sideRight,
          }))
          .filter((entry) => entry.sideConfig.type !== "mis");
        const sectionEntries = new Map<number, typeof nonMisSlices>();
        for (const entry of nonMisSlices) {
          const sectionIndex = entry.slice.sectionIndex;
          const currentSection = sectionEntries.get(sectionIndex);
          if (currentSection) {
            currentSection.push(entry);
          } else {
            sectionEntries.set(sectionIndex, [entry]);
          }
        }
        const orderedSections = Array.from(sectionEntries.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, entries]) => entries);
        for (const section of orderedSections) {
          const maxRows = section.reduce(
            (max, entry) => Math.max(max, entry.sideConfig.rowsPerSlice),
            0,
          );
          for (let row = 0; row < maxRows; row += 1) {
            for (const entry of section) {
              if (row >= entry.sideConfig.rowsPerSlice) {
                continue;
              }
              ordered.push(nonMisSlotId(hallId, entry.slice.globalSlice, side, row));
            }
          }
        }
      } else {
        for (const slice of slices) {
          const sideConfig = side === 0 ? slice.sideLeft : slice.sideRight;
          if (sideConfig.type === "mis") {
            continue;
          }
          for (let row = 0; row < sideConfig.rowsPerSlice; row += 1) {
            ordered.push(nonMisSlotId(hallId, slice.globalSlice, side, row));
          }
        }
      }

      const seenMisSlices = new Set<number>();
      for (const slice of slices) {
        const sideConfig = side === 0 ? slice.sideLeft : slice.sideRight;
        if (sideConfig.type !== "mis") {
          continue;
        }
        const misWidth = Math.max(1, sideConfig.misWidth);
        const misSlice = slice.globalSlice - (slice.sectionSlice % misWidth);
        if (seenMisSlices.has(misSlice)) {
          continue;
        }
        seenMisSlices.add(misSlice);
        for (let row = 0; row < sideConfig.rowsPerSlice; row += 1) {
          for (let index = 0; index < sideConfig.misSlotsPerSlice; index += 1) {
            ordered.push(misSlotId(hallId, misSlice, side, row, index));
          }
        }
      }
    }
  }

  return ordered;
}

export function parseDragPayload(rawPayload: string): DragPayload | null {
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("kind" in parsed) ||
      !("itemIds" in parsed) ||
      !Array.isArray((parsed as { itemIds?: unknown }).itemIds)
    ) {
      return null;
    }

    const payload = parsed as DragPayload;
    if (payload.kind !== "item" && payload.kind !== "category") {
      return null;
    }

    const itemIds = payload.itemIds.filter(
      (entry): entry is string => typeof entry === "string",
    );

    if (itemIds.length === 0) {
      return null;
    }

    return {
      kind: payload.kind,
      itemIds,
      source:
        payload.source === "layout" || payload.source === "catalog"
          ? payload.source
          : "catalog",
      originSlotId:
        typeof payload.originSlotId === "string" ? payload.originSlotId : undefined,
      sourceSlotIds: Array.isArray(payload.sourceSlotIds)
        ? payload.sourceSlotIds.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

export function buildCategories(items: CatalogItem[]): Category[] {
  const grouped = new Map<
    string,
    {
      label: string;
      dragLabel: string;
      items: CatalogItem[];
      sortMode: "color" | "wood" | "stone" | "brick" | "alpha";
    }
  >();

  const groupedItemIds = new Set<string>();

  for (const item of items) {
    const customCategory = matchCustomMaterialCategory(item.id);
    if (customCategory) {
      if (!grouped.has(customCategory.id)) {
        grouped.set(customCategory.id, {
          label: customCategory.label,
          dragLabel: customCategory.dragLabel,
          items: [],
          sortMode: "alpha",
        });
      }
      grouped.get(customCategory.id)?.items.push(item);
      groupedItemIds.add(item.id);
      continue;
    }

    const woodPrefix = startsWithVariantPrefix(item.id, WOOD_PREFIXES);
    if (woodPrefix) {
      const base = item.id.slice(woodPrefix.length + 1);
      const key = `wood:${base}`;
      const baseTitle = toTitle(base);
      const label = baseTitle === "Wood" ? "Wood Variants" : `${baseTitle} Wood Variants`;
      const dragLabel = baseTitle === "Wood" ? "wood set" : `${baseTitle.toLowerCase()} wood set`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          label,
          dragLabel,
          items: [],
          sortMode: "wood",
        });
      }
      grouped.get(key)?.items.push(item);
      groupedItemIds.add(item.id);
      continue;
    }

    const stonePrefix = startsWithVariantPrefix(item.id, STONE_PREFIXES);
    if (stonePrefix) {
      const base = item.id.slice(stonePrefix.length + 1);
      const key = `stone:${base}`;
      const baseTitle = toTitle(base);
      const label = baseTitle === "Stone" ? "Stone Variants" : `${baseTitle} Stone Variants`;
      const dragLabel = baseTitle === "Stone" ? "stone set" : `${baseTitle.toLowerCase()} stone set`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          label,
          dragLabel,
          items: [],
          sortMode: "stone",
        });
      }
      grouped.get(key)?.items.push(item);
      groupedItemIds.add(item.id);
      continue;
    }

    const brickPrefix = startsWithVariantPrefix(item.id, BRICK_PREFIXES);
    if (brickPrefix) {
      const base = item.id.slice(brickPrefix.length + 1);
      const key = `brick:${base}`;
      const baseTitle = toTitle(base);
      const label = baseTitle === "Brick" ? "Brick Variants" : `${baseTitle} Brick Variants`;
      const dragLabel = baseTitle === "Brick" ? "brick set" : `${baseTitle.toLowerCase()} brick set`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          label,
          dragLabel,
          items: [],
          sortMode: "brick",
        });
      }
      grouped.get(key)?.items.push(item);
      groupedItemIds.add(item.id);
      continue;
    }


    const colorPrefix = startsWithVariantPrefix(item.id, COLOR_PREFIXES);
    if (colorPrefix) {
      const base = item.id.slice(colorPrefix.length + 1);
      const key = `color:${base}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: `${toTitle(base)} Colors`,
          dragLabel: `${toTitle(base)} color set`,
          items: [],
          sortMode: "color",
        });
      }
      grouped.get(key)?.items.push(item);
      groupedItemIds.add(item.id);
      continue;
    }

  }

  const categories: Category[] = [];

  for (const [id, bucket] of grouped.entries()) {
    if (bucket.sortMode === "color") {
      bucket.items.sort((a, b) => {
        const aPrefix = startsWithVariantPrefix(a.id, COLOR_PREFIXES) ?? "";
        const bPrefix = startsWithVariantPrefix(b.id, COLOR_PREFIXES) ?? "";
        return (COLOR_INDEX.get(aPrefix) ?? 999) - (COLOR_INDEX.get(bPrefix) ?? 999);
      });
    } else if (bucket.sortMode === "wood") {
      bucket.items.sort((a, b) => {
        const aPrefix = startsWithVariantPrefix(a.id, WOOD_PREFIXES) ?? "";
        const bPrefix = startsWithVariantPrefix(b.id, WOOD_PREFIXES) ?? "";
        return (WOOD_INDEX.get(aPrefix) ?? 999) - (WOOD_INDEX.get(bPrefix) ?? 999);
      });
    } else if (bucket.sortMode === "stone") {
      bucket.items.sort((a, b) => {
        const aPrefix = startsWithVariantPrefix(a.id, STONE_PREFIXES) ?? "";
        const bPrefix = startsWithVariantPrefix(b.id, STONE_PREFIXES) ?? "";
        return (STONE_INDEX.get(aPrefix) ?? 999) - (STONE_INDEX.get(bPrefix) ?? 999);
      });
    } else if (bucket.sortMode === "brick") {
      bucket.items.sort((a, b) => {
        const aPrefix = startsWithVariantPrefix(a.id, BRICK_PREFIXES) ?? "";
        const bPrefix = startsWithVariantPrefix(b.id, BRICK_PREFIXES) ?? "";
        return (BRICK_INDEX.get(aPrefix) ?? 999) - (BRICK_INDEX.get(bPrefix) ?? 999);
      });
    } else {
      bucket.items.sort((a, b) => a.id.localeCompare(b.id));
    }

    categories.push({
      id,
      label: bucket.label,
      items: bucket.items,
      dragLabel: bucket.dragLabel,
    });
  }

  const singlesByCreativeTab = new Map<string, CatalogItem[]>();
  for (const item of items) {
    if (groupedItemIds.has(item.id)) {
      continue;
    }

    const primaryCreativeTab = resolvePrimaryCreativeTab(item);
    if (!singlesByCreativeTab.has(primaryCreativeTab)) {
      singlesByCreativeTab.set(primaryCreativeTab, []);
    }
    singlesByCreativeTab.get(primaryCreativeTab)?.push(item);
  }

  const singleCategories: Category[] = [];
  for (const [tabId, tabItems] of singlesByCreativeTab.entries()) {
    tabItems.sort((a, b) => a.id.localeCompare(b.id));
    const tabLabel = tabId === "uncategorized" ? "Uncategorized" : toTitle(tabId);
    singleCategories.push({
      id: `tab:${tabId}`,
      label: tabLabel,
      items: tabItems,
      dragLabel: tabLabel,
    });
  }

  categories.sort((a, b) => a.label.localeCompare(b.label));
  singleCategories.sort((a, b) => a.label.localeCompare(b.label));

  return [...categories, ...singleCategories];
}
