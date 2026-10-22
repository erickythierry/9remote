"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Smartphone, Monitor, Check, Loader2, Download } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { SdkJob, ProvisionPreset } from "@/features/mobile/hooks/useMobileDevices";

function stepLabelKey(job: any): string {
  if (job?.step) return `mobile.provisionStep_${job.step}`;
  const c = job?.component || "";
  if (c.startsWith("system-images;")) return "mobile.provisionStep_image";
  return `mobile.provisionStep_${c}`;
}

function fmtBytes(n: any): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export interface AddDeviceModalProps {
  isOpen: boolean;
  onClose?: () => void;
  presets?: ProvisionPreset[];
  sdkJob?: SdkJob | null;
  onProvision?: (presetId: string) => Promise<boolean>;
  onCancel?: () => void;
}

export default function AddDeviceModal({ isOpen, onClose, presets, sdkJob, onProvision, onCancel }: AddDeviceModalProps) {
  const { t } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastPreset, setLastPreset] = useState<any>(null);

  const job = sdkJob && sdkJob.phase !== "done" && sdkJob.phase !== "error" ? sdkJob : null;
  const jobError = sdkJob?.phase === "error" && (sdkJob as any).error !== "cancelled" ? (sdkJob as any).error : null;

  const close = useCallback(() => { setBusyId(null); setLastPreset(null); onClose?.(); }, [onClose]);

  useEffect(() => {
    if (!isOpen || job) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, job, close]);

  if (!isOpen || typeof document === "undefined") return null;

  const pick = async (preset: any) => {
    if (busyId || job) return;
    vibrate();
    setBusyId(preset.id);
    setLastPreset(preset);
    const ok = await onProvision?.(preset.id);
    setBusyId(null);
    if (ok) close();
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px] fade-in" onClick={close}>
      <div
        className="card-elev w-full max-w-sm max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
          <Smartphone size={15} className="text-brand-500 dark:text-white flex-shrink-0" />
          <span className="text-sm text-text flex-1">{t("mobile.addDevice")}</span>
          <button onClick={() => { vibrate(); close(); }} className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand">
            <X size={15} />
          </button>
        </div>

        <div className="p-3 space-y-1.5 overflow-y-auto modal-scrollable">
          {(job || jobError) ? (
            <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
              {jobError ? (
                <>
                  <p className="text-red-400 text-xs">{jobError}</p>
                  <div className="flex items-center gap-2">
                    {lastPreset && (
                      <button onClick={() => pick(lastPreset)} className="px-3 py-1.5 text-xs text-brand-500 bg-brand-500/10 dark:text-white dark:bg-white/10 rounded-brand">
                        {t("common.retry")}
                      </button>
                    )}
                    <button onClick={() => { vibrate(); close(); }} className="px-3 py-1.5 text-xs text-text-muted hover:text-text rounded-brand">
                      {t("common.close")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <Loader2 size={20} className="text-brand-500 animate-spin" />
                  <p className="text-text text-sm">{t(stepLabelKey(job))}</p>
                  <p className="text-text-muted text-xs">
                    {(job as any).kind === "image" || (job as any).step === "image"
                      ? `${(job as any).percent ?? 0}%`
                      : `${fmtBytes(job?.received)}${job?.total ? ` / ${fmtBytes(job.total)}` : ""}${(job as any)?.bytesPerSec ? ` · ${fmtBytes((job as any).bytesPerSec)}/s` : ""}`}
                  </p>
                  <button
                    onClick={() => { vibrate(); onCancel?.(); }}
                    className="px-3 py-1 text-[11px] text-text-muted hover:text-red-400 rounded-brand transition-colors"
                  >
                    {t("common.cancel")}
                  </button>
                </>
              )}
            </div>
          ) : (
            (presets || []).map((p: any) => (
              <button
                key={p.id}
                onClick={() => pick(p)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 bg-surface rounded-brand-lg hover:bg-surface-2 transition-colors text-left"
              >
                {p.id === "tablet" ? <Monitor size={16} className="text-brand-500 dark:text-white flex-shrink-0" /> : <Smartphone size={16} className="text-brand-500 dark:text-white flex-shrink-0" />}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm text-text truncate">{p.label}</span>
                  <span className="text-[10px] text-text-muted">
                    {p.ready ? t("mobile.presetReady") : t("mobile.presetDownload")}
                  </span>
                </div>
                {p.ready ? (
                  <Check size={13} className="text-green-500 flex-shrink-0" />
                ) : (
                  <Download size={13} className="text-text-muted flex-shrink-0" />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
