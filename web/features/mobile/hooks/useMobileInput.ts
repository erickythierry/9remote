"use client";

import { useCallback, useRef, RefObject } from "react";
import { WHEEL_LINE_PX, WHEEL_PAGE_PX, WHEEL_NOTCH_PX, SCROLL_MAX } from "../constants/mobileConfig";

export interface UseMobileInputParams {
  busRef: RefObject<any>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}

export function useMobileInput({ busRef, canvasRef }: UseMobileInputParams) {
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const latestMoveRef = useRef<{ x: number; y: number } | null>(null);
  const moveRafRef = useRef<number>(0);

  const send = useCallback((msg: any) => {
    busRef?.current?.emit("mobile:input", msg);
  }, [busRef]);

  const flushMove = useCallback(() => {
    moveRafRef.current = 0;
    const move = latestMoveRef.current;
    if (!move) return;
    latestMoveRef.current = null;
    send({ type: "touch", action: "move", ...move });
  }, [send]);

  const toUnit = useCallback((event: React.PointerEvent | React.WheelEvent | PointerEvent | WheelEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const paintedW = canvas.width * scale;
    const paintedH = canvas.height * scale;
    const originX = rect.left + (rect.width - paintedW) / 2;
    const originY = rect.top + (rect.height - paintedH) / 2;
    const x = (event.clientX - originX) / paintedW;
    const y = (event.clientY - originY) / paintedH;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }, [canvasRef]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    const pos = toUnit(event);
    if (!pos) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    pressRef.current = pos;
    send({ type: "touch", action: "down", ...pos });
  }, [send, toUnit]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!pressRef.current) return;
    const pos = toUnit(event);
    if (!pos) return;
    latestMoveRef.current = pos;
    if (!moveRafRef.current) moveRafRef.current = requestAnimationFrame(flushMove);
  }, [flushMove, toUnit]);

  const onWheel = useCallback((event: React.WheelEvent) => {
    const pos = toUnit(event);
    if (!pos) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const notches = (delta: number) => Math.max(-SCROLL_MAX, Math.min(SCROLL_MAX, -(delta * unit) / WHEEL_NOTCH_PX));
    send({ type: "scroll", ...pos, hscroll: notches(event.deltaX), vscroll: notches(event.deltaY) });
  }, [send, toUnit]);

  const endPress = useCallback((event: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    latestMoveRef.current = null;
    if (moveRafRef.current) { cancelAnimationFrame(moveRafRef.current); moveRafRef.current = 0; }
    const pos = toUnit(event) || { x: press.x, y: press.y };
    send({ type: "touch", action: "up", ...pos });
  }, [send, toUnit]);

  const sendKey = useCallback((name: string) => send({ type: "key", name }), [send]);

  return { onPointerDown, onPointerMove, onPointerUp: endPress, onPointerCancel: endPress, onWheel, sendKey };
}
