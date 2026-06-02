import type { StorageLayoutPreset } from "../layoutConfig";
import { buildInitialHallConfigs } from "../layoutConfig";
import type {
  FillDirection,
  HallConfig,
  HallDirection,
  HallId,
  HallSideConfig,
  HallType,
  PlannerLabelNames,
} from "../types";
import { clamp } from "../utils";

const STORAGE_LAYOUT_PRESETS: StorageLayoutPreset[] = ["single", "double", "triple", "cross", "h", "hcross", "octa"];
const FILL_DIRECTIONS: FillDirection[] = ["row", "column"];
const HALL_TYPES: HallType[] = ["bulk", "chest", "mis"];
const HALL_DIRECTIONS: HallDirection[] = ["north", "east", "south", "west"];
export const DEFAULT_MIS_SIGNAL_STRENGTH = 2;
export const MIN_MIS_SIGNAL_STRENGTH = 1;
export const MAX_MIS_SIGNAL_STRENGTH = 15;
export const DEFAULT_MIS_MULTIPLICITY = 1;
export const MIN_MIS_MULTIPLICITY = 1;
export const MAX_MIS_MULTIPLICITY = 16;

export const SAVE_FILE_VERSION = 1;

export type PlannerSnapshot = {
  storageLayoutPreset: StorageLayoutPreset;
  fillDirection: FillDirection;
  hallConfigs: Record<HallId, HallConfig>;
  slotAssignments: Record<string, string>;
  labelNames: PlannerLabelNames;
};

export type PlannerSaveFile = PlannerSnapshot & {
  version: number;
  savedAt: string;
};

type RecordDelta<T> = {
  set: Record<string, T>;
  remove: string[];
};

export type PlannerLabelNamesDelta = {
  layoutName?: string;
  hallNames?: RecordDelta<string>;
  sectionNames?: RecordDelta<string>;
  misNames?: RecordDelta<string>;
  misSignalStrengths?: RecordDelta<number>;
  misMultiplicities?: RecordDelta<number>;
};

export type PlannerSnapshotDelta = {
  storageLayoutPreset?: StorageLayoutPreset;
  fillDirection?: FillDirection;
  hallConfigs?: RecordDelta<HallConfig>;
  slotAssignments?: RecordDelta<string>;
  labelNames?: PlannerLabelNamesDelta;
};

export type PlannerHistoryEntry = {
  forward: PlannerSnapshotDelta;
  backward: PlannerSnapshotDelta;
  key: string;
};

export type PlannerHistoryState = {
  entries: PlannerHistoryEntry[];
  index: number;
  currentSnapshot: PlannerSnapshot;
};

export function sectionNameKey(hallId: HallId, sectionIndex: number): string {
  return `${hallId}:${sectionIndex}`;
}

export function misNameKey(
  hallId: HallId,
  slice: number,
  side: 0 | 1,
  row: number,
): string {
  return `${hallId}:${slice}:${side}:${row}`;
}

export function createEmptyPlannerLabelNames(): PlannerLabelNames {
  return {
    layoutName: "",
    hallNames: {},
    sectionNames: {},
    misNames: {},
    misSignalStrengths: {},
    misMultiplicities: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function defaultSideConfig(type: HallType): HallSideConfig {
  switch (type) {
    case "bulk":
      return {
        type: "bulk",
        rowsPerSlice: 1,
        misSlotsPerSlice: 54,
        misWidth: 1,
      };
    case "chest":
      return {
        type: "chest",
        rowsPerSlice: 4,
        misSlotsPerSlice: 54,
        misWidth: 1,
      };
    case "mis":
      return {
        type: "mis",
        rowsPerSlice: 4,
        misSlotsPerSlice: 54,
        misWidth: 2,
      };
  }
}

function cloneHallConfig(hallConfig: HallConfig): HallConfig {
  const nextConfig: HallConfig = {
    direction: hallConfig.direction,
    sections: hallConfig.sections.map((section) => ({
      slices: section.slices,
      sideLeft: { ...section.sideLeft },
      sideRight: { ...section.sideRight },
    })),
  };
  if (typeof hallConfig.name === "string") {
    nextConfig.name = hallConfig.name;
  }
  return nextConfig;
}

export function cloneHallConfigs(hallConfigs: Record<HallId, HallConfig>): Record<HallId, HallConfig> {
  const normalized: Record<HallId, HallConfig> = {};
  const entries = Object.entries(hallConfigs).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [hallIdRaw, hallConfig] of entries) {
    const hallId = Number(hallIdRaw);
    normalized[hallId] = cloneHallConfig(hallConfig);
  }
  return normalized;
}

export function cloneSlotAssignments(slotAssignments: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(slotAssignments)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function cloneHallNames(hallNames: Record<HallId, string>): Record<HallId, string> {
  const normalized: Record<HallId, string> = {};
  const entries = Object.entries(hallNames)
    .map(([hallIdRaw, hallName]) => [Number(hallIdRaw), hallName] as const)
    .filter(
      (entry): entry is [HallId, string] =>
        Number.isInteger(entry[0]) &&
        entry[0] > 0 &&
        typeof entry[1] === "string" &&
        entry[1].trim().length > 0,
    )
    .sort((a, b) => a[0] - b[0]);
  for (const [hallId, hallName] of entries) {
    normalized[hallId] = hallName.trim();
  }
  return normalized;
}

function cloneNameMap(nameMap: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(nameMap)
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          entry[0].trim().length > 0 &&
          typeof entry[1] === "string" &&
          entry[1].trim().length > 0,
      )
      .map(([key, value]) => [key, value.trim()] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function normalizeMisSignalStrength(value: unknown): number {
  return clamp(
    Math.round(toFiniteNumber(value, DEFAULT_MIS_SIGNAL_STRENGTH)),
    MIN_MIS_SIGNAL_STRENGTH,
    MAX_MIS_SIGNAL_STRENGTH,
  );
}

function normalizeMisMultiplicity(value: unknown): number {
  return clamp(
    Math.round(toFiniteNumber(value, DEFAULT_MIS_MULTIPLICITY)),
    MIN_MIS_MULTIPLICITY,
    MAX_MIS_MULTIPLICITY,
  );
}

function cloneMisSignalStrengthMap(signalStrengths: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(signalStrengths)
      .filter((entry): entry is [string, number] => {
        const [key, value] = entry;
        return (
          typeof key === "string" &&
          key.trim().length > 0 &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          normalizeMisSignalStrength(value) !== DEFAULT_MIS_SIGNAL_STRENGTH
        );
      })
      .map(([key, value]) => [key, normalizeMisSignalStrength(value)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function cloneMisMultiplicityMap(multiplicities: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(multiplicities)
      .filter((entry): entry is [string, number] => {
        const [key, value] = entry;
        return (
          typeof key === "string" &&
          key.trim().length > 0 &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          normalizeMisMultiplicity(value) !== DEFAULT_MIS_MULTIPLICITY
        );
      })
      .map(([key, value]) => [key, normalizeMisMultiplicity(value)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

export function clonePlannerLabelNames(labelNames: PlannerLabelNames): PlannerLabelNames {
  return {
    layoutName: labelNames.layoutName.trim(),
    hallNames: cloneHallNames(labelNames.hallNames),
    sectionNames: cloneNameMap(labelNames.sectionNames),
    misNames: cloneNameMap(labelNames.misNames),
    misSignalStrengths: cloneMisSignalStrengthMap(labelNames.misSignalStrengths),
    misMultiplicities: cloneMisMultiplicityMap(labelNames.misMultiplicities),
  };
}

export function buildPlannerSnapshot(input: PlannerSnapshot): PlannerSnapshot {
  return {
    storageLayoutPreset: input.storageLayoutPreset,
    fillDirection: input.fillDirection,
    hallConfigs: cloneHallConfigs(input.hallConfigs),
    slotAssignments: cloneSlotAssignments(input.slotAssignments),
    labelNames: clonePlannerLabelNames(input.labelNames),
  };
}

export function snapshotToKey(snapshot: PlannerSnapshot): string {
  return JSON.stringify(snapshot);
}

function createRecordDelta<T>(): RecordDelta<T> {
  return {
    set: {},
    remove: [],
  };
}

function hasRecordDelta<T>(delta: RecordDelta<T>): boolean {
  return Object.keys(delta.set).length > 0 || delta.remove.length > 0;
}

function isHallSideConfigEqual(a: HallSideConfig, b: HallSideConfig): boolean {
  return (
    a.type === b.type &&
    a.rowsPerSlice === b.rowsPerSlice &&
    a.misSlotsPerSlice === b.misSlotsPerSlice &&
    a.misWidth === b.misWidth
  );
}

function isHallConfigEqual(a: HallConfig, b: HallConfig): boolean {
  if ((a.name ?? "") !== (b.name ?? "")) {
    return false;
  }
  if (a.direction !== b.direction) {
    return false;
  }
  if (a.sections.length !== b.sections.length) {
    return false;
  }

  for (let index = 0; index < a.sections.length; index += 1) {
    const aSection = a.sections[index];
    const bSection = b.sections[index];
    if (
      aSection.slices !== bSection.slices ||
      !isHallSideConfigEqual(aSection.sideLeft, bSection.sideLeft) ||
      !isHallSideConfigEqual(aSection.sideRight, bSection.sideRight)
    ) {
      return false;
    }
  }

  return true;
}

function diffStringRecord(
  previous: Record<string, string>,
  next: Record<string, string>,
): RecordDelta<string> | null {
  const delta = createRecordDelta<string>();

  const nextEntries = Object.entries(next).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of nextEntries) {
    if (previous[key] !== value) {
      delta.set[key] = value;
    }
  }

  const removedKeys = Object.keys(previous)
    .filter((key) => !(key in next))
    .sort((a, b) => a.localeCompare(b));
  delta.remove.push(...removedKeys);

  return hasRecordDelta(delta) ? delta : null;
}

function applyStringRecordDelta(
  base: Record<string, string>,
  delta: RecordDelta<string>,
): Record<string, string> {
  const next = { ...base };
  for (const key of delta.remove) {
    delete next[key];
  }
  for (const [key, value] of Object.entries(delta.set)) {
    next[key] = value;
  }
  return next;
}

function diffNumberRecord(
  previous: Record<string, number>,
  next: Record<string, number>,
): RecordDelta<number> | null {
  const delta = createRecordDelta<number>();

  const nextEntries = Object.entries(next).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of nextEntries) {
    if (previous[key] !== value) {
      delta.set[key] = value;
    }
  }

  const removedKeys = Object.keys(previous)
    .filter((key) => !(key in next))
    .sort((a, b) => a.localeCompare(b));
  delta.remove.push(...removedKeys);

  return hasRecordDelta(delta) ? delta : null;
}

function applyNumberRecordDelta(
  base: Record<string, number>,
  delta: RecordDelta<number>,
): Record<string, number> {
  const next = { ...base };
  for (const key of delta.remove) {
    delete next[key];
  }
  for (const [key, value] of Object.entries(delta.set)) {
    next[key] = value;
  }
  return next;
}

function diffHallConfigs(
  previous: Record<HallId, HallConfig>,
  next: Record<HallId, HallConfig>,
): RecordDelta<HallConfig> | null {
  const delta = createRecordDelta<HallConfig>();
  const previousByKey = new Map<string, HallConfig>(
    Object.entries(previous).map(([hallId, hallConfig]) => [String(Number(hallId)), hallConfig]),
  );
  const nextEntries = Object.entries(next)
    .map(([hallId, hallConfig]) => [Number(hallId), hallConfig] as const)
    .sort((a, b) => a[0] - b[0]);

  for (const [hallId, hallConfig] of nextEntries) {
    const key = String(hallId);
    const previousHallConfig = previousByKey.get(key);
    if (!previousHallConfig || !isHallConfigEqual(previousHallConfig, hallConfig)) {
      delta.set[key] = cloneHallConfig(hallConfig);
    }
    previousByKey.delete(key);
  }

  const removedKeys = Array.from(previousByKey.keys()).sort((a, b) => Number(a) - Number(b));
  delta.remove.push(...removedKeys);

  return hasRecordDelta(delta) ? delta : null;
}

function applyHallConfigDelta(
  base: Record<HallId, HallConfig>,
  delta: RecordDelta<HallConfig>,
): Record<HallId, HallConfig> {
  const next = { ...base };
  for (const key of delta.remove) {
    delete next[Number(key)];
  }
  for (const [key, value] of Object.entries(delta.set)) {
    next[Number(key)] = cloneHallConfig(value);
  }
  return next;
}

function diffHallNameRecord(
  previous: Record<HallId, string>,
  next: Record<HallId, string>,
): RecordDelta<string> | null {
  const delta = createRecordDelta<string>();
  const previousByKey = new Map<string, string>(
    Object.entries(previous).map(([hallId, hallName]) => [String(Number(hallId)), hallName]),
  );
  const nextEntries = Object.entries(next)
    .map(([hallId, hallName]) => [Number(hallId), hallName] as const)
    .sort((a, b) => a[0] - b[0]);

  for (const [hallId, hallName] of nextEntries) {
    const key = String(hallId);
    if (previousByKey.get(key) !== hallName) {
      delta.set[key] = hallName;
    }
    previousByKey.delete(key);
  }

  const removedKeys = Array.from(previousByKey.keys()).sort((a, b) => Number(a) - Number(b));
  delta.remove.push(...removedKeys);

  return hasRecordDelta(delta) ? delta : null;
}

function applyHallNameDelta(
  base: Record<HallId, string>,
  delta: RecordDelta<string>,
): Record<HallId, string> {
  const next = { ...base };
  for (const key of delta.remove) {
    delete next[Number(key)];
  }
  for (const [key, value] of Object.entries(delta.set)) {
    next[Number(key)] = value;
  }
  return next;
}

function diffPlannerLabelNames(
  previous: PlannerLabelNames,
  next: PlannerLabelNames,
): PlannerLabelNamesDelta | null {
  const layoutName = previous.layoutName !== next.layoutName ? next.layoutName : undefined;
  const hallNames = diffHallNameRecord(previous.hallNames, next.hallNames);
  const sectionNames = diffStringRecord(previous.sectionNames, next.sectionNames);
  const misNames = diffStringRecord(previous.misNames, next.misNames);
  const misSignalStrengths = diffNumberRecord(previous.misSignalStrengths, next.misSignalStrengths);
  const misMultiplicities = diffNumberRecord(previous.misMultiplicities, next.misMultiplicities);

  if (!layoutName && !hallNames && !sectionNames && !misNames && !misSignalStrengths && !misMultiplicities) {
    return null;
  }

  return {
    layoutName,
    hallNames: hallNames ?? undefined,
    sectionNames: sectionNames ?? undefined,
    misNames: misNames ?? undefined,
    misSignalStrengths: misSignalStrengths ?? undefined,
    misMultiplicities: misMultiplicities ?? undefined,
  };
}

function applyPlannerLabelNamesDelta(
  base: PlannerLabelNames,
  delta: PlannerLabelNamesDelta,
): PlannerLabelNames {
  return {
    layoutName: delta.layoutName ?? base.layoutName,
    hallNames: delta.hallNames ? applyHallNameDelta(base.hallNames, delta.hallNames) : base.hallNames,
    sectionNames: delta.sectionNames
      ? applyStringRecordDelta(base.sectionNames, delta.sectionNames)
      : base.sectionNames,
    misNames: delta.misNames
      ? applyStringRecordDelta(base.misNames, delta.misNames)
      : base.misNames,
    misSignalStrengths: delta.misSignalStrengths
      ? applyNumberRecordDelta(base.misSignalStrengths, delta.misSignalStrengths)
      : base.misSignalStrengths,
    misMultiplicities: delta.misMultiplicities
      ? applyNumberRecordDelta(base.misMultiplicities, delta.misMultiplicities)
      : base.misMultiplicities,
  };
}

export function diffPlannerSnapshot(
  previous: PlannerSnapshot,
  next: PlannerSnapshot,
): PlannerSnapshotDelta | null {
  const delta: PlannerSnapshotDelta = {};

  if (previous.storageLayoutPreset !== next.storageLayoutPreset) {
    delta.storageLayoutPreset = next.storageLayoutPreset;
  }
  if (previous.fillDirection !== next.fillDirection) {
    delta.fillDirection = next.fillDirection;
  }

  const hallConfigs = diffHallConfigs(previous.hallConfigs, next.hallConfigs);
  if (hallConfigs) {
    delta.hallConfigs = hallConfigs;
  }

  const slotAssignments = diffStringRecord(previous.slotAssignments, next.slotAssignments);
  if (slotAssignments) {
    delta.slotAssignments = slotAssignments;
  }

  const labelNames = diffPlannerLabelNames(previous.labelNames, next.labelNames);
  if (labelNames) {
    delta.labelNames = labelNames;
  }

  return Object.keys(delta).length > 0 ? delta : null;
}

export function applyPlannerSnapshotDelta(
  base: PlannerSnapshot,
  delta: PlannerSnapshotDelta,
): PlannerSnapshot {
  return buildPlannerSnapshot({
    storageLayoutPreset: delta.storageLayoutPreset ?? base.storageLayoutPreset,
    fillDirection: delta.fillDirection ?? base.fillDirection,
    hallConfigs: delta.hallConfigs
      ? applyHallConfigDelta(base.hallConfigs, delta.hallConfigs)
      : base.hallConfigs,
    slotAssignments: delta.slotAssignments
      ? applyStringRecordDelta(base.slotAssignments, delta.slotAssignments)
      : base.slotAssignments,
    labelNames: delta.labelNames
      ? applyPlannerLabelNamesDelta(base.labelNames, delta.labelNames)
      : base.labelNames,
  });
}

function parseStorageLayoutPreset(value: unknown): StorageLayoutPreset | null {
  if (typeof value !== "string") {
    return null;
  }
  return STORAGE_LAYOUT_PRESETS.includes(value as StorageLayoutPreset)
    ? (value as StorageLayoutPreset)
    : null;
}

function parseFillDirection(value: unknown): FillDirection | null {
  if (typeof value !== "string") {
    return null;
  }
  return FILL_DIRECTIONS.includes(value as FillDirection) ? (value as FillDirection) : null;
}

function parseHallType(value: unknown): HallType | null {
  if (typeof value !== "string") {
    return null;
  }
  return HALL_TYPES.includes(value as HallType) ? (value as HallType) : null;
}

function parseHallDirection(value: unknown): HallDirection | null {
  if (typeof value !== "string") {
    return null;
  }
  return HALL_DIRECTIONS.includes(value as HallDirection) ? (value as HallDirection) : null;
}

function parseHallSideConfig(value: unknown): HallSideConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = parseHallType(value.type);
  if (!type) {
    return null;
  }

  const defaults = defaultSideConfig(type);
  const rowsPerSliceFallback = defaults.rowsPerSlice;
  const rowsPerSliceMax = type === "mis" ? 8 : 9;
  return {
    type,
    rowsPerSlice: clamp(toFiniteNumber(value.rowsPerSlice, rowsPerSliceFallback), 1, rowsPerSliceMax),
    misSlotsPerSlice: clamp(
      toFiniteNumber(value.misSlotsPerSlice, defaults.misSlotsPerSlice),
      1,
      200,
    ),
    misWidth: clamp(toFiniteNumber(value.misWidth, defaults.misWidth), 1, 16),
  };
}

function parseHallConfig(value: unknown, fallbackDirection: HallDirection): HallConfig | null {
  if (!isRecord(value) || !Array.isArray(value.sections) || value.sections.length === 0) {
    return null;
  }

  const sections = value.sections.map((sectionValue) => {
    if (!isRecord(sectionValue)) {
      return null;
    }

    const sideLeft = parseHallSideConfig(sectionValue.sideLeft);
    const sideRight = parseHallSideConfig(sectionValue.sideRight);
    if (!sideLeft || !sideRight) {
      return null;
    }

    return {
      slices: clamp(toFiniteNumber(sectionValue.slices, 1), 1, 200),
      sideLeft,
      sideRight,
    };
  });

  if (sections.some((section) => section === null)) {
    return null;
  }

  const hallConfig: HallConfig = {
    direction: parseHallDirection(value.direction) ?? fallbackDirection,
    sections: sections.filter((section): section is HallConfig["sections"][number] => Boolean(section)),
  };
  if (typeof value.name === "string") {
    hallConfig.name = value.name;
  }
  return hallConfig;
}

function parseHallConfigs(
  value: unknown,
  preset: StorageLayoutPreset,
): Record<HallId, HallConfig> | null {
  if (!isRecord(value)) {
    return null;
  }

  const defaultHallConfigs = buildInitialHallConfigs(preset);
  const entries: Array<[HallId, HallConfig]> = [];
  for (const [hallIdRaw, hallConfigValue] of Object.entries(value)) {
    const hallId = Number(hallIdRaw);
    if (!Number.isInteger(hallId) || hallId <= 0) {
      return null;
    }

    const fallbackDirection = defaultHallConfigs[hallId]?.direction ?? "east";
    const hallConfig = parseHallConfig(hallConfigValue, fallbackDirection);
    if (!hallConfig) {
      return null;
    }

    entries.push([hallId, hallConfig]);
  }

  if (entries.length === 0) {
    return null;
  }

  entries.sort((a, b) => a[0] - b[0]);
  const normalized: Record<HallId, HallConfig> = {};
  for (const [hallId, hallConfig] of entries) {
    normalized[hallId] = hallConfig;
  }
  return normalized;
}

function parseSlotAssignments(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].trim().length > 0,
    )
    .sort((a, b) => a[0].localeCompare(b[0]));

  return Object.fromEntries(entries);
}

function parseHallNames(value: unknown): Record<HallId, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .map(([hallIdRaw, hallName]) => [Number(hallIdRaw), hallName] as const)
    .filter(
      (entry): entry is [HallId, string] =>
        Number.isInteger(entry[0]) &&
        entry[0] > 0 &&
        typeof entry[1] === "string" &&
        entry[1].trim().length > 0,
    )
    .sort((a, b) => a[0] - b[0]);

  const normalized: Record<HallId, string> = {};
  for (const [hallId, hallName] of entries) {
    normalized[hallId] = hallName.trim();
  }
  return normalized;
}

function parseNameMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" &&
        entry[0].trim().length > 0 &&
        typeof entry[1] === "string" &&
        entry[1].trim().length > 0,
    )
    .map(([key, name]) => [key, name.trim()] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  return Object.fromEntries(entries);
}

function parseMisSignalStrengthMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, unknown] => {
      const [key, signalStrength] = entry;
      return (
        typeof key === "string" &&
        key.trim().length > 0 &&
        Number.isFinite(Number(signalStrength)) &&
        normalizeMisSignalStrength(signalStrength) !== DEFAULT_MIS_SIGNAL_STRENGTH
      );
    })
    .map(([key, signalStrength]) => [key, normalizeMisSignalStrength(signalStrength)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  return Object.fromEntries(entries);
}

function parseMisMultiplicityMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, unknown] => {
      const [key, multiplicity] = entry;
      return (
        typeof key === "string" &&
        key.trim().length > 0 &&
        Number.isFinite(Number(multiplicity)) &&
        normalizeMisMultiplicity(multiplicity) !== DEFAULT_MIS_MULTIPLICITY
      );
    })
    .map(([key, multiplicity]) => [key, normalizeMisMultiplicity(multiplicity)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

  return Object.fromEntries(entries);
}

function parsePlannerLabelNames(value: unknown): PlannerLabelNames {
  if (!isRecord(value)) {
    return createEmptyPlannerLabelNames();
  }

  const layoutName =
    typeof value.layoutName === "string" && value.layoutName.trim().length > 0
      ? value.layoutName.trim()
      : "";

  return {
    layoutName,
    hallNames: parseHallNames(value.hallNames),
    sectionNames: parseNameMap(value.sectionNames),
    misNames: parseNameMap(value.misNames),
    misSignalStrengths: parseMisSignalStrengthMap(value.misSignalStrengths),
    misMultiplicities: parseMisMultiplicityMap(value.misMultiplicities),
  };
}

export function parsePlannerSnapshot(value: unknown): PlannerSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  if ("version" in value && value.version !== SAVE_FILE_VERSION) {
    return null;
  }

  const storageLayoutPreset = parseStorageLayoutPreset(value.storageLayoutPreset);
  const fillDirection = parseFillDirection(value.fillDirection);
  const hallConfigs = storageLayoutPreset
    ? parseHallConfigs(value.hallConfigs, storageLayoutPreset)
    : null;

  if (!storageLayoutPreset || !fillDirection || !hallConfigs) {
    return null;
  }

  const labelNames =
    "labelNames" in value
      ? parsePlannerLabelNames(value.labelNames)
      : parsePlannerLabelNames({
          layoutName: value.layoutName,
          hallNames: value.hallNames,
          sectionNames: value.sectionNames,
          misNames: value.misNames,
          misSignalStrengths: value.misSignalStrengths,
          misMultiplicities: value.misMultiplicities,
        });

  return {
    storageLayoutPreset,
    fillDirection,
    hallConfigs,
    slotAssignments: parseSlotAssignments(value.slotAssignments),
    labelNames,
  };
}
