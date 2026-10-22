"use client";

// Paints binary browser frames onto a canvas by reusing Remote Desktop's useTiles hook:
// - Tile batches: decoded via tileDecoder.worker off main thread,
//   batched in rAF, drawn to canvas via ctx.drawImage, auto-acked.
// - Periodic repair: sends clientTileHashes via browser:request-tiles-hashes.
import { useEffect, useRef, useState, RefObject } from "react";
import { useTiles } from "@/features/remote/hooks/useTiles";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

export interface BrowserFrameInfo {
  w: number;
  h: number;
  meta?: {
    deviceWidth?: number;
    deviceHeight?: number;
    [key: string]: any;
  };
}

export interface UseBrowserFrameOptions {
  busRef: { current?: any } | null | undefined;
  connected: boolean;
  targetId: string | null;
  onPainted?: (info: Record<string, any>, bytes: number) => void;
}

export interface UseBrowserFrameReturn {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  frame: BrowserFrameInfo | null;
  frameRef: React.MutableRefObject<BrowserFrameInfo | null>;
}

export function useBrowserFrame({ busRef, connected, targetId, onPainted }: UseBrowserFrameOptions): UseBrowserFrameReturn {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState<BrowserFrameInfo | null>(null);
  const frameRef = useRef<BrowserFrameInfo | null>(null);
  const onPaintedRef = useRef(onPainted);
  useEffect(() => { onPaintedRef.current = onPainted; }, [onPainted]);

  // Clone 100% of Remote Desktop's useTiles hook
  const tiles = useTiles(busRef as any, connected && !!targetId, canvasRef, {
    ackEvent: "browser:stream.ack",
    verifyEvent: "browser:request-tiles-hashes",
    targetId: (targetId || null) as any,
    resetWorker: false
  });

  const {
    hasFrame,
    handleTilesData,
    handleTilesBinaryV2,
    cleanupTiles,
    requestScreenWithHashes,
    handleScreenDimensions,
    renderedTilesRef
  } = tiles;

  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.on || !targetId) return;

    cleanupTiles();
    let stopped = false;

    const onTilesData = (data: any) => {
      if (stopped) return;
      handleTilesData(data);
      onPaintedRef.current?.({}, data.bytes);
    };

    const onTilesBin = (buffer: any) => {
      if (stopped) return;
      handleTilesBinaryV2(buffer);
      onPaintedRef.current?.({}, buffer?.byteLength || 0);
    };

    // Host announces the REAL raster size (tiles live in it) and the page's CSS
    // viewport (input mapping reads meta.deviceWidth/Height). Tiles carry neither.
    const onDimensions = (dims: any) => {
      if (stopped || dims?.targetId !== targetId || !dims.frameW || !dims.frameH) return;
      const prev = frameRef.current;
      const resized = !prev || prev.w !== dims.frameW || prev.h !== dims.frameH;
      const next: BrowserFrameInfo = {
        w: dims.frameW,
        h: dims.frameH,
        meta: { ...(prev?.meta || {}), deviceWidth: dims.deviceWidth, deviceHeight: dims.deviceHeight }
      };
      frameRef.current = next;
      if (!resized) return;
      // New grid: old hashes/tiles are meaningless. Resizing a canvas also clears it,
      // so ask for a full repaint right away (tiles may have beaten this message).
      cleanupTiles();
      handleScreenDimensions({ tileCount: dims.tileCount });
      setFrame(next);
      if (canvasRef.current) {
        canvasRef.current.width = dims.frameW;
        canvasRef.current.height = dims.frameH;
      }
      bus.emit?.("browser:request-tiles-hashes", { targetId, tileHashes: [] });
    };

    bus.on?.("browser:tiles-data", onTilesData);
    bus.on?.("browser:tiles-bin", onTilesBin);
    bus.on?.("browser:screen-dimensions", onDimensions);

    // Periodic verify-repair (Remote Desktop's hash request loop)
    const verifyInterval = setInterval(() => {
      if (stopped || (typeof document !== "undefined" && document.hidden)) return;
      if (renderedTilesRef.current.size === 0) {
        bus.emit?.("browser:request-tiles-hashes", { targetId, tileHashes: [] });
      } else {
        requestScreenWithHashes();
      }
    }, REMOTE_CONFIG.hashRequestInterval);

    return () => {
      stopped = true;
      bus.off?.("browser:tiles-data", onTilesData);
      bus.off?.("browser:tiles-bin", onTilesBin);
      bus.off?.("browser:screen-dimensions", onDimensions);
      clearInterval(verifyInterval);
      cleanupTiles();
    };
  }, [busRef, connected, targetId, cleanupTiles, handleTilesData, handleTilesBinaryV2, handleScreenDimensions, requestScreenWithHashes, renderedTilesRef]);

  return {
    canvasRef,
    frame: (hasFrame || frame) ? (frame || { w: 1280, h: 720 }) : null,
    frameRef
  };
}
