"use client";

import { memo } from "react";
import Icon, { Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";

// The same icon → colour map the status bar uses, so a mode reads identically in both.
const MODE_ICON_COLOR: Record<string, string> = {
  Shield: "text-text-muted",
  Pencil: "text-accent",
  Eye: "text-accent",
  Sparkles: "text-warning",
};

export interface ModeModalProps {
  modes?: any[];
  currentMode?: string;
  onClose?: () => void;
  onSelectMode?: (mode: string) => void;
}

// Codex's `/permissions`: pick what the CLI may do without asking. The list comes from
// the engine's own registry, so no engine branch is needed here.
export const ModeModal = memo(function ModeModal({
  modes = [],
  currentMode = "",
  onClose,
  onSelectMode
}: ModeModalProps) {
  const handlePick = (mode: string) => {
    vibrate();
    onSelectMode?.(mode);
    onClose?.();
  };

  return (
    <ModalShell
      icon={<Icon name="Shield" size={14} />}
      title="Permissions"
      subtitle="What the agent may do without asking"
      maxWidth="max-w-md"
      onClose={onClose}
    >
      <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-0.5 custom-scrollbar">
        {modes.map((m: any) => {
          const isSelected = currentMode === m.id;
          return (
            <div
              key={m.id}
              onClick={() => handlePick(m.id)}
              data-selected={isSelected}
              className="modal-row"
            >
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <Icon
                  name={m.icon || "Shield"}
                  size={14}
                  className={`${MODE_ICON_COLOR[m.icon || ""] || "text-text-muted"} shrink-0`}
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text">{m.label}</div>
                  <div className="text-[11px] text-text-subtle">{m.desc}</div>
                </div>
              </div>

              {isSelected && <Check size={14} className="text-brand-500 shrink-0" />}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
});
