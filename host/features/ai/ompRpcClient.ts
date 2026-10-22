// Client for `omp --mode rpc`: NDJSON over stdio, one long-lived process per
// chat. Handles the ready frame, protocol v2 negotiation (mandatory in practice
// — agent_end frames exceed the 1 MiB v1 limit and arrive as base64 rpc_chunk
// sequences), id-correlated command/response, and forwards every other frame to
// the adapter. Transport is injected so tests run without omp installed.
//
// Wire contract measured from .source/omp docs/rpc.md + rpc-types.ts (18.2.6).
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("ai");

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

interface ChunkAccumulator {
  chunkId: string;
  byteLength: number;
  count: number;
  received: number;
  parts: Buffer[];
}

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

export interface OmpProcLike {
  onLine?: ((line: string) => void) | null;
  write(text: string): boolean | void;
  closeStdin?(): void;
  [key: string]: any;
}

export class OmpRpcClient {
  proc: OmpProcLike;
  seq: number;
  pending: Map<string | number, PendingRpc>;
  onFrame: ((frame: any) => void) | null;
  negotiated: boolean;
  private _chunks: ChunkAccumulator | null;

  constructor({ proc }: { proc: OmpProcLike }) {
    this.proc = proc;
    this.seq = 0;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.onFrame = null;      // every non-response frame (events, ui requests)
    this.negotiated = false;
    this._chunks = null;      // {chunkId, byteLength, received, parts: []}
    proc.onLine = (line: string) => this._ingestLine(line);
  }

  // Public door for lines replayed by the proc's start/attach commit().
  feed(line: string) {
    this._ingestLine(line);
  }

  // Bound so a late line after destroy cannot reach a dead adapter.
  private _ingestLine(line: string) {
    let frame: any;
    try {
      frame = JSON.parse(String(line));
    } catch {
      return; // stray non-JSON noise on stdout is dropped, not fatal
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "rpc_chunk") {
      const whole = this._reassemble(frame);
      if (whole) this._ingestLine(JSON.stringify(whole));
      return;
    }
    if (frame.type === "ready") {
      // v2 turns on chunked framing server-side; without it big frames die.
      this._write({ id: "protocol", type: "negotiate_protocol", protocolVersion: 2 });
      this.negotiated = true;
    }
    if (frame.type === "response") {
      this._settle(frame);
      return;
    }
    this.onFrame?.(frame);
  }

  // rpc_chunk reassembly per rpc-frame.ts: one uninterrupted, contiguous,
  // byte-accounted sequence per chunkId; anything else resets the accumulator.
  private _reassemble(chunk: any): any | null {
    if (!this._chunks || this._chunks.chunkId !== chunk.chunkId) {
      if (!chunk.chunkId || !Number.isInteger(chunk.index) || !Number.isInteger(chunk.count)
        || chunk.count < 2 || chunk.index >= chunk.count
        || !Number.isInteger(chunk.byteLength)
        || chunk.byteLength < MAX_FRAME_BYTES || chunk.byteLength > MAX_REASSEMBLED_BYTES) {
        this._chunks = null;
        return null;
      }
      if (chunk.index !== 0) return null; // sequence must start at zero
      this._chunks = { chunkId: chunk.chunkId, byteLength: chunk.byteLength, count: chunk.count, received: 0, parts: [] };
    } else if (chunk.index !== this._chunks.parts.length) {
      this._chunks = null;
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(String(chunk.data || ""), "base64");
    } catch {
      this._chunks = null;
      return null;
    }
    this._chunks.received += bytes.length;
    if (this._chunks.received > this._chunks.byteLength) {
      this._chunks = null;
      return null;
    }
    this._chunks.parts.push(bytes);
    if (this._chunks.parts.length < this._chunks.count) return null;
    if (this._chunks.received !== this._chunks.byteLength) {
      this._chunks = null;
      return null;
    }
    const whole = Buffer.concat(this._chunks.parts);
    this._chunks = null;
    try {
      const parsed = JSON.parse(whole.toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  private _settle(frame: any) {
    const entry = frame.id != null ? this.pending.get(frame.id) : null;
    if (!entry) return; // unsolicited ack — nothing to settle
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.success) entry.resolve(frame.data);
    else entry.reject(new Error(String(frame.error || `RPC ${frame.command} failed`)));
  }

  private _write(payload: any): boolean {
    return this.proc.write(JSON.stringify(payload) + "\n") !== false;
  }

  /** Send a command with a fresh id; resolves with the response data. */
  send(type: string, payload: Record<string, any> = {}, { timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<any> {
    this.seq += 1;
    const id = `r${this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp RPC ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this._write({ id, type, ...payload })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("omp process is not writable"));
      }
    });
  }

  // ── extension_ui_request answers ─────────────────────────────────────────
  uiRespondValue(id: string | number, value: any) {
    this._write({ type: "extension_ui_response", id, value: String(value) });
  }

  uiRespondConfirm(id: string | number, confirmed: boolean) {
    this._write({ type: "extension_ui_response", id, confirmed: Boolean(confirmed) });
  }

  uiRespondCancel(id: string | number) {
    this._write({ type: "extension_ui_response", id, cancelled: true });
  }

  /** Close stdin: the server drains, disposes, exits 0. */
  close() {
    try { this.proc.closeStdin?.(); } catch {}
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("omp RPC client closed"));
    }
    this.pending.clear();
  }
}
