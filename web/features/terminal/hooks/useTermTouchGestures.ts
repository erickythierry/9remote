"use client";

import { useEffect, type MutableRefObject } from "react";
import { vibrate } from "@/shared/utils/vibration";
import { TOUCH_SCROLL, TOUCH_SELECT, HISTORY_FETCH } from "@/features/terminal/constants/terminalConfig";

export interface UseTermTouchGesturesOptions {
  termRef: MutableRefObject<any>;
  termReady: boolean;
  isVisible: boolean;
  bus: any;
  sessionId: string;
  onSelectionMadeRef: MutableRefObject<((sel: string | null, pos: { x: number; y: number }) => void) | null | undefined>;
  awaitingTuiOutputRef: MutableRefObject<boolean>;
  maybeFetchHistoryRef: MutableRefObject<(() => void) | null | undefined>;
  userAtTopRef: MutableRefObject<boolean>;
  stopMomentumRef: MutableRefObject<(() => void) | null | undefined>;
}

// Touch layer over the XTerm viewport: inertia scroll (scrollback or SGR wheel for TUI apps),
// soft-KB wrapper pan handoff, long-press text selection, and top-of-scrollback history fetch.
export function useTermTouchGestures({
  termRef, termReady, isVisible, bus, sessionId,
  onSelectionMadeRef, awaitingTuiOutputRef, maybeFetchHistoryRef, userAtTopRef,
  stopMomentumRef
}: UseTermTouchGesturesOptions): void {
  useEffect(() => {
    if (!termReady || !termRef.current) return;

    const xtermScreen = termRef.current.element?.querySelector(".xterm-screen");
    if (!xtermScreen) return;

    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let momentumId: number | null = null;
    let accumulated = 0;
    let lastScrollAt = 0;

    const SENSITIVITY = TOUCH_SCROLL.sensitivity;
    const LINE_HEIGHT = TOUCH_SCROLL.lineHeight;
    const FRICTION = TOUCH_SCROLL.friction;
    const MIN_VELOCITY = TOUCH_SCROLL.minVelocity;
    const MAX_VELOCITY = TOUCH_SCROLL.maxVelocity;
    const TUI_THROTTLE_MS = TOUCH_SCROLL.tuiThrottleMs;
    const MOMENTUM_CADENCE_MS = TOUCH_SCROLL.momentumRenderCadenceMs;
    const TUI_BACKPRESSURE_TIMEOUT_MS = TOUCH_SCROLL.tuiBackpressureTimeoutMs;
    const MAX_LINES_PER_FRAME = 3; // cap scrollLines per frame → smaller repaints, smoother inertia

    // Throttle SGR wheel burst so touch ≈ PC wheel cadence (TUI decides actual rate).
    let lastSgrAt = 0;
    let pendingLines = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const flushSgr = () => {
      pendingTimer = null;
      if (!pendingLines) return;
      const t = termRef.current;
      if (!t) { pendingLines = 0; return; }
      const x = Math.max(1, Math.ceil(t.cols / 2));
      const y = Math.max(1, Math.ceil(t.rows / 2));
      const seq = pendingLines > 0 ? TOUCH_SCROLL.sgrDown(x, y) : TOUCH_SCROLL.sgrUp(x, y);
      const n = Math.min(Math.abs(pendingLines), TOUCH_SCROLL.wheelStepLines);
      for (let i = 0; i < n; i++) bus.emit("input", { sessionId, data: seq });
      pendingLines = 0;
      lastSgrAt = performance.now();
      awaitingTuiOutputRef.current = true; // expect output round-trip; cleared in handleOutput
    };

    // Alt-buffer (TUI mouse-tracking) has no scrollback → send SGR wheel to the app; else
    // scroll the local scrollback.
    const applyScroll = (lines: number) => {
      const t = termRef.current;
      if (!t) return;
      if (t.buffer.active.type === "alternate") {
        // Backpressure: TUI still redrawing last SGR → drop new lines, don't pile up.
        // Safety timeout clears anyway so TUIs that emit no output on wheel never stall scroll.
        if (awaitingTuiOutputRef.current && performance.now() - lastSgrAt < TUI_BACKPRESSURE_TIMEOUT_MS) return;
        pendingLines += lines;
        const elapsed = performance.now() - lastSgrAt;
        if (elapsed >= TUI_THROTTLE_MS) {
          flushSgr();
        } else if (!pendingTimer) {
          pendingTimer = setTimeout(flushSgr, TUI_THROTTLE_MS - elapsed);
        }
      } else {
        t.scrollLines(Math.max(-MAX_LINES_PER_FRAME, Math.min(MAX_LINES_PER_FRAME, lines)));
        // Touch scroll up near top must trigger the history fetch (the wheel path sets
        // userAtTopRef; this path never did, so mobile couldn't load older history).
        if (lines < 0) {
          const buf = t.buffer.active;
          if (buf.viewportY <= HISTORY_FETCH.topThresholdLines) {
            userAtTopRef.current = true;
            maybeFetchHistoryRef.current?.();
          }
        }
      }
    };

    const stopMomentum = () => {
      if (momentumId) {
        cancelAnimationFrame(momentumId);
        momentumId = null;
      }
      velocity = 0;
    };

    const doMomentum = () => {
      if (!termRef.current || Math.abs(velocity) < MIN_VELOCITY) {
        momentumId = null;
        return;
      }

      const isAlt = termRef.current.buffer?.active?.type === "alternate";
      const now = performance.now();

      const tuiBusy = isAlt && awaitingTuiOutputRef.current && now - lastSgrAt < TUI_BACKPRESSURE_TIMEOUT_MS;
      const cadenceDue = !isAlt && now - lastScrollAt >= MOMENTUM_CADENCE_MS;

      // Decay at the apply timestep, not per-rAF — otherwise scrollback (apply every 33ms)
      // loses 2x velocity between applies and the glide dies early. TUI always applies → unchanged.
      if (!tuiBusy && (isAlt || cadenceDue)) {
        velocity *= FRICTION;
        accumulated += velocity;
        const lines = Math.trunc(accumulated / LINE_HEIGHT);
        if (lines !== 0) {
          applyScroll(lines);
          accumulated -= lines * LINE_HEIGHT;
          lastScrollAt = performance.now();
        }
      }

      momentumId = requestAnimationFrame(doMomentum);
    };

    // --- Long-press text selection (mobile) ---
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let selecting = false;
    type Cell = { col: number; row: number }; // absolute buffer coords
    let selAnchor: Cell | null = null; // fixed end while dragging
    let selRange: { start: Cell; end: Cell } | null = null; // inclusive, kept after release for handle drags
    let startX = 0, startY = 0, curX = 0, curY = 0, moved = false;

    // Cached during select drag so touchToCell skips getBoundingClientRect() per frame
    let selRect: DOMRect | null = null;

    // Map viewport pixel → absolute buffer cell (accounts for scrollback offset)
    const touchToCell = (clientX: number, clientY: number) => {
      const t = termRef.current;
      const rect = selRect || xtermScreen.getBoundingClientRect();
      const cellW = rect.width / t.cols;
      const cellH = rect.height / t.rows;
      const col = Math.max(0, Math.min(t.cols - 1, Math.floor((clientX - rect.left) / cellW)));
      const vRow = Math.max(0, Math.min(t.rows - 1, Math.floor((clientY - rect.top) / cellH)));
      return { col, row: t.buffer.active.viewportY + vRow };
    };

    const before = (a: Cell, b: Cell) => a.row < b.row || (a.row === b.row && a.col <= b.col);

    // Stream selection: xterm wraps a length past the row end onto the next rows
    const applyRange = (a: Cell, b: Cell) => {
      const t = termRef.current;
      const [start, end] = before(a, b) ? [a, b] : [b, a];
      selRange = { start, end };
      t.select(start.col, start.row, (end.row - start.row) * t.cols + end.col - start.col + 1);
    };

    const wordAt = ({ col, row }: Cell): { start: Cell; end: Cell } => {
      const line = termRef.current.buffer.active.getLine(row);
      const text = line ? line.translateToString(false) : "";
      const isWord = (c: string) => c && TOUCH_SELECT.wordChars.test(c);
      if (!isWord(text[col])) return { start: { col, row }, end: { col, row } };
      let start = col, end = col;
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length - 1 && isWord(text[end + 1])) end++;
      return { start: { col: start, row }, end: { col: end, row } };
    };

    let word: { start: Cell; end: Cell } | null = null; // long-pressed word, kept whole while extending
    const extendSelection = (cell: Cell) => {
      if (word) {
        if (before(cell, word.start)) applyRange(cell, word.end);
        else applyRange(word.start, before(cell, word.end) ? word.end : cell);
        return;
      }
      if (selAnchor) applyRange(selAnchor, cell);
    };

    // Center of a cell in viewport px, to hit-test a touch against the selection ends
    const cellCenter = ({ col, row }: Cell) => {
      const t = termRef.current;
      const rect = xtermScreen.getBoundingClientRect();
      return {
        x: rect.left + (col + 0.5) * (rect.width / t.cols),
        y: rect.top + (row - t.buffer.active.viewportY + 0.5) * (rect.height / t.rows)
      };
    };
    const nearCell = (cell: Cell, x: number, y: number) => {
      const c = cellCenter(cell);
      return Math.hypot(c.x - x, c.y - y) <= TOUCH_SELECT.handleRadiusPx;
    };

    const clearSel = () => {
      selRange = null;
      word = null;
      if (termRef.current?.hasSelection()) {
        termRef.current.clearSelection();
        onSelectionMadeRef.current?.(null, { x: 0, y: 0 });
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      stopMomentum();
      const touch = e.touches[0];
      lastY = touch.clientY;
      startX = curX = touch.clientX;
      startY = curY = touch.clientY;
      lastTime = Date.now();
      velocity = 0;
      accumulated = 0;
      selecting = false;
      moved = false;
      // Touch on a selection end: drag that end, the other one stays put
      if (selRange && termRef.current?.hasSelection()) {
        const grabStart = nearCell(selRange.start, startX, startY);
        const grabEnd = !grabStart && nearCell(selRange.end, startX, startY);
        if (grabStart || grabEnd) {
          selAnchor = grabStart ? selRange.end : selRange.start;
          word = null;
          selecting = true;
          selRect = xtermScreen.getBoundingClientRect();
          onSelectionMadeRef.current?.(null, { x: 0, y: 0 });
          return;
        }
      }
      clearSel();
      longPressTimer = setTimeout(() => {
        if (moved || !termRef.current) return;
        selecting = true;
        vibrate();
        selRect = xtermScreen.getBoundingClientRect();
        word = wordAt(touchToCell(startX, startY));
        applyRange(word.start, word.end);
      }, TOUCH_SELECT.longPressMs);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!termRef.current) return;
      const touch = e.touches[0];
      curX = touch.clientX;
      curY = touch.clientY;

      if (!moved && Math.hypot(curX - startX, curY - startY) > TOUCH_SELECT.moveTolerance) {
        moved = true;
        if (!selecting && longPressTimer) clearTimeout(longPressTimer); // it's a scroll, not a long-press
      }

      if (selecting) {
        e.preventDefault();
        extendSelection(touchToCell(curX, curY));
        return;
      }

      const currentY = touch.clientY;
      const currentTime = Date.now();
      const dy = lastY - currentY; // >0 finger up / reveal bottom; <0 finger down / reveal top
      const deltaTime = currentTime - lastTime || 1;

      // Soft-KB: pan the outer wrapper first; at an edge hand off to xterm scrollback
      const wrap = xtermScreen.closest(".terminal-scroll.is-scrollable");
      if (wrap && wrap.scrollHeight > wrap.clientHeight + 1) {
        const maxScroll = wrap.scrollHeight - wrap.clientHeight;
        const atTop = wrap.scrollTop <= 0.5;
        const atBottom = wrap.scrollTop >= maxScroll - 0.5;
        const handoffToTerm = (dy < 0 && atTop) || (dy > 0 && atBottom);
        if (!handoffToTerm) {
          if (dy !== 0) {
            e.preventDefault();
            wrap.scrollTop = Math.max(0, Math.min(maxScroll, wrap.scrollTop + dy));
          }
          lastY = currentY;
          lastTime = currentTime;
          velocity = 0;
          accumulated = 0;
          return;
        }
      }

      const deltaY = dy * SENSITIVITY;
      accumulated += deltaY;
      const lines = Math.trunc(accumulated / LINE_HEIGHT);
      if (lines !== 0) {
        e.preventDefault();
        applyScroll(lines);
        accumulated -= lines * LINE_HEIGHT;
      }

      velocity = Math.min((deltaY / deltaTime) * 16, MAX_VELOCITY);
      lastY = currentY;
      lastTime = currentTime;
    };

    const handleTouchEnd = () => {
      if (longPressTimer) clearTimeout(longPressTimer);
      selRect = null;
      if (selecting) {
        selecting = false;
        const sel = termRef.current?.getSelection();
        if (sel && sel.trim()) onSelectionMadeRef.current?.(sel, { x: curX, y: curY });
        return;
      }
      if (Math.abs(velocity) > MIN_VELOCITY) {
        momentumId = requestAnimationFrame(doMomentum);
      }
    };
    stopMomentumRef.current = stopMomentum;

    xtermScreen.addEventListener("touchstart", handleTouchStart, { passive: true });
    xtermScreen.addEventListener("touchmove", handleTouchMove, { passive: false });
    xtermScreen.addEventListener("touchend", handleTouchEnd, { passive: true });

    // Desktop wheel — when scrolled to top, fetch an older history chunk
    const handleWheel = (e: WheelEvent) => {
      const t = termRef.current;
      if (!t) return;
      if (e.deltaY < 0 && t.buffer.active.viewportY <= HISTORY_FETCH.topThresholdLines) {
        userAtTopRef.current = true;
        maybeFetchHistoryRef.current?.();
      }
    };
    xtermScreen.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      stopMomentum();
      stopMomentumRef.current = null;
      if (longPressTimer) clearTimeout(longPressTimer);
      xtermScreen.removeEventListener("touchstart", handleTouchStart);
      xtermScreen.removeEventListener("touchmove", handleTouchMove);
      xtermScreen.removeEventListener("touchend", handleTouchEnd);
      xtermScreen.removeEventListener("wheel", handleWheel);
    };
  }, [termReady, isVisible, termRef, bus, sessionId, onSelectionMadeRef, awaitingTuiOutputRef, maybeFetchHistoryRef, userAtTopRef, stopMomentumRef]);
}
