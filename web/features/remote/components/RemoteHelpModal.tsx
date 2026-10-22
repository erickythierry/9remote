"use client";

import { useEffect } from "react";
import { X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";

export interface RemoteHelpModalProps {
  onClose?: () => void;
  inputMode?: string;
  pointerMode?: string;
}

interface HelpItem {
  key: string;
  desc: string;
}

interface HelpSection {
  title: string;
  items: HelpItem[];
}

function buildSections(t: (key: string) => string, inputMode: string, pointerMode: string): HelpSection[] {
  if (inputMode === "mouse") {
    return [
      {
        title: t("remoteHelp.mouseTitle"),
        items: [
          { key: t("remoteHelp.mouseClickKey"), desc: t("remoteHelp.mouseClickDesc") },
          { key: t("remoteHelp.mouseRightKey"), desc: t("remoteHelp.mouseRightDesc") },
          { key: t("remoteHelp.mouseWheelKey"), desc: t("remoteHelp.mouseWheelDesc") },
          { key: t("remoteHelp.mouseDoubleKey"), desc: t("remoteHelp.mouseDoubleDesc") }
        ]
      },
      {
        title: t("remoteHelp.keyboardTitle"),
        items: [
          { key: t("remoteHelp.keyPhysicalKey"), desc: t("remoteHelp.keyPhysicalDesc") },
          { key: t("remoteHelp.keyModifierKey"), desc: t("remoteHelp.keyModifierDesc") }
        ]
      }
    ];
  }

  if (pointerMode === "trackpad") {
    return [
      {
        title: t("remoteHelp.gesturesTrackpadTitle"),
        items: [
          { key: t("remoteHelp.trackpadSwipeKey"), desc: t("remoteHelp.trackpadSwipeDesc") },
          { key: t("remoteHelp.trackpadScrollLockKey"), desc: t("remoteHelp.trackpadScrollLockDesc") },
          { key: t("remoteHelp.trackpadTapKey"), desc: t("remoteHelp.trackpadTapDesc") },
          { key: t("remoteHelp.trackpad2TapKey"), desc: t("remoteHelp.trackpad2TapDesc") },
          { key: t("remoteHelp.trackpad2SwipeKey"), desc: t("remoteHelp.trackpad2SwipeDesc") },
          { key: t("remoteHelp.trackpadPinchKey"), desc: t("remoteHelp.trackpadPinchDesc") }
        ]
      },
      {
        title: t("remoteHelp.toolbarTitle"),
        items: [
          { key: "✋", desc: t("remoteHelp.toolbarHandDesc") },
          { key: "🖱️", desc: t("remoteHelp.toolbarMouseDirectDesc") },
          { key: "⌨️ / Aa", desc: t("remoteHelp.toolbarKeyboardDesc") }
        ]
      }
    ];
  }

  return [
    {
      title: t("remoteHelp.gesturesDirectTitle"),
      items: [
        { key: t("remoteHelp.directTapKey"), desc: t("remoteHelp.directTapDesc") },
        { key: t("remoteHelp.directLongKey"), desc: t("remoteHelp.directLongDesc") },
        { key: t("remoteHelp.directDoubleKey"), desc: t("remoteHelp.directDoubleDesc") },
        { key: t("remoteHelp.directScrollKey"), desc: t("remoteHelp.directScrollDesc") },
        { key: t("remoteHelp.directPinchKey"), desc: t("remoteHelp.directPinchDesc") },
        { key: t("remoteHelp.directPanKey"), desc: t("remoteHelp.directPanDesc") }
      ]
    },
    {
      title: t("remoteHelp.toolbarTitle"),
      items: [
        { key: "🖱️", desc: t("remoteHelp.toolbarMouseTrackpadDesc") },
        { key: "⌨️ / Aa", desc: t("remoteHelp.toolbarKeyboardDesc") },
        { key: "□", desc: t("remoteHelp.toolbarRectDesc") }
      ]
    }
  ];
}

export default function RemoteHelpModal({ onClose, inputMode = "touch", pointerMode = "direct" }: RemoteHelpModalProps) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const sections = buildSections(t, inputMode, pointerMode);
  const modeLabel = inputMode === "mouse"
    ? t("remoteHelp.modePc")
    : pointerMode === "trackpad"
      ? t("remoteHelp.modeTrackpad")
      : t("remoteHelp.modeDirect");

  return (
    <div
      className="fixed inset-x-0 top-0 h-[var(--app-height,100dvh)] z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="card-elev max-w-lg w-full max-h-full overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-surface z-10">
          <div className="flex items-baseline gap-2">
            <h2 className="text-text text-base font-semibold">{t("remote.help")}</h2>
            <span className="text-brand-400 text-xs font-mono">{modeLabel}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-2 text-text-muted hover:text-text transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="text-brand-400 text-xs font-semibold uppercase tracking-wider mb-2">
                {section.title}
              </h3>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item.key} className="flex gap-3 text-sm">
                    <span className="text-text font-mono bg-bg px-2 py-0.5 rounded text-xs shrink-0 min-w-[120px] text-center">
                      {item.key}
                    </span>
                    <span className="text-text-muted">{item.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
