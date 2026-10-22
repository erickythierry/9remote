import { useState, useEffect } from "preact/hooks";
import { LOCALES } from "./locales";
import { DEFAULT_LOCALE, STORAGE_KEY } from "./config";

type Locale = keyof typeof LOCALES;
type TranslationParams = Record<string, string | number>;
type TranslationValue = string;
type LocaleListener = (locale: Locale) => void;

// Resolve "a.b.c" dot-path inside a nested dict
function resolvePath(dict: unknown, path: string): unknown {
  if (!dict) return undefined;
  return path.split(".").reduce<unknown>((acc, key) => (
    acc != null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined
  ), dict);
}

// Replace {var} placeholders with provided params
function interpolate(template: unknown, params?: TranslationParams): TranslationValue {
  if (typeof template !== "string" || !params) return template as TranslationValue;
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => (params[key] != null ? String(params[key]) : `{${key}}`));
}

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("agentLocale");
    if (saved && saved in LOCALES) return saved as Locale;
  } catch {}
  return DEFAULT_LOCALE;
}

// Module-level shared store so locale changes re-render every subscriber
let currentLocale: Locale = detectLocale();
const listeners = new Set<LocaleListener>();
const localeDicts = LOCALES as Record<string, (typeof LOCALES)[Locale]>;

function setLocale(next: string) {
  if (next === currentLocale || !(next in LOCALES)) return;
  const locale = next as Locale;
  currentLocale = locale;
  try { localStorage.setItem(STORAGE_KEY, locale); } catch {}
  listeners.forEach((fn) => fn(locale));
}

export function translate(locale: string, key: string, params?: TranslationParams): TranslationValue {
  const dict = localeDicts[locale] || localeDicts[DEFAULT_LOCALE];
  const fallback = localeDicts[DEFAULT_LOCALE];
  const value = resolvePath(dict, key) ?? resolvePath(fallback, key) ?? key;
  return interpolate(value, params);
}

export function useI18n() {
  const [locale, setLocaleLocal] = useState(currentLocale);

  useEffect(() => {
    const fn = (next: Locale) => setLocaleLocal(next);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);

  const t = (key: string, params?: TranslationParams) => translate(locale, key, params);
  return { t, locale, setLocale };
}
