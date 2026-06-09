import { useCallback, useState } from "react";
import type { HallId, PlannerLabelNames } from "../types";
import {
  clonePlannerLabelNames,
  createEmptyPlannerLabelNames,
  misNameKey,
  sectionNameKey,
} from "../lib/plannerSnapshot";

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

  return {
    labelNames,
    replaceLabelNames,
    handleLayoutNameChange,
    handleHallNameChange,
    handleSectionNameChange,
    handleMisNameChange,
  };
}
