"use client";

import { useRef, useState, useEffect, useMemo, type MutableRefObject } from "react";
import type { BrowserFrameInfo } from "@/features/browser/hooks/useBrowserFrame";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { BROWSER_INPUT } from "@/features/browser/constants/BROWSER_INPUT";

export interface BrowserBusContext {
  busRef?: { current?: any } | null;
  targetId?: string | null;
  profile?: string;
  frameRef?: MutableRefObject<BrowserFrameInfo | null>;
  getCanvas?: () => HTMLCanvasElement | null | undefined;
  onSecondaryClick?: (pageX: number, pageY: number) => void;
  onClipboard?: (text: string) => void;
}

export interface BrowserInputEvent {
  t: "pointer" | "key" | "text" | "wheel";
  type?: string;
  x?: number;
  y?: number;
  drag?: boolean;
  button?: string;
  clickCount?: number;
  key?: string;
  modifiers?: string[];
  text?: string;
  deltaX?: number;
  deltaY?: number;
}

export interface BrowserEmitterState {
  queue: BrowserInputEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  held: string | null;
  pos: { x: number; y: number };
  clickCount: number;
  lastPress: { at: number; x: number; y: number; count: number };
}

// Pure emitter factory: all mutable state lives in `st`, config is read through `ctx()`.
export function createEmitters(ctx: () => BrowserBusContext, st: BrowserEmitterState) {
  const flush = () => {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    const { busRef, targetId, profile, onClipboard } = ctx();
    if (!st.queue.length || !targetId) { st.queue.length = 0; return; }
    const events = st.queue.splice(0);
    busRef?.current?.emit?.("browser:input", { targetId, events, profile }, (res: { clipboard?: string } | undefined) => {
      if (res?.clipboard) onClipboard?.(res.clipboard);
    });
  };
  // Moves and wheel deltas merge into the trailing event; everything else flushes now.
  const push = (evt: BrowserInputEvent, { lazy = false } = {}) => {
    const last = st.queue[st.queue.length - 1];
    if (lazy && last && last.t === evt.t && last.type === evt.type && !!last.drag === !!evt.drag) {
      if (evt.t === "wheel") {
        evt.deltaX = (evt.deltaX || 0) + (last.deltaX || 0);
        evt.deltaY = (evt.deltaY || 0) + (last.deltaY || 0);
      }
      st.queue[st.queue.length - 1] = evt;
    } else {
      st.queue.push(evt);
    }
    if (!lazy) return flush();
    if (!st.timer) st.timer = setTimeout(flush, BROWSER_INPUT.flushMs);
  };

  // percent of the canvas → page CSS px (the canvas shares the page's aspect ratio)
  const toPage = (percentX: number, percentY: number) => {
    const { frameRef, getCanvas } = ctx();
    const meta = frameRef?.current?.meta;
    const canvas = getCanvas?.();
    const w = meta?.deviceWidth || canvas?.width || 0;
    const h = meta?.deviceHeight || canvas?.height || 0;
    return { x: Math.round((percentX / 100) * w), y: Math.round((percentY / 100) * h) };
  };

  const emitMouseMove = (percentX: number, percentY: number) => {
    st.pos = toPage(percentX, percentY);
    push({ t: "pointer", type: "move", ...st.pos, ...(st.held ? { drag: true, button: st.held } : {}) }, { lazy: true });
  };
  const emitMousePress = (percentX: number, percentY: number, button = "left") => {
    if (button === BROWSER_INPUT.secondaryButton) return; // context menu owns right-click
    const p = (st.pos = toPage(percentX, percentY));
    const now = Date.now();
    const lp = st.lastPress;
    const near = Math.abs(p.x - lp.x) < REMOTE_CONFIG.moveThreshold && Math.abs(p.y - lp.y) < REMOTE_CONFIG.moveThreshold;
    st.clickCount = near && now - lp.at < REMOTE_CONFIG.doubleClickDelay
      ? Math.min(lp.count + 1, BROWSER_INPUT.maxClickCount)
      : 1;
    st.lastPress = { at: now, x: p.x, y: p.y, count: st.clickCount };
    st.held = button;
    push({ t: "pointer", type: "press", ...p, button, clickCount: st.clickCount });
  };
  const emitMouseRelease = (percentX: number, percentY: number, button = "left") => {
    if (button === BROWSER_INPUT.secondaryButton) return;
    const p = (st.pos = toPage(percentX, percentY));
    st.held = null;
    push({ t: "pointer", type: "release", ...p, button, clickCount: st.clickCount });
  };
  const emitMouseClick = (percentX: number, percentY: number, button = "left") => {
    if (button === BROWSER_INPUT.secondaryButton) {
      const p = toPage(percentX, percentY);
      ctx().onSecondaryClick?.(p.x, p.y);
      return;
    }
    emitMousePress(percentX, percentY, button);
    emitMouseRelease(percentX, percentY, button);
  };

  return {
    emitMouseMove,
    emitMousePress,
    emitMouseRelease,
    emitMouseClick,
    emitMouseDragSelect: (sx: number, sy: number, ex: number, ey: number) => {
      emitMousePress(sx, sy);
      emitMouseMove(ex, ey);
      emitMouseRelease(ex, ey);
    },
    emitKeyPress: (key: string, modifiers: string[] = []) => push({ t: "key", key, modifiers }),
    emitTypeText: (text: string) => push({ t: "text", text }),
    emitScroll: (direction: string, amount = 20, horizontal = false) => {
      const px = amount * BROWSER_INPUT.wheelScale;
      const sign = direction === "down" || direction === "right" ? 1 : -1;
      const along = horizontal || direction === "left" || direction === "right";
      push({ t: "wheel", ...st.pos, deltaX: along ? sign * px : 0, deltaY: along ? 0 : sign * px }, { lazy: true });
    },
    // Chrome screencasts damage only; no adaptive boost / focus rect on this stream.
    emitBoostStream: () => {},
    emitRequestScreenWithHashes: (tileHashes: unknown) => {
      const { busRef, targetId } = ctx();
      if (targetId) busRef?.current?.emit?.("browser:request-tiles-hashes", { targetId, tileHashes });
    }
  };
}

// useRemoteBus-shaped adapter over `browser:input`: Remote Desktop's canvas/input hooks
// speak "percent of screen" + robotjs key names; this turns that into page-pixel CDP
// events, so the whole remote input stack is reused unchanged.
// getCanvas(): the shared canvas element. onSecondaryClick(pageX, pageY): right-click
// becomes the pane's context menu. onClipboard(text): what a copy/cut chord selected.
export type BrowserEmitters = ReturnType<typeof createEmitters>;

export function useBrowserBus({ busRef, connected, targetId, profile, frameRef, getCanvas, onSecondaryClick, onClipboard }: BrowserBusContext & { connected: boolean }) {
  const streaming = !!connected && !!targetId;
  const ctxRef = useRef<BrowserBusContext>({});
  useEffect(() => {
    ctxRef.current = { busRef, targetId, profile, frameRef, getCanvas, onSecondaryClick, onClipboard };
  });

  // Lazy init: emitters are built once; every read goes through ctxRef at call time.
  const [emits] = useState(() => createEmitters(() => ctxRef.current, {
    queue: [], timer: null, held: null, pos: { x: 0, y: 0 }, clickCount: 1,
    lastPress: { at: 0, x: 0, y: 0, count: 0 }
  }));

  // Gate every emitter on streaming like useRemoteBus does.
  return useMemo(() => {
    const gated: Record<string, unknown> = { streaming };
    for (const [name, fn] of Object.entries(emits)) gated[name] = (...a: unknown[]) => { if (streaming) (fn as (...args: unknown[]) => void)(...a); };
    return gated as BrowserEmitters & { streaming: boolean };
  }, [emits, streaming]);
}
