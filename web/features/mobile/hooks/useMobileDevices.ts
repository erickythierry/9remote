"use client";

import { useCallback, useEffect, useState, RefObject } from "react";
import { DEVICE_REFRESH_MS } from "../constants/mobileConfig";
import { useTerminalStore } from "@/shared/stores/terminalStore";

export interface MobileDevice {
  id: string;
  serial?: string;
  avdName?: string;
  name?: string;
  model?: string;
  state?: "running" | "stopped" | "booting" | "offline" | string;
  type?: "device" | "emulator" | string;
  [key: string]: any;
}

export interface SdkJob {
  component?: string;
  step?: string;
  phase?: string;
  received?: number;
  total?: number;
  [key: string]: any;
}

export interface ProvisionPreset {
  id: string;
  name?: string;
  [key: string]: any;
}

export interface BootingState {
  avdName: string;
  phase: string;
}

export function emitAck(bus: any, event: string, payload: any): Promise<any> {
  return new Promise((resolve) => {
    if (!bus) { resolve({ success: false, error: "Not connected" }); return; }
    bus.emit(event, payload, (res: any) => resolve(res || { success: false, error: "No response" }));
  });
}

export interface UseMobileDevicesParams {
  busRef: RefObject<any>;
  connected: boolean;
}

export function useMobileDevices({ busRef, connected }: UseMobileDevicesParams) {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [canManage, setCanManage] = useState<boolean>(false);
  const [booting, setBooting] = useState<BootingState | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [sdkJob, setSdkJob] = useState<SdkJob | null>(null);
  const lowPower = useTerminalStore((s) => s.mobileLowPower);
  const setLowPower = useTerminalStore((s) => s.setMobileLowPower);

  const refresh = useCallback(async (): Promise<MobileDevice[]> => {
    const bus = busRef?.current;
    if (!bus || !connected) return [];
    const res = await emitAck(bus, "mobile:list", {});
    if (!res?.success) return [];
    setLoaded(true);
    setCanManage(!!res.canManageEmulators);
    if (res.env) {
      setSdkJob(res.env.job || null);
    }
    const list = Array.isArray(res.devices) ? res.devices : [];
    setDevices(list);
    setStopping((prev) => {
      const live = new Set(list.map((d: MobileDevice) => d.serial).filter(Boolean) as string[]);
      for (const serial of prev) if (live.has(serial)) return prev;
      const next = new Set([...prev].filter((serial) => live.has(serial)));
      return next.size === prev.size ? prev : next;
    });
    return list;
  }, [busRef, connected]);

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;
    const onProgress = ({ avdName, phase }: BootingState) => setBooting({ avdName, phase });
    bus.on("mobile:avdProgress", onProgress);
    const onSdkProgress = (job: SdkJob) => {
      setSdkJob(job);
      if (job.phase === "done" || job.phase === "error") refresh();
    };
    bus.on("mobile:sdkProgress", onSdkProgress);
    return () => {
      bus.off("mobile:avdProgress", onProgress);
      bus.off("mobile:sdkProgress", onSdkProgress);
    };
  }, [busRef, connected, refresh]);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const id = setInterval(refresh, DEVICE_REFRESH_MS);
    return () => clearInterval(id);
  }, [connected, refresh]);

  const startAvd = useCallback(async (avdName: string): Promise<string | null> => {
    setError(null);
    setBooting({ avdName, phase: "launching" });
    const res = await emitAck(busRef?.current, "mobile:avdStart", { avdName, lowPower });
    setBooting(null);
    await refresh();
    if (!res?.success) { setError(res?.error || "Could not start"); return null; }
    return res.serial;
  }, [busRef, refresh, lowPower]);

  const stopAvd = useCallback(async (serial: string): Promise<boolean> => {
    if (!serial) return false;
    setError(null);
    setStopping((prev) => new Set(prev).add(serial));
    const res = await emitAck(busRef?.current, "mobile:avdStop", { serial });
    await refresh();
    setStopping((prev) => { const next = new Set(prev); next.delete(serial); return next; });
    if (!res?.success) setError(res?.error || "Could not stop");
    return !!res?.success;
  }, [busRef, refresh]);

  const [presets, setPresets] = useState<ProvisionPreset[]>([]);

  const refreshPresets = useCallback(async () => {
    const res = await emitAck(busRef?.current, "mobile:provisionPresets", {});
    if (res?.success) setPresets(Array.isArray(res.presets) ? res.presets : []);
  }, [busRef]);

  const provision = useCallback(async (presetId: string): Promise<boolean> => {
    setError(null);
    const res = await emitAck(busRef?.current, "mobile:provision", { presetId });
    await Promise.all([refresh(), refreshPresets()]);
    if (!res?.success) { setError(res?.error || "Could not create device"); return false; }
    return true;
  }, [busRef, refresh, refreshPresets]);

  const cancelSetup = useCallback(async () => {
    await emitAck(busRef?.current, "mobile:sdkCancel", {});
    await refresh();
  }, [busRef, refresh]);

  const deleteAvd = useCallback(async (avdName: string): Promise<boolean> => {
    const res = await emitAck(busRef?.current, "mobile:avdDelete", { avdName });
    if (!res?.success) setError(res?.error || "Could not delete");
    await refresh();
    return !!res?.success;
  }, [busRef, refresh]);

  const wipeAvd = useCallback(async (avdName: string): Promise<boolean> => {
    const res = await emitAck(busRef?.current, "mobile:avdWipe", { avdName });
    if (!res?.success) setError(res?.error || "Could not wipe");
    await refresh();
    return !!res?.success;
  }, [busRef, refresh]);

  return {
    devices, canManage, booting, error, setError,
    refresh, startAvd, stopAvd, stopping,
    lowPower, setLowPower,
    sdkJob, presets, refreshPresets, provision, cancelSetup, deleteAvd, wipeAvd,
    loaded
  };
}
