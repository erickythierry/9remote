"use client";

import { create } from "zustand";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES } from "../i18n/config.js";
import en from "../i18n/locales/en.js";

type LocaleDictionary = typeof en;
interface I18nStore {
  locale: string;
  dicts: Record<string, LocaleDictionary>;
  hydrated: boolean;
  hydrate(): void;
  setLocale(locale: string): void;
}

const supportedCodes = SUPPORTED_LOCALES.map((locale) => locale.code);

// Detect initial locale: localStorage > DEFAULT_LOCALE
function detectLocale(): string {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved && supportedCodes.includes(saved)) return saved;
  } catch {}
  return DEFAULT_LOCALE;
}

// Locale dictionaries are lazy: only `en` (the fallback, also what SSR renders) ships in
// the main bundle; the other 22 load on demand as separate chunks. Until one arrives,
// `t()` keeps resolving against en — same behaviour as an untranslated key.
const inflight = new Map<string, Promise<unknown>>();
const ensureDict = (locale: string, set: (updater: (state: I18nStore) => Partial<I18nStore>) => void): void => {
  if (!supportedCodes.includes(locale) || locale === DEFAULT_LOCALE) return;
  if (useI18nStore.getState().dicts[locale] || inflight.has(locale)) return;
  const load = import(`../i18n/locales/${locale}.ts`).then((mod) => {
    inflight.delete(locale);
    const dict = mod.default;
    // Another setLocale may have run while loading — merge, never replace
    set((state) => ({ dicts: { ...state.dicts, [locale]: dict } }));
    return dict;
  }).catch(() => { inflight.delete(locale); });
  inflight.set(locale, load);
};

export const useI18nStore = create<I18nStore>((set) => ({
  locale: DEFAULT_LOCALE,
  dicts: { [DEFAULT_LOCALE]: en },
  hydrated: false,
  hydrate: () => {
    const locale = detectLocale();
    ensureDict(locale, set);
    set({ locale, hydrated: true });
  },
  setLocale: (locale) => {
    if (!supportedCodes.includes(locale)) return;
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch {}
    }
    ensureDict(locale, set);
    set({ locale });
  }
}));
