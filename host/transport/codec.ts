// Wire codec for non-socket.io adapters (RTC, future QUIC).
// Envelope: {event, args, ackId?}. Node uses Buffer (toJSON → {type:"Buffer", data:[]} ).
//
// Two wire forms of the SAME envelope:
//   v1 (text)   — JSON string, buffers inlined as {__b: base64}. Legacy peers.
//   v2 (binary) — [4B headerLen LE][header JSON][part0][part1]... with buffers
//                 lifted out as {__B: i} markers and appended raw. No base64:
//                 25% less wire and no encode/decode on either end.
// This is the same shape socket.io already uses for WS (placeholder + binary
// attachment), so both carriers now serialize an envelope the same way.
// v2 is used only after both sides announce it (caps.env2) — the DataChannel
// distinguishes text from binary frames, so v1 and v2 coexist with no ambiguity.

export type CodecValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | Uint8Array
  | CodecValue[]
  | { [key: string]: CodecValue };
type EncodedValue = null | undefined | boolean | number | string | EncodedValue[] | { [key: string]: EncodedValue };
type DecodedValue = null | undefined | boolean | number | string | Uint8Array | DecodedValue[] | { [key: string]: DecodedValue };
type BinaryMarker = { __B: number };

export type TransportEnvelope = {
  event: string;
  args: CodecValue[];
  ackId?: string | null;
};
type FrameBytes = ArrayBuffer | ArrayBufferView<ArrayBufferLike>;

type DecodedFrameBase = { event: string; ackId: string | null };
type DecodedPlainFrame = DecodedFrameBase & {
  args: DecodedValue[];
  frag: null | undefined;
  part: number | undefined;
  parts: number | undefined;
};
type DecodedFragmentFrame = DecodedFrameBase & {
  args: [Buffer | null, ...DecodedValue[]];
  frag: number;
  part: number;
  parts: number;
};
export type DecodedFrame = DecodedPlainFrame | DecodedFragmentFrame;

type FragmentInfo = { id: number; part: number; parts: number };
type FrameHeader = {
  event: string;
  args: EncodedValue[];
  ackId: string | null;
  lens: number[];
  frag?: number | null;
  part?: number;
  parts?: number;
};
type ParsedFrameHeader =
  | (Omit<FrameHeader, "args" | "frag" | "part" | "parts"> & { args: EncodedValue[]; frag?: null; part?: number; parts?: number })
  | (Omit<FrameHeader, "args" | "frag" | "part" | "parts"> & { args: [BinaryMarker, ...EncodedValue[]]; frag: number; part: number; parts: number });
type PendingFrame = { slices: Array<Buffer | undefined>; got: number };

const HEADER_LEN_BYTES = 4;

type NodeBufferJSON = { type: "Buffer"; data: number[] };

function isNodeBufferJSON(value: unknown): value is NodeBufferJSON {
  return value !== null && typeof value === "object" && "type" in value && value.type === "Buffer" && "data" in value && Array.isArray(value.data);
}

function replacer(_key: string, value: unknown): unknown {
  if (isNodeBufferJSON(value)) return { __b: Buffer.from(value.data).toString("base64") };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && "__b" in value && typeof value.__b === "string") {
    return Buffer.from(value.__b, "base64");
  }
  return value;
}

export function encode(envelope: TransportEnvelope): string | undefined {
  return JSON.stringify(envelope, replacer);
}

export function decode(wire: string | Uint8Array | ArrayBuffer): TransportEnvelope {
  const text = typeof wire === "string"
    ? wire
    : wire instanceof ArrayBuffer
      ? Buffer.from(wire).toString("utf8")
      : Buffer.from(wire).toString("utf8");
  const parsed: unknown = JSON.parse(text, reviver);
  return parsed as TransportEnvelope;
}

/** Lift every Buffer/TypedArray out of `value` into `parts`, leaving {__B: i}
 *  markers behind. Structure is preserved; only the bytes move. */
function lift(value: CodecValue, parts: Buffer[]): EncodedValue {
  if (Buffer.isBuffer(value)) {
    parts.push(value);
    return { __B: parts.length - 1 };
  }
  if (ArrayBuffer.isView(value)) {
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return { __B: parts.length - 1 };
  }
  if (Array.isArray(value)) return value.map((entry) => lift(entry, parts));
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: EncodedValue } = {};
    for (const key of Object.keys(value)) out[key] = lift(value[key], parts);
    return out;
  }
  return value;
}

function liftArgs(args: CodecValue[], parts: Buffer[]): EncodedValue[] {
  return args.map((entry) => lift(entry, parts));
}

/** Inverse of lift — put the raw parts back where their markers are. */
function drop(value: EncodedValue, parts: Buffer[]): DecodedValue {
  if (Array.isArray(value)) return value.map((entry) => drop(entry, parts));
  if (value !== null && typeof value === "object") {
    if ("__B" in value && typeof value.__B === "number") return parts[value.__B] ?? null;
    const out: { [key: string]: DecodedValue } = {};
    for (const key of Object.keys(value)) out[key] = drop(value[key], parts);
    return out;
  }
  return value;
}

function dropArgs(args: EncodedValue[], parts: Buffer[]): DecodedValue[] {
  return args.map((entry) => drop(entry, parts));
}

function dropFragmentArgs(args: [BinaryMarker, ...EncodedValue[]], parts: Buffer[]): [Buffer | null, ...DecodedValue[]] {
  return [parts[args[0].__B] ?? null, ...args.slice(1).map((entry) => drop(entry, parts))];
}

/** Serialize an envelope to the v2 binary frame. Returns a Buffer.
 *  `frag` = {id, part, parts} marks this frame as one slice of a larger envelope. */
export function encodeFrame(envelope: TransportEnvelope, frag: FragmentInfo | null = null): Buffer {
  const parts: Buffer[] = [];
  const header: FrameHeader = {
    event: envelope.event,
    args: liftArgs(envelope.args || [], parts),
    ackId: envelope.ackId ?? null,
    // Part byte lengths, so the reader can slice without a per-part header.
    lens: parts.map((part) => part.length),
  };
  if (frag) { header.frag = frag.id; header.part = frag.part; header.parts = frag.parts; }
  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.allocUnsafe(HEADER_LEN_BYTES);
  len.writeUInt32LE(headerBuf.length, 0);
  return Buffer.concat([len, headerBuf, ...parts]);
}

/** Parse a v2 binary frame back into {event, args, ackId}. Throws on a malformed
 *  frame — callers treat that like any other parse failure (drop the message).
 *
 *  The returned parts are subarray VIEWS onto the frame buffer (no copy — this is
 *  the point of v2): safe to read or write out, but do not hand one to something
 *  that takes ownership of the whole backing buffer. Copy it first if you must. */
export function decodeFrame(wire: FrameBytes): DecodedFrame {
  let buf: Buffer;
  if (Buffer.isBuffer(wire)) buf = wire;
  else if (wire instanceof ArrayBuffer) buf = Buffer.from(wire);
  else if (wire.buffer instanceof ArrayBuffer) buf = Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength);
  else buf = Buffer.from(new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength));
  if (buf.length < HEADER_LEN_BYTES) throw new Error("frame too short");
  const headerLen = buf.readUInt32LE(0);
  const headerEnd = HEADER_LEN_BYTES + headerLen;
  if (headerEnd > buf.length) throw new Error("frame header truncated");
  const parsed: unknown = JSON.parse(buf.subarray(HEADER_LEN_BYTES, headerEnd).toString("utf8"));
  const header = parsed as ParsedFrameHeader;
  const parts: Buffer[] = [];
  let off = headerEnd;
  for (const length of header.lens || []) {
    if (off + length > buf.length) throw new Error("frame part truncated");
    parts.push(buf.subarray(off, off + length));
    off += length;
  }
  const base = { event: header.event, ackId: header.ackId ?? null };
  if (header.frag != null) {
    return { ...base, args: dropFragmentArgs(header.args, parts), frag: header.frag, part: header.part, parts: header.parts };
  }
  return { ...base, args: dropArgs(header.args || [], parts), frag: header.frag, part: header.part, parts: header.parts };
}

// Ceiling on how many slices one envelope may be cut into — a peer announcing a
// huge count could otherwise make us allocate for a message that never arrives.
const MAX_FRAG_PARTS = 4096;

/** Cut a serialized frame into slices that each fit `maxBytes`, each slice still
 *  a valid frame once a fragment header is added. Returns [frame] when it already
 *  fits, or null when slicing cannot help — the payload does not fit even split,
 *  or the slice cap is exceeded. The caller then keeps the whole frame, which is
 *  the pre-fragment behaviour (and the peer's own limit decides what happens). */
export function sliceFrame(frame: Buffer, maxBytes: number): Buffer[] | null {
  if (frame.length <= maxBytes) return [frame];
  // Overhead of the fragment header: the length prefix, the JSON envelope skeleton
  // and the three markers. Reserved rather than measured — a few bytes of slack
  // cost nothing, an under-estimate costs the message.
  const FRAG_HEADER_RESERVE = 192;
  const slice = maxBytes - FRAG_HEADER_RESERVE;
  if (slice <= 0) return null;
  const count = Math.ceil(frame.length / slice);
  if (count > MAX_FRAG_PARTS) return null;
  const out: Buffer[] = [];
  for (let part = 0; part < count; part++) {
    out.push(frame.subarray(part * slice, Math.min((part + 1) * slice, frame.length)));
  }
  return out;
}

/** Wire frames for one envelope: a single frame when it fits `maxBytes`, else as
 *  many fragment frames as it takes. Returns null when the message cannot be sent
 *  on this carrier at all (see sliceFrame). */
export function encodeFragments(envelope: TransportEnvelope, maxBytes: number, fragId: number): Buffer[] | null {
  const wire = encodeFrame(envelope);
  const slices = sliceFrame(wire, maxBytes);
  if (!slices) return null;
  if (slices.length === 1) return [wire];
  return slices.map((slice, part) => encodeFrame({ event: envelope.event, args: [slice] }, { id: fragId, part, parts: slices.length }));
}

// Reassembled frames hold the original envelope bytes until every slice lands, so
// the buffer is bounded: at most this many messages in flight, oldest dropped.
const MAX_INFLIGHT_FRAMES = 4;

function isInteger(value: number | undefined): value is number {
  return Number.isInteger(value);
}

/** Collects sliced frames back into whole envelopes (control channel). One per
 *  receiving peer: slices of different messages interleave on the wire, so parts
 *  are grouped by id. Yields an envelope-shaped object per completed message —
 *  the same shape decodeFrame returns, so callers treat it identically. */
export function createReassembler(): { push(decoded: DecodedFrame): DecodedFrame | null } {
  const pending = new Map<number, PendingFrame>();
  return {
    /** decoded: a decodeFrame result. Returns an envelope, or null while the
     *  message is still incomplete. */
    push(decoded) {
      if (decoded.frag == null) return decoded;
      const { frag, part, parts } = decoded;
      if (!isInteger(part) || !isInteger(parts) || part < 0 || parts < 1 || part >= parts || parts > MAX_FRAG_PARTS) return null;
      let entry = pending.get(frag);
      if (!entry) {
        if (pending.size >= MAX_INFLIGHT_FRAMES) {
          const oldestFrag = pending.keys().next().value;
          if (oldestFrag !== undefined) pending.delete(oldestFrag);
        }
        entry = { slices: new Array(parts), got: 0 };
        pending.set(frag, entry);
      }
      const slice = decoded.args[0];
      if (slice == null) return null;
      // Fragment envelopes carry the original binary frame as their first decoded attachment.
      if (!entry.slices[part]) { entry.slices[part] = slice; entry.got++; }
      if (entry.got < parts) return null;
      pending.delete(frag);
      const completeSlices = entry.slices.filter((item): item is Buffer => item !== undefined);
      return decodeFrame(Buffer.concat(completeSlices));
    },
  };
}
