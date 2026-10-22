"use client";

import { useState, useRef, useEffect, RefObject, MutableRefObject } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { tileStatsFrom } from "@/features/remote/lib/tileBinaryHeader";
import { debugLog } from "@/shared/utils/debugLog";

export interface MonitorInfo {
  id?: string | number;
  name?: string;
  width?: number;
  height?: number;
  [key: string]: any;
}

export interface UnlockResult {
  ok: boolean;
  reason?: string;
  [key: string]: any;
}

export interface UseRemoteStreamParams {
  busRef: RefObject<any>;
  connected: boolean;
  streaming: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  serverDimensionsRef: MutableRefObject<{ width?: number; height?: number } | null | undefined>;
  handleCanvasDimensions: (dimensions: any, renderedTilesRef?: any) => void | boolean;
  resetPan: () => void;
  zoomGestureTimeoutRef: MutableRefObject<any>;
  trackTilesReceived: (data: any, via: string) => void;
  tiles: {
    renderedTilesRef: MutableRefObject<Set<string> | any>;
    handleFullScreenData: (data: any) => void;
    handleTilesData: (data: any) => void;
    handleTilesBinary: (buffer: any) => void;
    handleTilesBinaryV2: (buffer: any) => void;
    handleTilesMeta: (meta: any) => void;
    handleScreenDimensions: (dimensions: any) => void;
    cleanupTiles: () => void;
    requestScreenWithHashes: () => void;
  };
}

// Screen-stream lifecycle: host bus listeners, the (re)stream handshake, and the
// keep-alive effects that guarantee a painted canvas (periodic hash sync, dimension
// recovery, pause while hidden).
export function useRemoteStream({
  busRef, connected, streaming,
  canvasRef, serverDimensionsRef, handleCanvasDimensions, resetPan,
  zoomGestureTimeoutRef, trackTilesReceived, tiles
}: UseRemoteStreamParams) {
  const [screenLocked, setScreenLocked] = useState<boolean>(false);
  const [unlockReady, setUnlockReady] = useState<boolean>(false);
  const [unlockResult, setUnlockResult] = useState<UnlockResult | null>(null);
  const [clipboardText, setClipboardText] = useState<string>("");
  const [clipboardNew, setClipboardNew] = useState<boolean>(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [activeMonitorIndex, setActiveMonitorIndex] = useState<number>(0);
  const [cursorShape, setCursorShape] = useState<any>(null);
  const lastTileTransportRef = useRef<string | null>(null);

  const {
    renderedTilesRef, handleFullScreenData, handleTilesData, handleTilesBinary,
    handleTilesBinaryV2, handleTilesMeta, handleScreenDimensions, cleanupTiles,
    requestScreenWithHashes
  } = tiles;

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;

    // Reset stale tile state on (re)connect — stale hashes cause agent to skip tiles → black canvas
    cleanupTiles();

    const onScreenDimensions = (dimensions: any) => {
      handleScreenDimensions(dimensions);
      handleCanvasDimensions(dimensions, renderedTilesRef);
    };
    const onFullScreenData = (data: any) => handleFullScreenData(data);
    const onTilesData = (data: any) => {
      const via = data.transport || "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via}`);
      }
      trackTilesReceived(data, via);
      handleTilesData(data);
    };
    const onScreenError = (err: any) => console.error("Screen error:", err);

    const onScreenLocked = ({ locked, ready }: { locked?: boolean; ready?: boolean } = {}) => {
      setScreenLocked(!!locked);
      setUnlockReady(!!ready);
      if (locked) setUnlockResult(null);
    };

    const onUnlockResult = (r: UnlockResult | null) => setUnlockResult(r || null);

    const trackBinary = (buffer: ArrayBuffer | Uint8Array, label: string) => {
      const via = "ws";
      if (via !== lastTileTransportRef.current) {
        lastTileTransportRef.current = via;
        debugLog("remote", `[remote] tiles via ${via}${label}`);
      }
      trackTilesReceived(tileStatsFrom(buffer as any), via);
    };
    const onTilesBinary = (buffer: ArrayBuffer | Uint8Array) => {
      trackBinary(buffer, "");
      handleTilesBinary(buffer);
    };
    const onTilesMeta = (meta: any) => handleTilesMeta(meta);

    const onTilesBinV2 = (buffer: ArrayBuffer | Uint8Array) => {
      trackBinary(buffer, " v2");
      handleTilesBinaryV2(buffer);
    };

    const doRestream = () => {
      cleanupTiles();
      bus.emit("get-screen-dimensions");
      bus.emit("get-unlock-state");
      bus.emit("start-streaming");
    };

    const onRemoteReady = () => doRestream();

    const onClipboardUpdate = ({ text, hash }: { text?: string; hash?: string }) => {
      setClipboardText((prev) => {
        if (hash && hash === (onClipboardUpdate as any)._lastHash) return prev;
        (onClipboardUpdate as any)._lastHash = hash || null;
        return text || "";
      });
      setClipboardNew(true);
    };

    const onMonitors = ({ list, activeIndex }: { list?: MonitorInfo[]; activeIndex?: number }) => {
      setMonitors(Array.isArray(list) ? list : []);
      if (typeof activeIndex === "number") setActiveMonitorIndex(activeIndex);
    };

    const onFrameMeta = (meta: any) => {
      cleanupTiles();
      resetPan();
      if (typeof meta?.monitorIndex === "number") setActiveMonitorIndex(meta.monitorIndex);
    };

    bus.on("screen-dimensions", onScreenDimensions);
    bus.on("full-screen-data", onFullScreenData);
    bus.on("tiles-data", onTilesData);
    bus.on("tiles-data-binary", onTilesBinary);
    bus.on("tiles-bin-v2", onTilesBinV2);
    bus.on("tiles-meta", onTilesMeta);
    bus.on("screen-error", onScreenError);
    bus.on("screen-locked", onScreenLocked);
    bus.on("unlock-result", onUnlockResult);
    bus.on("remote:ready", onRemoteReady);
    bus.on("clipboard-update", onClipboardUpdate);
    bus.on("monitors", onMonitors);
    bus.on("frame_meta", onFrameMeta);
    const onCursorShape = (data: any) => setCursorShape(data?.shape ?? null);
    bus.on("cursor-shape", onCursorShape);

    doRestream();

    return () => {
      bus.emit("stop-streaming");
      bus.off("screen-dimensions", onScreenDimensions);
      bus.off("full-screen-data", onFullScreenData);
      bus.off("tiles-data", onTilesData);
      bus.off("tiles-data-binary", onTilesBinary);
      bus.off("tiles-bin-v2", onTilesBinV2);
      bus.off("tiles-meta", onTilesMeta);
      bus.off("screen-error", onScreenError);
      bus.off("screen-locked", onScreenLocked);
      bus.off("unlock-result", onUnlockResult);
      bus.off("remote:ready", onRemoteReady);
      bus.off("clipboard-update", onClipboardUpdate);
      bus.off("monitors", onMonitors);
      bus.off("frame_meta", onFrameMeta);
      bus.off("cursor-shape", onCursorShape);
      cleanupTiles();
      if (zoomGestureTimeoutRef.current) clearTimeout(zoomGestureTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    if (!streaming || !connected || !busRef?.current) return;
    const id = setInterval(() => {
      if (renderedTilesRef.current.size === 0) {
        busRef.current.emit("request-screen-with-hashes", { tileHashes: [] });
      } else {
        requestScreenWithHashes();
      }
    }, REMOTE_CONFIG.hashRequestInterval);
    return () => clearInterval(id);
  }, [streaming, connected, busRef, requestScreenWithHashes, renderedTilesRef]);

  useEffect(() => {
    if (!connected) return;
    const ensureSized = () => {
      const canvas = canvasRef.current;
      if (!canvas || canvas.width > 0) return true;
      const { width, height } = serverDimensionsRef.current || {};
      if (width && width > 0) handleCanvasDimensions({ width, height }, renderedTilesRef);
      else busRef.current?.emit("get-screen-dimensions");
      return false;
    };
    if (ensureSized()) return;
    const id = setInterval(() => { if (ensureSized()) clearInterval(id); }, REMOTE_CONFIG.restreamDelay);
    return () => clearInterval(id);
  }, [connected, busRef, canvasRef, serverDimensionsRef, handleCanvasDimensions, renderedTilesRef]);

  // Pause stream when tab hidden to save CPU + bandwidth
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;
    const onVisibility = () => {
      if (document.hidden) {
        bus.emit("stop-streaming");
      } else {
        bus.emit("start-streaming");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [connected, busRef]);

  return {
    screenLocked,
    unlockReady,
    unlockResult,
    setUnlockResult,
    clipboardText,
    clipboardNew,
    setClipboardNew,
    monitors,
    activeMonitorIndex,
    cursorShape
  };
}
