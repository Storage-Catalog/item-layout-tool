import Image from "next/image";
import {
  type DragEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogItem, FillDirection } from "../types";
import { buildCategories, toTitle } from "../utils";

type SearchMatcher =
  | { kind: "none" }
  | { kind: "text"; normalizedNeedle: string }
  | { kind: "regex"; regex: RegExp };

function parseSearchMatcher(rawQuery: string): SearchMatcher {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return { kind: "none" };
  }

  if (trimmed.startsWith("/")) {
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash > 0) {
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      try {
        return { kind: "regex", regex: new RegExp(pattern, flags) };
      } catch {
        // Treat invalid regex as plain text search to avoid silently failing.
      }
    }
  }

  return { kind: "text", normalizedNeedle: trimmed.toLowerCase() };
}

function highlightMatches(text: string, matcher: SearchMatcher): ReactNode {
  if (matcher.kind === "none") {
    return text;
  }

  const ranges: Array<{ start: number; end: number }> = [];
  if (matcher.kind === "text") {
    const needle = matcher.normalizedNeedle;
    if (!needle) {
      return text;
    }
    const source = text.toLowerCase();
    let cursor = 0;
    while (cursor < source.length) {
      const index = source.indexOf(needle, cursor);
      if (index < 0) {
        break;
      }
      ranges.push({ start: index, end: index + needle.length });
      cursor = index + needle.length;
    }
  } else {
    if (matcher.regex.flags.includes("g")) {
      const regex = new RegExp(matcher.regex.source, matcher.regex.flags);
      for (const match of text.matchAll(regex)) {
        if (match.index === undefined) {
          continue;
        }
        if (!match[0]) {
          // Avoid pathological highlighting for zero-length matches.
          return text;
        }
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    } else {
      const regex = new RegExp(matcher.regex.source, matcher.regex.flags.replace(/g/g, ""));
      const match = regex.exec(text);
      if (match?.index !== undefined && match[0]) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }

  if (ranges.length === 0) {
    return text;
  }

  const fragments: ReactNode[] = [];
  let start = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (range.start > start) {
      fragments.push(
        <span key={`plain-${index}-${start}`}>{text.slice(start, range.start)}</span>,
      );
    }
    fragments.push(
      <mark
        key={`match-${index}-${range.start}`}
        className="rounded-[0.2rem] bg-[rgba(255,224,138,0.72)] px-[0.06rem] text-inherit dark:bg-[rgba(186,139,61,0.62)]"
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    start = range.end;
  }
  if (start < text.length) {
    fragments.push(<span key={`tail-${start}`}>{text.slice(start)}</span>);
  }
  return fragments;
}

function regexMatches(regex: RegExp, value: string): boolean {
  const flags = regex.flags.replace(/g/g, "");
  return new RegExp(regex.source, flags).test(value);
}

type ItemLibraryPanelProps = {
  catalogItems: CatalogItem[];
  catalogGameVersion: string | null;
  isLoadingCatalog: boolean;
  catalogError: string | null;
  usedItemIds: Set<string>;
  fillDirection: FillDirection;
  onFillDirectionChange: (direction: FillDirection) => void;
  onItemContextPlace: (itemId: string) => boolean;
  onItemDragStart: (event: DragEvent<HTMLElement>, itemId: string) => void;
  onCategoryDragStart: (
    event: DragEvent<HTMLElement>,
    itemIds: string[],
  ) => void;
  onLibraryDragOver: (event: DragEvent<HTMLElement>) => void;
  onLibraryDrop: (event: DragEvent<HTMLElement>) => void;
  onAnyDragEnd: () => void;
};

export function ItemLibraryPanel({
  catalogItems,
  catalogGameVersion,
  isLoadingCatalog,
  catalogError,
  usedItemIds,
  fillDirection,
  onFillDirectionChange,
  onItemContextPlace,
  onItemDragStart,
  onCategoryDragStart,
  onLibraryDragOver,
  onLibraryDrop,
  onAnyDragEnd,
}: ItemLibraryPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedOverrides, setCollapsedOverrides] = useState<
    Record<string, boolean>
  >({});
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(0);
  const [listWidth, setListWidth] = useState(0);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const [selectedLibraryItemIds, setSelectedLibraryItemIds] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const selectionPointerId = useRef<number | null>(null);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const selectionAnchorSet = useRef<Set<string>>(new Set());
  const defaultCollapseThreshold = 48;
  const listOverscan = 520;
  const sectionGap = 10;

  const availableItems = useMemo(
    () => catalogItems.filter((item) => !usedItemIds.has(item.id)),
    [catalogItems, usedItemIds],
  );

  const trimmedSearch = searchQuery.trim();
  const searchMatcher = useMemo(() => parseSearchMatcher(searchQuery), [searchQuery]);

  const visibleItems = useMemo(() => {
    if (searchMatcher.kind === "none") {
      return availableItems;
    }

    if (searchMatcher.kind === "regex") {
      return availableItems.filter((item) => {
        const title = toTitle(item.id);
        if (regexMatches(searchMatcher.regex, item.id)) {
          return true;
        }
        return regexMatches(searchMatcher.regex, title);
      });
    }

    const normalized = searchMatcher.normalizedNeedle;
    return availableItems.filter((item) => {
      const title = toTitle(item.id).toLowerCase();
      return item.id.toLowerCase().includes(normalized) || title.includes(normalized);
    });
  }, [availableItems, searchMatcher]);

  const categories = buildCategories(visibleItems);
  const categoryColumns = listWidth <= 860 ? 1 : 2;

  useEffect(() => {
    const element = listRef.current;
    if (!element) {
      return;
    }

    const syncMetrics = (): void => {
      setListHeight(element.clientHeight);
      setListWidth(element.clientWidth);
      setScrollTop(element.scrollTop);
    };
    syncMetrics();

    const onScroll = (): void => {
      setScrollTop(element.scrollTop);
    };

    const observer = new ResizeObserver(() => {
      syncMetrics();
    });
    observer.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, [isLoadingCatalog, catalogError]);

  const categoryMeta = useMemo(() => {
    return categories.map((category) => {
      const isCollapsed = trimmedSearch
        ? false
        : (collapsedOverrides[category.id] ??
          (category.items.length > defaultCollapseThreshold));
      const estimatedHeight = (() => {
        const headerHeight = 56;
        if (isCollapsed) {
          return headerHeight;
        }
        const rows = Math.max(1, Math.ceil(category.items.length / Math.max(1, categoryColumns)));
        const gridHeight = rows * 44 + Math.max(0, rows - 1) * 6 + 16;
        return headerHeight + gridHeight;
      })();
      return { category, isCollapsed, estimatedHeight };
    });
  }, [
    categories,
    categoryColumns,
    collapsedOverrides,
    defaultCollapseThreshold,
    trimmedSearch,
  ]);

  const virtualizedList = useMemo(() => {
    if (categoryMeta.length === 0) {
      return {
        totalHeight: 0,
        startIndex: 0,
        endIndex: -1,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }

    const heights = categoryMeta.map((entry) => measuredHeights[entry.category.id] ?? entry.estimatedHeight);
    const offsets: number[] = new Array(heights.length);
    let cursor = 0;
    for (let index = 0; index < heights.length; index += 1) {
      offsets[index] = cursor;
      cursor += heights[index] + (index < heights.length - 1 ? sectionGap : 0);
    }
    const totalHeight = cursor;
    const maxScrollTop = Math.max(0, totalHeight - Math.max(0, listHeight));
    const safeScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);

    const minY = Math.max(0, safeScrollTop - listOverscan);
    const maxY = safeScrollTop + Math.max(0, listHeight) + listOverscan;

    let startIndex = 0;
    while (
      startIndex < heights.length &&
      offsets[startIndex] + heights[startIndex] < minY
    ) {
      startIndex += 1;
    }
    if (startIndex >= heights.length) {
      startIndex = heights.length - 1;
    }

    let endIndex = startIndex;
    while (endIndex < heights.length && offsets[endIndex] <= maxY) {
      endIndex += 1;
    }
    endIndex = Math.min(heights.length - 1, Math.max(startIndex, endIndex - 1));

    const topSpacer = startIndex > 0 ? offsets[startIndex] : 0;
    const visibleBottom =
      endIndex >= startIndex ? offsets[endIndex] + heights[endIndex] : topSpacer;
    const bottomSpacer = Math.max(0, totalHeight - visibleBottom);

    return {
      totalHeight,
      startIndex,
      endIndex,
      topSpacer,
      bottomSpacer,
    };
  }, [categoryMeta, listHeight, listOverscan, measuredHeights, scrollTop]);

  function updateMeasuredHeight(categoryId: string, nextHeight: number): void {
    setMeasuredHeights((current) => {
      if (current[categoryId] === nextHeight) {
        return current;
      }
      return { ...current, [categoryId]: nextHeight };
    });
  }

  function collectLibrarySelectionWithinRect(
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): string[] {
    const root = listRef.current;
    if (!root) {
      return [];
    }

    const rootRect = root.getBoundingClientRect();
    const itemNodes = root.querySelectorAll<HTMLElement>("[data-library-item-id]");
    const selected: string[] = [];

    for (const node of itemNodes) {
      const itemId = node.dataset.libraryItemId;
      if (!itemId) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      const itemLeft = rect.left - rootRect.left;
      const itemTop = rect.top - rootRect.top;
      const itemRight = itemLeft + rect.width;
      const itemBottom = itemTop + rect.height;
      const intersects =
        itemRight >= left &&
        itemLeft <= right &&
        itemBottom >= top &&
        itemTop <= bottom;
      if (intersects) {
        selected.push(itemId);
      }
    }

    return selected;
  }

  function handleListPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !event.shiftKey) {
      return;
    }

    const root = listRef.current;
    if (!root) {
      return;
    }

    const rect = root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    selectionPointerId.current = event.pointerId;
    selectionStart.current = { x, y };
    selectionAnchorSet.current = new Set(selectedLibraryItemIds);
    setSelectionBox({ left: x, top: y, width: 0, height: 0 });

    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleListPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (
      selectionPointerId.current === null ||
      selectionPointerId.current !== event.pointerId ||
      !selectionStart.current ||
      !listRef.current
    ) {
      return;
    }

    const rect = listRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
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

    const intersected = collectLibrarySelectionWithinRect(left, top, right, bottom);
    const next = new Set(selectionAnchorSet.current);
    for (const itemId of intersected) {
      next.add(itemId);
    }
    setSelectedLibraryItemIds(next);
  }

  function handleListPointerEnd(event: PointerEvent<HTMLDivElement>): void {
    if (selectionPointerId.current === null || selectionPointerId.current !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    selectionPointerId.current = null;
    selectionStart.current = null;
    setSelectionBox(null);
  }

  return (
    <aside
      className="flex min-h-0 w-[min(420px,36vw)] min-w-75 max-w-125 flex-col overflow-hidden bg-linear-to-b from-[#fff7e7] to-[#feecd2] dark:from-[#1a283a] dark:to-[#111b2a] max-[1200px]:min-h-[38vh] max-[1200px]:w-full max-[1200px]:min-w-0 max-[1200px]:max-w-none"
      onDragOver={onLibraryDragOver}
      onDrop={onLibraryDrop}
      data-no-pan
    >
      <div className="grid gap-[0.4rem] border-b border-b-[rgba(134,106,67,0.3)] px-[0.95rem] pb-[0.9rem] pt-4 dark:border-b-[rgba(113,138,173,0.38)]">
        <div className="flex items-start justify-between gap-[0.45rem]">
          <div className="grid gap-[0.08rem]">
            <h2 className="m-0 text-[1.1rem] tracking-[0.02em] dark:text-[#e2edff]">Item Library</h2>
            {catalogGameVersion ? (
              <span className="text-[0.68rem] font-semibold text-[#6d6256] dark:text-[#a6b9d5]">
                Minecraft {catalogGameVersion}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-[0.2rem] rounded-[0.55rem] border border-[rgba(121,96,62,0.35)] bg-[rgba(255,250,239,0.95)] p-[0.2rem] dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(19,31,47,0.92)]">
            <button
              type="button"
              className={`rounded-[0.36rem] border px-[0.34rem] py-[0.16rem] text-[0.64rem] font-semibold ${
                fillDirection === "row"
                  ? "border-[rgba(33,114,82,0.58)] bg-[rgba(226,253,239,0.96)] text-[#245342] dark:border-[rgba(83,173,153,0.65)] dark:bg-[rgba(23,72,66,0.9)] dark:text-[#c2f3e8]"
                  : "border-[rgba(123,98,66,0.48)] bg-[rgba(255,255,255,0.92)] text-[#3b2f22] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,44,62,0.92)] dark:text-[#d4e2f5]"
              }`}
              onClick={() => onFillDirectionChange("row")}
            >
              Fill Row
            </button>
            <button
              type="button"
              className={`rounded-[0.36rem] border px-[0.34rem] py-[0.16rem] text-[0.64rem] font-semibold ${
                fillDirection === "column"
                  ? "border-[rgba(33,114,82,0.58)] bg-[rgba(226,253,239,0.96)] text-[#245342] dark:border-[rgba(83,173,153,0.65)] dark:bg-[rgba(23,72,66,0.9)] dark:text-[#c2f3e8]"
                  : "border-[rgba(123,98,66,0.48)] bg-[rgba(255,255,255,0.92)] text-[#3b2f22] dark:border-[rgba(112,136,167,0.52)] dark:bg-[rgba(31,44,62,0.92)] dark:text-[#d4e2f5]"
              }`}
              onClick={() => onFillDirectionChange("column")}
            >
              Fill Column
            </button>
          </div>
        </div>
        <p className="m-0 text-[0.78rem] text-[#6d6256] dark:text-[#a6b9d5]">
          {usedItemIds.size} placed / {catalogItems.length} total
        </p>
        <p className="m-0 mt-[-0.1rem] text-[0.72rem] text-[#4a6a5f] dark:text-[#89c7b4]">
          Drop a placed layout item here to return it to the list.
        </p>
        <p className="m-0 mt-[-0.1rem] text-[0.72rem] text-[#4a6a5f] dark:text-[#89c7b4]">
          Right-click an item to place it at the layout cursor.
        </p>

        <label className="grid gap-[0.22rem]">
          <span className="text-[0.74rem] text-[#6d6256] dark:text-[#a6b9d5]">Search</span>
          <div className="flex items-center gap-[0.45rem]">
            <input
              className="min-w-0 flex-1 rounded-[0.45rem] border border-[rgba(127,99,62,0.4)] bg-[#fffdf8] px-2 py-[0.42rem] text-[0.84rem] outline-none dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(18,30,47,0.95)] dark:text-[#e2ecfa] dark:placeholder:text-[#879cb9]"
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="diamond, concrete, chest, /[a-z]/i..."
            />
            <button
              type="button"
              className="shrink-0 rounded-[0.45rem] border border-[rgba(41,117,90,0.45)] bg-[rgba(234,255,245,0.96)] px-[0.58rem] py-[0.36rem] text-[0.72rem] font-semibold text-[#255344] disabled:cursor-not-allowed disabled:border-[rgba(121,96,62,0.28)] disabled:bg-[rgba(255,255,255,0.85)] disabled:text-[#847564] dark:border-[rgba(83,173,153,0.58)] dark:bg-[rgba(24,72,66,0.92)] dark:text-[#c2f3e8] dark:disabled:border-[rgba(104,122,147,0.35)] dark:disabled:bg-[rgba(26,37,54,0.85)] dark:disabled:text-[#7f95b3]"
              onClick={() => {
                const visibleItemIds = visibleItems.map((item) => item.id);
                const allVisibleSelected = visibleItemIds.every((itemId) =>
                  selectedLibraryItemIds.has(itemId),
                );
                if (allVisibleSelected) {
                  setSelectedLibraryItemIds(new Set());
                  return;
                }
                setSelectedLibraryItemIds(new Set(visibleItemIds));
              }}
              disabled={visibleItems.length === 0}
              title="Select all items matching current search"
            >
              Select all
            </button>
          </div>
        </label>
      </div>

      {isLoadingCatalog ? (
        <div className="mx-[0.95rem] my-[0.8rem] rounded-[0.6rem] border border-[rgba(122,99,66,0.32)] bg-[rgba(255,252,245,0.85)] px-3 py-[0.65rem] text-[0.84rem] text-[#6d6256] dark:border-[rgba(112,136,167,0.45)] dark:bg-[rgba(19,31,47,0.9)] dark:text-[#a6b9d5]">
          Loading item catalog...
        </div>
      ) : null}

      {catalogError ? (
        <div className="mx-[0.95rem] my-[0.8rem] rounded-[0.6rem] border border-[rgba(156,55,42,0.48)] bg-[rgba(255,234,230,0.95)] px-3 py-[0.65rem] text-[0.84rem] text-[#7c2217] dark:border-[rgba(200,111,111,0.62)] dark:bg-[rgba(92,37,37,0.88)] dark:text-[#ffd9d9]">
          {catalogError}
        </div>
      ) : null}

      {!isLoadingCatalog && !catalogError ? (
        <div
          ref={listRef}
          className="relative flex-1 overflow-y-auto overscroll-contain px-[0.8rem] pb-[0.8rem] pt-[0.6rem] max-[1200px]:overscroll-auto"
          onPointerDown={handleListPointerDown}
          onPointerMove={handleListPointerMove}
          onPointerUp={handleListPointerEnd}
          onPointerCancel={handleListPointerEnd}
          onClick={(event) => {
            const target = event.target as HTMLElement;
            if (!event.shiftKey && !target.closest("[data-library-item-id]")) {
              setSelectedLibraryItemIds(new Set());
            }
          }}
        >
          {selectionBox ? (
            <div
              className="pointer-events-none absolute z-10 rounded-[0.35rem] border border-[rgba(47,118,105,0.68)] bg-[rgba(129,219,199,0.2)] dark:border-[rgba(88,186,172,0.8)] dark:bg-[rgba(84,158,183,0.22)]"
              style={{
                left: selectionBox.left,
                top: selectionBox.top,
                width: selectionBox.width,
                height: selectionBox.height,
              }}
            />
          ) : null}
          {categories.length > 0 ? (
            <div style={{ minHeight: `${Math.ceil(virtualizedList.totalHeight)}px` }}>
              {virtualizedList.topSpacer > 0 ? (
                <div style={{ height: `${Math.ceil(virtualizedList.topSpacer)}px` }} />
              ) : null}

              {categoryMeta
                .slice(virtualizedList.startIndex, virtualizedList.endIndex + 1)
                .map(({ category, isCollapsed }, visibleIndex, visibleArray) => {
                  const categoryLabel = category.label || toTitle(category.id) || "Category";
                  const categoryItemIds = category.items.map((item) => item.id);
                  const isLastVisible = visibleIndex === visibleArray.length - 1;

                  return (
                    <section
                      key={category.id}
                      ref={(element) => {
                        if (!element) {
                          return;
                        }
                        updateMeasuredHeight(category.id, element.offsetHeight);
                      }}
                      className={`overflow-hidden rounded-[0.68rem] border border-[rgba(137,107,67,0.35)] bg-[rgba(255,251,241,0.9)] dark:border-[rgba(112,136,167,0.5)] dark:bg-[rgba(20,33,49,0.9)] ${
                        !isLastVisible ? "mb-[0.6rem]" : ""
                      }`}
                    >
                <div className="grid min-h-[2.35rem] grid-cols-[auto_1fr_auto] items-center gap-[0.4rem] border-b border-b-[rgba(145,114,73,0.22)] bg-[rgba(255,245,226,0.98)] px-2 py-2 dark:border-b-[rgba(107,130,161,0.4)] dark:bg-[rgba(24,39,58,0.95)]">
                  <button
                    type="button"
                    className="h-[1.4rem] w-[1.4rem] cursor-pointer rounded-[0.32rem] border border-[rgba(114,87,52,0.38)] bg-[#fffcf5] p-0 text-[#4f3c23] dark:border-[rgba(106,128,158,0.5)] dark:bg-[rgba(30,45,66,0.95)] dark:text-[#d0def2]"
                    aria-label={isCollapsed ? "Expand category" : "Collapse category"}
                    onClick={() => {
                      setCollapsedOverrides((current) => ({
                        ...current,
                        [category.id]: !isCollapsed,
                      }));
                    }}
                  >
                    {isCollapsed ? (
                      <svg
                        viewBox="0 0 16 16"
                        className="mx-auto h-3.5 w-3.5"
                        aria-hidden="true"
                      >
                        <path
                          d="M6 3.5L11 8L6 12.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 16 16"
                        className="mx-auto h-3.5 w-3.5"
                        aria-hidden="true"
                      >
                        <path
                          d="M3.5 6L8 11L12.5 6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>

                  <div className="grid gap-[0.1rem]">
                    <div className="text-[0.8rem] font-bold text-[#3f3327] dark:text-[#e2edff]">
                      {categoryLabel}
                    </div>
                    <div className="text-[0.68rem] text-[#6d6256] dark:text-[#9db2cf]">
                      {category.items.length} available
                    </div>
                  </div>

                  <button
                    type="button"
                    className="cursor-grab rounded-full border border-dashed border-[rgba(114,87,52,0.42)] bg-[#fff7e7] px-[0.36rem] py-[0.14rem] text-[0.66rem] font-bold text-[#5a4934] hover:border-[rgba(40,111,88,0.5)] hover:bg-[#f2fff9] dark:border-[rgba(106,128,158,0.55)] dark:bg-[rgba(30,45,66,0.95)] dark:text-[#d0def2] dark:hover:border-[rgba(83,173,153,0.58)] dark:hover:bg-[rgba(26,64,62,0.92)]"
                    draggable={category.items.length > 0}
                    onDragStart={(event) => onCategoryDragStart(event, categoryItemIds)}
                    onDragEnd={onAnyDragEnd}
                    title={`Drag ${categoryLabel}`}
                  >
                    Drag
                  </button>
                </div>

                {!isCollapsed ? (
                  <div className="grid grid-cols-2 gap-[0.34rem] p-2 max-[860px]:grid-cols-1">
                    {category.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`flex min-h-8 cursor-grab items-center gap-[0.4rem] rounded-lg border px-[0.4rem] py-[0.3rem] text-left text-[#342b21] dark:text-[#dce9fb] ${
                          selectedLibraryItemIds.has(item.id)
                            ? "border-[rgba(30,117,94,0.62)] bg-[rgba(223,250,240,0.98)] dark:border-[rgba(84,170,152,0.68)] dark:bg-[rgba(25,75,71,0.88)]"
                            : "border-[rgba(116,92,59,0.36)] bg-[rgba(255,253,247,0.95)] hover:border-[rgba(38,109,88,0.5)] hover:bg-[#f0fff8] dark:border-[rgba(106,128,158,0.48)] dark:bg-[rgba(27,41,60,0.9)] dark:hover:border-[rgba(83,173,153,0.62)] dark:hover:bg-[rgba(26,64,62,0.92)]"
                        }`}
                        draggable
                        onClick={(event) => {
                          if (event.shiftKey) {
                            event.preventDefault();
                            event.stopPropagation();
                            setSelectedLibraryItemIds((current) => {
                              const next = new Set(current);
                              if (next.has(item.id)) {
                                next.delete(item.id);
                              } else {
                                next.add(item.id);
                              }
                              return next;
                            });
                            return;
                          }

                          if (selectedLibraryItemIds.size === 0) {
                            return;
                          }

                          event.preventDefault();
                          event.stopPropagation();
                          setSelectedLibraryItemIds((current) => {
                            const next = new Set(current);
                            if (next.has(item.id)) {
                              next.delete(item.id);
                            } else {
                              next.add(item.id);
                            }
                            return next;
                          });
                        }}
                        onDragStart={(event) => {
                          if (event.shiftKey) {
                            event.preventDefault();
                            return;
                          }
                          const selectedInViewOrder = visibleItems
                            .filter((entry) => selectedLibraryItemIds.has(entry.id))
                            .map((entry) => entry.id);
                          if (
                            selectedLibraryItemIds.has(item.id) &&
                            selectedInViewOrder.length > 1
                          ) {
                            onCategoryDragStart(event, selectedInViewOrder);
                            return;
                          }
                          onItemDragStart(event, item.id);
                        }}
                        onDragEnd={onAnyDragEnd}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onItemContextPlace(item.id);
                        }}
                        title={`Drag ${toTitle(item.id)} (right-click to place at cursor)`}
                        data-library-item-id={item.id}
                      >
                        <Image
                          src={item.texturePath}
                          alt={item.id}
                          width={22}
                          height={22}
                          className="pointer-events-none"
                          style={{ imageRendering: "pixelated" }}
                          draggable={false}
                          unoptimized
                        />
                        <span className="text-[0.74rem] leading-[1.2]">
                          {highlightMatches(toTitle(item.id), searchMatcher)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                    </section>
                  );
                })}

              {virtualizedList.bottomSpacer > 0 ? (
                <div style={{ height: `${Math.ceil(virtualizedList.bottomSpacer)}px` }} />
              ) : null}
            </div>
          ) : null}

          {categories.length === 0 ? (
            <div className="mx-[0.95rem] my-[0.8rem] rounded-[0.6rem] border border-[rgba(122,99,66,0.32)] bg-[rgba(255,252,245,0.85)] px-3 py-[0.65rem] text-[0.84rem] text-[#6d6256] dark:border-[rgba(112,136,167,0.45)] dark:bg-[rgba(19,31,47,0.9)] dark:text-[#a6b9d5]">
              No items match your search.
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
