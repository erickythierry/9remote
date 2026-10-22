// Maintains scroll position via anchor node when older messages are prepended.
// Threshold in pixels to treat viewport as pinned to bottom.
const AT_BOTTOM_PX = 8;

interface ScrollMeasurements {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  nodeTop?: number;
}

interface ScrollAnchor {
  nodeTop: number;
  scrollTop: number;
  atBottom: boolean;
}

// Snapshot scroll and anchor node position before prepending content.
export function anchorFrom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, nodeTop = 0 }: ScrollMeasurements = {}): ScrollAnchor {
  return {
    nodeTop,
    scrollTop,
    atBottom: scrollHeight - scrollTop - clientHeight < AT_BOTTOM_PX
  };
}

// Compute new scrollTop to keep anchor node at same viewport offset after prepending.
export function anchoredScrollTop(anchor: ScrollAnchor | null | undefined, { scrollHeight = 0, nodeTop = 0 }: ScrollMeasurements = {}): number | null {
  if (!anchor) return null;
  if (anchor.atBottom) return scrollHeight;
  if (nodeTop <= anchor.nodeTop) return null;
  return Math.max(0, nodeTop - (anchor.nodeTop - anchor.scrollTop));
}
