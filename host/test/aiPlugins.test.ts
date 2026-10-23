// The plugins the CLI has installed, and which of them are on.
// HOME is rewritten before the module loads, so a test never reads the user's real plugins.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-plugins-home-"));
process.env.HOME = sandbox;

const write = (rel: string, text: string) => {
  const p = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

const dir = path.join(sandbox, ".claude/plugins/cache/mk/p/1.0.0");
write(".claude/plugins/cache/mk/p/1.0.0/skills/one/SKILL.md", "---\nname: one\n---\n");
write(".claude/plugins/cache/mk/p/1.0.0/skills/two/SKILL.md", "---\nname: two\n---\n");
write(".claude/plugins/cache/mk/p/1.0.0/skills/registry.json", "{}");
write(".claude/plugins/cache/mk/p/1.0.0/agents/a.md", "x");
write(".claude/plugins/cache/mk/p/1.0.0/commands/c.toml", "x");
write(".claude/plugins/installed_plugins.json", JSON.stringify({
  plugins: {
    "p@mk": [{ scope: "user", installPath: dir, version: "1.0.0" }],
    "q@mk": [{ scope: "user", installPath: path.join(sandbox, "gone"), version: "2" }]
  }
}));
write(".claude/settings.json", JSON.stringify({ enabledPlugins: { "p@mk": true } }));

const { listPlugins } = await import("../features/ai/plugins.js");

test("a plugin reports its state and what it ships", () => {
  const [p, q] = listPlugins("claude");
  assert.equal(p.name, "p");
  assert.equal(p.marketplace, "mk");
  assert.equal(p.enabled, true);
  assert.deepEqual([p.skills, p.agents, p.commands], [2, 1, 0]);
  assert.equal(q.enabled, false);
});

test("the install path stays on the host", () => {
  assert.ok(!("installPath" in listPlugins("claude")[0]));
});

test("an engine other than claude has no plugins", () => {
  assert.deepEqual(listPlugins("codex"), []);
});

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
