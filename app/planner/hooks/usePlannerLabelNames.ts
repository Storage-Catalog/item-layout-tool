import { useCallback, useState } from "react";
import type { HallId, PlannerLabelNames } from "../types";
import {
  DEFAULT_MIS_MULTIPLICITY,
  DEFAULT_MIS_SIGNAL_STRENGTH,
  MAX_MIS_MULTIPLICITY,
  MAX_MIS_SIGNAL_STRENGTH,
  MIN_MIS_MULTIPLICITY,
  MIN_MIS_SIGNAL_STRENGTH,
  clonePlannerLabelNames,
  createEmptyPlannerLabelNames,
  misNameKey,
  sectionNameKey,
} from "../lib/plannerSnapshot";
import { clamp } from "../utils";

type UsePlannerLabelNamesResult = {
  labelNames: PlannerLabelNames;
  replaceLabelNames: (next: PlannerLabelNames) => void;
  handleLayoutNameChange: (rawName: string) => void;
  handleHallNameChange: (hallId: HallId, rawName: string) => void;
  handleSectionNameChange: (hallId: HallId, sectionIndex: number, rawName: string) => void;
  handleMisNameChange: (
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawName: string,
  ) => void;
  handleMisSignalStrengthChange: (
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawValue: string | number,
  ) => void;
  handleMisMultiplicityChange: (
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawValue: string | number,
  ) => void;
};

export function usePlannerLabelNames(): UsePlannerLabelNamesResult {
  const [labelNames, setLabelNames] = useState<PlannerLabelNames>(() =>
    createEmptyPlannerLabelNames(),
  );

  const replaceLabelNames = useCallback((next: PlannerLabelNames) => {
    setLabelNames(clonePlannerLabelNames(next));
  }, []);

  const handleLayoutNameChange = useCallback((rawName: string) => {
    setLabelNames((current) => {
      if (current.layoutName === rawName) {
        return current;
      }
      return {
        ...current,
        layoutName: rawName,
      };
    });
  }, []);

  const handleHallNameChange = useCallback((hallId: HallId, rawName: string) => {
    const trimmed = rawName.trim();
    setLabelNames((current) => {
      if (trimmed.length === 0) {
        if (!(hallId in current.hallNames)) {
          return current;
        }
        const nextHallNames = { ...current.hallNames };
        delete nextHallNames[hallId];
        return {
          ...current,
          hallNames: nextHallNames,
        };
      }

      if (current.hallNames[hallId] === trimmed) {
        return current;
      }

      return {
        ...current,
        hallNames: {
          ...current.hallNames,
          [hallId]: trimmed,
        },
      };
    });
  }, []);

  const handleSectionNameChange = useCallback((
    hallId: HallId,
    sectionIndex: number,
    rawName: string,
  ) => {
    const key = sectionNameKey(hallId, sectionIndex);
    const trimmed = rawName.trim();
    setLabelNames((current) => {
      if (trimmed.length === 0) {
        if (!(key in current.sectionNames)) {
          return current;
        }
        const nextSectionNames = { ...current.sectionNames };
        delete nextSectionNames[key];
        return {
          ...current,
          sectionNames: nextSectionNames,
        };
      }

      if (current.sectionNames[key] === trimmed) {
        return current;
      }

      return {
        ...current,
        sectionNames: {
          ...current.sectionNames,
          [key]: trimmed,
        },
      };
    });
  }, []);

  const handleMisNameChange = useCallback((
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawName: string,
  ) => {
    const key = misNameKey(hallId, slice, side, row);
    const trimmed = rawName.trim();
    setLabelNames((current) => {
      if (trimmed.length === 0) {
        if (!(key in current.misNames)) {
          return current;
        }
        const nextMisNames = { ...current.misNames };
        delete nextMisNames[key];
        return {
          ...current,
          misNames: nextMisNames,
        };
      }

      if (current.misNames[key] === trimmed) {
        return current;
      }

      return {
        ...current,
        misNames: {
          ...current.misNames,
          [key]: trimmed,
        },
      };
    });
  }, []);

  const handleMisSignalStrengthChange = useCallback((
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawValue: string | number,
  ) => {
    const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return;
    }
    const signalStrength = clamp(
      Math.round(numericValue),
      MIN_MIS_SIGNAL_STRENGTH,
      MAX_MIS_SIGNAL_STRENGTH,
    );
    const key = misNameKey(hallId, slice, side, row);

    setLabelNames((current) => {
      if (signalStrength === DEFAULT_MIS_SIGNAL_STRENGTH) {
        if (!(key in current.misSignalStrengths)) {
          return current;
        }
        const nextMisSignalStrengths = { ...current.misSignalStrengths };
        delete nextMisSignalStrengths[key];
        return {
          ...current,
          misSignalStrengths: nextMisSignalStrengths,
        };
      }

      if (current.misSignalStrengths[key] === signalStrength) {
        return current;
      }

      return {
        ...current,
        misSignalStrengths: {
          ...current.misSignalStrengths,
          [key]: signalStrength,
        },
      };
    });
  }, []);

  const handleMisMultiplicityChange = useCallback((
    hallId: HallId,
    slice: number,
    side: 0 | 1,
    row: number,
    rawValue: string | number,
  ) => {
    const numericValue = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(numericValue)) {
      return;
    }
    const multiplicity = clamp(
      Math.round(numericValue),
      MIN_MIS_MULTIPLICITY,
      MAX_MIS_MULTIPLICITY,
    );
    const key = misNameKey(hallId, slice, side, row);

    setLabelNames((current) => {
      if (multiplicity === DEFAULT_MIS_MULTIPLICITY) {
        if (!(key in current.misMultiplicities)) {
          return current;
        }
        const nextMisMultiplicities = { ...current.misMultiplicities };
        delete nextMisMultiplicities[key];
        return {
          ...current,
          misMultiplicities: nextMisMultiplicities,
        };
      }

      if (current.misMultiplicities[key] === multiplicity) {
        return current;
      }

      return {
        ...current,
        misMultiplicities: {
          ...current.misMultiplicities,
          [key]: multiplicity,
        },
      };
    });
  }, []);

  return {
    labelNames,
    replaceLabelNames,
    handleLayoutNameChange,
    handleHallNameChange,
    handleSectionNameChange,
    handleMisNameChange,
    handleMisSignalStrengthChange,
    handleMisMultiplicityChange,
  };
}
