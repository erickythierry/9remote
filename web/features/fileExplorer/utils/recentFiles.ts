import { STORAGE_KEYS, MAX_RECENT_FILES } from "../constants/fileExplorer.js";

export function getRecentFiles(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.recentFiles) || "[]");
  } catch {
    return [];
  }
}

export function addRecentFile(filePath?: string | null): void {
  if (typeof window === "undefined" || !filePath) return;
  const all = getRecentFiles();
  const rest = all.filter(p => p !== filePath);
  rest.unshift(filePath);
  localStorage.setItem(STORAGE_KEYS.recentFiles, JSON.stringify(rest.slice(0, MAX_RECENT_FILES)));
}

export function clearRecentFiles(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEYS.recentFiles);
}
