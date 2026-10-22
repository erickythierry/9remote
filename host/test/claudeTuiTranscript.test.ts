// The TUI transcript differs from stream-json: rewritten prompts, no task_started, hook commands in stop_hook_summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeRecordParser } from "../features/ai/claudeTranscript.js";
import { echoKey } from "../features/ai/claudeTerminal.js";
import { UPLOAD_DIR } from "../features/terminal/constants.js";

const collect = (records: any[]) => {
  const out: any[] = [];
  const parse = claudeRecordParser((ev) => out.push(ev));
  for (const r of records) parse(r, false);
  return out;
};

test("a prompt the TUI rewrote still matches the text the chat typed", () => {
  const typed = `${UPLOAD_DIR}/1_a.png ${UPLOAD_DIR}/2_b.png fix this`;
  const echoed = `[Image #1] [Image #2]\n\n<pasted_content id="c1">\n${UPLOAD_DIR}/1_a.png ${UPLOAD_DIR}/2_b.png fix this\n</pasted_content>`;
  assert.equal(echoKey(echoed), echoKey(typed));
  assert.notEqual(echoKey("another prompt"), echoKey(typed));
});

test("an async Agent ack yields a task_started carrying the tool_use_id and label", () => {
  const evs = collect([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Agent", input: { description: "Sleep test", subagent_type: "general-purpose" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "Async agent launched successfully.\nagentId: a1b2c3 (internal)" }] }] } }
  ]);
  const started = evs.find((e) => e.data?.subtype === "task_started");
  assert.equal(started.data.record.task_id, "a1b2c3");
  assert.equal(started.data.record.tool_use_id, "tu1");
  assert.equal(started.data.record.description, "Sleep test");
  assert.equal(started.data.record.async_launch, true);
});

test("a stop_hook_summary reaches the pane without the hook command lines", () => {
  const [ev] = collect([{
    type: "system", subtype: "stop_hook_summary", hookCount: 2,
    hookInfos: [{ command: "tool --auth-token SECRET", durationMs: 18 }, { command: "sync", durationMs: 9000 }], hookErrors: []
  }]);
  assert.equal(ev.data.record.hookCount, 2);
  assert.deepEqual(ev.data.record.hookDurationsMs, [18, 9000]);
  assert.ok(!JSON.stringify(ev).includes("SECRET"));
});
