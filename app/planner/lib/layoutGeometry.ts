import { SLOT_GAP, SLOT_SIZE, STAGE_SIZE } from "../constants";
import { directionOrientation, resolveStorageLayout } from "../layoutConfig";
import type { HallConfig, HallId, SlotPoint } from "../types";
import { resolveHallSlices } from "../utils";

export function toPointKey(point: SlotPoint): string {
  return `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
}

function sideDepthPx(side: {
  type: "bulk" | "chest" | "mis";
  rowsPerSlice: number;
  misSlotsPerSlice: number;
}): number {
  if (side.type === "mis") {
    return side.rowsPerSlice * 112 + Math.max(0, side.rowsPerSlice - 1) * SLOT_GAP;
  }
  return side.rowsPerSlice * SLOT_SIZE + Math.max(0, side.rowsPerSlice - 1) * SLOT_GAP;
}

function misColumns(slotsPerSlice: number): number {
  return slotsPerSlice % 9 === 0
    ? 9
    : Math.min(12, Math.max(6, Math.ceil(Math.sqrt(slotsPerSlice))));
}

export function buildSlotCenters(
  hallConfigs: Record<HallId, HallConfig>,
): Map<string, SlotPoint> {
  const slotCenters = new Map<string, SlotPoint>();
  const center = STAGE_SIZE / 2;
  const resolvedLayout = resolveStorageLayout("cross", hallConfigs, center);
  const hallIds = Object.keys(hallConfigs).map((key) => Number(key));

  for (const hallId of hallIds) {
    const config = hallConfigs[hallId];
    const orientation = directionOrientation(resolvedLayout.directions[hallId]);
    const hallTopLeft = (() => {
      const placement = resolvedLayout.positions[hallId];
      const match = /translate\(([-\d.]+)%\s*,\s*([-\d.]+)%\)/.exec(placement.transform);
      const tx = match ? Number(match[1]) : 0;
      const ty = match ? Number(match[2]) : 0;
      const x = placement.left + (tx / 100) * placement.width;
      const y = placement.top + (ty / 100) * placement.height;
      return { x, y, width: placement.width, height: placement.height };
    })();

    const slices = resolveHallSlices(config);
    if (slices.length === 0) {
      continue;
    }

    let maxLeftDepth = 0;
    let maxRightDepth = 0;
    for (const slice of slices) {
      maxLeftDepth = Math.max(maxLeftDepth, sideDepthPx(slice.sideLeft));
      maxRightDepth = Math.max(maxRightDepth, sideDepthPx(slice.sideRight));
    }

    for (const slice of slices) {
      for (const side of [0, 1] as const) {
        const sideConfig = side === 0 ? slice.sideLeft : slice.sideRight;
        const sideDepth = sideDepthPx(sideConfig);

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
          const groupMainStart = groupFirstSlice.mainStart;
          const groupMainSize = groupLastSlice.mainStart + groupLastSlice.mainSize - groupFirstSlice.mainStart;
          const unitColumns = misColumns(sideConfig.misSlotsPerSlice);
          const unitRows = Math.max(1, Math.ceil(sideConfig.misSlotsPerSlice / unitColumns));
          for (let misRow = 0; misRow < sideConfig.rowsPerSlice; misRow += 1) {
            const unitMain = groupMainSize;
            const unitCross = sideDepth / sideConfig.rowsPerSlice;
            const cellMain = unitMain / unitColumns;
            const cellCross = unitCross / unitRows;

            for (let index = 0; index < sideConfig.misSlotsPerSlice; index += 1) {
              const column = index % unitColumns;
              const slotRow = Math.floor(index / unitColumns);

              if (orientation === "horizontal") {
                const baseY = side === 0 ? hallTopLeft.y : hallTopLeft.y + hallTopLeft.height - sideDepth;
                const x = hallTopLeft.x + groupMainStart + (column + 0.5) * cellMain;
                const y = baseY + misRow * unitCross + (slotRow + 0.5) * cellCross;
                slotCenters.set(`${hallId}:m:${misSlice}:${side}:${misRow}:${index}`, { x, y });
              } else {
                const baseX = side === 0 ? hallTopLeft.x : hallTopLeft.x + hallTopLeft.width - sideDepth;
                const x = baseX + misRow * unitCross + (slotRow + 0.5) * cellCross;
                const y = hallTopLeft.y + groupMainStart + (column + 0.5) * cellMain;
                slotCenters.set(`${hallId}:m:${misSlice}:${side}:${misRow}:${index}`, { x, y });
              }
            }
          }
          continue;
        }

        for (let row = 0; row < sideConfig.rowsPerSlice; row += 1) {
          if (orientation === "horizontal") {
            const baseY = side === 0 ? hallTopLeft.y : hallTopLeft.y + hallTopLeft.height - sideDepth;
            const x = hallTopLeft.x + slice.mainStart + slice.mainSize / 2;
            const y = baseY + row * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
            slotCenters.set(`${hallId}:g:${slice.globalSlice}:${side}:${row}`, { x, y });
          } else {
            const baseX = side === 0 ? hallTopLeft.x : hallTopLeft.x + hallTopLeft.width - sideDepth;
            const x = baseX + row * (SLOT_SIZE + SLOT_GAP) + SLOT_SIZE / 2;
            const y = hallTopLeft.y + slice.mainStart + slice.mainSize / 2;
            slotCenters.set(`${hallId}:g:${slice.globalSlice}:${side}:${row}`, { x, y });
          }
        }
      }
    }
  }

  return slotCenters;
}
