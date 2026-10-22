"use client";

import { useCallback, useEffect, useRef, useState, ReactNode, RefObject } from "react";
import { ChevronLeft, Smartphone, Loader2, Triangle, Circle, Square, Lock, PowerOff, Package, FileText, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useMobileDevices } from "../hooks/useMobileDevices";
import { useMobileSession } from "../hooks/useMobileSession";
import { useMobileStream, DECODER_SUPPORTED } from "../hooks/useMobileStream";
import { useMobileInput } from "../hooks/useMobileInput";
import { useMobileApps } from "../hooks/useMobileApps";
import { useMobileLogcat } from "../hooks/useMobileLogcat";
import DevicePicker from "./DevicePicker";
import AddDeviceModal from "./AddDeviceModal";
import AppPanel from "./AppPanel";
import LogcatPanel from "./LogcatPanel";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

export interface MobileMirrorProps {
  onClose?: () => void;
  busRef: RefObject<any>;
  protocolRef?: RefObject<any>;
  connected: boolean;
  variant?: "fullscreen" | "panel";
}

interface RailButtonProps {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}

function RailButton({ icon, label, onClick, active = false }: RailButtonProps) {
  return (
    <button
      onClick={() => { vibrate(); onClick?.(); }}
      className={`p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 ${active ? "text-brand-500 bg-surface-2" : "text-text hover:bg-surface-2"
        }`}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {icon}
    </button>
  );
}

export default function MobileMirror({ onClose, busRef, protocolRef, connected, variant = "fullscreen" }: MobileMirrorProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [overlay, setOverlay] = useState<"apps" | "logs" | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState<boolean>(false);
  const [showAdd, setShowAdd] = useState<boolean>(false);

  const deviceApi = useMobileDevices({ busRef, connected });
  const {
    devices, canManage, booting, refresh, startAvd, stopAvd, stopping, lowPower, setLowPower,
    sdkJob, presets, refreshPresets, provision, cancelSetup, deleteAvd, wipeAvd
  } = deviceApi;

  const session = useMobileSession({ busRef, connected, devices, startAvd, stopAvd, stopping });
  const { serial, meta, starting, error: sessionError, open, stop, cancel } = session;

  const { status, fps } = useMobileStream({ busRef, connected, canvasRef, meta });
  const input = useMobileInput({ busRef, canvasRef });
  const apps = useMobileApps({ busRef, protocolRef, serial, enabled: !!meta });
  const logcat = useMobileLogcat({
    busRef, serial,
    active: !!meta && overlay === "logs",
    foregroundPackage: apps.foreground?.packageName
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta) return;
    canvas.width = meta.width;
    canvas.height = meta.height;
  }, [meta]);

  const isPanel = variant === "panel";
  const currentDevice = devices.find((d) => d.serial === serial) || null;

  const shutdownDevice = useCallback(async () => {
    setConfirmShutdown(false);
    const target = serial;
    stop();
    if (target) await stopAvd(target);
  }, [serial, stop, stopAvd]);

  const handleStop = useCallback(async (device: any) => {
    if (device.serial === serial) stop();
    await stopAvd(device.serial);
  }, [serial, stop, stopAvd]);

  const handleClose = useCallback(() => {
    if (!isPanel) stop();
    onClose?.();
  }, [isPanel, stop, onClose]);

  const phaseLabel = (phase: string) => t(`mobile.phase${phase.charAt(0).toUpperCase()}${phase.slice(1)}`);

  const retry = useCallback(() => {
    const dev = devices.find((d) => d.serial === serial);
    if (dev) open(dev);
  }, [devices, serial, open]);

  if (!meta) {
    return (
      <div className="absolute inset-0 flex flex-col bg-bg">
        {!isPanel && (
          <header className="flex items-center gap-2 px-2 py-1.5 border-b border-border flex-shrink-0">
            <button
              onClick={() => { vibrate(); handleClose(); }}
              className="p-1.5 text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94]"
              aria-label={t("common.back")}
            >
              <ChevronLeft size={18} />
            </button>
            <Smartphone size={16} className="text-brand-500 flex-shrink-0" />
            <span className="text-sm text-text truncate">{t("mobile.title")}</span>
          </header>
        )}
        <div className="flex-1 overflow-y-auto modal-scrollable flex items-center justify-center">
          {starting || booting ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <Loader2 size={22} className="text-brand-500 animate-spin" />
              <p className="text-text text-sm">{booting ? phaseLabel(booting.phase) : t("mobile.starting")}</p>
              {booting && <p className="text-text-muted text-xs">{booting.avdName}</p>}
              <button
                onClick={() => { vibrate(); cancel(); }}
                className="px-3 py-1.5 text-xs text-text-muted bg-surface hover:bg-surface-2 rounded-brand transition-colors"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : !DECODER_SUPPORTED ? (
            <p className="text-text-muted text-sm max-w-xs text-center p-6">{t("mobile.unsupportedBrowser")}</p>
          ) : (
            <>
            <DevicePicker
              devices={devices}
              canManage={canManage}
              booting={booting}
              stopping={stopping}
              loading={!deviceApi.loaded}
              error={sessionError || deviceApi.error}
              onOpen={open}
              onStop={handleStop}
              onRefresh={refresh}
              lowPower={lowPower}
              onLowPowerChange={setLowPower}
              onAddDevice={() => { refreshPresets(); setShowAdd(true); }}
              onDeleteAvd={deleteAvd}
              onWipeAvd={wipeAvd}
              sdkJob={sdkJob}
              onShowSetup={() => setShowAdd(true)}
            />

            <AddDeviceModal
              isOpen={showAdd}
              onClose={() => setShowAdd(false)}
              presets={presets}
              sdkJob={sdkJob}
              onProvision={provision}
              onCancel={cancelSetup}
            />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex bg-bg">
      <ConfirmDialog
        isOpen={confirmShutdown}
        onClose={() => setConfirmShutdown(false)}
        onConfirm={shutdownDevice}
        title={t("mobile.shutdownTitle")}
        message={t("mobile.shutdownMessage", { name: meta.deviceName })}
        confirmText={t("mobile.shutdownConfirm")}
      />
      <div className="flex-1 min-w-0 relative flex items-center justify-center bg-black">
        <canvas
          ref={canvasRef}
          onPointerDown={input.onPointerDown}
          onPointerMove={input.onPointerMove}
          onPointerUp={input.onPointerUp}
          onPointerCancel={input.onPointerCancel}
          onWheel={input.onWheel}
          className="max-w-full max-h-full object-contain touch-none"
        />
        {(status === "connecting" || status === "idle") && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 size={22} className="text-brand-500 animate-spin" />
          </div>
        )}
        {(status === "ended" || status === "decoder failed") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center bg-black/40">
            <p className="text-text text-sm">
              {t(status === "ended" ? "mobile.streamEnded" : "mobile.streamFailed")}
            </p>
            {currentDevice ? (
              <button
                onClick={() => { vibrate(); retry(); }}
                className="px-3 py-1.5 text-xs text-brand-500 bg-surface hover:bg-surface-2 rounded-brand transition-colors"
              >
                {t("mobile.retry")}
              </button>
            ) : (
              <p className="text-text-muted text-xs">{t("mobile.streamGone")}</p>
            )}
          </div>
        )}
        {status === "streaming" && fps > 0 && (
          <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/50 text-[10px] text-white/80 pointer-events-none">
            {fps} fps
          </span>
        )}

        {overlay && (
          <button
            onClick={() => { vibrate(); setOverlay(null); }}
            className="absolute inset-x-0 top-0 h-16 z-10 cursor-pointer"
            aria-label={t("mobile.backToScreen")}
          />
        )}

        {overlay && (
          <div
            key={overlay}
            className="absolute inset-x-0 bottom-0 top-16 bg-bg border-t border-border flex flex-col shadow-[0_-8px_24px_rgba(0,0,0,0.35)] sheet-rise"
          >
            <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border flex-shrink-0">
              {overlay === "apps"
                ? <Package size={14} className="text-brand-500 flex-shrink-0" />
                : <FileText size={14} className="text-brand-500 flex-shrink-0" />}
              <span className="text-xs text-text flex-1 truncate">
                {t(overlay === "apps" ? "mobile.tabApps" : "mobile.tabLogs")}
              </span>
              <button
                onClick={() => { vibrate(); setOverlay(null); }}
                className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
                title={t("mobile.backToScreen")}
                aria-label={t("mobile.backToScreen")}
              >
                <X size={14} />
              </button>
            </div>
            {overlay === "apps"
              ? (
                <AppPanel
                  apps={apps.apps}
                  foreground={apps.foreground}
                  busy={apps.busy}
                  progress={apps.progress}
                  error={apps.error}
                  onInstall={apps.install}
                  onLaunch={apps.launch}
                  onStopApp={apps.stopApp}
                  onClearData={apps.clearData}
                  onUninstall={apps.uninstall}
                  onOpenLink={apps.openLink}
                  onRefresh={apps.refresh}
                />
              )
              : <LogcatPanel logcat={logcat} apps={apps.apps} />}
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-0.5 px-1 py-1.5 pb-safe border-l border-border flex-shrink-0 overflow-y-auto modal-scrollable">
        <RailButton icon={<Triangle size={15} className="-rotate-90" />} label={t("mobile.back")} onClick={() => input.sendKey("back")} />
        <RailButton icon={<Circle size={15} />} label={t("mobile.home")} onClick={() => input.sendKey("home")} />
        <RailButton icon={<Square size={14} />} label={t("mobile.recents")} onClick={() => input.sendKey("recents")} />

        <div className="w-5 h-px bg-border my-1" />

        <RailButton icon={<Lock size={15} />} label={t("mobile.power")} onClick={() => input.sendKey("power")} />

        <div className="w-5 h-px bg-border my-1" />

        <RailButton
          icon={<Package size={15} />}
          label={t("mobile.tabApps")}
          onClick={() => setOverlay(overlay === "apps" ? null : "apps")}
          active={overlay === "apps"}
        />
        <RailButton
          icon={<FileText size={15} />}
          label={t("mobile.tabLogs")}
          onClick={() => setOverlay(overlay === "logs" ? null : "logs")}
          active={overlay === "logs"}
        />

        <div className="flex-1 min-h-2" />
        <RailButton icon={<Smartphone size={15} />} label={t("mobile.switchDevice")} onClick={stop} />
        {currentDevice?.canStop && (
          <button
            onClick={() => { vibrate(); setConfirmShutdown(true); }}
            className="p-2 rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 text-red-400 hover:bg-red-500/15"
            title={t("mobile.shutdownDevice")}
            aria-label={t("mobile.shutdownDevice")}
          >
            <PowerOff size={15} />
          </button>
        )}
        {!isPanel && <RailButton icon={<X size={15} />} label={t("common.close")} onClick={handleClose} />}
      </div>
    </div>
  );
}
