// Claude Code profiles: every reader and writer must find the config dir a launcher points at,
// not just ~/.claude. HOME moves to a sandbox BEFORE the modules load, so no fixture touches the real home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-profile-home-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
delete process.env.CLAUDE_CONFIG_DIR;

let pass = 0, fail = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`); }
};

const write = (rel: string, body: string) => {
  const file = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const profile = path.join(sandbox, ".claude-work");
write(".claude/settings.json", "{}");
write(".claude-work/settings.json", JSON.stringify({ enabledPlugins: { "tool@mk": true } }));
write(`.claude-work/projects/-tmp-proj/${SID}.jsonl`, `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } })}\n`);
// A bare folder with a `.claude-` prefix and none of the CLI's files is not a profile.
fs.mkdirSync(path.join(sandbox, ".claude-notes"), { recursive: true });

const prof = await import("../features/ai/claudeProfile.js");
const tr = await import("../features/ai/claudeTranscript.js");

await test("detects ~/.claude and ~/.claude-* profiles, skips a bare folder", () => {
  const dirs = prof.claudeProfileDirs();
  assert.deepEqual(dirs, [path.join(sandbox, ".claude"), profile]);
});

await test("findTranscript finds a session recorded in another profile", () => {
  const found = tr.findTranscript("/tmp/proj", SID);
  assert.equal(found, path.join(profile, "projects", "-tmp-proj", `${SID}.jsonl`));
});

await test("profileOfTranscript names the owning profile", () => {
  assert.equal(prof.profileOfTranscript(tr.findTranscript("/tmp/proj", SID)!), profile);
});

await test("resume line carries CLAUDE_CONFIG_DIR when no launcher owns the profile", () => {
  const line = prof.resumeLineForProfile(`claude --resume ${SID}`, profile);
  assert.equal(line, `CLAUDE_CONFIG_DIR='${profile}' claude --resume ${SID}`);
});

await test("resume line stays plain for the default profile", () => {
  const line = `claude --resume ${SID}`;
  assert.equal(prof.resumeLineForProfile(line, path.join(sandbox, ".claude")), line);
});

await test("a profile marker is required: settings.json alone makes a profile", () => {
  write(".claude-late/settings.json", "{}");
  // The scan is cached briefly; a fresh module state is not needed, only a later window.
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try { assert.ok(prof.claudeProfileDirs().includes(path.join(sandbox, ".claude-late"))); }
  finally { Date.now = realNow; }
});

await test("state file sits beside HOME for the default profile, inside for the others", () => {
  assert.equal(prof.claudeStateFile(path.join(sandbox, ".claude")), path.join(sandbox, ".claude.json"));
  assert.equal(prof.claudeStateFile(profile), path.join(profile, ".claude.json"));
});

await test("plugins and skills read the profile they are given", async () => {
  const plugins = await import("../features/ai/plugins.js");
  write(".claude-work/plugins/installed_plugins.json", JSON.stringify({
    plugins: { "tool@mk": [{ installPath: path.join(profile, "plugins", "tool"), version: "1.0.0" }] }
  }));
  write(".claude-work/plugins/tool/skills/s1/SKILL.md", "---\nname: s1\ndescription: d\n---\n");
  const [p] = plugins.installedPlugins(profile);
  assert.equal(p.id, "tool@mk");
  assert.equal(p.enabled, true);
  assert.equal(p.skills, 1);
  assert.deepEqual(plugins.installedPlugins(path.join(sandbox, ".claude")), []);
});

await test("hooks are written to every profile and removed from every profile", async () => {
  const hooks = await import("../features/terminal/hookManager.js");
  assert.equal(hooks.enableToolHook("claude").success, true);
  for (const dir of [".claude", ".claude-work"]) {
    const s = JSON.parse(fs.readFileSync(path.join(sandbox, dir, "settings.json"), "utf8"));
    assert.ok(s.hooks?.Stop, `${dir} has the Stop hook`);
  }
  assert.equal(hooks.disableToolHook("claude").success, true);
  const after = JSON.parse(fs.readFileSync(path.join(profile, "settings.json"), "utf8"));
  assert.equal(after.hooks, undefined);
  assert.deepEqual(after.enabledPlugins, { "tool@mk": true }, "user settings survive");
});

await test("session history lists a session from another profile with a profile-aware resume", async () => {
  const history = await import("../features/terminal/agentHistory.js");
  const rows = await history.listAgentSessions({ cwd: "/tmp/proj", limit: 10 });
  const row = rows.find((r: { sessionId: string }) => r.sessionId === SID);
  assert.ok(row, "session found");
  assert.ok(row.resume.includes(`CLAUDE_CONFIG_DIR='${profile}'`), row.resume);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
