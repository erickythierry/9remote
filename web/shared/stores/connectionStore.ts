"use client";

import { create } from "zustand";
import type { createClientBus } from "@/shared/transport/lib/clientBus.js";

type ClientBus = ReturnType<typeof createClientBus>;
type ApprovalEvent = "pending" | "approved" | "rejected" | "reconnect";
export type ApprovalState = Exclude<ApprovalEvent, "reconnect"> | null;
type ConnectionMode = "tunnel" | "local";
type Carrier = "ws" | "webrtc";

interface Ref<T> {
  current: T | null;
}

export interface ProtocolReference {
  setUpdating?(updating: boolean): void;
  disconnect?(): void;
  connect?(): void;
  connectionMode?: string;
}

export interface RetryStatus {
  isRetrying: boolean;
  attempt: number;
  maxAttempts: number;
  failed: boolean;
}

interface ConnectionPatch {
  bus?: ClientBus | null;
  busRef?: Ref<ClientBus>;
  protocolRef?: Ref<ProtocolReference>;
  connected?: boolean;
  everConnected?: boolean;
  deliberate?: boolean;
  connectionMode?: ConnectionMode;
  carrier?: Carrier;
  approvalStatus?: ApprovalState;
  admitted?: boolean;
  authKey?: string | null;
  endpoint?: string | null;
  retryStatus?: RetryStatus;
  hostOffline?: boolean;
}

interface ConnectionStore extends Required<Omit<ConnectionPatch, "busRef" | "protocolRef">> {
  busRef: Ref<ClientBus>;
  protocolRef: Ref<ProtocolReference>;
  setConnection(patch: ConnectionPatch): void;
  setConnected(connected: boolean): void;
  setCarrier(carrier: Carrier): void;
  setConnectionMode(connectionMode: ConnectionMode): void;
  setRetryStatus(retryStatus: RetryStatus): void;
  setHostOffline(hostOffline: boolean): void;
  setAuthKey(authKey: string | null): void;
  setAdmitted(admitted: boolean): void;
  applyApproval(next: ApprovalEvent): void;
  reset(): void;
}

const initialRetryStatus: RetryStatus = { isRetrying: false, attempt: 0, maxAttempts: 10, failed: false };

export const useConnectionStore = create<ConnectionStore>((set) => ({
  bus: null,
  busRef: { current: null },
  protocolRef: { current: null },
  connected: false,
  // True once any connection has come up in this page's life. Establishing
  // the FIRST connection is "connecting", not "connection lost" — the loading
  // screen owns that phase, and the retry modal with its buttons must not
  // flash over it on a slow first attempt.
  everConnected: false,
  // The user dropped this connection on purpose ( Disconnect): the workspace
  // must not cover itself with the loading gate or the retry screen — the
  // host's row shows offline and its connect button is the way back.
  deliberate: false,
  connectionMode: "tunnel",
  carrier: "ws",
  // Device admission for the ACTIVE host's connection — store-owned (not hook
  // state) so a re-key resets them with the connection, not with a component.
  approvalStatus: null,
  admitted: false,
  // The host's apiKey HEAD the workspace connection serves. Reactive mirror of
  // sessionStorage — setAuthData bumps it and useBus re-keys in place, which is
  // what makes switching hosts possible without a page reload.
  authKey: null,
  // The WS endpoint actually in use (auth.tunnelUrl at connect time) — the
  // status bar shows it so "local vs tunnel" is verifiable, not guessed.
  endpoint: null,
  retryStatus: { ...initialRetryStatus },
  // The Worker vouched the host process is down (/api/connect 503
  // agent-offline) — a standing verdict like approvalStatus, cleared on
  // connect or manual retry (both re-ask the Worker).
  hostOffline: false,

  setConnection: (patch) => set((prev) => ({ ...prev, ...patch })),
  setConnected: (connected) => set({ connected }),
  setCarrier: (carrier) => set({ carrier }),
  setConnectionMode: (connectionMode) => set({ connectionMode }),
  setRetryStatus: (retryStatus) => set({ retryStatus }),
  setHostOffline: (hostOffline) => set({ hostOffline }),
  setAuthKey: (authKey) => set({ authKey }),
  setAdmitted: (admitted) => set({ admitted }),
  // Unified device-approval verdict, arriving from socket.io OR the DO
  // signaling relay. A reconnect keeps a standing approval; a pending after
  // approved is a stale late signal.
  applyApproval: (next) => set((prev) => {
    const cur = prev.approvalStatus;
    if (next === "reconnect") {
      return { approvalStatus: cur === "approved" ? null : cur };
    }
    if (cur === "approved" && next === "pending") {
      return { approvalStatus: cur };
    }
    return { approvalStatus: next };
  }),
  // NOTE: reset() deliberately keeps authKey — a transient disconnect must not
  // look like a host switch (which would tear the connection down). Admission
  // state DOES reset: it belongs to the connection being dropped.
  reset: () => set({
    bus: null,
    connected: false,
    deliberate: false,
    everConnected: false,
    connectionMode: "tunnel",
    carrier: "ws",
    endpoint: null,
    approvalStatus: null,
    admitted: false,
    hostOffline: false,
    retryStatus: { ...initialRetryStatus }
  })
}));
