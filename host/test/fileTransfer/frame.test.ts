// Unit tests for binary file-transfer framing (TDD — module not yet implemented).
// Frame layout: [uploadId u32 LE][offset u32 LE][payload bytes]. No base64/JSON.
// Run: node agent/test/fileTransfer/frame.test.mjs
import assert from "node:assert/strict";
import { encodeFileFrame, decodeFileFrame, FRAME_HEADER_SIZE } from "../../transport/fileFrame.js";
import { decodeFileFrame as decodeWebFileFrame, encodeFileFrame as encodeWebFileFrame } from "../../../web/shared/transport/fileFrame.js";

let pass = 0, fail = 0;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const test = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((error: unknown) => { fail++; console.error(`  ✗ ${name}\n    ${errorMessage(error)}`); });

await test("header size is 8 bytes (uploadId u32 + offset u32)", () => {
  assert.equal(FRAME_HEADER_SIZE, 8);
});

await test("encode round-trips payload exactly (byte-identical)", () => {
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x7f, 0x80, 0xfe]);
  const frame = encodeFileFrame(42, 1024, payload);
  assert.equal(frame.length, FRAME_HEADER_SIZE + payload.length);
  const decoded = decodeFileFrame(frame);
  assert.equal(decoded.uploadId, 42);
  assert.equal(decoded.offset, 1024);
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));
});

await test("encode preserves zero-byte payload", () => {
  const frame = encodeFileFrame(1, 0, Buffer.alloc(0));
  const decoded = decodeFileFrame(frame);
  assert.equal(decoded.uploadId, 1);
  assert.equal(decoded.offset, 0);
  assert.equal(decoded.payload.length, 0);
});

await test("large uploadId + offset fit in u32 (4_294_967_295)", () => {
  const max = 0xffffffff;
  const frame = encodeFileFrame(max, max, Buffer.from([1, 2, 3]));
  const decoded = decodeFileFrame(frame);
  assert.equal(decoded.uploadId, max);
  assert.equal(decoded.offset, max);
});

await test("binary payload (image-like bytes) survives intact", () => {
  const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  const decoded = decodeFileFrame(encodeFileFrame(7, 8192, payload));
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));
  assert.equal(decoded.offset, 8192);
});

await test("host and web file frames have identical bytes and cross-decode", () => {
  const payload = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
  const hostFrame = encodeFileFrame(0xfedcba98, 0x76543210, payload);
  const webFrame = encodeWebFileFrame(0xfedcba98, 0x76543210, payload);
  assert.deepEqual(Array.from(hostFrame), Array.from(webFrame));
  assert.deepEqual(Array.from(decodeFileFrame(webFrame).payload), Array.from(payload));
  assert.deepEqual(Array.from(decodeWebFileFrame(hostFrame).payload), Array.from(payload));
  assert.deepEqual(Array.from(hostFrame.subarray(0, FRAME_HEADER_SIZE)), [0x98, 0xba, 0xdc, 0xfe, 0x10, 0x32, 0x54, 0x76]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
