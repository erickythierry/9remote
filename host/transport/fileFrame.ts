// Binary framing for file transfer over DataChannel / WS binary.
// Layout: [uploadId u32 LE][offset u32 LE][payload bytes]. No base64/JSON.
// Environment-agnostic (Uint8Array/DataView) so host + browser share identical bytes.
export const FRAME_HEADER_SIZE = 8;

export type FileFrame = { uploadId: number; offset: number; payload: Uint8Array };
export type FilePayload = Uint8Array | ArrayBuffer;

// payload: Uint8Array | Buffer | ArrayBuffer → Uint8Array with header prepended.
export function encodeFileFrame(uploadId: number, offset: number, payload: FilePayload): Uint8Array {
  const data = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  const frame = new Uint8Array(FRAME_HEADER_SIZE + data.byteLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, uploadId >>> 0, true);
  dv.setUint32(4, offset >>> 0, true);
  frame.set(data, FRAME_HEADER_SIZE);
  return frame;
}

// buf: Uint8Array | Buffer | ArrayBuffer → { uploadId, offset, payload }.
export function decodeFileFrame(buf: FilePayload): FileFrame {
  const view = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
  return {
    uploadId: dv.getUint32(0, true),
    offset: dv.getUint32(4, true),
    payload: view.slice(FRAME_HEADER_SIZE),
  };
}
