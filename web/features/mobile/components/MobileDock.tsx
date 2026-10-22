"use client";

import { useCallback, RefObject } from "react";
import { createPortal } from "react-dom";
import { X, PanelRight, GripVertical } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useFloatingWindow } from "../hooks/useFloatingWindow";
import MobileMirror from "./MobileMirror";

const RESIZE_EDGES = [
  { edge: "n", className: "top-0 left-3 right-3 h-1", cursor: "cursor-ns-resize" },
  { edge: "s", className: "bottom-0 left-3 right-3 h-1", cursor: "cursor-ns-resize" },
  { edge: "w", className: "top-3 bottom-3 left-0 w-1", cursor: "cursor-ew-resize" },
  { edge: "e", className: "top-3 bottom-3 right-0 w-1", cursor: "cursor-ew-resize" },
  { edge: "nw", className: "top-0 left-0 w-3 h-3", cursor: "cursor-nwse-resize" },
  { edge: "ne", className: "top-0 right-0 w-3 h-3", cursor: "cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 w-3 h-3", cursor: "cursor-nesw-resize" },
  { edge: "se", className: "bottom-0 right-0 w-3 h-3", cursor: "cursor-nwse-resize" }
];

export interface MobileDockProps {
  busRef: RefObject<any>;
  protocolRef?: RefObject<any>;
  connected: boolean;
  pinSlot?: Element | null;
}

export default function MobileDock({ busRef, protocolRef, connected, pinSlot = null }: MobileDockProps) {
  const { t } = useI18n();

  const mobileMode = useTerminalStore((s) => s.mobileMode);
  const floatRect = useTerminalStore((s) => s.mobileFloatRect);
  const setMobileOpen = useTerminalStore((s) => s.setMobileOpen);
  const setMobileSession = useTerminalStore((s) => s.setMobileSession);
  const setMobileMode = useTerminalStore((s) => s.setMobileMode);
  const setMobileFloatRect = useTerminalStore((s) => s.setMobileFloatRect);

  const floating = useFloatingWindow({
    rect: floatRect,
    onChange: setMobileFloatRect,
    enabled: mobileMode === "float"
  });

  const handleClose = useCallback(() => {
    busRef?.current?.emit("mobile:stop");
    setMobileSession(null);
    setMobileOpen(false);
  }, [busRef, setMobileSession, setMobileOpen]);

  const pinned = mobileMode === "pin";

  const chrome = (draggable: boolean) => (
    <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border bg-surface flex-shrink-0">
      <div
        className={`flex items-center gap-1 flex-1 min-w-0 ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={draggable ? floating.onDragHandlePointerDown : undefined}
      >
        {draggable && <GripVertical size={13} className="text-text-muted flex-shrink-0" />}
        <span className="text-xs text-text-muted select-none truncate">{t("mobile.title")}</span>
      </div>
      <button
        onClick={() => { vibrate(); setMobileMode(pinned ? "float" : "pin"); }}
        className={`p-1.5 rounded-brand transition-colors ${pinned ? "text-brand-500 bg-surface-2" : "text-text-muted hover:text-text hover:bg-surface-2"}`}
        title={pinned ? t("mobile.modeFloat") : t("mobile.modePin")}
        aria-label={pinned ? t("mobile.modeFloat") : t("mobile.modePin")}
        aria-pressed={pinned}
      >
        <PanelRight size={13} />
      </button>
      <button
        onClick={() => { vibrate(); handleClose(); }}
        className="p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
        title={t("common.close")}
        aria-label={t("common.close")}
      >
        <X size={13} />
      </button>
    </div>
  );

  const panel = (draggable: boolean) => (
    <div className="flex flex-col h-full w-full bg-bg overflow-hidden">
      {chrome(draggable)}
      <div className="flex-1 min-h-0 relative">
        <MobileMirror
          busRef={busRef}
          protocolRef={protocolRef}
          connected={connected}
          variant="panel"
          onClose={handleClose}
        />
      </div>
    </div>
  );

  if (pinned) {
    return pinSlot ? createPortal(panel(false), pinSlot) : null;
  }

  const rect = floating.rect;
  if (!rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed z-40 flex flex-col rounded-brand-lg overflow-hidden border border-border shadow-2xl bg-bg"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerMove={floating.onPointerMove}
      onPointerUp={floating.onPointerUp}
      onPointerCancel={floating.onPointerCancel}
    >
      {panel(true)}
      {RESIZE_EDGES.map(({ edge, className, cursor }) => (
        <div
          key={edge}
          onPointerDown={floating.onResizeHandlePointerDown(edge)}
          className={`absolute ${className} ${cursor}`}
          aria-label={t("mobile.resize")}
        />
      ))}
    </div>,
    document.body
  );
}
