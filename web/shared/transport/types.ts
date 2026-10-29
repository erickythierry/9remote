export type TransportChannel = "control" | "binary" | "file" | "mobile" | "browser";

export type TransportAuth = {
  apiKey?: string;
  tempKey?: string | null;
  tunnelUrl?: string | null;
  localIp?: string | null;
  deviceId?: string;
  namespace?: string;
  socketOptions?: { auth?: Record<string, unknown>; [key: string]: unknown };
  keyTail?: string;
  keyTailSealed?: { epk: string; iv: string; ct: string };
  [key: string]: unknown;
};

export type TransportCallbacks = {
  onConnect?: (...args: unknown[]) => unknown;
  onDisconnect?: (...args: unknown[]) => unknown;
  onRetryStatus?: (...args: unknown[]) => unknown;
  onUrlUpdate?: (...args: unknown[]) => unknown;
  onApproval?: (status: "pending" | "rejected") => unknown;
  onHostOffline?: () => unknown;
  onUpgrade?: (...args: unknown[]) => unknown;
  onFallback?: (...args: unknown[]) => unknown;
  onTransportChange?: (...args: unknown[]) => unknown;
};

export type TransportProfile = {
  enabled: string[];
  parallel?: boolean;
  channels: Partial<Record<TransportChannel, { strategy?: string; prefer?: string }>>;
  rtc?: { enableTurn?: boolean; dcControl?: { ordered?: boolean } };
};

export type AdapterContext = {
  auth: TransportAuth;
  profile: TransportProfile;
  onRetryStatus?: (...args: unknown[]) => unknown;
  onUrlUpdate?: (update: { tunnelUrl?: string; localIp?: string | null }) => unknown;
  onHostOffline?: () => unknown;
  signaling?: {
    send(message: SignalingMessage): unknown;
    on(handler: (message: SignalingMessage) => unknown): unknown;
    off(): unknown;
  };
};

export type ControlEnvelope = { event: string; args: unknown[]; cb?: AckCallback | null };
export type AckCallback = (...args: unknown[]) => unknown;

export type ProtocolAdapter = {
  ready: boolean;
  state: string;
  connectionMode?: string;
  socket?: { id?: string; disconnect?: () => unknown } | null;
  typeDetail?: string;
  isLoopback?: boolean;
  _peerEpoch?: number;
  blocked?: boolean;
  lastInboundAt?: number;
  lastMsgAt?: number;
  connectingSince?: number | null;
  connectDeadline?: number | null;
  natVerdict?(): string | null;
  _pc?: RTCPeerConnection | null;
  connect(ctx: unknown): unknown;
  disconnect(reason?: string): unknown;
  send(channel: string, payload: unknown): boolean;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  setBlocked?(blocked: boolean): unknown;
  setUpdating?(updating: boolean): unknown;
  forceReconnect?(): unknown;
  retryNow?(reason?: string): unknown;
  setPeerCaps?(caps: unknown): unknown;
  getPriority?(channel: string): number;
  supports(channel: string): boolean;
};

export type ClientBus = {
  _listeners: Map<string, Array<AckCallback & { _original?: AckCallback }>>;
  connected: boolean;
  id: string | null;
  emit(event: string, ...args: unknown[]): void;
  on(event: string, handler: AckCallback): void;
  off(event: string, handler: AckCallback): void;
  once(event: string, handler: AckCallback): void;
  listeners(event: string): AckCallback[];
  dispatch(event: string, args?: unknown[]): void;
  clear(): void;
  disconnect(): void;
  kickWsZombie(reason?: string): boolean;
};

export type SignalingMessage = { type: string; [key: string]: unknown };
export type SignalingClientLike = {
  ready: boolean;
  send(message: SignalingMessage): boolean;
  on(handler: (message: SignalingMessage) => unknown): void;
  connect(): unknown;
  disconnect(): unknown;
  retryNow?(reason?: string): unknown;
};

export type ProtocolManagerContext = {
  _profile: TransportProfile;
  _auth: TransportAuth;
  _wsCallbacks: TransportCallbacks;
  _rtcCallbacks: TransportCallbacks;
  _peerId: string;
  _adapters: Map<string, ProtocolAdapter>;
  _buffer: ControlEnvelope[];
  _pendingAcks: Map<string, AckCallback>;
  _ackTimers: Map<string, ReturnType<typeof setTimeout>>;
  _ackSeq: number;
  _rtcRestartAttempts: number;
  _rtcRestartTimer: ReturnType<typeof setTimeout> | null;
  _rtcRestartDueAt: number;
  _probeAttempts: number;
  _rtcGivenUp: boolean;
  _giveUpIp: string | null;
  _lastStunProbeAt: number;
  _rejoinDebounceTimer: ReturnType<typeof setTimeout> | null;
  _netFingerprint: string | null;
  _awaitingApproval: boolean;
  _ackTimeoutMs: number;
  _hiddenAt: number | null;
  _resumeProbeTimer: ReturnType<typeof setTimeout> | null;
  _resumeCoalesceTimer?: ReturnType<typeof setTimeout> | null;
  _netDebounceTimer?: ReturnType<typeof setTimeout> | null;
  _probeToken: number;
  _probeLive: { rtc: ProtocolAdapter; token: number } | null;
  _connected: boolean;
  _type: string;
  _connectionMode: string;
  _lastWsState: string | null;
  _rawSocket: { id?: string; disconnect?: () => unknown } | null;
  _onConnectFired: boolean;
  _rtcSignalingHandler: ((message: SignalingMessage) => unknown) | null;
  _sig: SignalingClientLike | null;
  _sigDestroyed: boolean;
  _sigBuffer: SignalingMessage[];
  _wsFallbackTimer: ReturnType<typeof setTimeout> | null;
  _rtcDeferTimer?: ReturnType<typeof setTimeout> | null;
  _rtcTestDisabled?: boolean;
  _srvCaps?: unknown;
  _bus: ClientBus;
  busRef: { current: ClientBus };
  _watchers: { visibilityHandler: () => void; detach: () => void } | null;
  _tailProofSent?: number;
  _anyAdapterReady(): boolean;
  _pickAdapter(channel: TransportChannel): ProtocolAdapter | null;
  _sendControl(event: string, args: unknown[]): void;
  _scheduleAckTimeout(ackId: string, ctx?: { event: string; args: unknown[] }): void;
  _canSignal(): boolean;
  _restartRtc(reason: string): void;
  _startSecondaryAdapters(): void;
  _startWsFallback(): void;
  _maybeFireRejoin(adapterId: string, reason: string): void;
  _maybeRearmRtc(): void;
  _forceRestartRtc(reason: string): void;
  _scheduleRtcRestart(reason: string): void;
  _shouldRenegotiate(): boolean;
  retryNow(reason?: string): void;
  _disarmRestart(): void;
  kickWsZombie(reason?: string): boolean;
};
