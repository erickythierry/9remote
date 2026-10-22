import { io, Socket } from "socket.io-client";
import { freshAuth } from "./freshAuth";
import { DefaultEventsMap } from "@socket.io/component-emitter";
import { TransportAuth } from "../types";
import type { AdapterContext, TransportCallbacks } from "../types";

type LocalFirstOptions = {
  tunnelUrl: string;
  localIp?: string | null;
  namespace?: string;
  socketOptions?: { auth?: TransportAuth; [key: string]: unknown };
};
type AdapterResult = { onSocket(socket: Socket<DefaultEventsMap, DefaultEventsMap>, mode: string): void; onFail?(): void };

const DEFAULT_SOCKET_OPTIONS = {
  transports: ["websocket"],
  reconnection: false
};

/**
 * LocalFirstAdapter — probes local LAN first, falls back to tunnel on error.
 * No timeout — relies on connect_error which fires immediately on TCP failure.
 */
export class LocalFirstAdapter {
  declare _tunnelUrl: string;
  declare _localIp: string | null | undefined;
  declare _namespace: string;
  declare _socketOptions: NonNullable<LocalFirstOptions["socketOptions"]>;

  constructor({ tunnelUrl, localIp, namespace = "", socketOptions = {} }: LocalFirstOptions) {
    this._tunnelUrl = tunnelUrl;
    this._localIp = localIp;
    this._namespace = namespace;
    this._socketOptions = socketOptions;
  }

  connect({ onSocket, onFail }: AdapterResult) {
    // socket.io keeps emitting connect_error after a successful connect (later
    // transport errors), so the local probe's error handler could fire once the
    // local socket had already won — spawning a pointless second socket to the
    // tunnel. One settle per connect attempt.
    let settled = false;
    const win = (socket: Socket<DefaultEventsMap,DefaultEventsMap>, mode: string) => { if (settled) { try { socket.disconnect(); } catch {} return; } settled = true; onSocket(socket, mode); };
    const fail = () => { if (settled) return; settled = true; onFail?.(); };
    const mkUrl = (base: string) => this._namespace ? `${base}${this._namespace}` : base;
    const mkOpts = (mode: string) => ({
      ...DEFAULT_SOCKET_OPTIONS,
      ...this._socketOptions,
      path: "/socket.io",
      // Function form: socket.io calls it per (re)connect, so a TAIL that
      // arrived mid-session (enrollment) is picked up without a fresh mount.
      auth: (cb: ((value: TransportAuth) => TransportAuth|PromiseLike<TransportAuth>)|null|undefined) => { freshAuth(this._socketOptions.auth, mode).then(cb); }
    });

    const connectTunnel = () => {
      // Mode label follows the ENDPOINT, not the code path: connecting to the
      // page's own origin (host-served workspace) IS the local carrier, even
      // though it rides this function rather than the localIp probe.
      const mode = this._tunnelUrl === window.location.origin ? "local" : "tunnel";
      const socket = io(mkUrl(this._tunnelUrl), mkOpts(mode));
      socket.once("connect", () => win(socket, mode));
      socket.once("connect_error", () => fail());
    };

    // HTTPS pages block ws:// (Mixed Content), and no localIp means no probe
    // target — both go straight to the tunnel URL (which in local mode IS the
    // loopback origin, so nothing is lost by skipping the probe).
    if (!this._localIp || window.location.protocol === "https:") {
      connectTunnel();
      return;
    }

    const localSocket = io(mkUrl(`http://${this._localIp}`), mkOpts("local"));
    localSocket.once("connect", () => win(localSocket, "local"));
    localSocket.once("connect_error", () => {
      // Only fall back while the local probe is still the live attempt — a late
      // error after it connected must not open a second socket to the tunnel.
      if (settled) return;
      localSocket.disconnect();
      connectTunnel();
    });
  }
}
