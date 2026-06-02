import { withBasePath } from "../base-path";
import type { CatalogItem, HallConfig, HallId, HallSideConfig } from "../types";
import { calculateMisComparatorPrimer, clamp, misSlotId, nonMisSlotId } from "../utils";
import { DEFAULT_MIS_MULTIPLICITY, DEFAULT_MIS_SIGNAL_STRENGTH } from "./plannerSnapshot";

export type LayoutExportMode = "containers" | "item_frames" | "blocks_and_frames" | "boxes" | "ssi_ss2_filters" | "ss3_filters";
export type LayoutViewMode = "storage" | "flat";
const FILTER_ROW_STRIDE = 2;

export type LayoutExportOption = {
  mode: LayoutExportMode;
  label: string;
  description: string;
  fileSuffix: string;
};

export const LITEMATIC_EXPORT_OPTIONS: readonly LayoutExportOption[] = [
  {
    mode: "containers",
    label: "Litematic: Containers",
    description: "Each slot is a barrel containing the assigned item.",
    fileSuffix: "containers",
  },
  {
    mode: "item_frames",
    label: "Litematic: Item Frames",
    description: "Each slot is shown as an item frame on a support block.",
    fileSuffix: "item-frames",
  },
  {
    mode: "blocks_and_frames",
    label: "Litematic: Blocks + Frames",
    description: "Place block items as blocks, and non-blocks as item frames.",
    fileSuffix: "blocks-and-frames",
  },
  {
    mode: "boxes",
    label: "Litematic: Full boxes",
    description: "Each slot is a full shulker box containing the assigned item.",
    fileSuffix: "boxes",
  },
  {
    mode: "ssi_ss2_filters",
    label: "Litematic: SSI SS2 Filters",
    description: "Preconfigured SSI SS2 item filter hoppers for each assigned item.",
    fileSuffix: "boxes",
  },
  {
    mode: "ss3_filters",
    label: "Litematic: SS3 Filters",
    description: "Preconfigured SS3 item filter hoppers for each assigned item.",
    fileSuffix: "boxes",
  }
] as const;

type LayoutLitematicExportInput = {
  mode: LayoutExportMode;
  layoutName: string;
  hallConfigs: Record<HallId, HallConfig>;
  slotAssignments: Record<string, string>;
  itemById: Map<string, CatalogItem>;
  misSignalStrengths?: Record<string, number>;
  misMultiplicities?: Record<string, number>;
  layoutViewMode?: LayoutViewMode;
};

type LayoutLitematicExportResult = {
  bytes: Uint8Array;
  option: LayoutExportOption;
};

type NucleationSchematicWrapper = {
  setName?: (name: string) => void;
  setAuthor?: (author: string) => void;
  setDescription?: (description: string) => void;
  setCreated?: (created: number) => void;
  setModified?: (modified: number) => void;
  set_block?: (x: number, y: number, z: number, blockName: string) => void;
  set_block_from_string?: (x: number, y: number, z: number, blockState: string) => void;
  addContainerItem?: (
    blockId: string,
    x: number,
    y: number,
    z: number,
    itemId: string,
    slot: number,
    count: number,
  ) => void;
  addItemFrameEntity?: (
    itemId: string,
    supportX: number,
    supportY: number,
    supportZ: number,
    facing: number,
    itemRotation: number,
    fixed: boolean,
  ) => void;
  addEntity?: (id: string, x: number, y: number, z: number, nbt: unknown) => void;
  addBlockEntity?: (id: string, x: number, y: number, z: number, nbt: unknown) => void;
  to_litematic?: () => Uint8Array | number[];
};

type ContainerItem = {
  id: string;
  slot: number;
  count: number;
};

type MisContainerItem = {
  slot: number;
  itemId: string;
  count: number;
};

type MisDummyCandidate = {
  slot: number;
  itemId: string;
  maxAddCount: number;
  equivalentItemsPerCount: number;
  kind: "empty" | "assigned";
};

type NucleationModule = {
  default: () => Promise<unknown>;
  SchematicWrapper: new () => NucleationSchematicWrapper;
};

let nucleationModulePromise: Promise<NucleationModule> | null = null;

export async function exportLayoutAsLitematic(
  input: LayoutLitematicExportInput,
): Promise<LayoutLitematicExportResult> {
  const option = resolveExportOption(input.mode);
  const cells = buildExportCellsForLayout(
    input.slotAssignments,
    input.itemById,
    input.hallConfigs,
    input.mode,
    input.layoutViewMode ?? "storage",
    input.misSignalStrengths,
    input.misMultiplicities,
  );
  if (cells.length === 0) {
    throw new Error("No assigned items found to export.");
  }

  const nucleationModule = await loadNucleationModule();
  if (typeof nucleationModule.SchematicWrapper !== "function") {
    throw new Error("Nucleation module loaded, but SchematicWrapper is unavailable.");
  }

  const schematic = new nucleationModule.SchematicWrapper();
  applyMetadata(schematic, input.layoutName, option);

  // set 0 0
  setBlockState(schematic, 0, 0, 0, "minecraft:diamond_block");
  setBlockState(schematic, 0, 1, 0, "minecraft:torch");

  writeExportCells(schematic, cells);

  const rawBytes = schematic.to_litematic?.();
  if (!rawBytes) {
    throw new Error("Nucleation SchematicWrapper is missing to_litematic().");
  }

  return {
    bytes: rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes),
    option,
  };
}

async function loadNucleationModule(): Promise<NucleationModule> {
  if (!nucleationModulePromise) {
    nucleationModulePromise = loadNucleationModuleInternal().catch((error) => {
      nucleationModulePromise = null;
      throw error;
    });
  }
  return nucleationModulePromise;
}

async function loadNucleationModuleInternal(): Promise<NucleationModule> {
  if (typeof window === "undefined") {
    throw new Error("Litematic export is only available in the browser.");
  }

  const candidatePaths = [
    withBasePath("/nucleation/pkg/nucleation.js"),
    "/nucleation/pkg/nucleation.js",
  ];

  let lastError: unknown = null;

  for (const candidatePath of candidatePaths) {
    const moduleUrl = new URL(candidatePath, window.location.origin).toString();
    try {
      const loadedModule = (await import(/* webpackIgnore: true */ moduleUrl)) as NucleationModule;
      await loadedModule.default();
      return loadedModule;
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
  throw new Error(
    `Could not load Nucleation WASM module (${detail}). Build Nucleation and copy the generated pkg directory to public/nucleation/pkg.`,
  );
}

function resolveExportOption(mode: LayoutExportMode): LayoutExportOption {
  const option = LITEMATIC_EXPORT_OPTIONS.find((entry) => entry.mode === mode);
  if (!option) {
    throw new Error(`Unsupported export mode: ${mode}`);
  }
  return option;
}

function isFilterExportMode(mode: LayoutExportMode): boolean {
  return mode === "ssi_ss2_filters" || mode === "ss3_filters";
}

function nonMisRowStride(mode: LayoutExportMode): number {
  return isFilterExportMode(mode) ? FILTER_ROW_STRIDE : 1;
}

function nonMisSideDepth(rows: number, mode: LayoutExportMode): number {
  return rows <= 0 ? 0 : (rows - 1) * nonMisRowStride(mode) + 1;
}

function misSignalStrengthKey(hallId: HallId, slice: number, side: 0 | 1, row: number): string {
  return `${hallId}:${slice}:${side}:${row}`;
}

function maxStackSizeForItem(itemById: Map<string, CatalogItem>, itemId: string): number {
  return clamp(Math.floor(itemById.get(itemId)?.maxStackSize ?? 64), 1, 64);
}

function fillMisContainerDummyItems(
  items: MisContainerItem[],
  slotsPerSlice: number,
  signalStrength: number,
  itemById: Map<string, CatalogItem>,
): MisContainerItem[] {
  const containerSlots = slotsPerSlice <= 27 ? 27 : 54;
  const itemsBySlot = new Map<number, MisContainerItem>();
  for (const item of items) {
    if (item.slot >= 0 && item.slot < containerSlots) {
      itemsBySlot.set(item.slot, { ...item });
    }
  }

  const requiredDummyItems = calculateMisComparatorPrimer(
    slotsPerSlice,
    signalStrength,
    Array.from(itemsBySlot.values()).map((item) => ({
      maxStackSize: maxStackSizeForItem(itemById, item.itemId),
      count: item.count,
    })),
  ).itemCount;
  if (requiredDummyItems <= 0) {
    return Array.from(itemsBySlot.values()).sort((a, b) => a.slot - b.slot);
  }

  const candidates: MisDummyCandidate[] = [];
  for (let slot = containerSlots - 1; slot >= 0; slot -= 1) {
    const existingItem = itemsBySlot.get(slot);
    if (!existingItem) {
      candidates.push({
        slot,
        itemId: "minecraft:barrier",
        maxAddCount: 64,
        equivalentItemsPerCount: 1,
        kind: "empty",
      });
      continue;
    }

    const maxStackSize = maxStackSizeForItem(itemById, existingItem.itemId);
    const availableItems = maxStackSize - existingItem.count;
    if (availableItems <= 0) {
      continue;
    }

    const equivalentItemsPerCount = Math.round(64 / maxStackSize);
    if (equivalentItemsPerCount <= 0) {
      continue;
    }

    candidates.push({
      slot,
      itemId: existingItem.itemId,
      maxAddCount: availableItems,
      equivalentItemsPerCount,
      kind: "assigned",
    });
  }

  candidates.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "empty" ? -1 : 1;
    }
    return b.slot - a.slot;
  });

  const suffixPossible: boolean[][] = Array.from({ length: candidates.length + 1 }, () =>
    Array.from({ length: requiredDummyItems + 1 }, () => false),
  );
  suffixPossible[candidates.length][0] = true;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const nextPossible = suffixPossible[index + 1];
    const currentPossible = suffixPossible[index];
    for (let subtotal = 0; subtotal <= requiredDummyItems; subtotal += 1) {
      if (!nextPossible[subtotal]) {
        continue;
      }
      for (let count = 0; count <= candidate.maxAddCount; count += 1) {
        const nextSubtotal = subtotal + count * candidate.equivalentItemsPerCount;
        if (nextSubtotal > requiredDummyItems) {
          break;
        }
        currentPossible[nextSubtotal] = true;
      }
    }
  }

  let remainingDummyItems = requiredDummyItems;
  while (remainingDummyItems > 0 && !suffixPossible[0][remainingDummyItems]) {
    remainingDummyItems -= 1;
  }

  for (let index = 0; index < candidates.length && remainingDummyItems > 0; index += 1) {
    const candidate = candidates[index];
    const nextPossible = suffixPossible[index + 1];
    let selectedCount = 0;
    for (let count = Math.min(
      candidate.maxAddCount,
      Math.floor(remainingDummyItems / candidate.equivalentItemsPerCount),
    ); count >= 0; count -= 1) {
      const nextRemaining = remainingDummyItems - count * candidate.equivalentItemsPerCount;
      if (nextPossible[nextRemaining]) {
        selectedCount = count;
        remainingDummyItems = nextRemaining;
        break;
      }
    }

    if (selectedCount <= 0) {
      continue;
    }

    const existingItem = itemsBySlot.get(candidate.slot);
    itemsBySlot.set(candidate.slot, {
      slot: candidate.slot,
      itemId: candidate.itemId,
      count: (existingItem?.count ?? 0) + selectedCount,
    });
  }

  return Array.from(itemsBySlot.values()).sort((a, b) => a.slot - b.slot);
}

function applyMetadata(
  schematic: NucleationSchematicWrapper,
  layoutName: string,
  option: LayoutExportOption,
): void {
  const now = Date.now();
  const resolvedName = layoutName.trim().length > 0 ? layoutName.trim() : "Untitled Layout";
  schematic.setName?.(resolvedName);
  schematic.setAuthor?.("Storage Catalog");
  schematic.setDescription?.(option.description);
  schematic.setCreated?.(now);
  schematic.setModified?.(now);
}

function writeExportCells(
  schematic: NucleationSchematicWrapper,
  cells: ExportCell[],
): void {
  for (const cell of cells) {
    if (cell.type === "container") {
      addContainerBlockWithItems(
        schematic,
        cell.blockState,
        cell.x,
        0,
        cell.z,
        cell.items.map((item) => ({
          id: item.itemId,
          slot: item.slot,
          count: item.count,
        })),
      );
      continue;
    }
    if (cell.type === "item_frame") {
      placeItemFrameSlot(schematic, cell.x, 0, cell.z, cell.itemId);
      continue;
    }
    if (cell.type === "block") {
      setBlockState(schematic, cell.x, 0, cell.z, cell.blockState);
    }
  }
}

function placeItemFrameSlot(
  schematic: NucleationSchematicWrapper,
  x: number,
  y: number,
  z: number,
  itemId: string,
): void {
  if (!schematic.addItemFrameEntity) {
    throw new Error("Nucleation module is missing addItemFrameEntity(). Rebuild your WASM package.");
  }
  setBlockState(schematic, x, y, z, "minecraft:light_gray_stained_glass");
  schematic.addItemFrameEntity(toMinecraftId(itemId), x, y + 1, z, 1, 0, true);
}

function setBlockState(
  schematic: NucleationSchematicWrapper,
  x: number,
  y: number,
  z: number,
  blockState: string,
): void {
  if (typeof schematic.set_block_from_string === "function") {
    schematic.set_block_from_string(x, y, z, blockState);
    return;
  }
  if (typeof schematic.set_block === "function") {
    schematic.set_block(x, y, z, blockState);
    return;
  }
  throw new Error("Nucleation SchematicWrapper is missing block placement APIs.");
}

function addContainerBlockWithItems(
  schematic: NucleationSchematicWrapper,
  blockState: string,
  x: number,
  y: number,
  z: number,
  items: ContainerItem[],
): void {
  setBlockState(schematic, x, y, z, blockState);

  if (typeof schematic.addBlockEntity !== "function") {
    throw new Error("Nucleation module is missing addBlockEntity(). Rebuild your WASM package.");
  }

  schematic.addBlockEntity(blockStateToBlockId(blockState), x, y, z, {
    Items: items.map((item) => ({
      id: toMinecraftId(item.id),
      Count: item.count,
      Slot: item.slot,
    })),
  });
}

function toMinecraftId(itemId: string): string {
  return itemId.includes(":") ? itemId : `minecraft:${itemId}`;
}

function blockStateToBlockId(blockState: string): string {
  const trimmed = blockState.trim();
  const stateStart = trimmed.indexOf("[");
  const nbtStart = trimmed.indexOf("{");
  const end = [stateStart, nbtStart]
    .filter((value) => value >= 0)
    .reduce((min, value) => Math.min(min, value), trimmed.length);
  const baseId = trimmed.slice(0, end).trim();
  return toMinecraftId(baseId);
}

export type ExportCellBase = {
  type: "block" | "item_frame" | "container";
  x: number;
  z: number;
};

export type BlockExportCell = ExportCellBase & {
  type: "block";
  blockState: string;
};

export type ItemFrameExportCell = ExportCellBase & {
  type: "item_frame";
  itemId: string;
};

export type ContainerExportCell = ExportCellBase & {
  type: "container";
  items: { slot: number; itemId: string; count: number }[];
  blockState: string;
};

export type ExportCell = BlockExportCell | ItemFrameExportCell | ContainerExportCell;

export function buildExportCellsForLayout(
  slotAssignments: Record<string, string>,
  itemById: Map<string, CatalogItem>,
  hallConfigs: Record<HallId, HallConfig>,
  mode: LayoutExportMode = "containers",
  viewMode: LayoutViewMode = "storage",
  misSignalStrengths: Record<string, number> = {},
  misMultiplicities: Record<string, number> = {},
): ExportCell[] {
  if (viewMode === "flat") {
    return buildExportCellsForFlatLayout(slotAssignments, itemById, hallConfigs, mode, misSignalStrengths, misMultiplicities);
  }

  const output: ExportCell[] = [];

  // first, measure each hall
  const hallDimensions = Object.fromEntries(
    Object.entries(hallConfigs).map(([hallId, config]) => [
      hallId,
      measureHallDimensions(config, mode),
    ] as const),
  );

  // calculate overall size for each direction
  let northSize = -2;
  let southSize = -2;
  let westSize = -2;
  let eastSize = -2;

  for (const [hallId, config] of Object.entries(hallConfigs)) {
    const dimensions = hallDimensions[hallId];
    const direction = config.direction;
    switch (direction) {
      case "north":
        northSize += dimensions.totalSize + 2; // add spacing between halls
        break;
      case "south":
        southSize += dimensions.totalSize + 2;
        break;
      case "west":
        westSize += dimensions.totalSize + 2;
        break;
      case "east":
        eastSize += dimensions.totalSize + 2;
        break;
    }
  }

  // Calculate max size for vertical and horizontal
  const maxHorizontalSize = Math.max(northSize, southSize); // remove spacing after last hall
  const maxVerticalSize = Math.max(westSize, eastSize);

  const halfVertical = Math.floor(maxVerticalSize / 2);
  const halfHorizontal = Math.floor(maxHorizontalSize / 2);

  // Calculate starting coordinates for each hall based on its direction and the max sizes
  const hallCoordinates: Record<HallId, { x: number; z: number }> = {};

  // first start with horizontal halls
  const westHallsDimensions = Object.entries(hallConfigs).filter(([_, config]) => config.direction === "west")
    .map(([hallId]) => [parseInt(hallId), hallDimensions[hallId]] as const);
  const eastHallsDimensions = Object.entries(hallConfigs)
    .filter(([_, config]) => config.direction === "east")
    .map(([hallId]) => [parseInt(hallId), hallDimensions[hallId]] as const);

  // top is north here
  const topOffset = Math.max(westHallsDimensions[0]?.[1].rightSize ?? 0, eastHallsDimensions[0]?.[1].leftSize ?? 0);

  // bottom is south here
  const bottomOffset = Math.max(westHallsDimensions[westHallsDimensions.length - 1]?.[1].leftSize ?? 0, eastHallsDimensions[eastHallsDimensions.length - 1]?.[1].rightSize ?? 0);

  // west halls
  // we assume there will be only at most 2 halls per direction.

  // in the game, east is positive, and south is positive.
  for (let i = 0; i < westHallsDimensions.length; i++) {
    const [hallId] = westHallsDimensions[i];

    const isNorth = i === 0;
    hallCoordinates[hallId] = {
      x: halfHorizontal - maxHorizontalSize, // start from the left edge
      z: isNorth ? (halfVertical - maxVerticalSize + topOffset + 1) : (halfVertical + bottomOffset + 1), // start from the top edge
    };
  }

  // east halls
  for (let i = 0; i < eastHallsDimensions.length; i++) {
    const [hallId] = eastHallsDimensions[i];
    const isNorth = i === 0;
    hallCoordinates[hallId] = {
      x: halfHorizontal + 1, // start from the right edge
      z: isNorth ? (halfVertical - maxVerticalSize + topOffset + 1) : (halfVertical + bottomOffset + 1), // start from the top edge
    };
  }

  // vertical halls
  const northHallsDimensions = Object.entries(hallConfigs)
    .filter(([_, config]) => config.direction === "north")
    .map(([hallId]) => [parseInt(hallId), hallDimensions[hallId]] as const);
  const southHallsDimensions = Object.entries(hallConfigs)
    .filter(([_, config]) => config.direction === "south")
    .map(([hallId]) => [parseInt(hallId), hallDimensions[hallId]] as const);

  // left is west here
  const leftOffset = Math.max(northHallsDimensions[0]?.[1].leftSize ?? 0, southHallsDimensions[0]?.[1].rightSize ?? 0);
  const rightOffset = Math.max(northHallsDimensions[northHallsDimensions.length - 1]?.[1].rightSize ?? 0, southHallsDimensions[southHallsDimensions.length - 1]?.[1].leftSize ?? 0);


  // north halls
  for (let i = 0; i < northHallsDimensions.length; i++) {
    const [hallId] = northHallsDimensions[i];
    const isWest = i === 0;
    hallCoordinates[hallId] = {
      x: isWest ? (halfHorizontal - maxHorizontalSize + leftOffset + 1) : (halfHorizontal + rightOffset + 1), // start from the left edge
      z: halfVertical - maxVerticalSize, // start from the top edge
    };
  }

  // south halls
  for (let i = 0; i < southHallsDimensions.length; i++) {
    const [hallId] = southHallsDimensions[i];
    const isWest = i === 0;
    hallCoordinates[hallId] = {
      x: isWest ? (halfHorizontal - maxHorizontalSize + leftOffset + 1) : (halfHorizontal + rightOffset + 1), // start from the left edge
      z: halfVertical + 1, // start from the bottom edge
    };
  }

  // log coordinates
  console.log(`Horizontal size: ${maxHorizontalSize}, Vertical size: ${maxVerticalSize}`);
  console.log(`Half Horizontal: ${halfHorizontal}, Half Vertical: ${halfVertical}`);
  console.log(`Top Offset: ${topOffset}, Bottom Offset: ${bottomOffset}, Left Offset: ${leftOffset}, Right Offset: ${rightOffset}`);
  console.log("Hall Coordinates:");
  for (const [hallId, coord] of Object.entries(hallCoordinates)) {
    const name = hallConfigs[parseInt(hallId)].name;
    console.log(`Hall ${hallId} (${name}): x=${coord.x}, z=${coord.z}`);
  }

  // now we have coordinates for each hall, we can place cells relative to those coordinates
  for (const [hallIdRaw, config] of Object.entries(hallConfigs)) {
    const hallId = Number(hallIdRaw);
    const hallCoord = hallCoordinates[hallId];
    if (!hallCoord) {
      continue;
    }
    const hallCells = buildExportCellsForLayoutHall(
      slotAssignments,
      itemById,
      config,
      hallId,
      mode,
      misSignalStrengths,
      misMultiplicities,
    );
    // first, rotate cells based on hall direction, then translate to hall coordinates
    const rotatedAndTranslated = hallCells.map((cell) => {
      let rotatedX = cell.x;
      let rotatedZ = cell.z;
      switch (config.direction) {
        case "north":
          // -90 deg from east
          rotatedX = cell.z;
          rotatedZ = -cell.x;
          break;
        case "south":
          // +90 deg from east
          rotatedX = -cell.z;
          rotatedZ = cell.x;
          break;
        case "west":
          // 180 deg from east
          rotatedX = -cell.x;
          rotatedZ = -cell.z;
          break;
        case "east":
          // no rotation
          break;
      }
      return {
        ...cell,
        x: hallCoord.x + rotatedX,
        z: hallCoord.z + rotatedZ,
      };
    });

    // rotate chests as well
    const rotateDirection = (facing: string, angle: number): string => {
      const directions = ["north", "east", "south", "west"];
      const index = directions.indexOf(facing);
      if (index === -1) {
        return facing; // unknown direction, return as is
      }
      const steps = Math.round(angle / 90) % 4;
      const newIndex = (index + steps + 4) % 4;
      return directions[newIndex];
    };

    rotatedAndTranslated.forEach((cell) => {
      if (cell.type === "container") {
        // parse block state
        const blockStateParsed = cell.blockState.match(/^minecraft:(\w+)(\[.*\])?$/);
        if (blockStateParsed) {
          const [, blockType, blockStateProps] = blockStateParsed;
          let facing = blockStateProps?.match(/facing=(\w+)/)?.[1];
          if (facing) {
            switch (config.direction) {
              case "north":
                facing = rotateDirection(facing, -90);
                break;
              case "south":
                facing = rotateDirection(facing, 90);
                break;
              case "west":
                facing = rotateDirection(facing, 180);
                break;
              case "east":
                // no rotation
                break;
            }
            const newBlockStateProps = blockStateProps
              ? blockStateProps.replace(/facing=\w+/, `facing=${facing}`)
              : `[facing=${facing}]`;
            cell.blockState = `minecraft:${blockType}${newBlockStateProps}`;
          }
        }
      }
    });
    output.push(...rotatedAndTranslated);
  }

  return output;
}

function buildExportCellsForFlatLayout(
  slotAssignments: Record<string, string>,
  itemById: Map<string, CatalogItem>,
  hallConfigs: Record<HallId, HallConfig>,
  mode: LayoutExportMode,
  misSignalStrengths: Record<string, number>,
  misMultiplicities: Record<string, number>,
): ExportCell[] {
  const output: ExportCell[] = [];
  const hallIds = Object.keys(hallConfigs)
    .map((key) => Number(key))
    .sort((a, b) => a - b);

  const HALL_GAP = 2;
  let cursorZ = 0;

  for (const hallId of hallIds) {
    const config = hallConfigs[hallId];
    if (!config) {
      continue;
    }

    const hallCells = buildExportCellsForLayoutHall(
      slotAssignments,
      itemById,
      config,
      hallId,
      mode,
      misSignalStrengths,
      misMultiplicities,
    );
    if (hallCells.length === 0) {
      continue;
    }

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const cell of hallCells) {
      minX = Math.min(minX, cell.x);
      maxX = Math.max(maxX, cell.x);
      minZ = Math.min(minZ, cell.z);
      maxZ = Math.max(maxZ, cell.z);
    }

    const offsetX = -minX;
    const offsetZ = cursorZ - minZ;
    for (const cell of hallCells) {
      output.push({
        ...cell,
        x: cell.x + offsetX,
        z: cell.z + offsetZ,
      });
    }

    const hallHeight = maxZ - minZ + 1;
    cursorZ += hallHeight + HALL_GAP;
  }

  return output;
}

export function measureHallDimensions(hallConfig: HallConfig, mode: LayoutExportMode = "containers"): { leftSize: number; rightSize: number, totalSize: number, totalSlices: number } {
  let leftSize = 0;
  let rightSize = 0;
  let totalSlices = 0;
  for (const section of hallConfig.sections) {
    if (section.sideLeft.type === "mis") {
      const widthRemainder = section.slices % section.sideLeft.misWidth;
      leftSize = Math.max(leftSize, section.sideLeft.rowsPerSlice * (widthRemainder < 2 ? 2 : 1));
    } else {
      leftSize = Math.max(leftSize, nonMisSideDepth(section.sideLeft.rowsPerSlice, mode));
    }
    if (section.sideRight.type === "mis") {
      const widthRemainder = section.slices % section.sideRight.misWidth;
      rightSize = Math.max(rightSize, section.sideRight.rowsPerSlice * (widthRemainder < 2 ? 2 : 1));
    } else {
      rightSize = Math.max(rightSize, nonMisSideDepth(section.sideRight.rowsPerSlice, mode));
    }


    totalSlices += section.slices + 1; // add 1 for spacing between sections
  }

  totalSlices -= 1; // remove spacing after last section

  return {
    leftSize,
    rightSize,
    totalSize: leftSize + rightSize + 1, // add 1 for aisle
    totalSlices,
  }
}

export function buildExportCellsForLayoutHall(
  slotAssignments: Record<string, string>,
  itemById: Map<string, CatalogItem>,
  config: HallConfig,
  hallId: HallId,
  mode: LayoutExportMode = "containers",
  misSignalStrengths: Record<string, number> = {},
  misMultiplicities: Record<string, number> = {},
): ExportCell[] {
  const output: ExportCell[] = [];

  // we assume we are going to the EAST (positive X)
  // 
  // 0,0 is the middle-left side of the hall, where the aisle is

  let sectionStartX = 0;
  let globalSliceStart = 0;
  for (let sectionIndex = 0; sectionIndex < config.sections.length; sectionIndex++) {
    const section = config.sections[sectionIndex];
    const sliceCount = section.slices;

    const sideLeft = section.sideLeft;
    const sideRight = section.sideRight;

    applySideToExportCells(
      output,
      slotAssignments,
      itemById,
      hallId,
      sideLeft,
      sectionStartX,
      globalSliceStart,
      sliceCount,
      "left",
      mode,
      misSignalStrengths,
      misMultiplicities,
    );

    applySideToExportCells(
      output,
      slotAssignments,
      itemById,
      hallId,
      sideRight,
      sectionStartX,
      globalSliceStart,
      sliceCount,
      "right",
      mode,
      misSignalStrengths,
      misMultiplicities,
    );

    sectionStartX += sliceCount + 1; // add 1 block of spacing between sections
    globalSliceStart += sliceCount;
  }
  return output;
}

export function applySideToExportCells(
  output: ExportCell[],
  slotAssignments: Record<string, string>,
  itemById: Map<string, CatalogItem>,
  hallId: HallId,
  sideConfig: HallSideConfig,
  sectionStartX: number,
  globalSliceStart: number,
  numSlices: number,
  side: "left" | "right",
  mode: LayoutExportMode = "containers",
  misSignalStrengths: Record<string, number> = {},
  misMultiplicities: Record<string, number> = {},
): void {
  const rows = sideConfig.rowsPerSlice;
  if (sideConfig.type === "mis") {
    const slotsPerSlice = sideConfig.misSlotsPerSlice;
    const misWidth = sideConfig.misWidth;

    // divide up slices by mis width
    const sliceGroups = Math.ceil(numSlices / misWidth);
    for (let misGroup = 0; misGroup < sliceGroups; misGroup++) {
      const groupStartSlice = misGroup * misWidth;
      const groupEndSlice = Math.min(groupStartSlice + misWidth, numSlices);
      const canDoubleChestFit = groupEndSlice - groupStartSlice >= 2;
      const misSlice = globalSliceStart + groupStartSlice;
      for (let row = 0; row < rows; row++) {

        let items: MisContainerItem[] = [];
        const configKey = misSignalStrengthKey(hallId, misSlice, side === "left" ? 0 : 1, row);
        const multiplicity = misMultiplicities[configKey] ?? DEFAULT_MIS_MULTIPLICITY;
        for (let slot = 0; slot < slotsPerSlice; slot++) {
          const key = misSlotId(hallId, misSlice, side === "left" ? 0 : 1, row, slot);
          const itemId = slotAssignments[key];
          if (itemId) {
            const count = clamp(multiplicity, 1, maxStackSizeForItem(itemById, itemId));
            items.push({ slot, itemId, count });
          }
        }

        if (items.length === 0) {
          continue;
        }

        if (isFilterExportMode(mode)) {
          const signalStrength =
            misSignalStrengths[configKey] ??
            DEFAULT_MIS_SIGNAL_STRENGTH;
          items = fillMisContainerDummyItems(items, slotsPerSlice, signalStrength, itemById);
        }

        const posX = sectionStartX + groupStartSlice;
        // north is negative Z
        const rowSize = canDoubleChestFit ? 1 : 2;
        const posZ = side === "left" ? ((row - rows + 1) * rowSize - 1) : (row * rowSize + 1);

        if (slotsPerSlice <= 27) {
          output.push({
            type: "container",
            x: posX,
            z: posZ,
            blockState: `minecraft:chest[facing=${side === "left" ? "south" : "north"},type=single,waterlogged=false]`,
            items,
          });
        } else {
          // double chest
          const firstItems = items.filter(item => item.slot < 27).map(item => ({ ...item }));
          const secondItems = items.filter(item => item.slot >= 27).map(item => ({ ...item, slot: item.slot - 27 }));

          // first items is in right block

          if (canDoubleChestFit) {
            // place double chest facing the right way
            output.push({
              type: "container",
              x: posX,
              z: posZ,
              blockState: `minecraft:chest[facing=${side === "left" ? "south" : "north"},type=${side === "left" ? "right" : "left"},waterlogged=false]`,
              items: side === "left" ? firstItems : secondItems,
            });
            output.push({
              type: "container",
              x: posX + 1,
              z: posZ,
              blockState: `minecraft:chest[facing=${side === "left" ? "south" : "north"},type=${side === "left" ? "left" : "right"},waterlogged=false]`,
              items: side === "left" ? secondItems : firstItems,
            });
          } else {
            // place facing west
            const offset = side === "left" ? -1 : 0;
            output.push({
              type: "container",
              x: posX,
              z: posZ + offset,
              blockState: `minecraft:chest[facing=west,type=right,waterlogged=false]`,
              items: firstItems,
            });
            output.push({
              type: "container",
              x: posX,
              z: posZ + 1 + offset,
              blockState: `minecraft:chest[facing=west,type=left,waterlogged=false]`,
              items: secondItems,
            });
          }
        }
      }
    }


  } else if (sideConfig.type === "bulk" || sideConfig.type === "chest") {
    const rowStride = nonMisRowStride(mode);
    for (let slice = 0; slice < numSlices; slice++) {
      const globalSlice = globalSliceStart + slice;
      for (let row = 0; row < rows; row++) {
        const posX = sectionStartX + slice;
        const posZ = side === "left" ? -((rows - row - 1) * rowStride + 1) : (row * rowStride + 1);
        const key = nonMisSlotId(hallId, globalSlice, side === "left" ? 0 : 1, row);
        const itemId = slotAssignments[key];
        if (!itemId) {
          continue;
        }

        if (mode === "containers") {
          if (sideConfig.type === "chest") {
            output.push({
              type: "container",
              x: posX,
              z: posZ,
              blockState: `minecraft:chest[facing=${side === "left" ? "south" : "north"},type=single,waterlogged=false]`,
              items: [{ slot: 0, itemId, count: 1 }],
            });
          } else {
            output.push({
              type: "container",
              x: posX,
              z: posZ,
              blockState: `minecraft:barrel[facing=up]`,
              items: [{ slot: 0, itemId, count: 1 }],
            });
          }
        } else if (mode === "item_frames") {
          output.push({
            type: "item_frame",
            x: posX,
            z: posZ,
            itemId,
          });
        } else if (mode === "blocks_and_frames") {
          const catalogItem = itemById.get(itemId);
          if (catalogItem?.registration === "block") {
            output.push({
              type: "block",
              x: posX,
              z: posZ,
              blockState: toMinecraftId(itemId),
            });
          } else {
            output.push({
              type: "item_frame",
              x: posX,
              z: posZ,
              itemId,
            });
          }
        } else if (mode === "boxes") {
          const catalogItem = itemById.get(itemId);
          output.push({
            type: "container",
            x: posX,
            z: posZ,
            blockState: `minecraft:shulker_box[facing=up]`,
            items: Array.from({ length: 27 }, (_, slot) => ({ slot, itemId, count: catalogItem?.maxStackSize || 64 })),
          });
        } else if (mode === "ssi_ss2_filters" || mode === "ss3_filters") {
          const catalogItem = itemById.get(itemId);

          const dummyItemId = "minecraft:barrier"; // use barrier as a placeholder for empty slots in the filter

          const is16Stackable = catalogItem?.maxStackSize === 16;
          const items = Array.from({ length: 5 }, (_, slot) => {
            if (slot === 0) {
              if (mode === "ssi_ss2_filters") {
                return { slot, itemId, count: 1 };
              } else {
                return { slot, itemId, count: is16Stackable ? 10 : 41 };
              }
            }

            if (slot === 1 && mode === "ssi_ss2_filters") {
              return { slot, itemId: dummyItemId, count: is16Stackable ? 12 : 18 };
            }

            return { slot, itemId: dummyItemId, count: 1 };
          });


          output.push({
            type: "container",
            x: posX,
            z: posZ,
            blockState: `minecraft:hopper[facing=${side === "left" ? "south" : "north"}]`,
            items,
          });

        } else {
          throw new Error("Unknown export mode");
        }
      }
    }
  }

}
