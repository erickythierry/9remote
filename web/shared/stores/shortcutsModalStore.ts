"use client";

import { create } from "zustand";

// Standalone store so the settings menu and the global Mod+Shift+/ chord can both
// open the sheet without threading a callback through the workspace shell.
interface ShortcutsModalState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

export const useShortcutsModalStore = create<ShortcutsModalState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen }))
}));
