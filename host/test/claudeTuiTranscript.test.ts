// The TUI transcript differs from stream-json: rewritten prompts, no task_started, hook commands in stop_hook_summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeRecordParser } from "../features/ai/claudeTranscript.js";
import { echoKey, ClaudeTerminal } from "../features/ai/claudeTerminal.js";
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

test("a prompt absorbed mid-turn draws its bubble from the queue removal", () => {
  const evs = collect([
    { type: "queue-operation", operation: "enqueue", content: "do the build" },
    { type: "queue-operation", operation: "remove", content: "do the build", reason: "absorbed_mid_turn" },
    { type: "queue-operation", operation: "remove", content: "<task-notification>\n<task-id>x</task-id>\n</task-notification>", reason: "absorbed_mid_turn" }
  ]);
  const bubbles = evs.filter((e) => e.event === "user_message");
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].data.text, "do the build");
});

test("the TUI's queue is mirrored: enqueue, dequeue, remove and popAll", () => {
  const term: any = new (ClaudeTerminal as any)({});
  const op = (operation: string, content = "", reason?: string) => term.queueRecord({ type: "queue-operation", operation, content, reason });
  op("enqueue", "one"); op("enqueue", "two"); op("enqueue", "<task-notification>x</task-notification>");
  assert.deepEqual(term.queued.filter((q: any) => !q.hidden).map((q: any) => q.text), ["one", "two"]);
  op("dequeue");
  assert.deepEqual(term.queued.map((q: any) => q.text.slice(0, 3)), ["two", "<ta"]);
  op("remove", "two", "absorbed_mid_turn");
  assert.equal(term.queued.length, 1);
  op("popAll");
  assert.equal(term.queued.length, 0);
});

test("a TaskStop result closes the background task and its launcher row", () => {
  const evs = collect([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 999" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "Command did not complete within its 120s timeout and was moved to the background (ID: b1x)." }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "TaskStop", input: { task_id: "b1x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "{\"message\":\"Successfully stopped task: b1x\"}" }] } }
  ]);
  const ended = evs.find((e) => e.data?.subtype === "task_notification");
  assert.equal(ended.data.record.task_id, "b1x");
  assert.equal(ended.data.record.status, "killed");
  assert.equal(ended.data.record.tool_use_id, "tu1");
  const settled = evs.filter((e) => e.event === "tool_result" && e.data.id === "tu1").pop();
  assert.equal(settled.data.status, "done");
});

test("a failed TaskStop leaves the task running", () => {
  const evs = collect([
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "TaskStop", input: { task_id: "b1x" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", is_error: true, content: "No such task" }] } }
  ]);
  assert.ok(!evs.some((e) => e.data?.subtype === "task_notification"));
});
