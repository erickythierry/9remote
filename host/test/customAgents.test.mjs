// Custom agent launchers: a user-defined command that borrows a catalog agent's behaviour.
//
// Run: node --test host/test/customAgents.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const home = mkdtempSync(path.join(tmpdir(), "custom-agents-"));
process.env.NREMOTE_HOME = home;

const custom = await import("../features/terminal/customAgents.js");
const catalog = await import("../features/terminal/agentCatalog.js");
const modes = await import("../features/terminal/conversationModes.js");

test("add stores a launcher with an id that carries its base", () => {
  const { agent, error } = custom.addCustomAgent({ label: "9R", base: "claude", cmd: "9r" });
  assert.equal(error, undefined);
  assert.equal(agent.id, "claude+9r");
  assert.equal(custom.baseOfAgentId("claude+9r-ui"), "claude");
  assert.equal(modes.engineFromAgent("claude+9r-ui"), "claude");
});

test("a repeated name gets a distinct id", () => {
  const { agent } = custom.addCustomAgent({ label: "9R", base: "claude", cmd: "9r --x" });
  assert.equal(agent.id, "claude+9r-2");
});

test("a command with a line break is refused", () => {
  assert.ok(custom.addCustomAgent({ label: "Bad", base: "claude", cmd: "9r\nrm -rf ~" }).error);
  assert.ok(custom.addCustomAgent({ label: "", base: "claude", cmd: "9r" }).error);
});

test("the typed launch line resolves to the launcher, built-ins stay built-in", () => {
  assert.equal(catalog.agentIdFromLaunchLine("9r --foo"), "claude+9r");
  assert.equal(catalog.agentIdFromLaunchLine("claude"), "claude");
});

test("resume swaps the base binary for the launcher command", () => {
  assert.equal(catalog.agentById("claude+9r").resume("abc"), "9r --resume abc");
  assert.equal(catalog.agentById("claude+9r-ui").label, "9R");
});

test("a custom launcher wins over the base CLI the hook or process reports", () => {
  assert.equal(custom.agentOverridesDetected("claude+9r", "claude"), true);
  assert.equal(custom.agentOverridesDetected("claude+9r", "codex"), false);
  assert.equal(custom.agentOverridesDetected("claude", "claude"), false);
});

test("the list carries the launcher with the base's skip-permissions flag", () => {
  const entry = catalog.listAgentClis().find((a) => a.id === "claude+9r");
  assert.equal(entry.cmd, "9r");
  assert.equal(entry.yolo, "--dangerously-skip-permissions");
});

test("remove drops it", () => {
  assert.equal(custom.removeCustomAgent("claude+9r"), true);
  assert.equal(catalog.agentById("claude+9r"), null);
  rmSync(home, { recursive: true, force: true });
});
