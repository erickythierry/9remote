"use client";

import { useEffect, useCallback, useState } from "react";
import type { MutableRefObject } from "react";
import { useCanvas } from "@/features/remote/hooks/useCanvas";
import { useInput } from "@/features/remote/hooks/useInput";
import { useRemoteKeyboard } from "@/features/remote/hooks/useRemoteKeyboard";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

// Everything a remote screen needs except where its pixels come from: pointer/keyboard
// state, canvas viewport, hand/trackpad modes, clipboard badge and focus-rect streaming.
// `emits` is the useRemoteBus contract — Remote Desktop passes the real one, the browser
// pane passes an adapter with the same shape. `intercept(e, type)` / `interceptKey(e)`
// let a host view claim an event before the default input pipeline sees it.
export interface UseRemoteSurfaceParams {
  emits: Record<string, any>;
  streaming: boolean;
  hostPlatform?: string | null;
  storagePrefix?: string;
  defaultPointerMode?: string;
  hoverMove?: boolean;
  wheelMultiplier?: number;
  intercept?: (e: any, type: string) => boolean | void;
  interceptKey?: (e: React.KeyboardEvent<HTMLCanvasElement>) => boolean | void;
  stageLockRef?: MutableRefObject<{ kbShrunk?: boolean; height?: number } | null>;
}

export type RemoteSurface = ReturnType<typeof useRemoteSurface>;

export function useRemoteSurface({
  emits, streaming, hostPlatform,
  storagePrefix = "remoteDesktop", defaultPointerMode = REMOTE_CONFIG.pointerMode, hoverMove = false, wheelMultiplier, intercept, interceptKey,
  stageLockRef
}: UseRemoteSurfaceParams) {
  const key = (name: string) => `${storagePrefix}.${name}`;
  const [showTextPanel, setShowTextPanel] = usePersistedState(key("showTextPanel"), true);
  const [keyboardOn, setKeyboardOn] = usePersistedState(key("keyboard"), false);
  const [controlsHidden, setControlsHidden] = usePersistedState(key("controlsHidden"), false);
  const [pointerMode, setPointerMode] = usePersistedState<string>(key("pointerMode"), defaultPointerMode);
  const [handMode, setHandMode] = usePersistedState(key("handMode"), false);

  const inputMode = useInputMode();
  const pcCfg = REMOTE_CONFIG.pcModeControls;
  const show = (k: string) => inputMode !== "mouse" || !!(pcCfg as Record<string, boolean> | undefined)?.[k];
  // Tall landscape (iPad/tablet): full-width controls below canvas. Phone landscape keeps the
  // right sidebar. screen dimensions are physical — unaffected by soft keyboard shrinking viewport.
  const [isLandscape, setIsLandscape] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape)");
    const update = () => setIsLandscape(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  const tallLandscape = isLandscape && Math.min(window.screen.width, window.screen.height) >= 700;
  // PC mode forces direct absolute pointing
  useEffect(() => {
    if (inputMode === "mouse" && pointerMode !== "direct") setPointerMode("direct");
  }, [inputMode, pointerMode, setPointerMode]);

  const {
    emitRequestScreenWithHashes, emitMousePress, emitMouseRelease, emitMouseClick, emitMouseMove,
    emitMouseDragSelect, emitKeyPress, emitTypeText, emitScroll, emitBoostStream, emitSetFocus
  } = emits;
  const socketEmitFunctions = {
    emitRequestScreenWithHashes, emitMousePress, emitMouseRelease, emitMouseClick, emitMouseMove,
    emitMouseDragSelect, emitKeyPress, emitTypeText, emitScroll, emitBoostStream
  };

  const canvas = useCanvas(socketEmitFunctions, { stageLockRef });
  const {
    canvasRef, canvasContainerRef, canvasZoom, canvasPan, fitScale,
    getCanvasCoordinates, centerVirtualCursor, startHandHold, releaseHandHold,
    handleCanvasInteraction, baseCanvasSize
  } = canvas;

  const togglePointerMode = useCallback(() => {
    setPointerMode(prev => {
      const next = prev === "trackpad" ? "direct" : "trackpad";
      if (next === "trackpad") centerVirtualCursor();
      return next;
    });
  }, [centerVirtualCursor, setPointerMode]);

  const input = useInput(socketEmitFunctions);
  const {
    textInputRef, selectionMode, selectionStart, dragMode, isDragging, setIsDragging, setDragMode,
    toggleSelectionMode, handleCanvasKeyPress, handleSelection, emitKeyWithActiveModifiers
  } = input;

  const keyboard = useRemoteKeyboard({
    streaming, keyboardOn, setKeyboardOn, showTextPanel, setShowTextPanel,
    textInputRef, canvasContainerRef, panForKeyboard: canvas.panForKeyboard,
    pointerMode, virtualCursor: canvas.virtualCursor
  });

  // Unified key emit — merges sticky UI modifiers with combo's own modifiers.
  // osAdaptive combos (undo/paste/cut/...) use ⌘ on a macOS host instead of Ctrl.
  const emitKeyDirect = useCallback((k: string, comboModifiers: string[] = [], osAdaptive = false) => {
    if (!streaming) return;
    if (comboModifiers.length > 0) {
      const mods = osAdaptive && hostPlatform === "darwin"
        ? comboModifiers.map((m: string) => (m === "control" ? "command" : m))
        : comboModifiers;
      emitKeyPress(k, mods);
    } else emitKeyWithActiveModifiers(k);
  }, [streaming, hostPlatform, emitKeyPress, emitKeyWithActiveModifiers]);

  // Hand mode: ON presses mouse-left at virtual cursor; OFF releases it.
  const toggleHandMode = useCallback(() => {
    setHandMode(prev => {
      const next = !prev;
      if (next) {
        if (selectionMode) toggleSelectionMode();
        startHandHold();
      } else {
        releaseHandHold();
      }
      return next;
    });
  }, [setHandMode, selectionMode, toggleSelectionMode, startHandHold, releaseHandHold]);

  // Focus-based streaming: emit visible canvas rect on pan/zoom; zoom=1 → null (full screen)
  useEffect(() => {
    if (!streaming || !emitSetFocus) return;
    const timer = setTimeout(() => {
      const el = canvasRef.current;
      const container = canvasContainerRef.current;
      if (!el || !container || el.width === 0) return;
      if (canvasZoom <= 1) { emitSetFocus(null, 1); return; }

      const totalScale = fitScale * canvasZoom;
      if (totalScale <= 0) return;
      const x = Math.max(0, -canvasPan.x / totalScale);
      const y = Math.max(0, -canvasPan.y / totalScale);
      const w = Math.min(el.width - x, container.clientWidth / totalScale);
      const h = Math.min(el.height - y, container.clientHeight / totalScale);
      emitSetFocus({ x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h) }, canvasZoom);
    }, REMOTE_CONFIG.focusDebounce);
    return () => clearTimeout(timer);
  }, [streaming, canvasZoom, canvasPan, fitScale, canvasRef, canvasContainerRef, emitSetFocus]);

  const onHandRelease = useCallback(() => setHandMode(false), [setHandMode]);

  const handleToggleSelection = useCallback(() => {
    if (handMode) setHandMode(false);
    toggleSelectionMode();
  }, [handMode, setHandMode, toggleSelectionMode]);

  const interactionHandler = (type: string) => (e: any) => {
    if (intercept?.(e, type)) return;
    handleCanvasInteraction(e, type, {
      streaming,
      selectionMode,
      selectionStart,
      dragMode,
      isDragging,
      setIsDragging,
      setDragMode,
      isMobile: type.includes("touch"),
      pointerMode,
      handMode,
      hoverMove,
      wheelMultiplier,
      onHandRelease,
      handleSelection: (clientX: number, clientY: number, selType: "start" | "move" | "end", extra: any) => handleSelection(clientX, clientY, selType, {
        streaming,
        getCanvasCoordinates,
        baseCanvasSize,
        canvasZoom,
        canvasPan,
        ...extra
      })
    });
  };

  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (interceptKey?.(e)) return;
    handleCanvasKeyPress(e, streaming);
  };

  return {
    ...canvas,
    ...input,
    ...keyboard,
    streaming,
    inputMode,
    show,
    tallLandscape,
    pointerMode,
    handMode,
    keyboardOn,
    showTextPanel,
    controlsHidden,
    setControlsHidden,
    togglePointerMode,
    toggleHandMode,
    handleToggleSelection,
    emitKeyDirect,
    interactionHandler,
    onCanvasKeyDown,
    emitRequestScreenWithHashes,
    recalculateDisplaySize: canvas.recalculateDisplaySize
  };
}
