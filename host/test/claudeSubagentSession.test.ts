// A background sub-agent is its own headless session ("sdk-cli") whose hooks reach the notify
// endpoint with the terminal's NINE_REMOTE_SESSION_ID; the chat must not follow its id.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9r-subagent-"));
process.env.NREMOTE_CLAUDE_PROJECTS_DIR = tmpRoot;

const { isFollowableConversation } = await import("../features/ai/claudeRewind.js");

let pass = 0, fail = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`); }
};

const MAIN = "aaaaaaaa-0000-0000-0000-000000000001";
const SUB = "bbbbbbbb-0000-0000-0000-000000000002";
const write = (id: string, entrypoint: string | null) => {
  const dir = path.join(tmpRoot, "-tmp-proj");
  fs.mkdirSync(dir, { recursive: true });
  const head = { type: "queue-operation", sessionId: id };
  const user = { type: "user", sessionId: id, ...(entrypoint ? { entrypoint } : {}), message: { role: "user", content: "hi" } };
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [head, user].map((r) => JSON.stringify(r)).join("\n") + "\n");
};

write(MAIN, "cli");
write(SUB, "sdk-cli");

await test("an interactive (cli) session is followed", () => assert.equal(isFollowableConversation(MAIN), true));
await test("a sub-agent (sdk-cli) session is not followed", () => assert.equal(isFollowableConversation(SUB), false));
await test("an id with no transcript yet is not followed", () => assert.equal(isFollowableConversation("cccccccc-0000-0000-0000-000000000003"), false));
await test("a transcript without an entrypoint is followed", () => {
  const id = "dddddddd-0000-0000-0000-000000000004";
  write(id, null);
  assert.equal(isFollowableConversation(id), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
