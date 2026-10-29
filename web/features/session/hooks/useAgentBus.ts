import { useEffect, useState, useCallback, useRef } from "react";
import { useBus } from "@/shared/hooks/useBus";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { commitPendingKey, forgetRejectedTail } from "@/shared/transport/lib/deviceTrust";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useVoiceStore } from "@/shared/stores/voiceStore";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { WORKER_API } from "@/shared/constants/API";
import { TAIL_REJECT_REASON, LOGIN_ERROR_KEY, APPROVAL_STATUS } from "@/shared/constants/transport";
import { sameList } from "@/shared/utils/shallowEqual";
import { isNewer } from "@/shared/utils/versionCompare";
import { termLog } from "@/shared/utils/termLog";
import { debugLog } from "@/shared/utils/debugLog";
import type { AuthData } from "@/shared/hooks/useSessionStorage";
import type { ClientBus } from "@/shared/transport/types";
import type { ProtocolManager } from "@/shared/transport/ProtocolManager";

interface SessionRow {
  id: string;
  name: string;
  createdAt?: number;
  cwd?: string | null;
  workspaceId?: string | null;
  groupId?: string | null;
  workspacePath?: string | null;
  shellId?: string | null;
  shellLabel?: string | null;
  agent?: string | null;
  hostKey?: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  path?: string | null;
  [key: string]: unknown;
}

interface CreateSessionResult {
  success: boolean;
  error?: string;
  id?: string;
  sessionId?: string;
  name?: string;
  cwd?: string | null;
  replaced?: string | null;
  shellId?: string | null;
  shellLabel?: string | null;
}

export interface AgentConfig {
  id?: string;
}

export type CreateSessionCallback = (result: CreateSessionResult) => void;
export type CreateSession = {
  (name: string | null, callback: CreateSessionCallback): void;
  (
    name: string | null,
    shellId: string | null,
    workspaceId: string | null,
    cwd: string | null,
    callback: CreateSessionCallback,
    nameIsAuto?: boolean,
    agent?: AgentConfig | string | null,
    replaces?: string | null
  ): void;
};

interface FleetMainHost {
  sessions?: SessionRow[];
  workspaces?: WorkspaceRow[];
  status?: string;
  updating?: boolean;
}

interface FleetStoreSnapshot {
  currentKey: string | null;
  hosts: Record<string, FleetMainHost>;
  _patchHost: (key: string | null, patch: Record<string, unknown>) => void;
}

interface ServerInfo {
  platform: string;
  version?: string | null;
  isCodespaces?: boolean;
  updateAvailable?: { version?: string } | null;
  canSelfUpdate?: boolean;
  remoteAvailable: boolean;
  mobileAvailable?: boolean;
  caps?: unknown;
  artifactEnabled?: boolean;
  mcpClients?: unknown;
  voiceConfig?: unknown;
}

type ApprovalEvent = Parameters<ReturnType<typeof useConnectionStore.getState>["applyApproval"]>[0];
type WireResult = CreateSessionResult;
type WireCallback = (result: WireResult) => void;

// Mobile resume collapses multiple list-refresh triggers into one round-trip.
const FETCH_COALESCE_MS = 120;
// Drop duplicate list fetches across carriers (RTC then WS) within freshness window.
const FETCH_FRESH_MS = 1000;

// The main host is a fleet host like any other: its data lands in the SAME store
// entry (single lane for readers). No-op until sync() has settled currentKey.
const patchMainHost = (p: Record<string, unknown>) => {
  const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
  st._patchHost(st.currentKey, p);
};

export function useAgentBus() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [mobileAvailable, setMobileAvailable] = useState(false);
  const [platform, setPlatform] = useState<string | null>(null);
  const [hostVersion, setHostVersion] = useState<string | null>(null);
  // Admission state is store-owned (connectionStore): it belongs to the
  // connection, and a re-key resets it there — not to the component.
  const approvalStatus = useConnectionStore((s) => s.approvalStatus);
  const admitted = useConnectionStore((s) => s.admitted);
  const hostOffline = useConnectionStore((s) => s.hostOffline);
  const { getAuth } = useSessionStorage();

  // Unified handler for device approval arriving from either socket.io or DO signaling relay.
  const applyApproval = useCallback((next: ApprovalEvent) => {
    useConnectionStore.getState().applyApproval(next);
  }, []);

  // Remove one-time key from worker after device is approved
  const removeTempKey = useCallback(async () => {
    const auth = getAuth();
    if (auth?.tempKey) {
      try {
        await fetch(`${WORKER_API}/api/temp-key/remove`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tempKey: auth.tempKey })
        });
        sessionStorage.removeItem("tempKey");
      } catch (error) {
        console.error("Failed to remove temp key:", error);
      }
    }
  }, [getAuth]);

  // Ref to disconnect function from useBus needed before its definition.
  const disconnectRef = useRef<(() => void) | null>(null);

  // Track whether lists have loaded (empty array counts as loaded).
  const loadedRef = useRef({ sessions: false, workspaces: false });
  const bothLoaded = () => loadedRef.current.sessions && loadedRef.current.workspaces;

  const markLoaded = (key: "sessions" | "workspaces") => { loadedRef.current[key] = true; };

  const resetLoaded = useCallback((why: string) => {
    termLog("switch", `lists untrusted (${why}) → refetch`);
    loadedRef.current = { sessions: false, workspaces: false };
  }, []);

  // Reject non-array ack (carrier failure) to allow retry loop to continue.
  const applySessions = useCallback((list: unknown) => {
    if (!Array.isArray(list)) return;
    const sessionList = list as SessionRow[];
    markLoaded("sessions");
    for (const s of sessionList) {
      if (s?.id && s?.agent) {
        useTerminalStore.getState().setSessionAgent(s.id, s.agent);
      }
    }
    // Keep previous array reference if unchanged to avoid unnecessary re-renders.
    setSessions((prev) => (sameList(prev, sessionList) ? prev : sessionList));
    const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
    if (!sameList(st.hosts[st.currentKey || ""]?.sessions, sessionList)) patchMainHost({ sessions: sessionList });
  }, []);

  const applyWorkspaces = useCallback((list: unknown) => {
    if (!Array.isArray(list)) return;
    const workspaceList = list as WorkspaceRow[];
    markLoaded("workspaces");
    setWorkspaces((prev) => (sameList(prev, workspaceList) ? prev : workspaceList));
    const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
    if (!sameList(st.hosts[st.currentKey || ""]?.workspaces, workspaceList)) patchMainHost({ workspaces: workspaceList });
  }, []);

  // Sequence counters per list to discard out-of-order responses from multiple triggers.
  const sessionSeqRef = useRef(0);
  const workspaceSeqRef = useRef(0);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchAtRef = useRef(0);

  const emitSessions = useCallback((bus: { emit: (arg0: string,arg1: (list: unknown) => void) => void; }) => {
    const seq = ++sessionSeqRef.current;
    bus.emit("getSessions", (list: unknown) => {
      termLog("diag", `getSessions ack seq=${seq} type=${Array.isArray(list) ? "list" : typeof list} n=${Array.isArray(list) ? list.length : "-"}`);
      if (seq === sessionSeqRef.current) applySessions(list);
    });
  }, [applySessions]);

  const emitWorkspaces = useCallback((bus: { emit: (arg0: string,arg1: (list: unknown) => void) => void; }) => {
    const seq = ++workspaceSeqRef.current;
    bus.emit("getWorkspaces", (list: unknown) => { if (seq === workspaceSeqRef.current) applyWorkspaces(list); });
  }, [applyWorkspaces]);

  // Coalesce list fetch triggers into a single round-trip.
  const fetchLists = useCallback((bus: ClientBus | null, force = false) => {
    if (!bus) return;
    const targetBus = bus;
    if (force && fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    else if (fetchTimerRef.current) return;
    // Freshness counts from emit time, not ack arrival — the pre-ack window is where duplicate fetches stacked up.
    else if (Date.now() - lastFetchAtRef.current < FETCH_FRESH_MS) return;
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null;
      lastFetchAtRef.current = Date.now();
      termLog("diag", `fetchLists FIRE (bus=${bus ? "ok" : "null"} connected-already=${loadedRef.current.sessions}/${loadedRef.current.workspaces})`);
      emitWorkspaces(targetBus);
      emitSessions(targetBus);
    }, FETCH_COALESCE_MS);
  }, [emitSessions, emitWorkspaces]);

  // Client capability announcement required by agent for binary/fragmented transport.
  const CAPS = { fragOut: true, binOut: true, hb: 1, env2: 1, fragCtl: 1 };
  const announceCaps = (bus: ClientBus) => {
    termLog("switch", `caps → ${JSON.stringify(CAPS)} announced`);
    bus.emit("caps", CAPS);
  };

  // Track bound bus instance to prevent duplicate listener registration on carrier reconnect.
  const boundBusRef = useRef<ClientBus | null>(null);

  const handleBusReady = useCallback((bus: ClientBus, auth: AuthData) => {
    applyApproval(APPROVAL_STATUS.reconnect as ApprovalEvent);
    // The row follows the wire: a deliberate disconnect (or a boot into one)
    // left it offline — the moment the bus answers, it is "full" again.
    patchMainHost({ status: "full" });
    // Invalidate cached lists on reconnect until refetched.
    resetLoaded("pm-connect");

    if (boundBusRef.current === bus) {
      fetchLists(bus);
      return;
    }
    boundBusRef.current = bus;

    bus.on("device:pendingApproval", () => {
      termLog("diag", "EVENT device:pendingApproval arrived");
      debugLog("auth", "[auth] agent says: waiting for host approval");
      applyApproval(APPROVAL_STATUS.pending as ApprovalEvent);
    });

    bus.on("device:approved", () => {
      termLog("diag", "EVENT device:approved arrived → applying");
      applyApproval(APPROVAL_STATUS.approved as ApprovalEvent);
      useConnectionStore.getState().setAdmitted(true);
      // Persist key now that agent has verified and accepted it.
      commitPendingKey();
      removeTempKey();
    });

    // terminal:ready signals handlers are registered, but is not an admission verdict.
    bus.on("terminal:ready", () => {
      debugLog("auth", "[auth] terminal:ready (NOT an admission signal)");
      fetchLists(bus);
    });

    // Re-assert readiness and refetch lists on carrier reconnect.
    bus.on("connect", () => {
      resetLoaded("carrier-connect");
      bus.emit("device:clientReady");
      announceCaps(bus);
      fetchLists(bus);
    });

    bus.on("device:rejected", () => {
      termLog("diag", "EVENT device:rejected arrived → applying");
      applyApproval(APPROVAL_STATUS.rejected as ApprovalEvent);
      // Stop auto-reconnect — user must re-submit key to try again
      disconnectRef.current?.();
    });

    bus.on("device:tailRejected", (payload: unknown) => {
      const data = payload as { reason?: string };
      // seal-unreadable = stale pin (agent rotated its host key): deviceTrust drops pin and retries.
      if (data?.reason === TAIL_REJECT_REASON.sealUnreadable) return;
      // Failed tail verification drops session and redirects to login with error reason.
      disconnectRef.current?.();
      const auth = getAuth();
      forgetRejectedTail(auth?.apiKey);
      forgetRejectedTail(auth?.tempKey);
      sessionStorage.clear();
      sessionStorage.setItem(LOGIN_ERROR_KEY, data?.reason || TAIL_REJECT_REASON.mismatch);
      window.location.replace("/login");
    });

    bus.on("serverInfo", (payload: unknown) => {
      const info = payload as ServerInfo;
      // Mid-update the dying process can still speak — its notice is stale by
      // construction (the user already acted; the restart tells the truth).
      const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
      const acted = !!st.hosts[st.currentKey || ""]?.updating;
      patchMainHost({
        platform: info.platform || null,
        version: info.version || null,
        isCodespaces: !!info.isCodespaces,
        // Honest notice: only ahead-of-running versions count (see fleetStore).
        updateAvailable: !acted && isNewer(info.updateAvailable?.version, info.version) ? info.updateAvailable : null,
        canSelfUpdate: !!info.canSelfUpdate,
        remoteAvailable: !!info.remoteAvailable,
        mobileAvailable: !!info.mobileAvailable
      });
      setRemoteAvailable(!!info.remoteAvailable);
      setMobileAvailable(!!info.mobileAvailable);
      setPlatform(info.platform || null);
      setHostVersion(info.version || null);
      useTerminalStore.getState().setAgentCaps((info.caps as Record<string, unknown>) || {});
      useTerminalStore.getState().setArtifactEnabled(Boolean(info.artifactEnabled));
      useTerminalStore.getState().setMcpClients((info.mcpClients as string[]) || []);
      if (info.voiceConfig) {
        useVoiceStore.getState().syncFromHost(info.voiceConfig);
      }
    });

    bus.on("sessionClosed", (payload: unknown) => {
      const sessionId = payload as string;
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
      const cur = st.hosts[st.currentKey || ""]?.sessions;
      if (cur?.some((s) => s.id === sessionId)) patchMainHost({ sessions: cur.filter((s) => s.id !== sessionId) });
      // Clean up terminal store state for closed session.
      useTerminalStore.getState().closeSession(sessionId);
    });

    // The agent renames a terminal on its own once its conversation has a title.
    bus.on("session-renamed", (payload: unknown) => {
      const { sessionId, name } = (payload || {}) as { sessionId?: string; name: string };
      if (!sessionId) return;
      setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, name } : s)));
      const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
      const cur = st.hosts[st.currentKey || ""]?.sessions;
      if (cur?.some((s) => s.id === sessionId)) patchMainHost({ sessions: cur.map((s) => (s.id === sessionId ? { ...s, name } : s)) });
    });

    // Update session agent surface and invalidate history cache when mode changes.
    bus.on("sessionAgentChanged", (payload: unknown) => {
      const { sessionId, agent } = (payload || {}) as { sessionId?: string; agent?: string };
      if (!sessionId || !agent) return;
      useTerminalStore.getState().setSessionAgent(sessionId, agent);
      useTerminalStore.getState().invalidateAgentHistory();
    });

    // A terminal opened on another device; force, or the freshness guard eats it.
    bus.on("sessionsChanged", () => fetchLists(bus, true));

    bus.on("workspacesChanged", () => fetchLists(bus));


    // Announce capabilities on first bind in addition to carrier reconnects.
    announceCaps(bus);

    // This bus IS the connection from here on, so a verdict left by the previous
    // one is stale — cleared AFTER the listeners are on, so an answer that
    // arrived while the bus was being built is not wiped by this.
    useConnectionStore.getState().setConnection({ approvalStatus: null });

    bus.emit("device:clientReady");
  }, [removeTempKey, fetchLists, applyApproval, getAuth, resetLoaded]);

  const busResult = useBus({
    namespace: "",
    redirectOnNoAuth: "/",
    onConnect: handleBusReady,
    // Wire dropped: the row follows the wire — "connecting" while the transport
    // retries (handleBusReady lands it back on "full"). Only from "full": a
    // deliberate disconnect patches the row offline before this fires.
    onDisconnect: () => {
      const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
      if (st.hosts[st.currentKey || ""]?.status === "full") patchMainHost({ status: "connecting" });
    },
    // Agent refused over signaling — same funnel as the socket.io device:* events
    onApproval: (next: unknown) => applyApproval(next as ApprovalEvent)
  });
  const bus = busResult.bus as ClientBus | null;
  const busRef = busResult.busRef as { current: ClientBus | null };
  const protocolRef = busResult.protocolRef as { current: ProtocolManager | null };
  const { connected, connectionMode, carrier, retryStatus, disconnect, reconnect } = busResult;

  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  const loadSessions = useCallback(() => fetchLists(busRef.current), [busRef, fetchLists]);

  // Force refresh lists bypassing the freshness guard.
  const refreshLists = useCallback(() => fetchLists(busRef.current, true), [busRef, fetchLists]);

  // Pending coalesce timer must not outlive the hook.
  useEffect(() => () => {
    if (fetchTimerRef.current) { clearTimeout(fetchTimerRef.current); fetchTimerRef.current = null; }
  }, []);

  // terminal:ready is one-shot over a racy multi-carrier transport — if it or a fetch
  // ack is dropped, the lists stay empty forever. Retry while connected until each
  // list has ever received a response; receiving [] also counts (stops forever then).
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      if (bothLoaded()) return;
      loadSessions();
    }, 2000);
    return () => clearInterval(timer);
  }, [connected, loadSessions]);

  // Refetch lists when tab becomes visible if connected.
  useEffect(() => {
    if (!connected) return;
    const refetch = () => {
      if (document.visibilityState !== "visible") return;
      loadSessions();
    };
    refetch();
    document.addEventListener("visibilitychange", refetch);
    return () => document.removeEventListener("visibilitychange", refetch);
  }, [connected, loadSessions]);

  // Create session; nameIsAuto indicates UI-generated placeholder name.
  const createSessionImpl = useCallback((
    name: string | null,
    shellIdArg: string | null | CreateSessionCallback,
    workspaceIdArg?: string | null | CreateSessionCallback,
    cwdArg?: string | null | CreateSessionCallback,
    callbackArg?: CreateSessionCallback,
    nameIsAuto = false,
    agent: AgentConfig | string | null = null,
    replaces: string | null = null
  ) => {
    if (!busRef.current) return;
    let shellId = shellIdArg;
    let workspaceId = workspaceIdArg;
    let cwd = cwdArg;
    let callback = callbackArg;
    // Backward compat: createSession(name, callback) / createSession(name, shellId, callback)
    if (typeof shellId === "function") { callback = shellId; shellId = null; workspaceId = null; cwd = null; }
    else if (typeof workspaceId === "function") { callback = workspaceId; workspaceId = null; cwd = null; }
    else if (typeof cwd === "function") { callback = cwd; cwd = null; }

    const agentId = typeof agent === "string" ? agent : agent?.id || null;
    busRef.current.emit("createSession", { name, shellId, workspaceId, cwd, nameIsAuto, agent: agentId, replaces }, (response: unknown) => {
      const result = response as CreateSessionResult;
      if (result?.success) {
        if (result.sessionId) {
          if (agentId) useTerminalStore.getState().setSessionAgent(result.sessionId, agentId);
          const wsPath = workspaces.find((w) => w.id === workspaceId)?.path || null;
          const entry = {
            id: result.sessionId,
            name: result.name || name || "Terminal",
            createdAt: Date.now(),
            cwd: result.cwd || cwd || null,
            workspaceId: workspaceId || null,
            groupId: workspaceId || null,
            workspacePath: wsPath,
            shellId: result.shellId || shellId || null,
            shellLabel: result.shellLabel || null,
            agent: agentId || null
          };
          const merge = (prev: SessionRow[]) => [
            // The terminal this one replaced goes in the same update to avoid holding both.
            ...prev.filter((s) => s.id !== result.sessionId && s.id !== result.replaced),
            entry
          ];
          setSessions(merge);
          const st = useFleetStore.getState() as unknown as FleetStoreSnapshot;
          const cur = st.hosts[st.currentKey || ""]?.sessions;
          if (cur) patchMainHost({ sessions: merge(cur) });
        }
        refreshLists();
      }
      callback?.(result);
    });
  }, [busRef, refreshLists, workspaces]);
  const createSession = createSessionImpl as CreateSession;

  const createWorkspace = useCallback((name: string, wsPath: string | null | WireCallback | undefined, callback?: WireCallback) => {
    if (typeof wsPath === "function") { callback = wsPath; wsPath = null; }
    busRef.current?.emit("createWorkspace", { name, path: wsPath }, (response: unknown) => { const result = response as WireResult; if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const renameWorkspace = useCallback((workspaceId: string, name: string, callback?: WireCallback) => {
    busRef.current?.emit("renameWorkspace", { workspaceId, name }, (response: unknown) => { const result = response as WireResult; if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const deleteWorkspace = useCallback((workspaceId: string, callback?: WireCallback) => {
    busRef.current?.emit("deleteWorkspace", { workspaceId }, (response: unknown) => { const result = response as WireResult; if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const setWorkspaceHiddenRepos = useCallback((workspaceId: string, paths: string[], callback?: WireCallback) => {
    busRef.current?.emit("setWorkspaceHiddenRepos", { workspaceId, paths }, (response: unknown) => { const result = response as WireResult; if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const moveSession = useCallback((sessionId: string, workspaceId: string | null, callback?: WireCallback) => {
    busRef.current?.emit("moveSession", { sessionId, workspaceId }, (response: unknown) => { const result = response as WireResult; if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const reorderSession = useCallback((orderedIds: string[], callback?: WireCallback) => {
    busRef.current?.emit("reorderSession", { orderedIds }, (response: unknown) => { const result = response as WireResult; if (result?.success) refreshLists(); callback?.(result); });
  }, [busRef, refreshLists]);

  const getShells = useCallback((callback?: (result: unknown) => void) => {
    if (!busRef.current) return;
    busRef.current.emit("getShells", (result: unknown) => callback?.(result));
  }, [busRef]);

  const deleteSession = useCallback((sessionId: string, callback?: WireCallback) => {
    if (!busRef.current) return;

    busRef.current.emit("deleteSession", sessionId, (response: unknown) => {
      const result = response as WireResult;
      if (result.success) refreshLists();
      callback?.(result);
    });
  }, [busRef, refreshLists]);

  const renameSession = useCallback((sessionId: string, newName: string, callback?: WireCallback) => {
    if (!busRef.current) return;

    busRef.current.emit("renameSession", { sessionId, name: newName }, (response: unknown) => {
      const result = response as WireResult;
      if (result.success) refreshLists();
      callback?.(result);
    });
  }, [busRef, refreshLists]);

  return {
    bus,
    busRef,
    protocolRef,
    disconnect,
    reconnect,
    connected,
    connectionMode,
    carrier,
    retryStatus,
    approvalStatus,
    admitted,
    hostOffline,
    sessions,
    remoteAvailable,
    mobileAvailable,
    platform,
    hostVersion,
    agentVersion: hostVersion,
    workspaces,
    loadSessions,
    createSession,
    getShells,
    deleteSession,
    renameSession,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setWorkspaceHiddenRepos,
    moveSession,
    reorderSession
  };
}
