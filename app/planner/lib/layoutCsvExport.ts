import { getLayoutHallName, type StorageLayoutPreset } from "../layoutConfig";
import {
  misNameKey,
  sectionNameKey,
} from "./plannerSnapshot";
import type { CatalogItem, HallConfig, HallId, PlannerLabelNames } from "../types";
import { resolveHallSlices, toTitle } from "../utils";

type AssignedTo = "Bulk" | "Chest" | "MIS" | "None";

type CsvExportInput = {
  catalogItems: CatalogItem[];
  hallConfigs: Record<HallId, HallConfig>;
  slotAssignments: Record<string, string>;
  labelNames: PlannerLabelNames;
  storageLayoutPreset: StorageLayoutPreset;
};

type ParsedSlotId =
  | {
    kind: "standard";
    hallId: HallId;
    slice: number;
    side: 0 | 1;
    row: number;
  }
  | {
    kind: "mis";
    hallId: HallId;
    slice: number;
    side: 0 | 1;
    row: number;
    index: number;
  };

type ItemLocation = {
  assignedTo: AssignedTo;
  hallName: string;
  sectionName: string;
  sideName: string;
  sliceNumber: string;
  rowNumber: string;
  misNumber: string;
  misSlotNumber: string;
  positionSortKey: number[];
};

type CsvRow = {
  itemName: string;
  id: string;
  maxStackSize: number;
  hasBlock: string;
  creativeTabs: string;
  location: ItemLocation;
};

const CSV_HEADERS = [
  "Item Name",
  "ID",
  "Max Stack Size",
  "Has Block",
  "Creative Tabs",
  "Assigned To",
  "Hall",
  "Section",
  "Side",
  "Slice",
  "Row",
  "MIS Number",
  "MIS Slot",
] as const;

const ASSIGNED_SORT_ORDER: Record<AssignedTo, number> = {
  Bulk: 0,
  Chest: 1,
  MIS: 2,
  None: 3,
};

const EMPTY_LOCATION: ItemLocation = {
  assignedTo: "None",
  hallName: "",
  sectionName: "",
  sideName: "",
  sliceNumber: "",
  rowNumber: "",
  misNumber: "",
  misSlotNumber: "",
  positionSortKey: [Number.POSITIVE_INFINITY],
};

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSide(value: string): 0 | 1 | null {
  const parsed = parseInteger(value);
  return parsed === 0 || parsed === 1 ? parsed : null;
}

function parseSlotId(slotId: string): ParsedSlotId | null {
  const parts = slotId.split(":");
  const hallId = parseInteger(parts[0] ?? "");
  if (hallId === null) {
    return null;
  }

  if (parts.length === 5 && parts[1] === "g") {
    const slice = parseInteger(parts[2]);
    const side = parseSide(parts[3]);
    const row = parseInteger(parts[4]);
    if (slice === null || side === null || row === null) {
      return null;
    }
    return { kind: "standard", hallId, slice, side, row };
  }

  if (parts.length === 6 && parts[1] === "m") {
    const slice = parseInteger(parts[2]);
    const side = parseSide(parts[3]);
    const row = parseInteger(parts[4]);
    const index = parseInteger(parts[5]);
    if (slice === null || side === null || row === null || index === null) {
      return null;
    }
    return { kind: "mis", hallId, slice, side, row, index };
  }

  return null;
}

function assignedToLabel(type: HallConfig["sections"][number]["sideLeft"]["type"]): AssignedTo {
  switch (type) {
    case "bulk":
      return "Bulk";
    case "chest":
      return "Chest";
    case "mis":
      return "MIS";
  }
}

function formatHallName(
  hallId: HallId,
  hallConfig: HallConfig,
  labelNames: PlannerLabelNames,
  storageLayoutPreset: StorageLayoutPreset,
): string {
  return (
    labelNames.hallNames[hallId] ??
    hallConfig.name ??
    getLayoutHallName(storageLayoutPreset, hallId) ??
    `Hall ${hallId}`
  );
}

function formatSectionName(
  hallId: HallId,
  sectionIndex: number,
  labelNames: PlannerLabelNames,
): string {
  return labelNames.sectionNames[sectionNameKey(hallId, sectionIndex)] ?? `Section ${sectionIndex + 1}`;
}

function resolveSlotLocation(
  slotId: string,
  hallConfigs: Record<HallId, HallConfig>,
  labelNames: PlannerLabelNames,
  storageLayoutPreset: StorageLayoutPreset,
): ItemLocation | null {
  const parsed = parseSlotId(slotId);
  if (!parsed) {
    return null;
  }

  const hallConfig = hallConfigs[parsed.hallId];
  if (!hallConfig) {
    return null;
  }

  const slice = resolveHallSlices(hallConfig).find(
    (entry) => entry.globalSlice === parsed.slice,
  );
  if (!slice) {
    return null;
  }

  const sideConfig = parsed.side === 0 ? slice.sideLeft : slice.sideRight;
  const hallName = formatHallName(parsed.hallId, hallConfig, labelNames, storageLayoutPreset);
  const sectionName = formatSectionName(parsed.hallId, slice.sectionIndex, labelNames);
  const baseLocation = {
    assignedTo: assignedToLabel(sideConfig.type),
    hallName,
    sectionName,
    sideName: parsed.side === 0 ? "Left" : "Right",
    sliceNumber: String(slice.sectionSlice + 1),
    rowNumber: String(parsed.row + 1),
  };
  const positionSortKey = [
    parsed.hallId,
    slice.sectionIndex,
    parsed.side,
    parsed.row,
    slice.sectionSlice,
    parsed.kind === "mis" ? parsed.index : -1,
  ];

  if (parsed.kind === "mis") {
    const misWidth = Math.max(1, sideConfig.misWidth);
    const misNumber = Math.floor(slice.sectionSlice / misWidth) + 1;
    return {
      ...baseLocation,
      misNumber:
        labelNames.misNames[misNameKey(parsed.hallId, parsed.slice, parsed.side, parsed.row)] ??
        `MIS ${misNumber}`,
      misSlotNumber: String(parsed.index + 1),
      positionSortKey,
    };
  }

  return {
    ...baseLocation,
    misNumber: "",
    misSlotNumber: "",
    positionSortKey,
  };
}

function csvEscape(value: string | number): string {
  const raw = String(value);
  if (!/[",\r\n]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

function compareNumberArrays(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const aValue = a[index] ?? 0;
    const bValue = b[index] ?? 0;
    if (aValue !== bValue) {
      return aValue - bValue;
    }
  }
  return 0;
}

function buildItemLocations(input: CsvExportInput): Map<string, ItemLocation> {
  const locations = new Map<string, ItemLocation>();
  const entries = Object.entries(input.slotAssignments).sort(([slotA], [slotB]) =>
    slotA.localeCompare(slotB),
  );

  for (const [slotId, itemId] of entries) {
    if (locations.has(itemId)) {
      continue;
    }
    const location = resolveSlotLocation(
      slotId,
      input.hallConfigs,
      input.labelNames,
      input.storageLayoutPreset,
    );
    if (location) {
      locations.set(itemId, location);
    }
  }

  return locations;
}

export function exportLayoutAsCsv(input: CsvExportInput): string {
  const locations = buildItemLocations(input);
  const rows: CsvRow[] = input.catalogItems.map((item) => ({
    itemName: toTitle(item.id),
    id: item.id,
    maxStackSize: item.maxStackSize,
    hasBlock: item.registration === "block" ? "Yes" : "No",
    creativeTabs: item.creativeTabs.join("; "),
    location: locations.get(item.id) ?? EMPTY_LOCATION,
  }));

  rows.sort((a, b) => {
    const assignedComparison =
      ASSIGNED_SORT_ORDER[a.location.assignedTo] - ASSIGNED_SORT_ORDER[b.location.assignedTo];
    if (assignedComparison !== 0) {
      return assignedComparison;
    }
    const positionComparison = compareNumberArrays(
      a.location.positionSortKey,
      b.location.positionSortKey,
    );
    if (positionComparison !== 0) {
      return positionComparison;
    }
    return a.itemName.localeCompare(b.itemName, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });

  const csvRows = rows.map((row) =>
    [
      row.itemName,
      row.id,
      row.maxStackSize,
      row.hasBlock,
      row.creativeTabs,
      row.location.assignedTo,
      row.location.hallName,
      row.location.sectionName,
      row.location.sideName,
      row.location.sliceNumber,
      row.location.rowNumber,
      row.location.misNumber,
      row.location.misSlotNumber,
    ]
      .map(csvEscape)
      .join(","),
  );

  return `${CSV_HEADERS.join(",")}\r\n${csvRows.join("\r\n")}\r\n`;
}
