import type {
  CatalogItem,
  DragPayload,
  HallId,
  IncomingEntry,
  PreviewPlacement,
} from "../types";
import { retainValidAssignments } from "./layoutAssignments";

type PlacementContext = {
  orderedSlotIds: string[];
  orderedSlotIdSet: Set<string>;
  itemById: Map<string, CatalogItem>;
};

type BuildPlacementsInput = {
  anchorSlotId: string;
  payload: DragPayload;
  assignments: Record<string, string>;
  context: PlacementContext;
  preferFirstEmptyMisSlot?: boolean;
};

type BuildSwapPlacementsInput = {
  payload: DragPayload;
  incomingEntries: IncomingEntry[];
  placements: PreviewPlacement[];
  assignments: Record<string, string>;
  orderedSlotIdSet: Set<string>;
};

type ParsedGridSlot = {
  kind: "grid";
  hallId: HallId;
  slice: number;
  side: number;
  row: number;
};

type ParsedMisSlot = {
  kind: "mis";
  hallId: HallId;
  slice: number;
  side: number;
  row: number;
  index: number;
};

type ParsedSlot = ParsedGridSlot | ParsedMisSlot;

function parseHallId(raw: string): HallId | null {
  const hallId = Number(raw);
  if (Number.isFinite(hallId)) {
    return hallId;
  }
  return null;
}

function parseIntPart(raw: string): number | null {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseSlotId(slotId: string): ParsedSlot | null {
  const parts = slotId.split(":");
  const [hallRaw, kindRaw] = parts;
  const hallId = parseHallId(hallRaw);
  if (!hallId) {
    return null;
  }

  if (kindRaw === "g") {
    const a = parseIntPart(parts[2]);
    const b = parseIntPart(parts[3]);
    const c = parseIntPart(parts[4]);
    if (a === null || b === null || c === null) {
      return null;
    }
    return {
      kind: "grid",
      hallId,
      slice: a,
      side: b,
      row: c,
    };
  }

  if (kindRaw === "m") {
    const a = parseIntPart(parts[2]);
    const side = parseIntPart(parts[3]);
    const row = parseIntPart(parts[4]);
    const index = parseIntPart(parts[5]);
    if (a === null || side === null || row === null || index === null) {
      return null;
    }
    return {
      kind: "mis",
      hallId,
      slice: a,
      side,
      row,
      index,
    };
  }

  return null;
}

function projectRepresentationTargetSlotId(
  sourceSlotId: string,
  originSlotId: string,
  anchorSlotId: string,
): string | null {
  const source = parseSlotId(sourceSlotId);
  const origin = parseSlotId(originSlotId);
  const anchor = parseSlotId(anchorSlotId);

  if (!source || !origin || !anchor) {
    return null;
  }

  if (source.kind !== origin.kind || anchor.kind !== origin.kind) {
    return null;
  }

  if (origin.kind === "grid" && source.kind === "grid" && anchor.kind === "grid") {
    const targetSlice = anchor.slice + (source.slice - origin.slice);
    const targetSide = anchor.side + (source.side - origin.side);
    const targetRow = anchor.row + (source.row - origin.row);

    if (targetSide < 0 || targetSide > 1) {
      return null;
    }

    return `${anchor.hallId}:g:${targetSlice}:${targetSide}:${targetRow}`;
  }

  if (origin.kind === "mis" && source.kind === "mis" && anchor.kind === "mis") {
    const targetSlice = anchor.slice + (source.slice - origin.slice);
    const targetSide = anchor.side + (source.side - origin.side);
    const targetMisRow = anchor.row + (source.row - origin.row);
    const targetIndex = anchor.index + (source.index - origin.index);

    if (targetSide < 0 || targetSide > 1) {
      return null;
    }
    return `${anchor.hallId}:m:${targetSlice}:${targetSide}:${targetMisRow}:${targetIndex}`;
  }

  return null;
}

function findNextEmptyMisSlot(
  anchorSlotId: string,
  orderedSlotIds: string[],
  assignments: Record<string, string>,
): string {
  const parsed = parseSlotId(anchorSlotId);
  if (!parsed || parsed.kind !== "mis") {
    return anchorSlotId;
  }

  const groupSlots = orderedSlotIds.filter((slotId) => {
    const candidate = parseSlotId(slotId);
    return (
      candidate?.kind === "mis" &&
      candidate.hallId === parsed.hallId &&
      candidate.slice === parsed.slice &&
      candidate.side === parsed.side &&
      candidate.row === parsed.row
    );
  });

  const nextEmpty = groupSlots.find((slotId) => !assignments[slotId]);
  return nextEmpty ?? anchorSlotId;
}

export function getIncomingEntries(
  payload: DragPayload,
  itemById: Map<string, CatalogItem>,
): IncomingEntry[] {
  return payload.itemIds
    .map((itemId, index) => ({
      itemId,
      sourceSlotId: payload.sourceSlotIds?.[index],
    }))
    .filter((entry) => itemById.has(entry.itemId));
}

export function buildPlacements({
  anchorSlotId,
  payload,
  assignments,
  context,
  preferFirstEmptyMisSlot = true,
}: BuildPlacementsInput): PreviewPlacement[] {
  const { orderedSlotIds, orderedSlotIdSet, itemById } = context;

  const anchorIndex = orderedSlotIds.indexOf(anchorSlotId);
  if (anchorIndex === -1) {
    return [];
  }

  const incomingEntries = getIncomingEntries(payload, itemById);
  const incoming = incomingEntries.map((entry) => entry.itemId);
  if (incoming.length === 0) {
    return [];
  }

  const allowOccupiedTargets = payload.source === "layout";
  const working = retainValidAssignments(assignments, orderedSlotIdSet);
  const incomingSet = new Set(incoming);

  for (const [slotId, itemId] of Object.entries(working)) {
    if (incomingSet.has(itemId)) {
      delete working[slotId];
    }
  }

  const canTryShapePlacement =
    payload.source === "layout" &&
    payload.kind === "category" &&
    Boolean(payload.originSlotId) &&
    Array.isArray(payload.sourceSlotIds) &&
    payload.sourceSlotIds.length === payload.itemIds.length;

  if (canTryShapePlacement) {
    const originSlotId = payload.originSlotId as string;
    const shapePlacements: PreviewPlacement[] = [];
    const usedTargetSlots = new Set<string>();

    for (const entry of incomingEntries) {
      if (!entry.sourceSlotId) {
        continue;
      }

      const targetSlotId = projectRepresentationTargetSlotId(
        entry.sourceSlotId,
        originSlotId,
        anchorSlotId,
      );

      if (!targetSlotId || !orderedSlotIdSet.has(targetSlotId)) {
        continue;
      }

      if (usedTargetSlots.has(targetSlotId)) {
        continue;
      }

      if (!allowOccupiedTargets && working[targetSlotId]) {
        continue;
      }

      shapePlacements.push({
        slotId: targetSlotId,
        itemId: entry.itemId,
        kind: "place",
      });
      usedTargetSlots.add(targetSlotId);
      working[targetSlotId] = entry.itemId;
    }

    if (shapePlacements.length === incomingEntries.length) {
      return shapePlacements;
    }
  }

  if (payload.kind === "item") {
    const targetSlotId = preferFirstEmptyMisSlot
      ? findNextEmptyMisSlot(anchorSlotId, orderedSlotIds, working)
      : anchorSlotId;
    return [
      {
        slotId: targetSlotId,
        itemId: incoming[0],
        kind: "place",
      },
    ];
  }

  const previews: PreviewPlacement[] = [];
  let cursor = anchorIndex;

  for (const itemId of incoming) {
    if (!allowOccupiedTargets) {
      while (cursor < orderedSlotIds.length && working[orderedSlotIds[cursor]]) {
        cursor += 1;
      }
    }

    if (cursor >= orderedSlotIds.length) {
      break;
    }

    const slotId = orderedSlotIds[cursor];
    previews.push({ slotId, itemId, kind: "place" });
    working[slotId] = itemId;
    cursor += 1;
  }

  return previews;
}

export function buildSwapPlacements({
  payload,
  incomingEntries,
  placements,
  assignments,
  orderedSlotIdSet,
}: BuildSwapPlacementsInput): PreviewPlacement[] | null {
  if (payload.source !== "layout" || placements.length === 0) {
    return [];
  }

  const incomingSet = new Set(incomingEntries.map((entry) => entry.itemId));
  const displaced: Array<{ itemId: string; preferredSlotId?: string }> = [];

  for (const [index, placement] of placements.entries()) {
    const existingItemId = assignments[placement.slotId];
    if (existingItemId && !incomingSet.has(existingItemId)) {
      displaced.push({
        itemId: existingItemId,
        preferredSlotId: incomingEntries[index]?.sourceSlotId,
      });
    }
  }

  if (displaced.length === 0) {
    return [];
  }

  const next = retainValidAssignments(assignments, orderedSlotIdSet);
  for (const [slotId, itemId] of Object.entries(next)) {
    if (incomingSet.has(itemId)) {
      delete next[slotId];
    }
  }
  for (const placement of placements) {
    next[placement.slotId] = placement.itemId;
  }

  const targetSlots = new Set(placements.map((placement) => placement.slotId));
  const sourceSlots: string[] = [];
  const sourceSlotSet = new Set<string>();

  for (const entry of incomingEntries) {
    if (
      entry.sourceSlotId &&
      orderedSlotIdSet.has(entry.sourceSlotId) &&
      !sourceSlotSet.has(entry.sourceSlotId)
    ) {
      sourceSlots.push(entry.sourceSlotId);
      sourceSlotSet.add(entry.sourceSlotId);
    }
  }

  const candidateSwapSlots = sourceSlots.filter(
    (slotId) => !targetSlots.has(slotId) && !next[slotId],
  );

  if (candidateSwapSlots.length < displaced.length) {
    return null;
  }

  const swapPlacements: PreviewPlacement[] = [];
  const usedSwapSlots = new Set<string>();
  const remaining: string[] = [];

  for (const item of displaced) {
    const preferred = item.preferredSlotId;
    if (
      preferred &&
      candidateSwapSlots.includes(preferred) &&
      !usedSwapSlots.has(preferred)
    ) {
      swapPlacements.push({
        slotId: preferred,
        itemId: item.itemId,
        kind: "swap",
      });
      usedSwapSlots.add(preferred);
      continue;
    }

    remaining.push(item.itemId);
  }

  let cursor = 0;
  for (const itemId of remaining) {
    while (
      cursor < candidateSwapSlots.length &&
      usedSwapSlots.has(candidateSwapSlots[cursor])
    ) {
      cursor += 1;
    }

    if (cursor >= candidateSwapSlots.length) {
      return null;
    }

    const slotId = candidateSwapSlots[cursor];
    swapPlacements.push({
      slotId,
      itemId,
      kind: "swap",
    });
    usedSwapSlots.add(slotId);
    cursor += 1;
  }

  return swapPlacements;
}

export function arePreviewsEqual(
  current: PreviewPlacement[],
  next: PreviewPlacement[],
): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentPlacement = current[index];
    const nextPlacement = next[index];
    if (
      currentPlacement.slotId !== nextPlacement.slotId ||
      currentPlacement.itemId !== nextPlacement.itemId ||
      currentPlacement.kind !== nextPlacement.kind
    ) {
      return false;
    }
  }

  return true;
}
