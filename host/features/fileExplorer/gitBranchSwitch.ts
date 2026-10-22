// Branch switching with the failures a user can act on named instead of dumped as git stderr.
// `git switch` carries local changes along when it can; it only refuses when the target
// branch touches the same files, which is exactly when a stash is the way out.
import fs from "fs";
import path from "path";

// Files whose presence means a merge/rebase/etc. owns the working tree.
const IN_PROGRESS_MARKERS = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"]
];

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

type SwitchFailure = { success: false; code: string; error: string; [extra: string]: unknown };
type SwitchResult = { success: true; branch: string; stashed?: boolean } | SwitchFailure;

const failure = (code: string, error: string, extra: Record<string, unknown> = {}): SwitchFailure => ({ success: false, code, error, ...extra });

// Maps git's stderr to a stable code. The raw text stays in `error` for the unknown case.
export function classifySwitchError(text = ""): SwitchFailure {
  const msg = text.trim();
  if (/would be overwritten by (checkout|switch)/i.test(msg)) {
    const files = msg.split("\n").filter((l) => /^\s+\S/.test(l)).map((l) => l.trim());
    return failure("dirtyConflict", msg, { files });
  }
  const wt = msg.match(/already (?:used by worktree|checked out) at '([^']+)'/i);
  if (wt) return failure("inWorktree", msg, { path: wt[1] });
  if (/index\.lock/i.test(msg)) return failure("locked", msg);
  if (/resolve your current index first|needs merge|unmerged/i.test(msg)) return failure("unmerged", msg);
  if (/already exists/i.test(msg)) return failure("exists", msg);
  if (/not a valid branch name/i.test(msg)) return failure("invalidName", msg);
  if (/invalid reference|invalid object name|did not match any|unknown (?:branch|revision)|not a commit/i.test(msg)) {
    return failure("notFound", msg);
  }
  return failure("unknown", msg || "git switch failed");
}

// Which operation (merge, rebase…) is mid-flight in this working tree, or "".
export async function operationInProgress(repoPath: string, run: RunGit): Promise<string> {
  const r = await run(["rev-parse", "--absolute-git-dir"], repoPath);
  if (r.code !== 0) return "";
  const gitDir = r.stdout.trim();
  return IN_PROGRESS_MARKERS.find(([name]) => fs.existsSync(path.join(gitDir, name)))?.[1] || "";
}

async function unmergedFiles(repoPath: string, run: RunGit): Promise<string[]> {
  const r = await run(["diff", "--name-only", "--diff-filter=U"], repoPath);
  return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

// A remote ref ("origin/x") with no local branch of that name becomes a tracking branch.
async function switchArgs(repoPath: string, branch: string, create: boolean, run: RunGit): Promise<string[]> {
  if (create) return ["switch", "-c", branch];
  const local = await run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
  if (local.code === 0) return ["switch", branch];
  const remote = await run(["show-ref", "--verify", "--quiet", `refs/remotes/${branch}`], repoPath);
  if (remote.code !== 0) return ["switch", branch];
  const localName = branch.slice(branch.indexOf("/") + 1);
  const hasLocal = await run(["show-ref", "--verify", "--quiet", `refs/heads/${localName}`], repoPath);
  return hasLocal.code === 0 ? ["switch", localName] : ["switch", "--track", branch];
}

/**
 * @param run (args, cwd) => Promise<{ code, stdout, stderr }>
 * Resolves { success: true, branch, stashed? } or { success: false, code, error, ... }.
 */
export async function switchBranch(
  repoPath: string,
  { branch, create = false, stash = false }: { branch?: unknown; create?: boolean; stash?: boolean } = {},
  run: RunGit
): Promise<SwitchResult> {
  if (typeof branch !== "string" || !branch.trim()) return failure("invalidName", "branch required");
  // A leading dash would be read by git as an option.
  if (branch.startsWith("-")) return failure("invalidName", `Invalid branch name: ${branch}`);

  const operation = await operationInProgress(repoPath, run);
  if (operation) return failure("operationInProgress", `A ${operation} is in progress`, { operation });
  const unmerged = await unmergedFiles(repoPath, run);
  if (unmerged.length) return failure("unmerged", "Unresolved merge conflicts", { files: unmerged });

  if (create) {
    const valid = await run(["check-ref-format", "--branch", branch], repoPath);
    if (valid.code !== 0) return failure("invalidName", `Invalid branch name: ${branch}`);
  }

  const args = await switchArgs(repoPath, branch, create, run);
  let res = await run(args, repoPath);
  if (res.code === 0) return { success: true, branch };

  const failed = classifySwitchError(res.stderr || res.stdout);
  if (failed.code !== "dirtyConflict" || !stash) return failed;

  // -u so untracked files that block the switch are set aside too.
  const saved = await run(["stash", "push", "-u", "-m", `9remote: before switching to ${branch}`], repoPath);
  if (saved.code !== 0) return classifySwitchError(saved.stderr || saved.stdout);
  res = await run(args, repoPath);
  if (res.code === 0) return { success: true, branch, stashed: true };

  // The switch still failed: put the work back so the stash is not left behind for nothing.
  await run(["stash", "pop"], repoPath);
  return classifySwitchError(res.stderr || res.stdout);
}
