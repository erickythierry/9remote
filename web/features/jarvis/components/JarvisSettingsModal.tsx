"use client";

import { memo } from "react";
import { Settings } from "@/shared/components/ui/Icon";
import { ModalShell } from "@/features/ai/components/modals/ModalShell";
import { JarvisConfigPanel } from "@/features/jarvis/components/JarvisConfigPanel";

const ModalShellComponent = ModalShell as React.ComponentType<any>;

interface JarvisSettingsModalProps {
  busRef?: React.MutableRefObject<any>;
  onClose?: () => void;
}

/**
 * The in-view gear modal — a thin shell around JarvisConfigPanel, which is the
 * same configuration the settings dialog's Jarvis section shows.
 */
export const JarvisSettingsModal = memo(function JarvisSettingsModal({ busRef, onClose }: JarvisSettingsModalProps) {
  return (
    <ModalShellComponent
      icon={<Settings size={14} />}
      title="Jarvis Settings"
      subtitle="Coordinator harness and behavior"
      maxWidth="max-w-sm"
      onClose={onClose}
    >
      <div className="p-3">
        <JarvisConfigPanel busRef={busRef} />
      </div>
    </ModalShellComponent>
  );
});
