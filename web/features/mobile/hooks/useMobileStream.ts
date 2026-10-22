"use client";

import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import { decodeMobileFrame } from "../lib/mobileFrame";
import { buildCodecString, scanAccessUnit } from "../lib/h264";
import {
  FRAME_QUEUE_SIZE, DECODE_QUEUE_LIMIT, REASSEMBLY_WINDOW, KEYFRAME_REQUEST_INTERVAL_MS
} from "../constants/mobileConfig";

export const DECODER_SUPPORTED =
  typeof window !== "undefined" && "VideoDecoder" in window && "EncodedVideoChunk" in window;

export interface StreamMeta {
  width: number;
  height: number;
  [key: string]: any;
}

export interface UseMobileStreamParams {
  busRef: RefObject<any>;
  connected: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  meta: StreamMeta | null;
}

interface StreamState {
  decoder: any;
  pending: Map<number, {
    chunks: (Uint8Array | undefined)[];
    received: number;
    count: number;
    isKey: boolean;
    isConfig: boolean;
    ptsMs: number;
  }>;
  queue: any[];
  raf: number;
  sawKey: boolean;
  dropping: boolean;
  lastKeyframeReq: number;
  ackedSeq: number;
  config: Uint8Array | null;
  frameCount: number;
  fpsAt: number;
}

export function useMobileStream({ busRef, connected, canvasRef, meta }: UseMobileStreamParams) {
  const [status, setStatus] = useState<string>("idle");
  const [fps, setFps] = useState<number>(0);
  const stateRef = useRef<StreamState | null>(null);

  const requestKeyframe = useCallback(() => {
    const st = stateRef.current;
    const now = performance.now();
    if (st && now - st.lastKeyframeReq < KEYFRAME_REQUEST_INTERVAL_MS) return;
    if (st) st.lastKeyframeReq = now;
    busRef?.current?.emit("mobile:keyframe");
  }, [busRef]);

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected || !meta || !DECODER_SUPPORTED) return;

    const st: StreamState = {
      decoder: null,
      pending: new Map(),
      queue: [],
      raf: 0,
      sawKey: false,
      dropping: false,
      lastKeyframeReq: 0,
      ackedSeq: -1,
      config: null,
      frameCount: 0,
      fpsAt: performance.now()
    };
    stateRef.current = st;
    setStatus("connecting");

    const closeDecoder = () => {
      if (st.decoder && st.decoder.state !== "closed") {
        try { st.decoder.close(); } catch { /* already closing */ }
      }
      st.decoder = null;
      st.sawKey = false;
      for (const f of st.queue) f.close();
      st.queue = [];
    };

    const paint = () => {
      st.raf = 0;
      const canvas = canvasRef.current;
      while (st.queue.length > 1) st.queue.shift()?.close();
      const frame = st.queue.shift();
      if (!frame) return;
      const ctx = canvas?.getContext("2d", { alpha: false, desynchronized: true } as any) as CanvasRenderingContext2D | null;
      if (ctx) ctx.drawImage(frame, 0, 0, canvas!.width, canvas!.height);
      frame.close();

      st.frameCount++;
      const now = performance.now();
      if (now - st.fpsAt >= 1000) {
        setFps(Math.round((st.frameCount * 1000) / (now - st.fpsAt)));
        st.frameCount = 0;
        st.fpsAt = now;
      }
      if (st.queue.length) st.raf = requestAnimationFrame(paint);
    };

    const skipToKeyframe = () => {
      st.dropping = true;
      requestKeyframe();
    };

    const recover = () => {
      closeDecoder();
      st.dropping = true;
      requestKeyframe();
    };

    const ensureDecoder = (spsBytes: Uint8Array): boolean => {
      if (st.decoder?.state === "configured") return true;
      closeDecoder();
      const VideoDecoderClass = (window as any).VideoDecoder;
      const decoder = new VideoDecoderClass({
        output: (frame: any) => {
          if (st.decoder !== decoder) { frame.close(); return; }
          if (st.queue.length >= FRAME_QUEUE_SIZE) st.queue.shift()?.close();
          st.queue.push(frame);
          if (!st.raf) st.raf = requestAnimationFrame(paint);
        },
        error: () => { if (st.decoder === decoder) recover(); }
      });
      try {
        decoder.configure({ codec: buildCodecString(spsBytes), optimizeForLatency: true });
        st.decoder = decoder;
        return true;
      } catch {
        try { decoder.close(); } catch { /* never configured */ }
        setStatus("decoder failed");
        requestKeyframe();
        return false;
      }
    };

    const feed = ({ data: au, isKey, isConfig, ptsMs }: { data: Uint8Array; isKey: boolean; isConfig: boolean; ptsMs: number }) => {
      let data = au;
      if (isConfig) {
        st.config = data;
        const sps = scanAccessUnit(data).spsBytes;
        if (sps) ensureDecoder(sps);
        return;
      }
      if (isKey && st.decoder?.state !== "configured") {
        if (!st.config) { requestKeyframe(); return; }
        const sps = scanAccessUnit(st.config).spsBytes;
        if (!sps || !ensureDecoder(sps)) return;
      }
      if (isKey && st.config) {
        const merged = new Uint8Array(st.config.byteLength + data.byteLength);
        merged.set(st.config, 0);
        merged.set(data, st.config.byteLength);
        data = merged;
      }

      if (st.dropping) {
        if (!isKey || st.decoder?.state !== "configured") { requestKeyframe(); return; }
        st.dropping = false;
      }
      if (st.decoder?.state !== "configured") { if (!isKey) requestKeyframe(); return; }
      if (st.decoder.decodeQueueSize > DECODE_QUEUE_LIMIT) { skipToKeyframe(); return; }
      if (!st.sawKey) {
        if (!isKey) { requestKeyframe(); return; }
        st.sawKey = true;
        setStatus("streaming");
      }
      try {
        const EncodedVideoChunkClass = (window as any).EncodedVideoChunk;
        st.decoder.decode(new EncodedVideoChunkClass({
          type: isKey ? "key" : "delta",
          timestamp: ptsMs * 1000,
          data
        }));
      } catch {
        recover();
      }
    };

    const ack = (seq: number) => {
      if (seq <= st.ackedSeq) return;
      st.ackedSeq = seq;
      bus.emit("mobile:ack", { seq });
    };

    const onBinary = (buffer: ArrayBuffer | Uint8Array) => {
      const chunk = decodeMobileFrame(buffer);
      if (!chunk) return;

      if (chunk.chunkCount === 1) {
        ack(chunk.frameSeq);
        feed({ data: chunk.payload, isKey: chunk.isKey, isConfig: chunk.isConfig, ptsMs: chunk.ptsMs });
        return;
      }
      let entry = st.pending.get(chunk.frameSeq);
      if (!entry) {
        entry = { chunks: new Array(chunk.chunkCount), received: 0, count: chunk.chunkCount, isKey: chunk.isKey, isConfig: chunk.isConfig, ptsMs: chunk.ptsMs };
        st.pending.set(chunk.frameSeq, entry);
        for (const seq of st.pending.keys()) {
          if (chunk.frameSeq - seq > REASSEMBLY_WINDOW) st.pending.delete(seq);
        }
      }
      if (entry.chunks[chunk.chunkIdx]) return;
      entry.chunks[chunk.chunkIdx] = chunk.payload;
      entry.received++;
      if (entry.received !== entry.count) return;

      st.pending.delete(chunk.frameSeq);
      ack(chunk.frameSeq);
      const size = (entry.chunks as Uint8Array[]).reduce((n, c) => n + c.byteLength, 0);
      const data = new Uint8Array(size);
      let at = 0;
      for (const c of (entry.chunks as Uint8Array[])) { data.set(c, at); at += c.byteLength; }
      feed({ data, isKey: entry.isKey, isConfig: entry.isConfig, ptsMs: entry.ptsMs });
    };

    const onEnded = () => setStatus("ended");

    bus.on("mobile-bin", onBinary);
    bus.on("file-bin", onBinary);
    bus.on("mobile:ended", onEnded);
    requestKeyframe();

    return () => {
      bus.off("mobile-bin", onBinary);
      bus.off("file-bin", onBinary);
      bus.off("mobile:ended", onEnded);
      if (st.raf) cancelAnimationFrame(st.raf);
      closeDecoder();
      st.pending.clear();
      stateRef.current = null;
    };
  }, [busRef, connected, canvasRef, meta, requestKeyframe]);

  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected || !meta) return;
    const onVisibility = () => {
      const visible = !document.hidden;
      bus.emit("mobile:visible", { visible });
      if (visible) requestKeyframe();
    };
    document.addEventListener("visibilitychange", onVisibility);
    bus.emit("mobile:visible", { visible: !document.hidden });
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [busRef, connected, meta, requestKeyframe]);

  return { status: DECODER_SUPPORTED ? status : "unsupported", fps, requestKeyframe };
}
