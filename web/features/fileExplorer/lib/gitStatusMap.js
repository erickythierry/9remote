import { REPO_SCAN } from "@/features/terminal/constants/terminalConfig.js";

// Git status → path map with parent-folder propagation.
// Both explorers need "this folder contains changes" badges, and each had its own
// copy of the walk (with different loop directions and payload shapes). One
// implementation, so a fix lands in both.

/**
 * Build `{ relativePath: status }` from a gitStatus() result, marking every parent
 * directory of a changed file as "folder-changed".
 * Accepts both payload shapes seen from the host: {path,status} and {file,code}.
 * `prefix` re-keys a nested repo's entries under their path relative to the workspace.
 * `stripPrefix` strips leading path segments when workspace is a subdirectory in a repo.
 */
export function buildGitStatusMap(result, prefix = "", stripPrefix = "") {
  if (!result?.success) return {};
  const list = result.files || result.status || [];
  const map = {};
  for (const entry of list) {
    let rel = (entry?.path || entry?.file || "").replace(/\\/g, "/");
    const status = entry?.status || entry?.code;
    if (!rel || !status) continue;
    if (stripPrefix) {
      if (!rel.startsWith(stripPrefix)) continue;
      rel = rel.slice(stripPrefix.length);
    }
    const fullRel = (prefix + rel).replace(/\/+/g, "/").replace(/^\//, "");
    if (!fullRel) continue;
    map[fullRel] = status;
    // Mark all ancestors so a collapsed folder still shows it has changes inside.
    const parts = fullRel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (!map[parent]) map[parent] = "folder-changed";
    }
  }
  return map;
}

/**
 * Status map for a workspace that may not be a repo itself — a parent folder holding
 * nested repos, or a subdirectory of a repository.
 * Returns { hasGit, map }: hasGit is true for a repo root OR any nested repo.
 */
export async function buildWorkspaceGitStatus(fileBus, workspace) {
  const root = await fileBus.gitStatus(workspace);
  let rootMap = {};
  let rootHasGit = false;

  if (root?.success) {
    rootHasGit = true;
    const gitRoot = root.gitRoot || root.repoRoot;
    let stripPrefix = "";
    if (gitRoot && workspace) {
      const normRoot = gitRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      const normWs = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
      if (normWs.startsWith(`${normRoot}/`)) {
        stripPrefix = normWs.slice(normRoot.length + 1) + "/";
      }
    }
    rootMap = buildGitStatusMap(root, "", stripPrefix);
  }

  const scan = await fileBus.gitScanRepos?.(workspace, REPO_SCAN.maxDepth);
  const repos = (scan?.success ? scan.repos : []) || [];
  const nested = repos.filter((r) => r.path !== workspace && r.relPath);

  if (!nested.length) {
    return { hasGit: rootHasGit, map: rootMap };
  }

  const maps = await Promise.all(nested.map(async (repo) => {
    // Windows hosts send relPath with backslashes; map keys are forward-slash.
    const rel = String(repo.relPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!rel) return null;
    const res = await fileBus.gitStatus(repo.path);
    if (!res?.success) return null;
    const map = buildGitStatusMap(res, `${rel}/`);
    if (Object.keys(map).length) map[rel] ||= "folder-changed";
    return map;
  }));

  const merged = Object.assign({}, rootMap, ...maps.filter(Boolean));
  return { hasGit: rootHasGit || maps.some(Boolean), map: merged };
}

/**
 * Shallow-equal check used to keep the previous object reference when nothing
 * changed — the map feeds every row, so a new reference re-renders the whole tree.
 */
export function sameStatusMap(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const k of kb) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
