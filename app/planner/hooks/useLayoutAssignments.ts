import { type DragEvent, useMemo, useState } from "react";
import { DRAG_DATA_KEY } from "../constants";
import { retainValidAssignments } from "../lib/layoutAssignments";
import { buildSlotCenters } from "../lib/layoutGeometry";
import { buildCursorMovementHint, parseMisSlotIdValue } from "../lib/cursorHints";
import {
  arePreviewsEqual,
  buildPlacements,
  buildSwapPlacements,
  getIncomingEntries,
} from "../lib/placementEngine";
import type { CursorMovementHint } from "../components/layoutViewport/types";
import type {
  CatalogItem,
  DragPayload,
  FillDirection,
  HallConfig,
  HallId,
  PreviewPlacement,
} from "../types";
import { buildOrderedSlotIds, parseDragPayload } from "../utils";

type UseLayoutAssignmentsInput = {
  catalogItems: CatalogItem[];
  hallConfigs: Record<HallId, HallConfig>;
  fillDirection: FillDirection;
};

type UseLayoutAssignmentsResult = {
  itemById: Map<string, CatalogItem>;
  activeSlotAssignments: Record<string, string>;
  usedItemIds: Set<string>;
  cursorSlotId: string | null;
  cursorMovementHint: CursorMovementHint | null;
  selectedSlotIdSet: Set<string>;
  draggedSourceSlotIdSet: Set<string>;
  dragPreviews: PreviewPlacement[];
  clearLayout: () => void;
  clearDragState: () => void;
  setCursorSlot: (slotId: string) => void;
  setCursorMisRow: (hallId: HallId, slice: number, side: 0 | 1, row: number) => void;
  placeLibraryItemAtCursor: (itemId: string) => boolean;
  beginItemDrag: (event: DragEvent<HTMLElement>, itemId: string) => void;
  beginCategoryDrag: (event: DragEvent<HTMLElement>, itemIds: string[]) => void;
  beginSlotItemDrag: (
    event: DragEvent<HTMLElement>,
    slotId: string,
    itemId: string,
  ) => void;
  beginSlotGroupDrag: (
    event: DragEvent<HTMLElement>,
    slotIds: string[],
    originSlotId?: string,
  ) => void;
  handleSlotDragOver: (
    event: DragEvent<HTMLElement>,
    slotId: string,
    options?: SlotPlacementOptions,
  ) => void;
  handleSlotDrop: (
    event: DragEvent<HTMLElement>,
    slotId: string,
    options?: SlotPlacementOptions,
  ) => void;
  handleViewportDropFallback: (event: DragEvent<HTMLElement>) => void;
  handleLibraryDragOver: (event: DragEvent<HTMLElement>) => void;
  handleLibraryDrop: (event: DragEvent<HTMLElement>) => void;
  preserveAssignmentsForConfigChange: (
    previousConfigs: Record<HallId, HallConfig>,
    nextConfigs: Record<HallId, HallConfig>,
  ) => void;
  replaceSlotAssignments: (
    assignments: Record<string, string>,
    options?: {
      validSlotIds?: Set<string>;
      orderedSlotIds?: string[];
    },
  ) => void;
  clearSlot: (slotId: string) => void;
  setSelectedSlotIds: (slotIds: string[]) => void;
};

type ParsedMisRow = {
  hallId: HallId;
  slice: number;
  side: number;
  row: number;
};

type SlotPlacementOptions = {
  preferFirstEmptyMisSlot?: boolean;
};

export function useLayoutAssignments({
  catalogItems,
  hallConfigs,
  fillDirection,
}: UseLayoutAssignmentsInput): UseLayoutAssignmentsResult {
  const orderedSlotIds = useMemo(
    () => buildOrderedSlotIds(hallConfigs, fillDirection),
    [fillDirection, hallConfigs],
  );
  const orderedSlotIdSet = useMemo(() => new Set(orderedSlotIds), [orderedSlotIds]);

  const [slotAssignments, setSlotAssignments] = useState<Record<string, string>>({});
  const [cursorSlotId, setCursorSlotId] = useState<string | null>(() => orderedSlotIds[0] ?? null);
  const [selectedSlotIds, setSelectedSlotIdsState] = useState<string[]>([]);
  const [activeDragPayload, setActiveDragPayload] = useState<DragPayload | null>(null);
  const [dragPreviews, setDragPreviews] = useState<PreviewPlacement[]>([]);

  const placementContext = useMemo(
    () => ({
      orderedSlotIds,
      orderedSlotIdSet,
      itemById: new Map(catalogItems.map((item) => [item.id, item])),
    }),
    [catalogItems, orderedSlotIds, orderedSlotIdSet],
  );
  const itemById = placementContext.itemById;

  const activeSlotAssignments = useMemo(
    () => retainValidAssignments(slotAssignments, orderedSlotIdSet),
    [orderedSlotIdSet, slotAssignments],
  );

  const usedItemIds = useMemo(() => {
    const used = new Set<string>();
    for (const itemId of Object.values(activeSlotAssignments)) {
      if (itemId) {
        used.add(itemId);
      }
    }
    return used;
  }, [activeSlotAssignments]);

  const selectedSlotIdSet = useMemo(() => new Set(selectedSlotIds), [selectedSlotIds]);
  const draggedSourceSlotIdSet = useMemo(() => {
    if (activeDragPayload?.source !== "layout") {
      return new Set<string>();
    }

    const slotIds = activeDragPayload.sourceSlotIds ?? [];
    if (slotIds.length === 0 && activeDragPayload.originSlotId) {
      return orderedSlotIdSet.has(activeDragPayload.originSlotId)
        ? new Set([activeDragPayload.originSlotId])
        : new Set<string>();
    }

    const next = new Set<string>();
    for (const slotId of slotIds) {
      if (orderedSlotIdSet.has(slotId)) {
        next.add(slotId);
      }
    }
    return next;
  }, [activeDragPayload, orderedSlotIdSet]);

  const selectedSlotsInOrder = useMemo(
    () =>
      orderedSlotIds.filter(
        (slotId) => selectedSlotIdSet.has(slotId) && Boolean(activeSlotAssignments[slotId]),
      ),
    [activeSlotAssignments, orderedSlotIds, selectedSlotIdSet],
  );

  function parseMisRow(slotId: string): ParsedMisRow | null {
    const parsed = parseMisSlotIdValue(slotId);
    if (!parsed) {
      return null;
    }
    return {
      hallId: parsed.hallId,
      slice: parsed.slice,
      side: parsed.side,
      row: parsed.row,
    };
  }

  function isSameMisRow(a: ParsedMisRow, b: ParsedMisRow): boolean {
    return (
      a.hallId === b.hallId &&
      a.slice === b.slice &&
      a.side === b.side &&
      a.row === b.row
    );
  }

  function getMisRowSlotIds(unit: ParsedMisRow, slotIds: string[]): string[] {
    return slotIds
      .filter((slotId) => {
        const parsed = parseMisRow(slotId);
        return parsed ? isSameMisRow(parsed, unit) : false;
      })
      .sort((a, b) => {
        const ai = Number(a.split(":")[5]);
        const bi = Number(b.split(":")[5]);
        return ai - bi;
      });
  }

  function findFirstEmptySlotFrom(
    startSlotId: string | null,
    assignments: Record<string, string>,
  ): string | null {
    if (orderedSlotIds.length === 0) {
      return null;
    }

    const startIndex =
      startSlotId && orderedSlotIdSet.has(startSlotId)
        ? orderedSlotIds.indexOf(startSlotId)
        : 0;
    const normalizedStartIndex = startIndex >= 0 ? startIndex : 0;

    for (let offset = 0; offset < orderedSlotIds.length; offset += 1) {
      const index = (normalizedStartIndex + offset) % orderedSlotIds.length;
      const slotId = orderedSlotIds[index];
      if (!assignments[slotId]) {
        return slotId;
      }
    }

    return null;
  }

  function findNextEmptySlotAfter(
    slotId: string,
    assignments: Record<string, string>,
  ): string | null {
    if (orderedSlotIds.length === 0) {
      return null;
    }

    const baseIndex = orderedSlotIds.indexOf(slotId);
    const startIndex = baseIndex >= 0 ? (baseIndex + 1) % orderedSlotIds.length : 0;

    for (let offset = 0; offset < orderedSlotIds.length; offset += 1) {
      const index = (startIndex + offset) % orderedSlotIds.length;
      const candidate = orderedSlotIds[index];
      if (!assignments[candidate]) {
        return candidate;
      }
    }

    return null;
  }

  function setCursorSlot(slotId: string): void {
    if (!orderedSlotIdSet.has(slotId)) {
      return;
    }
    setCursorSlotId(slotId);
  }

  function setCursorMisRow(
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
  ): void {
    const targetUnit: ParsedMisRow = {
      hallId,
      slice,
      side,
      row,
    };
    const unitSlotIds = getMisRowSlotIds(targetUnit, orderedSlotIds);
    if (unitSlotIds.length === 0) {
      return;
    }

    const nextCursor =
      unitSlotIds.find((slotId) => !activeSlotAssignments[slotId]) ?? unitSlotIds[0];
    setCursorSlotId(nextCursor);
  }

  function resolveCursorForAssignments(assignments: Record<string, string>): string | null {
    return findFirstEmptySlotFrom(cursorSlotId, assignments) ?? orderedSlotIds[0] ?? null;
  }

  function resolveCursorMovementHint(mode: "layout" | "popup"): CursorMovementHint | null {
    const anchorSlotId = findFirstEmptySlotFrom(cursorSlotId, activeSlotAssignments);
    if (!anchorSlotId) {
      return null;
    }

    const simulatedAssignments = {
      ...activeSlotAssignments,
      [anchorSlotId]: "__cursor__",
    };
    const nextSlotId = findNextEmptySlotAfter(anchorSlotId, simulatedAssignments);
    if (!nextSlotId || nextSlotId === anchorSlotId) {
      return null;
    }

    return buildCursorMovementHint(anchorSlotId, nextSlotId, fillDirection, mode);
  }

  const cursorMovementHint = resolveCursorMovementHint("layout");

  function placeLibraryItemAtCursor(itemId: string): boolean {
    if (!itemById.has(itemId)) {
      return false;
    }

    const anchorSlotId = findFirstEmptySlotFrom(cursorSlotId, activeSlotAssignments);
    if (!anchorSlotId) {
      return false;
    }

    const nextAssignments = { ...activeSlotAssignments, [anchorSlotId]: itemId };
    const nextCursor = findNextEmptySlotAfter(anchorSlotId, nextAssignments) ?? anchorSlotId;

    setSlotAssignments((current) => {
      const next = retainValidAssignments(current, orderedSlotIdSet);
      for (const [slotId, assignedItemId] of Object.entries(next)) {
        if (assignedItemId === itemId) {
          delete next[slotId];
        }
      }
      next[anchorSlotId] = itemId;
      return next;
    });
    setCursorSlotId(nextCursor);
    setSelectedSlotIdsState([]);
    clearDragState();
    return true;
  }

  function buildMisSwapPreview(
    anchorSlotId: string,
    payload: DragPayload,
    assignments: Record<string, string>,
  ): PreviewPlacement[] | null {
    if (payload.source !== "layout" || !payload.originSlotId) {
      return null;
    }

    const sourceUnit = parseMisRow(payload.originSlotId);
    const targetUnit = parseMisRow(anchorSlotId);
    if (!sourceUnit || !targetUnit || isSameMisRow(sourceUnit, targetUnit)) {
      return null;
    }

    const sourceSlotIds = getMisRowSlotIds(sourceUnit, orderedSlotIds);
    const targetSlotIds = getMisRowSlotIds(targetUnit, orderedSlotIds);
    if (sourceSlotIds.length === 0 || targetSlotIds.length === 0) {
      return null;
    }

    // Only run MIS-unit swap for explicit full-unit drags (from MIS card/panel),
    // not individual slot drags from popup content.
    const payloadSourceSlotIds = payload.sourceSlotIds ?? [];
    if (payloadSourceSlotIds.length !== sourceSlotIds.length) {
      return null;
    }
    const payloadSourceSlotSet = new Set(payloadSourceSlotIds);
    if (sourceSlotIds.some((slotId) => !payloadSourceSlotSet.has(slotId))) {
      return null;
    }

    const swapCount = Math.min(sourceSlotIds.length, targetSlotIds.length);
    const previews: PreviewPlacement[] = [];
    for (let index = 0; index < swapCount; index += 1) {
      const sourceSlotId = sourceSlotIds[index];
      const targetSlotId = targetSlotIds[index];
      const sourceItemId = assignments[sourceSlotId];
      const targetItemId = assignments[targetSlotId];

      if (sourceItemId) {
        previews.push({
          slotId: targetSlotId,
          itemId: sourceItemId,
          kind: "place",
        });
      }
      if (targetItemId) {
        previews.push({
          slotId: sourceSlotId,
          itemId: targetItemId,
          kind: "swap",
        });
      }
    }

    return previews;
  }

  function placeMisRowSwap(anchorSlotId: string, payload: DragPayload): boolean {
    if (payload.source !== "layout" || !payload.originSlotId) {
      return false;
    }

    const sourceUnit = parseMisRow(payload.originSlotId);
    const targetUnit = parseMisRow(anchorSlotId);
    if (!sourceUnit || !targetUnit || isSameMisRow(sourceUnit, targetUnit)) {
      return false;
    }

    const sourceSlotIds = getMisRowSlotIds(sourceUnit, orderedSlotIds);
    const targetSlotIds = getMisRowSlotIds(targetUnit, orderedSlotIds);
    if (sourceSlotIds.length === 0 || targetSlotIds.length === 0) {
      return false;
    }

    // Only run MIS-unit swap for explicit full-unit drags (from MIS card/panel),
    // not individual slot drags from popup content.
    const payloadSourceSlotIds = payload.sourceSlotIds ?? [];
    if (payloadSourceSlotIds.length !== sourceSlotIds.length) {
      return false;
    }
    const payloadSourceSlotSet = new Set(payloadSourceSlotIds);
    if (sourceSlotIds.some((slotId) => !payloadSourceSlotSet.has(slotId))) {
      return false;
    }

    const swapCount = Math.min(sourceSlotIds.length, targetSlotIds.length);
    setSlotAssignments((current) => {
      const next = retainValidAssignments(current, orderedSlotIdSet);
      const sourceItems = sourceSlotIds.map((slotId) => next[slotId]);
      const targetItems = targetSlotIds.map((slotId) => next[slotId]);

      for (let index = 0; index < swapCount; index += 1) {
        const sourceSlotId = sourceSlotIds[index];
        const targetSlotId = targetSlotIds[index];
        const sourceItemId = sourceItems[index];
        const targetItemId = targetItems[index];

        if (sourceItemId) {
          next[targetSlotId] = sourceItemId;
        } else {
          delete next[targetSlotId];
        }

        if (targetItemId) {
          next[sourceSlotId] = targetItemId;
        } else {
          delete next[sourceSlotId];
        }
      }

      return next;
    });

    const selected = targetSlotIds
      .slice(0, swapCount)
      .filter((slotId, index) => Boolean(activeSlotAssignments[sourceSlotIds[index]]));
    setSelectedSlotIdsState(selected);
    return true;
  }

  function clearLayout(): void {
    setSlotAssignments({});
    setCursorSlotId(orderedSlotIds[0] ?? null);
    setSelectedSlotIdsState([]);
  }

  function clearDragState(): void {
    setActiveDragPayload(null);
    setDragPreviews([]);
  }

  function beginItemDrag(event: DragEvent<HTMLElement>, itemId: string): void {
    const payload: DragPayload = {
      kind: "item",
      itemIds: [itemId],
      source: "catalog",
    };

    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
    setActiveDragPayload(payload);
    setDragPreviews([]);
  }

  function beginCategoryDrag(event: DragEvent<HTMLElement>, itemIds: string[]): void {
    if (itemIds.length === 0) {
      event.preventDefault();
      return;
    }

    const payload: DragPayload = {
      kind: "category",
      itemIds,
      source: "catalog",
    };

    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
    setActiveDragPayload(payload);
    setDragPreviews([]);
  }

  function beginSlotItemDrag(
    event: DragEvent<HTMLElement>,
    slotId: string,
    itemId: string,
  ): void {
    const isMultiMove = selectedSlotIdSet.has(slotId) && selectedSlotsInOrder.length > 1;
    const selectedItemIds = selectedSlotsInOrder
      .map((selectedSlotId) => activeSlotAssignments[selectedSlotId])
      .filter((selectedItemId): selectedItemId is string => Boolean(selectedItemId));

    const dragItemIds = isMultiMove ? selectedItemIds : [itemId];
    const payload: DragPayload = {
      kind: dragItemIds.length > 1 ? "category" : "item",
      itemIds: dragItemIds,
      source: "layout",
      originSlotId: slotId,
      sourceSlotIds: isMultiMove ? selectedSlotsInOrder : [slotId],
    };

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
    setActiveDragPayload(payload);
    setDragPreviews([]);
    if (!isMultiMove) {
      setSelectedSlotIdsState([slotId]);
    }
  }

  function beginSlotGroupDrag(
    event: DragEvent<HTMLElement>,
    slotIds: string[],
    originSlotId?: string,
  ): void {
    const normalizedSlotIds: string[] = [];
    const seen = new Set<string>();
    for (const slotId of slotIds) {
      if (!orderedSlotIdSet.has(slotId) || seen.has(slotId)) {
        continue;
      }
      normalizedSlotIds.push(slotId);
      seen.add(slotId);
    }

    const entries = normalizedSlotIds
      .map((slotId) => ({
        slotId,
        itemId: activeSlotAssignments[slotId],
      }))
      .filter((entry): entry is { slotId: string; itemId: string } => Boolean(entry.itemId));

    if (entries.length === 0) {
      event.preventDefault();
      return;
    }

    const nextOriginSlotId =
      originSlotId && entries.some((entry) => entry.slotId === originSlotId)
        ? originSlotId
        : entries[0].slotId;

    const payload: DragPayload = {
      kind: entries.length > 1 ? "category" : "item",
      itemIds: entries.map((entry) => entry.itemId),
      source: "layout",
      originSlotId: nextOriginSlotId,
      sourceSlotIds: entries.map((entry) => entry.slotId),
    };

    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
    setActiveDragPayload(payload);
    setDragPreviews([]);
    setSelectedSlotIdsState(entries.map((entry) => entry.slotId));
  }

  function buildPreviewSet(
    anchorSlotId: string,
    payload: DragPayload,
    options?: SlotPlacementOptions,
  ): PreviewPlacement[] {
    const placements = buildPlacements({
      anchorSlotId,
      payload,
      assignments: activeSlotAssignments,
      context: placementContext,
      preferFirstEmptyMisSlot: options?.preferFirstEmptyMisSlot,
    });

    const incomingEntries = getIncomingEntries(payload, itemById);
    const swapPreviews = buildSwapPlacements({
      payload,
      incomingEntries,
      placements,
      assignments: activeSlotAssignments,
      orderedSlotIdSet,
    });

    return swapPreviews === null ? placements : [...placements, ...swapPreviews];
  }

  function getPayloadFromDragEvent(event: DragEvent<HTMLElement>): DragPayload | null {
    return parseDragPayload(event.dataTransfer.getData(DRAG_DATA_KEY)) ?? activeDragPayload;
  }

  function handleSlotDragOver(
    event: DragEvent<HTMLElement>,
    slotId: string,
    options?: SlotPlacementOptions,
  ): void {
    event.preventDefault();

    const payload = getPayloadFromDragEvent(event);
    if (!payload) {
      setDragPreviews([]);
      return;
    }

    event.dataTransfer.dropEffect = payload.source === "layout" ? "move" : "copy";
    setActiveDragPayload(payload);

    const misSwapPreview = buildMisSwapPreview(slotId, payload, activeSlotAssignments);
    if (misSwapPreview && misSwapPreview.length > 0) {
      setDragPreviews((current) =>
        arePreviewsEqual(current, misSwapPreview) ? current : misSwapPreview,
      );
      return;
    }

    const nextPreviews = buildPreviewSet(slotId, payload, options);
    setDragPreviews((current) =>
      arePreviewsEqual(current, nextPreviews) ? current : nextPreviews,
    );
  }

  function placePayload(
    anchorSlotId: string,
    payload: DragPayload,
    options?: SlotPlacementOptions,
  ): void {
    if (!orderedSlotIdSet.has(anchorSlotId)) {
      return;
    }

    setSlotAssignments((current) => {
      const next = retainValidAssignments(current, orderedSlotIdSet);
      const incomingEntries = getIncomingEntries(payload, itemById);
      const incoming = incomingEntries.map((entry) => entry.itemId);

      if (incoming.length === 0) {
        return current;
      }

      const placements = buildPlacements({
        anchorSlotId,
        payload,
        assignments: current,
        context: placementContext,
        preferFirstEmptyMisSlot: options?.preferFirstEmptyMisSlot,
      });
      if (placements.length === 0) {
        return current;
      }

      const swapPlacements = buildSwapPlacements({
        payload,
        incomingEntries,
        placements,
        assignments: current,
        orderedSlotIdSet,
      });
      if (swapPlacements === null) {
        return current;
      }

      const incomingSet = new Set(incoming);
      for (const [slotId, itemId] of Object.entries(next)) {
        if (incomingSet.has(itemId)) {
          delete next[slotId];
        }
      }

      for (const placement of placements) {
        next[placement.slotId] = placement.itemId;
      }

      for (const swapPlacement of swapPlacements) {
        next[swapPlacement.slotId] = swapPlacement.itemId;
      }

      return next;
    });
  }

  function handleSlotDrop(
    event: DragEvent<HTMLElement>,
    anchorSlotId: string,
    options?: SlotPlacementOptions,
  ): void {
    event.preventDefault();

    const payload = getPayloadFromDragEvent(event);
    if (!payload) {
      clearDragState();
      return;
    }

    if (placeMisRowSwap(anchorSlotId, payload)) {
      clearDragState();
      return;
    }

    const placements = buildPlacements({
      anchorSlotId,
      payload,
      assignments: activeSlotAssignments,
      context: placementContext,
      preferFirstEmptyMisSlot: options?.preferFirstEmptyMisSlot,
    });

    placePayload(anchorSlotId, payload, options);
    if (payload.source === "layout") {
      setSelectedSlotIdsState(placements.map((placement) => placement.slotId));
    }
    clearDragState();
  }

  function handleViewportDropFallback(event: DragEvent<HTMLElement>): void {
    event.preventDefault();

    const payload = getPayloadFromDragEvent(event);
    if (!payload) {
      clearDragState();
      return;
    }

    const anchorSlotId = dragPreviews.find((placement) => placement.kind === "place")?.slotId;
    if (!anchorSlotId) {
      clearDragState();
      return;
    }

    const placements = buildPlacements({
      anchorSlotId,
      payload,
      assignments: activeSlotAssignments,
      context: placementContext,
    });

    if (placements.length === 0) {
      clearDragState();
      return;
    }

    placePayload(anchorSlotId, payload);
    if (payload.source === "layout") {
      setSelectedSlotIdsState(placements.map((placement) => placement.slotId));
    }
    clearDragState();
  }

  function handleLibraryDragOver(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    event.dataTransfer.dropEffect = activeDragPayload?.source === "layout" ? "move" : "copy";

    if (dragPreviews.length > 0) {
      setDragPreviews([]);
    }
  }

  function handleLibraryDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();

    const payload = getPayloadFromDragEvent(event);
    if (!payload) {
      clearDragState();
      return;
    }

    if (payload.source === "layout") {
      const incomingSet = new Set(payload.itemIds);
      setSlotAssignments((current) => {
        const next = retainValidAssignments(current, orderedSlotIdSet);
        for (const [slotId, itemId] of Object.entries(next)) {
          if (incomingSet.has(itemId)) {
            delete next[slotId];
          }
        }
        return next;
      });
      setSelectedSlotIdsState([]);
    }

    clearDragState();
  }

  function clearSlot(slotId: string): void {
    setSlotAssignments((current) => {
      if (!(slotId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[slotId];
      return next;
    });

    setSelectedSlotIdsState((current) => current.filter((entry) => entry !== slotId));
  }

  function setSelectedSlotIds(slotIds: string[]): void {
    setSelectedSlotIdsState(slotIds);
  }

  function replaceSlotAssignments(
    assignments: Record<string, string>,
    options?: {
      validSlotIds?: Set<string>;
      orderedSlotIds?: string[];
    },
  ): void {
    const validSlotIds = options?.validSlotIds ?? orderedSlotIdSet;
    const orderedIds = options?.orderedSlotIds ?? orderedSlotIds;
    const normalizedAssignments = retainValidAssignments(assignments, validSlotIds);
    setSlotAssignments({ ...normalizedAssignments });
    if (orderedIds.length === 0) {
      setCursorSlotId(null);
    } else {
      const startIndex =
        cursorSlotId && validSlotIds.has(cursorSlotId)
          ? orderedIds.indexOf(cursorSlotId)
          : 0;
      const normalizedStartIndex = startIndex >= 0 ? startIndex : 0;
      let nextCursor: string | null = orderedIds[0] ?? null;
      for (let offset = 0; offset < orderedIds.length; offset += 1) {
        const index = (normalizedStartIndex + offset) % orderedIds.length;
        const slotId = orderedIds[index];
        if (!normalizedAssignments[slotId]) {
          nextCursor = slotId;
          break;
        }
      }
      setCursorSlotId(nextCursor);
    }
    setSelectedSlotIdsState([]);
    clearDragState();
  }

  function preserveAssignmentsForConfigChange(
    previousConfigs: Record<HallId, HallConfig>,
    nextConfigs: Record<HallId, HallConfig>,
  ): void {
    const previousOrderedSlotIds = buildOrderedSlotIds(previousConfigs, fillDirection);
    const nextOrderedSlotIds = buildOrderedSlotIds(nextConfigs, fillDirection);
    const previousValidSlotIdSet = new Set(previousOrderedSlotIds);
    const nextOrderIndex = new Map(
      nextOrderedSlotIds.map((slotId, index) => [slotId, index]),
    );
    const previousOrderIndex = new Map(
      previousOrderedSlotIds.map((slotId, index) => [slotId, index]),
    );
    const previousCenterBySlotId = buildSlotCenters(previousConfigs);
    const nextCenterBySlotId = buildSlotCenters(nextConfigs);

    const parseHallId = (slotId: string): HallId | null => {
      const hallId = Number(slotId.split(":")[0]);
      if (Number.isFinite(hallId)) {
        return hallId;
      }
      return null;
    };

    const pickNearestSlot = (
      targetPoint: { x: number; y: number } | undefined,
      candidates: Set<string>,
    ): string | null => {
      let bestSlotId: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestOrder = Number.POSITIVE_INFINITY;

      for (const candidateSlotId of candidates) {
        const center = nextCenterBySlotId.get(candidateSlotId);
        const order = nextOrderIndex.get(candidateSlotId) ?? Number.POSITIVE_INFINITY;
        const distance = targetPoint
          ? ((center?.x ?? Number.POSITIVE_INFINITY) - targetPoint.x) ** 2 +
            ((center?.y ?? Number.POSITIVE_INFINITY) - targetPoint.y) ** 2
          : Number.POSITIVE_INFINITY;

        if (
          distance < bestDistance ||
          (distance === bestDistance && order < bestOrder)
        ) {
          bestDistance = distance;
          bestOrder = order;
          bestSlotId = candidateSlotId;
        }
      }

      if (!bestSlotId && candidates.size > 0) {
        bestSlotId = Array.from(candidates).sort((a, b) => {
          return (nextOrderIndex.get(a) ?? Number.POSITIVE_INFINITY) -
            (nextOrderIndex.get(b) ?? Number.POSITIVE_INFINITY);
        })[0] ?? null;
      }

      return bestSlotId;
    };

    let nextAssignments: Record<string, string> = {};
    setSlotAssignments((current) => {
      const currentFromPrevious = retainValidAssignments(current, previousValidSlotIdSet);
      const entries = Object.entries(currentFromPrevious)
        .map(([slotId, itemId]) => ({
          slotId,
          itemId,
          hallId: parseHallId(slotId),
          point: previousCenterBySlotId.get(slotId),
        }))
        .sort((a, b) => {
          return (previousOrderIndex.get(a.slotId) ?? Number.POSITIVE_INFINITY) -
            (previousOrderIndex.get(b.slotId) ?? Number.POSITIVE_INFINITY);
        });

      if (entries.length === 0) {
        nextAssignments = {};
        return {};
      }

      const unassignedGlobal = new Set(nextOrderedSlotIds);
      const unassignedByHall = new Map<HallId, Set<string>>();
      const hallIds = Object.keys(nextConfigs).map((key) => Number(key));
      for (const hallId of hallIds) {
        const hallSlots = nextOrderedSlotIds.filter((slotId) => slotId.startsWith(`${hallId}:`));
        unassignedByHall.set(hallId, new Set(hallSlots));
      }

      const remapped: Record<string, string> = {};

      for (const entry of entries) {
        let targetSlotId: string | null = null;

        if (entry.hallId) {
          const hallCandidates = unassignedByHall.get(entry.hallId);
          if (hallCandidates && hallCandidates.size > 0) {
            targetSlotId = pickNearestSlot(entry.point, hallCandidates);
          }
        }

        if (!targetSlotId && unassignedGlobal.size > 0) {
          targetSlotId = pickNearestSlot(entry.point, unassignedGlobal);
        }

        if (!targetSlotId) {
          continue;
        }

        remapped[targetSlotId] = entry.itemId;
        unassignedGlobal.delete(targetSlotId);
        const targetHallId = parseHallId(targetSlotId);
        if (targetHallId) {
          unassignedByHall.get(targetHallId)?.delete(targetSlotId);
        }
      }

      nextAssignments = remapped;
      return remapped;
    });

    setSelectedSlotIdsState([]);
    setCursorSlotId(resolveCursorForAssignments(nextAssignments));
    clearDragState();
  }

  return {
    itemById,
    activeSlotAssignments,
    usedItemIds,
    cursorSlotId,
    cursorMovementHint,
    selectedSlotIdSet,
    draggedSourceSlotIdSet,
    dragPreviews,
    clearLayout,
    clearDragState,
    setCursorSlot,
    setCursorMisRow,
    placeLibraryItemAtCursor,
    beginItemDrag,
    beginCategoryDrag,
    beginSlotItemDrag,
    beginSlotGroupDrag,
    handleSlotDragOver,
    handleSlotDrop,
    handleViewportDropFallback,
    handleLibraryDragOver,
    handleLibraryDrop,
    preserveAssignmentsForConfigChange,
    replaceSlotAssignments,
    clearSlot,
    setSelectedSlotIds,
  };
}
