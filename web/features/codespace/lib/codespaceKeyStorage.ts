// Map codespace name -> host apiKey (kept in localStorage)
const STORAGE_KEY = "9remote_codespace_keys";

function read(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function write(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function saveCodespaceKey(codespaceName: string, apiKey: string): void {
  const map = read();
  map[codespaceName] = apiKey;
  write(map);
}

export function getCodespaceKey(codespaceName: string): string | null {
  return read()[codespaceName] || null;
}

export function removeCodespaceKey(codespaceName: string): void {
  const map = read();
  delete map[codespaceName];
  write(map);
}
