"use client";

import { useEffect, useRef, type ComponentType } from "react";
import { Copy, FileText, ExternalLink, Undo2, X, EyeOff } from "./Icon";

// VSCode-style right-click menu for a file row.
// items: array of { key, label, icon, onClick, danger?, disabled? }
// onClose: hide the menu
export type FileContextMenuItem = {
  key: string;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
};

type FileContextMenuProps = {
  x: number;
  y: number;
  items: (FileContextMenuItem | null | undefined | false)[];
  onClose: () => void;
};

export default function FileContextMenu({ x, y, items, onClose }: FileContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    // Clamp inside viewport
    const rect = ref.current.getBoundingClientRect();
    const adjX = Math.min(x, window.innerWidth - rect.width - 8);
    const adjY = Math.min(y, window.innerHeight - rect.height - 8);
    ref.current.style.left = `${Math.max(8, adjX)}px`;
    ref.current.style.top = `${Math.max(8, adjY)}px`;
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Defer so the opening click doesn't immediately close it
    const id = setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("contextmenu", close, true);
      document.addEventListener("keydown", onEsc);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] py-1 rounded-lg border border-border bg-surface shadow-elev animate-in fade-in"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.filter((item): item is FileContextMenuItem => !!item).map((item, i) => (
        <button
          key={item.key + i}
          type="button"
          disabled={item.disabled}
          onClick={(e) => { e.stopPropagation(); item.onClick?.(); onClose(); }}
          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
            item.disabled
              ? "text-text-subtle cursor-not-allowed"
              : item.danger
                ? "text-danger hover:bg-[rgba(var(--danger-rgb),0.12)]"
                : "text-text hover:bg-surface-2"
          }`}
        >
          {item.icon && <item.icon size={14} className="flex-shrink-0" />}
          <span className="flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export const FILE_MENU_ICONS = { Copy, FileText, ExternalLink, Undo2, X, EyeOff };
