import { type DragEvent, type ReactNode } from "react";
import { SLOT_SIZE } from "../../constants";
import type { HallId } from "../../types";

export type ExpandedMisTarget = {
  hallId: HallId;
  slice: number;
  side: 0 | 1;
  row: number;
};

export type ExpandedMisPanel = ExpandedMisTarget & {
  slotIds: string[];
  columns: number;
  capacity: number;
  fallbackLabel: string;
};

type ExpandedMisPanelsOverlayProps = {
  panels: ExpandedMisPanel[];
  slotAssignments: Record<string, string>;
  onSlotGroupDragStart: (
    event: DragEvent<HTMLElement>,
    slotIds: string[],
    originSlotId?: string,
  ) => void;
  onAnyDragEnd: () => void;
  onClosePanel: (target: ExpandedMisTarget) => void;
  onRenameMis: (target: ExpandedMisTarget, rawName: string) => void;
  misDisplayName: (target: ExpandedMisTarget, fallback: string) => string;
  renderSlot: (slotId: string) => ReactNode;
};

export function ExpandedMisPanelsOverlay({
  panels,
  slotAssignments,
  onSlotGroupDragStart,
  onAnyDragEnd,
  onClosePanel,
  onRenameMis,
  misDisplayName,
  renderSlot,
}: ExpandedMisPanelsOverlayProps) {
  if (panels.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute left-1/2 top-5 z-30 flex max-w-[96vw] -translate-x-1/2 items-start gap-3"
      data-no-pan
      onClick={(event) => event.stopPropagation()}
    >
      {panels.map((panel, index) => {
        const isPrimary = index === 0;
        const frameClass = isPrimary
          ? "border-[rgba(58,90,74,0.55)] bg-[linear-gradient(180deg,rgba(244,250,240,0.97)_0%,rgba(223,236,216,0.97)_100%)] dark:border-[rgba(83,157,139,0.55)] dark:bg-[linear-gradient(180deg,rgba(23,49,48,0.96)_0%,rgba(17,35,36,0.96)_100%)]"
          : "border-[rgba(64,78,112,0.55)] bg-[linear-gradient(180deg,rgba(240,246,255,0.97)_0%,rgba(217,228,246,0.97)_100%)] dark:border-[rgba(100,128,173,0.55)] dark:bg-[linear-gradient(180deg,rgba(24,41,68,0.96)_0%,rgba(17,31,52,0.96)_100%)]";
        const headerClass = isPrimary
          ? "border-[rgba(63,88,72,0.28)] text-[#2e5042] dark:border-[rgba(92,154,142,0.5)] dark:text-[#c6f3e7]"
          : "border-[rgba(64,82,108,0.28)] text-[#2d4464] dark:border-[rgba(114,139,184,0.5)] dark:text-[#d5e6ff]";
        const subTextClass = isPrimary ? "text-[#3e6455] dark:text-[#9fd5c7]" : "text-[#45608a] dark:text-[#aac2e8]";
        const closeClass = isPrimary
          ? "border-[rgba(82,104,88,0.45)] bg-[rgba(253,255,252,0.92)] text-[#2f4b3f] dark:border-[rgba(92,154,142,0.58)] dark:bg-[rgba(22,59,55,0.9)] dark:text-[#c6f3e7]"
          : "border-[rgba(86,100,130,0.45)] bg-[rgba(252,254,255,0.92)] text-[#334d70] dark:border-[rgba(114,139,184,0.58)] dark:bg-[rgba(23,48,77,0.9)] dark:text-[#d5e6ff]";
        const panelTarget: ExpandedMisTarget = {
          hallId: panel.hallId,
          slice: panel.slice,
          side: panel.side,
          row: panel.row,
        };
        const panelKey = `${panel.hallId}:${panel.slice}:${panel.side}:${panel.row}`;
        return (
          <div
            key={panelKey}
            className={`w-[min(30vw,370px)] overflow-hidden rounded-[0.85rem] border shadow-[0_12px_34px_rgba(38,48,33,0.28)] dark:shadow-[0_16px_38px_rgba(4,8,16,0.5)] max-[980px]:w-[78vw] ${frameClass}`}
            data-mis-panel
          >
            <header
              className={`flex items-center justify-between border-b px-3 py-2 ${headerClass}`}
              draggable={panel.slotIds.some((slotId) => Boolean(slotAssignments[slotId]))}
              onDragStart={(event) => {
                if (event.shiftKey) {
                  event.preventDefault();
                  return;
                }
                onSlotGroupDragStart(event, panel.slotIds, panel.slotIds[0]);
              }}
              onDragEnd={onAnyDragEnd}
            >
              <div className="grid min-w-0 flex-1 gap-[0.08rem]">
                <div className="text-[0.78rem] font-bold tracking-[0.02em]">
                  <span
                    className="rounded-[0.22rem] px-[0.12rem] normal-case focus:bg-[rgba(255,255,255,0.84)] focus:outline-none dark:focus:bg-[rgba(33,49,72,0.92)]"
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    tabIndex={0}
                    title="Click to rename MIS"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) =>
                      onRenameMis(panelTarget, event.currentTarget.textContent ?? "")
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                  >{misDisplayName(panelTarget, panel.fallbackLabel)}</span>
                </div>
                <div className={`text-[0.68rem] ${subTextClass}`}>
                  {panel.slotIds.filter((slotId) => Boolean(slotAssignments[slotId])).length}/
                  {panel.capacity} assigned
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className={`rounded-[0.4rem] border px-2 py-[0.2rem] text-[0.72rem] font-semibold ${closeClass}`}
                  onClick={() => onClosePanel(panelTarget)}
                >
                  Close
                </button>
              </div>
            </header>
            <div className="max-h-[64vh] overflow-auto p-4">
              <div
                className="grid content-start gap-1"
                style={{
                  gridTemplateColumns: `repeat(${panel.columns}, ${SLOT_SIZE}px)`,
                }}
              >
                {panel.slotIds.map((slotId) => renderSlot(slotId))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
