"use client";

import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useShallow } from "zustand/react/shallow";
import { TOGGLEABLE_BUTTONS, type ToggleableButton } from "@/features/terminal/constants/terminalConfig";
import type { TerminalStoreState } from "@/shared/stores/terminalTypes";

// One read/write pair for every hideable button, so the settings screen and the
// slide menu render the same list without either knowing where a flag is stored:
// header ids live in a shared array, pane ids in their own boolean.
// Subscribes to just those flags — the bare-store form re-rendered on every
// unrelated set() (mobile drafts, status ticks) while a menu or dialog is open.
const BUTTON_SLICE = (s: TerminalStoreState) => {
  const slice: Record<string, any> = { hiddenHeaderButtons: s.hiddenHeaderButtons, toggleHeaderButton: s.toggleHeaderButton };
  for (const btn of TOGGLEABLE_BUTTONS) {
    if (btn.group === "pane") {
      if (btn.storeKey) slice[btn.storeKey] = (s as any)[btn.storeKey];
      if (btn.setterKey) slice[btn.setterKey] = (s as any)[btn.setterKey];
    }
  }
  return slice;
};

export function useButtonToggles() {
  const state = useTerminalStore(useShallow(BUTTON_SLICE));
  const isOn = (btn: ToggleableButton): boolean => (btn.group === "header"
    ? !state.hiddenHeaderButtons.includes(btn.id)
    : !!state[btn.storeKey || ""]);
  const toggle = (btn: ToggleableButton): void => (btn.group === "header"
    ? state.toggleHeaderButton(btn.id)
    : state[btn.setterKey || ""](!state[btn.storeKey || ""]));
  return { buttons: TOGGLEABLE_BUTTONS, isOn, toggle };
}
