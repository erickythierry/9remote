"use client";

import React, { useEffect, useRef, useState, RefObject } from "react";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { useI18n } from "@/shared/i18n";
import { Lock, Eye, EyeOff, Loader2 } from "@/shared/components/ui/Icon";
import MonitorSwitcher from "@/features/remote/components/MonitorSwitcher";
import { MonitorInfo, UnlockResult } from "@/features/remote/hooks/useRemoteStream";
import { SelectionRect } from "@/features/remote/hooks/useInput";

export interface ClickIndicator {
  x: number;
  y: number;
  size: number;
}

export interface RemoteCanvasProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasContainerRef: RefObject<HTMLDivElement | null>;
  canvasZoom: number;
  canvasPan: { x: number; y: number };
  fitScale: number;
  streaming: boolean;
  hasFrame?: boolean;
  selectionRect?: SelectionRect | null;
  clickIndicator?: ClickIndicator | null;
  pointerMode?: string;
  selectionMode?: boolean;
  handMode?: boolean;
  handHolding?: boolean;
  scrollLock?: boolean;
  virtualCursor?: { x: number; y: number } | null;
  cursorShape?: string | null;
  inputMode?: string;
  keyboardOn?: boolean;
  monitors?: MonitorInfo[];
  activeMonitorIndex?: number;
  onSelectMonitor?: (index: number) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onWheel?: (e: WheelEvent | React.WheelEvent<HTMLCanvasElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onDoubleClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  onTouchStart?: (e: React.TouchEvent<HTMLDivElement>) => void;
  onTouchMove?: (e: React.TouchEvent<HTMLDivElement>) => void;
  onTouchEnd?: (e: React.TouchEvent<HTMLDivElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLCanvasElement>) => void;
  screenLocked?: boolean;
  unlockReady?: boolean;
  unlockResult?: UnlockResult | null;
  onUnlockSubmit?: (password: string) => void;
  cursorOverride?: string;
  children?: React.ReactNode;
}

export default function RemoteCanvas({
  canvasRef,
  canvasContainerRef,
  canvasZoom,
  canvasPan,
  fitScale,
  streaming,
  hasFrame = true,
  selectionRect,
  clickIndicator,
  pointerMode,
  selectionMode,
  handMode,
  handHolding,
  scrollLock,
  virtualCursor,
  cursorShape,
  inputMode,
  keyboardOn,
  monitors,
  activeMonitorIndex,
  onSelectMonitor,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  onContextMenu,
  onDoubleClick,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onKeyDown,
  screenLocked,
  unlockReady,
  unlockResult,
  onUnlockSubmit,
  cursorOverride,
  children
}: RemoteCanvasProps) {
  const totalScale = fitScale * canvasZoom;
  const isMouseInput = inputMode === "mouse";
  const { t } = useI18n();
  const [isDraggingMouse, setIsDraggingMouse] = useState(false);
  const [unlockText, setUnlockText] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [showPass, setShowPass] = useState(false);

  useEffect(() => {
    if (!screenLocked) { setUnlockText(""); setUnlockBusy(false); }
  }, [screenLocked]);

  useEffect(() => {
    if (unlockResult) setUnlockBusy(false);
  }, [unlockResult]);

  const RESIZE_CSS: Record<string, string> = {
    ew: "cursor-ew-resize", ns: "cursor-ns-resize",
    nwse: "cursor-nwse-resize", nesw: "cursor-nesw-resize", all: "cursor-move"
  };
  const cursorClass = selectionMode
    ? "cursor-crosshair"
    : handMode
      ? (handHolding ? "cursor-grabbing" : "cursor-grab")
      : isMouseInput && isDraggingMouse
        ? "cursor-grabbing"
        : (isMouseInput && cursorShape && RESIZE_CSS[cursorShape])
          ? RESIZE_CSS[cursorShape]
          : pointerMode === "trackpad"
            ? "cursor-grab active:cursor-grabbing"
            : "cursor-default";

  const onWheelRef = useRef(onWheel);
  useEffect(() => { onWheelRef.current = onWheel; }, [onWheel]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => onWheelRef.current?.(e);
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [canvasRef]);

  useEffect(() => {
    if (!isMouseInput || !streaming) return;
    canvasRef.current?.focus();
  }, [canvasRef, isMouseInput, streaming]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Soft keyboard on: a touch tap must not move focus off the sink textarea
    // (the blur would close the keyboard) — cancel the native focus default.
    if (keyboardOn && e.pointerType !== "mouse") e.preventDefault();
    const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (ae?.name === "remote-batch-input") {
      if (keyboardOn) {
        const sink = document.querySelector('textarea[name="remote-keyboard-sink"]') as HTMLTextAreaElement | null;
        sink?.focus();
      } else {
        ae.blur();
      }
    }
    if (isMouseInput) {
      canvasRef.current?.focus();
      if (e.pointerType === "mouse") setIsDraggingMouse(true);
    }
    onPointerDown?.(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isMouseInput && e.pointerType === "mouse") setIsDraggingMouse(false);
    onPointerUp?.(e);
  };

  useEffect(() => {
    if (!isDraggingMouse) return;
    const clear = () => setIsDraggingMouse(false);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, [isDraggingMouse]);

  return (
    <div className="w-full h-full overflow-hidden relative flex-1">
      <div
        className="absolute inset-0"
        ref={canvasContainerRef}
        style={{ touchAction: "none" }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <canvas
          ref={canvasRef}
          className={`block ${cursorClass} bg-black outline-none`}
          style={{
            touchAction: "none",
            cursor: cursorOverride,
            transformOrigin: "top left",
            userSelect: "none",
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
            WebkitTapHighlightColor: "transparent",
            transform: `translate3d(${canvasPan.x}px, ${canvasPan.y}px, 0) scale(${totalScale})`,
            imageRendering: "auto",
            willChange: "transform"
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          tabIndex={0}
          onKeyDown={onKeyDown}
        />

        {streaming && !hasFrame && !screenLocked && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 text-white/80 text-[11px] font-mono">
              <Loader2 size={12} className="animate-spin" />
              {t("remote.receivingImage", { defaultValue: "Receiving screen…" })}
            </div>
          </div>
        )}

        {selectionRect && (
          <div
            className="absolute border-2 border-blue-400 bg-blue-400/20 z-10"
            style={{
              left: `${selectionRect.x}px`,
              top: `${selectionRect.y}px`,
              width: `${selectionRect.width}px`,
              height: `${selectionRect.height}px`
            }}
          />
        )}

        {pointerMode === "trackpad" && virtualCursor && (
          <div
            className="absolute pointer-events-none z-30"
            style={{
              left: `${virtualCursor.x * totalScale + canvasPan.x}px`,
              top: `${virtualCursor.y * totalScale + canvasPan.y}px`,
              width: `${REMOTE_CONFIG.trackpadCursorSize}px`,
              height: `${REMOTE_CONFIG.trackpadCursorSize}px`,
              transform: (cursorShape || handMode || scrollLock || selectionMode) ? "translate(-50%, -50%)" : "translate(-2px, -2px)"
            }}
          >
            {scrollLock ? (
              <div
                className="w-full h-full flex items-center justify-center text-yellow-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                style={{ fontSize: `${REMOTE_CONFIG.trackpadCursorSize}px`, lineHeight: 1 }}
              >
                ✥
              </div>
            ) : selectionMode ? (
              <svg viewBox="0 0 24 24" className="w-full h-full text-yellow-400 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                <path
                  d="M12 3 V21 M3 12 H21"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            ) : handMode ? (
              <div
                className="w-full h-full flex items-center justify-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                style={{ fontSize: `${REMOTE_CONFIG.trackpadCursorSize}px`, lineHeight: 1 }}
              >
                {handHolding ? "✊" : "✋"}
              </div>
            ) : cursorShape ? (
              <svg
                viewBox="0 0 24 24"
                className="w-full h-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                style={{ transform: `rotate(${cursorShape === "ns" ? 90 : cursorShape === "nwse" ? 45 : cursorShape === "nesw" ? -45 : 0}deg)` }}
              >
                {cursorShape === "all" ? (
                  <path
                    d="M12 3 V21 M3 12 H21 M8 6 L12 2 L16 6 M8 18 L12 22 L16 18 M6 8 L2 12 L6 16 M18 8 L22 12 L18 16"
                    fill="#ffffff" stroke="#000000" strokeWidth="1.2"
                    strokeLinecap="round" strokeLinejoin="round"
                  />
                ) : (
                  <path
                    d="M3 12 H21 M7 8 L3 12 L7 16 M17 8 L21 12 L17 16"
                    fill="#ffffff" stroke="#000000" strokeWidth="1.2"
                    strokeLinecap="round" strokeLinejoin="round"
                  />
                )}
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="w-full h-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                <path
                  d="M4 2 L4 18 L8.5 14 L11 20 L14 18.5 L11.5 13 L18 12.5 Z"
                  fill="#ffffff"
                  stroke="#000000"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        )}

        {clickIndicator && (
          <div
            className="absolute pointer-events-none z-20"
            style={{
              left: `${clickIndicator.x - clickIndicator.size / 2}px`,
              top: `${clickIndicator.y - clickIndicator.size / 2}px`,
              width: `${clickIndicator.size}px`,
              height: `${clickIndicator.size}px`
            }}
          >
            <div className="w-full h-full rounded-full border-2 border-blue-400 bg-blue-400/30 animate-ping" />
            <div className="absolute inset-0 w-full h-full rounded-full border-2 border-blue-400 bg-blue-400/50" />
          </div>
        )}
      </div>
      {/* View-specific overlays (browser pick rings, load states...) sit over the stage but
          OUTSIDE the touch container, so taps on them never reach the canvas handlers. */}
      {children}

      <MonitorSwitcher
        list={monitors}
        activeIndex={activeMonitorIndex}
        onSelect={onSelectMonitor}
      />

      {screenLocked && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          style={{ background: "radial-gradient(circle at 50% 40%, rgba(40,60,140,0.55) 0%, rgba(10,12,30,0.92) 60%, rgba(0,0,0,0.96) 100%)" }}
        >
          <div className="w-full max-w-[300px] mx-4 rounded-2xl p-5 shadow-2xl backdrop-blur-md" style={{ background: "rgba(20,22,40,0.85)", border: "1px solid rgba(120,140,220,0.25)" }}>
            {unlockReady ? (
              <>
                <div className="flex flex-col items-center gap-2 mb-4">
                  <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(120,140,220,0.18)" }}>
                    <Lock size={26} color="#a9b8ff" />
                  </div>
                  <h3 className="text-base font-semibold text-white">{t("remote.lockTitle")}</h3>
                  <p className="text-xs text-center" style={{ color: "rgba(220,225,245,0.7)" }}>
                    {t("remote.lockDesc")}
                  </p>
                </div>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={unlockText}
                    autoFocus
                    disabled={unlockBusy}
                    onChange={(e) => setUnlockText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && unlockText && !unlockBusy) {
                        setUnlockBusy(true);
                        onUnlockSubmit?.(unlockText);
                      }
                    }}
                    placeholder={t("remote.lockPlaceholder")}
                    className="w-full rounded-xl px-4 py-2 pr-11 text-sm text-white focus:outline-none focus:border-blue-400"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(120,140,220,0.35)" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    tabIndex={-1}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg"
                    style={{ color: "rgba(220,225,245,0.7)" }}
                    aria-label={showPass ? "Hide password" : "Show password"}
                  >
                    {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <button
                  type="button"
                  disabled={!unlockText || unlockBusy}
                  onClick={() => {
                    setUnlockBusy(true);
                    onUnlockSubmit?.(unlockText);
                  }}
                  className="w-full mt-2.5 rounded-xl py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
                  style={{ background: "linear-gradient(135deg, #4a6cf7 0%, #6b8aff 100%)" }}
                >
                  {unlockBusy ? t("remote.unlocking") : t("remote.unlock")}
                </button>
                {unlockResult && !unlockResult.ok && (
                  <p className="mt-3 text-xs text-center text-red-300">
                    {t("remote.unlockFailed")}
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(120,140,220,0.18)" }}>
                  <Lock size={26} color="#a9b8ff" />
                </div>
                <h3 className="text-base font-semibold text-white">{t("remote.lockTitle")}</h3>
                <p className="text-xs" style={{ color: "rgba(220,225,245,0.85)" }}>
                  {t("remote.lockGrantDesc")}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
