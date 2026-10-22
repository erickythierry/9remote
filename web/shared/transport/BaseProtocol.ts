import { ADAPTER_STATE } from "@/shared/constants/transport";

type AdapterState = typeof ADAPTER_STATE[keyof typeof ADAPTER_STATE];

/**
 * BaseProtocol — adapter contract.
 *
 * Static metadata (declare in subclass):
 *   id            — "ws" | "rtc" | ...
 *   capabilities  — { control: bool, binary: bool, signaling: "ws"|"http"|"none" }
 *   priority      — { control: number, binary: number }  (higher = preferred)
 *
 * Lifecycle events emitted via on(event, handler):
 *   "stateChange"(state)         — idle|connecting|open|degraded|closed
 *   "message"({ event, data })   — incoming control event (from any channel)
 *   "binary"(buffer)             — incoming binary frame
 *   "error"(err)
 *
 * Interface:
 *   connect(ctx)                  — ctx = { auth, signaling, profile }
 *   disconnect()
 *   send(channel, payload)        — channel: "control" | "binary"
 *   on(event, handler) / off(event, handler)
 *   get state                     — current ADAPTER_STATE
 *   get ready                     — bool
 *   supports(channel)             — bool — derived from capabilities
 */
export class BaseProtocol {
  static id: string = "base";
  static capabilities: Record<string, boolean | string> = { control: false, binary: false, signaling: "none" };
  static priority: Record<string, number> = { control: 0, binary: 0 };

  declare _listeners: Map<string, Set<(...args: unknown[]) => void>>;
  declare _state: AdapterState;

  constructor() {
    this._listeners = new Map();
    this._state = ADAPTER_STATE.idle;
  }

  get state() { return this._state; }
  get ready() { return this._state === ADAPTER_STATE.open; }

  supports(channel: string) {
    const adapterClass = this.constructor as typeof BaseProtocol;
    return Boolean(adapterClass.capabilities[channel]);
  }

  getPriority(channel: string) {
    const adapterClass = this.constructor as typeof BaseProtocol;
    return adapterClass.priority[channel] ?? 0;
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    let listeners = this._listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(event, listeners);
    }
    listeners.add(handler);
  }

  off(event: string, handler: (...args: unknown[]) => void) {
    this._listeners.get(event)?.delete(handler);
  }

  _emit(event: string, ...args: unknown[]) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const h of set) h(...args);
  }

  _setState(next: AdapterState) {
    if (this._state === next) return;
    this._state = next;
    this._emit("stateChange", next);
  }

  // Subclasses must implement
  connect(_ctx: unknown) { throw new Error("Not implemented: connect"); }
  disconnect() { throw new Error("Not implemented: disconnect"); }
  send(_channel: string, _payload: unknown) { throw new Error("Not implemented: send"); }
}
