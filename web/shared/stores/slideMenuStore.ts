"use client";

import { create } from "zustand";

type MenuPanel = "menu" | "pwa" | string;
type MenuCallback = (() => void) | null;

interface SlideMenuContext {
  connected: boolean;
  remoteAvailable: boolean;
  showTheme: boolean;
  theme: string;
  busRef: { current: unknown } | null;
  tunnelUrl: string | null;
  apiKey: string | null;
  hideActions: string[];
  connectionMode: string;
  hostVersion: string | null;
  agentVersion: string | null;
  transport: string;
  carrier?: string;
  subscribeToPush?: (() => Promise<unknown>) | null;
  unsubscribeFromPush?: (() => Promise<unknown>) | null;
}

interface SlideMenuCallbacks {
  onRemote: MenuCallback;
  onFiles: MenuCallback;
  onLogout: MenuCallback;
  onThemeChange: ((theme: string) => void) | null;
  onUpdate: MenuCallback;
  onRestart: MenuCallback;
  onSelectSite?: MenuCallback;
  onRefreshSites?: MenuCallback;
}

interface SlideMenuState {
  isOpen: boolean;
  activePanel: MenuPanel;
  context: SlideMenuContext;
  callbacks: SlideMenuCallbacks;
  cachedSites: unknown[];
  currentSites: unknown[];
  loadingSites: boolean;
  open: (panel?: MenuPanel) => void;
  close: () => void;
  setActivePanel: (panel: MenuPanel) => void;
  setContext: (context: Partial<SlideMenuContext>) => void;
  setCallbacks: (callbacks: Partial<SlideMenuCallbacks>) => void;
  setCachedSites: (sites: unknown[]) => void;
  setCurrentSites: (sites: unknown[]) => void;
  setLoadingSites: (loading: boolean) => void;
  openPwa: () => void;
  openMenu: () => void;
}

const isShallowEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
};

export const useSlideMenuStore = create<SlideMenuState>((set, get) => ({
  isOpen: false,
  activePanel: "menu",

  context: {
    connected: false,
    remoteAvailable: false,
    showTheme: false,
    theme: "default",
    busRef: null,
    tunnelUrl: null,
    apiKey: null,
    hideActions: [],
    connectionMode: "tunnel",
    hostVersion: null,
    agentVersion: null,
    transport: "ws"
  },

  callbacks: {
    onRemote: null,
    onFiles: null,
    onLogout: null,
    onThemeChange: null,
    onUpdate: null,
    onRestart: null,
  },

  cachedSites: [],
  currentSites: [],
  loadingSites: false,

  open: (panel = "menu") => set({ isOpen: true, activePanel: panel }),
  close: () => set({ isOpen: false, activePanel: "menu" }),
  setActivePanel: (panel) => set({ activePanel: panel }),

  setContext: (context) => set((state) => {
    const nextContext = { ...state.context, ...context };
    let changed = false;
    for (const key of Object.keys(nextContext) as (keyof SlideMenuContext)[]) {
      if (!isShallowEqual(state.context[key], nextContext[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return state;
    return { context: nextContext };
  }),

  setCallbacks: (callbacks) => {
    const curr = get().callbacks;
    let presenceChanged = false;
    for (const key of Object.keys(callbacks) as (keyof SlideMenuCallbacks)[]) {
      const callback = callbacks[key];
      if (Boolean(curr[key]) !== Boolean(callback)) {
        presenceChanged = true;
      }
      if (callback !== undefined) curr[key] = callback as any;
    }
    if (presenceChanged) {
      set({ callbacks: { ...curr } });
    }
  },

  setCachedSites: (sites) => set({ cachedSites: sites }),
  setCurrentSites: (sites) => set({ currentSites: sites }),
  setLoadingSites: (loading) => set({ loadingSites: loading }),

  openPwa: () => set({ isOpen: true, activePanel: "pwa" }),
  openMenu: () => set({ isOpen: true, activePanel: "menu" }),
}));
