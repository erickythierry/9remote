"use client";

import { create } from "zustand";

interface UIStore {
  isKeyboardOpen: boolean;
  setKeyboardOpen(isOpen: boolean): void;
}

// UI state store - runtime only (no persistence)
export const useUIStore = create<UIStore>((set) => ({
  // Keyboard state
  isKeyboardOpen: false,
  setKeyboardOpen: (isOpen) => {
    set({ isKeyboardOpen: isOpen });
    // Toggle body class for CSS
    if (typeof document !== "undefined") {
      document.body.classList.toggle("keyboard-open", isOpen);
    }
  }
}));
