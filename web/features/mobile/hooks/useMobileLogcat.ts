"use client";

import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import { LOG_BUFFER_LINES, DEFAULT_LOG_LEVEL } from "../constants/mobileConfig";
import { emitAck } from "./useMobileDevices";

export interface LogcatLine {
  seq: number;
  time: string;
  level: string;
  tag: string;
  message: string;
}

const LINE_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*):\s?(.*)$/;

function parse(line: string, seq: number): LogcatLine {
  const m = LINE_RE.exec(line);
  if (!m) return { seq, time: "", level: "V", tag: "", message: line };
  return { seq, time: m[1].slice(6), level: m[2], tag: m[3].trim(), message: m[4] };
}

export interface UseMobileLogcatParams {
  busRef: RefObject<any>;
  serial?: string | null;
  active?: boolean;
  foregroundPackage?: string | null;
}

export function useMobileLogcat({ busRef, serial, active, foregroundPackage }: UseMobileLogcatParams) {
  const [lines, setLines] = useState<LogcatLine[]>([]);
  const [minLevel, setMinLevel] = useState<string>(DEFAULT_LOG_LEVEL);
  const [search, setSearch] = useState<string>("");
  const [packageName, setPackageName] = useState<string | null>(null);
  const pickedRef = useRef<boolean>(false);

  useEffect(() => {
    if (pickedRef.current || !foregroundPackage) return;
    setPackageName(foregroundPackage);
  }, [foregroundPackage]);

  const choosePackage = useCallback((pkg: string | null) => {
    pickedRef.current = true;
    setPackageName(pkg);
  }, []);

  const [paused, setPaused] = useState<boolean>(false);
  const [includeNoise, setIncludeNoise] = useState<boolean>(false);
  const seqRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const clear = useCallback(() => setLines([]), []);

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !serial || !active) return;

    setLines([]);

    const onLines = ({ lines: incoming }: { lines?: string[] }) => {
      if (pausedRef.current || !Array.isArray(incoming)) return;
      setLines((prev) => {
        const next = prev.concat(incoming.map((l) => parse(l, seqRef.current++)));
        return next.length > LOG_BUFFER_LINES ? next.slice(next.length - LOG_BUFFER_LINES) : next;
      });
    };
    bus.on("mobile:logcat", onLines);
    emitAck(bus, "mobile:logcatStart", {
      serial, minLevel, search, includeNoise,
      ...(pickedRef.current || packageName ? { packageName } : {})
    });

    return () => {
      bus.off("mobile:logcat", onLines);
      bus.emit("mobile:logcatStop");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busRef, serial, active]);

  useEffect(() => {
    if (!active || !serial) return;
    const id = setTimeout(() => {
      busRef?.current?.emit("mobile:logcatFilter", { minLevel, search, packageName, includeNoise });
    }, 200);
    return () => clearTimeout(id);
  }, [minLevel, search, packageName, includeNoise, active, serial, busRef]);

  return {
    lines, clear,
    minLevel, setMinLevel,
    search, setSearch,
    packageName, setPackageName: choosePackage,
    paused, setPaused,
    includeNoise, setIncludeNoise
  };
}
