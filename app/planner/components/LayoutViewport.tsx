import Image from "next/image";
import {
  type DragEvent,
  type PointerEvent,
  type RefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SLOT_GAP,
  SLOT_SIZE,
  STAGE_SIZE,
} from "../constants";
import {
  directionOrientation,
  getLayoutHallName,
  resolveStorageLayout,
  type HallDirection,
  type StorageLayoutPreset,
} from "../layoutConfig";
import type { HallSideKey } from "../hooks/useHallConfigs";
import { CursorMovementIndicator } from "./layoutViewport/CursorMovementIndicator";
import {
  ExpandedMisPanelsOverlay,
  type ExpandedMisPanel,
  type ExpandedMisTarget,
} from "./layoutViewport/ExpandedMisPanelsOverlay";
import { HallConfigPanel } from "./layoutViewport/HallConfigPanel";
import type { CursorMovementHint } from "./layoutViewport/types";
import type {
  CatalogItem,
  HallConfig,
  HallId,
  HallSideConfig,
  HallType,
  PreviewPlacement,
} from "../types";
import {
  calculateMisComparatorPrimer,
  getHallSize,
  misSlotId,
  nonMisSlotId,
  resolveHallSlices,
  toTitle,
} from "../utils";
import { buildPopupCursorHint } from "../lib/cursorHints";
import { DEFAULT_MIS_MULTIPLICITY, DEFAULT_MIS_SIGNAL_STRENGTH } from "../lib/plannerSnapshot";

type LayoutViewportProps = {
  storageLayoutPreset: StorageLayoutPreset;
  onStorageLayoutPresetChange: (preset: StorageLayoutPreset) => void;
  hallConfigs: Record<HallId, HallConfig>;
  slotAssignments: Record<string, string>;
  itemById: Map<string, CatalogItem>;
  hallNames: Record<HallId, string>;
  sectionNames: Record<string, string>;
  misNames: Record<string, string>;
  misSignalStrengths: Record<string, number>;
  misMultiplicities: Record<string, number>;
  cursorSlotId: string | null;
  cursorMovementHint: CursorMovementHint | null;
  viewportRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  pan: { x: number; y: number };
  subscribeViewportTransform: (
    listener: (state: { zoom: number; pan: { x: number; y: number } }) => void,
  ) => () => void;
  onAdjustZoom: (delta: number) => void;
  onPanViewportBy: (
    deltaX: number,
    deltaY: number,
    commitMode?: "immediate" | "throttled",
  ) => void;
  onFitViewportToBounds: (
    bounds: { left: number; top: number; right: number; bottom: number },
    padding?: number,
  ) => void;
  onRecenterViewport: (focusPoint?: { x: number; y: number }) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => boolean;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onSlotDragOver: (
    event: DragEvent<HTMLElement>,
    slotId: string,
    options?: { preferFirstEmptyMisSlot?: boolean },
  ) => void;
  onSlotDrop: (
    event: DragEvent<HTMLElement>,
    slotId: string,
    options?: { preferFirstEmptyMisSlot?: boolean },
  ) => void;
  onViewportDropFallback: (event: DragEvent<HTMLElement>) => void;
  onCursorSlotChange: (slotId: string) => void;
  onCursorMisChange: (hallId: HallId, slice: number, side: 0 | 1, row: number) => void;
  onSectionSlicesChange: (hallId: HallId, sectionIndex: number, value: string) => void;
  onSectionSideTypeChange: (
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    type: HallType,
  ) => void;
  onSectionSideRowsChange: (
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ) => void;
  onSectionSideMisCapacityChange: (
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ) => void;
  onSectionSideMisRowsChange: (
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ) => void;
  onSectionSideMisWidthChange: (
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ) => void;
  onHallNameChange: (hallId: HallId, rawName: string) => void;
  onSectionNameChange: (hallId: HallId, sectionIndex: number, rawName: string) => void;
  onMisNameChange: (
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawName: string,
  ) => void;
  onMisSignalStrengthChange: (
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawValue: string | number,
  ) => void;
  onMisMultiplicityChange: (
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawValue: string | number,
  ) => void;
  onAddSection: (hallId: HallId) => void;
  onRemoveSection: (hallId: HallId, sectionIndex: number) => void;
  onSlotItemDragStart: (
    event: DragEvent<HTMLElement>,
    slotId: string,
    itemId: string,
  ) => void;
  onSlotGroupDragStart: (
    event: DragEvent<HTMLElement>,
    slotIds: string[],
    originSlotId?: string,
  ) => void;
  onAnyDragEnd: () => void;
  onClearSlot: (slotId: string) => void;
  draggedSourceSlotIds: Set<string>;
  dragPreviewPlacements: PreviewPlacement[];
  selectedSlotIds: Set<string>;
  onSelectionChange: (slotIds: string[]) => void;
  onViewModeChange?: (mode: LayoutViewMode) => void;
};

type LayoutViewMode = "storage" | "flat";

type HallPlacement = {
  left: number;
  top: number;
  transform: string;
  width: number;
  height: number;
};

type FlatLayoutMetrics = {
  dimensions: Array<{ hallId: HallId; width: number; height: number }>;
  totalHeight: number;
  maxWidth: number;
  left: number;
  top: number;
};

const FLAT_VIEW_HALL_GAP = 25;

type HallLayoutState = {
  positions: Record<HallId, HallPlacement>;
  directions: Record<HallId, HallDirection>;
  core: { left: number; top: number; width: number; height: number; label: string } | null;
};

type WorldBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type SectionVisualTheme = {
  areaClassName: string;
  labelClassName: string;
  indexChipClassName: string;
  titleClassName: string;
  slotTintClassName: string;
};

const VISIBILITY_OVERSCAN = 80;
const LAYOUT_HINT_DISMISSED_STORAGE_KEY = "planner:layout-hint-dismissed";
const SECTION_DIVIDER_CLASS_NAME =
  "bg-[rgba(104,84,58,0.62)] shadow-[0_0_0_1px_rgba(255,243,221,0.68)] dark:bg-[rgba(116,140,177,0.58)] dark:shadow-[0_0_0_1px_rgba(35,49,72,0.7)]";

const SECTION_VISUAL_THEMES: SectionVisualTheme[] = [
  {
    areaClassName:
      "border-[rgba(157,114,56,0.26)] bg-[linear-gradient(180deg,rgba(255,229,185,0.28)_0%,rgba(255,247,230,0.05)_100%)] dark:border-[rgba(186,136,74,0.35)] dark:bg-[linear-gradient(180deg,rgba(113,82,43,0.35)_0%,rgba(37,28,19,0.22)_100%)]",
    labelClassName:
      "border-[rgba(151,104,48,0.42)] bg-[rgba(255,244,221,0.96)] text-[#5f4423] shadow-[0_1px_3px_rgba(95,68,35,0.2)] dark:border-[rgba(186,136,74,0.52)] dark:bg-[rgba(83,59,30,0.88)] dark:text-[#ffe8ca] dark:shadow-[0_1px_4px_rgba(10,12,18,0.45)]",
    indexChipClassName:
      "border-[rgba(151,104,48,0.52)] bg-[rgba(229,185,120,0.35)] text-[#5a3d1d] dark:border-[rgba(196,149,91,0.62)] dark:bg-[rgba(169,123,67,0.38)] dark:text-[#fff0dc]",
    titleClassName: "text-[#5a3d1d] dark:text-[#ffe8ca]",
    slotTintClassName: "bg-[rgba(199,169,122,0.18)] dark:bg-[rgba(171,123,67,0.2)]",
  },
  {
    areaClassName:
      "border-[rgba(43,115,106,0.26)] bg-[linear-gradient(180deg,rgba(188,244,226,0.26)_0%,rgba(234,251,244,0.05)_100%)] dark:border-[rgba(60,140,132,0.35)] dark:bg-[linear-gradient(180deg,rgba(27,83,78,0.34)_0%,rgba(16,43,43,0.22)_100%)]",
    labelClassName:
      "border-[rgba(33,121,109,0.42)] bg-[rgba(233,253,246,0.95)] text-[#1e5a53] shadow-[0_1px_3px_rgba(31,86,79,0.2)] dark:border-[rgba(73,169,157,0.52)] dark:bg-[rgba(21,67,64,0.88)] dark:text-[#c8f6ea] dark:shadow-[0_1px_4px_rgba(10,12,18,0.45)]",
    indexChipClassName:
      "border-[rgba(33,121,109,0.52)] bg-[rgba(129,225,196,0.34)] text-[#1a5149] dark:border-[rgba(83,173,153,0.62)] dark:bg-[rgba(52,126,113,0.4)] dark:text-[#dcfff6]",
    titleClassName: "text-[#1d564f] dark:text-[#c8f6ea]",
    slotTintClassName: "bg-[rgba(82,189,158,0.2)] dark:bg-[rgba(52,126,113,0.24)]",
  },
  {
    areaClassName:
      "border-[rgba(52,92,148,0.26)] bg-[linear-gradient(180deg,rgba(196,221,255,0.24)_0%,rgba(240,247,255,0.05)_100%)] dark:border-[rgba(94,129,184,0.35)] dark:bg-[linear-gradient(180deg,rgba(35,59,96,0.34)_0%,rgba(16,28,50,0.22)_100%)]",
    labelClassName:
      "border-[rgba(58,99,159,0.42)] bg-[rgba(236,244,255,0.95)] text-[#274878] shadow-[0_1px_3px_rgba(39,72,120,0.2)] dark:border-[rgba(106,143,206,0.52)] dark:bg-[rgba(25,44,74,0.88)] dark:text-[#cfe3ff] dark:shadow-[0_1px_4px_rgba(10,12,18,0.45)]",
    indexChipClassName:
      "border-[rgba(58,99,159,0.52)] bg-[rgba(156,192,241,0.34)] text-[#203f6a] dark:border-[rgba(114,149,206,0.62)] dark:bg-[rgba(70,103,156,0.4)] dark:text-[#e1edff]",
    titleClassName: "text-[#234472] dark:text-[#cfe3ff]",
    slotTintClassName: "bg-[rgba(115,156,222,0.2)] dark:bg-[rgba(70,103,156,0.24)]",
  },
  {
    areaClassName:
      "border-[rgba(93,111,57,0.24)] bg-[linear-gradient(180deg,rgba(214,236,182,0.22)_0%,rgba(246,251,236,0.05)_100%)] dark:border-[rgba(117,142,77,0.35)] dark:bg-[linear-gradient(180deg,rgba(58,81,39,0.35)_0%,rgba(24,34,20,0.22)_100%)]",
    labelClassName:
      "border-[rgba(95,129,60,0.42)] bg-[rgba(245,252,232,0.95)] text-[#41592a] shadow-[0_1px_3px_rgba(65,89,42,0.18)] dark:border-[rgba(138,171,90,0.52)] dark:bg-[rgba(43,61,31,0.88)] dark:text-[#e0f2cc] dark:shadow-[0_1px_4px_rgba(10,12,18,0.45)]",
    indexChipClassName:
      "border-[rgba(95,129,60,0.5)] bg-[rgba(184,220,136,0.32)] text-[#385024] dark:border-[rgba(150,185,103,0.62)] dark:bg-[rgba(94,126,64,0.36)] dark:text-[#f0ffe0]",
    titleClassName: "text-[#3e5628] dark:text-[#e0f2cc]",
    slotTintClassName: "bg-[rgba(156,196,96,0.18)] dark:bg-[rgba(94,126,64,0.24)]",
  },
];

function defaultHallLabel(hallId: HallId): string {
  return `Hall ${hallId}`;
}

function shouldIgnoreViewerShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function expandedMisKey(target: ExpandedMisTarget): string {
  return `${target.hallId}:${target.slice}:${target.side}:${target.row}`;
}

function sectionNameKey(hallId: HallId, sectionIndex: number): string {
  return `${hallId}:${sectionIndex}`;
}

function resolveSectionVisualTheme(sectionIndex: number): SectionVisualTheme {
  return SECTION_VISUAL_THEMES[sectionIndex % SECTION_VISUAL_THEMES.length];
}

function misPreviewLayout(cardWidth: number, cardHeight: number): { columns: number; maxItems: number } {
  const tile = 16;
  const gap = 2;
  const usableWidth = Math.max(16, Math.floor(cardWidth) - 4);
  const columns = Math.max(1, Math.min(6, Math.floor((usableWidth + gap) / (tile + gap))));

  // Card layout is [title][count][preview-grid]; reserve compact header space.
  const usableHeight = Math.max(16, Math.floor(cardHeight) - 24);
  const rows = Math.max(1, Math.floor((usableHeight + gap) / (tile + gap)));
  return { columns, maxItems: columns * rows };
}

function sideDepthPx(side: HallSideConfig): number {
  if (side.type === "mis") {
    return side.rowsPerSlice * 112 + Math.max(0, side.rowsPerSlice - 1) * SLOT_GAP;
  }
  return side.rowsPerSlice * SLOT_SIZE + Math.max(0, side.rowsPerSlice - 1) * SLOT_GAP;
}

function emptyHallPlacements(hallIds: HallId[]): Record<HallId, HallPlacement> {
  const positions: Record<HallId, HallPlacement> = {};
  for (const hallId of hallIds) {
    positions[hallId] = { left: 0, top: 0, transform: "", width: 0, height: 0 };
  }
  return positions;
}

function readInitialHintVisibility(): boolean {
  try {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem(LAYOUT_HINT_DISMISSED_STORAGE_KEY) !== "1";
  } catch {
    // Ignore storage access issues; default to showing hint.
    return true;
  }
}

function buildFlatLayoutMetrics(
  hallIds: HallId[],
  hallConfigs: Record<HallId, HallConfig>,
  center: number,
): FlatLayoutMetrics {
  const dimensions = hallIds.map((hallId) => {
    const config = hallConfigs[hallId];
    const orientation: "horizontal" | "vertical" = "horizontal";
    const { width, height } = getHallSize(config, orientation);
    return { hallId, width, height };
  });
  const totalHeight =
    dimensions.reduce((sum, hall) => sum + hall.height, 0) +
    Math.max(0, dimensions.length - 1) * FLAT_VIEW_HALL_GAP;
  const maxWidth = dimensions.reduce((max, hall) => Math.max(max, hall.width), 0);
  return {
    dimensions,
    totalHeight,
    maxWidth,
    left: center - maxWidth / 2,
    top: center - totalHeight / 2,
  };
}

function resolveHallControlAnchorStyle(
  viewMode: LayoutViewMode,
  hallIds: HallId[],
  hallDirections: Record<HallId, HallDirection>,
  hallId: HallId,
  layoutDirection: HallDirection,
): { left?: string; right?: string; top?: string; bottom?: string; transform: string } {
  if (viewMode === "flat") {
    return { left: "-0.36rem", top: "50%", transform: "translate(-100%, -50%)" };
  }

  const sameDirectionHalls = hallIds.filter(
    (otherHallId) => hallDirections[otherHallId] === layoutDirection,
  );
  const sameDirectionHallIndex = sameDirectionHalls.indexOf(hallId);
  switch (layoutDirection) {
    case "south":
      if (sameDirectionHalls.length === 1) {
        return {
          left: "50%",
          bottom: "-0.36rem",
          transform: "translate(-50%, 100%)",
        };
      }
      if (sameDirectionHalls.length === 2) {
        if (sameDirectionHallIndex === 0) {
          return {
            right: "0",
            bottom: "-0.36rem",
            transform: "translate(0, 100%)",
          };
        }
        return {
          left: "0",
          bottom: "-0.36rem",
          transform: "translate(0, 100%)",
        };
      }
      break;
    case "north":
      if (sameDirectionHalls.length === 1) {
        return {
          left: "50%",
          top: "-0.36rem",
          transform: "translate(-50%, -100%)",
        };
      }
      if (sameDirectionHalls.length === 2) {
        if (sameDirectionHallIndex === 0) {
          return {
            right: "0",
            top: "-0.36rem",
            transform: "translate(0, -100%)",
          };
        }
        return {
          left: "0",
          top: "-0.36rem",
          transform: "translate(0, -100%)",
        };
      }
      break;
    case "east":
      if (sameDirectionHalls.length === 1) {
        return {
          right: "0",
          top: "-0.36rem",
          transform: "translate(0, -100%)",
        };
      }
      if (sameDirectionHalls.length === 2) {
        if (sameDirectionHallIndex === 0) {
          return {
            right: "0",
            top: "-0.36rem",
            transform: "translate(0, -100%)",
          };
        }
        return {
          right: "0",
          bottom: "-0.36rem",
          transform: "translate(0, 100%)",
        };
      }
      break;
    case "west":
    default:
      if (sameDirectionHalls.length === 1) {
        return {
          left: "0",
          top: "-0.36rem",
          transform: "translate(0, -100%)",
        };
      }
      if (sameDirectionHalls.length === 2) {
        if (sameDirectionHallIndex === 0) {
          return {
            left: "0",
            top: "-0.36rem",
            transform: "translate(0, -100%)",
          };
        }
        return {
          left: "0",
          bottom: "-0.36rem",
          transform: "translate(0, 100%)",
        };
      }
      break;
  }

  return { left: "-0.36rem", top: "50%", transform: "translate(-100%, -50%)" };
}

export function LayoutViewport({
  storageLayoutPreset,
  onStorageLayoutPresetChange,
  hallConfigs,
  slotAssignments,
  itemById,
  hallNames,
  sectionNames,
  misNames,
  misSignalStrengths,
  misMultiplicities,
  cursorSlotId,
  cursorMovementHint,
  viewportRef,
  zoom,
  pan,
  subscribeViewportTransform,
  onAdjustZoom,
  onPanViewportBy,
  onFitViewportToBounds,
  onRecenterViewport,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onSlotDragOver,
  onSlotDrop,
  onViewportDropFallback,
  onCursorSlotChange,
  onCursorMisChange,
  onSectionSlicesChange,
  onSectionSideTypeChange,
  onSectionSideRowsChange,
  onSectionSideMisCapacityChange,
  onSectionSideMisRowsChange,
  onSectionSideMisWidthChange,
  onHallNameChange,
  onSectionNameChange,
  onMisNameChange,
  onMisSignalStrengthChange,
  onMisMultiplicityChange,
  onAddSection,
  onRemoveSection,
  onSlotItemDragStart,
  onSlotGroupDragStart,
  onAnyDragEnd,
  onClearSlot,
  draggedSourceSlotIds,
  dragPreviewPlacements,
  selectedSlotIds,
  onSelectionChange,
  onViewModeChange,
}: LayoutViewportProps) {
  const didInitialFit = useRef(false);
  const panLayerRef = useRef<HTMLDivElement | null>(null);
  const zoomLayerRef = useRef<HTMLDivElement | null>(null);
  const pendingTransformRef = useRef<{ pan: { x: number; y: number }; zoom: number } | null>(null);
  const transformRafRef = useRef<number | null>(null);
  const keyboardPanKeysRef = useRef(new Set<"KeyW" | "KeyA" | "KeyS" | "KeyD">());
  const isKeyboardPanBoostedRef = useRef(false);
  const keyboardPanRafRef = useRef<number | null>(null);
  const keyboardPanTimestampRef = useRef<number | null>(null);
  const layoutBoundsRef = useRef<WorldBounds | null>(null);
  const onAdjustZoomRef = useRef(onAdjustZoom);
  const onFitViewportToBoundsRef = useRef(onFitViewportToBounds);
  const onPanViewportByRef = useRef(onPanViewportBy);
  const onRecenterViewportRef = useRef(onRecenterViewport);
  const moveCursorToRenderedSlotRef = useRef<((direction: "up" | "down" | "left" | "right") => void) | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const applyViewportTransform = useCallback((nextPan: { x: number; y: number }, nextZoom: number): void => {
    const panLayer = panLayerRef.current;
    if (panLayer) {
      panLayer.style.transform = `translate3d(${nextPan.x}px, ${nextPan.y}px, 0)`;
    }
    const zoomLayer = zoomLayerRef.current;
    if (zoomLayer) {
      zoomLayer.style.transform = `scale(${nextZoom})`;
    }
  }, []);

  const scheduleViewportTransform = useCallback((nextPan: { x: number; y: number }, nextZoom: number): void => {
    pendingTransformRef.current = { pan: nextPan, zoom: nextZoom };
    if (transformRafRef.current !== null) {
      return;
    }
    transformRafRef.current = window.requestAnimationFrame(() => {
      transformRafRef.current = null;
      const pending = pendingTransformRef.current;
      if (!pending) {
        return;
      }
      pendingTransformRef.current = null;
      applyViewportTransform(pending.pan, pending.zoom);
    });
  }, [applyViewportTransform]);

  useEffect(() => {
    return subscribeViewportTransform((nextState) => {
      scheduleViewportTransform(nextState.pan, nextState.zoom);
    });
  }, [scheduleViewportTransform, subscribeViewportTransform]);

  useEffect(() => {
    applyViewportTransform(pan, zoom);
  }, [applyViewportTransform, pan, zoom]);

  useEffect(() => {
    return () => {
      if (transformRafRef.current !== null) {
        window.cancelAnimationFrame(transformRafRef.current);
        transformRafRef.current = null;
      }
      pendingTransformRef.current = null;
    };
  }, []);

  function resolvePlacementTopLeft(placement: HallPlacement): { left: number; top: number } {
    const match = /translate\(\s*([^)]+?)\s*,\s*([^)]+?)\s*\)/.exec(placement.transform);
    const parseTranslate = (
      raw: string | undefined,
      axisSpan: number,
    ): number => {
      if (!raw) {
        return 0;
      }
      const value = raw.trim();
      if (value.endsWith("%")) {
        const numeric = Number(value.slice(0, -1));
        return Number.isFinite(numeric) ? (numeric / 100) * axisSpan : 0;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    };
    const tx = parseTranslate(match?.[1], placement.width);
    const ty = parseTranslate(match?.[2], placement.height);
    return {
      left: placement.left + tx,
      top: placement.top + ty,
    };
  }

  function blurLayoutConfigIfNeeded(target: EventTarget | null): void {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return;
    }

    const activeInConfig = Boolean(active.closest("[data-layout-config]"));
    const clickInConfig = Boolean(target.closest("[data-layout-config]"));
    if (activeInConfig && !clickInConfig) {
      active.blur();
    }
  }

  const center = STAGE_SIZE / 2;
  const selectionPointerId = useRef<number | null>(null);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [isHintBoxVisible, setIsHintBoxVisible] = useState(false);
  const [viewMode, setViewMode] = useState<LayoutViewMode>("storage");
  const [expandedMisTargets, setExpandedMisTargets] = useState<ExpandedMisTarget[]>([]);
  const hallIds = useMemo(() => Object.keys(hallConfigs).map((key) => Number(key)), [hallConfigs]);

  useEffect(() => {
    onViewModeChange?.(viewMode);
  }, [onViewModeChange, viewMode]);

  useEffect(() => {
    let isCancelled = false;
    const frameId = window.requestAnimationFrame(() => {
      if (isCancelled) {
        return;
      }
      if (readInitialHintVisibility()) {
        setIsHintBoxVisible(true);
      }
    });

    return () => {
      isCancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  const visibleWorldBounds = useMemo<WorldBounds | null>(() => {
    if (zoom <= 0 || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return null;
    }

    return {
      left: -pan.x / zoom,
      top: -pan.y / zoom,
      right: (viewportSize.width - pan.x) / zoom,
      bottom: (viewportSize.height - pan.y) / zoom,
    };
  }, [pan.x, pan.y, viewportSize.height, viewportSize.width, zoom]);

  const viewportBackgroundStyle = useMemo(
    () => ({
      backgroundImage:
        "linear-gradient(90deg, var(--planner-stage-grid-line) 1px, transparent 1px), linear-gradient(var(--planner-stage-grid-line) 1px, transparent 1px), radial-gradient(circle at 20% 16%, var(--planner-stage-radial) 0%, transparent 40%), var(--planner-stage-bg)",
      backgroundSize: "24px 24px, 24px 24px, auto, auto",
    }),
    [],
  );

  const previewBySlot = useMemo(() => {
    const map = new Map<string, { itemId: string; kind: "place" | "swap" }>();
    for (const placement of dragPreviewPlacements) {
      map.set(placement.slotId, {
        itemId: placement.itemId,
        kind: placement.kind,
      });
    }
    return map;
  }, [dragPreviewPlacements]);

  const collectSelectionWithinRect = useCallback(
    (left: number, top: number, right: number, bottom: number): string[] => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return [];
      }

      const viewportRect = viewport.getBoundingClientRect();
      const slots = viewport.querySelectorAll<HTMLElement>("[data-slot-id]");
      const selected: string[] = [];
      const popupPanels = Array.from(
        viewport.querySelectorAll<HTMLElement>("[data-mis-panel]"),
      );
      const intersectsAnyPopup = popupPanels.some((panel) => {
        const panelRect = panel.getBoundingClientRect();
        const panelLeft = panelRect.left - viewportRect.left;
        const panelTop = panelRect.top - viewportRect.top;
        const panelRight = panelLeft + panelRect.width;
        const panelBottom = panelTop + panelRect.height;
        return (
          panelRight >= left &&
          panelLeft <= right &&
          panelBottom >= top &&
          panelTop <= bottom
        );
      });

      for (const slot of slots) {
        const slotId = slot.dataset.slotId;
        if (!slotId || !slotAssignments[slotId]) {
          continue;
        }

        const slotPanel = slot.closest("[data-mis-panel]");
        if (intersectsAnyPopup && !slotPanel) {
          continue;
        }
        if (!intersectsAnyPopup && slotPanel) {
          continue;
        }

        const slotRect = slot.getBoundingClientRect();
        const slotLeft = slotRect.left - viewportRect.left;
        const slotTop = slotRect.top - viewportRect.top;
        const slotRight = slotLeft + slotRect.width;
        const slotBottom = slotTop + slotRect.height;

        const intersects =
          slotRight >= left &&
          slotLeft <= right &&
          slotBottom >= top &&
          slotTop <= bottom;

        if (intersects) {
          selected.push(slotId);
        }
      }

      return selected;
    },
    [slotAssignments, viewportRef],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const syncSize = (): void => {
      const rect = viewport.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    syncSize();

    const resizeObserver = new ResizeObserver(() => {
      syncSize();
    });
    resizeObserver.observe(viewport);

    const preventContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
    };

    viewport.addEventListener("contextmenu", preventContextMenu);
    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("contextmenu", preventContextMenu);
    };
  }, [viewportRef]);

  const updateHallName = useCallback((hallId: HallId, rawName: string): void => {
    onHallNameChange(hallId, rawName);
  }, [onHallNameChange]);

  const hallDisplayName = useCallback(
    (hallId: HallId): string =>
      hallNames[hallId] ??
      getLayoutHallName(storageLayoutPreset, hallId) ??
      defaultHallLabel(hallId),
    [hallNames, storageLayoutPreset],
  );

  const updateSectionName = useCallback((hallId: HallId, sectionIndex: number, rawName: string): void => {
    onSectionNameChange(hallId, sectionIndex, rawName);
  }, [onSectionNameChange]);

  const sectionDisplayName = useCallback(
    (hallId: HallId, sectionIndex: number): string =>
      sectionNames[sectionNameKey(hallId, sectionIndex)] ?? `Section ${sectionIndex + 1}`,
    [sectionNames],
  );

  const updateMisName = useCallback((target: ExpandedMisTarget, rawName: string): void => {
    onMisNameChange(target.hallId, target.slice, target.side, target.row, rawName);
  }, [onMisNameChange]);

  const misDisplayName = useCallback(
    (target: ExpandedMisTarget, fallbackLabel: string): string =>
      misNames[expandedMisKey(target)] ?? fallbackLabel,
    [misNames],
  );

  const misSignalStrength = useCallback(
    (target: ExpandedMisTarget): number =>
      misSignalStrengths[expandedMisKey(target)] ?? DEFAULT_MIS_SIGNAL_STRENGTH,
    [misSignalStrengths],
  );

  const misMultiplicity = useCallback(
    (target: ExpandedMisTarget): number =>
      misMultiplicities[expandedMisKey(target)] ?? DEFAULT_MIS_MULTIPLICITY,
    [misMultiplicities],
  );

  const updateMisSignalStrength = useCallback((
    target: ExpandedMisTarget,
    rawValue: string | number,
  ): void => {
    onMisSignalStrengthChange(target.hallId, target.slice, target.side, target.row, rawValue);
  }, [onMisSignalStrengthChange]);

  const updateMisMultiplicity = useCallback((
    target: ExpandedMisTarget,
    rawValue: string | number,
  ): void => {
    onMisMultiplicityChange(target.hallId, target.slice, target.side, target.row, rawValue);
  }, [onMisMultiplicityChange]);

  const layoutSummary = useMemo(() => {
    let bulkTypes = 0;
    let chestTypes = 0;
    let misTypes = 0;
    let bulkHalls = 0;
    let chestHalls = 0;
    let misHalls = 0;

    for (const hallId of hallIds) {
      const hall = hallConfigs[hallId];
      if (!hall) {
        continue;
      }

      const hallTypes = new Set<HallType>();
      const slices = resolveHallSlices(hall);

      for (const side of [0, 1] as const) {
        const seenMisSlices = new Set<number>();
        for (const slice of slices) {
          const sideConfig = side === 0 ? slice.sideLeft : slice.sideRight;
          hallTypes.add(sideConfig.type);

          if (sideConfig.type === "mis") {
            const misWidth = Math.max(1, sideConfig.misWidth);
            const misSlice = slice.globalSlice - (slice.sectionSlice % misWidth);
            if (seenMisSlices.has(misSlice)) {
              continue;
            }
            seenMisSlices.add(misSlice);
            misTypes += sideConfig.rowsPerSlice * sideConfig.misSlotsPerSlice;
            continue;
          }

          if (sideConfig.type === "bulk") {
            bulkTypes += sideConfig.rowsPerSlice;
          } else if (sideConfig.type === "chest") {
            chestTypes += sideConfig.rowsPerSlice;
          }
        }
      }

      if (hallTypes.has("bulk")) {
        bulkHalls += 1;
      }
      if (hallTypes.has("chest")) {
        chestHalls += 1;
      }
      if (hallTypes.has("mis")) {
        misHalls += 1;
      }
    }

    return {
      totalTypes: bulkTypes + chestTypes + misTypes,
      bulkTypes,
      chestTypes,
      misTypes,
      bulkHalls,
      chestHalls,
      misHalls,
    };
  }, [hallConfigs, hallIds]);

  const hallLayout = useMemo<HallLayoutState>(() => {
    if (viewMode === "flat") {
      const positions = emptyHallPlacements(hallIds);
      const flatLayout = buildFlatLayoutMetrics(hallIds, hallConfigs, center);
      let currentTop = flatLayout.top;
      const leftAlignedX = flatLayout.left;

      for (const hallId of hallIds) {
        const hall = flatLayout.dimensions.find((entry) => entry.hallId === hallId);
        if (!hall) {
          continue;
        }
        positions[hallId] = {
          left: leftAlignedX,
          top: currentTop,
          transform: "translate(0, 0)",
          width: hall.width,
          height: hall.height,
        };
        currentTop += hall.height + FLAT_VIEW_HALL_GAP;
      }

      return {
        positions,
        directions: Object.fromEntries(
          hallIds.map((hallId) => [hallId, "east"]),
        ) as Record<HallId, HallDirection>,
        core: null,
      };
    }
    const resolved = resolveStorageLayout(storageLayoutPreset, hallConfigs, center);
    return {
      positions: resolved.positions,
      directions: resolved.directions,
      core: resolved.core,
    };
  }, [center, hallConfigs, hallIds, storageLayoutPreset, viewMode]);

  const layoutBounds = useMemo(() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    const includeRect = (left: number, top: number, width: number, height: number): void => {
      minX = Math.min(minX, left);
      minY = Math.min(minY, top);
      maxX = Math.max(maxX, left + width);
      maxY = Math.max(maxY, top + height);
    };

    for (const hallId of hallIds) {
      const placement = hallLayout.positions[hallId];
      if (!placement) {
        continue;
      }
      const topLeft = resolvePlacementTopLeft(placement);
      includeRect(topLeft.left, topLeft.top, placement.width, placement.height);
    }

    if (hallLayout.core) {
      includeRect(
        hallLayout.core.left,
        hallLayout.core.top,
        hallLayout.core.width,
        hallLayout.core.height,
      );
    }

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      return null;
    }

    return { left: minX, top: minY, right: maxX, bottom: maxY };
  }, [hallIds, hallLayout]);
  const moveCursorToRenderedSlot = useCallback(
    (direction: "up" | "down" | "left" | "right"): void => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      const allSlots = Array.from(
        viewport.querySelectorAll<HTMLElement>("[data-slot-id]"),
      );
      if (allSlots.length === 0) {
        return;
      }

      const matchingCurrentSlots = cursorSlotId
        ? allSlots.filter((slot) => slot.dataset.slotId === cursorSlotId)
        : [];
      const currentSlot =
        matchingCurrentSlots.find((slot) => Boolean(slot.closest("[data-mis-panel]"))) ??
        matchingCurrentSlots[0] ??
        allSlots[0];
      const currentSlotId = currentSlot.dataset.slotId;
      if (!currentSlotId) {
        return;
      }

      const currentPanel = currentSlot.closest("[data-mis-panel]");
      const candidateSlots = allSlots.filter((slot) => {
        const slotId = slot.dataset.slotId;
        if (!slotId || slotId === currentSlotId) {
          return false;
        }
        const slotPanel = slot.closest("[data-mis-panel]");
        if (currentPanel) {
          return slotPanel === currentPanel;
        }
        return !slotPanel;
      });

      const currentRect = currentSlot.getBoundingClientRect();
      const currentX = currentRect.left + currentRect.width / 2;
      const currentY = currentRect.top + currentRect.height / 2;
      let bestSlotId: string | null = null;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const slot of candidateSlots) {
        const slotId = slot.dataset.slotId;
        if (!slotId) {
          continue;
        }

        const rect = slot.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - currentX;
        const dy = rect.top + rect.height / 2 - currentY;
        let primary = 0;
        let perpendicular = 0;
        switch (direction) {
          case "up":
            primary = -dy;
            perpendicular = Math.abs(dx);
            break;
          case "down":
            primary = dy;
            perpendicular = Math.abs(dx);
            break;
          case "left":
            primary = -dx;
            perpendicular = Math.abs(dy);
            break;
          case "right":
            primary = dx;
            perpendicular = Math.abs(dy);
            break;
        }

        if (primary <= 1) {
          continue;
        }

        const score = primary * primary + perpendicular * perpendicular * 2.5;
        if (score < bestScore) {
          bestScore = score;
          bestSlotId = slotId;
        }
      }

      if (bestSlotId) {
        onCursorSlotChange(bestSlotId);
      }
    },
    [cursorSlotId, onCursorSlotChange, viewportRef],
  );

  useEffect(() => {
    layoutBoundsRef.current = layoutBounds;
    onAdjustZoomRef.current = onAdjustZoom;
    onFitViewportToBoundsRef.current = onFitViewportToBounds;
    onPanViewportByRef.current = onPanViewportBy;
    onRecenterViewportRef.current = onRecenterViewport;
    moveCursorToRenderedSlotRef.current = moveCursorToRenderedSlot;
  }, [
    layoutBounds,
    moveCursorToRenderedSlot,
    onAdjustZoom,
    onFitViewportToBounds,
    onPanViewportBy,
    onRecenterViewport,
  ]);

  useEffect(() => {
    if (didInitialFit.current || !layoutBounds) {
      return;
    }
    onFitViewportToBounds(layoutBounds, 24);
    didInitialFit.current = true;
  }, [layoutBounds, onFitViewportToBounds]);

  useEffect(() => {
    const PAN_SPEED = 620;
    const PAN_SHIFT_MULTIPLIER = 2.4;
    const ZOOM_STEP = 0.2;
    const panKeys = keyboardPanKeysRef.current;
    const resolvePanKey = (event: KeyboardEvent): "KeyW" | "KeyA" | "KeyS" | "KeyD" | null => {
      switch (event.code) {
        case "KeyW":
        case "KeyA":
        case "KeyS":
        case "KeyD":
          return event.code;
        default:
          return null;
      }
    };

    const stopKeyboardPan = (): void => {
      if (keyboardPanRafRef.current !== null) {
        window.cancelAnimationFrame(keyboardPanRafRef.current);
        keyboardPanRafRef.current = null;
      }
      keyboardPanTimestampRef.current = null;
    };

    const runKeyboardPan = (timestamp: number): void => {
      const previousTimestamp = keyboardPanTimestampRef.current;
      keyboardPanTimestampRef.current = timestamp;
      const elapsedSeconds =
        previousTimestamp === null ? 1 / 60 : Math.min(0.05, (timestamp - previousTimestamp) / 1000);
      const panSpeed = PAN_SPEED * (isKeyboardPanBoostedRef.current ? PAN_SHIFT_MULTIPLIER : 1);

      let dx = 0;
      let dy = 0;
      if (panKeys.has("KeyW")) {
        dy += panSpeed * elapsedSeconds;
      }
      if (panKeys.has("KeyS")) {
        dy -= panSpeed * elapsedSeconds;
      }
      if (panKeys.has("KeyA")) {
        dx += panSpeed * elapsedSeconds;
      }
      if (panKeys.has("KeyD")) {
        dx -= panSpeed * elapsedSeconds;
      }

      if (dx !== 0 || dy !== 0) {
        onPanViewportByRef.current(dx, dy, "throttled");
        keyboardPanRafRef.current = window.requestAnimationFrame(runKeyboardPan);
        return;
      }

      stopKeyboardPan();
    };

    const startKeyboardPan = (): void => {
      if (keyboardPanRafRef.current !== null) {
        return;
      }
      keyboardPanRafRef.current = window.requestAnimationFrame(runKeyboardPan);
    };

    function handleViewerKeyDown(event: KeyboardEvent): void {
      if (event.key === "Shift") {
        isKeyboardPanBoostedRef.current = true;
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (shouldIgnoreViewerShortcut(event.target)) {
        return;
      }
      const panKey = resolvePanKey(event);
      if (event.shiftKey && !panKey) {
        return;
      }
      if (panKey) {
        event.preventDefault();
        isKeyboardPanBoostedRef.current = event.shiftKey;
        panKeys.add(panKey);
        startKeyboardPan();
        return;
      }

      switch (event.key) {
        case " ":
        case "Spacebar":
          event.preventDefault();
          if (layoutBoundsRef.current) {
            onFitViewportToBoundsRef.current(layoutBoundsRef.current, 24);
          } else {
            onRecenterViewportRef.current();
          }
          break;
        case "q":
        case "Q":
          event.preventDefault();
          onAdjustZoomRef.current(-ZOOM_STEP);
          break;
        case "e":
        case "E":
          event.preventDefault();
          onAdjustZoomRef.current(ZOOM_STEP);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveCursorToRenderedSlotRef.current?.("up");
          break;
        case "ArrowDown":
          event.preventDefault();
          moveCursorToRenderedSlotRef.current?.("down");
          break;
        case "ArrowLeft":
          event.preventDefault();
          moveCursorToRenderedSlotRef.current?.("left");
          break;
        case "ArrowRight":
          event.preventDefault();
          moveCursorToRenderedSlotRef.current?.("right");
          break;
      }
    }

    function handleViewerKeyUp(event: KeyboardEvent): void {
      const panKey = resolvePanKey(event);
      if (panKey) {
        panKeys.delete(panKey);
        return;
      }

      switch (event.key) {
        case "Shift":
          isKeyboardPanBoostedRef.current = false;
          break;
      }
    }

    function handleWindowBlur(): void {
      panKeys.clear();
      isKeyboardPanBoostedRef.current = false;
      stopKeyboardPan();
    }

    window.addEventListener("keydown", handleViewerKeyDown);
    window.addEventListener("keyup", handleViewerKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleViewerKeyDown);
      window.removeEventListener("keyup", handleViewerKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
      panKeys.clear();
      isKeyboardPanBoostedRef.current = false;
      stopKeyboardPan();
    };
  }, []);

  const expandedMisPanels = useMemo<ExpandedMisPanel[]>(() => {
    return expandedMisTargets
      .map((target) => {
        const hall = hallConfigs[target.hallId];
        if (!hall) {
          return null;
        }
        const slice = resolveHallSlices(hall).find((entry) => entry.globalSlice === target.slice);
        if (!slice) {
          return null;
        }
        const sideConfig = target.side === 0 ? slice.sideLeft : slice.sideRight;
        if (sideConfig.type !== "mis" || target.row >= sideConfig.rowsPerSlice) {
          return null;
        }
        const misWidth = Math.max(1, sideConfig.misWidth);
        const fallbackLabel = `MIS ${Math.floor(slice.sectionSlice / misWidth) + 1}`;
        const slotIds = Array.from(
          { length: sideConfig.misSlotsPerSlice },
          (_, index) => misSlotId(target.hallId, target.slice, target.side, target.row, index),
        );
        const assignedItems = slotIds
          .map((slotId) => slotAssignments[slotId])
          .filter((itemId): itemId is string => Boolean(itemId))
          .map((itemId) => ({
            maxStackSize: itemById.get(itemId)?.maxStackSize ?? 64,
            count: misMultiplicity(target),
          }));
        const columns =
          sideConfig.misSlotsPerSlice % 9 === 0
            ? 9
            : Math.min(12, Math.max(6, Math.ceil(Math.sqrt(sideConfig.misSlotsPerSlice))));
        return {
          ...target,
          slotIds,
          columns,
          capacity: sideConfig.misSlotsPerSlice,
          fallbackLabel,
          signalStrength: misSignalStrength(target),
          multiplicity: misMultiplicity(target),
          assignedItems,
        };
      })
      .filter((panel): panel is ExpandedMisPanel => panel !== null);
  }, [expandedMisTargets, hallConfigs, itemById, misMultiplicity, misSignalStrength, slotAssignments]);

  const popupColumnsBySlotId = useMemo(() => {
    const map = new Map<string, number>();
    for (const panel of expandedMisPanels) {
      for (const slotId of panel.slotIds) {
        map.set(slotId, panel.columns);
      }
    }
    return map;
  }, [expandedMisPanels]);

  const popupNextSlotIdBySlotId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const panel of expandedMisPanels) {
      for (let index = 0; index < panel.slotIds.length; index += 1) {
        const slotId = panel.slotIds[index];
        map.set(slotId, panel.slotIds[index + 1] ?? null);
      }
    }
    return map;
  }, [expandedMisPanels]);

  const toggleExpandedMis = useCallback((target: ExpandedMisTarget): void => {
    const targetKey = expandedMisKey(target);
    setExpandedMisTargets((current) => {
      const existingIndex = current.findIndex(
        (entry) => expandedMisKey(entry) === targetKey,
      );
      if (existingIndex >= 0) {
        return current.filter((_, index) => index !== existingIndex);
      }
      if (current.length < 2) {
        return [...current, target];
      }
      return [current[1], target];
    });
  }, []);

  function renderSlot(
    slotId: string,
    slotTintClassName?: string,
    useHallDirectionMapping = true,
    placementOptions?: { preferFirstEmptyMisSlot?: boolean },
  ): ReactNode {
    const assignedItemId = slotAssignments[slotId];
    const assignedItem = assignedItemId ? itemById.get(assignedItemId) : undefined;
    const isDraggedSource = draggedSourceSlotIds.has(slotId);
    const preview = previewBySlot.get(slotId);
    const previewItemId = preview?.itemId;
    const previewItem = previewItemId ? itemById.get(previewItemId) : undefined;
    const showPreviewItem = Boolean(previewItem);
    const isDropTarget = showPreviewItem;
    const isSwapPreview = preview?.kind === "swap";
    const showAssignedItem = Boolean(assignedItem) && !showPreviewItem && !isDraggedSource;
    const isSelected = selectedSlotIds.has(slotId) && Boolean(assignedItem);
    const isCursorSlot = cursorSlotId === slotId;
    const slotMovementHint =
      isCursorSlot && cursorMovementHint?.fromSlotId === slotId ? cursorMovementHint : null;
    const displayMovementHint = useHallDirectionMapping
      ? slotMovementHint
      : isCursorSlot
        ? buildPopupCursorHint(
          slotId,
          "popup",
          popupColumnsBySlotId,
          popupNextSlotIdBySlotId,
        )
        : null;

    const indicatorHallDirections = useHallDirectionMapping
      ? hallLayout.directions
      : ({} as Record<HallId, HallDirection>);

    return (
      <button
        key={slotId}
        type="button"
        className={`relative z-0 grid h-8.5 w-8.5 cursor-pointer place-items-center overflow-visible rounded-[0.45rem] border p-0 transition hover:z-20 hover:-translate-y-px ${isSelected
          ? "hover:shadow-[0_0_0_2px_rgba(37,99,235,0.55)] dark:hover:shadow-[0_0_0_2px_rgba(96,165,250,0.6)]"
          : "hover:shadow-[0_3px_8px_rgba(57,47,30,0.22)] dark:hover:shadow-[0_3px_10px_rgba(5,8,16,0.5)]"
          } ${assignedItem
            ? "border-[rgba(40,102,110,0.62)] bg-[linear-gradient(145deg,rgba(237,253,249,0.95)_0%,rgba(205,235,226,0.95)_100%)] dark:border-[rgba(83,173,153,0.62)] dark:bg-[linear-gradient(145deg,rgba(24,72,66,0.95)_0%,rgba(20,55,58,0.95)_100%)]"
            : "border-[rgba(108,89,62,0.35)] bg-[linear-gradient(145deg,rgba(245,233,216,0.95)_0%,rgba(231,212,184,0.95)_100%)] dark:border-[rgba(107,131,163,0.45)] dark:bg-[linear-gradient(145deg,rgba(38,54,77,0.95)_0%,rgba(27,40,59,0.95)_100%)]"
          } ${isDropTarget
            ? isSwapPreview
              ? "border-[rgba(194,65,12,0.92)] shadow-[0_0_0_2px_rgba(251,146,60,0.45)]"
              : "border-[rgba(22,132,120,0.92)] shadow-[0_0_0_2px_rgba(85,204,178,0.38)]"
            : ""
          } ${isSelected ? "shadow-[0_0_0_2px_rgba(37,99,235,0.55)]" : ""} ${isCursorSlot ? "z-20 shadow-[0_0_0_2px_rgba(217,119,6,0.9)] border-[rgba(180,83,9,0.86)]" : ""}`}
        draggable={Boolean(assignedItem)}
        onPointerDown={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            return;
          }

          if (event.button === 2) {
            event.preventDefault();
            event.stopPropagation();
            onClearSlot(slotId);
          }
        }}
        onPointerEnter={(event) => {
          if ((event.buttons & 2) === 2) {
            event.preventDefault();
            onClearSlot(slotId);
          }
        }}
        onDragStart={(event) => {
          if (event.shiftKey || !assignedItemId) {
            event.preventDefault();
            return;
          }
          onSlotItemDragStart(event, slotId, assignedItemId);
        }}
        onClick={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }

          if (!assignedItem) {
            onCursorSlotChange(slotId);
            if (selectedSlotIds.size > 0) {
              onSelectionChange([]);
            }
            event.stopPropagation();
            return;
          }

          if (selectedSlotIds.size === 0) {
            return;
          }

          const nextSelection = new Set(selectedSlotIds);
          if (nextSelection.has(slotId)) {
            nextSelection.delete(slotId);
          } else {
            nextSelection.add(slotId);
          }
          onSelectionChange(Array.from(nextSelection));

          event.stopPropagation();
        }}
        onDragEnd={onAnyDragEnd}
        onDragOver={(event) => {
          event.stopPropagation();
          onSlotDragOver(event, slotId, placementOptions);
        }}
        onDrop={(event) => {
          event.stopPropagation();
          onSlotDrop(event, slotId, placementOptions);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onClearSlot(slotId);
        }}
        data-slot
        data-slot-id={slotId}
        title={
          assignedItem
            ? `${toTitle(assignedItem.id)} (right click to clear)`
            : "Drop item here"
        }
      >
        {slotTintClassName ? (
          <span
            className={`pointer-events-none absolute inset-0 z-0 rounded-[0.35rem] ${slotTintClassName}`}
          />
        ) : null}
        {showAssignedItem && assignedItem ? (
          <Image
            src={assignedItem.texturePath}
            alt={assignedItem.id}
            width={22}
            height={22}
            className="pointer-events-none relative z-1"
            style={{ imageRendering: "pixelated" }}
            draggable={false}
            unoptimized
          />
        ) : null}
        {showPreviewItem ? (
          <div
            className={`pointer-events-none absolute inset-0 z-1 ${isSwapPreview
              ? showAssignedItem
                ? "bg-[rgba(251,146,60,0.2)]"
                : "bg-[rgba(251,146,60,0.32)]"
              : showAssignedItem
                ? "bg-[rgba(45,212,191,0.2)]"
                : "bg-[rgba(45,212,191,0.3)]"
              }`}
          />
        ) : null}
        {showPreviewItem && previewItem ? (
          <Image
            src={previewItem.texturePath}
            alt={previewItem.id}
            width={22}
            height={22}
            className={`pointer-events-none absolute inset-0 z-2 m-auto ${showAssignedItem ? "opacity-40" : "opacity-[0.72]"
              }`}
            style={{ imageRendering: "pixelated" }}
            draggable={false}
            unoptimized
          />
        ) : null}
        {isCursorSlot ? (
          <span className="pointer-events-none absolute -right-[0.12rem] -top-[0.12rem] z-3 h-[0.45rem] w-[0.45rem] rounded-full border border-[rgba(120,53,15,0.9)] bg-[rgba(245,158,11,0.96)]" />
        ) : null}
        {displayMovementHint ? (
          <CursorMovementIndicator
            hint={displayMovementHint}
            hallDirections={indicatorHallDirections}
          />
        ) : null}
      </button>
    );
  }

  function renderPopupSlot(slotId: string): ReactNode {
    return renderSlot(slotId, undefined, false, { preferFirstEmptyMisSlot: false });
  }

  function renderHallContent(
    hallId: HallId,
    config: HallConfig,
    layoutDirection: HallDirection,
    orientation: "horizontal" | "vertical",
    hallTopLeft: { left: number; top: number },
    visibleBounds: WorldBounds | null,
    hallWidth: number,
    hallHeight: number,
  ): ReactNode {
    const slices = resolveHallSlices(config);
    const flipMainAxis = layoutDirection === "north" || layoutDirection === "west";
    const swapSidesForDirection = layoutDirection === "south" || layoutDirection === "west";
    const visualSlices = flipMainAxis ? [...slices].reverse() : slices;
    const mainSpan =
      slices.length === 0
        ? SLOT_SIZE
        : slices[slices.length - 1].mainStart + slices[slices.length - 1].mainSize;
    const mapMainStart = (start: number, size: number): number =>
      flipMainAxis ? mainSpan - (start + size) : start;

    let maxLeftDepth = 0;
    let maxRightDepth = 0;
    for (const slice of slices) {
      maxLeftDepth = Math.max(maxLeftDepth, sideDepthPx(slice.sideLeft));
      maxRightDepth = Math.max(maxRightDepth, sideDepthPx(slice.sideRight));
    }
    const crossAxisStartDepth = swapSidesForDirection ? maxRightDepth : maxLeftDepth;
    const crossAxisEndDepth = swapSidesForDirection ? maxLeftDepth : maxRightDepth;
    const aisleSpan = Math.max(8, hallWidth - maxLeftDepth - maxRightDepth);
    const aisleCenterX = crossAxisStartDepth + aisleSpan / 2;
    const sectionRanges = config.sections
      .map((section, sectionIndex) => {
        const sectionSlices = slices.filter((slice) => slice.sectionIndex === sectionIndex);
        if (sectionSlices.length === 0) {
          return null;
        }
        const first = sectionSlices[0];
        const last = sectionSlices[sectionSlices.length - 1];
        const sectionMainSize = last.mainStart + last.mainSize - first.mainStart;
        const start = mapMainStart(first.mainStart, sectionMainSize);
        return {
          sectionIndex,
          name: sectionDisplayName(hallId, sectionIndex),
          start,
          end: start + sectionMainSize,
          size: sectionMainSize,
          rawStart: first.mainStart,
        };
      })
      .filter(
        (entry): entry is {
          sectionIndex: number;
          name: string;
          start: number;
          end: number;
          size: number;
          rawStart: number;
        } =>
          entry !== null,
      );

    const slots: ReactNode[] = [];
    const isLocalRectVisible = (
      localLeft: number,
      localTop: number,
      width: number,
      height: number,
    ): boolean => {
      if (!visibleBounds) {
        return true;
      }
      const left = hallTopLeft.left + localLeft;
      const top = hallTopLeft.top + localTop;
      const right = left + width;
      const bottom = top + height;
      return (
        right >= visibleBounds.left - VISIBILITY_OVERSCAN &&
        left <= visibleBounds.right + VISIBILITY_OVERSCAN &&
        bottom >= visibleBounds.top - VISIBILITY_OVERSCAN &&
        top <= visibleBounds.bottom + VISIBILITY_OVERSCAN
      );
    };
    const reverseCrossAxisForDirection = layoutDirection === "south" || layoutDirection === "west";
    for (const slice of visualSlices) {
      for (const side of [0, 1] as const) {
        const sideConfig = side === 0 ? slice.sideLeft : slice.sideRight;
        const sideDepth = sideDepthPx(sideConfig);
        const visualSide = swapSidesForDirection ? (side === 0 ? 1 : 0) : side;

        if (sideConfig.type === "mis") {
          const misWidth = Math.max(1, sideConfig.misWidth);
          const groupStartSectionSlice = Math.floor(slice.sectionSlice / misWidth) * misWidth;
          if (slice.sectionSlice !== groupStartSectionSlice) {
            continue;
          }
          const groupSlices = slices.filter(
            (entry) =>
              entry.sectionIndex === slice.sectionIndex &&
              entry.sectionSlice >= groupStartSectionSlice &&
              entry.sectionSlice < groupStartSectionSlice + misWidth,
          );
          const groupFirstSlice = groupSlices[0] ?? slice;
          const groupLastSlice = groupSlices[groupSlices.length - 1] ?? slice;
          const misSlice = groupFirstSlice.globalSlice;
          const misMainStart = mapMainStart(
            groupFirstSlice.mainStart,
            groupLastSlice.mainStart + groupLastSlice.mainSize - groupFirstSlice.mainStart,
          );
          const misMainSize = groupLastSlice.mainStart + groupLastSlice.mainSize - groupFirstSlice.mainStart;
          const misGroupNumber = Math.floor(groupStartSectionSlice / misWidth) + 1;
          Array.from({ length: sideConfig.rowsPerSlice }, (_, row) => {
            const unitSlotIds = Array.from(
              { length: sideConfig.misSlotsPerSlice },
              (_, index) => misSlotId(hallId, misSlice, side, row, index),
            );
            const assignedIds = unitSlotIds
              .map((slotId) => slotAssignments[slotId])
              .filter((itemId): itemId is string => Boolean(itemId));
            const previewEntries = unitSlotIds
              .map((slotId) => {
                const preview = previewBySlot.get(slotId);
                if (preview?.itemId) {
                  return {
                    itemId: preview.itemId,
                    previewKind: preview.kind,
                  };
                }
                if (draggedSourceSlotIds.has(slotId)) {
                  return undefined;
                }
                const assigned = slotAssignments[slotId];
                return assigned
                  ? {
                    itemId: assigned,
                    previewKind: null,
                  }
                  : undefined;
              })
              .filter(
                (
                  entry,
                ): entry is {
                  itemId: string;
                  previewKind: "place" | "swap" | null;
                } => Boolean(entry),
              );
            const hasAssigned = assignedIds.length > 0;
            const hasPreview = unitSlotIds.some((slotId) => previewBySlot.has(slotId));
            const hasSwapPreview = unitSlotIds.some(
              (slotId) => previewBySlot.get(slotId)?.kind === "swap",
            );
            const firstSlot = unitSlotIds[0];
            const nextEmptySlot =
              unitSlotIds.find((slotId) => !slotAssignments[slotId]) ?? firstSlot;
            const misTarget: ExpandedMisTarget = {
              hallId,
              slice: misSlice,
              side,
              row,
            };
            const misTargetKey = expandedMisKey(misTarget);
            const assignedItems = assignedIds.map((itemId) => ({
              maxStackSize: itemById.get(itemId)?.maxStackSize ?? 64,
              count: misMultiplicity(misTarget),
            }));
            const isMisInvalid = calculateMisComparatorPrimer(
              sideConfig.misSlotsPerSlice,
              misSignalStrength(misTarget),
              assignedItems,
            ).isOverThreshold;
            const expandedIndex = expandedMisTargets.findIndex(
              (entry) => expandedMisKey(entry) === misTargetKey,
            );
            const misCardSurfaceClass =
              expandedIndex === 0
                ? "border-[rgba(18,125,87,0.95)] bg-[linear-gradient(180deg,rgba(209,247,229,0.98)_0%,rgba(180,237,213,0.98)_100%)] dark:border-[rgba(83,173,153,0.82)] dark:bg-[linear-gradient(180deg,rgba(23,72,66,0.96)_0%,rgba(19,59,56,0.96)_100%)]"
                : expandedIndex === 1
                  ? "border-[rgba(50,91,168,0.95)] bg-[linear-gradient(180deg,rgba(220,235,255,0.98)_0%,rgba(193,218,250,0.98)_100%)] dark:border-[rgba(106,143,206,0.82)] dark:bg-[linear-gradient(180deg,rgba(25,44,74,0.96)_0%,rgba(20,35,60,0.96)_100%)]"
                  : "border-[rgba(73,97,78,0.45)] bg-[linear-gradient(180deg,rgba(244,250,240,0.95)_0%,rgba(221,235,212,0.95)_100%)] dark:border-[rgba(103,128,161,0.45)] dark:bg-[linear-gradient(180deg,rgba(30,48,66,0.94)_0%,rgba(25,41,58,0.94)_100%)]";
            const misCardPreviewClass = hasPreview
              ? hasSwapPreview
                ? "shadow-[0_0_0_2px_rgba(251,146,60,0.45)] border-[rgba(194,65,12,0.92)]"
                : "shadow-[0_0_0_2px_rgba(85,204,178,0.38)] border-[rgba(22,132,120,0.92)]"
              : "";
            const misCardCursorClass = cursorSlotId && unitSlotIds.includes(cursorSlotId)
              ? "shadow-[0_0_0_2px_rgba(217,119,6,0.85)] border-[rgba(180,83,9,0.9)]"
              : "";
            const misCardMovementHint =
              cursorMovementHint && unitSlotIds.includes(cursorMovementHint.fromSlotId)
                ? cursorMovementHint
                : null;
            const isSingleSliceMis = misWidth === 1 && orientation === "horizontal";
            const misCardLayoutClass = isSingleSliceMis
              ? "grid-cols-[0.62rem_1fr] grid-rows-[auto_1fr] gap-x-[0.02rem] gap-y-[0.04rem]"
              : "grid-rows-[auto_auto_1fr] gap-[0.04rem]";
            const misTitleContainerClass = isSingleSliceMis
              ? "col-start-1 row-start-2 mt-[0.08rem] flex min-h-0 min-w-0 items-center justify-center leading-none text-[0.5rem] font-bold text-[#355039] dark:text-[#b9e0d4]"
              : "leading-none text-[0.5rem] font-bold text-[#355039] dark:text-[#b9e0d4]";
            const misTitleClass = isSingleSliceMis
              ? "block max-h-full max-w-[0.62rem] overflow-hidden text-ellipsis whitespace-nowrap rounded-[0.18rem] px-0 py-0 text-center normal-case [writing-mode:vertical-rl] rotate-180 focus:bg-[rgba(255,255,255,0.92)] focus:outline-none dark:focus:bg-[rgba(31,45,64,0.95)]"
              : "inline-block min-w-[1.6rem] rounded-[0.18rem] px-[0.06rem] text-center normal-case focus:bg-[rgba(255,255,255,0.92)] focus:outline-none dark:focus:bg-[rgba(31,45,64,0.95)]";
            const misCountClass = isSingleSliceMis
              ? "col-span-2 col-start-1 row-start-1 flex min-w-0 items-center justify-center gap-[0.12rem] text-center leading-none text-[0.48rem] font-semibold text-[#33524f] dark:text-[#a4cfd1]"
              : "flex items-center gap-[0.12rem] leading-none text-[0.48rem] font-semibold text-[#33524f] dark:text-[#a4cfd1]";
            const misPreviewClass = isSingleSliceMis
              ? "col-start-2 row-start-2 grid content-start gap-0.5"
              : "grid content-start gap-0.5";

            if (orientation === "horizontal") {
              const unitCrossSize = 112;
              const baseTop = visualSide === 0 ? 0 : hallHeight - sideDepth;
              const visualMisRow = reverseCrossAxisForDirection
                ? sideConfig.rowsPerSlice - 1 - row
                : row;
              const x = misMainStart + 2;
              const y = baseTop + visualMisRow * (unitCrossSize + SLOT_GAP) + 2;
              const cardWidth = Math.max(12, misMainSize - 4);
              const cardHeight = Math.max(42, unitCrossSize - 4);
              if (!isLocalRectVisible(x, y, cardWidth, cardHeight)) {
                return;
              }
              const previewLayout = misPreviewLayout(
                isSingleSliceMis ? cardWidth - 10 : cardWidth,
                cardHeight,
              );
              const previewColumns = previewLayout.columns;
              slots.push(
                <div
                  key={`${hallId}:mcard:${slice.globalSlice}:${side}:${row}`}
                  className={`absolute grid ${misCardLayoutClass} overflow-visible rounded-[0.45rem] border p-[0.16rem] ${misCardSurfaceClass} ${misCardPreviewClass} ${misCardCursorClass}`}
                  style={{ left: x, top: y, width: cardWidth, height: cardHeight }}
                  data-no-pan
                  data-mis-card
                  draggable={hasAssigned}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    if (event.shiftKey || !hasAssigned) {
                      event.preventDefault();
                      return;
                    }
                    event.stopPropagation();
                    onSlotGroupDragStart(event, unitSlotIds, firstSlot);
                  }}
                  onDragEnd={onAnyDragEnd}
                  onDragOver={(event) => onSlotDragOver(event, nextEmptySlot)}
                  onDrop={(event) => onSlotDrop(event, nextEmptySlot)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCursorMisChange(misTarget.hallId, misTarget.slice, misTarget.side, misTarget.row);
                    toggleExpandedMis(misTarget);
                  }}
                >
                  {misCardMovementHint ? (
                    <CursorMovementIndicator
                      hint={misCardMovementHint}
                      hallDirections={hallLayout.directions}
                    />
                  ) : null}
                  <div className={misTitleContainerClass}>
                    <span
                      className={misTitleClass}
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      tabIndex={0}
                      title="Click to rename MIS"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) =>
                        updateMisName(misTarget, event.currentTarget.textContent ?? "")
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    >{misDisplayName(misTarget, `MIS ${misGroupNumber}`)}</span>
                  </div>
                  <div className={misCountClass}>
                    <span>{previewEntries.length}/{sideConfig.misSlotsPerSlice}</span>
                    {isMisInvalid ? (
                      <span className="text-[#b42318] dark:text-[#ff9a8d]">*Invalid</span>
                    ) : null}
                  </div>
                  <div
                    className={misPreviewClass}
                    style={{ gridTemplateColumns: `repeat(${previewColumns}, 16px)` }}
                  >
                    {previewEntries
                      .slice(0, previewLayout.maxItems)
                      .map((entry, previewIndex) => {
                        const item = itemById.get(entry.itemId);
                        if (!item) {
                          return null;
                        }
                        return (
                          <div
                            key={`${hallId}-mis-preview-${slice.globalSlice}-${side}-${row}-${entry.itemId}-${previewIndex}`}
                            className={`grid h-4 w-4 place-items-center overflow-hidden rounded-[0.2rem] border ${entry.previewKind === "swap"
                              ? "border-[rgba(194,65,12,0.55)] bg-[rgba(255,233,213,0.92)] dark:border-[rgba(222,139,96,0.7)] dark:bg-[rgba(92,53,31,0.85)]"
                              : entry.previewKind === "place"
                                ? "border-[rgba(22,132,120,0.55)] bg-[rgba(203,246,236,0.92)] dark:border-[rgba(83,173,153,0.7)] dark:bg-[rgba(24,72,66,0.85)]"
                                : "border-[rgba(56,89,84,0.28)] bg-[rgba(236,249,245,0.8)] dark:border-[rgba(103,128,161,0.45)] dark:bg-[rgba(29,46,67,0.78)]"
                              }`}
                          >
                            <Image
                              src={item.texturePath}
                              alt={item.id}
                              width={14}
                              height={14}
                              className={entry.previewKind ? "opacity-[0.72]" : ""}
                              style={{ imageRendering: "pixelated" }}
                              draggable={false}
                              unoptimized
                            />
                          </div>
                        );
                      })}
                  </div>
                </div>,
              );
            } else {
              const unitCrossSize = 112;
              const baseLeft = visualSide === 0 ? 0 : hallWidth - sideDepth;
              const visualMisRow = reverseCrossAxisForDirection
                ? sideConfig.rowsPerSlice - 1 - row
                : row;
              const x = baseLeft + visualMisRow * (unitCrossSize + SLOT_GAP) + 2;
              const y = misMainStart + 2;
              const cardWidth = Math.max(42, unitCrossSize - 4);
              const cardHeight = Math.max(12, misMainSize - 4);
              if (!isLocalRectVisible(x, y, cardWidth, cardHeight)) {
                return;
              }
              const previewLayout = misPreviewLayout(
                isSingleSliceMis ? cardWidth - 10 : cardWidth,
                cardHeight,
              );
              const previewColumns = previewLayout.columns;
              slots.push(
                <div
                  key={`${hallId}:mcard:${slice.globalSlice}:${side}:${row}`}
                  className={`absolute grid ${misCardLayoutClass} overflow-visible rounded-[0.45rem] border p-[0.16rem] ${misCardSurfaceClass} ${misCardPreviewClass} ${misCardCursorClass}`}
                  style={{ left: x, top: y, width: cardWidth, height: cardHeight }}
                  data-no-pan
                  data-mis-card
                  draggable={hasAssigned}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    if (event.shiftKey || !hasAssigned) {
                      event.preventDefault();
                      return;
                    }
                    event.stopPropagation();
                    onSlotGroupDragStart(event, unitSlotIds, firstSlot);
                  }}
                  onDragEnd={onAnyDragEnd}
                  onDragOver={(event) => onSlotDragOver(event, nextEmptySlot)}
                  onDrop={(event) => onSlotDrop(event, nextEmptySlot)}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCursorMisChange(misTarget.hallId, misTarget.slice, misTarget.side, misTarget.row);
                    toggleExpandedMis(misTarget);
                  }}
                >
                  {misCardMovementHint ? (
                    <CursorMovementIndicator
                      hint={misCardMovementHint}
                      hallDirections={hallLayout.directions}
                    />
                  ) : null}
                  <div className={misTitleContainerClass}>
                    <span
                      className={misTitleClass}
                      contentEditable
                      suppressContentEditableWarning
                      role="textbox"
                      tabIndex={0}
                      title="Click to rename MIS"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={(event) =>
                        updateMisName(misTarget, event.currentTarget.textContent ?? "")
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    >{misDisplayName(misTarget, `MIS ${misGroupNumber}`)}</span>
                  </div>
                  <div className={misCountClass}>
                    <span>{previewEntries.length}/{sideConfig.misSlotsPerSlice}</span>
                    {isMisInvalid ? (
                      <span className="text-[#b42318] dark:text-[#ff9a8d]">*Invalid</span>
                    ) : null}
                  </div>
                  <div
                    className={misPreviewClass}
                    style={{ gridTemplateColumns: `repeat(${previewColumns}, 16px)` }}
                  >
                    {previewEntries
                      .slice(0, previewLayout.maxItems)
                      .map((entry, previewIndex) => {
                        const item = itemById.get(entry.itemId);
                        if (!item) {
                          return null;
                        }
                        return (
                          <div
                            key={`${hallId}-mis-preview-${slice.globalSlice}-${side}-${row}-${entry.itemId}-${previewIndex}`}
                            className={`grid h-4 w-4 place-items-center overflow-hidden rounded-[0.2rem] border ${entry.previewKind === "swap"
                              ? "border-[rgba(194,65,12,0.55)] bg-[rgba(255,233,213,0.92)] dark:border-[rgba(222,139,96,0.7)] dark:bg-[rgba(92,53,31,0.85)]"
                              : entry.previewKind === "place"
                                ? "border-[rgba(22,132,120,0.55)] bg-[rgba(203,246,236,0.92)] dark:border-[rgba(83,173,153,0.7)] dark:bg-[rgba(24,72,66,0.85)]"
                                : "border-[rgba(56,89,84,0.28)] bg-[rgba(236,249,245,0.8)] dark:border-[rgba(103,128,161,0.45)] dark:bg-[rgba(29,46,67,0.78)]"
                              }`}
                          >
                            <Image
                              src={item.texturePath}
                              alt={item.id}
                              width={14}
                              height={14}
                              className={entry.previewKind ? "opacity-[0.72]" : ""}
                              style={{ imageRendering: "pixelated" }}
                              draggable={false}
                              unoptimized
                            />
                          </div>
                        );
                      })}
                  </div>
                </div>,
              );
            }
          });
          continue;
        }

        for (let row = 0; row < sideConfig.rowsPerSlice; row += 1) {
          const slotKey = nonMisSlotId(hallId, slice.globalSlice, side, row);
          const sectionTheme = resolveSectionVisualTheme(slice.sectionIndex);
          const visualRow = reverseCrossAxisForDirection
            ? sideConfig.rowsPerSlice - 1 - row
            : row;
          const mainStart = mapMainStart(slice.mainStart, slice.mainSize);
          if (orientation === "horizontal") {
            const baseTop = visualSide === 0 ? 0 : hallHeight - sideDepth;
            const x = mainStart + (slice.mainSize - SLOT_SIZE) / 2;
            const y = baseTop + visualRow * (SLOT_SIZE + SLOT_GAP);
            if (!isLocalRectVisible(x, y, SLOT_SIZE, SLOT_SIZE)) {
              continue;
            }
            slots.push(
              <div key={slotKey} className="absolute" style={{ left: x, top: y }}>
                {renderSlot(slotKey, sectionTheme.slotTintClassName)}
              </div>,
            );
          } else {
            const baseLeft = visualSide === 0 ? 0 : hallWidth - sideDepth;
            const x = baseLeft + visualRow * (SLOT_SIZE + SLOT_GAP);
            const y = mainStart + (slice.mainSize - SLOT_SIZE) / 2;
            if (!isLocalRectVisible(x, y, SLOT_SIZE, SLOT_SIZE)) {
              continue;
            }
            slots.push(
              <div key={slotKey} className="absolute" style={{ left: x, top: y }}>
                {renderSlot(slotKey, sectionTheme.slotTintClassName)}
              </div>,
            );
          }
        }
      }
    }

    return (
      <>
        {orientation === "horizontal" ? (
          <div
            className="absolute left-0 right-0 rounded-[99px] bg-[linear-gradient(180deg,rgba(45,119,127,0.18)_0%,rgba(45,119,127,0.08)_100%)] dark:bg-[linear-gradient(180deg,rgba(84,137,185,0.24)_0%,rgba(84,137,185,0.12)_100%)]"
            style={{
              top: crossAxisStartDepth,
              height: Math.max(8, hallHeight - crossAxisStartDepth - crossAxisEndDepth),
            }}
          />
        ) : (
          <div
            className="absolute top-0 bottom-0 rounded-[99px] bg-[linear-gradient(180deg,rgba(45,119,127,0.18)_0%,rgba(45,119,127,0.08)_100%)] dark:bg-[linear-gradient(180deg,rgba(84,137,185,0.24)_0%,rgba(84,137,185,0.12)_100%)]"
            style={{
              left: crossAxisStartDepth,
              width: Math.max(8, hallWidth - crossAxisStartDepth - crossAxisEndDepth),
            }}
          />
        )}
        {sectionRanges.length > 0 ? sectionRanges.map((section, index) => {
          const theme = resolveSectionVisualTheme(section.sectionIndex);
          const center = section.start + (section.end - section.start) / 2;
          const boundary =
            index > 0
              ? flipMainAxis
                ? mainSpan - (section.rawStart - SLOT_GAP / 2)
                : section.rawStart - SLOT_GAP / 2
              : null;
          const sectionSpan = Math.max(10, section.size - 3);
          if (orientation === "horizontal") {
            return (
              <div key={`${hallId}:section:${index}`} className="pointer-events-none absolute inset-0">
                <div
                  className={`absolute rounded-[0.65rem] border ${theme.areaClassName}`}
                  style={{
                    left: section.start + 1.5,
                    top: 1.5,
                    width: sectionSpan,
                    height: Math.max(8, hallHeight - 3),
                  }}
                />
                {boundary !== null ? (
                  <div
                    className={`absolute w-0.5 rounded-full ${SECTION_DIVIDER_CLASS_NAME}`}
                    style={{ left: boundary - 1, top: 1, height: Math.max(6, hallHeight - 2) }}
                  />
                ) : null}
                <div
                  className={`pointer-events-auto absolute flex -translate-x-1/2 items-center gap-[0.12rem] rounded-[0.32rem] border px-[0.22rem] py-[0.06rem] text-[0.5rem] font-bold tracking-[0.03em] ${theme.labelClassName}`}
                  style={{ left: center, top: crossAxisStartDepth + 2 }}
                  data-no-pan
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <span
                    className={`inline-grid h-[0.78rem] min-w-[0.78rem] place-items-center rounded-[0.2rem] border text-[0.45rem] leading-none ${theme.indexChipClassName}`}
                  >
                    {section.sectionIndex + 1}
                  </span>
                  <span
                    className={`inline-block min-w-[2.1rem] whitespace-nowrap rounded-[0.2rem] px-[0.1rem] text-center normal-case focus:bg-[rgba(255,255,255,0.92)] focus:outline-none dark:focus:bg-[rgba(31,45,64,0.95)] ${theme.titleClassName}`}
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    tabIndex={0}
                    title="Click to rename section"
                    onBlur={(event) =>
                      updateSectionName(hallId, section.sectionIndex, event.currentTarget.textContent ?? "")
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                  >
                    {section.name}
                  </span>
                </div>
              </div>
            );
          }
          return (
            <div key={`${hallId}:section:${index}`} className="pointer-events-none absolute inset-0">
              <div
                className={`absolute rounded-[0.65rem] border ${theme.areaClassName}`}
                style={{
                  left: 1.5,
                  top: section.start + 1.5,
                  width: Math.max(8, hallWidth - 3),
                  height: sectionSpan,
                }}
              />
              {boundary !== null ? (
                <div
                  className={`absolute h-0.5 rounded-full ${SECTION_DIVIDER_CLASS_NAME}`}
                  style={{ left: 1, top: boundary - 1, width: Math.max(6, hallWidth - 2) }}
                />
              ) : null}
              <div
                className={`pointer-events-auto absolute flex -translate-x-1/2 -translate-y-1/2 -rotate-90 items-center gap-[0.12rem] rounded-[0.32rem] border px-[0.22rem] py-[0.06rem] text-[0.5rem] font-bold tracking-[0.03em] ${theme.labelClassName}`}
                style={{ left: aisleCenterX, top: center }}
                data-no-pan
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <span
                  className={`inline-grid h-[0.78rem] min-w-[0.78rem] place-items-center rounded-[0.2rem] border text-[0.45rem] leading-none ${theme.indexChipClassName}`}
                >
                  {section.sectionIndex + 1}
                </span>
                <span
                  className={`inline-block min-w-[2.1rem] whitespace-nowrap rounded-[0.2rem] px-[0.1rem] text-center normal-case focus:bg-[rgba(255,255,255,0.92)] focus:outline-none dark:focus:bg-[rgba(31,45,64,0.95)] ${theme.titleClassName}`}
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  tabIndex={0}
                  title="Click to rename section"
                  onBlur={(event) =>
                    updateSectionName(hallId, section.sectionIndex, event.currentTarget.textContent ?? "")
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                >
                  {section.name}
                </span>
              </div>
            </div>
          );
        }) : null}
        {slots}
      </>
    );
  }

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 flex-1 cursor-grab select-none overflow-hidden touch-none active:cursor-grabbing"
      style={viewportBackgroundStyle}
      onClickCapture={(event) => {
        if (event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const clickedViewportBackground =
          !target.closest("[data-mis-panel]") &&
          !target.closest("[data-mis-card]") &&
          !target.closest("[data-no-pan]");
        if (clickedViewportBackground) {
          setExpandedMisTargets([]);
        }

        if (event.shiftKey || selectedSlotIds.size === 0) {
          return;
        }
        if (target.closest("[data-slot-id]")) {
          return;
        }

        onSelectionChange([]);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        onViewportDropFallback(event);
      }}
      onPointerDown={(event) => {
        blurLayoutConfigIfNeeded(event.target);

        const didStartPan = onPointerDown(event);
        if (didStartPan || event.button !== 0 || !event.shiftKey) {
          return;
        }

        const target = event.target as HTMLElement;
        const inNoPanArea = Boolean(target.closest("[data-no-pan]"));
        const inMisPanel = Boolean(target.closest("[data-mis-panel]"));
        if (inNoPanArea && !inMisPanel) {
          return;
        }

        if (!viewportRef.current) {
          return;
        }

        const viewportRect = viewportRef.current.getBoundingClientRect();
        const x = event.clientX - viewportRect.left;
        const y = event.clientY - viewportRect.top;

        selectionPointerId.current = event.pointerId;
        selectionStart.current = { x, y };
        setSelectionBox({ left: x, top: y, width: 0, height: 0 });
        onSelectionChange([]);

        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        onPointerMove(event);

        if (
          selectionPointerId.current === null ||
          selectionPointerId.current !== event.pointerId ||
          !selectionStart.current ||
          !viewportRef.current
        ) {
          return;
        }

        const viewportRect = viewportRef.current.getBoundingClientRect();
        const x = event.clientX - viewportRect.left;
        const y = event.clientY - viewportRect.top;
        const left = Math.min(selectionStart.current.x, x);
        const top = Math.min(selectionStart.current.y, y);
        const right = Math.max(selectionStart.current.x, x);
        const bottom = Math.max(selectionStart.current.y, y);

        setSelectionBox({
          left,
          top,
          width: right - left,
          height: bottom - top,
        });

        const nextSelection = collectSelectionWithinRect(left, top, right, bottom);
        onSelectionChange(nextSelection);
      }}
      onPointerUp={(event) => {
        onPointerEnd(event);

        if (
          selectionPointerId.current !== null &&
          selectionPointerId.current === event.pointerId
        ) {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          selectionPointerId.current = null;
          selectionStart.current = null;
          setSelectionBox(null);
        }
      }}
      onPointerCancel={(event) => {
        onPointerEnd(event);

        if (
          selectionPointerId.current !== null &&
          selectionPointerId.current === event.pointerId
        ) {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          selectionPointerId.current = null;
          selectionStart.current = null;
          setSelectionBox(null);
        }
      }}
    >
      {isHintBoxVisible ? (
        <button
          type="button"
          className="absolute bottom-4 left-4 z-20 grid cursor-pointer gap-[0.1rem] rounded-[0.55rem] border border-[rgba(134,105,67,0.35)] bg-[rgba(255,252,245,0.92)] px-[0.55rem] py-[0.45rem] text-left text-[0.72rem] leading-[1.3] text-[#6d6256] dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(22,34,50,0.92)] dark:text-[#9eb3d1]"
          data-no-pan
          title="Click to dismiss tips"
          onClick={(event) => {
            event.stopPropagation();
            setIsHintBoxVisible(false);
            try {
              window.localStorage.setItem(LAYOUT_HINT_DISMISSED_STORAGE_KEY, "1");
            } catch {
              // Ignore storage access issues.
            }
          }}
        >
          <div>Mouse wheel to zoom</div>
          <div>Drag to pan</div>
          <div>Shift + drag to box-select slots</div>
          <div>Right-click a placed slot to clear</div>
        </button>
      ) : null}

      <div className="absolute left-4 top-4 z-20 grid gap-[0.45rem]" data-no-pan>
        <div className="grid gap-[0.28rem] rounded-[0.65rem] border border-[rgba(121,96,62,0.35)] bg-[rgba(255,250,239,0.92)] p-[0.45rem] text-[0.68rem] text-[#4f4639] dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(21,33,49,0.9)] dark:text-[#b7c9e2]">

          <div className="font-semibold text-[#3a332b] dark:text-[#e2edff]">
            Total Types: {layoutSummary.totalTypes}
          </div>
          <div className="grid grid-cols-3 gap-[0.2rem]">
            <div className="grid justify-items-center rounded-[0.35rem] border border-[rgba(137,107,67,0.28)] bg-[rgba(255,255,255,0.62)] px-[0.2rem] py-[0.14rem] text-center dark:border-[rgba(104,128,160,0.45)] dark:bg-[rgba(31,45,64,0.85)]">
              <span>Bulk</span>
              <span className="font-semibold text-[#2f5f4a] dark:text-[#9fe1cb]">{layoutSummary.bulkTypes}</span>
            </div>
            <div className="grid justify-items-center rounded-[0.35rem] border border-[rgba(137,107,67,0.28)] bg-[rgba(255,255,255,0.62)] px-[0.2rem] py-[0.14rem] text-center dark:border-[rgba(104,128,160,0.45)] dark:bg-[rgba(31,45,64,0.85)]">
              <span>Chest</span>
              <span className="font-semibold text-[#2f5f4a] dark:text-[#9fe1cb]">{layoutSummary.chestTypes}</span>
            </div>
            <div className="grid justify-items-center rounded-[0.35rem] border border-[rgba(137,107,67,0.28)] bg-[rgba(255,255,255,0.62)] px-[0.2rem] py-[0.14rem] text-center dark:border-[rgba(104,128,160,0.45)] dark:bg-[rgba(31,45,64,0.85)]">
              <span>MIS</span>
              <span className="font-semibold text-[#2f5f4a] dark:text-[#9fe1cb]">{layoutSummary.misTypes}</span>
            </div>
          </div>
        </div>

        <div className="grid gap-[0.35rem] rounded-[0.65rem] border border-[rgba(121,96,62,0.35)] bg-[rgba(255,250,239,0.92)] p-[0.45rem] dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(21,33,49,0.9)]">
          <div className="text-[0.72rem] font-semibold uppercase tracking-[0.04em] text-[#5e513f] dark:text-[#a6b9d5]">
            Layout Options
          </div>
          <select
            className="min-w-[8.2rem] rounded-[0.42rem] border border-[rgba(123,98,66,0.48)] bg-[rgba(255,255,255,0.92)] px-[0.45rem] py-[0.22rem] text-[0.7rem] font-semibold text-[#3b2f22] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,45,64,0.95)] dark:text-[#d8e4f8]"
            value={storageLayoutPreset}
            onChange={(event) =>
              onStorageLayoutPresetChange(event.target.value as StorageLayoutPreset)
            }
          >
            <option value="single">Single Layout</option>
            <option value="double">Double Layout</option>
            <option value="triple">Triple Layout</option>
            <option value="cross">Cross Layout</option>
            <option value="h">H Layout</option>
            <option value="hcross">H-Cross Layout</option>
            <option value="octa">Octa Layout</option>
          </select>
        </div>
      </div>

      <div className="absolute right-4 top-4 z-20 grid justify-items-end gap-[0.45rem]" data-no-pan>
        <div className="grid gap-[0.45rem]">
          <div className="grid gap-[0.35rem] rounded-[0.65rem] border border-[rgba(121,96,62,0.35)] bg-[rgba(255,250,239,0.92)] p-[0.45rem] dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(21,33,49,0.9)]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`rounded-[0.4rem] border px-[0.42rem] py-[0.2rem] text-[0.68rem] font-semibold ${viewMode === "storage"
                  ? "border-[rgba(33,114,82,0.58)] bg-[rgba(226,253,239,0.96)] text-[#245342] dark:border-[rgba(83,173,153,0.65)] dark:bg-[rgba(23,72,66,0.9)] dark:text-[#c2f3e8]"
                  : "border-[rgba(123,98,66,0.48)] bg-[rgba(255,255,255,0.92)] text-[#3b2f22] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,45,64,0.92)] dark:text-[#d4e2f5]"
                  }`}
                onClick={() => {
                  if (viewMode === "storage") {
                    return;
                  }
                  setViewMode("storage");
                  onRecenterViewport();
                }}
              >
                Storage View
              </button>
              <button
                type="button"
                className={`rounded-[0.4rem] border px-[0.42rem] py-[0.2rem] text-[0.68rem] font-semibold ${viewMode === "flat"
                  ? "border-[rgba(33,114,82,0.58)] bg-[rgba(226,253,239,0.96)] text-[#245342] dark:border-[rgba(83,173,153,0.65)] dark:bg-[rgba(23,72,66,0.9)] dark:text-[#c2f3e8]"
                  : "border-[rgba(123,98,66,0.48)] bg-[rgba(255,255,255,0.92)] text-[#3b2f22] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,45,64,0.92)] dark:text-[#d4e2f5]"
                  }`}
                onClick={() => {
                  if (viewMode === "flat") {
                    return;
                  }
                  const flatLayout = buildFlatLayoutMetrics(hallIds, hallConfigs, center);
                  setViewMode("flat");
                  const controlAnchorX = flatLayout.left + Math.min(180, flatLayout.maxWidth * 0.22);
                  onRecenterViewport({
                    x: controlAnchorX,
                    y: flatLayout.top + flatLayout.totalHeight / 2,
                  });
                }}
              >
                Flat View
              </button>
            </div>
          </div>
        </div>

        <div
          className="w-fit justify-self-end flex items-center gap-[0.45rem] rounded-full border border-[rgba(134,105,67,0.35)] bg-[rgba(255,250,239,0.92)] px-[0.45rem] py-1 dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(21,33,49,0.9)]"
        >
          <button
            type="button"
            className="h-[1.6rem] w-[1.6rem] cursor-pointer rounded-full border border-[rgba(132,101,64,0.5)] bg-white text-[1rem] leading-none text-[#2b2b2b] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,45,64,0.95)] dark:text-[#d8e4f8]"
            onClick={() => onAdjustZoom(0.2)}
          >
            +
          </button>
          <span className="min-w-[2.8rem] text-center text-[0.76rem] font-bold text-[#6d6256] dark:text-[#a6b9d5]">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="h-[1.6rem] w-[1.6rem] cursor-pointer rounded-full border border-[rgba(132,101,64,0.5)] bg-white text-[1rem] leading-none text-[#2b2b2b] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,45,64,0.95)] dark:text-[#d8e4f8]"
            onClick={() => onAdjustZoom(-0.2)}
          >
            -
          </button>
        </div>
      </div>

      <ExpandedMisPanelsOverlay
        panels={expandedMisPanels}
        slotAssignments={slotAssignments}
        onSlotGroupDragStart={onSlotGroupDragStart}
        onAnyDragEnd={onAnyDragEnd}
        onClosePanel={(target) =>
          setExpandedMisTargets((current) =>
            current.filter((entry) => expandedMisKey(entry) !== expandedMisKey(target)),
          )
        }
        onRenameMis={updateMisName}
        onSignalStrengthChange={updateMisSignalStrength}
        onMultiplicityChange={updateMisMultiplicity}
        misDisplayName={misDisplayName}
        renderSlot={renderPopupSlot}
      />

      <div
        ref={panLayerRef}
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
        }}
      >
        <div
          ref={zoomLayerRef}
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: `${STAGE_SIZE}px`,
            height: `${STAGE_SIZE}px`,
            transform: `scale(${zoom})`,
          }}
          data-storage-canvas
        >
          {viewMode === "storage" && hallLayout.core ? (
            <div
              className="absolute grid place-items-center rounded-[1.1rem] border-2 border-dashed border-[rgba(41,86,92,0.7)] bg-[repeating-linear-gradient(-45deg,rgba(186,225,222,0.45)_0,rgba(186,225,222,0.45)_8px,rgba(210,234,231,0.6)_8px,rgba(210,234,231,0.6)_16px)] text-[0.875rem] font-bold uppercase tracking-[0.08em] text-[#18444c] dark:border-[rgba(86,148,170,0.72)] dark:bg-[repeating-linear-gradient(-45deg,rgba(41,82,102,0.46)_0,rgba(41,82,102,0.46)_8px,rgba(30,62,84,0.62)_8px,rgba(30,62,84,0.62)_16px)] dark:text-[#cfe9ff]"
              style={{
                width: `${hallLayout.core.width}px`,
                height: `${hallLayout.core.height}px`,
                left: `${hallLayout.core.left}px`,
                top: `${hallLayout.core.top}px`,
              }}
            >
              {hallLayout.core.label}
            </div>
          ) : null}

          {hallIds.map((hallId) => {
            const hall = hallConfigs[hallId];
            const orientation =
              viewMode === "flat"
                ? "horizontal"
                : directionOrientation(hallLayout.directions[hallId]);
            const placement = hallLayout.positions[hallId];
            const layoutDirection = hallLayout.directions[hallId];
            const hallTopLeft = resolvePlacementTopLeft(placement);
            const hallVisible =
              !visibleWorldBounds ||
              (hallTopLeft.left + placement.width >= visibleWorldBounds.left - VISIBILITY_OVERSCAN &&
                hallTopLeft.left <= visibleWorldBounds.right + VISIBILITY_OVERSCAN &&
                hallTopLeft.top + placement.height >= visibleWorldBounds.top - VISIBILITY_OVERSCAN &&
                hallTopLeft.top <= visibleWorldBounds.bottom + VISIBILITY_OVERSCAN);
            if (!hallVisible) {
              return null;
            }
            const controlAnchorStyle = resolveHallControlAnchorStyle(
              viewMode,
              hallIds,
              hallLayout.directions,
              hallId,
              layoutDirection,
            );

            return (
              <section
                key={hallId}
                className="absolute rounded-[0.85rem] border border-[rgba(72,64,52,0.4)] bg-[rgba(255,250,240,0.8)] shadow-[0_5px_15px_rgba(42,34,20,0.12)] dark:border-[rgba(106,128,158,0.52)] dark:bg-[rgba(22,35,53,0.86)] dark:shadow-[0_8px_20px_rgba(5,9,17,0.45)]"
                data-hall-section
                style={{
                  left: `${placement.left}px`,
                  top: `${placement.top}px`,
                  transform: placement.transform,
                  width: `${placement.width}px`,
                  height: `${placement.height}px`,
                }}
                onDrop={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <HallConfigPanel
                  hallId={hallId}
                  hall={hall}
                  anchorStyle={controlAnchorStyle}
                  hallDisplayName={hallDisplayName(hallId)}
                  onHallNameChange={updateHallName}
                  onAddSection={onAddSection}
                  onRemoveSection={onRemoveSection}
                  onSectionSlicesChange={onSectionSlicesChange}
                  onSectionSideTypeChange={onSectionSideTypeChange}
                  onSectionSideRowsChange={onSectionSideRowsChange}
                  onSectionSideMisCapacityChange={onSectionSideMisCapacityChange}
                  onSectionSideMisRowsChange={onSectionSideMisRowsChange}
                  onSectionSideMisWidthChange={onSectionSideMisWidthChange}
                />

                {renderHallContent(
                  hallId,
                  hall,
                  layoutDirection,
                  orientation,
                  hallTopLeft,
                  visibleWorldBounds,
                  placement.width,
                  placement.height,
                )}
              </section>
            );
          })}
        </div>
      </div>

      {selectionBox ? (
        <div
          className="pointer-events-none absolute z-40 border border-[rgba(37,99,235,0.9)] bg-[rgba(37,99,235,0.18)] dark:border-[rgba(96,165,250,0.95)] dark:bg-[rgba(96,165,250,0.22)]"
          style={{
            left: `${selectionBox.left}px`,
            top: `${selectionBox.top}px`,
            width: `${selectionBox.width}px`,
            height: `${selectionBox.height}px`,
          }}
        />
      ) : null}
    </div>
  );
}
