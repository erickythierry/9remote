// Which skill directories each engine reads.
//
// Found on disk, not inferred: claude reads ~/.claude/skills, codex ~/.codex/skills,
// opencode ~/.config/opencode/skills, antigravity ~/.gemini/skills (plus the CLI's builtin
// set). The old reader was `codex ? codex-dir : claude-dir`, so opencode and antigravity
// were shown ANOTHER CLI's library — every row offered as something that engine can run.
//
// HOME IS REWRITTEN BEFORE THE MODULE LOADS, and the sandbox is where every fixture goes.
// The first version of this file wrote its fixtures into the real home and then cleaned up
// with rmSync — which is how it deleted real skills' `references/` and `scripts/`. A test
// of a *reader* must never be able to write where the reader looks.
//
// Run: node agent/test/aiSkills.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Captured before HOME moves, so the last test can prove the real libraries were untouched.
const REAL_HOME = os.homedir();
const realDirs = [".claude/skills", ".codex/skills", ".config/opencode/skills", ".gemini/skills"]
  .map((rel) => {
    const p = path.join(REAL_HOME, rel);
    let stat = null;
    try { stat = fs.statSync(p); } catch {}
    return { rel, exists: Boolean(stat), mtimeMs: stat?.mtimeMs ?? null };
  });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-skills-home-"));
process.env.HOME = sandbox;

let pass = 0, fail = 0;
const test = (name: string, fn: { (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; }) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const skill = (rel: string, dir: string, name: string, description: string) => {
  const p = path.join(sandbox, rel, dir);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`);
};

skill(".claude/skills", "claude-only", "claude-skill", "from claude");
skill(".codex/skills", "codex-only", "codex-skill", "from codex");
skill(".config/opencode/skills", "opencode-only", "opencode-skill", "from opencode");
skill(".gemini/skills", "agy-user", "agy-skill", "from antigravity");
skill(".gemini/antigravity-cli/builtin/skills", "agy-builtin", "agy-builtin-skill", "shipped by the CLI");
// A skill directory with no SKILL.md yet: the reader tolerates it, so the test must too.
fs.mkdirSync(path.join(sandbox, ".codex/skills/bare"), { recursive: true });

const { listSkills } = await import("../features/ai/skills.js");
const names = (engine: string|undefined) => listSkills(engine, null).map((s) => s.name).sort();

test("each engine reports its OWN skills", () => {
  assert.deepEqual(names("claude"), ["claude-skill"]);
  assert.deepEqual(names("opencode"), ["opencode-skill"]);
  assert.deepEqual(names("codex"), ["bare", "codex-skill"]);
});

test("antigravity reads both its library and the CLI's builtin set", () => {
  assert.deepEqual(names("antigravity"), ["agy-builtin-skill", "agy-skill"]);
});

test("no engine shows another engine's library", () => {
  // The bug as a property: a skill that exists in exactly one place appears for exactly
  // one engine.
  for (const [engine, foreign] of [
    ["codex", "claude-skill"], ["opencode", "claude-skill"], ["antigravity", "claude-skill"],
    ["claude", "codex-skill"], ["opencode", "codex-skill"], ["antigravity", "codex-skill"],
    ["claude", "opencode-skill"], ["codex", "opencode-skill"]
  ]) {
    assert.ok(!names(engine).includes(foreign), `${engine} must not list ${foreign}`);
  }
});

test("the frontmatter is where a name and description come from", () => {
  const s = listSkills("codex", null).find((x: { id: string; }) => x.id === "codex-only");
  assert.equal(s.name, "codex-skill");
  assert.equal(s.description, "from codex");
  assert.ok(s.path.endsWith("codex-only"), "and the path is the directory it was found in");
});

test("a skill with no SKILL.md lists under its directory name", () => {
  const bare = listSkills("codex", null).find((s: { id: string; }) => s.id === "bare");
  assert.ok(bare, "a directory is a skill even before it is documented");
  assert.equal(bare.name, "bare");
});

test("an engine nobody has taught gets no library, not another's", () => {
  assert.deepEqual(listSkills("not-an-engine", null), []);
});

// listSkills caches per engine for 10s; a test that changes the disk jumps the clock past it.
const realNow = Date.now;
let skew = 0;
const pastCache = () => { skew += 60_000; Date.now = () => realNow() + skew; };

test("an enabled plugin's skills list as <plugin>:<name>, a disabled one's do not", () => {
  const on = path.join(sandbox, ".claude/plugins/cache/mk/on");
  const off = path.join(sandbox, ".claude/plugins/cache/mk/off");
  for (const [dir, name] of [[on, "alpha"], [off, "beta"]]) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: >\n  folded\n  text\ndisable-model-invocation: true\n---\n`);
    // Build files beside the skills are not skills.
    fs.mkdirSync(path.join(dir, "skills", "generated"), { recursive: true });
  }
  fs.writeFileSync(path.join(sandbox, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "on@mk": true, "off@mk": false } }));
  fs.writeFileSync(path.join(sandbox, ".claude/plugins/installed_plugins.json"), JSON.stringify({
    plugins: { "on@mk": [{ installPath: on }], "off@mk": [{ installPath: off }] }
  }));
  fs.rmSync(path.join(sandbox, ".claude/skills copy"), { recursive: true, force: true });
  pastCache();
  const found = listSkills("claude", null).filter((x: { source: string; }) => x.source === "plugin");
  assert.deepEqual(found.map((x: { name: string; }) => x.name), ["on:alpha"]);
  assert.equal(found[0].plugin, "on");
  assert.equal(found[0].userOnly, true);
  assert.equal(found[0].description, "folded text");
  // Another engine never gets claude's plugins.
  assert.ok(!listSkills("codex", null).some((x: { source: string; }) => x.source === "plugin"));
});

test("a symlinked skill directory is a skill", () => {
  const target = path.join(sandbox, "elsewhere", "linked");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), "---\nname: linked\ndescription: via symlink\n---\n");
  fs.symlinkSync(target, path.join(sandbox, ".claude/skills", "linked"));
  pastCache();
  assert.ok(listSkills("claude", null).some((x: { name: string; }) => x.name === "linked"));
});

// The reason this file is written the way it is, asserted rather than trusted.
test("the real skill libraries were never written to", () => {
  for (const before of realDirs) {
    const p = path.join(REAL_HOME, before.rel);
    let stat = null;
    try { stat = fs.statSync(p); } catch {}
    assert.equal(Boolean(stat), before.exists, `${before.rel} appeared or vanished`);
    if (stat) assert.equal(stat.mtimeMs, before.mtimeMs, `${before.rel} was written to`);
  }
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
