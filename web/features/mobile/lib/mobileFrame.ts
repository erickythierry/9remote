// Binary framing for Android video access units over the transport's ordered
// "file" channel. Mirrored verbatim in host/features/mobile/mobileFrame.ts —
// change both sides together.
//
// An access unit exceeds the SCTP message cap, so it is split into chunks that
// the client reassembles by frameSeq. Layout (big-endian):
//   [magic u32][frameSeq u32][chunkIdx u16][chunkCount u16][flags u8][reserved u8][ptsMs u32][payload]

export const MOBILE_FRAME_MAGIC = 0xffffffff;
export const MOBILE_HEADER_SIZE = 18;
export const MOBILE_FLAG_KEY = 1;
export const MOBILE_FLAG_CONFIG = 2;

export interface EncodeMobileFrameParams {
  frameSeq: number;
  chunkIdx: number;
  chunkCount: number;
  flags: number;
  ptsMs: number;
  payload: ArrayBuffer | Uint8Array;
}

export function encodeMobileFrame({ frameSeq, chunkIdx, chunkCount, flags, ptsMs, payload }: EncodeMobileFrameParams): Uint8Array {
  const data = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  const frame = new Uint8Array(MOBILE_HEADER_SIZE + data.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, MOBILE_FRAME_MAGIC);
  dv.setUint32(4, frameSeq >>> 0);
  dv.setUint16(8, chunkIdx);
  dv.setUint16(10, chunkCount);
  dv.setUint8(12, flags);
  dv.setUint8(13, 0);
  dv.setUint32(14, ptsMs >>> 0);
  frame.set(data, MOBILE_HEADER_SIZE);
  return frame;
}

export interface DecodedMobileFrame {
  frameSeq: number;
  chunkIdx: number;
  chunkCount: number;
  isKey: boolean;
  isConfig: boolean;
  ptsMs: number;
  payload: Uint8Array;
}

/** Returns null when the buffer is not a mobile video frame (a file chunk, say). */
export function decodeMobileFrame(buf: ArrayBuffer | Uint8Array): DecodedMobileFrame | null {
  const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (view.byteLength < MOBILE_HEADER_SIZE) return null;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  if (dv.getUint32(0) !== MOBILE_FRAME_MAGIC) return null;
  const flags = dv.getUint8(12);
  return {
    frameSeq: dv.getUint32(4),
    chunkIdx: dv.getUint16(8),
    chunkCount: dv.getUint16(10),
    isKey: (flags & MOBILE_FLAG_KEY) !== 0,
    isConfig: (flags & MOBILE_FLAG_CONFIG) !== 0,
    ptsMs: dv.getUint32(14),
    payload: view.slice(MOBILE_HEADER_SIZE)
  };
}
