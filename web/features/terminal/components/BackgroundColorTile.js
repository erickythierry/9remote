"use client";

import { useRef } from "react";
import { Palette } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

// The native color input fires on every drag step: hand back the previous pick so the
// caller replaces it instead of piling up one pool entry per step.
export default function BackgroundColorTile({ label, onPick, className = "" }) {
  const prevRef = useRef(null);
  return (
    <label
      className={`group relative block w-full aspect-[9/16] rounded-2xl overflow-hidden border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 text-text-muted hover:border-brand-500 hover:text-brand-500 transition-colors cursor-pointer ${className}`}
      onClick={() => vibrate()}
    >
      <Palette size={24} strokeWidth={1.75} />
      <span className="text-xs font-medium">{label}</span>
      <input
        type="color"
        className="absolute inset-0 opacity-0 cursor-pointer"
        onChange={(e) => {
          const key = `color:${e.target.value}`;
          onPick(key, prevRef.current);
          prevRef.current = key;
        }}
        aria-label={label}
      />
    </label>
  );
}
