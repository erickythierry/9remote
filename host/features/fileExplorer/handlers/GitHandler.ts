import type { ExplorerSocket } from "../fileExplorerSocket.js";
import fs from "fs";
import path from "path";
import { spawn, spawnSync, execSync, type SpawnOptions } from "child_process";
import { BINARY_EXTENSIONS, MAX_FILE_SIZE, DEFAULT_GIT_LOG_LIMIT, MAX_GIT_OUTPUT_SIZE, MAX_GIT_DIFF_SIZE, MIME_BY_EXT, MAX_IMAGE_RAW_SIZE } from "../constants.js";
import { isSensitivePath } from "../pathGuard.js";
import { scaleImageBuffer } from "./FileHandler.js";
import {
  scanReposCached, invalidateRepoScan, parseWorktreeList, parseBranchList, terminalsInWorktree
} from "../gitRepoScan.js";
import { switchBranch } from "../gitBranchSwitch.js";
import { listSessionRoots } from "../../terminal/terminalSocket.js";
import { destroySessionById } from "../../terminal/handlers/SessionHandler.js";
import { getSessionAgent } from "../../terminal/statusManager.js";
import { findGitRoot } from "../../terminal/workspaceMigration.js";

type Cb = (res: Record<string, unknown>) => void;

// Narrows an unknown catch variable to its message; the value read is unchanged.
const errMsg = (e: unknown): string => (e as { message: string }).message;

// Per-cwd TTL cache for gitChangedCount badge — prevents repeated git spawns on
// rapid requests (e.g. terminal typing re-rendering the file watcher effect).
const GIT_COUNT_TTL_MS = 5000;
type CountEntry = { ts: number; value: { success: boolean; count?: number; ahead?: number; behind?: number; error?: string }; pending: Promise<CountResult> | null };
const _countCache = new Map<string, CountEntry>(); // repoPath → { ts, value, pending }

const GIT_FETCH_TTL_MS = 60000;
const GIT_FETCH_TIMEOUT_MS = 20000;
const _fetchCache = new Map<string, { ts: number; pending: Promise<void> | null }>(); // repoPath → { ts, pending }

// Background `git fetch` so ahead/behind sees new origin commits. Never prompts for
// credentials (a prompt would hang until the timeout); failures are ignored, the old refs stay.
function fetchRepoCached(repoPath: string, force: boolean) {
  const cached = _fetchCache.get(repoPath);
  if (cached?.pending) return cached.pending;
  if (!force && cached && Date.now() - cached.ts < GIT_FETCH_TTL_MS) return Promise.resolve();
  const pending = runGit(["fetch", "--quiet", "--no-tags"], repoPath, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: GIT_FETCH_TIMEOUT_MS
  }).then(async (r) => {
    if (r && r.code !== 0 && isAuthFailure(r.stderr)) {
      await tryRemoteFallback(repoPath, ["fetch", "--quiet", "--no-tags"]);
    }
    _fetchCache.set(repoPath, { ts: Date.now(), pending: null });
  });
  _fetchCache.set(repoPath, { ts: cached?.ts ?? 0, pending });
  return pending;
}

// Changed-file count for one repo, TTL-cached and de-duplicated: a spawn already in
// flight is awaited rather than repeated.
type CountResult = { success: boolean; count?: number; ahead?: number; behind?: number; error?: string };
async function changedCountCached(repoPath: string | undefined, force: boolean): Promise<CountResult> {
  if (!repoPath || !findGitRoot(repoPath)) return { success: false, error: "Not a git repository or git not available" };
  const cached = _countCache.get(repoPath);
  const now = Date.now();
  if (!force && cached && now - cached.ts < GIT_COUNT_TTL_MS) return cached.value;
  if (cached?.pending) {
    try { return await cached.pending; } catch { return { success: false }; }
  }
  const pending: Promise<CountResult> = Promise.all([
    runGit(["status", "--porcelain", "--no-renames", "-uall"], repoPath),
    runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], repoPath)
  ]).then(([r, ab]) => {
    // No upstream makes rev-list fail: leave ahead/behind at 0.
    const [behind = 0, ahead = 0] = ab.code === 0 ? ab.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0) : [];
    const value = r.code === 0
      ? { success: true, count: r.stdout.trim() ? r.stdout.trim().split("\n").length : 0, ahead, behind }
      : { success: false, error: "Not a git repository or git not available" };
    _countCache.set(repoPath, { ts: Date.now(), value, pending: null });
    return value;
  }).catch((): CountResult => ({ success: false }));
  _countCache.set(repoPath, { ts: now, value: { success: false }, pending });
  try { return await pending; } catch { return { success: false }; }
}

// Agents launched from launchers/services inherit a minimal PATH where git is
// invisible (spawn ENOENT) — resolve the binary once, then reuse everywhere.
const GIT_BIN_NOT_FOUND = "git not found on this machine";
const gitBinProbe = (bin: string): boolean => {
  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8", windowsHide: true, timeout: 5000 });
    return !r.error;
  } catch { return false; }
};
function resolveGitBin() {
  if (gitBinProbe("git")) return "git";
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files (x86)\\Git\\cmd\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  return candidates.find(gitBinProbe) || null;
}
const GIT_BIN = resolveGitBin();

export type GitResult = { code: number | null; stdout: string; stderr: string };

export function runGit(args: string[], cwd: string, opts: SpawnOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    if (!GIT_BIN) return resolve({ code: -1, stdout: "", stderr: GIT_BIN_NOT_FOUND });
    const child = spawn(GIT_BIN, args, { cwd, windowsHide: true, ...opts });
    let stdout = "", stderr = "";
    // Pipes are the default for spawn, so these guards never skip in practice.
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const AUTH_FAILURE_REGEX = /could not read (username|password)|terminal prompts disabled|authentication failed|permission denied \(publickey\)|invalid username or password|(?:HTTP|error:?)\s*(?:401|403)/i;

export function isAuthFailure(output: string | null | undefined): boolean {
  if (!output) return false;
  return AUTH_FAILURE_REGEX.test(output);
}

export function toSshUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.trim().match(/^https?:\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
  if (!match) return null;
  return `git@${match[1]}:${match[2]}`;
}

export function toHttpsUrl(url: string | null | undefined): string | null {
  if (!url || /^https?:\/\//i.test(url)) return null;
  const match = url.trim().match(/^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)(?::\d+)?[:/](.+)$/);
  if (!match) return null;
  return `https://${match[1]}/${match[2].replace(/^\/+/, "")}`;
}

async function getRemoteNameAndUrl(repoPath: string): Promise<{ remoteName: string; remoteUrl: string } | null> {
  const branchRes = await runGit(["branch", "--show-current"], repoPath);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : "";
  let remoteName = "origin";
  if (branch) {
    const r = await runGit(["config", `branch.${branch}.remote`], repoPath);
    if (r.code === 0 && r.stdout.trim()) remoteName = r.stdout.trim();
  }
  const urlRes = await runGit(["remote", "get-url", remoteName], repoPath);
  if (urlRes.code === 0 && urlRes.stdout.trim()) {
    return { remoteName, remoteUrl: urlRes.stdout.trim() };
  }
  return null;
}

// Transparent fallback between HTTPS and SSH: if pushing/pulling fails with an auth
// error (e.g. HTTPS repo on a machine that uses SSH keys, or vice-versa), try the alternative protocol.
export async function tryRemoteFallback(repoPath: string, gitArgs: string[]): Promise<{ attempted: false } | { attempted: true; result: GitResult; output: string }> {
  const remoteInfo = await getRemoteNameAndUrl(repoPath);
  if (!remoteInfo) return { attempted: false };
  const { remoteName, remoteUrl } = remoteInfo;

  let altUrl = null;
  if (/^https?:\/\//i.test(remoteUrl)) {
    altUrl = toSshUrl(remoteUrl);
  } else if (/^(?:ssh:\/\/)?(?:[^@]+@)?[^:/]+[:/]/i.test(remoteUrl)) {
    altUrl = toHttpsUrl(remoteUrl);
  }

  if (!altUrl || altUrl === remoteUrl) return { attempted: false };

  const setAlt = await runGit(["remote", "set-url", remoteName, altUrl], repoPath);
  if (setAlt.code !== 0) return { attempted: false };

  const retryRes = await runGit(gitArgs, repoPath, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const retryOutput = (retryRes.stdout + retryRes.stderr).trim();

  if (retryRes.code === 0) {
    return { attempted: true, result: retryRes, output: retryOutput };
  }

  await runGit(["remote", "set-url", remoteName, remoteUrl], repoPath);
  return { attempted: false };
}

// Sync no-shell git for legacy sync handlers. args is an argv array (never a template
// string) so socket-controlled paths cannot inject shell metacharacters.
export function runGitSync(args: string[], cwd: string): string {
  if (!GIT_BIN) throw new Error(GIT_BIN_NOT_FOUND);
  const r = spawnSync(GIT_BIN, args, {
    cwd, encoding: "utf-8", windowsHide: true, maxBuffer: MAX_GIT_OUTPUT_SIZE
  });
  // ENOBUFS means the output was cut mid-diff — returning it would look like a smaller
  // change set rather than a failure, so it has to surface.
  if (r.error) throw r.error;
  return r.stdout ?? "";
}

function isBinaryFile(filename: string) {
  return BINARY_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

// Accepts a path either relative to the repo or absolute inside it, and always yields the
// repo-relative form git expects. A path outside the repo is left alone so git rejects it
// rather than this silently rewriting it.
function toRepoRelative(repoPath: string | undefined, file: string | undefined): string | undefined {
  if (!file || !repoPath || !path.isAbsolute(file)) return file;
  const rel = path.relative(repoPath, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join("/");
}

// A diff too large to render is truncated with a visible marker — never dropped, which
// the UI would show as "no changes".
function capDiff(diff: string): string {
  if (diff.length <= MAX_GIT_DIFF_SIZE) return diff;
  return `${diff.slice(0, MAX_GIT_DIFF_SIZE)}\n\n... diff truncated (over ${Math.round(MAX_GIT_DIFF_SIZE / 1024 / 1024)}MB)`;
}

export function setupGitHandlers(socket: ExplorerSocket) {
  socket.on("gitStatus", ({ repoPath }: { repoPath: string }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    const gitRoot = findGitRoot(repoPath);
    if (!gitRoot) return callback({ success: false, error: "Not a git repository or git not available" });
    try {
      // -uall: without it git collapses an untracked directory into one entry, which the
      // UI then opens as a file (EISDIR) and counts as zero added lines.
      const result = execSync("git status --porcelain --no-renames -uall", {
        cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true
      });

      // Get diff stats for tracked files
      const diffStats: Record<string, { added: number; deleted: number }> = {};
      try {
        const statResult = execSync("git diff HEAD --numstat --no-renames", {
          cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true
        });
        statResult.trim().split("\n").filter(Boolean).forEach(line => {
          const parts = line.split("\t");
          if (parts.length >= 3) {
            diffStats[parts[2]] = {
              added: parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0,
              deleted: parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0
            };
          }
        });
      } catch {}

      const files = [];
      for (const line of result.trim().split("\n").filter(Boolean)) {
        const match = line.match(/^([MADRCU?! ]{1,2})\s+(.+)$/);
        if (!match) continue;
        const statusCode = match[1];
        // git wraps paths with special chars in double quotes; strip them.
        // Trim trailing CR (CRLF output) / whitespace that breaks path joins.
        let filePath = match[2].replace(/\r+$/, "").trim();
        if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
        if (!filePath) continue;

        let status;
        if (statusCode.includes("?")) status = "?";
        else if (statusCode.includes("A")) status = "A";
        else if (statusCode.includes("D")) status = "D";
        else if (statusCode.includes("M")) status = "M";
        else if (statusCode.includes("R")) status = "R";
        else status = statusCode.trim()[0] || "?";

        const stats = diffStats[filePath] || { added: 0, deleted: 0 };
        if (status === "?") {
          try {
            const fullPath = path.join(gitRoot, filePath);
            if (fs.existsSync(fullPath) && !isBinaryFile(filePath) && !isSensitivePath(fullPath)) {
              const content = fs.readFileSync(fullPath, "utf-8");
              stats.added = content.split("\n").length;
              stats.deleted = 0;
            }
          } catch {}
        }

        files.push({ status, path: filePath, file: filePath, added: stats.added, deleted: stats.deleted });
      }

      callback({ success: true, files, gitRoot });
    } catch {
      callback({ success: false, error: "Not a git repository or git not available" });
    }
  });

  // Lightweight: only the count of changed files (badge), avoids sending the full list.
  // Async (runGit = spawn) + per-cwd TTL cache so rapid requests (e.g. typing) don't
  // spawn git repeatedly or block the event loop.
  socket.on("gitChangedCount", async ({ repoPath, force }: { repoPath: string; force?: boolean }, callback: Cb) => {
    callback(await changedCountCached(repoPath, !!force));
  });

  // One number for the whole workspace: the root repo plus every repo under it, so the
  // terminal badge and the git panel can never disagree. Shares the per-repo TTL cache
  // with gitChangedCount/gitScanRepos, so polling this costs nothing extra.
  socket.on("gitWorkspaceChangedCount", async ({ rootPath, maxDepth, force, fetch }: { rootPath?: string; maxDepth?: number; force?: boolean; fetch?: boolean }, callback: Cb) => {
    if (!rootPath) return callback({ success: false, error: "rootPath required" });
    if (isSensitivePath(rootPath)) return callback({ success: false, error: "Access denied" });
    try {
      const found = scanReposCached(rootPath, maxDepth ? { maxDepth } : {});
      if (fetch) await Promise.all(found.map((repo) => fetchRepoCached(repo.path, !!force)));
      const results: [string, CountResult][] = await Promise.all(found.map(async (repo) => [repo.path, await changedCountCached(repo.path, !!force || !!fetch)] as [string, CountResult]));
      const perRepo: Record<string, number> = {};
      const syncPerRepo: Record<string, { ahead?: number; behind?: number }> = {};
      let count = 0;
      for (const [repoPath, res] of results) {
        if (!res.success) continue;
        const n = res.count ?? 0;
        perRepo[repoPath] = n;
        syncPerRepo[repoPath] = { ahead: res.ahead, behind: res.behind };
        count += n;
      }
      callback({ success: true, count, perRepo, syncPerRepo });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitFileStatus", ({ repoPath, filePath }: { repoPath: string; filePath: string }, callback: Cb) => {
    if (!repoPath || !findGitRoot(repoPath)) return callback({ success: true, status: null });
    try {
      const relativePath = path.relative(repoPath, filePath);
      const result = runGitSync(["status", "--porcelain", "--", relativePath], repoPath);

      const line = result.trim();
      if (!line) return callback({ success: true, status: null });

      const match = line.match(/^([MADRCU?! ]{1,2})\s+(.+)$/);
      if (!match) return callback({ success: true, status: null });

      const statusCode = match[1];
      let status;
      if (statusCode.includes("?")) status = "?";
      else if (statusCode.includes("A")) status = "A";
      else if (statusCode.includes("D")) status = "D";
      else if (statusCode.includes("M")) status = "M";
      else if (statusCode.includes("R")) status = "R";
      else status = statusCode.trim()[0] || "?";

      callback({ success: true, status, file: relativePath });
    } catch {
      callback({ success: true, status: null });
    }
  });

  socket.on("gitDiff", ({ repoPath, file: rawFile, status }: { repoPath: string; file?: string; status?: string }, callback: Cb) => {
    if (!repoPath || !findGitRoot(repoPath)) return callback({ success: false, error: "Not a git repository" });
    try {
      let diff = "";
      // Callers hand this over either way: the git panel sends a repo-relative path, the
      // mobile editor an absolute one. Joining an absolute path onto the repo would point
      // at /repo/repo/file and read as an empty diff.
      const file = toRepoRelative(repoPath, rawFile);

      if (file && status === "?") {
        const filePath = path.join(repoPath, file);
        if (fs.existsSync(filePath) && !isSensitivePath(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
        }
      } else if (file) {
        diff = runGitSync(["diff", "HEAD", "--", file], repoPath);
      } else {
        diff = runGitSync(["diff", "HEAD"], repoPath);

        const statusResult = runGitSync(["status", "--porcelain", "--no-renames", "-uall"], repoPath);
        const untrackedFiles = statusResult.trim().split("\n")
          .filter(line => line.startsWith("??"))
          .map(line => line.substring(3));

        for (const untrackedFile of untrackedFiles) {
          const filePath = path.join(repoPath, untrackedFile);
          if (fs.existsSync(filePath) && !isBinaryFile(untrackedFile) && !isSensitivePath(filePath)) {
            try {
              const stat = fs.statSync(filePath);
              if (stat.size <= MAX_FILE_SIZE) {
                const content = fs.readFileSync(filePath, "utf-8");
                const lines = content.split("\n");
                diff += `\ndiff --git a/${untrackedFile} b/${untrackedFile}\nnew file mode 100644\n--- /dev/null\n+++ b/${untrackedFile}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
              }
            } catch {}
          }
        }
      }

      callback({ success: true, diff: capDiff(diff) });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitShowMedia", async ({ repoPath, file: rawFile, ref = "HEAD" }: { repoPath: string; file?: string; ref?: string }, callback: Cb) => {
    try {
      if (!repoPath) return callback({ success: false, error: "Missing repoPath" });
      const file = toRepoRelative(repoPath, rawFile);
      if (!file) return callback({ success: false, error: "Invalid path" });

      const fullPath = path.join(repoPath, file);
      if (isSensitivePath(fullPath)) return callback({ success: false, error: "Access denied" });

      if (!GIT_BIN) throw new Error(GIT_BIN_NOT_FOUND);
      const r = spawnSync(GIT_BIN, ["show", `${ref}:${file}`], {
        cwd: repoPath,
        maxBuffer: MAX_IMAGE_RAW_SIZE,
        windowsHide: true
      });

      if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
        return callback({ success: false, error: r.stderr?.toString() || "File not found in git ref" });
      }

      const buffer = r.stdout;
      const ext = path.extname(file).toLowerCase().slice(1);
      const mime = MIME_BY_EXT[ext] || "image/png";
      const isImage = mime.startsWith("image/");

      if (isImage) {
        try {
          const scaled = await scaleImageBuffer(buffer, file);
          const dataUrl = `data:image/jpeg;base64,${scaled.buffer.toString("base64")}`;
          return callback({
            success: true,
            dataUrl,
            size: buffer.length,
            mime,
            width: scaled.width,
            height: scaled.height,
            originalWidth: scaled.originalWidth,
            originalHeight: scaled.originalHeight
          });
        } catch {
          const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
          return callback({ success: true, dataUrl, size: buffer.length, mime });
        }
      }

      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      callback({ success: true, dataUrl, size: buffer.length, mime });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitBranch", async ({ repoPath }: { repoPath: string }, callback: Cb) => {
    if (!repoPath || !findGitRoot(repoPath)) return callback({ success: false });
    try {
      const r = await runGit(["branch", "--show-current"], repoPath);
      if (r.code !== 0) return callback({ success: false });
      const result: { success: boolean; branch: string; ahead?: number | null; behind?: number | null } = { success: true, branch: r.stdout.trim() };
      // ahead/behind upstream @{u}; absent upstream → null (still success).
      const ab = await runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], repoPath);
      if (ab.code === 0) {
        const [behind, ahead] = ab.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
        result.ahead = Number.isFinite(ahead) ? ahead : null;
        result.behind = Number.isFinite(behind) ? behind : null;
      } else {
        result.ahead = null;
        result.behind = null;
      }
      callback(result);
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitAdd", async ({ repoPath, files }: { repoPath: string; files?: string[] }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      const list = Array.isArray(files) && files.length ? files : ["."];
      const r = await runGit(["add", "--", ...list], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitReset", async ({ repoPath, files }: { repoPath: string; files?: string[] }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      const list = Array.isArray(files) && files.length ? files : ["."];
      const r = await runGit(["reset", "HEAD", "--", ...list], repoPath);
      callback({ success: r.code === 0, error: r.code === 0 ? undefined : r.stderr.trim() });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitCommit", async ({ repoPath, message }: { repoPath: string; message?: string }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      if (!message) return callback({ success: false, error: "Empty message" });
      const r = await runGit(["commit", "-m", message], repoPath);
      const output = (r.stdout + r.stderr).trim();
      if (r.code !== 0) return callback({ success: false, output, error: r.stderr.trim() });
      callback({ success: true, output });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitPush", async ({ repoPath }: { repoPath: string }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      let r = await runGit(["push"], repoPath, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      let output = (r.stdout + r.stderr).trim();
      if (r.code !== 0 && isAuthFailure(output)) {
        const fallback = await tryRemoteFallback(repoPath, ["push"]);
        if (fallback.attempted) {
          r = fallback.result;
          output = fallback.output;
        }
      }
      if (r.code !== 0) return callback({ success: false, output, error: r.stderr.trim() });
      callback({ success: true, output });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitPull", async ({ repoPath }: { repoPath: string }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      let r = await runGit(["pull"], repoPath, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      let output = (r.stdout + r.stderr).trim();
      if (r.code !== 0 && isAuthFailure(output)) {
        const fallback = await tryRemoteFallback(repoPath, ["pull"]);
        if (fallback.attempted) {
          r = fallback.result;
          output = fallback.output;
        }
      }
      if (r.code !== 0) return callback({ success: false, output, error: r.stderr.trim() });
      callback({ success: true, output });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitLog", async ({ repoPath, limit }: { repoPath: string; limit?: number }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      const n = typeof limit === "number" && limit > 0 ? limit : DEFAULT_GIT_LOG_LIMIT;
      const r = await runGit(["log", `-n`, String(n), "--pretty=format:%h%x09%s"], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      const commits = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [hash, ...rest] = line.split("\t");
        return { hash, message: rest.join("\t") };
      });
      callback({ success: true, commits });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitDiscard", ({ repoPath, file, status }: { repoPath: string; file?: string; status?: string }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    try {
      if (!file) return callback({ success: false, error: "No file specified" });
      const filePath = path.join(repoPath, file);

      if (isSensitivePath(filePath)) return callback({ success: false, error: "Access denied" });

      if (status === "?") {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          stat.isDirectory() ? fs.rmSync(filePath, { recursive: true }) : fs.unlinkSync(filePath);
        }
      } else if (status === "A") {
        runGitSync(["reset", "HEAD", "--", file], repoPath);
        if (fs.existsSync(filePath) && !isSensitivePath(filePath)) fs.unlinkSync(filePath);
      } else {
        runGitSync(["checkout", "HEAD", "--", file], repoPath);
      }

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  // ---- Nested repos ----

  // Repos at or under a workspace root. Bounded by depth + wall clock and memoized per
  // root inside gitRepoScan, so expanding the tree never re-walks the disk.
  socket.on("gitScanRepos", async ({ rootPath, maxDepth, force }: { rootPath?: string; maxDepth?: number; force?: boolean }, callback: Cb) => {
    if (!rootPath) return callback({ success: false, error: "rootPath required" });
    if (isSensitivePath(rootPath)) return callback({ success: false, error: "Access denied" });
    try {
      const found = scanReposCached(rootPath, maxDepth ? { maxDepth } : {});
      // Branch + change count per repo, in parallel — a monorepo can hold a dozen.
      const repos = await Promise.all(found.map(async (repo) => {
        const [branchRes, countRes] = await Promise.all([
          runGit(["branch", "--show-current"], repo.path),
          changedCountCached(repo.path, !!force)
        ]);
        return {
          ...repo,
          name: path.basename(repo.path),
          branch: branchRes.code === 0 ? branchRes.stdout.trim() || null : null,
          changedCount: countRes.success ? countRes.count : 0
        };
      }));
      callback({ success: true, repos });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitRefreshRepos", ({ rootPath }: { rootPath?: string }, callback: Cb) => {
    invalidateRepoScan(rootPath);
    callback?.({ success: true });
  });

  // ---- Worktrees ----

  socket.on("gitWorktreeList", async ({ repoPath }: { repoPath: string }, callback: Cb) => {
    if (!repoPath || !findGitRoot(repoPath)) return callback({ success: false, error: "Not a git repository" });
    try {
      const r = await runGit(["worktree", "list", "--porcelain"], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      callback({ success: true, worktrees: parseWorktreeList(r.stdout) });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitWorktreeAdd", async ({ repoPath, worktreePath, branch, newBranch }: { repoPath: string; worktreePath?: string; branch?: string; newBranch?: boolean }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    if (!worktreePath || !branch) return callback({ success: false, error: "worktreePath and branch required" });
    if (isSensitivePath(worktreePath)) return callback({ success: false, error: "Access denied" });
    try {
      const args = newBranch
        ? ["worktree", "add", "-b", branch, worktreePath]
        : ["worktree", "add", worktreePath, branch];
      const r = await runGit(args, repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      invalidateRepoScan(repoPath);
      callback({ success: true, path: path.resolve(worktreePath) });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  // Refuses while terminals are still rooted inside, unless the client confirms — pulling
  // the directory out from under a running shell is not something to do silently.
  socket.on("gitWorktreeRemove", async ({ repoPath, worktreePath, force, confirmed, deleteBranch, probe }: { repoPath?: string; worktreePath?: string; force?: boolean; confirmed?: boolean; deleteBranch?: string; probe?: boolean }, callback: Cb) => {
    if (!worktreePath) return callback({ success: false, error: "worktreePath required" });
    if (isSensitivePath(worktreePath)) return callback({ success: false, error: "Access denied" });
    try {
      let mainRepo: string | undefined = repoPath;
      if (worktreePath && (repoPath === worktreePath || !repoPath || !fs.existsSync(repoPath))) {
        const gitFile = path.join(worktreePath, ".git");
        if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
          try {
            const content = fs.readFileSync(gitFile, "utf8");
            const match = content.match(/gitdir:\s*(.*)/i);
            if (match) {
              const gitDir = path.resolve(worktreePath, match[1].trim());
              const mainGitDir = gitDir.replace(/[/\\]worktrees[/\\][^/\\]+$/, "");
              const candidate = path.dirname(mainGitDir);
              if (fs.existsSync(candidate)) mainRepo = candidate;
            }
          } catch {}
        }
      }
      if (!mainRepo || !fs.existsSync(mainRepo)) mainRepo = repoPath;
      if (!mainRepo) return callback({ success: false, error: "repoPath required" });

      const busy = terminalsInWorktree(worktreePath, listSessionRoots());
      // Probe answers "what would removal take with it" — nothing is touched.
      if (probe) {
        const branch = typeof deleteBranch === "string" && !deleteBranch.startsWith("-") && !/\s/.test(deleteBranch) ? deleteBranch : null;
        let branchMerged = null;
        if (branch) {
          const m = await runGit(["branch", "--merged"], mainRepo);
          if (m.code === 0) branchMerged = m.stdout.split("\n").map((l) => l.replace(/^\*?\s+/, "").trim()).includes(branch);
        }
        return callback({
          success: true,
          probe: true,
          branchMerged,
          sessions: busy.map((s) => ({ id: s.id, name: s.name, chat: (getSessionAgent(s.id) || "").endsWith("-ui") }))
        });
      }
      if (busy.length && !confirmed) {
        return callback({ success: false, busy: busy.map((s) => ({ id: s.id, name: s.name })) });
      }
      // Close the rooted sessions first — on Windows a live cwd inside blocks the
      // removal, and the standard destroy path also tears down a chat CLI if any.
      for (const s of busy) await destroySessionById(s.id);
      if (!fs.existsSync(worktreePath)) {
        await runGit(["worktree", "prune"], mainRepo);
      } else {
        const args = ["worktree", "remove", worktreePath];
        if (force) args.splice(2, 0, "--force");
        const r = await runGit(args, mainRepo);
        if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      }
      invalidateRepoScan(mainRepo);
      if (repoPath !== mainRepo) invalidateRepoScan(repoPath);
      // Optional branch cleanup: safe delete only — git refuses unmerged or checked-out
      // branches, and a refusal keeps the branch rather than failing the removal.
      if (deleteBranch) {
        const branch = String(deleteBranch);
        if (branch.startsWith("-") || /\s/.test(branch)) {
          return callback({ success: true, branchKept: true, branchNote: "invalid branch name" });
        }
        const bd = await runGit(["branch", "-d", branch], mainRepo);
        if (bd.code !== 0) return callback({ success: true, branchKept: true, branchNote: bd.stderr.trim() });
      }
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  // ---- Branches ----

  socket.on("gitBranchList", async ({ repoPath }: { repoPath: string }, callback: Cb) => {
    if (!repoPath || !findGitRoot(repoPath)) return callback({ success: false, error: "Not a git repository" });
    try {
      const [branchRes, wtRes] = await Promise.all([
        runGit(["branch", "-a", "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)"], repoPath),
        runGit(["worktree", "list", "--porcelain"], repoPath)
      ]);
      if (branchRes.code !== 0) return callback({ success: false, error: branchRes.stderr.trim() });
      const worktrees = wtRes.code === 0 ? parseWorktreeList(wtRes.stdout) : [];
      callback({ success: true, branches: parseBranchList(branchRes.stdout, worktrees), worktrees });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  // A dirty tree makes git refuse the switch; surface its message verbatim rather than
  // reporting a generic failure the user cannot act on.
  socket.on("gitBranchCheckout", async ({ repoPath, branch, create }: { repoPath: string; branch?: string; create?: boolean }, callback: Cb) => {
    if (!repoPath) return callback({ success: false, error: "repoPath required" });
    if (!branch) return callback({ success: false, error: "branch required" });
    try {
      const r = await runGit(create ? ["checkout", "-b", branch] : ["checkout", branch], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() || r.stdout.trim() });
      callback({ success: true, branch });
    } catch (error) {
      callback({ success: false, error: errMsg(error) });
    }
  });

  socket.on("gitBranchSwitch", async ({ repoPath, branch, create, stash }: { repoPath?: string; branch?: unknown; create?: boolean; stash?: boolean }, callback: Cb) => {
    if (!repoPath || !findGitRoot(repoPath)) return callback({ success: false, code: "notRepo", error: "Not a git repository" });
    try {
      callback(await switchBranch(repoPath, { branch, create, stash }, runGit));
    } catch (error) {
      callback({ success: false, code: "unknown", error: errMsg(error) });
    }
  });
}
