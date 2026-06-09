"use client";

import Image from "next/image";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ItemLibraryPanel } from "./components/ItemLibraryPanel";
import { LayoutViewport } from "./components/LayoutViewport";
import {
  type PlannerSaveFile,
  type PlannerSnapshot,
  SAVE_FILE_VERSION,
  buildPlannerSnapshot,
  cloneHallConfigs,
  cloneFilterExportConfig,
  cloneSlotAssignments,
  createDefaultFilterExportConfig,
  parsePlannerSnapshot,
  snapshotToKey,
} from "./lib/plannerSnapshot";
import { useCatalog } from "./hooks/useCatalog";
import { useHallConfigs, type HallSideKey } from "./hooks/useHallConfigs";
import { useLayoutAssignments } from "./hooks/useLayoutAssignments";
import { usePlannerHistory } from "./hooks/usePlannerHistory";
import { usePlannerLabelNames } from "./hooks/usePlannerLabelNames";
import { useViewportNavigation } from "./hooks/useViewportNavigation";
import {
  type PlannerAutosaveDraft,
  clearPlannerAutosaveDraft,
  loadPlannerAutosaveDraft,
  savePlannerAutosaveDraft,
} from "./lib/plannerDraftStore";
import {
  LITEMATIC_EXPORT_OPTIONS,
  exportLayoutAsLitematic,
  type LayoutExportMode,
} from "./lib/layoutExport";
import { exportLayoutAsCsv } from "./lib/layoutCsvExport";
import type {
  FillDirection,
  FilterExportHallSettings,
  FilterExportItemType,
  FilterExportSettings,
  FilterExportType,
  HallId,
  HallType,
} from "./types";
import {
  buildInitialHallConfigs,
  getLayoutHallName,
  type StorageLayoutPreset,
} from "./layoutConfig";
import {
  buildOrderedSlotIds,
  calculateMisComparatorPrimer,
  misSlotId,
  resolveHallSlices,
} from "./utils";
import { withBasePath } from "./base-path";

const TOOLBAR_BUTTON_CLASS =
  "cursor-pointer rounded-[0.35rem] bg-transparent px-[0.46rem] py-[0.2rem] text-[0.8rem] font-semibold text-[#3b2f22] hover:text-[#241c14] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(122,99,66,0.35)] disabled:cursor-not-allowed disabled:opacity-45 dark:text-[#cad9ef] dark:hover:text-[#eff6ff] dark:focus-visible:ring-[rgba(148,163,184,0.45)]";
const AUTOSAVE_DEBOUNCE_MS = 800;
const LAYOUT_NAME_PLACEHOLDER = "Untitled Layout";
const FILTER_EXPORT_MODE: LayoutExportMode = "filters";

const FILTER_EXPORT_CHOICES: readonly {
  value: FilterExportType;
  label: string;
  disabled?: boolean;
}[] = [
  { value: "ssi_ss2", label: "SSI/SS2" },
  { value: "ss3", label: "SS3" },
  { value: "box_sorters", label: "Box sorters" },
];
const FILTER_EXPORT_ITEM_TYPES: readonly {
  value: FilterExportItemType;
  label: string;
}[] = [
  { value: "chest", label: "Chest" },
  { value: "bulk", label: "Bulk" },
];
const FILTER_MIS_SIGNAL_STRENGTH_VALUES = Array.from({ length: 14 }, (_, index) => index + 2);
const FILTER_MIS_MULTIPLICITY_VALUES = Array.from({ length: 14 }, (_, index) => index + 1);

function shouldIgnoreHistoryHotkeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function isEditableElement(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  return (
    element.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

function formatAutosaveTimestamp(savedAt: string): string {
  const date = new Date(savedAt);
  if (Number.isFinite(date.getTime())) {
    return date.toLocaleString();
  }
  return savedAt;
}

function toFilenameSegment(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "planner-layout";
}

function hasFileTransfer(dataTransfer: DataTransfer | null): dataTransfer is DataTransfer {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

function isPlannerJsonFile(file: File): boolean {
  return file.type === "application/json" || file.name.toLowerCase().endsWith(".json");
}

function getPlannerJsonFile(fileList: FileList): File | null {
  return Array.from(fileList).find(isPlannerJsonFile) ?? null;
}

function isSupportedFilterExportChoice(value: FilterExportType): value is FilterExportType {
  return value === "ssi_ss2" || value === "ss3" || value === "box_sorters";
}

export function PlannerApp() {
  const { catalogItems, catalogGameVersion, isLoadingCatalog, catalogError } = useCatalog();
  const {
    storageLayoutPreset,
    hallConfigs,
    applyLayoutPreset,
    setLayoutState,
    setSectionSlices,
    setSectionSideType,
    setSectionSideRows,
    setSectionSideMisCapacity,
    setSectionSideMisRows,
    setSectionSideMisWidth,
    addHallSection,
    removeHallSection,
  } = useHallConfigs();
  const [fillDirection, setFillDirection] = useState<FillDirection>("row");
  const {
    itemById,
    activeSlotAssignments,
    usedItemIds,
    cursorSlotId,
    cursorMovementHint,
    selectedSlotIdSet,
    draggedSourceSlotIdSet,
    dragPreviews,
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
  } = useLayoutAssignments({
    catalogItems,
    hallConfigs,
    fillDirection,
  });
  const {
    labelNames,
    replaceLabelNames,
    handleLayoutNameChange,
    handleHallNameChange,
    handleSectionNameChange,
    handleMisNameChange,
  } = usePlannerLabelNames();
  const {
    viewportRef,
    zoom,
    pan,
    subscribeViewportTransform,
    adjustZoom,
    panBy,
    fitViewportToBounds,
    recenterViewport,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
  } = useViewportNavigation();
  const [pendingLayoutChange, setPendingLayoutChange] = useState<{
    preset: StorageLayoutPreset;
    removedCount: number;
  } | null>(null);
  const [pendingAutosaveRestore, setPendingAutosaveRestore] = useState<PlannerAutosaveDraft | null>(
    null,
  );
  const [isAutosaveRestoreResolved, setIsAutosaveRestoreResolved] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isExportingLayout, setIsExportingLayout] = useState(false);
  const [isFilterExportDialogOpen, setIsFilterExportDialogOpen] = useState(false);
  const [isInvalidMisExportDialogOpen, setIsInvalidMisExportDialogOpen] = useState(false);
  const [filterExportConfig, setFilterExportConfig] = useState(createDefaultFilterExportConfig);
  const [filterExportPage, setFilterExportPage] = useState<"defaults" | HallId>("defaults");
  const [layoutViewMode, setLayoutViewMode] = useState<"storage" | "flat">("storage");
  const openFileInputRef = useRef<HTMLInputElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const autosaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const plannerSnapshot = useMemo<PlannerSnapshot>(
    () =>
      buildPlannerSnapshot({
        storageLayoutPreset,
        fillDirection,
        hallConfigs,
        slotAssignments: activeSlotAssignments,
        labelNames,
        filterExportConfig,
      }),
    [
      activeSlotAssignments,
      fillDirection,
      filterExportConfig,
      hallConfigs,
      labelNames,
      storageLayoutPreset,
    ],
  );
  const plannerSnapshotKey = useMemo(
    () => snapshotToKey(plannerSnapshot),
    [plannerSnapshot],
  );
  const hallIds = useMemo(
    () => Object.keys(hallConfigs).map((key) => Number(key)).sort((a, b) => a - b),
    [hallConfigs],
  );
  const misExportValidation = useMemo(() => {
    const invalidKeys = new Set<string>();
    const signalStrengthByKey = new Map<string, number>();
    for (const hallId of hallIds) {
      const hallConfig = hallConfigs[hallId];
      if (!hallConfig) {
        continue;
      }
      const hallFilterSettings = filterExportConfig.halls[hallId] ?? {};
      const misSignalStrength =
        hallFilterSettings.misSignalStrength ?? filterExportConfig.defaults.misSignalStrength;
      const misMultiplicity =
        hallFilterSettings.misMultiplicity ?? filterExportConfig.defaults.misMultiplicity;
      const slices = resolveHallSlices(hallConfig);
      for (const side of [0, 1] as const) {
        for (const slice of slices) {
          const sideConfig = side === 0 ? slice.sideLeft : slice.sideRight;
          if (sideConfig.type !== "mis") {
            continue;
          }
          const misWidth = Math.max(1, sideConfig.misWidth);
          const groupStartSectionSlice = Math.floor(slice.sectionSlice / misWidth) * misWidth;
          if (slice.sectionSlice !== groupStartSectionSlice) {
            continue;
          }
          const groupFirstSlice = slices.find(
            (entry) =>
              entry.sectionIndex === slice.sectionIndex &&
              entry.sectionSlice >= groupStartSectionSlice &&
              entry.sectionSlice < groupStartSectionSlice + misWidth,
          ) ?? slice;
          const misSlice = groupFirstSlice.globalSlice;
          for (let row = 0; row < sideConfig.rowsPerSlice; row += 1) {
            const misKey = `${hallId}:${misSlice}:${side}:${row}`;
            signalStrengthByKey.set(misKey, misSignalStrength);
            const assignedItems = Array.from(
              { length: sideConfig.misSlotsPerSlice },
              (_, index) => activeSlotAssignments[misSlotId(hallId, misSlice, side, row, index)],
            )
              .filter((itemId): itemId is string => Boolean(itemId))
              .map((itemId) => itemById.get(itemId))
              .filter((item): item is NonNullable<typeof item> => Boolean(item))
              .map((item) => ({
                maxStackSize: item.maxStackSize,
                count: misMultiplicity,
              }));
            if (assignedItems.length === 0) {
              continue;
            }
            const primer = calculateMisComparatorPrimer(
              sideConfig.misSlotsPerSlice,
              misSignalStrength,
              assignedItems,
            );
            if (primer.isOverThreshold) {
              invalidKeys.add(misKey);
            }
          }
        }
      }
    }
    return {
      invalidKeys,
      signalStrengthByKey,
    };
  }, [activeSlotAssignments, filterExportConfig, hallConfigs, hallIds, itemById]);
  const invalidMisExportKeys = misExportValidation.invalidKeys;
  const misExportSignalStrengthByKey = misExportValidation.signalStrengthByKey;

  useEffect(() => {
    if (typeof filterExportPage === "number" && !hallIds.includes(filterExportPage)) {
      setFilterExportPage("defaults");
    }
  }, [filterExportPage, hallIds]);

  type ApplySnapshotOptions = {
    recenter?: boolean;
  };

  const applySnapshot = useCallback(
    (snapshot: PlannerSnapshot, options?: ApplySnapshotOptions) => {
      setPendingLayoutChange(null);
      clearDragState();
      setSelectedSlotIds([]);
      setFillDirection(snapshot.fillDirection);
      setLayoutState(snapshot.storageLayoutPreset, cloneHallConfigs(snapshot.hallConfigs));
      const snapshotOrderedSlotIds = buildOrderedSlotIds(
        snapshot.hallConfigs,
        snapshot.fillDirection,
      );
      replaceSlotAssignments(cloneSlotAssignments(snapshot.slotAssignments), {
        validSlotIds: new Set(snapshotOrderedSlotIds),
        orderedSlotIds: snapshotOrderedSlotIds,
      });
      replaceLabelNames(snapshot.labelNames);
      const filterExportConfig = cloneFilterExportConfig(snapshot.filterExportConfig);
      setFilterExportConfig(filterExportConfig);
      setFilterExportPage("defaults");
      if (options?.recenter ?? true) {
        recenterViewport();
      }
    },
    [
      clearDragState,
      recenterViewport,
      replaceLabelNames,
      replaceSlotAssignments,
      setLayoutState,
      setSelectedSlotIds,
    ],
  );

  const applyHistorySnapshot = useCallback(
    (snapshot: PlannerSnapshot) => {
      applySnapshot(snapshot, { recenter: false });
    },
    [applySnapshot],
  );

  const { canUndo, canRedo, undo, redo, getHistoryState, restoreHistoryState } = usePlannerHistory({
    snapshot: plannerSnapshot,
    snapshotKey: plannerSnapshotKey,
    onApplySnapshot: applyHistorySnapshot,
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== "z") {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      if (shouldIgnoreHistoryHotkeys(event.target)) {
        return;
      }

      event.preventDefault();
      if (event.shiftKey) {
        if (canRedo) {
          redo();
        }
        return;
      }

      if (canUndo) {
        undo();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [canRedo, canUndo, redo, undo]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent): void => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !isEditableElement(active)) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (active === target || active.contains(target)) {
        return;
      }

      if (target instanceof HTMLElement && isEditableElement(target)) {
        return;
      }

      active.blur();
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    };
  }, []);

  useEffect(() => {
    if (!isExportMenuOpen) {
      return;
    }

    function handleDocumentPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (exportMenuRef.current?.contains(target)) {
        return;
      }
      setIsExportMenuOpen(false);
    }

    function handleDocumentKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setIsExportMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [isExportMenuOpen]);

  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      try {
        const draft = await loadPlannerAutosaveDraft();
        if (isCancelled) {
          return;
        }
        if (draft && draft.history.entries.length > 0) {
          setPendingAutosaveRestore(draft);
        } else {
          if (draft) {
            void clearPlannerAutosaveDraft().catch(() => {
              // Ignore clear failures and continue without prompting.
            });
          }
          setIsAutosaveRestoreResolved(true);
        }
      } catch {
        if (!isCancelled) {
          setIsAutosaveRestoreResolved(true);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (autosaveTimeoutRef.current !== null) {
        clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isAutosaveRestoreResolved || pendingAutosaveRestore) {
      return;
    }

    const historyState = getHistoryState();
    if (!historyState) {
      return;
    }
    if (historyState.entries.length === 0) {
      return;
    }

    if (autosaveTimeoutRef.current !== null) {
      clearTimeout(autosaveTimeoutRef.current);
    }

    autosaveTimeoutRef.current = setTimeout(() => {
      autosaveTimeoutRef.current = null;
      void savePlannerAutosaveDraft({
        savedAt: new Date().toISOString(),
        snapshot: plannerSnapshot,
        history: getHistoryState() ?? historyState,
      }).catch(() => {
        // Ignore autosave failures (storage can be unavailable in some browser modes).
      });
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (autosaveTimeoutRef.current !== null) {
        clearTimeout(autosaveTimeoutRef.current);
        autosaveTimeoutRef.current = null;
      }
    };
  }, [
    getHistoryState,
    isAutosaveRestoreResolved,
    pendingAutosaveRestore,
    plannerSnapshot,
    plannerSnapshotKey,
  ]);

  function handleSectionSlicesChange(hallId: HallId, sectionIndex: number, value: string): void {
    setSectionSlices(hallId, sectionIndex, value);
  }

  function handleSectionSideTypeChange(
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    type: HallType,
  ): void {
    setSectionSideType(hallId, sectionIndex, side, type);
  }

  function handleSectionSideRowsChange(
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ): void {
    setSectionSideRows(hallId, sectionIndex, side, value);
  }

  function handleSectionSideMisCapacityChange(
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ): void {
    setSectionSideMisCapacity(hallId, sectionIndex, side, value);
  }

  function handleSectionSideMisRowsChange(
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ): void {
    setSectionSideMisRows(hallId, sectionIndex, side, value);
  }

  function handleSectionSideMisWidthChange(
    hallId: HallId,
    sectionIndex: number,
    side: HallSideKey,
    value: string,
  ): void {
    setSectionSideMisWidth(hallId, sectionIndex, side, value);
  }

  function handleAddSection(hallId: HallId): void {
    addHallSection(hallId);
  }

  function handleRemoveSection(hallId: HallId, sectionIndex: number): void {
    removeHallSection(hallId, sectionIndex);
  }

  function applyPresetChange(nextPreset: StorageLayoutPreset): void {
    if (nextPreset === storageLayoutPreset) {
      return;
    }

    const nextHallConfigs = buildInitialHallConfigs(nextPreset);
    const nextSlotCount = buildOrderedSlotIds(nextHallConfigs, fillDirection).length;
    const assignedCount = Object.keys(activeSlotAssignments).length;
    const removedCount = Math.max(0, assignedCount - nextSlotCount);

    if (removedCount > 0) {
      setPendingLayoutChange({
        preset: nextPreset,
        removedCount,
      });
      return;
    }

    preserveAssignmentsForConfigChange(hallConfigs, nextHallConfigs);
    applyLayoutPreset(nextPreset);
    recenterViewport();
  }

  function confirmPendingLayoutChange(): void {
    if (!pendingLayoutChange) {
      return;
    }

    const nextHallConfigs = buildInitialHallConfigs(pendingLayoutChange.preset);
    preserveAssignmentsForConfigChange(hallConfigs, nextHallConfigs);
    applyLayoutPreset(pendingLayoutChange.preset);
    setPendingLayoutChange(null);
    recenterViewport();
  }

  function handleOpenClick(): void {
    openFileInputRef.current?.click();
  }

  const openPlannerFile = useCallback(async (file: File): Promise<void> => {
    try {
      const parsed = parsePlannerSnapshot(JSON.parse(await file.text()) as unknown);
      if (!parsed) {
        window.alert("Could not open file. Expected a planner save JSON file.");
        return;
      }
      applySnapshot(parsed);
    } catch {
      window.alert("Could not open file. The selected file is not valid JSON.");
    }
  }, [applySnapshot]);

  async function handleOpenFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    await openPlannerFile(file);
  }

  useEffect(() => {
    function handleWindowDragOver(event: DragEvent): void {
      const dataTransfer = event.dataTransfer;
      if (!hasFileTransfer(dataTransfer)) {
        return;
      }

      event.preventDefault();
      dataTransfer.dropEffect = "copy";
    }

    function handleWindowDrop(event: DragEvent): void {
      const dataTransfer = event.dataTransfer;
      if (!hasFileTransfer(dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const file = getPlannerJsonFile(dataTransfer.files);
      if (!file) {
        window.alert("Could not open file. Expected a planner save JSON file.");
        return;
      }

      void openPlannerFile(file);
    }

    window.addEventListener("dragover", handleWindowDragOver);
    window.addEventListener("drop", handleWindowDrop);
    return () => {
      window.removeEventListener("dragover", handleWindowDragOver);
      window.removeEventListener("drop", handleWindowDrop);
    };
  }, [openPlannerFile]);

  function handleSaveClick(): void {
    const saveFile: PlannerSaveFile = {
      version: SAVE_FILE_VERSION,
      savedAt: new Date().toISOString(),
      ...plannerSnapshot,
    };

    const blob = new Blob([`${JSON.stringify(saveFile, null, 2)}\n`], {
      type: "application/json",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    const layoutFileName = toFilenameSegment(labelNames.layoutName);
    anchor.download = `${layoutFileName}-${saveFile.savedAt.replace(/[:]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
  }

  async function handleExportLayoutClick(
    mode: LayoutExportMode,
    filterSettings?: ReturnType<typeof cloneFilterExportConfig>,
  ): Promise<void> {
    setIsExportMenuOpen(false);

    if (Object.keys(activeSlotAssignments).length === 0) {
      window.alert("Cannot export an empty layout. Assign at least one item first.");
      return;
    }

    try {
      setIsExportingLayout(true);
      const exported = await exportLayoutAsLitematic({
        layoutName: labelNames.layoutName,
        hallConfigs,
        slotAssignments: activeSlotAssignments,
        itemById,
        options: {
          mode,
          viewMode: layoutViewMode,
          filterDefaults: filterSettings?.defaults,
          hallFilterSettings: filterSettings?.halls,
        },
      });

      const now = new Date().toISOString().replace(/[:]/g, "-");
      const resolvedLayoutName =
        labelNames.layoutName.trim().length > 0 ? labelNames.layoutName : "Untitled Layout";
      const layoutFileName = toFilenameSegment(resolvedLayoutName);
      const viewFileName = layoutViewMode === "flat" ? "flat" : "storage";
      const exportTypeFileName = exported.option.fileSuffix;
      const exportBuffer = exported.bytes.buffer.slice(
        exported.bytes.byteOffset,
        exported.bytes.byteOffset + exported.bytes.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([exportBuffer], {
        type: "application/octet-stream",
      });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `${layoutFileName}-${viewFileName}-${exportTypeFileName}-${now}.litematic`;
      anchor.click();
      URL.revokeObjectURL(downloadUrl);
      if (mode === FILTER_EXPORT_MODE) {
        setIsFilterExportDialogOpen(false);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not export litematic file.";
      window.alert(message);
    } finally {
      setIsExportingLayout(false);
    }
  }

  function handleExportMenuOptionClick(mode: LayoutExportMode): void {
    if (mode === FILTER_EXPORT_MODE) {
      setIsExportMenuOpen(false);
      setIsFilterExportDialogOpen(true);
      return;
    }

    void handleExportLayoutClick(mode);
  }

  function updateFilterDefaults(updates: Partial<FilterExportSettings>): void {
    setFilterExportConfig((current) =>
      cloneFilterExportConfig({
        ...current,
        defaults: {
          ...current.defaults,
          ...updates,
        },
      }),
    );
  }

  function updateHallFilterSettings(
    hallId: HallId,
    updates: FilterExportHallSettings,
  ): void {
    setFilterExportConfig((current) => {
      const nextHallSettings = {
        ...(current.halls[hallId] ?? {}),
        ...updates,
      };
      const nextHalls = {
        ...current.halls,
        [hallId]: nextHallSettings,
      };
      return cloneFilterExportConfig({
        ...current,
        halls: nextHalls,
      });
    });
  }

  function clearHallFilterSetting(
    hallId: HallId,
    key: keyof FilterExportHallSettings,
  ): void {
    setFilterExportConfig((current) => {
      const nextHallSettings = { ...(current.halls[hallId] ?? {}) };
      delete nextHallSettings[key];
      const nextHalls = { ...current.halls };
      if (
        nextHallSettings.chestType === undefined &&
        nextHallSettings.bulkType === undefined &&
        nextHallSettings.misSignalStrength === undefined &&
        nextHallSettings.misMultiplicity === undefined
      ) {
        delete nextHalls[hallId];
      } else {
        nextHalls[hallId] = nextHallSettings;
      }
      return cloneFilterExportConfig({
        ...current,
        halls: nextHalls,
      });
    });
  }

  function handleFilterExportConfirm(): void {
    if (invalidMisExportKeys.size > 0) {
      setIsInvalidMisExportDialogOpen(true);
      return;
    }
    void handleExportLayoutClick(FILTER_EXPORT_MODE, filterExportConfig);
  }

  function handleInvalidMisExportAnyway(): void {
    setIsInvalidMisExportDialogOpen(false);
    void handleExportLayoutClick(FILTER_EXPORT_MODE, filterExportConfig);
  }

  function handleExportCsvClick(): void {
    setIsExportMenuOpen(false);

    if (catalogItems.length === 0) {
      window.alert("Cannot export CSV before the item catalog has loaded.");
      return;
    }

    const csv = exportLayoutAsCsv({
      catalogItems,
      hallConfigs,
      slotAssignments: activeSlotAssignments,
      labelNames,
      storageLayoutPreset,
    });
    const now = new Date().toISOString().replace(/[:]/g, "-");
    const resolvedLayoutName =
      labelNames.layoutName.trim().length > 0 ? labelNames.layoutName : "Untitled Layout";
    const layoutFileName = toFilenameSegment(resolvedLayoutName);
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `${layoutFileName}-items-${now}.csv`;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
  }

  function handleRestoreAutosaveClick(): void {
    if (!pendingAutosaveRestore) {
      return;
    }

    restoreHistoryState(pendingAutosaveRestore.history);
    applySnapshot(pendingAutosaveRestore.history.currentSnapshot);
    setPendingAutosaveRestore(null);
    setIsAutosaveRestoreResolved(true);
  }

  async function handleDiscardAutosaveClick(): Promise<void> {
    setPendingAutosaveRestore(null);
    setIsAutosaveRestoreResolved(true);
    try {
      await clearPlannerAutosaveDraft();
    } catch {
      // Ignore draft-clear failures and continue with a fresh session.
    }
  }

  const autosaveLayoutName =
    pendingAutosaveRestore?.snapshot.labelNames.layoutName || LAYOUT_NAME_PLACEHOLDER;
  const layoutNameWidthText = labelNames.layoutName || LAYOUT_NAME_PLACEHOLDER;

  const filterButtonClass = (
    isSelected: boolean,
    isInheritedDefault: boolean,
    isDisabled = false,
  ): string => {
    if (isDisabled) {
      return "cursor-not-allowed rounded-full border border-[rgba(116,104,89,0.22)] bg-[rgba(232,226,216,0.55)] px-2.5 py-[0.32rem] text-[0.72rem] font-bold text-[#8d8273] opacity-65 dark:border-[rgba(110,130,158,0.26)] dark:bg-[rgba(45,55,70,0.5)] dark:text-[#8391a8]";
    }
    if (isSelected) {
      return "rounded-full border border-[rgba(42,100,76,0.72)] bg-[rgba(210,239,221,0.98)] px-2.5 py-[0.32rem] text-[0.72rem] font-bold text-[#224c38] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.6)] dark:border-[rgba(98,205,176,0.68)] dark:bg-[rgba(25,82,73,0.96)] dark:text-[#d8fff4]";
    }
    if (isInheritedDefault) {
      return "rounded-full border border-[rgba(42,100,76,0.62)] bg-[rgba(255,255,255,0.64)] px-2.5 py-[0.32rem] text-[0.72rem] font-bold text-[#2f7656] hover:bg-[rgba(245,235,218,0.9)] dark:border-[rgba(98,205,176,0.58)] dark:bg-[rgba(25,39,58,0.72)] dark:text-[#8fe6ce] dark:hover:bg-[rgba(39,59,83,0.92)]";
    }
    return "rounded-full border border-[rgba(120,98,66,0.32)] bg-[rgba(255,255,255,0.64)] px-2.5 py-[0.32rem] text-[0.72rem] font-bold text-[#4b3a28] hover:bg-[rgba(245,235,218,0.9)] dark:border-[rgba(112,136,167,0.42)] dark:bg-[rgba(25,39,58,0.72)] dark:text-[#cddcf0] dark:hover:bg-[rgba(39,59,83,0.92)]";
  };

  const misPresetButtonClass = (
    isSelected: boolean,
    isInheritedDefault: boolean,
    index: number,
    total: number,
  ): string =>
    `h-7 min-w-[1.72rem] border px-1 text-[0.7rem] font-bold tabular-nums first:ml-0 ${
      index === 0 ? "rounded-l-full" : "-ml-px"
    } ${index === total - 1 ? "rounded-r-full" : ""} ${
      isSelected
        ? "relative z-[1] border-[rgba(42,100,76,0.72)] bg-[rgba(210,239,221,0.98)] text-[#224c38] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.6)] dark:border-[rgba(98,205,176,0.68)] dark:bg-[rgba(25,82,73,0.96)] dark:text-[#d8fff4]"
        : isInheritedDefault
          ? "relative z-[1] border-[rgba(42,100,76,0.62)] bg-[rgba(255,255,255,0.64)] text-[#2f7656] hover:bg-[rgba(245,235,218,0.9)] dark:border-[rgba(98,205,176,0.58)] dark:bg-[rgba(25,39,58,0.72)] dark:text-[#8fe6ce] dark:hover:bg-[rgba(39,59,83,0.92)]"
          : "border-[rgba(120,98,66,0.32)] bg-[rgba(255,255,255,0.64)] text-[#4b3a28] hover:bg-[rgba(245,235,218,0.9)] dark:border-[rgba(112,136,167,0.42)] dark:bg-[rgba(25,39,58,0.72)] dark:text-[#cddcf0] dark:hover:bg-[rgba(39,59,83,0.92)]"
    }`;

  const filterPageHallId = typeof filterExportPage === "number" ? filterExportPage : null;
  const filterPageHallSettings = filterPageHallId
    ? filterExportConfig.halls[filterPageHallId] ?? {}
    : {};
  const isFilterDefaultsPage = filterPageHallId === null;
  const filterPageLabel = isFilterDefaultsPage
    ? "Defaults"
    : labelNames.hallNames[filterPageHallId] ??
      getLayoutHallName(storageLayoutPreset, filterPageHallId) ??
      `Hall ${filterPageHallId}`;

  return (
    <div className="flex h-screen min-h-screen flex-col overflow-hidden bg-[radial-gradient(circle_at_15%_12%,#fff8e8_0%,rgba(255,248,232,0)_35%),radial-gradient(circle_at_88%_8%,#e2f1ee_0%,rgba(226,241,238,0)_30%),linear-gradient(180deg,#f9f4ea_0%,#f2eadd_100%)] text-[#1f1a16] dark:bg-[radial-gradient(circle_at_15%_12%,rgba(108,138,184,0.28)_0%,rgba(108,138,184,0)_35%),radial-gradient(circle_at_88%_8%,rgba(91,159,153,0.2)_0%,rgba(91,159,153,0)_30%),linear-gradient(180deg,#121c29_0%,#0c141f_100%)] dark:text-[#e4ecf7] max-[1200px]:h-auto max-[1200px]:overflow-auto" data-planner-scroll-shell>
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-b-[rgba(114,88,46,0.28)] bg-[linear-gradient(180deg,rgba(255,252,245,0.94)_0%,rgba(249,241,226,0.9)_100%)] px-4 py-[0.55rem] dark:border-b-[rgba(119,143,176,0.4)] dark:bg-[linear-gradient(180deg,rgba(27,39,56,0.95)_0%,rgba(16,26,39,0.94)_100%)]">
        <div className="flex items-center gap-[0.45rem]">
          <a
            href="https://storagecatalog.org"
            className="mr-[0.3rem] flex items-center gap-[0.34rem] rounded-[0.35rem] px-[0.08rem] py-[0.04rem] hover:bg-[rgba(255,255,255,0.42)] dark:hover:bg-[rgba(89,114,152,0.32)]"
          >
            <Image
              src={withBasePath("/logo.png")}
              alt="Minecraft Storage Catalog logo"
              width={28}
              height={28}
              className="h-7 w-7 rounded-[0.35rem] object-cover"
              unoptimized
            />
            <span className="whitespace-nowrap text-[0.94rem] font-bold tracking-[0.015em] text-[#3e301f] dark:text-[#d7e4f8]">
              Minecraft Storage Catalog
            </span>
          </a>
          <input
            ref={openFileInputRef}
            className="hidden"
            type="file"
            accept="application/json,.json"
            onChange={handleOpenFileChange}
          />
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={handleOpenClick}
          >
            Open
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={handleSaveClick}
          >
            Save
          </button>
          <div
            ref={exportMenuRef}
            className="relative"
          >
            <button
              type="button"
              className={TOOLBAR_BUTTON_CLASS}
              aria-haspopup="menu"
              aria-expanded={isExportMenuOpen}
              onClick={() => setIsExportMenuOpen((current) => !current)}
              disabled={isExportingLayout}
            >
              {isExportingLayout ? "Exporting..." : "Export"}
            </button>
            {isExportMenuOpen ? (
              <div className="absolute left-0 top-[calc(100%+0.35rem)] z-20 min-w-64 rounded-[0.45rem] border border-[rgba(114,88,46,0.3)] bg-[rgba(255,250,242,0.98)] p-1 shadow-[0_10px_22px_rgba(64,48,24,0.18)] dark:border-[rgba(111,135,165,0.5)] dark:bg-[rgba(21,31,45,0.98)] dark:shadow-[0_14px_28px_rgba(4,8,16,0.48)]">
                <button
                  type="button"
                  className="block w-full rounded-[0.35rem] px-2 py-1.5 text-left text-[0.78rem] leading-tight text-[#3b2f22] hover:bg-[rgba(210,184,142,0.2)] dark:text-[#d6e3f5] dark:hover:bg-[rgba(92,124,173,0.28)]"
                  onClick={handleExportCsvClick}
                >
                  <span className="block text-[0.8rem] font-semibold">CSV: Item List Spreadsheet</span>
                  <span className="mt-0.5 block text-[0.72rem] text-[#6d5a3f] dark:text-[#9fb2ce]">
                    A spreadsheet containing each catalog item with assignment and location details.
                  </span>
                </button>
                {LITEMATIC_EXPORT_OPTIONS.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    className="block w-full rounded-[0.35rem] px-2 py-1.5 text-left text-[0.78rem] leading-tight text-[#3b2f22] hover:bg-[rgba(210,184,142,0.2)] dark:text-[#d6e3f5] dark:hover:bg-[rgba(92,124,173,0.28)]"
                    onClick={() => handleExportMenuOptionClick(option.mode)}
                  >
                    <span className="block text-[0.8rem] font-semibold">{option.label}</span>
                    <span className="mt-0.5 block text-[0.72rem] text-[#6d5a3f] dark:text-[#9fb2ce]">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="grid min-w-48 max-w-[44vw] justify-self-center">
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1 whitespace-pre px-1 py-[0.08rem] text-center text-[1.08rem] font-bold tracking-[0.02em]"
          >
            {layoutNameWidthText}
          </span>
          <input
            type="text"
            className="col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent px-1 py-[0.08rem] text-center text-[1.08rem] font-bold tracking-[0.02em] text-[#4b3a24] placeholder:text-[#8a7a63] focus:outline-none dark:text-[#d9e5f8] dark:placeholder:text-[#90a3be]"
            title="Click to rename layout"
            placeholder={LAYOUT_NAME_PLACEHOLDER}
            value={labelNames.layoutName}
            onChange={(event) => handleLayoutNameChange(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-self-end gap-[0.45rem]">
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={undo}
            disabled={!canUndo}
          >
            Undo
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={redo}
            disabled={!canRedo}
          >
            Redo
          </button>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden max-[1200px]:flex-col">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-r-[rgba(114,88,46,0.24)] dark:border-r-[rgba(119,143,176,0.35)] max-[1200px]:min-h-[62vh] max-[1200px]:border-r-0 max-[1200px]:border-b max-[1200px]:border-b-[rgba(114,88,46,0.24)] dark:max-[1200px]:border-b-[rgba(119,143,176,0.35)]">
          <LayoutViewport
            storageLayoutPreset={storageLayoutPreset}
            onStorageLayoutPresetChange={applyPresetChange}
            hallConfigs={hallConfigs}
            slotAssignments={activeSlotAssignments}
            itemById={itemById}
            invalidMisExportKeys={invalidMisExportKeys}
            misExportSignalStrengthByKey={misExportSignalStrengthByKey}
            hallNames={labelNames.hallNames}
            sectionNames={labelNames.sectionNames}
            misNames={labelNames.misNames}
            cursorSlotId={cursorSlotId}
            cursorMovementHint={cursorMovementHint}
            viewportRef={viewportRef}
            zoom={zoom}
            pan={pan}
            subscribeViewportTransform={subscribeViewportTransform}
            onAdjustZoom={adjustZoom}
            onPanViewportBy={panBy}
            onFitViewportToBounds={fitViewportToBounds}
            onRecenterViewport={recenterViewport}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerEnd={handlePointerEnd}
            onSlotDragOver={handleSlotDragOver}
            onSlotDrop={handleSlotDrop}
            onViewportDropFallback={handleViewportDropFallback}
            onCursorSlotChange={setCursorSlot}
            onCursorMisChange={setCursorMisRow}
            onSectionSlicesChange={handleSectionSlicesChange}
            onSectionSideTypeChange={handleSectionSideTypeChange}
            onSectionSideRowsChange={handleSectionSideRowsChange}
            onSectionSideMisCapacityChange={handleSectionSideMisCapacityChange}
            onSectionSideMisRowsChange={handleSectionSideMisRowsChange}
            onSectionSideMisWidthChange={handleSectionSideMisWidthChange}
            onHallNameChange={handleHallNameChange}
            onSectionNameChange={handleSectionNameChange}
            onMisNameChange={handleMisNameChange}
            onAddSection={handleAddSection}
            onRemoveSection={handleRemoveSection}
            onSlotItemDragStart={beginSlotItemDrag}
            onSlotGroupDragStart={beginSlotGroupDrag}
            onAnyDragEnd={clearDragState}
            onClearSlot={clearSlot}
            draggedSourceSlotIds={draggedSourceSlotIdSet}
            dragPreviewPlacements={dragPreviews}
            selectedSlotIds={selectedSlotIdSet}
            onSelectionChange={setSelectedSlotIds}
            onViewModeChange={setLayoutViewMode}
          />
        </section>

        <ItemLibraryPanel
          catalogItems={catalogItems}
          catalogGameVersion={catalogGameVersion}
          isLoadingCatalog={isLoadingCatalog}
          catalogError={catalogError}
          usedItemIds={usedItemIds}
          fillDirection={fillDirection}
          onFillDirectionChange={setFillDirection}
          onItemContextPlace={placeLibraryItemAtCursor}
          onItemDragStart={beginItemDrag}
          onCategoryDragStart={beginCategoryDrag}
          onLibraryDragOver={handleLibraryDragOver}
          onLibraryDrop={handleLibraryDrop}
          onAnyDragEnd={clearDragState}
        />
      </div>

      {isFilterExportDialogOpen ? (
        <div className="fixed inset-0 z-60 grid place-items-center bg-[rgba(19,15,10,0.45)] px-4">
          <div
            className="grid max-h-[88vh] w-full max-w-2xl grid-rows-[auto_1fr_auto] overflow-hidden rounded-[0.8rem] border border-[rgba(126,101,67,0.46)] bg-[linear-gradient(180deg,rgba(255,252,244,0.98)_0%,rgba(247,236,217,0.98)_100%)] shadow-[0_16px_42px_rgba(23,19,13,0.35)] dark:border-[rgba(116,142,178,0.52)] dark:bg-[linear-gradient(180deg,rgba(23,35,53,0.98)_0%,rgba(15,25,38,0.98)_100%)] dark:shadow-[0_20px_46px_rgba(4,8,14,0.52)]"
            data-no-pan
          >
            <header className="flex items-center justify-between gap-3 border-b border-[rgba(126,101,67,0.26)] px-4 py-3 dark:border-[rgba(116,142,178,0.35)]">
              <h3 className="m-0 text-[1rem] font-bold text-[#3b3126] dark:text-[#dbe6f7]">
                Litematic: Filters
              </h3>
              <div className="flex min-w-0 items-center justify-end gap-2">
                <select
                  className="min-w-0 max-w-[15rem] rounded-[0.4rem] border border-[rgba(122,99,66,0.35)] bg-[rgba(255,255,255,0.78)] px-2 py-[0.24rem] text-[0.74rem] font-semibold text-[#4b3a28] outline-none focus:border-[rgba(42,100,76,0.62)] dark:border-[rgba(112,136,167,0.45)] dark:bg-[rgba(25,39,58,0.86)] dark:text-[#d4e2f4] dark:focus:border-[rgba(98,205,176,0.58)]"
                  aria-label="Filter export config page"
                  value={isFilterDefaultsPage ? "defaults" : String(filterPageHallId)}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setFilterExportPage(value === "defaults" ? "defaults" : Number(value));
                  }}
                >
                  <option value="defaults">Defaults</option>
                  {hallIds.map((hallId) => {
                    const hallName =
                      labelNames.hallNames[hallId] ??
                      getLayoutHallName(storageLayoutPreset, hallId) ??
                      `Hall ${hallId}`;
                    return (
                      <option key={hallId} value={hallId}>
                        {hallName}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  className="rounded-[0.4rem] border border-[rgba(122,99,66,0.35)] bg-[rgba(255,255,255,0.7)] px-2 py-[0.22rem] text-[0.74rem] font-semibold text-[#4b3a28] dark:border-[rgba(112,136,167,0.45)] dark:bg-[rgba(25,39,58,0.86)] dark:text-[#d4e2f4]"
                  onClick={() => setIsFilterExportDialogOpen(false)}
                >
                  Close
                </button>
              </div>
            </header>
            <div className="min-h-0 overflow-auto px-4 py-3">
              <section className="grid gap-1.5 rounded-[0.45rem] border border-[rgba(126,101,67,0.22)] bg-[rgba(255,255,255,0.34)] p-2.5 dark:border-[rgba(116,142,178,0.32)] dark:bg-[rgba(20,32,48,0.52)]">
                <div className="grid gap-0.5 pb-1">
                  <h4 className="m-0 text-[0.82rem] font-bold text-[#3f3328] dark:text-[#dbe6f7]">
                    Filter type
                  </h4>
                  <p className="m-0 text-[0.7rem] leading-[1.3] text-[#6a5d4b] dark:text-[#9fb2ce]">
                    Choose the default hopper filter type, then override individual halls only when they differ.
                  </p>
                </div>
                <div className="grid gap-1 rounded-[0.36rem] bg-[rgba(255,255,255,0.38)] px-2 py-1.5 text-[0.68rem] leading-[1.25] text-[#6a5d4b] dark:bg-[rgba(15,25,38,0.42)] dark:text-[#9fb2ce]">
                  <p className="m-0">
                    <span className="font-bold text-[#3f3328] dark:text-[#dbe6f7]">SSI/SS2:</span>{" "}
                    For signal strength isolated AB-tileable signal strength 2 filters. One filter item in first slot, dummy items in slots 2-5 so that total signal strength is 2.
                  </p>
                  <p className="m-0">
                    <span className="font-bold text-[#3f3328] dark:text-[#dbe6f7]">SS3:</span>{" "}
                    For traditional tileable signal strength 3 filters. 41 filter items (10 if 16-stackable) in first slot, dummy items in slots 2-5 so that total signal strength is 3.
                  </p>
                  <p className="m-0">
                    <span className="font-bold text-[#3f3328] dark:text-[#dbe6f7]">Box sorters:</span>{" "}
                    For first-item box sorters. Downward hopper with one filter item in first slot, then shulker boxes to block other slots.
                  </p>
                </div>
                <div className="grid gap-1">
                  <div className="text-[0.7rem] font-bold text-[#3f3328] dark:text-[#dbe6f7]">
                    {filterPageLabel}
                  </div>
                  {FILTER_EXPORT_ITEM_TYPES.map((itemType) => {
                    const settingKey =
                      itemType.value === "chest" ? "chestType" : "bulkType";
                    const defaultType = filterExportConfig.defaults[settingKey];
                    const override = filterPageHallSettings[settingKey];
                    return (
                      <div
                        key={itemType.value}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[rgba(126,101,67,0.1)] py-1.5 dark:border-[rgba(116,142,178,0.18)]"
                      >
                        <span className="truncate text-[0.72rem] font-semibold text-[#5f5446] dark:text-[#a8b9d1]">
                          {itemType.label}
                        </span>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                          {FILTER_EXPORT_CHOICES.map((option) => {
                            const isSupported = isSupportedFilterExportChoice(option.value);
                            const isSelected = isFilterDefaultsPage
                              ? option.value === defaultType
                              : option.value === override;
                            const isInheritedDefault =
                              !isFilterDefaultsPage &&
                              override === undefined &&
                              option.value === defaultType;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                aria-pressed={isSelected}
                                disabled={option.disabled}
                                className={filterButtonClass(
                                  isSelected,
                                  isInheritedDefault,
                                  option.disabled,
                                )}
                                title={option.disabled ? "Coming later" : undefined}
                                onClick={() => {
                                  if (!isSupported) {
                                    return;
                                  }
                                  if (isFilterDefaultsPage) {
                                    updateFilterDefaults({ [settingKey]: option.value });
                                    return;
                                  }
                                  if (!filterPageHallId) {
                                    return;
                                  }
                                  if (isSelected) {
                                    clearHallFilterSetting(filterPageHallId, settingKey);
                                  } else {
                                    updateHallFilterSettings(filterPageHallId, {
                                      [settingKey]: option.value,
                                    });
                                  }
                                }}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
              <section className="mt-3 grid gap-2 rounded-[0.45rem] border border-[rgba(126,101,67,0.22)] bg-[rgba(255,255,255,0.34)] p-2.5 dark:border-[rgba(116,142,178,0.32)] dark:bg-[rgba(20,32,48,0.52)]">
                <div className="grid gap-0.5">
                  <h4 className="m-0 text-[0.82rem] font-bold text-[#3f3328] dark:text-[#dbe6f7]">
                    MIS settings
                  </h4>
                  <p className="m-0 text-[0.7rem] leading-[1.3] text-[#6a5d4b] dark:text-[#9fb2ce]">
                    Set the signal strength and multiplicity values used for filling MIS chests with dummy items.
                  </p>
                  {invalidMisExportKeys.size > 0 ? (
                    <p className="m-0 rounded-[0.36rem] border border-[rgba(185,28,28,0.38)] bg-[rgba(254,226,226,0.74)] px-2 py-1 text-[0.7rem] font-semibold leading-[1.25] text-[#8f1d1d] dark:border-[rgba(248,113,113,0.48)] dark:bg-[rgba(91,28,28,0.54)] dark:text-[#fecaca]">
                      {invalidMisExportKeys.size} MIS chest{invalidMisExportKeys.size === 1 ? "" : "s"} need{invalidMisExportKeys.size === 1 ? "s" : ""} to be fixed for this configuration.
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-2">
                  <div className="grid gap-1.5 sm:grid-cols-[7.75rem_minmax(0,1fr)] sm:items-center">
                    <span className="text-[0.72rem] font-semibold text-[#5f5446] dark:text-[#a8b9d1]">
                      Signal strength
                    </span>
                    <div
                      className="flex max-w-full items-center justify-end overflow-x-auto py-0.5"
                      role="group"
                      aria-label="Default MIS signal strength"
                    >
                      {FILTER_MIS_SIGNAL_STRENGTH_VALUES.map((value, index) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={
                            isFilterDefaultsPage
                              ? filterExportConfig.defaults.misSignalStrength === value
                              : filterPageHallSettings.misSignalStrength === value
                          }
                          className={misPresetButtonClass(
                            isFilterDefaultsPage
                              ? filterExportConfig.defaults.misSignalStrength === value
                              : filterPageHallSettings.misSignalStrength === value,
                            !isFilterDefaultsPage &&
                              filterPageHallSettings.misSignalStrength === undefined &&
                              filterExportConfig.defaults.misSignalStrength === value,
                            index,
                            FILTER_MIS_SIGNAL_STRENGTH_VALUES.length,
                          )}
                          onClick={() => {
                            if (isFilterDefaultsPage) {
                              updateFilterDefaults({ misSignalStrength: value });
                              return;
                            }
                            if (!filterPageHallId) {
                              return;
                            }
                            if (filterPageHallSettings.misSignalStrength === value) {
                              clearHallFilterSetting(filterPageHallId, "misSignalStrength");
                            } else {
                              updateHallFilterSettings(filterPageHallId, {
                                misSignalStrength: value,
                              });
                            }
                          }}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-1.5 sm:grid-cols-[7.75rem_minmax(0,1fr)] sm:items-center">
                    <span className="text-[0.72rem] font-semibold text-[#5f5446] dark:text-[#a8b9d1]">
                      Multiplicity
                    </span>
                    <div
                      className="flex max-w-full items-center justify-end overflow-x-auto py-0.5"
                      role="group"
                      aria-label="Default MIS multiplicity"
                    >
                      {FILTER_MIS_MULTIPLICITY_VALUES.map((value, index) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={
                            isFilterDefaultsPage
                              ? filterExportConfig.defaults.misMultiplicity === value
                              : filterPageHallSettings.misMultiplicity === value
                          }
                          className={misPresetButtonClass(
                            isFilterDefaultsPage
                              ? filterExportConfig.defaults.misMultiplicity === value
                              : filterPageHallSettings.misMultiplicity === value,
                            !isFilterDefaultsPage &&
                              filterPageHallSettings.misMultiplicity === undefined &&
                              filterExportConfig.defaults.misMultiplicity === value,
                            index,
                            FILTER_MIS_MULTIPLICITY_VALUES.length,
                          )}
                          onClick={() => {
                            if (isFilterDefaultsPage) {
                              updateFilterDefaults({ misMultiplicity: value });
                              return;
                            }
                            if (!filterPageHallId) {
                              return;
                            }
                            if (filterPageHallSettings.misMultiplicity === value) {
                              clearHallFilterSetting(filterPageHallId, "misMultiplicity");
                            } else {
                              updateHallFilterSettings(filterPageHallId, {
                                misMultiplicity: value,
                              });
                            }
                          }}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-[rgba(126,101,67,0.26)] px-4 py-3 dark:border-[rgba(116,142,178,0.35)]">
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(122,99,66,0.45)] bg-[rgba(255,255,255,0.88)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#3b2f22] dark:border-[rgba(115,136,165,0.55)] dark:bg-[rgba(28,42,61,0.95)] dark:text-[#d5e3f8]"
                onClick={() => setIsFilterExportDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(61,116,87,0.52)] bg-[rgba(231,250,238,0.95)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#204b35] disabled:cursor-not-allowed disabled:opacity-55 dark:border-[rgba(79,157,139,0.62)] dark:bg-[rgba(28,73,66,0.92)] dark:text-[#bcefe4]"
                disabled={isExportingLayout}
                onClick={handleFilterExportConfirm}
              >
                {isExportingLayout ? "Exporting..." : "Export"}
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {isInvalidMisExportDialogOpen ? (
        <div
          className="fixed inset-0 z-70 grid place-items-center bg-[rgba(19,15,10,0.52)] px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invalid-mis-export-title"
        >
          <div className="w-full max-w-md rounded-[0.9rem] border border-[rgba(156,55,42,0.48)] bg-[linear-gradient(180deg,rgba(255,250,244,0.98)_0%,rgba(248,232,221,0.98)_100%)] p-4 shadow-[0_16px_42px_rgba(23,19,13,0.35)] dark:border-[rgba(200,111,111,0.58)] dark:bg-[linear-gradient(180deg,rgba(48,29,31,0.98)_0%,rgba(31,22,28,0.98)_100%)] dark:shadow-[0_20px_46px_rgba(4,8,14,0.52)]">
            <h3
              id="invalid-mis-export-title"
              className="m-0 text-[1rem] font-bold text-[#5a241b] dark:text-[#ffd9d9]"
            >
              Invalid MIS Export
            </h3>
            <p className="mt-2 text-[0.84rem] leading-[1.35] text-[#5f5446] dark:text-[#d3b9b9]">
              {invalidMisExportKeys.size} MIS chest
              {invalidMisExportKeys.size === 1 ? "" : "s"} cannot hit the configured signal
              strength with the current assignments.
            </p>
            <p className="mt-1 text-[0.78rem] leading-[1.35] text-[#6c5f4e] dark:text-[#c4aaaa]">
              Fix the highlighted MIS chests before exporting, or export anyway with the current
              configuration.
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(156,55,42,0.52)] bg-[rgba(255,235,231,0.82)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#7c2217] dark:border-[rgba(200,111,111,0.6)] dark:bg-[rgba(92,37,37,0.78)] dark:text-[#ffd9d9]"
                disabled={isExportingLayout}
                onClick={handleInvalidMisExportAnyway}
              >
                Export Anyway
              </button>
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(61,116,87,0.52)] bg-[rgba(231,250,238,0.95)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#204b35] dark:border-[rgba(79,157,139,0.62)] dark:bg-[rgba(28,73,66,0.92)] dark:text-[#bcefe4]"
                onClick={() => {
                  setIsInvalidMisExportDialogOpen(false);
                  setIsFilterExportDialogOpen(false);
                }}
              >
                Fix
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingAutosaveRestore ? (
        <div className="fixed inset-0 z-70 grid place-items-center bg-[rgba(19,15,10,0.45)] px-4">
          <div className="w-full max-w-md rounded-[0.9rem] border border-[rgba(126,101,67,0.46)] bg-[linear-gradient(180deg,rgba(255,252,244,0.98)_0%,rgba(247,236,217,0.98)_100%)] p-4 shadow-[0_16px_42px_rgba(23,19,13,0.35)] dark:border-[rgba(116,142,178,0.52)] dark:bg-[linear-gradient(180deg,rgba(23,35,53,0.98)_0%,rgba(15,25,38,0.98)_100%)] dark:shadow-[0_20px_46px_rgba(4,8,14,0.52)]">
            <h3 className="m-0 max-w-full text-[1rem] font-bold text-[#3b3126] [overflow-wrap:anywhere] dark:text-[#dbe6f7]">
              Restore{" "}
              <span className="font-extrabold text-[#2f251b] [overflow-wrap:anywhere] dark:text-[#eef4ff]">
                {autosaveLayoutName}
              </span>
              ?
            </h3>
            <p className="mt-1 text-[0.84rem] leading-[1.35] text-[#5f5446] dark:text-[#a8b9d1]">
              A local autosave from{" "}
              <span className="font-semibold text-[#3b2f22] dark:text-[#d8e4f6]">
                {formatAutosaveTimestamp(pendingAutosaveRestore.savedAt)}
              </span>{" "}
              was found.
            </p>
            <p className="mt-1 text-[0.78rem] text-[#6c5f4e] dark:text-[#8fa4c1]">
              Restore the autosaved layout and history?
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(122,99,66,0.45)] bg-[rgba(255,255,255,0.88)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#3b2f22] dark:border-[rgba(115,136,165,0.55)] dark:bg-[rgba(28,42,61,0.95)] dark:text-[#d5e3f8]"
                onClick={() => {
                  void handleDiscardAutosaveClick();
                }}
              >
                Start Fresh
              </button>
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(61,116,87,0.52)] bg-[rgba(231,250,238,0.95)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#204b35] dark:border-[rgba(79,157,139,0.62)] dark:bg-[rgba(28,73,66,0.92)] dark:text-[#bcefe4]"
                onClick={handleRestoreAutosaveClick}
              >
                Restore
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingLayoutChange ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(27,22,16,0.42)] px-4">
          <div className="w-full max-w-md rounded-[0.9rem] border border-[rgba(137,107,67,0.45)] bg-[linear-gradient(180deg,rgba(255,251,241,0.98)_0%,rgba(248,238,220,0.98)_100%)] p-4 shadow-[0_16px_42px_rgba(23,19,13,0.34)] dark:border-[rgba(116,142,178,0.52)] dark:bg-[linear-gradient(180deg,rgba(23,35,53,0.98)_0%,rgba(15,25,38,0.98)_100%)] dark:shadow-[0_20px_46px_rgba(4,8,14,0.52)]">
            <h3 className="m-0 text-[1rem] font-bold text-[#3b3126] dark:text-[#dbe6f7]">Confirm Layout Change</h3>
            <p className="mt-2 text-[0.85rem] leading-[1.35] text-[#5f5446] dark:text-[#a8b9d1]">
              Switching to this layout will remove{" "}
              <span className="font-semibold text-[#8a2f22] dark:text-[#ff9f9f]">
                {pendingLayoutChange.removedCount}
              </span>{" "}
              placed item{pendingLayoutChange.removedCount === 1 ? "" : "s"} because the new
              layout has fewer slots.
            </p>
            <p className="mt-1 text-[0.78rem] text-[#6c5f4e] dark:text-[#8fa4c1]">
              Do you want to continue?
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(122,99,66,0.45)] bg-[rgba(255,255,255,0.88)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#3b2f22] dark:border-[rgba(115,136,165,0.55)] dark:bg-[rgba(28,42,61,0.95)] dark:text-[#d5e3f8]"
                onClick={() => setPendingLayoutChange(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-[0.45rem] border border-[rgba(156,55,42,0.52)] bg-[rgba(255,235,231,0.95)] px-3 py-[0.34rem] text-[0.78rem] font-semibold text-[#7c2217] dark:border-[rgba(200,111,111,0.6)] dark:bg-[rgba(92,37,37,0.9)] dark:text-[#ffd9d9]"
                onClick={confirmPendingLayoutChange}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
