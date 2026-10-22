"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// Per-session note backed by agent storage (bus getNote/saveNote).
// Debounced auto-save 500ms after the last edit.
const SAVE_DEBOUNCE_MS = 500;

export interface UseSessionNoteResult {
  text: string;
  setText: (next: string) => void;
  loaded: boolean;
}

export function useSessionNote(
  bus?: { emit: (event: string, ...args: any[]) => void } | null,
  sessionId?: string | null
): UseSessionNoteResult {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const textRef = useRef("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load on mount / when session changes
  useEffect(() => {
    if (!bus || !sessionId) { setText(""); textRef.current = ""; setLoaded(false); return; }
    let cancelled = false;
    setLoaded(false);
    bus.emit("getNote", { sessionId }, (res: any) => {
      if (cancelled) return;
      const value = res?.success ? (res.text || "") : "";
      setText(value);
      textRef.current = value;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [bus, sessionId]);

  const doSave = useCallback((value: string) => {
    if (!bus || !sessionId) return;
    bus.emit("saveNote", { sessionId, text: value });
  }, [bus, sessionId]);

  // Debounced auto-save — latest value read from ref at fire time
  const update = useCallback((next: string) => {
    setText(next);
    textRef.current = next;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      doSave(textRef.current);
    }, SAVE_DEBOUNCE_MS);
  }, [doSave]);

  // Flush pending save on unmount / session switch
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        doSave(textRef.current);
      }
    };
  }, [doSave]);

  return { text, setText: update, loaded };
}
