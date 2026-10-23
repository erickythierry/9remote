"use client";

import { memo } from "react";
import { Plug, CheckCircle2, AlertCircle } from "@/shared/components/ui/Icon";
import { ModalShell } from "./ModalShell";

export interface PluginItem {
  id?: string;
  name?: string;
  marketplace?: string;
  version?: string;
  enabled?: boolean;
  skills?: number;
  agents?: number;
  commands?: number;
  [key: string]: any;
}

export interface PluginsModalProps {
  plugins?: PluginItem[];
  onClose?: () => void;
}

const PARTS = ["skills", "agents", "commands"] as const;

export const PluginsModal = memo(function PluginsModal({
  plugins = [],
  onClose
}: PluginsModalProps) {
  return (
    <ModalShell
      icon={<Plug size={14} />}
      title={`Plugins (${plugins.length})`}
      subtitle="Plugins installed in the CLI. Manage them with /plugin in the terminal."
      onClose={onClose}
    >
      <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-0.5 custom-scrollbar">
        {plugins.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
            <Plug size={32} className="opacity-50" />
            <span className="text-sm">No plugins installed.</span>
          </div>
        ) : (
          plugins.map((p: PluginItem, idx: number) => {
            const parts = PARTS.filter((k) => (p[k] || 0) > 0).map((k) => `${p[k]} ${k}`);
            return (
              <div key={p.id || idx} className="modal-row">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-text flex items-center gap-2">
                    {p.enabled
                      ? <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                      : <AlertCircle size={13} className="text-text-muted shrink-0" />}
                    <span className="font-mono">{p.name || p.id}</span>
                    {p.version && <span className="text-[10px] text-text-muted font-normal">v{p.version}</span>}
                  </div>
                  <div className="text-[11px] text-text-muted font-mono break-all mt-1">
                    {[p.marketplace, ...parts].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono border uppercase shrink-0 ml-2 ${
                  p.enabled
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : "bg-surface-3 text-text-muted border-border-subtle"
                }`}>
                  {p.enabled ? "enabled" : "disabled"}
                </span>
              </div>
            );
          })
        )}
      </div>
    </ModalShell>
  );
});
