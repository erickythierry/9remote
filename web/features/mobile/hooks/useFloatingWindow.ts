"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_FLOAT } from "@/features/terminal/constants/terminalConfig";

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
  width?: number;
  height?: number;
  [key: string]: any;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Default box: bottom-right, respecting the viewport it has to fit in. */
function defaultRect(): FloatRect {
  const w = MOBILE_FLOAT.width.default;
  const h = Math.min(MOBILE_FLOAT.height.default, window.innerHeight - MOBILE_FLOAT.defaultOffset * 2);
  return {
    x: Math.max(MOBILE_FLOAT.margin, window.innerWidth - w - MOBILE_FLOAT.defaultOffset),
    y: Math.max(MOBILE_FLOAT.margin, window.innerHeight - h - MOBILE_FLOAT.defaultOffset),
    w,
    h
  };
}

function keepOnScreen(rect: FloatRect): FloatRect {
  const maxX = window.innerWidth - MOBILE_FLOAT.margin * 4;
  const maxY = window.innerHeight - MOBILE_FLOAT.margin * 3;
  return {
    ...rect,
    x: clamp(rect.x, MOBILE_FLOAT.margin - rect.w + MOBILE_FLOAT.margin * 4, maxX),
    y: clamp(rect.y, MOBILE_FLOAT.margin, maxY)
  };
}

export interface UseFloatingWindowParams {
  rect?: any;
  onChange?: (rect: any) => void;
  enabled?: boolean;
}

interface DragState {
  mode: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatRect;
}

export function useFloatingWindow({ rect, onChange, enabled }: UseFloatingWindowParams) {
  const [live, setLive] = useState<FloatRect | null>(() =>
    typeof window === "undefined" ? null : (rect ? keepOnScreen(rect) : defaultRect())
  );
  const [dragging, setDragging] = useState<boolean>(false);
  const dragRef = useRef<DragState | null>(null);
  const liveRef = useRef<FloatRect | null>(live);

  const applyRect = useCallback((newRect: FloatRect) => {
    liveRef.current = newRect;
    setLive(newRect);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onResize = () => {
      const prev = liveRef.current;
      if (!prev) return;
      const h = Math.min(prev.h, window.innerHeight - MOBILE_FLOAT.margin * 2);
      applyRect(keepOnScreen({ ...prev, h }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, applyRect]);

  const end = useCallback((event: React.PointerEvent | PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (liveRef.current) onChange?.(liveRef.current);
  }, [onChange]);

  const begin = useCallback((event: React.PointerEvent, mode: string) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    if (!live) return;
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: live
    };
    setDragging(true);
  }, [live]);

  const move = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      end(event);
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (drag.mode === "move") {
      applyRect(keepOnScreen({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }));
      return;
    }

    const { origin, mode } = drag;
    const west = mode.includes("w");
    const north = mode.includes("n");
    const horizontal = west || mode.includes("e");
    const vertical = north || mode.includes("s");
    const maxH = window.innerHeight - MOBILE_FLOAT.margin * 2;

    const maxNorthH = north ? origin.y + origin.h - MOBILE_FLOAT.margin : maxH;
    const maxWestW = west ? origin.x + origin.w - MOBILE_FLOAT.margin : MOBILE_FLOAT.width.max;

    const w = horizontal
      ? clamp(west ? origin.w - dx : origin.w + dx, MOBILE_FLOAT.width.min, Math.min(MOBILE_FLOAT.width.max, maxWestW))
      : origin.w;
    const h = vertical
      ? clamp(north ? origin.h - dy : origin.h + dy, MOBILE_FLOAT.height.min, Math.min(maxH, maxNorthH))
      : origin.h;

    applyRect({
      x: west ? origin.x + (origin.w - w) : origin.x,
      y: north ? origin.y + (origin.h - h) : origin.y,
      w,
      h
    });
  }, [applyRect, end]);

  useEffect(() => {
    if (!dragging) return;
    const onBlur = () => {
      dragRef.current = null;
      setDragging(false);
      if (liveRef.current) onChange?.(liveRef.current);
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [dragging, onChange]);

  return {
    rect: live,
    dragging,
    onDragHandlePointerDown: (e: React.PointerEvent) => begin(e, "move"),
    onResizeHandlePointerDown: (edge: string) => (e: React.PointerEvent) => begin(e, edge),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end
  };
}
