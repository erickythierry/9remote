"use client";

import { PATH_SUGGEST } from "@/features/terminal/constants/terminalConfig";

// Match a path-taking verb followed by a single partial arg at end of input.
// Captures [verb, partial]. Caret-after-partial is enforced by the caller.
const VERB_RE = new RegExp(`^\\s*(${PATH_SUGGEST.verbs.join("|")})\\s+(\\S*)$`, "i");

export interface EntryItem {
  name: string;
  type: string;
  [key: string]: unknown;
}

export interface PathMatch {
  name: string;
  type: string;
  arg: string;
  label: string;
  full: string;
}

export interface DirCache {
  get(dir: string, now: number): EntryItem[] | null;
  set(dir: string, entries: EntryItem[], now: number): void;
  clear(): void;
}

export interface ParsedPathInput {
  verb: string;
  dir: string;
  prefix: string;
  partial: string;
}

// Dir listing cache: Map<dir, { entries, expireAt }>. FIFO cap on size.
export function makeDirCache({ ttlMs, maxDirs } = PATH_SUGGEST): DirCache {
  const cache = new Map<string, { entries: EntryItem[]; expireAt: number }>();
  const touch = (dir: string) => {
    const val = cache.get(dir);
    if (val) {
      cache.delete(dir);
      cache.set(dir, val);
    }
  };
  return {
    get(dir: string, now: number): EntryItem[] | null {
      const e = cache.get(dir);
      if (!e) return null;
      if (e.expireAt < now) { cache.delete(dir); return null; }
      touch(dir);
      return e.entries;
    },
    set(dir: string, entries: EntryItem[], now: number): void {
      if (cache.size >= maxDirs && !cache.has(dir)) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(dir, { entries, expireAt: now + ttlMs });
    },
    clear(): void { cache.clear(); }
  };
}

// Resolve the directory to list and the prefix to filter from raw input + cwd.
// Returns { verb, dir, prefix, partial } or null if input isn't a path-arg verb form.
export function parsePathInput(input: string, cwd?: string | null): ParsedPathInput | null {
  const m = VERB_RE.exec(input);
  if (!m) return null;
  const verb = m[1];
  const partial = m[2] || "";
  const sep = partial.lastIndexOf("/");
  if (sep < 0) return { verb, dir: cwd || "", prefix: partial, partial };
  const base = partial.slice(0, sep);
  // Absolute/home root when base is empty: "cd /" → dir "/", "cd ~/" → "~".
  if (!base) return { verb, dir: partial.startsWith("~") ? "~" : "/", prefix: partial.slice(sep + 1), partial };
  return { verb, dir: joinDir(cwd, base), prefix: partial.slice(sep + 1), partial };
}

// Resolve a possibly-relative dir against cwd. "~"/absolute pass through.
function joinDir(cwd: string | null | undefined, base: string): string {
  if (!base) return cwd || "";
  if (base.startsWith("/") || base.startsWith("~")) return base;
  if (!cwd) return base;
  return cwd.replace(/\/+$/, "") + "/" + base;
}

// Pick matching entries for the current prefix: folders first, then alphabetical.
// Returns up to maxResults matches, each annotated with the full arg to insert.
export function pickMatches(
  entries?: EntryItem[] | null,
  prefix: string = "",
  { partial, verb }: { partial?: string; verb?: string } = {}
): PathMatch[] {
  if (!entries?.length) return [];
  const norm = prefix.toLowerCase();
  const base = partial && partial.includes("/")
    ? partial.slice(0, partial.lastIndexOf("/") + 1)
    : "";
  const matches = entries
    .filter((e) => e.name.toLowerCase().startsWith(norm))
    .map((e) => ({
      name: e.name,
      type: e.type,
      arg: base + e.name + (e.type === "folder" ? "/" : ""),
      label: e.name + (e.type === "folder" ? "/" : ""),
      full: `${verb || ""} ${base}${e.name}${e.type === "folder" ? "/" : ""}`,
    }))
    .sort((a, b) => {
      const ad = a.type === "folder" ? 0 : 1;
      const bd = b.type === "folder" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  return matches.slice(0, (PATH_SUGGEST.maxResults || 8));
}
