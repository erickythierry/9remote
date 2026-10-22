"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { DEFAULT_THEME, STORAGE_KEY, THEME_KEYS } from "./themeConfig";
import type { ReactNode } from "react";
import type { ThemeMode } from "./themeConfig";

type NativeResult = { catch?: (onRejected: () => void) => unknown } | undefined;
type ThemeWindow = Window & {
  __TAURI__?: { window?: { getCurrentWindow?: () => { setTheme?: (theme: ThemeMode) => NativeResult; setBackgroundColor?: (color: string) => NativeResult } } };
  ReactNativeWebView?: { postMessage(message: string): void };
};
type ThemeContextValue = { theme: ThemeMode; setTheme: (theme: ThemeMode) => void; toggleTheme: () => void };

const ThemeContext = createContext<ThemeContextValue>({ theme: DEFAULT_THEME, setTheme: () => {}, toggleTheme: () => {} });

const applyClass = (theme: ThemeMode): void => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
  try {
    const win = (window as ThemeWindow).__TAURI__?.window?.getCurrentWindow?.();
    if (win) {
      win.setTheme?.(theme)?.catch?.(() => {});
      win.setBackgroundColor?.(theme === "light" ? "#e7e7e9" : "#2a2a2a")?.catch?.(() => {});
    }
  } catch {}
};

// Notify native shell (Expo WebView) so status bar / safe area match current theme
const notifyNative = (theme: ThemeMode): void => {
  if (typeof window === "undefined") return;
  const bridge = (window as ThemeWindow).ReactNativeWebView;
  if (!bridge) return;
  try {
    bridge.postMessage(JSON.stringify({ type: "THEME_CHANGE", theme }));
  } catch { /* ignore */ }
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(DEFAULT_THEME);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("9remote-theme");
    const initial: ThemeMode = THEME_KEYS.includes(saved as ThemeMode) ? saved as ThemeMode : DEFAULT_THEME;
    setThemeState(initial);
    applyClass(initial);
    notifyNative(initial);
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    if (!THEME_KEYS.includes(next as ThemeMode)) return;
    const themeMode = next as ThemeMode;
    setThemeState(themeMode);
    applyClass(themeMode);
    notifyNative(themeMode);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, themeMode);
      localStorage.setItem("9remote-theme", themeMode);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
