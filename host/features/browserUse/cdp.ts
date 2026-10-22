// Minimal CDP client over the native WebSocket (Node 22+). Zero new dependencies.
// One browser-level connection; per-target calls ride the flattened sessionId.
import { CDP_CALL_TIMEOUT_MS } from "./constants.js";

// Narrow view of the native WebSocket (Node 22 global, not typed by @types/node 18).
interface CdpSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: string }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

interface NativeWebSocketCtor {
  new (url: string): CdpSocket;
  readonly CLOSED: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// CDP result objects are shape-checked by each caller.
export type CdpResult = Record<string, unknown>;

type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

// Surface shared by CdpClient and the extension relay client; each event/call names its own shape.
export interface CdpConnection {
  readonly closed: boolean;
  on<P = Record<string, unknown>>(method: string, fn: (params: P, sessionId?: string) => void): () => boolean | undefined;
  call<T = CdpResult>(method: string, params?: Record<string, unknown>, sessionId?: string | null, timeoutMs?: number): Promise<T>;
  close(): void;
}

// Inbound frame from the browser: a response (has id) or an event (has method).
interface CdpFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: CdpResult;
  error?: { message?: string };
}

// Native WebSocket global, typed through a local interface.
const NativeWebSocket = (globalThis as unknown as { WebSocket: NativeWebSocketCtor }).WebSocket;

export class CdpClient implements CdpConnection {
  wsUrl: string;
  ws: CdpSocket | null;
  nextId: number;
  pending: Map<number, PendingCall>; // id -> {resolve, reject, timer}
  handlers: Map<string, Set<CdpEventHandler>>; // event method -> Set<fn(params, sessionId)>

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  // Subscribe to a CDP event; returns an unsubscribe function.
  on<P = Record<string, unknown>>(method: string, fn: (params: P, sessionId?: string) => void): () => boolean | undefined {
    // Event params are untyped wire JSON; each subscriber declares the shape it reads.
    const handler = fn as unknown as CdpEventHandler;
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }

  static async connect(wsUrl: string, timeoutMs = 10000): Promise<CdpClient> {
    const client = new CdpClient(wsUrl);
    await client._open(timeoutMs);
    return client;
  }

  _open(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new NativeWebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timeout: ${this.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${this.wsUrl}`));
      });
      ws.addEventListener("message", (ev) => this._onMessage(ev.data));
      ws.addEventListener("close", () => this._failAll("CDP connection closed"));
      this.ws = ws;
    });
  }

  _onMessage(raw: string): void {
    let msg: CdpFrame;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id) {
      // Event frame — dispatch to subscribers; unknown events are dropped.
      const subs = this.handlers.get(msg.method as string);
      if (subs) for (const fn of subs) { try { fn(msg.params || {}, msg.sessionId); } catch { /* subscriber error never kills the socket */ } }
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`${msg.error.message || "CDP error"}`));
    else entry.resolve(msg.result as CdpResult);
  }

  _failAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get closed(): boolean { return !this.ws || this.ws.readyState === NativeWebSocket.CLOSED; }

  // Resolves the CDP result object; every caller validates its own shape.
  call<T = CdpResult>(method: string, params: Record<string, unknown> = {}, sessionId: string | null = null, timeoutMs = CDP_CALL_TIMEOUT_MS): Promise<T> {
    const ws = this.ws;
    if (this.closed || !ws) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const frame: { id: number; method: string; params: Record<string, unknown>; sessionId?: string } = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      ws.send(JSON.stringify(frame));
    });
  }

  close(): void {
    this._failAll("CDP connection closed");
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}

// Poll the DevTools HTTP endpoint until the browser answers, then return its info.
export async function waitForDevTools(port: number, timeoutMs = 15000): Promise<{ webSocketDebuggerUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  const base = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json() as { webSocketDebuggerUrl: string };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DevTools endpoint did not come up on port ${port}`);
}
