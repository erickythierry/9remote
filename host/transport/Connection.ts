import { EventEmitter } from "events";
import { CONNECTION_STATE, AUTH_EVENTS } from "../lib/connectionConstants.js";
import type { ProtocolManager } from "./ProtocolManager.js";

export type ConnectionState = typeof CONNECTION_STATE[keyof typeof CONNECTION_STATE];
export type ConnectionCarrier = { ready?: boolean; disconnect?: (...args: unknown[]) => unknown } | null;
export type ConnectionData = {
  auth?: {
    deviceId?: string;
    apiKey?: string | null;
    peerId?: string;
    tempKey?: string | null;
    keyTail?: string;
    keyTailSealed?: { epk: string; iv: string; ct: string } | null;
    localToken?: string;
  } | null;
  conn?: Connection;
  approved?: boolean;
  rtcSession?: boolean;
  ready?: Promise<void>;
  localUi?: boolean;
  provenDevice?: boolean;
  clientReady?: boolean;
  sessionReady?: boolean;
  unlocking?: boolean;
  awaitingProof?: boolean;
  authHandlersReady?: boolean;
  protocol?: ProtocolManager;
  tailReject?: { reason: string | null | undefined; penaltyMs: number };
  tailRejectFinished?: boolean;
};

// Device connection model managing multi-carrier lifecycle and auth state machine.
export class Connection extends EventEmitter {
  declare readonly deviceId: string;
  declare readonly peerId: string;
  declare readonly apiKey: string | null;
  declare readonly createdAt: number;
  declare readonly data: ConnectionData;
  declare private _state: ConnectionState;
  declare private _carriers: Map<string, ConnectionCarrier>;

  constructor({ deviceId, peerId = null, apiKey = null }: { deviceId: string; peerId?: string | null; apiKey?: string | null }) {
    super();
    this.setMaxListeners(0);
    this.deviceId = deviceId;
    this.peerId = peerId || deviceId;
    this.apiKey = apiKey;
    this.createdAt = Date.now();
    this.data = {};
    this._state = CONNECTION_STATE.authenticating;
    this._carriers = new Map();
  }

  get state() { return this._state; }
  get active() { return this._state === CONNECTION_STATE.active; }
  get closed() { return this._state === CONNECTION_STATE.closed; }

  get carrierIds() { return [...this._carriers.keys()]; }

  get connected() {
    for (const c of this._carriers.values()) if (c?.ready) return true;
    return false;
  }

  // Attach carrier idempotently; replaces existing carrier with same id.
  attach(id: string, carrier: ConnectionCarrier): boolean {
    if (this.closed) return false;
    const prev = this._carriers.get(id);
    if (prev && prev !== carrier) this._detachOne(id, prev);
    this._carriers.set(id, carrier);
    this.emit("carrierAttached", id, carrier);
    return true;
  }

  detach(id: string): boolean {
    const carrier = this._carriers.get(id);
    if (!carrier) return false;
    this._detachOne(id, carrier);
    return true;
  }

  private _detachOne(id: string, carrier: ConnectionCarrier): void {
    this._carriers.delete(id);
    this.emit("carrierDetached", id, carrier);
  }

  hasCarrier(id: string): boolean { return this._carriers.has(id); }
  carrier(id: string): ConnectionCarrier | null { return this._carriers.get(id) || null; }

  // Only auth events are allowed across an inactive connection.
  allows(event: string): boolean {
    if (this.active) return true;
    if (this.closed) return false;
    return AUTH_EVENTS.has(event);
  }

  keyProven() {
    if (this._state !== CONNECTION_STATE.authenticating) return false;
    return this._transition(CONNECTION_STATE.awaitingHost, "key-proven");
  }

  // Transition to active state once key is proven and host allows device.
  hostAllowed() {
    if (this._state !== CONNECTION_STATE.awaitingHost) return false;
    return this._transition(CONNECTION_STATE.active, "host-allowed");
  }

  close(reason: string | null = "closed"): boolean {
    if (this.closed) return false;
    for (const [id, carrier] of [...this._carriers]) this._detachOne(id, carrier);
    return this._transition(CONNECTION_STATE.closed, reason);
  }

  private _transition(next: ConnectionState, reason: string | null): boolean {
    const from = this._state;
    this._state = next;
    this.emit("state", { from, to: next, reason, deviceId: this.deviceId });
    return true;
  }

  toJSON() {
    return {
      deviceId: this.deviceId,
      peerId: this.peerId,
      state: this._state,
      carriers: this.carrierIds,
      createdAt: this.createdAt
    };
  }
}
