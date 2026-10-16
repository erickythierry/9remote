// Branch switching against real throwaway repos: the failure classes come from git's own
// stderr, so faking git would test nothing.
// Run: node host/test/gitBranchSwitch.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { switchBranch, classifySwitchError } from "../features/fileExplorer/gitBranchSwitch.js";

let pass = 0, fail = 0;
const test = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const run = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return Promise.resolve({ code: r.status, stdout: r.stdout, stderr: r.stderr });
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const current = (cwd) => git(cwd, "branch", "--show-current");

const roots = [];
// main has a.txt; "other" changes a.txt, so a dirty a.txt blocks switching to it.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbs-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "branch", "clean");
  git(dir, "switch", "-qc", "other");
  fs.writeFileSync(path.join(dir, "a.txt"), "other\n");
  git(dir, "commit", "-qam", "other change");
  git(dir, "switch", "-q", "main");
  return dir;
}

await test("a clean tree switches", async () => {
  const dir = makeRepo();
  const r = await switchBranch(dir, { branch: "other" }, run);
  assert.deepEqual(r, { success: true, branch: "other" });
  assert.equal(current(dir), "other");
});

await test("changes in files the target does not touch ride along", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "b.txt"), "edited\n");
  const r = await switchBranch(dir, { branch: "other" }, run);
  assert.equal(r.success, true);
  assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "edited\n");
});

await test("a change the target would overwrite is refused and names the file", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "mine\n");
  const r = await switchBranch(dir, { branch: "other" }, run);
  assert.equal(r.success, false);
  assert.equal(r.code, "dirtyConflict");
  assert.deepEqual(r.files, ["a.txt"]);
  assert.equal(current(dir), "main", "a refused switch leaves the branch alone");
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "mine\n");
});

await test("stash sets the work aside, switches, and keeps the stash", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "mine\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "untracked\n");
  const r = await switchBranch(dir, { branch: "other", stash: true }, run);
  assert.deepEqual(r, { success: true, branch: "other", stashed: true });
  assert.equal(current(dir), "other");
  assert.match(git(dir, "stash", "list"), /before switching to other/);
});

await test("a switch that fails after stashing puts the work back", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "mine\n");
  // Real git for everything except the retry: the second switch is made to fail.
  let switches = 0;
  const flaky = (args, cwd) => {
    if (args[0] === "switch" && ++switches === 2) return Promise.resolve({ code: 128, stdout: "", stderr: "fatal: boom" });
    return run(args, cwd);
  };
  const r = await switchBranch(dir, { branch: "other", stash: true }, flaky);
  assert.equal(r.code, "unknown");
  assert.equal(current(dir), "main");
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "mine\n", "the edit is back in the tree");
  assert.equal(git(dir, "stash", "list"), "", "nothing left stranded in the stash");
});

await test("a branch checked out in another worktree reports where", async () => {
  const dir = makeRepo();
  const wt = path.join(dir, "..", path.basename(dir) + "-wt2");
  roots.push(wt);
  git(dir, "worktree", "add", "-q", wt, "other");
  const r = await switchBranch(dir, { branch: "other" }, run);
  assert.equal(r.code, "inWorktree");
  assert.equal(fs.realpathSync(r.path), fs.realpathSync(wt));
});

await test("a merge in progress blocks the switch", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "main side\n");
  git(dir, "commit", "-qam", "main change");
  spawnSync("git", ["merge", "other"], { cwd: dir });
  const r = await switchBranch(dir, { branch: "clean" }, run);
  assert.equal(r.success, false);
  assert.equal(r.code, "operationInProgress");
  assert.equal(r.operation, "merge");
});

await test("unresolved conflicts are listed when no operation marker applies", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "main side\n");
  git(dir, "commit", "-qam", "main change");
  spawnSync("git", ["merge", "other"], { cwd: dir });
  fs.rmSync(path.join(spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: dir, encoding: "utf8" }).stdout.trim(), "MERGE_HEAD"));
  const r = await switchBranch(dir, { branch: "clean" }, run);
  assert.equal(r.code, "unmerged");
  assert.deepEqual(r.files, ["a.txt"]);
});

await test("a remote-only branch becomes a local tracking branch", async () => {
  const dir = makeRepo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "gbs-remote-"));
  roots.push(remote);
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "other");
  git(dir, "branch", "-D", "other");
  git(dir, "fetch", "-q", "origin");
  const r = await switchBranch(dir, { branch: "origin/other" }, run);
  assert.equal(r.success, true);
  assert.equal(current(dir), "other");
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "other@{u}"), "origin/other");
});

await test("create makes a new branch and rejects a bad or taken name", async () => {
  const dir = makeRepo();
  assert.equal((await switchBranch(dir, { branch: "feat/x", create: true }, run)).success, true);
  assert.equal(current(dir), "feat/x");
  assert.equal((await switchBranch(dir, { branch: "bad name~", create: true }, run)).code, "invalidName");
  assert.equal((await switchBranch(dir, { branch: "other", create: true }, run)).code, "exists");
});

await test("an unknown branch is notFound", async () => {
  const dir = makeRepo();
  assert.equal((await switchBranch(dir, { branch: "nope" }, run)).code, "notFound");
});

await test("a name that looks like an option never reaches git", async () => {
  const dir = makeRepo();
  assert.equal((await switchBranch(dir, { branch: "--detach" }, run)).code, "invalidName");
  assert.equal((await switchBranch(dir, { branch: "" }, run)).code, "invalidName");
});

await test("a held index.lock is reported as locked", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, ".git", "index.lock"), "");
  const r = await switchBranch(dir, { branch: "other" }, run);
  assert.equal(r.code, "locked");
});

await test("unrecognised git output keeps its text for the user", () => {
  const r = classifySwitchError("fatal: something new");
  assert.equal(r.code, "unknown");
  assert.equal(r.error, "fatal: something new");
});

for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
