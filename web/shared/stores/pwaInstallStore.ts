"use client";

import { create } from "zustand";

interface InstallPromptEvent {
  prompt: () => Promise<void> | void;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

interface PwaInstallState {
  canInstall: boolean;
  isInstalled: boolean;
  setDeferredPrompt: (event: InstallPromptEvent | null) => void;
  setIsInstalled: (installed: boolean) => void;
  install: () => Promise<"accepted" | "dismissed" | null>;
}

// PWA install state shared across SlideMenu + PwaInstallGuide.
// canInstall flips true only when Chromium fires beforeinstallprompt —
// iOS Safari / Firefox stay false → callers fall back to the manual guide.
// The deferred event is kept in a module-level ref (not state) so React
// re-renders are driven by the boolean, not the event object identity.
let deferredPrompt: InstallPromptEvent | null = null;

export const usePwaInstallStore = create<PwaInstallState>((set) => ({
  canInstall: false,
  isInstalled: false,

  setDeferredPrompt: (event) => {
    deferredPrompt = event;
    set({ canInstall: Boolean(event) });
  },

  setIsInstalled: (installed) => set({ isInstalled: installed }),

  // Triggers the native install dialog. Returns the user's choice or null
  // if no deferred prompt is available (caller should fall back to guide).
  install: async () => {
    if (!deferredPrompt) return null;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    // Prompt can only be used once per event — clear it.
    deferredPrompt = null;
    set({ canInstall: false });
    return choice?.outcome ?? null;
  },
}));
