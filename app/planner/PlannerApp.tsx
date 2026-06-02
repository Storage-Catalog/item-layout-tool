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
  cloneSlotAssignments,
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
import type { FillDirection, HallId, HallType } from "./types";
import { buildInitialHallConfigs, type StorageLayoutPreset } from "./layoutConfig";
import { buildOrderedSlotIds } from "./utils";
import { withBasePath } from "./base-path";

const TOOLBAR_BUTTON_CLASS =
  "cursor-pointer rounded-[0.35rem] bg-transparent px-[0.46rem] py-[0.2rem] text-[0.8rem] font-semibold text-[#3b2f22] hover:text-[#241c14] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(122,99,66,0.35)] disabled:cursor-not-allowed disabled:opacity-45 dark:text-[#cad9ef] dark:hover:text-[#eff6ff] dark:focus-visible:ring-[rgba(148,163,184,0.45)]";
const AUTOSAVE_DEBOUNCE_MS = 800;
const LAYOUT_NAME_PLACEHOLDER = "Untitled Layout";

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

export function PlannerApp() {
  const { catalogItems, isLoadingCatalog, catalogError } = useCatalog();
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
    handleMisSignalStrengthChange,
  } = usePlannerLabelNames();
  const {
    viewportRef,
    zoom,
    pan,
    subscribeViewportTransform,
    adjustZoom,
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
      }),
    [activeSlotAssignments, fillDirection, hallConfigs, labelNames, storageLayoutPreset],
  );
  const plannerSnapshotKey = useMemo(
    () => snapshotToKey(plannerSnapshot),
    [plannerSnapshot],
  );

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

  async function handleOpenFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

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
  }

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

  async function handleExportLayoutClick(mode: LayoutExportMode): Promise<void> {
    setIsExportMenuOpen(false);

    if (Object.keys(activeSlotAssignments).length === 0) {
      window.alert("Cannot export an empty layout. Assign at least one item first.");
      return;
    }

    try {
      setIsExportingLayout(true);
      const exported = await exportLayoutAsLitematic({
        mode,
        layoutName: labelNames.layoutName,
        hallConfigs,
        slotAssignments: activeSlotAssignments,
        itemById,
        misSignalStrengths: labelNames.misSignalStrengths,
        layoutViewMode,
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
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not export litematic file.";
      window.alert(message);
    } finally {
      setIsExportingLayout(false);
    }
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
                  <span className="block text-[0.8rem] font-semibold">CSV: Item Layout</span>
                  <span className="mt-0.5 block text-[0.72rem] text-[#6d5a3f] dark:text-[#9fb2ce]">
                    A spreadsheet containing each catalog item with assignment and location details.
                  </span>
                </button>
                {LITEMATIC_EXPORT_OPTIONS.map((option) => (
                  <button
                    key={option.mode}
                    type="button"
                    className="block w-full rounded-[0.35rem] px-2 py-1.5 text-left text-[0.78rem] leading-tight text-[#3b2f22] hover:bg-[rgba(210,184,142,0.2)] dark:text-[#d6e3f5] dark:hover:bg-[rgba(92,124,173,0.28)]"
                    onClick={() => void handleExportLayoutClick(option.mode)}
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
            hallNames={labelNames.hallNames}
            sectionNames={labelNames.sectionNames}
            misNames={labelNames.misNames}
            misSignalStrengths={labelNames.misSignalStrengths}
            cursorSlotId={cursorSlotId}
            cursorMovementHint={cursorMovementHint}
            viewportRef={viewportRef}
            zoom={zoom}
            pan={pan}
            subscribeViewportTransform={subscribeViewportTransform}
            onAdjustZoom={adjustZoom}
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
            onMisSignalStrengthChange={handleMisSignalStrengthChange}
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
