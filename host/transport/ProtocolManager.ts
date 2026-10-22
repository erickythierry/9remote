import { WsProtocol } from "./WsProtocol.js";
import { WebRtcProtocol } from "./WebRtcProtocol.js";
import { registerProtocol, getProtocol } from "./registry.js";
import { TRANSPORT_PROFILES, CHANNELS, ADAPTER_STATE, RTC_DEAD_GRACE_MS, SIGNALING_ERRORS } from "../lib/transportConstants.js";
import { encodeTilesBatch } from "../features/remote/handlers/ScreenHandler.js";
import { isDeviceRejected } from "../lib/deviceApproval.js";
import { onSignalingMessage, onSignalingReady, sendSignaling as sendGlobalSignaling, isSignalingReady } from "../lib/signalingGlobal.js";
import { pushTransportState } from "../api/ui.js";
import { createLogger } from "../lib/logger.js";
import type { Socket } from "socket.io";
import type { HostBus } from "./HostBus.js";
import type { ProtocolContext, ProtocolProfile, ProtocolState } from "./BaseProtocol.js";
import type { ProtocolAdapter } from "./registry.js";
import type { SignalingMessage } from "./SignalingClient.js";

const logger = createLogger("transport");

type HostEndpoint = Socket | HostBus;
type ProtocolConfig = {
  enableWebRTC: boolean;
  enableTurn?: boolean;
  apiKey: string | null;
  turnApiUrl: string | null;
  turnRefreshInterval: number;
  dcMaxMessageSize: number;
  dcChunkSize: number;
  dcMaxTilesPerFrame: number;
  answerTimeout: number;
  maxControlBuffer: number;
  wsChunkSize: number;
  signaling?: { deviceId?: string | null; doUrl?: string | null; apiKey?: string | null };
};
type AdapterStats = { binChunks: number; b64Chunks: number; sentRtc: number; sentWs: number; binAnnounced: boolean; env2Announced: boolean };
type BufferedControl = { event: string; args: unknown[]; ackId?: string | null };
type TileRef = { tileIndex: number };
type TileEnvelope = { tiles: TileRef[]; timestamp?: number };
type PeerCapabilities = { binOut?: boolean; env2?: boolean; fragCtl?: boolean; hb?: boolean };
type BusSocket = HostEndpoint & { _rawEmit?: (...args: unknown[]) => unknown; emit: (event: string, ...args: unknown[]) => unknown };
type AdapterConstructorInfo = Function & { id?: string; priority?: Record<string, number> };

function adapterInfo(adapter: ProtocolAdapter): AdapterConstructorInfo {
  return adapter.constructor as AdapterConstructorInfo;
}

function defersWsAdapter(host: HostEndpoint | null): boolean {
  return Boolean(host && "defersWsAdapter" in host && host.defersWsAdapter);
}

function isPeerCapabilities(value: unknown): value is PeerCapabilities {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelopeArgs(value: unknown): unknown[] | null {
  return typeof value === "object" && value !== null && "args" in value && Array.isArray(value.args)
    ? value.args
    : null;
}

function envelopeAckId(value: unknown): unknown {
  return typeof value === "object" && value !== null && "ackId" in value ? value.ackId : undefined;
}

registerProtocol(WsProtocol);
registerProtocol(WebRtcProtocol);

/** Server ProtocolManager — per-client orchestrator. */
export class ProtocolManager {
  _profile: ProtocolProfile;
  _auth: { apiKey: string | null; socketId: string | null };
  _socket: HostEndpoint | null;
  _host: HostEndpoint | null;
  _wsChunkSize: number;
  _dcChunkSize: number;
  _dcMaxTilesPerFrame: number;
  _maxControlBuffer: number;
  _deviceId: string | null;
  _approvalDeviceId: string | null;
  _sigBuffer: SignalingMessage[];
  _adapters: Map<string, ProtocolAdapter>;
  _buffer: BufferedControl[];
  _binOut: boolean;
  _stats: AdapterStats;
  _statsTimer: ReturnType<typeof setInterval>;
  _rtcSignalingHandler: ((message: SignalingMessage) => void) | null;
  _wsPendingSince: Map<number, number>;
  _rtcPendingSince: Map<number, number>;
  declare _attachingWs: Promise<void> | null;
  declare _offGlobalSig: (() => void) | null;
  declare _offGlobalReady: (() => void) | null;
  declare _peerCaps: PeerCapabilities | null;
  declare _closed: boolean;
  declare _deadTimer: ReturnType<typeof setTimeout> | null;
  declare _onDead: (() => void) | null;

  constructor(socket: HostEndpoint | null, config: ProtocolConfig) {
    const profileId = config.enableWebRTC ? "remoteDesktop" : "clientApp";
    const profile: ProtocolProfile = { ...TRANSPORT_PROFILES[profileId] };
    if (!config.enableWebRTC) profile.enabled = ["ws"];

    profile.rtc = {
      enableTurn: Boolean(config.enableTurn),
      turnApiUrl: config.turnApiUrl || null,
      turnRefreshInterval: config.turnRefreshInterval,
      dcMaxMessageSize: config.dcMaxMessageSize,
      answerTimeout: config.answerTimeout
    };

    this._profile = profile;
    this._auth = { apiKey: config.apiKey || null, socketId: socket?.id || null };
    this._socket = socket || null;
    this._host = socket || null;
    this._wsChunkSize = config.wsChunkSize;
    this._dcChunkSize = config.dcChunkSize;
    this._dcMaxTilesPerFrame = config.dcMaxTilesPerFrame;
    this._maxControlBuffer = config.maxControlBuffer;
    this._deviceId = config.signaling?.deviceId || null;
    this._approvalDeviceId = this._deviceId ? this._deviceId.split(":")[0] : null;
    this._sigBuffer = [];

    this._adapters = new Map();
    this._buffer = [];
    this._binOut = false;
    this._stats = { binChunks: 0, b64Chunks: 0, sentRtc: 0, sentWs: 0, binAnnounced: false, env2Announced: false };
    this._statsTimer = setInterval(() => this._reportStats(), 60_000);
    this._statsTimer.unref?.();
    this._rtcSignalingHandler = null;
    this._wsPendingSince = new Map();
    this._rtcPendingSince = new Map();
  }

  get type(): "dc" | "ws" {
    const adapter = this._pickAdapter(CHANNELS.binary);
    return adapter && adapterInfo(adapter).id === "rtc" ? "dc" : "ws";
  }

  async init(): Promise<void> {
    for (const id of this._profile.enabled) {
      if (id === "ws" && defersWsAdapter(this._host)) continue;
      const Adapter = getProtocol(id);
      if (!Adapter) continue;
      let inst: ProtocolAdapter;
      try {
        inst = new Adapter();
        inst.on("stateChange", (state) => this._onAdapterStateChange(id, state));
        inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source ?? "", args));
        inst.on("binary", (msg) => this._onBinary(msg));
        await inst.connect(this._buildCtx(id));
      } catch (err) {
        if (id === "rtc") {
        console.warn(`[ProtocolManager] WebRTC unavailable — remote desktop over WS only. (${err instanceof Error ? err.message : String(err)})`);
          continue;
        }
        throw err;
      }
      this._adapters.set(id, inst);
    }
    this.setupSignaling(this._socket);
  }

  /** Late-attach a socket.io socket to an RTC-only session. */
  async attachSocket(socket: HostEndpoint | null): Promise<void> {
    if (!socket) return;
    const existing = this._adapters.get("ws");
    if (existing) {
      if (existing.socket === socket) return;
      // Evict a stale ws adapter: its socket died undetected (half-open tunnel)
      // and would silently refuse this live socket — events would hit zero listeners.
      this._adapters.delete("ws");
      const staleSocket = existing.socket;
      try { existing.disconnect(); } catch {}
      try { staleSocket?.disconnect?.(true); } catch {}
    }
    if (this._attachingWs) {
      this._attachingWs = this._attachingWs
        .catch(() => {})
        .then(() => this.attachSocket(socket));
      await this._attachingWs;
      return;
    }
    this._attachingWs = this._attachSocketInternal(socket)
      .finally(() => { this._attachingWs = null; });
    await this._attachingWs;
  }

  async _attachSocketInternal(socket: HostEndpoint): Promise<void> {
    this._socket = socket;
    this._auth.socketId = socket.id;
    const Adapter = getProtocol("ws");
    if (!Adapter) return;
    const inst = new Adapter();
    inst.on("stateChange", (state) => this._onAdapterStateChange("ws", state));
    inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source ?? "", args));
    inst.on("binary", (msg) => this._onBinary(msg));
    await inst.connect(this._buildCtx("ws"));
    this._adapters.set("ws", inst);
    const onDisconnect = () => {
      if (this._adapters.get("ws") !== inst) return;
      this._adapters.delete("ws");
      this._socket = null;
      try { inst.disconnect(); } catch {}
    };
    if ("defersWsAdapter" in socket) socket.on("disconnect", onDisconnect);
    else socket.on("disconnect", onDisconnect);
    this._flushBuffer();
  }

  setupSignaling(_socket: HostEndpoint | null): void {
    if (this._offGlobalSig) return;
    this._offGlobalSig = onSignalingMessage(this._deviceId, (msg) => {
      if (msg.type === "offer") {
        if (this._approvalDeviceId && isDeviceRejected(this._approvalDeviceId)) {
          this._sendSignaling({ type: "error", message: SIGNALING_ERRORS.rejected });
          return;
        }
        if (!this._rtcSignalingHandler) {
          this._sendSignaling({ type: "error", message: "rtc-disabled" });
          return;
        }
      }
      this._rtcSignalingHandler?.(msg);
    });
    this._offGlobalReady = onSignalingReady(() => this._flushSigBuffer());
  }

  emit(event: string, ...args: unknown[]): void {
    this._sendControl(event, args);
  }

  /** Broadcast event across all ready carriers. */
  emitEverywhere(event: string, ...args: unknown[]): boolean {
    let sent = 0;
    for (const a of this._adapters.values()) {
      if (!a.ready) continue;
      try { if (a.send(CHANNELS.control, { event, args })) sent++; } catch {}
    }
    logger.debug(`[diag] emitEverywhere ${event} → sent on ${sent} carrier(s)`);
    return sent > 0;
  }

  /** Recreate RTC adapter and signaling handler. */
  restartRtc() {
    if (this._adapters.has("rtc")) return;
    const Adapter = getProtocol("rtc");
    if (!Adapter) return;
    try {
      const inst = new Adapter();
      inst.on("stateChange", (s) => this._onAdapterStateChange("rtc", s));
      inst.on("message", ({ event, data, args, source }) => this._dispatch(event, data, source ?? "", args));
      inst.on("binary", (msg) => this._onBinary(msg));
      if (this._peerCaps) inst.setPeerCaps?.(this._peerCaps);
      this._adapters.set("rtc", inst);
      inst.connect(this._buildCtx("rtc"));
    } catch (e) {
      console.warn(`[ProtocolManager] restartRtc failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Send binary payload using best ready adapter (RTC preferred). */
  sendBinary(channel: string, payload: Buffer | Uint8Array): boolean {
    const adapter = this._pickAdapter(channel);
    if (!adapter) return false;
    return adapter.send(channel, payload);
  }

  /** Send screen tiles: prefer RTC binary, fallback to WS chunked. */
  sendTiles(payload: TileEnvelope, encodeBatch: ((tiles: TileRef[], timestamp?: number) => Buffer) | null, channel = CHANNELS.binary): TileRef[] {
    const { tiles, timestamp } = payload;
    if (!tiles?.length) return [];

    const adapter = this._pickAdapter(channel);
    const frameTs = timestamp ?? Date.now();

    if (adapter && adapterInfo(adapter).id === "rtc" && encodeBatch) {
      return this._emitTilesRtc(adapter, tiles, frameTs, encodeBatch, channel);
    }
    return this._emitTilesChunked(tiles, frameTs, channel);
  }

  close(): void {
    this._closed = true;
    clearInterval(this._statsTimer);
    if (this._deadTimer) clearTimeout(this._deadTimer);
    this._deadTimer = null;
    try { this._offGlobalSig?.(); } catch {}
    this._offGlobalSig = null;
    try { this._offGlobalReady?.(); } catch {}
    this._offGlobalReady = null;
    this._sigBuffer = [];
    for (const inst of this._adapters.values()) {
      try { inst.disconnect(); } catch {}
    }
    this._adapters.clear();
    this._buffer = [];
  }

  /** Route socket.emit through ProtocolManager control channel. */
  attachAsBus(socket: HostEndpoint): void {
    const busSocket = socket as BusSocket;
    if (busSocket._rawEmit) return;
    const rawEmit = busSocket.emit.bind(busSocket);
    busSocket._rawEmit = rawEmit as (...args: unknown[]) => unknown;
    const reserved = new Set(["error", "disconnect", "disconnecting", "connect", "newListener", "removeListener"]);
    socket.emit = ((event: string, ...args: unknown[]) => {
      if (reserved.has(event)) return rawEmit(event, ...args);
      this._sendControl(event, args);
      return true;
    }) as typeof socket.emit;
  }

  _emitTilesChunked(tiles: TileRef[], frameTs: number, channel = CHANNELS.binary): TileRef[] {
    const ws = this._adapters.get("ws");
    if (!ws?.ready) return [];
    const size = this._wsChunkSize;
    const pendingSince = this._wsPendingSince;
    const now = frameTs ?? Date.now();
    const ordered = [...tiles].sort((a, b) => {
      const ap = pendingSince.get(a.tileIndex) ?? Infinity;
      const bp = pendingSince.get(b.tileIndex) ?? Infinity;
      if (ap !== bp) return ap - bp;
      return a.tileIndex - b.tileIndex;
    });
    const sent = [];
    for (let i = 0; i < ordered.length; i += size) {
      const chunk = ordered.slice(i, i + size);
      if (ws.send(channel, encodeTilesBatch(chunk as any, frameTs)) === false) {
        for (let j = i; j < ordered.length; j++) {
          const tileIndex = ordered[j].tileIndex;
          if (!pendingSince.has(tileIndex)) pendingSince.set(tileIndex, now);
        }
        break;
      }
      for (const tile of chunk) pendingSince.delete(tile.tileIndex);
      sent.push(...chunk);
    }
    return sent;
  }

  _emitTilesRtc(rtc: ProtocolAdapter, tiles: TileRef[], frameTs: number, encodeBatch: (tiles: TileRef[], timestamp?: number) => Buffer, channel = CHANNELS.binary): TileRef[] {
    const max = this._profile.rtc?.dcMaxMessageSize ?? 65536;
    const n = tiles.length;
    const pendingSince = this._rtcPendingSince;
    const now = frameTs ?? Date.now();
    const ordered = [...tiles].sort((a, b) => {
      const ap = pendingSince.get(a.tileIndex) ?? Infinity;
      const bp = pendingSince.get(b.tileIndex) ?? Infinity;
      if (ap !== bp) return ap - bp;
      return a.tileIndex - b.tileIndex;
    });
    const chunkTiles = (cs: number) => ordered.slice(0, cs);
    let chunkSize = Math.min(this._dcChunkSize, n);
    while (chunkSize > 1 && encodeBatch(chunkTiles(chunkSize), frameTs).length > max) {
      chunkSize = Math.floor(chunkSize / 2);
    }
    const ws = this._adapters.get("ws");
    const sent = [];
    for (let i = 0; i < n; i += chunkSize) {
      const chunk = ordered.slice(i, i + chunkSize);
      const buf = encodeBatch(chunk, frameTs);
      if (buf.length > max) {
        if (chunk.length === 1 && ws?.ready && ws.send(channel, buf) !== false) {
          pendingSince.delete(chunk[0].tileIndex);
          sent.push(...chunk);
        }
        continue;
      }
      if (rtc.send(channel, buf) === false) {
        const remaining = ordered.slice(i);
        if (ws?.ready) {
          const wsSent = this._emitTilesChunked(remaining, frameTs, channel);
          for (const t of wsSent) pendingSince.delete(t.tileIndex);
          sent.push(...wsSent);
        } else {
          for (let j = i; j < n; j++) {
            if (!pendingSince.has(ordered[j].tileIndex)) pendingSince.set(ordered[j].tileIndex, now);
          }
        }
        return sent;
      }
      for (const tile of chunk) pendingSince.delete(tile.tileIndex);
      sent.push(...chunk);
    }
    return sent;
  }

  _buildCtx(adapterId: string): ProtocolContext {
    const ctx: ProtocolContext = { auth: this._auth, profile: this._profile };
    if (adapterId === "ws") {
      ctx.socket = this._socket;
    }
    if (adapterId === "rtc") {
      ctx.signaling = {
        send: (msg) => this._sendSignaling(msg as SignalingMessage),
        on: (handler) => { this._rtcSignalingHandler = handler as (message: SignalingMessage) => void; },
        off: () => { this._rtcSignalingHandler = null; }
      };
    }
    return ctx;
  }

  _onAdapterStateChange(adapterId: string, state: ProtocolState): void {
    if (this._closed) return;
    logger.debug(`${adapterId}→${state} (carriers: ${[...this._adapters.entries()].map(([id, a]) => `${id}=${a.ready ? "ready" : a.state}`).join(" ")})`);
    pushTransportState();
    if (state === ADAPTER_STATE.open) {
      if (this._deadTimer) clearTimeout(this._deadTimer);
      this._deadTimer = null;
      this._flushBuffer();
      return;
    }
    if (state === ADAPTER_STATE.closed && adapterId === "rtc"
      && defersWsAdapter(this._host) && !this._adapters.get("ws")?.ready) {
      if (this._deadTimer) clearTimeout(this._deadTimer);
      logger.debug(`rtc closed, no ws on a HostBus session → ${RTC_DEAD_GRACE_MS}ms grace before declaring dead`);
      this._deadTimer = setTimeout(() => {
        this._deadTimer = null;
        if (this._closed || this._adapters.get("rtc")?.ready) {
          logger.debug("rtc came back inside grace — session kept");
          return;
        }
        logger.info("rtc never returned → session dead");
        this._onDead?.();
      }, RTC_DEAD_GRACE_MS);
    }
  }

  _pickAdapter(channel: string): ProtocolAdapter | null {
    const cfg = this._profile.channels[channel];
    if (!cfg) return null;

    const candidates = [...this._adapters.values()]
      .filter((a) => a.supports(channel) && a.ready);

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const pB = b.getPriority(channel) ?? adapterInfo(b).priority?.[channel] ?? 0;
      const pA = a.getPriority(channel) ?? adapterInfo(a).priority?.[channel] ?? 0;
      if (pB !== pA) return pB - pA;
      if (cfg.prefer) {
        if (adapterInfo(b).id === cfg.prefer) return 1;
        if (adapterInfo(a).id === cfg.prefer) return -1;
      }
      return 0;
    });

    return candidates[0] || null;
  }

  hasReadyAdapter(): boolean {
    return Boolean(this._pickAdapter(CHANNELS.control) || this._pickAdapter(CHANNELS.binary));
  }

  _sendControl(event: string, args: unknown[], ackId?: string | null): void {
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) {
      this._buffer.push({ event, args, ackId });
      if (this._buffer.length > this._maxControlBuffer) this._buffer.shift();
      return;
    }
    this._legacyB64Down(event, args);
    if (event === "output") {
      const st = this._stats;
      const firstArg = args[0];
      if (firstArg !== null && typeof firstArg === "object" && "enc" in firstArg && firstArg.enc === "bin") {
        st.binChunks++;
        if (!st.binAnnounced) {
          st.binAnnounced = true;
          const sessionId = "sessionId" in firstArg ? firstArg.sessionId : undefined;
          logger.info(`[binout] FIRST binary output chunk sent → ${sessionId}`);
        }
      } else st.b64Chunks++;
    }
    if (adapterInfo(adapter).id === "rtc") {
      this._stats.sentRtc++;
      if (adapter.send(CHANNELS.control, { event, args, ackId })) return;
      const retry = this._pickAdapter(CHANNELS.control);
      if (retry && retry !== adapter && retry.send(CHANNELS.control, { event, args, ackId })) return;
    } else {
      this._stats.sentWs++;
      if (adapter.send(CHANNELS.control, { event, args })) return;
    }
    this._buffer.push({ event, args, ackId });
    if (this._buffer.length > this._maxControlBuffer) this._buffer.shift();
  }

  /** Downgrade binary output to base64 for peers without caps.binOut. */
  _legacyB64Down(event: string, args: unknown[]): void {
    if (this._binOut || event !== "output") return;
    const p = args[0];
    if (p !== null && typeof p === "object" && "enc" in p && p.enc === "bin" && "data" in p && Buffer.isBuffer(p.data)) {
      args[0] = { ...p, enc: "b64", data: p.data.toString("base64") };
    }
  }

  _reportStats(): void {
    const st = this._stats;
    const out = st.binChunks + st.b64Chunks;
    if (!out && !st.sentRtc && !st.sentWs) return;
    const binPct = out ? Math.round((st.binChunks / out) * 100) : 0;
    const rtcPct = (st.sentRtc + st.sentWs) ? Math.round((st.sentRtc / (st.sentRtc + st.sentWs)) * 100) : 0;
    logger.info(
      `[stats] output=${out} (bin ${binPct}% / b64 ${100 - binPct}%) | control rtc=${rtcPct}% (${st.sentRtc}/${st.sentRtc + st.sentWs}) | env2=${this._adapters.get("rtc")?._peerEnv2 ? "on" : "off"} binOut=${this._binOut ? "on" : "off"}`
    );
    st.binChunks = 0; st.b64Chunks = 0; st.sentRtc = 0; st.sentWs = 0;
  }

  _flushBuffer(): void {
    if (!this._buffer.length) return;
    const adapter = this._pickAdapter(CHANNELS.control);
    if (!adapter) return;
    const queued = this._buffer.splice(0);
    for (const { event, args, ackId } of queued) this._sendControl(event, args, ackId);
  }

  /** Dispatch incoming message from RTC or WS. */
  _dispatch(event: string, payload: unknown, source: string, wsArgs?: unknown[]): void {
    if (event === "caps") {
      const capsPayload = source === "rtc" ? envelopeArgs(payload)?.[0] : (wsArgs?.[0] ?? payload);
      if (isPeerCapabilities(capsPayload)) {
        if (capsPayload.binOut) this._binOut = true;
        this._peerCaps = capsPayload;
        this._adapters.get("rtc")?.setPeerCaps?.(this._peerCaps);
      }
    }
    if (source === "rtc") {
      const args = [...(envelopeArgs(payload) ?? [])];
      const ackId = envelopeAckId(payload);
      if (ackId) {
        args.push((...resp: unknown[]) => this._sendAck(ackId, resp));
      }
      const fns = this._host?.listeners?.(event) || [];
      for (const fn of fns) fn(...args);
      this._dispatchAny(this._host, event, args[0]);
      return;
    }
    if (this._host) {
      const fns = this._host.listeners?.(event) || [];
      const args = wsArgs || [payload];
      for (const fn of fns) fn(...args);
      this._dispatchAny(this._host, event, payload);
    }
  }

  _dispatchAny(host: HostEndpoint | null, event: string, payload: unknown): void {
    if (host && "dispatchAny" in host && typeof host.dispatchAny === "function") host.dispatchAny(event, payload);
  }

  /** Route incoming binary frame to "file-bin" listeners. */
  _onBinary(msg: { channel: string; buffer: Buffer | Uint8Array } | null): void {
    if (!msg || msg.channel !== "file") return;
    const fns = this._host?.listeners?.("file-bin") || [];
    for (const fn of fns) fn(msg.buffer);
  }

  _sendAck(ackId: unknown, resp: unknown[]): void {
    const adapter = this._adapters.get("rtc");
    if (adapter?.ready && adapter.send(CHANNELS.control, { event: "__ack", args: resp, ackId })) return;
    const ws = this._adapters.get("ws");
    if (ws?.ready) ws.send(CHANNELS.control, { event: "__ack", args: resp, ackId });
  }

  _sendSignaling(msg: SignalingMessage): void {
    if (isSignalingReady() && sendGlobalSignaling({ ...msg, to: this._deviceId })) return;
    if (msg.type === "answer") {
      this._sigBuffer = this._sigBuffer.filter((m) => m.type !== "answer" && m.type !== "ice");
    }
    this._sigBuffer.push(msg);
    if (this._sigBuffer.length > 32) this._sigBuffer.shift();
  }

  _flushSigBuffer(): void {
    if (!this._sigBuffer.length) return;
    const queued = this._sigBuffer;
    this._sigBuffer = [];
    for (const msg of queued) this._sendSignaling(msg);
  }
}
