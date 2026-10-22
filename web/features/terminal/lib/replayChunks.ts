// Split a terminal mirror (mixed Uint8Array | string chunks) into byte-bounded
// chunks for incremental xterm.write. xterm.js parses asynchronously in ~12ms
// batches and preserves ANSI/UTF-8 parser state across writes, so feeding a
// big replay in ≤maxBytes pieces (via write callback + rAF) keeps the main
// thread responsive instead of blocking on one MB-sized write.
//
// Byte order is preserved exactly; multibyte UTF-8 codepoints may be split
// across chunk boundaries (xterm reassembles them via its decoder state).

declare const Buffer: any;

const _enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

// mirror: array of Uint8Array | string. maxBytes: max byte length per output chunk.
// Returns array of Uint8Array (byte-sliced from inputs, order preserved).
export function toReplayChunks(mirror: Array<Uint8Array | string>, maxBytes: number): Uint8Array[] {
  if (!Array.isArray(mirror) || mirror.length === 0) return [];
  const cap = maxBytes > 0 ? Math.floor(maxBytes) : 1;
  const out: Uint8Array[] = [];
  const buf = new Uint8Array(cap);
  let bufLen = 0;

  const flush = () => {
    if (bufLen === 0) return;
    out.push(bufLen === cap ? buf.slice() : buf.subarray(0, bufLen).slice());
    bufLen = 0;
  };

  for (const item of mirror) {
    if (item == null) continue;
    const src = item instanceof Uint8Array ? item
      : (typeof item === "string" ? (_enc ? _enc.encode(item) : Uint8Array.from(Buffer.from(item, "utf-8")))
        : null);
    if (!src || src.length === 0) continue;
    let off = 0;
    while (off < src.length) {
      const room = cap - bufLen;
      const take = Math.min(room, src.length - off);
      buf.set(src.subarray(off, off + take), bufLen);
      bufLen += take;
      off += take;
      if (bufLen >= cap) flush();
    }
  }
  flush();
  return out;
}
