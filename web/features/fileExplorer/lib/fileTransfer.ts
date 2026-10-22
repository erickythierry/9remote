// Client-side file transfer: windowed upload + chunked download over the FILE
// channel (RTC preferred, WS fallback handled by ProtocolManager.sendBinary).
"use client";

import { CHANNELS, FILE_TRANSFER } from "@/shared/constants/transport";
import { encodeFileFrame, decodeFileFrame } from "@/shared/transport/fileFrame";
import { emitAck } from "@/features/mobile/hooks/useMobileDevices";
import { AckTracker } from "./ackTrackerWeb";
import { ConflictResolver, type ConflictChoice } from "./conflict";

export interface TransferBus {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
}
type ProtocolRef = { current: unknown } | null | undefined;
type BinaryProtocol = { sendBinary?: (channel: string, frame: Uint8Array) => boolean };
export interface UploadItem { file: File; relativePath: string }
export interface UploadCallbacks {
  onConflict?: (file: File, relativePath: string) => Promise<ConflictChoice> | ConflictChoice;
  onProgress?: (file: File, ratio: number) => void;
  onFileDone?: (file: File, status: string) => void;
  onError?: (file: File | null, err: unknown) => void;
}
export interface DownloadMeta { size: number | null; fileName: string | null }
export interface MediaMeta {
  mime?: string; size?: number; width?: number; height?: number;
  scaled?: boolean; originalWidth?: number; originalHeight?: number;
}
type Ack = { success?: boolean; error?: string; [key: string]: any };

function planChunks(size: number, chunkSize: number) {
  if (size <= 0) return [];
  const out: Array<{ offset: number; length: number }> = [];
  let offset = 0;
  while (offset < size) {
    const length = Math.min(chunkSize, size - offset);
    out.push({ offset, length });
    offset += length;
  }
  return out;
}

/**
 * Upload a list of files into targetDir (preserving relativePath for folders).
 * ctx.bus is the carrier-agnostic transport bus; ctx.protocolRef is { current: ProtocolManager }.
 * onConflict returns one of: "skip" | "replace" | "skipAll" | "replaceAll"
 */
export async function uploadFiles({ bus, protocolRef, targetDir, items, callbacks }: {
  bus: TransferBus;
  protocolRef?: ProtocolRef;
  targetDir: string;
  items: UploadItem[];
  callbacks?: UploadCallbacks;
}) {
  const { onConflict, onProgress, onFileDone, onError } = callbacks || {};
  const resolver = new ConflictResolver();

  for (const { file, relativePath } of items) {
    try {
      const result = await uploadOne(bus, protocolRef, targetDir, file, relativePath, resolver, onConflict, onProgress);
      onFileDone?.(file, result.status);
    } catch (e) {
      onError?.(file, e);
    }
  }
}

async function uploadOne(
  bus: TransferBus,
  protocolRef: ProtocolRef,
  targetDir: string,
  file: File,
  relativePath: string,
  resolver: ConflictResolver,
  onConflict: UploadCallbacks["onConflict"],
  onProgress: UploadCallbacks["onProgress"]
) {
  const start: Ack = await emitAck(bus, "upload:start", {
    targetDir, relativePath, size: file.size, mtime: file.lastModified || 0
  });
  if (!start.success) throw new Error(start.error);
  const { uploadId, exists } = start;

  if (exists) {
    let decision = resolver.resolve(true);
    if (decision === "ask") {
      const choice = await onConflict?.(file, relativePath);
      resolver.record(choice as ConflictChoice);
      decision = resolver.resolve(true);
    }
    if (decision === "skip") {
      bus.emit("upload:cancel", { uploadId });
      return { status: "skipped" };
    }
  }

  await streamFile(bus, protocolRef, uploadId, file, onProgress);
  return { status: "done" };
}

function streamFile(bus: TransferBus, protocolRef: ProtocolRef, uploadId: number, file: File, onProgress: UploadCallbacks["onProgress"]) {
  return new Promise<void>(async (resolve, reject) => {
    const size = file.size;
    const chunkSize = FILE_TRANSFER.chunkSize;
    const windowBytes = chunkSize * FILE_TRANSFER.windowSize;

    let buf: Uint8Array;
    try { buf = new Uint8Array(await file.arrayBuffer()); }
    catch (e) { reject(e); return; }

    const chunks = planChunks(size, chunkSize);
    let i = 0, sentOffset = 0, ackedOffset = 0, done = false;

    const onAck = ({ uploadId: uid, offset }: { uploadId: number; offset: number }) => {
      if (uid !== uploadId) return;
      if (offset > ackedOffset) {
        ackedOffset = offset;
        onProgress?.(file, size ? ackedOffset / size : 1);
      }
      if (ackedOffset >= size && !done) { done = true; bus.emit("upload:end", { uploadId }); }
      else pump();
    };
    const onErr = ({ uploadId: uid, error }: { uploadId: number; error: string }) => {
      if (uid !== uploadId) return;
      cleanup();
      reject(new Error(error));
    };
    const onDoneEv = ({ uploadId: uid }: { uploadId: number }) => {
      if (uid !== uploadId) return;
      cleanup();
      resolve();
    };
    function cleanup() {
      bus.off("upload:ack", onAck);
      bus.off("upload:error", onErr);
      bus.off("upload:done", onDoneEv);
    }
    bus.on("upload:ack", onAck);
    bus.on("upload:error", onErr);
    bus.on("upload:done", onDoneEv);

    const sendFrame = (frame: Uint8Array) => {
      const pm = protocolRef?.current as BinaryProtocol | null | undefined;
      if (pm?.sendBinary) return pm.sendBinary(CHANNELS.file, frame);
      bus.emit("file-bin", frame);
      return true;
    };

    function pump() {
      while (i < chunks.length && (sentOffset - ackedOffset) < windowBytes) {
        const c = chunks[i];
        const frame = encodeFileFrame(uploadId, c.offset, buf.subarray(c.offset, c.offset + c.length));
        if (!sendFrame(frame)) break; // backpressure — retry on next ack/tick
        i++;
        sentOffset = c.offset + c.length;
      }
      if (ackedOffset >= size && !done) {
        done = true;
        bus.emit("upload:end", { uploadId });
        return;
      }
      // Still chunks to send but sendBinary refused → short backoff keeps window full.
      if (i < chunks.length && (sentOffset - ackedOffset) < windowBytes) {
        setTimeout(pump, 50);
      }
    }
    pump();
  });
}

/**
 * Download a file/folder from host → client, assembling into a Blob.
 * Folder downloads arrive as a streamed .zip (size unknown up front).
 * onSave receives a Blob + { size, fileName }; caller triggers the browser save.
 */
export function downloadFile({ bus, protocolRef: _protocolRef, filePath, onSave, onProgress, onError }: {
  bus: TransferBus;
  protocolRef?: ProtocolRef;
  filePath: string;
  onSave?: (blob: Blob, meta: DownloadMeta) => void;
  onProgress?: (ratio: number) => void;
  onError?: (err: unknown) => void;
}) {
  let downloadId: number | null = null;
  let size: number | null = null;       // null = folder zip (size unknown until stream ends)
  let fileName: string | null = null;
  let tracker: AckTracker | null = null;
  let parts: Map<number, Uint8Array> | null = null;

  const onFrame = (buffer: Uint8Array | ArrayBuffer) => {
    let frame;
    try { frame = decodeFileFrame(buffer); } catch { return; }
    if (frame.uploadId !== downloadId) return;
    parts!.set(frame.offset, frame.payload);
    if (tracker) {
      tracker.mark(frame.offset, frame.payload.byteLength);
      if (onProgress && size) onProgress(tracker.watermark / size);
    }
  };
  const finalize = () => {
    cleanup();
    const ordered = [...parts!.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    onSave?.(new Blob(ordered as BlobPart[]), { size, fileName });
  };
  const onDoneEv = ({ downloadId: uid }: { downloadId: number }) => {
    if (uid !== downloadId) return;
    // size-known: wait until all chunks in; folder zip: stream ended → ready.
    if (tracker && !tracker.isComplete()) return;
    finalize();
  };
  const onErrEv = ({ downloadId: uid, error }: { downloadId: number; error: string }) => {
    if (uid !== downloadId) return;
    cleanup();
    onError?.(new Error(error));
  };
  function cleanup() {
    bus.off("file-bin", onFrame);
    bus.off("download:done", onDoneEv);
    bus.off("download:error", onErrEv);
  }

  emitAck(bus, "download:start", { filePath }).then((res: Ack) => {
    if (!res.success) { onError?.(new Error(res.error)); return; }
    downloadId = res.downloadId;
    size = res.size;              // null for folder zip
    fileName = res.fileName;
    tracker = size != null ? new AckTracker(size) : null;
    parts = new Map();
    bus.on("file-bin", onFrame);
    bus.on("download:done", onDoneEv);
    bus.on("download:error", onErrEv);
  }).catch((e: unknown) => onError?.(e));
}

/**
 * Stream a media file for progressive playback via MediaSource Extensions.
 * Frames arrive ordered (file DC is ordered, reliable) but may land before the
 * caller's SourceBuffer is open — caller must queue onChunk until ready.
 * Images: the host streams a server-scaled JPEG and the ack carries its dims
 * (width/height + originalWidth/originalHeight/scaled) alongside mime/size.
 * Returns cancel().
 */
export function streamMedia({ bus, filePath, onMeta, onChunk, onDone, onError }: {
  bus: TransferBus;
  filePath: string;
  onMeta?: (meta: MediaMeta) => void;
  onChunk?: (chunk: Uint8Array) => void;
  onDone?: () => void;
  onError?: (err: unknown) => void;
}) {
  let streamId: number | null = null;
  const pending = new Map<number, Uint8Array>(); // offset → payload (drain in order; guards reordering)
  let nextOffset = 0;

  const drain = () => {
    while (pending.has(nextOffset)) {
      const p = pending.get(nextOffset) as Uint8Array;
      pending.delete(nextOffset);
      onChunk?.(p);
      nextOffset += p.byteLength;
    }
  };
  const onFrame = (buffer: Uint8Array | ArrayBuffer) => {
    if (streamId == null) return;
    let frame;
    try { frame = decodeFileFrame(buffer); } catch { return; }
    if (frame.uploadId !== streamId) return;
    pending.set(frame.offset, frame.payload);
    drain();
  };
  const onDoneEv = ({ downloadId }: { downloadId: number }) => {
    if (downloadId !== streamId) return;
    cleanup();
    onDone?.();
  };
  const onErrEv = ({ downloadId, error }: { downloadId: number; error: string }) => {
    if (downloadId !== streamId) return;
    cleanup();
    onError?.(new Error(error));
  };
  function cleanup() {
    bus.off("file-bin", onFrame);
    bus.off("download:done", onDoneEv);
    bus.off("download:error", onErrEv);
  }

  // Register before the ack resolves so early frames buffer into `pending`.
  bus.on("file-bin", onFrame);
  bus.on("download:done", onDoneEv);
  bus.on("download:error", onErrEv);

  emitAck(bus, "streamMedia:start", { filePath }).then((res: Ack) => {
    if (!res.success) { cleanup(); onError?.(new Error(res.error)); return; }
    streamId = res.streamId;
    onMeta?.({
      mime: res.mime,
      size: res.size,
      width: res.width,
      height: res.height,
      scaled: res.scaled,
      originalWidth: res.originalWidth,
      originalHeight: res.originalHeight
    });
    drain();
  }).catch((e: unknown) => { cleanup(); onError?.(e); });

  return () => {
    cleanup();
    if (streamId != null) bus.emit("download:cancel", { downloadId: streamId });
  };
}

