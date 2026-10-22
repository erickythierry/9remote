import { ADAPTER_STATE } from "../lib/transportConstants.js";
import type { HostBus } from "./HostBus.js";
import type { Socket } from "socket.io";
import type { SignalingMessage } from "./SignalingClient.js";

export type ProtocolState = typeof ADAPTER_STATE[keyof typeof ADAPTER_STATE];
export type ProtocolMessage = { event: string; data?: unknown; args?: unknown[]; source?: string };
export type ProtocolBinaryMessage = { channel: string; buffer: Buffer | Uint8Array };
export type ProtocolEventMap = {
  stateChange: [ProtocolState];
  message: [ProtocolMessage];
  binary: [ProtocolBinaryMessage];
  error: [Error];
};
export type ProtocolProfile = {
  enabled: string[];
  channels: Record<string, { strategy: string; prefer?: string }>;
  rtc?: { enableTurn: boolean; turnApiUrl: string | null; turnRefreshInterval: number; dcMaxMessageSize: number; answerTimeout: number };
};
export type ProtocolContext = {
  auth: { apiKey: string | null; socketId: string | null };
  profile: ProtocolProfile;
  socket?: Socket | HostBus | null;
  signaling?: {
    send: (message: SignalingMessage) => void;
    on: (handler: (message: SignalingMessage) => void) => void;
    off: () => void;
  };
};
type ProtocolClass = typeof BaseProtocol & { id: string; capabilities: Record<string, boolean | string>; priority: Record<string, number> };
type ProtocolListener = (...args: unknown[]) => void;

/**
 * BaseProtocol — server-side adapter contract.
 *
 * Static metadata (declare in subclass): id, capabilities, priority
 *
 * Events: "stateChange"(state), "message"({event,data}), "binary"(buf), "error"(err)
 * Methods: connect(ctx), disconnect(), send(channel, payload)
 */
export class BaseProtocol {
  static id = "base";
  static capabilities = { control: false, binary: false, file: false, signaling: "none" };
  static priority = { control: 0, binary: 0, file: 0 };

  declare protected _listeners: Map<string, Set<ProtocolListener>>;
  declare protected _state: ProtocolState;

  constructor() {
    this._listeners = new Map();
    this._state = ADAPTER_STATE.idle;
  }

  get state() { return this._state; }
  get ready() { return this._state === ADAPTER_STATE.open; }

  supports(channel: string): boolean {
    return Boolean((this.constructor as ProtocolClass).capabilities[channel]);
  }

  getPriority(channel: string): number {
    return (this.constructor as ProtocolClass).priority[channel] ?? 0;
  }

  on<K extends keyof ProtocolEventMap>(event: K, handler: (...args: ProtocolEventMap[K]) => void): void {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event)?.add(handler as ProtocolListener);
  }

  off<K extends keyof ProtocolEventMap>(event: K, handler: (...args: ProtocolEventMap[K]) => void): void {
    this._listeners.get(event)?.delete(handler as ProtocolListener);
  }

  protected _emit<K extends keyof ProtocolEventMap>(event: K, ...args: ProtocolEventMap[K]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const h of set) h(...args);
  }

  protected _setState(next: ProtocolState): void {
    if (this._state === next) return;
    this._state = next;
    this._emit("stateChange", next);
  }

  connect(_ctx: ProtocolContext): void | Promise<void> { throw new Error("Not implemented: connect"); }
  disconnect() { throw new Error("Not implemented: disconnect"); }
  send(_channel: string, _payload: unknown): boolean { throw new Error("Not implemented: send"); }
}
