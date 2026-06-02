import {
  useCallback,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { MAX_ZOOM, MIN_ZOOM, STAGE_SIZE } from "../constants";
import { clamp } from "../utils";

type PanSession = {
  pointerId: number;
  lastX: number;
  lastY: number;
};

type ViewportState = {
  zoom: number;
  pan: { x: number; y: number };
};

const PAN_ZOOM_COMMIT_INTERVAL_MS = 48;

export function useViewportNavigation(): {
  viewportRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  pan: { x: number; y: number };
  subscribeViewportTransform: (
    listener: (state: ViewportState) => void,
  ) => () => void;
  adjustZoom: (delta: number) => void;
  panBy: (deltaX: number, deltaY: number, commitMode?: "immediate" | "throttled") => void;
  fitViewportToBounds: (
    bounds: { left: number; top: number; right: number; bottom: number },
    padding?: number,
  ) => void;
  recenterViewport: (focusPoint?: { x: number; y: number }) => void;
  handlePointerDown: (event: PointerEvent<HTMLDivElement>) => boolean;
  handlePointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  handlePointerEnd: (event: PointerEvent<HTMLDivElement>) => void;
} {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const didInitializePan = useRef(false);
  const panSessionRef = useRef<PanSession | null>(null);
  const previousBodyUserSelect = useRef("");
  const liveStateRef = useRef<ViewportState>({
    zoom: 1,
    pan: { x: 0, y: 0 },
  });
  const transformListenersRef = useRef(new Set<(state: ViewportState) => void>());
  const commitRafRef = useRef<number | null>(null);
  const lastCommitTimestampRef = useRef(0);

  const [state, setState] = useState<ViewportState>({
    zoom: 1,
    pan: { x: 0, y: 0 },
  });

  const notifyTransformListeners = useCallback((nextState: ViewportState): void => {
    for (const listener of transformListenersRef.current) {
      listener(nextState);
    }
  }, []);

  const commitLiveStateToReact = useCallback((): void => {
    const nextState = liveStateRef.current;
    setState((current) => {
      if (
        current.zoom === nextState.zoom &&
        current.pan.x === nextState.pan.x &&
        current.pan.y === nextState.pan.y
      ) {
        return current;
      }
      return nextState;
    });
  }, []);

  const scheduleReactCommit = useCallback((): void => {
    if (commitRafRef.current !== null) {
      return;
    }

    const tick = (timestamp: number): void => {
      commitRafRef.current = null;
      if (timestamp - lastCommitTimestampRef.current < PAN_ZOOM_COMMIT_INTERVAL_MS) {
        commitRafRef.current = window.requestAnimationFrame(tick);
        return;
      }
      lastCommitTimestampRef.current = timestamp;
      commitLiveStateToReact();
    };

    commitRafRef.current = window.requestAnimationFrame(tick);
  }, [commitLiveStateToReact]);

  const updateViewportState = useCallback(
    (
      updater: (current: ViewportState) => ViewportState,
      commitMode: "immediate" | "throttled" = "throttled",
    ): void => {
      const current = liveStateRef.current;
      const next = updater(current);
      if (
        next.zoom === current.zoom &&
        next.pan.x === current.pan.x &&
        next.pan.y === current.pan.y
      ) {
        return;
      }
      liveStateRef.current = next;
      notifyTransformListeners(next);
      if (commitMode === "immediate") {
        if (commitRafRef.current !== null) {
          window.cancelAnimationFrame(commitRafRef.current);
          commitRafRef.current = null;
        }
        lastCommitTimestampRef.current =
          typeof performance !== "undefined" ? performance.now() : 0;
        commitLiveStateToReact();
        return;
      }
      scheduleReactCommit();
    },
    [commitLiveStateToReact, notifyTransformListeners, scheduleReactCommit],
  );

  useEffect(() => {
    if (didInitializePan.current || !viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    updateViewportState(
      (current) => ({
        ...current,
        pan: {
          x: rect.width / 2 - (STAGE_SIZE / 2) * current.zoom,
          y: rect.height / 2 - (STAGE_SIZE / 2) * current.zoom,
        },
      }),
      "immediate",
    );
    didInitializePan.current = true;
  }, [updateViewportState]);

  useEffect(() => {
    return () => {
      if (commitRafRef.current !== null) {
        window.cancelAnimationFrame(commitRafRef.current);
        commitRafRef.current = null;
      }
      if (panSessionRef.current) {
        document.body.style.userSelect = previousBodyUserSelect.current;
        panSessionRef.current = null;
      }
    };
  }, []);

  const subscribeViewportTransform = useCallback((
    listener: (nextState: ViewportState) => void,
  ): (() => void) => {
    transformListenersRef.current.add(listener);
    listener(liveStateRef.current);
    return () => {
      transformListenersRef.current.delete(listener);
    };
  }, []);

  const applyZoomAt = useCallback(
    (
      viewportX: number,
      viewportY: number,
      getNextZoom: (currentZoom: number) => number,
      commitMode: "immediate" | "throttled" = "throttled",
    ): void => {
      updateViewportState((current) => {
        const nextZoom = clamp(getNextZoom(current.zoom), MIN_ZOOM, MAX_ZOOM);
        if (nextZoom === current.zoom) {
          return current;
        }

        const zoomFactor = nextZoom / current.zoom;

        return {
          zoom: nextZoom,
          pan: {
            x: viewportX - (viewportX - current.pan.x) * zoomFactor,
            y: viewportY - (viewportY - current.pan.y) * zoomFactor,
          },
        };
      }, commitMode);
    },
    [updateViewportState],
  );

  const adjustZoom = useCallback((delta: number): void => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    applyZoomAt(rect.width / 2, rect.height / 2, (currentZoom) => currentZoom + delta, "immediate");
  }, [applyZoomAt]);

  const panBy = useCallback((
    deltaX: number,
    deltaY: number,
    commitMode: "immediate" | "throttled" = "immediate",
  ): void => {
    updateViewportState(
      (current) => ({
        ...current,
        pan: {
          x: current.pan.x + deltaX,
          y: current.pan.y + deltaY,
        },
      }),
      commitMode,
    );
  }, [updateViewportState]);

  const fitViewportToBounds = useCallback((
    bounds: { left: number; top: number; right: number; bottom: number },
    padding = 24,
  ): void => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const boundsWidth = Math.max(1, bounds.right - bounds.left);
    const boundsHeight = Math.max(1, bounds.bottom - bounds.top);
    const availableWidth = Math.max(1, rect.width - padding * 2);
    const availableHeight = Math.max(1, rect.height - padding * 2);
    const targetZoom = clamp(
      Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;

    updateViewportState(
      () => ({
        zoom: targetZoom,
        pan: {
          x: rect.width / 2 - centerX * targetZoom,
          y: rect.height / 2 - centerY * targetZoom,
        },
      }),
      "immediate",
    );
  }, [updateViewportState]);

  const recenterViewport = useCallback((focusPoint?: { x: number; y: number }): void => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const focusX = focusPoint?.x ?? STAGE_SIZE / 2;
    const focusY = focusPoint?.y ?? STAGE_SIZE / 2;
    updateViewportState(
      (current) => ({
        ...current,
        pan: {
          x: rect.width / 2 - focusX * current.zoom,
          y: rect.height / 2 - focusY * current.zoom,
        },
      }),
      "immediate",
    );
  }, [updateViewportState]);

  const handleWheelFromViewport = useCallback((
    clientX: number,
    clientY: number,
    deltaY: number,
  ): void => {
    if (!viewportRef.current) {
      return;
    }

    const rect = viewportRef.current.getBoundingClientRect();
    const rawX = clientX - rect.left;
    const rawY = clientY - rect.top;
    const fallbackX = rect.width / 2;
    const fallbackY = rect.height / 2;
    const viewportX =
      Number.isFinite(rawX) && rawX >= 0 && rawX <= rect.width ? rawX : fallbackX;
    const viewportY =
      Number.isFinite(rawY) && rawY >= 0 && rawY <= rect.height ? rawY : fallbackY;

    const zoomScale = Math.exp(-deltaY * 0.0022);
    applyZoomAt(viewportX, viewportY, (currentZoom) => currentZoom * zoomScale);
  }, [applyZoomAt]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const handleNativeWheel = (event: globalThis.WheelEvent): void => {
      const scrollShell = element.closest<HTMLElement>("[data-planner-scroll-shell]");
      const shellCanScrollVertically = Boolean(
        scrollShell && scrollShell.scrollHeight > scrollShell.clientHeight + 1,
      );
      const isZoomIntent = event.ctrlKey || event.metaKey;
      if (shellCanScrollVertically && !isZoomIntent) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleWheelFromViewport(event.clientX, event.clientY, event.deltaY);
    };

    element.addEventListener("wheel", handleNativeWheel, { passive: false });

    return () => {
      element.removeEventListener("wheel", handleNativeWheel);
    };
  }, [handleWheelFromViewport]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): boolean {
    if (event.button !== 0) {
      return false;
    }

    const target = event.target as HTMLElement;
    if (target.closest("[data-slot]") || target.closest("[data-no-pan]")) {
      return false;
    }

    if (event.shiftKey) {
      return false;
    }

    panSessionRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };

    previousBodyUserSelect.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    return true;
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - session.lastX;
    const dy = event.clientY - session.lastY;

    session.lastX = event.clientX;
    session.lastY = event.clientY;

    updateViewportState((current) => ({
      ...current,
      pan: {
        x: current.pan.x + dx,
        y: current.pan.y + dy,
      },
    }));
    event.preventDefault();
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>): void {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    document.body.style.userSelect = previousBodyUserSelect.current;
    panSessionRef.current = null;
    commitLiveStateToReact();
  }

  return {
    viewportRef,
    zoom: state.zoom,
    pan: state.pan,
    subscribeViewportTransform,
    adjustZoom,
    panBy,
    fitViewportToBounds,
    recenterViewport,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
  };
}
