// Unified transport layer for WS and WebRTC DataChannel.

let _worker: Worker | false | null = null;
let _workerMsgId = 0;
// Bound consecutive worker respawns on repeated crash (e.g. CSP).
const MAX_WORKER_RESPAWNS = 3;
let _workerFailures = 0;
const _workerPending = new Map<number, (val: any) => void>();
const _latestTileTs = new Map<number, number>();
let _pendingEmit: { tiles: Map<number, any>; timestamp: number; hasBitmap: boolean } | null = null;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function getWorker(): Worker | null {
  if (_worker === false) return null;
  if (_worker) return _worker;
  try {
    _worker = new Worker(
      new URL("../workers/tileDecoder.worker.js", import.meta.url)
    );
  } catch {
    _worker = false;
    return null;
  }
  _worker.onmessage = ({ data: { tiles, timestamp, id, hasBitmap, error } }: MessageEvent) => {
    _workerFailures = 0;
    const resolve = _workerPending.get(id);
    if (!resolve) return;
    _workerPending.delete(id);
    resolve(error ? null : { tiles, timestamp, hasBitmap });
  };
  _worker.onerror = (err: ErrorEvent) => {
    console.error("[Worker] tileDecoder error:", err.message);
    resetWorker();
    if (++_workerFailures >= MAX_WORKER_RESPAWNS) _worker = false;
  };
  return _worker;
}

function resetWorker(): void {
  if (_worker) { try { _worker.terminate(); } catch {} }
  _worker = null;
  for (const resolve of _workerPending.values()) { try { resolve(null); } catch {} }
  _workerPending.clear();
}

export class RemoteTransport {
  private _socket: any;
  private _dc: RTCDataChannel | null;
  private _tileBatch: any[];
  private _listeners: Map<string, Set<Function>>;
  private _socketProxy: (eventName: string) => (...args: any[]) => void;
  private _proxiedEvents: Map<string, (...args: any[]) => void>;
  private _lastTransport: string | null;

  constructor(bus: any) {
    this._socket = bus;
    this._dc = null;
    this._tileBatch = [];
    this._listeners = new Map();

    this._socketProxy = (eventName: string) => (...args: any[]) => {
      this._emit(eventName, ...args);
    };
    this._proxiedEvents = new Map();
    this._lastTransport = null;
  }

  on(eventName: string, handler: Function): void {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, new Set());
      const proxy = (...args: any[]) => {
        if (eventName === "tiles-data" && args[0] && !args[0].transport) {
          args[0].transport = "ws";
        }
        this._emit(eventName, ...args);
      };
      this._proxiedEvents.set(eventName, proxy);
      this._socket?.on(eventName, proxy);
    }
    this._listeners.get(eventName)!.add(handler);
  }

  off(eventName: string, handler: Function): void {
    const set = this._listeners.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this._listeners.delete(eventName);
      const proxy = this._proxiedEvents.get(eventName);
      if (proxy) {
        this._socket?.off(eventName, proxy);
        this._proxiedEvents.delete(eventName);
      }
    }
  }

  emit(eventName: string, data?: any): void {
    this._socket?.emit(eventName, data);
  }

  attachDataChannel(dc: RTCDataChannel): void {
    this._dc = dc;
    dc.onmessage = ({ data }: MessageEvent) => {
      if (!(data instanceof ArrayBuffer)) return;
      this._receiveDCTile(data);
    };
    dc.onclose = () => {
      this._dc = null;
    };
  }

  detachDataChannel(): void {
    if (this._dc) {
      this._dc.onmessage = null;
      this._dc.onclose = null;
      this._dc = null;
    }
    this._tileBatch = [];
    _latestTileTs.clear();
    _pendingEmit = null;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  }

  destroy(): void {
    this.detachDataChannel();
    for (const [eventName, proxy] of this._proxiedEvents.entries()) {
      this._socket?.off(eventName, proxy);
    }
    this._proxiedEvents.clear();
    this._listeners.clear();
  }

  _emit(eventName: string, ...args: any[]): void {
    const set = this._listeners.get(eventName);
    if (!set) return;
    for (const handler of set) handler(...args);
  }

  _receiveDCTile(buffer: ArrayBuffer): void {
    const id = ++_workerMsgId;

    new Promise<any>((resolve) => {
      const worker = getWorker();
      if (!worker) return resolve(null);
      _workerPending.set(id, resolve);
      worker.postMessage({ buffer, id }, [buffer]);
    }).then((result) => {
      if (!result) return;
      const { tiles, timestamp, hasBitmap } = result;

      if (!_pendingEmit) {
        _pendingEmit = { tiles: new Map(), timestamp, hasBitmap };
      }
      for (const tile of tiles) {
        const prev = _latestTileTs.get(tile.tileIndex) ?? 0;
        if (timestamp >= prev) {
          _latestTileTs.set(tile.tileIndex, timestamp);
          _pendingEmit.tiles.get(tile.tileIndex)?.bitmap?.close?.();
          _pendingEmit.tiles.set(tile.tileIndex, tile);
          if (timestamp > _pendingEmit.timestamp) _pendingEmit.timestamp = timestamp;
        } else {
          tile.bitmap?.close?.();
        }
      }

      // setTimeout(0) merges chunks from the same frame before emitting.
      if (_flushTimer) clearTimeout(_flushTimer);
      _flushTimer = setTimeout(() => {
        _flushTimer = null;
        if (!_pendingEmit) return;
        const { tiles: tileMap, timestamp: ts, hasBitmap: hb } = _pendingEmit;
        _pendingEmit = null;
        const freshTiles = [...tileMap.values()];
        if (!freshTiles.length) return;
        this._emit("tiles-data", { tiles: freshTiles, timestamp: ts, hasBitmap: hb, transport: "webrtc" });
      }, 0);
    });
  }

  getTransport(): string {
    return this._dc ? "webrtc" : "ws";
  }
}
