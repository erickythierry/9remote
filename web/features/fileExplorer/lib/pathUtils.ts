// Path helpers shared by the explorer components.
// Extracted verbatim from ExplorerPanel.

export function joinPath(dir: string | null | undefined, name: string): string {
  if (!dir) return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/** Path relative to the workspace root (used for git status keys + display). */
export function relativeTo(workspace: string | null | undefined, p: string | null | undefined): string {
  if (!p || !workspace) return p || "";
  const normW = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const normP = p.replace(/\\/g, "/");
  if (normP.startsWith(`${normW}/`)) return normP.slice(normW.length + 1);
  return normP === normW ? "" : normP;
}

/** Last non-empty path segment — the folder name shown in the header. */
export function basename(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}
