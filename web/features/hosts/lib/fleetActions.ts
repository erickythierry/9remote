"use client";

import { useFleetStore, fleetBusOf, emitWhenReady } from "@/shared/stores/fleetStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { switchHost } from "./switchHost";
import { agentLaunchCommand } from "@/features/terminal/constants/agentCli";
import { scopedWsId, type FleetHost, type FleetSession } from "./fleetTree";

export interface FleetActionsOptions {
  onSelectSession?: ((sessionId: string, pendingWorkspaceId?: string | null) => void) | null;
  onSelectWorkspace?: ((workspaceId: string) => void) | null;
}

export interface FleetActions {
  selectSession: (sessionId: string) => void;
  selectWorkspace: (rawId?: string | null) => Promise<void>;
  createSession: (
    name: string | null,
    workspaceId: string | null,
    shellId: string | null,
    cwd?: string | null,
    agent?: any,
    yolo?: boolean,
    nameIsAuto?: boolean,
    callback?: (res: any) => void
  ) => void;
  createWorkspace: (name: string, path?: string | null, callback?: ((res: any) => void) | null) => void;
  renameSession: (sessionId: string, name: string) => void;
  deleteSession: (sessionId: string) => void;
  reorderSession: (orderedIds: string[]) => void;
  renameWorkspace: (workspaceId: string, name: string) => void;
  deleteWorkspace: (workspaceId: string) => void;
  renameHost?: (key: string, name: string) => void;
  deleteHost?: (key: string) => void;
  backgroundSession?: (session: any) => void;
}

/**
 * The same action set the main host gets from nav/useAgentBus, implemented over a
 * fleet background bus — the DRY seam: a tree never learns which kind of host it
 * draws, it just consumes these. Emits use the host's RAW ids (the host knows its
 * own); optimistic patches keep the tree responsive until the host's
 * sessionsChanged broadcast refetch lands.
 */
export function makeFleetActions(
  host: { key: string; full?: string | null; [key: string]: any },
  { onSelectSession = null, onSelectWorkspace = null }: FleetActionsOptions = {}
): FleetActions {
  const bus = () => fleetBusOf(host.key);

  const patchSessions = (fn: (prev: FleetSession[]) => FleetSession[]) => {
    const st = useFleetStore.getState();
    const cur = (st.hosts[host.key]?.sessions as FleetSession[]) || [];
    st._patchHost(host.key, { sessions: fn(cur) });
  };

  return {
    // Selecting is also the lazy-connect door: a tap opens the host's bus if it
    // is not up yet (side effects belong here, never in a render path).
    selectSession: (sessionId: string) => {
      useFleetStore.getState().ensureHost(host.key);
      onSelectSession?.(sessionId);
    },
    // Opening another host's workspace IS the switch: verify + re-key in place
    // (no reload), then select it as the viewed host's own — its ids are the
    // unscoped set now. An unreachable target falls back to the foreign view,
    // so the tap always does something.
    selectWorkspace: async (rawId?: string | null) => {
      const st = useFleetStore.getState();
      if (host.key && host.key !== st.currentKey) {
        try {
          await switchHost(host.full || host.key);
          onSelectWorkspace?.(rawId ?? "_");
          return;
        } catch { /* unreachable — view it as a foreign workspace instead */ }
      }
      onSelectWorkspace?.(scopedWsId(host.key, rawId ?? "_"));
    },
    createSession: (name, workspaceId, shellId, cwd, agent, yolo, nameIsAuto, callback) => {
      // The modal hands the picked OPTION object; the wire and the tree want its id.
      const agentOpt = typeof agent === "string" ? null : agent;
      const agentId = typeof agent === "string" ? agent : (agent?.id || null);
      // The host stores the id but never launches the CLI — the client types the
      // startup line on join, exactly like the main host's create flows do.
      const startupCmd = agentLaunchCommand(agentOpt, yolo);
      // Deferred when the lazy bus is still opening — fires on connect, never dropped.
      emitWhenReady(host.key, (b: any) => b.emit("createSession",
        { name, shellId, workspaceId, cwd, nameIsAuto, agent: agentId },
        (res: any) => {
          if (res?.success && res.sessionId) {
            if (startupCmd) useTerminalStore.getState().queueStartup(res.sessionId, startupCmd);
            if (agentId) useTerminalStore.getState().setSessionAgent(res.sessionId, agentId);
            patchSessions((prev) => prev.some((s) => s.id === res.sessionId) ? prev : [...prev, {
              id: res.sessionId, name: res.name || name || "", createdAt: Date.now(),
              cwd: res.cwd || cwd || null, workspaceId: workspaceId || null,
              shellId: res.shellId || shellId || null, agent: agentId
            }]);
            // Scoped workspace rides along: nav's session list has not absorbed the
            // optimistic patch yet (same tick), so selection by id alone would no-op.
            onSelectSession?.(res.sessionId, scopedWsId(host.key, workspaceId ?? "_"));
          }
          callback?.(res);
        }));
    },
    createWorkspace: (name, path = null, callback = null) => {
      // Same wire + ack as the main host's createWorkspace — the caller owns the post-flow.
      emitWhenReady(host.key, (b: any) => b.emit("createWorkspace", { name, path }, (res: any) => callback?.(res)));
    },
    renameSession: (sessionId, name) => {
      bus()?.emit("renameSession", { sessionId, name }, () => {});
      patchSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name } : s)));
    },
    deleteSession: (sessionId) => {
      bus()?.emit("deleteSession", sessionId, () => {});
      patchSessions((prev) => prev.filter((s) => s.id !== sessionId));
    },
    reorderSession: (orderedIds) => {
      bus()?.emit("reorderSession", { orderedIds }, () => {});
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      patchSessions((prev) => [...prev].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)));
    },
    renameWorkspace: (workspaceId, name) => {
      bus()?.emit("renameWorkspace", { workspaceId, name }, () => {});
    },
    deleteWorkspace: (workspaceId) => {
      bus()?.emit("deleteWorkspace", { workspaceId }, () => {});
    }
  };
}
