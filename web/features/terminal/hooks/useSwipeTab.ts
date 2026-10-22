import { useRef, useCallback, type TouchEvent as ReactTouchEvent } from "react";
import { SWIPE_TAB } from "@/features/terminal/constants/terminalConfig";

const overflowXOf = (el: Element) =>
  typeof getComputedStyle === "function" ? getComputedStyle(el).overflowX : "";

/**
 * Does this touch start inside a box that pans horizontally on its own?
 */
export function startsInScrollerX(target: Element, getOverflowX = overflowXOf): boolean {
  for (let el: Element | null = target; el && el.nodeType === 1; el = el.parentElement) {
    const overflowX = getOverflowX(el);
    if (overflowX !== "auto" && overflowX !== "scroll") continue;
    if (el.scrollWidth > el.clientWidth) return true;
  }
  return false;
}

export interface SwipeTabBindOptions {
  enabled: boolean;
  sessionIds: string[];
  activeSessionId?: string | null;
  onSwitch?: (id: string) => void;
}

export interface SwipeTabBindings {
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
}

// Horizontal swipe to switch tabs (mobile). Left = next, right = prev — no wrap.
// Passive handlers: never preventDefault so vertical scroll/selection stay intact.
// bind() is called at render with live data, keeping the hook itself top-level.
export function useSwipeTab(): (opts: SwipeTabBindOptions) => SwipeTabBindings {
  const startRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const bind = useCallback(({ enabled, sessionIds, activeSessionId, onSwitch }: SwipeTabBindOptions): SwipeTabBindings => ({
    onTouchStart: (e: ReactTouchEvent) => {
      if (!enabled || e.touches.length !== 1) {
        startRef.current = null;
        return;
      }
      // The gesture belongs to the code block's own pan, not to the tab strip.
      if (startsInScrollerX(e.target as Element)) {
        startRef.current = null;
        return;
      }
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY, time: performance.now() };
    },
    onTouchEnd: (e: ReactTouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start || !enabled || sessionIds.length < 2) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const elapsed = performance.now() - start.time;
      // Horizontal intent only: fast, mostly-horizontal, long-enough swipe
      if (
        elapsed > SWIPE_TAB.maxDuration ||
        Math.abs(dx) < SWIPE_TAB.minDistance ||
        Math.abs(dx) < Math.abs(dy) * SWIPE_TAB.ratio
      ) return;
      const idx = activeSessionId ? sessionIds.indexOf(activeSessionId) : -1;
      if (idx === -1) return;
      const next = dx < 0 ? sessionIds[idx + 1] : sessionIds[idx - 1];
      if (next && next !== activeSessionId) onSwitch?.(next);
    }
  }), []);

  return bind;
}
