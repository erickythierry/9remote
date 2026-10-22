"use client";

import { useRef, useEffect, useCallback, RefObject } from "react";

export interface UseRemoteKeyboardParams {
  streaming: boolean;
  keyboardOn: boolean;
  setKeyboardOn: (on: boolean | ((prev: boolean) => boolean)) => void;
  showTextPanel: boolean;
  setShowTextPanel: (show: boolean | ((prev: boolean) => boolean)) => void;
  textInputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  canvasContainerRef: RefObject<HTMLElement | null>;
  panForKeyboard: (shrank: boolean, focusPoint: { x: number; y: number } | null) => void;
  pointerMode?: string;
  virtualCursor?: { x: number; y: number } | null;
}

// Native keyboard + text panel control, and the pan that keeps the point of
// interest visible when the on-screen keyboard shrinks the viewport.
export function useRemoteKeyboard({
  streaming, keyboardOn, setKeyboardOn, showTextPanel, setShowTextPanel,
  textInputRef, canvasContainerRef, panForKeyboard, pointerMode, virtualCursor
}: UseRemoteKeyboardParams) {
  // Mirror keyboardOn into a ref so onBlur handler reads the latest value synchronously.
  const keyboardOnRef = useRef<boolean>(keyboardOn);
  useEffect(() => { keyboardOnRef.current = keyboardOn; }, [keyboardOn]);

  // Toggle native keyboard by focus/blur the hidden text input.
  const toggleKeyboard = useCallback(() => {
    const next = !keyboardOn;
    keyboardOnRef.current = next;
    setKeyboardOn(next);
    if (next) textInputRef.current?.focus();
    else textInputRef.current?.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardOn]);

  // Auto-focus hidden sink once when stream is ready and keyboard was left on (persisted).
  const autoFocusedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!streaming || autoFocusedRef.current || !keyboardOnRef.current) return;
    autoFocusedRef.current = true;
    textInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  // When closing panel, sync-focus hidden sink to keep native keyboard visible (iOS gesture rule).
  const toggleTextPanel = useCallback(() => {
    const next = !showTextPanel;
    if (!next && keyboardOn) textInputRef.current?.focus();
    setShowTextPanel(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTextPanel, keyboardOn]);

  // Re-focus to keep the native keyboard visible. Uses the ref (not state) so
  // toggleKeyboard's blur can actually close it.
  const handleTextInputBlur = useCallback(() => {
    if (keyboardOnRef.current && !showTextPanel) setTimeout(() => textInputRef.current?.focus(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTextPanel]);

  const focusPxRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    focusPxRef.current = pointerMode === "trackpad" ? (virtualCursor ?? null) : null;
  }, [pointerMode, virtualCursor]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevVVH = vv.height;
    let raf = 0;
    const onResize = () => {
      const shrank = vv.height < prevVVH;
      prevVVH = vv.height;
      const container = canvasContainerRef.current;
      if (!container) return;
      const startH = container.clientHeight;
      cancelAnimationFrame(raf);
      let tries = 0;
      const wait = () => {
        if (container.clientHeight !== startH || tries++ > 30) {
          panForKeyboard(shrank, focusPxRef.current);
          return;
        }
        raf = requestAnimationFrame(wait);
      };
      raf = requestAnimationFrame(wait);
    };
    vv.addEventListener("resize", onResize);
    return () => { cancelAnimationFrame(raf); vv.removeEventListener("resize", onResize); };
  }, [canvasContainerRef, panForKeyboard]);

  return { keyboardOnRef, toggleKeyboard, toggleTextPanel, handleTextInputBlur };
}
