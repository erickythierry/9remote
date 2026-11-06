import assert from "node:assert/strict";
import { test } from "node:test";
import { AiSession } from "../features/ai/aiSession.js";
import { ClaudeTerminal } from "../features/ai/claudeTerminal.js";
import { getConversation } from "../features/terminal/statusManager.js";

const OLD_ID = "11111111-1111-4111-8111-111111111111";
const RESUME_ID = "22222222-2222-4222-8222-222222222222";

function sessionFixture() {
  const calls: any[] = [];
  const session = Object.create(AiSession.prototype);
  Object.assign(session, {
    id: "resume-test", engine: "claude", cliSessionId: OLD_ID,
    options: {}, history: [], isTurnRunning: false, model: "", effort: "",
    terminal: {
      needsRelaunch: () => false,
      applyOptions: async (opts: any) => { calls.push(opts); }
    },
    _rebuildFromStore: (id: string) => { calls.push(id); return { events: [] }; },
    _adoptLog: () => {}, emitNormalized: () => {},
    _saveKvState: () => {}, flushSaveSnapshot: () => {}
  });
  return { session, calls };
}

test("a history selection sends the resume id to the terminal", () => {
  const { session, calls } = sessionFixture();
  session.setOptions({ resume: RESUME_ID });
  assert.equal(session.cliSessionId, RESUME_ID);
  assert.equal(session.pendingResume, null);
  assert.equal(calls[0], RESUME_ID);
  assert.equal(calls[1].resume, RESUME_ID);
});

test("a history selection waits until the current turn ends", () => {
  const { session, calls } = sessionFixture();
  session.isTurnRunning = true;
  session.setOptions({ resume: RESUME_ID });
  assert.equal(session.cliSessionId, OLD_ID);
  assert.equal(session.pendingResume, RESUME_ID);
  assert.equal(calls.length, 0);
  session.isTurnRunning = false;
  session.applyPendingOptions();
  assert.equal(session.cliSessionId, RESUME_ID);
  assert.equal(session.pendingResume, null);
  assert.equal(calls[0], RESUME_ID);
  assert.equal(calls[1].resume, RESUME_ID);
});

test("an invalid resume id does not switch the terminal conversation", () => {
  const { session, calls } = sessionFixture();
  session.setOptions({ resume: "--invalid" });
  assert.equal(session.cliSessionId, OLD_ID);
  assert.equal(calls[0].resume, undefined);
});

test("resume waits for a TUI launch already in progress", async () => {
  const terminal = new ClaudeTerminal({ id: "resume-booting", cliSessionId: OLD_ID } as AiSession);
  let finish!: () => void;
  terminal.booting = new Promise<void>((resolve) => { finish = resolve; });
  terminal.tuiRunning = async () => true;
  let relaunched = false;
  terminal.relaunch = async () => { relaunched = true; };
  const applying = terminal.applyOptions({ resume: RESUME_ID });
  assert.equal(terminal.session.cliSessionId, OLD_ID);
  assert.equal(relaunched, false);
  finish();
  await applying;
  assert.equal(terminal.session.cliSessionId, RESUME_ID);
  assert.equal(relaunched, true);
});

test("transcript polling waits while the TUI restarts", () => {
  const terminal = new ClaudeTerminal({ id: "resume-polling" } as AiSession);
  terminal.booting = Promise.resolve();
  terminal.hookConversation = () => { assert.fail("polling must wait for the restart"); };
  terminal.tick();
});

for (const running of [true, false]) {
  test(`resume ${running ? "restarts" : "starts"} the TUI and resets its transcript`, async () => {
    const terminal = new ClaudeTerminal({ id: `resume-terminal-${running}`, cliSessionId: RESUME_ID } as AiSession);
    terminal.file = "/old/transcript.jsonl";
    terminal.followed = OLD_ID;
    terminal.tuiRunning = async () => running;
    const calls: string[] = [];
    terminal.relaunch = async () => { calls.push("relaunch"); };
    terminal.ensureTui = async () => { calls.push("boot"); };
    await terminal.applyOptions({ resume: RESUME_ID });
    assert.deepEqual(calls, [running ? "relaunch" : "boot"]);
    assert.equal(terminal.file, null);
    assert.equal(terminal.followed, RESUME_ID);
    assert.equal(getConversation(terminal.session.id)?.id, RESUME_ID);
  });
}
