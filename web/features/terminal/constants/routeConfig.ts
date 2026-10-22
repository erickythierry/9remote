// Workspace route <-> view mapping (single source of truth for URL sync)

export const WORKSPACE_BASE = "/workspace";

export type WorkspaceView =
  | { type: "list" }
  | { type: "terminal"; sessionId?: string }
  | { type: "files"; workspace?: string; currentPath?: string; fromTerminal?: boolean }
  | { type: "editor"; path?: string; line?: number; column?: number; workspace?: string; diffStatus?: string; preview?: boolean; artifactSessionId?: string | null }
  | { type: "git"; workspace?: string }
  | { type: "remote"; hostKey?: string }
  | { type: "mobile"; hostKey?: string }
  | { type: "workspaces" }
  | { type: "browse"; path?: string }
  | { type: "pair" }
  | { type: "welcome" }
  | { type: "browser"; hostKey?: string }

type PathView = {
  type?: string;
  sessionId?: string;
  workspace?: string;
  currentPath?: string;
  path?: string;
  line?: number;
  column?: number;
  fromTerminal?: boolean;
  diffStatus?: string;
  preview?: boolean;
  artifactSessionId?: string | null;
  hostKey?: string;
};

type SearchParamsLike = { get(key: string): string | null };

// View type -> URL builder. Path carries primary id; query carries extra data.
export const VIEW_TO_PATH: Record<string, (view?: PathView) => string> = {
  list: () => WORKSPACE_BASE,
  terminal: (view) => `${WORKSPACE_BASE}/terminal/${encodeURIComponent(view?.sessionId || "")}`,
  files: (view) => withQuery(`${WORKSPACE_BASE}/files`, { ws: view?.workspace, p: view?.currentPath }),
  editor: (view) => withQuery(`${WORKSPACE_BASE}/editor`, { path: view?.path, line: view?.line, col: view?.column }),
  git: (view) => withQuery(`${WORKSPACE_BASE}/git`, { ws: view?.workspace }),
  remote: () => `${WORKSPACE_BASE}/remote`,
  mobile: () => `${WORKSPACE_BASE}/mobile`,
  workspaces: () => `${WORKSPACE_BASE}/workspaces`,
  browse: (view) => withQuery(`${WORKSPACE_BASE}/browse`, { path: view?.path }),
  pair: () => `${WORKSPACE_BASE}/pair`,
  welcome: () => `${WORKSPACE_BASE}/welcome`
};

// Views rendered as a store-only overlay: never mirrored into the URL. The site
// browser's iframe piles its own entries onto the parent history, so keeping it
// out of history is the only way Back stays predictable.
export const OVERLAY_VIEWS = ["browser"];

// First path segment after base -> view type
const SEGMENT_TO_TYPE: Record<string, WorkspaceView["type"]> = {
  "": "list",
  terminal: "terminal",
  files: "files",
  editor: "editor",
  git: "git",
  remote: "remote",
  mobile: "mobile",
  workspaces: "workspaces",
  browse: "browse",
  pair: "pair",
  welcome: "welcome"
};

// Build "?a=b" string, skipping empty values
function withQuery(path: string, params: Record<string, string | number | null | undefined>): string {
  const qs = Object.entries(params)
    .filter(([, val]) => val != null && val !== "")
    .map(([key, val]) => `${key}=${encodeURIComponent(String(val))}`)
    .join("&");
  return qs ? `${path}?${qs}` : path;
}

// Parse a workspace URL into a view object (null = not a workspace route)
export function pathToView(pathname: string | null | undefined, searchParams?: SearchParamsLike | null): WorkspaceView | null {
  if (!pathname?.startsWith(WORKSPACE_BASE)) return null;
  const rest = pathname.slice(WORKSPACE_BASE.length).replace(/^\//, "");
  const [segment, idPart] = rest.split("/");
  const type = SEGMENT_TO_TYPE[segment || ""];
  if (!type) return null;
  const q = (key: string): string | undefined => searchParams?.get(key) || undefined;
  switch (type) {
    case "terminal": return { type, sessionId: idPart ? decodeURIComponent(idPart) : undefined };
    case "files": return { type, workspace: q("ws"), currentPath: q("p") };
    case "editor": return { type, path: q("path"), line: numOrUndef(q("line")), column: numOrUndef(q("col")) };
    case "git": return { type, workspace: q("ws") };
    case "browse": return { type, path: q("path") };
    default: return { type };
  }
}

// Build URL string from a view object
export function viewToPath(view: WorkspaceView | null | undefined): string {
  const build = VIEW_TO_PATH[view?.type || ""] || VIEW_TO_PATH.list;
  return build(view ?? undefined);
}

// Resolve a view parsed from the URL against the current stack.
// Returns the stack to adopt, or null when the view is a genuinely new level (push it).
export function stackForUrl(viewStack: WorkspaceView[], view: WorkspaceView): WorkspaceView[] | null {
  const target = viewToPath(view);
  // The URL names a view the stack already holds lower down (Back out of files/editor):
  // cut back to that entry. Pushing instead left a duplicate terminal above the original,
  // so the next Back landed on the old terminal — which reads as a tab switch.
  const seen = viewStack.findIndex((existing) => viewToPath(existing) === target);
  if (seen !== -1) return viewStack.slice(0, seen + 1);
  if (view.type === "terminal" && viewStack[viewStack.length - 1]?.type === "terminal") {
    // Tab switch within terminal view = same level, replace top instead of growing stack
    const next = [...viewStack];
    next[next.length - 1] = view;
    return next;
  }
  return null;
}

function numOrUndef(val: string | undefined): number | undefined {
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}
