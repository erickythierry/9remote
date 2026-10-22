"use client";

import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import { DEFAULT_PRESET, streamOptionsFor } from "../constants/mobileConfig";
import { emitAck, MobileDevice } from "./useMobileDevices";
import { useTerminalStore } from "@/shared/stores/terminalStore";

export interface UseMobileSessionParams {
  busRef: RefObject<any>;
  connected: boolean;
  devices: MobileDevice[];
  startAvd: (avdName: string) => Promise<string | null>;
  stopAvd?: (serial: string) => Promise<boolean>;
  stopping?: Set<string>;
}

export function useMobileSession({ busRef, connected, devices, startAvd, stopAvd, stopping }: UseMobileSessionParams) {
  const session = useTerminalStore((s) => s.mobileSession);
  const setSession = useTerminalStore((s) => s.setMobileSession);
  const serial = (session?.serial ?? null) as string | null;
  const meta = (session?.meta ?? null) as any;
  const [starting, setStarting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef<boolean>(false);
  const cancelledRef = useRef<boolean>(false);
  const autoTriedRef = useRef<Set<string>>(new Set());

  useEffect(() => { if (meta) startedRef.current = true; }, [meta]);

  const stop = useCallback(() => {
    busRef?.current?.emit("mobile:stop");
    startedRef.current = false;
    setSession(null);
  }, [busRef, setSession]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  const startStream = useCallback(async (targetSerial: string) => {
    const cssEdge = typeof window !== "undefined" ? Math.max(window.innerWidth, window.innerHeight) : 900;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    const res = await emitAck(busRef?.current, "mobile:start", {
      serial: targetSerial,
      options: streamOptionsFor(DEFAULT_PRESET, cssEdge, dpr)
    });
    if (!res?.success) throw new Error(res?.error || "Failed to start");
    startedRef.current = true;
    setSession({ serial: targetSerial, meta: res.meta });
    return res.meta;
  }, [busRef, setSession]);

  const open = useCallback(async (device: MobileDevice) => {
    if (!device) return;
    cancelledRef.current = false;
    setStarting(true);
    setError(null);
    autoTriedRef.current.add(device.id);
    try {
      const target = device.serial || (device.avdName ? await startAvd(device.avdName) : null);
      if (cancelledRef.current) { if (target) stopAvd?.(target); return; }
      if (!target) throw new Error("Device did not start");
      await startStream(target);
      if (cancelledRef.current) { stop(); if (target) stopAvd?.(target); }
    } catch (e: any) {
      if (!cancelledRef.current) setError(e.message);
    } finally {
      setStarting(false);
    }
  }, [startAvd, startStream, stopAvd, stop]);

  useEffect(() => {
    if (meta || starting || serial) return;
    const live = devices.filter((d) => d.state === "running");
    if (live.length !== 1 || devices.length !== 1) return;
    const only = live[0];
    if (autoTriedRef.current.has(only.id)) return;
    if (only.serial && stopping?.has(only.serial)) return;
    const id = setTimeout(() => open(only), 0);
    return () => clearTimeout(id);
  }, [devices, meta, starting, serial, open, stopping]);

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;
    const onResized = ({ meta: next }: { meta?: any }) => {
      if (!next) return;
      setSession((prev: any) => (prev ? { ...prev, meta: next } : prev));
    };
    bus.on("mobile:resized", onResized);
    return () => bus.off("mobile:resized", onResized);
  }, [busRef, connected, setSession]);

  useEffect(() => {
    if (!connected && startedRef.current) {
      startedRef.current = false;
      setSession(null);
    }
  }, [connected, setSession]);

  return { serial, meta, starting, error, setError, open, stop, cancel };
}
