"use client";

import { useEffect, useMemo } from "react";
import { useI18nStore } from "../stores/i18nStore.js";
import { DEFAULT_LOCALE } from "./config.js";

// Resolve "a.b.c" dot-path inside a nested dict
function resolvePath(dict: unknown, path: string): unknown {
  if (!dict) return undefined;
  return path.split(".").reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), dict);
}

// Replace {var} placeholders with provided params
function interpolate(template: unknown, params?: Record<string, unknown>): unknown {
  if (typeof template !== "string" || !params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

export function useI18n() {
  const { locale, dicts, hydrated, hydrate, setLocale } = useI18nStore();

  // Hydrate locale from localStorage/navigator after mount (avoid SSR mismatch)
  useEffect(() => { if (!hydrated) hydrate(); }, [hydrated, hydrate]);

  // The active locale's dict arrives async the first time it is needed — until then it
  // resolves against `en` exactly like an untranslated key, then re-renders when loaded.
  const dict = dicts[locale] || dicts[DEFAULT_LOCALE];
  const fallback = dicts[DEFAULT_LOCALE];

  const t = useMemo(() => {
    return (key: string, params?: Record<string, unknown>): string => {
      const value = resolvePath(dict, key) ?? resolvePath(fallback, key) ?? key;
      return String(interpolate(value, params));
    };
  }, [dict, fallback]);

  return { t, locale, setLocale, hydrated };
}
