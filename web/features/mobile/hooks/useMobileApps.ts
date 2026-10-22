"use client";

import { useCallback, useEffect, useState, RefObject } from "react";
import { uploadFiles } from "@/features/fileExplorer/lib/fileTransfer";
import { emitAck } from "./useMobileDevices";

export interface MobileApp {
  packageName: string;
  name?: string;
  icon?: string;
  isSystem?: boolean;
  [key: string]: any;
}

export interface UseMobileAppsParams {
  busRef: RefObject<any>;
  protocolRef?: RefObject<any>;
  serial: string | null;
  enabled?: boolean;
}

export function useMobileApps({ busRef, protocolRef, serial, enabled }: UseMobileAppsParams) {
  const [apps, setApps] = useState<MobileApp[]>([]);
  const [foreground, setForeground] = useState<{ packageName?: string; [key: string]: any } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!serial || !enabled) return;
    const res = await emitAck(busRef?.current, "mobile:apps", { serial });
    if (!res?.success) return;
    setApps(res.apps || []);
    setForeground(res.foreground || null);
  }, [busRef, serial, enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const act = useCallback(async (event: string, packageName: string, after?: boolean): Promise<boolean> => {
    setBusy(packageName);
    setError(null);
    const res = await emitAck(busRef?.current, event, { serial, packageName });
    setBusy(null);
    if (!res?.success) { setError(res?.error || "Failed"); return false; }
    if (after) await refresh();
    return true;
  }, [busRef, serial, refresh]);

  const launch = useCallback((pkg: string) => act("mobile:launch", pkg), [act]);
  const stopApp = useCallback((pkg: string) => act("mobile:stopApp", pkg), [act]);
  const clearData = useCallback((pkg: string) => act("mobile:clearApp", pkg), [act]);
  const uninstall = useCallback((pkg: string) => act("mobile:uninstall", pkg, true), [act]);

  const install = useCallback(async (file: File): Promise<string | null> => {
    if (!file || !serial) return null;
    setBusy("install");
    setError(null);
    setProgress(0);
    try {
      const stage = await emitAck(busRef?.current, "mobile:apkStage", { name: file.name, size: file.size });
      if (!stage?.success) throw new Error(stage?.error || "Cannot stage APK");

      let uploadError: any = null;
      await uploadFiles({
        bus: busRef?.current,
        protocolRef: protocolRef as any,
        targetDir: stage.targetDir,
        items: [{ file, relativePath: stage.fileName } as any],
        callbacks: {
          onProgress: (_f: any, ratio: number) => setProgress(ratio),
          onError: (_f: any, e: any) => { uploadError = e; }
        }
      });
      if (uploadError) throw uploadError;

      const res = await emitAck(busRef?.current, "mobile:install", {
        serial,
        fileName: stage.fileName,
        launch: true
      });
      if (!res?.success) throw new Error(res?.error || "Install failed");
      await refresh();
      return res.packageName;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
      setProgress(0);
    }
  }, [busRef, protocolRef, serial, refresh]);

  const openLink = useCallback(async (url: string): Promise<boolean> => {
    setError(null);
    const res = await emitAck(busRef?.current, "mobile:openLink", { serial, url });
    if (!res?.success) setError(res?.error || "Could not open link");
    return !!res?.success;
  }, [busRef, serial]);

  return { apps, foreground, busy, progress, error, setError, refresh, install, launch, stopApp, clearData, uninstall, openLink };
}
