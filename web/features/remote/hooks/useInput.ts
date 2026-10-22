"use client";

import { useState, useRef, useCallback, useEffect, RefObject } from "react";
import { MODIFIER_MAP, SPECIAL_KEYS, REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { useRemoteHistoryStore } from "@/shared/stores/historyStore";

export interface SocketEmitFunctions {
  emitKeyPress?: (key: string, modifiers: string[]) => void;
  emitTypeText?: (text: string) => void;
  emitScroll?: (direction: string, amount: number, horizontal?: boolean) => void;
  emitMouseDragSelect?: (startX: number, startY: number, endX: number, endY: number) => void;
  [key: string]: any;
}

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionOptions {
  streaming: boolean;
  getCanvasCoordinates: (clientX: number, clientY: number) => { percentX: number; percentY: number };
  baseCanvasSize: { width: number; height: number };
  canvasZoom: number;
  canvasPan: { x: number; y: number };
  percentOverride?: { percentX: number; percentY: number };
}

export function useInput(socketEmitFunctions?: SocketEmitFunctions | null) {
  const [textInputValue, setTextInputValue] = useState<string>("");
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [keyboardVisible, setKeyboardVisible] = useState<boolean>(false);
  const textInputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const [modifierKeys, setModifierKeys] = useState({
    ctrl: false,
    cmd: false,
    alt: false,
    shift: false
  });

  const [selectionMode, setSelectionMode] = useState<boolean>(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  const [dragMode, setDragMode] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const scrollIntervalRef = useRef<NodeJS.Timeout | number | null>(null);

  // Detect mobile and keyboard
  useEffect(() => {
    const checkMobile = () => {
      const isMobileDevice = window.innerWidth <= 768 || 
        /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      setIsMobile(isMobileDevice);
      return isMobileDevice;
    };

    const handleResize = () => {
      const mobileDevice = checkMobile();
      if (mobileDevice) {
        const viewportHeight = window.visualViewport?.height || window.innerHeight;
        const windowHeight = window.screen.height;
        setKeyboardVisible(viewportHeight < windowHeight * 0.75);
      } else {
        setKeyboardVisible(false);
      }
    };

    checkMobile();
    window.addEventListener("resize", handleResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleResize);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (scrollIntervalRef.current) {
        clearInterval(scrollIntervalRef.current as any);
      }
    };
  }, []);

  const toggleModifierKey = useCallback((key: "ctrl" | "cmd" | "alt" | "shift") => {
    setModifierKeys(prev => ({ ...prev, [key]: !prev[key] }));
    if (isMobile && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [isMobile]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(prev => !prev);
    setSelectionStart(null);
    setSelectionRect(null);
  }, []);

  const toggleDragMode = useCallback(() => {
    setDragMode(prev => !prev);
    if (isDragging) {
      setIsDragging(false);
    }
  }, [isDragging]);

  const handleTextInputFocus = useCallback(() => {
    // NOTE: Deliberately NO scrollIntoView here.
  }, []);

  // Canvas keydown handler — used by physical keyboard when canvas has focus (PC mode).
  const handleCanvasKeyPress = useCallback((event: React.KeyboardEvent | KeyboardEvent, streaming: boolean) => {
    if (!streaming || !socketEmitFunctions?.emitKeyPress) return;

    const raw = event.key;
    // Skip pure-modifier keys — they only matter as modifiers on the next key.
    if (raw === "Shift" || raw === "Control" || raw === "Meta" || raw === "Alt") return;

    // Always preventDefault so the browser doesn't eat Tab/F5/Space/Backspace/arrows.
    if (raw !== "F12") event.preventDefault();

    // Merge live event modifiers with sticky UI modifiers (from on-screen Ctrl/Alt/... buttons).
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push("control");
    if (event.metaKey) modifiers.push("command");
    if (event.altKey) modifiers.push("alt");
    if (event.shiftKey) modifiers.push("shift");
    const stickyActive = (Object.keys(modifierKeys) as (keyof typeof modifierKeys)[]).filter(k => modifierKeys[k]);
    for (const k of stickyActive) {
      const m = MODIFIER_MAP[k];
      if (m && !modifiers.includes(m)) modifiers.push(m);
    }

    // Map special keys; single-char keys pass through as-is to preserve case.
    const key = SPECIAL_KEYS[raw] ?? (raw.length === 1 ? raw : raw.toLowerCase());

    socketEmitFunctions.emitKeyPress(key, modifiers);

    // Clear sticky modifiers after emit (matches emitKeyWithActiveModifiers semantics).
    if (stickyActive.length > 0) {
      setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
    }
  }, [modifierKeys, socketEmitFunctions]);

  // Scroll functions
  const startScroll = useCallback((direction: string, streaming: boolean, horizontal = false) => {
    if (!streaming || !socketEmitFunctions?.emitScroll) return;

    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current as any);
    }

    socketEmitFunctions.emitScroll(direction, 20, horizontal);

    scrollIntervalRef.current = setInterval(() => {
      if (socketEmitFunctions?.emitScroll && streaming) {
        socketEmitFunctions.emitScroll(direction, 20, horizontal);
      }
    }, REMOTE_CONFIG.scrollInterval);

    if (isMobile && textInputRef.current && keyboardVisible) {
      setTimeout(() => textInputRef.current?.focus(), 10);
    }
  }, [isMobile, keyboardVisible, socketEmitFunctions]);

  const startScrollUp = useCallback((streaming: boolean) => startScroll("up", streaming), [startScroll]);
  const startScrollDown = useCallback((streaming: boolean) => startScroll("down", streaming), [startScroll]);
  const startScrollLeft = useCallback((streaming: boolean) => startScroll("left", streaming, true), [startScroll]);
  const startScrollRight = useCallback((streaming: boolean) => startScroll("right", streaming, true), [startScroll]);

  const stopScrolling = useCallback(() => {
    if (scrollIntervalRef.current) {
      clearInterval(scrollIntervalRef.current as any);
      scrollIntervalRef.current = null;
    }
  }, []);

  const addCommand = useRemoteHistoryStore((s) => s.addCommand);

  const sendTextInput = useCallback((streaming: boolean) => {
    if (!streaming || !socketEmitFunctions?.emitTypeText) return;
    // Empty input → send lone Enter; otherwise type the buffered text
    if (!textInputValue.trim()) {
      socketEmitFunctions.emitKeyPress?.("enter", []);
      return;
    }
    // Only refocus if the input was focused when sending.
    const wasFocused = document.activeElement === textInputRef.current;
    socketEmitFunctions.emitTypeText(textInputValue);
    addCommand(textInputValue);
    setTextInputValue("");
    if (wasFocused) textInputRef.current?.focus();
  }, [textInputValue, socketEmitFunctions, textInputRef, addCommand]);

  const directBufRef = useRef<string>("");
  const directTimerRef = useRef<NodeJS.Timeout | number | null>(null);
  const handleDirectInputChange = useCallback((value: string, streaming: boolean) => {
    if (!streaming || !value || !socketEmitFunctions?.emitTypeText) return;
    directBufRef.current += value;
    setTextInputValue("");
    if (directTimerRef.current) clearTimeout(directTimerRef.current as any);
    directTimerRef.current = setTimeout(() => {
      const text = directBufRef.current;
      directBufRef.current = "";
      directTimerRef.current = null;
      if (text) socketEmitFunctions?.emitTypeText?.(text);
    }, 150);
  }, [socketEmitFunctions]);

  // Emit a key with currently active sticky modifiers applied, then clear them.
  const emitKeyWithActiveModifiers = useCallback((key: string) => {
    if (!socketEmitFunctions?.emitKeyPress) return;
    const activeModifiers = (Object.keys(modifierKeys) as (keyof typeof modifierKeys)[]).filter(k => modifierKeys[k]);
    const modifiers = activeModifiers.map(k => MODIFIER_MAP[k]).filter(Boolean) as string[];
    socketEmitFunctions.emitKeyPress(key, modifiers);
    if (activeModifiers.length > 0) {
      setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
    }
  }, [modifierKeys, socketEmitFunctions]);

  const sendBackspace = useCallback((streaming: boolean) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("backspace");
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendArrowKey = useCallback((direction: string, streaming: boolean) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers(direction);
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendEscKey = useCallback((streaming: boolean) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("escape");
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendTabKey = useCallback((streaming: boolean) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("tab");
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const sendEnterKey = useCallback((event: React.KeyboardEvent | KeyboardEvent | null | undefined, streaming: boolean) => {
    if (!streaming) return;
    emitKeyWithActiveModifiers("enter");
    if (event) event.preventDefault();
    if (isMobile && textInputRef.current && keyboardVisible) {
      textInputRef.current.focus();
    }
  }, [isMobile, keyboardVisible, emitKeyWithActiveModifiers]);

  const handleSelection = useCallback((clientX: number, clientY: number, type: "start" | "move" | "end", options: SelectionOptions) => {
    const { streaming, getCanvasCoordinates, baseCanvasSize, canvasZoom, canvasPan, percentOverride } = options;
    if (!selectionMode || !streaming || !socketEmitFunctions?.emitMouseDragSelect) return;

    const { percentX, percentY } = percentOverride || getCanvasCoordinates(clientX, clientY);

    if (type === "start") {
      setSelectionStart({ x: percentX, y: percentY });
      setSelectionRect(null);
    } else if (type === "move" && selectionStart) {
      const canvasDisplayWidth = baseCanvasSize.width * canvasZoom;
      const canvasDisplayHeight = baseCanvasSize.height * canvasZoom;

      setSelectionRect({
        x: Math.min(selectionStart.x, percentX) * canvasDisplayWidth / 100 + canvasPan.x,
        y: Math.min(selectionStart.y, percentY) * canvasDisplayHeight / 100 + canvasPan.y,
        width: Math.abs(percentX - selectionStart.x) * canvasDisplayWidth / 100,
        height: Math.abs(percentY - selectionStart.y) * canvasDisplayHeight / 100
      });
    } else if (type === "end" && selectionStart) {
      socketEmitFunctions.emitMouseDragSelect(selectionStart.x, selectionStart.y, percentX, percentY);
      setTimeout(() => {
        setSelectionStart(null);
        setSelectionMode(false);
        setSelectionRect(null);
      }, 500);
    }
  }, [selectionMode, selectionStart, socketEmitFunctions]);

  // Handle keydown from native keyboard input field.
  const handleModifiedTextInput = useCallback((event: React.KeyboardEvent | KeyboardEvent, streaming: boolean, directMode = false) => {
    if (!streaming || !socketEmitFunctions?.emitTypeText || !socketEmitFunctions?.emitKeyPress) return;

    let keyToSend = event.key.toLowerCase();
    const isPureModifierKey = ["shift", "control", "meta", "alt"].includes(keyToSend);
    if (isPureModifierKey) return;

    if (event.key === "Unidentified" || (event as any).keyCode === 229) return;

    const activeModifiers = (Object.keys(modifierKeys) as (keyof typeof modifierKeys)[]).filter(key => modifierKeys[key]);
    const hasUIModifiers = activeModifiers.length > 0;
    const hasKeyboardModifiers = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;

    if (directMode) {
      event.preventDefault();

      let modifiers = activeModifiers.map(k => MODIFIER_MAP[k]).filter(Boolean) as string[];
      if (event.ctrlKey && !modifiers.includes("control")) modifiers.push("control");
      if (event.metaKey && !modifiers.includes("command")) modifiers.push("command");
      if (event.altKey && !modifiers.includes("alt")) modifiers.push("alt");
      if (event.shiftKey && !modifiers.includes("shift")) modifiers.push("shift");

      if (SPECIAL_KEYS[keyToSend]) keyToSend = SPECIAL_KEYS[keyToSend];
      else if (keyToSend === " ") keyToSend = "space";
      else if (event.key.length === 1) keyToSend = event.key; // preserve case

      socketEmitFunctions.emitKeyPress(keyToSend, modifiers);
      if (hasUIModifiers) setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
      setTextInputValue("");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (textInputValue.trim()) {
        socketEmitFunctions.emitTypeText(textInputValue);
        addCommand(textInputValue);
        setTextInputValue("");
      }
      return;
    }

    const isAlphaNumeric = /^[a-z0-9]$/i.test(event.key);
    const shouldSendAsCombination = (hasUIModifiers || hasKeyboardModifiers) && (!isAlphaNumeric || hasUIModifiers);

    if (shouldSendAsCombination) {
      event.preventDefault();

      let modifiers = activeModifiers.map(key => MODIFIER_MAP[key]).filter(Boolean) as string[];
      if (event.ctrlKey && !modifiers.includes("control")) modifiers.push("control");
      if (event.metaKey && !modifiers.includes("command")) modifiers.push("command");
      if (event.altKey && !modifiers.includes("alt")) modifiers.push("alt");
      if (event.shiftKey && !modifiers.includes("shift")) modifiers.push("shift");

      if (SPECIAL_KEYS[keyToSend]) {
        keyToSend = SPECIAL_KEYS[keyToSend];
      } else if (keyToSend === " ") {
        keyToSend = "space";
      }

      socketEmitFunctions.emitKeyPress(keyToSend, modifiers);
      setModifierKeys({ ctrl: false, cmd: false, alt: false, shift: false });
      setTextInputValue("");
    }
  }, [modifierKeys, textInputValue, socketEmitFunctions, addCommand]);

  return {
    textInputValue,
    setTextInputValue,
    textInputRef,
    keyboardVisible,
    modifierKeys,
    selectionMode,
    selectionStart,
    selectionRect,
    dragMode,
    isDragging,
    setIsDragging,
    setDragMode,
    toggleModifierKey,
    toggleSelectionMode,
    toggleDragMode,
    handleTextInputFocus,
    handleCanvasKeyPress,
    startScrollUp,
    startScrollDown,
    startScrollLeft,
    startScrollRight,
    stopScrolling,
    sendTextInput,
    sendBackspace,
    sendArrowKey,
    sendEscKey,
    sendTabKey,
    sendEnterKey,
    handleSelection,
    handleModifiedTextInput,
    handleDirectInputChange,
    emitKeyWithActiveModifiers
  };
}
