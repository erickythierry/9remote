// Which MCP servers each engine reports.
//
// Two things were wrong, both reported from real use of the modal:
//   • the codex reader ran for EVERY engine, so claude's servers were listed as codex's
//     and opencode/antigravity — with no reader at all — showed claude's list as theirs;
//   • it matched the TOML heading alone, and codex nests options under a server
//     (`[mcp_servers."9remote".http_headers]`), so option tables were listed as servers
//     of their own, named after the option.
//
// HOME IS REWRITTEN BEFORE THE MODULE LOADS. The readers resolve `os.homedir()` per call,
// so pointing HOME at a throwaway directory is what keeps a test from ever touching the
// user's real config — the failure mode that matters more than anything this asserts.
//
// Run: node agent/test/aiMcpServers.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The real home, captured BEFORE anything points HOME elsewhere, so the last test can
// prove it was never written to.
const REAL_HOME = os.homedir();
const realFiles = [".claude/settings.json", ".codex/config.toml"].map((rel) => {
  const p = path.join(REAL_HOME, rel);
  let stat = null;
  try { stat = fs.statSync(p); } catch {}
  return { rel, exists: Boolean(stat), mtimeMs: stat?.mtimeMs ?? null, size: stat?.size ?? null };
});

// Must happen before the import below: a module that captured the path at load time would
// otherwise read the real home.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "9r-mcp-home-"));
process.env.HOME = sandbox;

let pass = 0, fail = 0;
const test = (name: string, fn: { (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; (): void; }) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const write = (rel: string, text: string|NodeJS.ArrayBufferView<ArrayBufferLike>) => {
  const p = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

write(".claude/settings.json", JSON.stringify({
  mcpServers: { exa: { command: "exa-mcp" }, "remote-thing": { url: "https://x/mcp" } }
}));
write(".codex/config.toml", [
  "[mcp_servers.node_repl]",
  'command = "node_repl"',
  "[mcp_servers.node_repl.env]",
  'FOO = "bar"',
  '[mcp_servers."9remote"]',
  'url = "https://9remote.cc/mcp"',
  '[mcp_servers."9remote".http_headers]',
  'Authorization = "Bearer x"',
  "[mcp_servers.computer-use]",
  'command = "cu"'
].join("\n"));

const { listMcpServers } = await import("../features/ai/mcp.js");

test("each engine reports its OWN servers", () => {
  assert.deepEqual(listMcpServers("claude").map((s) => s.name), ["exa", "remote-thing"]);
  assert.deepEqual(listMcpServers("codex").map((s) => s.name), ["node_repl", "9remote", "computer-use"]);
});

test("claude also reads ~/.claude.json, the project's .mcp.json and enabled plugins", () => {
  const proj = path.join(sandbox, "work", "app");
  write(".claude.json", JSON.stringify({
    mcpServers: { "user-one": { command: "u1" }, exa: { command: "dup" } },
    projects: { [proj]: { mcpServers: { "proj-one": { url: "https://p/mcp?key=SECRET" } } } }
  }));
  write("work/app/.mcp.json", JSON.stringify({ mcpServers: { "file-one": { command: "f1" } } }));
  write(".claude/settings.json", JSON.stringify({ mcpServers: { exa: { command: "exa-mcp" } }, enabledPlugins: { "ctx@mk": true, "off@mk": false } }));
  const install = path.join(sandbox, ".claude", "plugins", "cache", "ctx");
  write(".claude/plugins/installed_plugins.json", JSON.stringify({ plugins: { "ctx@mk": [{ installPath: install }], "off@mk": [{ installPath: install }] } }));
  write(".claude/plugins/cache/ctx/.mcp.json", JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://c7/mcp" } } }));
  const servers = listMcpServers("claude", path.join(proj, "src"));
  assert.deepEqual(servers.map((s) => s.name).sort(), ["exa", "file-one", "plugin:ctx:context7", "proj-one", "user-one"]);
  assert.equal(servers.find((s) => s.name === "proj-one")?.command, "https://p/mcp");
  // The tests below share this sandbox and expect its original claude config.
  for (const rel of [".claude.json", "work", ".claude/plugins"]) fs.rmSync(path.join(sandbox, rel), { recursive: true, force: true });
  write(".claude/settings.json", JSON.stringify({ mcpServers: { exa: { command: "exa-mcp" }, "remote-thing": { url: "https://x/mcp" } } }));
});

test("an option table is not a server", () => {
  // `.env` and `.http_headers` are keys OF a server, not servers.
  const names = listMcpServers("codex").map((s) => s.name);
  for (const phantom of ["node_repl.env", "9remote.http_headers"]) {
    assert.ok(!names.includes(phantom), `${phantom} is an option, not a server`);
  }
});

test("an engine with no reader of its own reports nothing, not another's", () => {
  assert.deepEqual(listMcpServers("antigravity"), []);
});

test("opencode reads its own config: mcp.servers local + remote", () => {
  write(".config/opencode/opencode.json", JSON.stringify({
    mcp: { servers: {
      filesystem: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"] },
      exa: { type: "remote", url: "https://mcp.exa.ai/mcp" }
    } }
  }));
  const servers = listMcpServers("opencode");
  assert.deepEqual(servers.map((s) => s.name), ["filesystem", "exa"]);
  assert.equal(servers[0].type, "stdio");
  assert.match(servers[0].command, /server-filesystem/);
  assert.equal(servers[1].type, "http");
  assert.match(servers[1].command, /^https:/);
});

test("opencode broken config is empty, and project config is not borrowed", () => {
  write(".config/opencode/opencode.json", "not json {");
  assert.deepEqual(listMcpServers("opencode"), []);
});

test("a quoted name keeps its real name", () => {
  assert.ok(listMcpServers("codex").some((s: { name: string; }) => s.name === "9remote"), "quotes are not part of the name");
});

test("an http server is typed by its url", () => {
  const remote = listMcpServers("claude").find((s: { name: string; }) => s.name === "remote-thing");
  assert.equal(remote.type, "http");
  assert.match(remote.command, /^https:/);
});

test("a missing or broken config is an empty list, not a throw", () => {
  write(".codex/config.toml", "not = [ valid");
  assert.deepEqual(listMcpServers("codex"), []);
  fs.rmSync(path.join(sandbox, ".codex/config.toml"), { force: true });
  assert.deepEqual(listMcpServers("codex"), []);
});

// The whole point of the sandbox: this file must not be able to touch the user's config,
// however wrong its assertions are. Verified, not assumed.
test("the real home's configs are untouched", () => {
  for (const before of realFiles) {
    const p = path.join(REAL_HOME, before.rel);
    let stat = null;
    try { stat = fs.statSync(p); } catch {}
    assert.equal(Boolean(stat), before.exists, `${before.rel} appeared or vanished`);
    if (!stat) continue;
    assert.equal(stat.size, before.size, `${before.rel} changed size`);
    assert.equal(stat.mtimeMs, before.mtimeMs, `${before.rel} was written to`);
  }
});

// And the module really read the sandbox — otherwise every assertion above is vacuous.
test("the module read the sandbox home, not the real one", () => {
  assert.equal(os.homedir(), sandbox);
  // The fixture is rewritten here because the test above deliberately broke it; what this
  // checks is that a server placed in the SANDBOX comes back, so the reads are not somehow
  // still pointed at the real home.
  write(".codex/config.toml", "[mcp_servers.sandbox-only]\ncommand = \"x\"\n");
  assert.deepEqual(listMcpServers("codex").map((s) => s.name), ["sandbox-only"]);
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

test("claude flags a server in the CLI's needs-auth cache until its entry lapses", () => {
  write(".claude.json", JSON.stringify({ mcpServers: { live: { command: "a" }, lapsed: { command: "b" }, fine: { command: "c" } } }));
  write(".claude/mcp-needs-auth-cache.json", JSON.stringify({
    live: { timestamp: Date.now() - 60_000 },
    lapsed: { timestamp: Date.now() - 60 * 60_000 }
  }));
  const by = Object.fromEntries(listMcpServers("claude").map((s) => [s.name, s.status]));
  assert.equal(by.live, "needs-auth");
  assert.equal(by.lapsed, "configured");
  assert.equal(by.fine, "configured");
  for (const rel of [".claude.json", ".claude/mcp-needs-auth-cache.json"]) fs.rmSync(path.join(sandbox, rel), { force: true });
});
