import type { MutableRefObject } from "react";
import { trimEndToEsc } from "@/features/terminal/lib/ansiBoundary";
import type { WriteBatcher } from "@/features/terminal/lib/termWriteBatcher";

export type TerminalChunk = Uint8Array | string;

// Fast zero-allocation UTF-8 byte length (matches Buffer.byteLength without GC pressure).
export function utf8ByteLength(str: string): number {
  if (!str) return 0;
  let len = 0;
  const strLen = str.length;
  for (let i = 0; i < strLen; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) len += 1;
    else if (code <= 0x7ff) len += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}

// Normalize a payload to Uint8Array or string — the two forms the mirror stores.
export function toChunk(data: unknown): TerminalChunk {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
  }
  return typeof data === "string" ? data : String(data);
}

export const chunkByteLength = (chunk: TerminalChunk): number =>
  typeof chunk === "string" ? utf8ByteLength(chunk) : chunk.byteLength;

// Write output via the rAF batcher when provided (coalesces bursts into one write/frame so the
// main thread isn't blocked parsing each 1KB chunk), else direct term.write. mirror/mirrorBytes:
// refs accumulating raw bytes for scroll-up history replay (null = skip mirroring).
export function writeChunked(
  term: any,
  data: unknown,
  mirror: MutableRefObject<TerminalChunk[]> | null | undefined,
  mirrorBytes: MutableRefObject<number> | null | undefined,
  batcher?: WriteBatcher | null
): void {
  if (!term || term._core?._isDisposed) return;
  const chunk = toChunk(data);
  if (batcher) batcher.write(chunk);
  else term.write(chunk);

  if (mirror && mirrorBytes) {
    mirror.current.push(chunk);
    mirrorBytes.current += chunkByteLength(chunk);
  }
}

export interface DedupePrefixOptions {
  haveAtEmit: number;
  historyBytes: number;
}

// Race-dedup for a scroll-up prefix: the daemon computes the range against the `have` we SENT,
// but live PTY output can land in our tail between emit and ack → the prefix's tail re-covers
// bytes already mirrored. Drop that overlap, aligning any byte cut to a clean ESC boundary so
// a trailing ANSI escape isn't split.
export function dedupePrefix(prefixChunk: TerminalChunk, { haveAtEmit, historyBytes }: DedupePrefixOptions): TerminalChunk {
  const liveDelta = Math.max(0, haveAtEmit > 0 ? historyBytes - haveAtEmit : 0);
  if (liveDelta <= 0) return prefixChunk;
  let keep = Math.max(0, chunkByteLength(prefixChunk) - liveDelta);
  if (typeof prefixChunk !== "string") keep = trimEndToEsc(prefixChunk, keep);
  return typeof prefixChunk === "string" ? prefixChunk.slice(0, keep) : prefixChunk.subarray(0, keep);
}

export interface ViewportRestoreDeltaOptions {
  oldViewportY: number;
  baseYBefore: number;
  baseYAfter: number;
}

// Scroll offset that keeps the user's content in place after a prefix replay. We MEASURE the
// prefix's real line count (baseY delta) instead of estimating from bytes — ANSI escapes and
// wide-char wrapping make byte/cols estimates wildly wrong → viewport jump. Negative = scroll up.
export function viewportRestoreDelta({ oldViewportY, baseYBefore, baseYAfter }: ViewportRestoreDeltaOptions): number {
  const actualChunkLines = Math.max(0, baseYAfter - baseYBefore);
  const target = Math.max(0, Math.min(oldViewportY + actualChunkLines, baseYAfter));
  return target - baseYAfter;
}

// Decode the mirror into one writable string (stream mode keeps multibyte chars split
// across chunk boundaries intact).
export function decodeMirror(chunks: TerminalChunk[]): string {
  const decoder = new TextDecoder();
  return chunks.map((c) => (typeof c === "string" ? c : decoder.decode(c, { stream: true }))).join("");
}
