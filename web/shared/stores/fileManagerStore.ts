"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface FileManagerTab {
  id: string;
  workspaceId: string;
  path: string;
  title: string;
}

interface FileManagerState {
  tabsByWorkspace: Record<string, FileManagerTab[]>;
  activeByWorkspace: Record<string, string | null>;
  setTabs(wsId: string, tabs: FileManagerTab[]): void;
  setActive(wsId: string, tabId: string | null): void;
  addTab(wsId: string, path: string, title?: string | null): string;
  removeTab(wsId: string, tabId: string): void;
}

type PersistedFileManagerState = Pick<FileManagerState, "tabsByWorkspace" | "activeByWorkspace">;

export const useFileManagerStore = create<FileManagerState>()(
  persist<FileManagerState, [], [], PersistedFileManagerState>(
    (set, get) => ({
      tabsByWorkspace: {},
      activeByWorkspace: {},

      setTabs: (wsId, tabs) =>
        set((s) => ({
          tabsByWorkspace: { ...s.tabsByWorkspace, [wsId]: tabs },
        })),

      setActive: (wsId, tabId) =>
        set((s) => ({
          activeByWorkspace: { ...s.activeByWorkspace, [wsId]: tabId },
        })),

      addTab: (wsId, path, title) => {
        const id = `fm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const fallbackTitle = path.split("/").filter(Boolean).pop() || "Arquivos";
        const newTab: FileManagerTab = {
          id,
          workspaceId: wsId,
          path,
          title: title?.trim() || fallbackTitle,
        };
        const current = get().tabsByWorkspace[wsId] || [];
        set((s) => ({
          tabsByWorkspace: {
            ...s.tabsByWorkspace,
            [wsId]: [...current, newTab],
          },
          activeByWorkspace: {
            ...s.activeByWorkspace,
            [wsId]: id,
          },
        }));
        return id;
      },

      removeTab: (wsId, tabId) => {
        const current = get().tabsByWorkspace[wsId] || [];
        const next = current.filter((t) => t.id !== tabId);
        const active = get().activeByWorkspace[wsId];
        let nextActive = active;
        if (active === tabId) {
          nextActive = next.length > 0 ? next[next.length - 1].id : null;
        }
        set((s) => ({
          tabsByWorkspace: { ...s.tabsByWorkspace, [wsId]: next },
          activeByWorkspace: { ...s.activeByWorkspace, [wsId]: nextActive },
        }));
      },
    }),
    {
      name: "file-manager-tabs-state",
      partialize: (state) => ({
        tabsByWorkspace: state.tabsByWorkspace,
        activeByWorkspace: state.activeByWorkspace,
      }),
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          try {
            const value = localStorage.getItem(name);
            return value ? JSON.parse(value) : null;
          } catch {
            return null;
          }
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          try {
            localStorage.setItem(name, JSON.stringify(value));
          } catch {}
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          try {
            localStorage.removeItem(name);
          } catch {}
        },
      },
    }
  )
);
