import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { isAuthFailure, toSshUrl, toHttpsUrl, tryRemoteFallback } from "../features/fileExplorer/handlers/GitHandler.js";

test("isAuthFailure detects HTTPS credential errors", () => {
  assert.equal(isAuthFailure("fatal: could not read Username for 'https://github.com': Endereço ou dispositivo inexistente"), true);
  assert.equal(isAuthFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), true);
  assert.equal(isAuthFailure("fatal: could not read Password for 'https://user@github.com': No such device or address"), true);
  assert.equal(isAuthFailure("fatal: Authentication failed for 'https://github.com/org/repo.git/'"), true);
  assert.equal(isAuthFailure("remote: Invalid username or password."), true);
  assert.equal(isAuthFailure("fatal: unable to access 'https://github.com/...': The requested URL returned error: 403"), true);
});

test("isAuthFailure detects SSH credential errors", () => {
  assert.equal(isAuthFailure("git@github.com: Permission denied (publickey)."), true);
  assert.equal(isAuthFailure("fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights"), false);
  assert.equal(isAuthFailure("Permission denied (publickey)"), true);
});

test("isAuthFailure ignores regular non-auth errors", () => {
  assert.equal(isAuthFailure("error: failed to push some refs to 'origin'"), false);
  assert.equal(isAuthFailure("fatal: remote origin already exists"), false);
  assert.equal(isAuthFailure(""), false);
  assert.equal(isAuthFailure(null), false);
});

test("toSshUrl converts HTTPS URLs to SSH format", () => {
  assert.equal(
    toSshUrl("https://github.com/erickythierry/media-download-api.git"),
    "git@github.com:erickythierry/media-download-api.git"
  );
  assert.equal(
    toSshUrl("http://gitlab.com/group/subgroup/project.git"),
    "git@gitlab.com:group/subgroup/project.git"
  );
  assert.equal(
    toSshUrl("https://user:token@github.com/owner/repo.git"),
    "git@github.com:owner/repo.git"
  );
  assert.equal(toSshUrl("git@github.com:owner/repo.git"), null);
});

test("toHttpsUrl converts SSH URLs to HTTPS format", () => {
  assert.equal(
    toHttpsUrl("git@github.com:erickythierry/media-download-api.git"),
    "https://github.com/erickythierry/media-download-api.git"
  );
  assert.equal(
    toHttpsUrl("ssh://git@github.com/erickythierry/media-download-api.git"),
    "https://github.com/erickythierry/media-download-api.git"
  );
  assert.equal(
    toHttpsUrl("ssh://git@gitlab.com:22/group/subgroup/project.git"),
    "https://gitlab.com/group/subgroup/project.git"
  );
  assert.equal(toHttpsUrl("https://github.com/owner/repo.git"), null);
});

test("tryRemoteFallback restores remote URL when retry fails", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-fallback-test-"));
  try {
    execSync("git init -b main", { cwd: tmpDir });
    execSync("git remote add origin https://invalid.example.com/owner/repo.git", { cwd: tmpDir });

    const fallback = await tryRemoteFallback(tmpDir, ["push", "--dry-run"]);
    assert.equal(fallback.attempted, false);

    // URL should have been restored back to original
    const restoredUrl = execSync("git remote get-url origin", { cwd: tmpDir, encoding: "utf-8" }).trim();
    assert.equal(restoredUrl, "https://invalid.example.com/owner/repo.git");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
