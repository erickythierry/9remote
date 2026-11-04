"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Bot, Terminal, Square, Loader2, ChevronDown, Check, CheckCircle2, AlertCircle, Ban } from "@/shared/components/ui/Icon";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { vibrate } from "@/shared/utils/vibration";
import { useAiStore } from "@/shared/stores/aiStore";
import { findTaskTool } from "../../lib/toolTree";
import { taskElapsedMs, type HarnessTaskRow } from "../../lib/harnessTasks";
import { clockText, taskStartTime } from "../../lib/taskClock";
import { MessageBubble } from "../MessageBubble";
import { AiTurn } from "../AiTurn";
import { renderToolCard } from "../cards/toolCards";
import { AiToolCard } from "../cards/AiToolCard";
import { ModalShell } from "./ModalShell";

// The modal's own beat, so the header's total keeps moving while it is open. One timer
// for the whole panel — every row reads the same `now`.
const TICK_MS = 1000;

function TaskIcon({ background = false, engine = "claude", size = 16, className = "" }) {
  if (background) {
    return <Terminal size={size} className={className || "text-text"} />;
  }
  const iconSrc = agentIconUrl(engine);
  if (iconSrc) {
    return (
      <img
        src={iconSrc}
        alt={engine}
        draggable={false}
        style={{ width: size, height: size }}
        className={`flex-shrink-0 object-contain ${AGENT_ICON_CLS} ${className}`}
      />
    );
  }
  return <Bot size={size} className={className || "text-text"} />;
}

function TaskStatusIcon({ status }: { status: string }) {
  if (status === "running") return <Loader2 size={12} className="animate-spin text-brand-500 shrink-0" />;
  if (status === "completed") return <CheckCircle2 size={12} className="text-success shrink-0" />;
  if (status === "failed") return <AlertCircle size={12} className="text-danger shrink-0" />;
  return <Ban size={12} className="text-text-subtle shrink-0" />;
}

function TaskPickerRow({ t, engine, now, on = false }: { t: HarnessTaskRow; engine: string; now: number; on?: boolean }) {
  const tStarted = taskStartTime(t);
  return (
    <>
      <TaskIcon background={t.background} engine={engine} size={14} className={on ? "" : "opacity-70"} />
      <span className="flex-1 min-w-0 truncate text-left">{t.description || t.subagentType || t.taskId}</span>
      <TaskStatusIcon status={t.status} />
      <span className="font-mono text-[10px] opacity-60 tabular-nums shrink-0">
        {tStarted ? `${tStarted} · ` : ""}{clockText(taskElapsedMs(t, now))}
      </span>
    </>
  );
}

// Collapsed: the current task plus a count. Open: every task as a full-width row, so long names stay readable on a phone.
function TaskPicker({ tasks, current, engine, now, onPick }: { tasks: HarnessTaskRow[]; current: HarnessTaskRow; engine: string; now: number; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const runningCount = tasks.filter((t) => t.status === "running").length;
  return (
    <div className="border-b border-border-subtle bg-bg shrink-0">
      <button
        type="button"
        onClick={() => { vibrate(); setOpen((o) => !o); }}
        aria-expanded={open}
        className="w-full px-4 py-2 flex items-center gap-2 text-xs text-text hover:bg-surface-2/40 transition-colors"
      >
        <span className="shrink-0 px-1.5 py-0.5 rounded bg-surface-2 text-[10px] font-medium tabular-nums text-text-muted">
          {runningCount ? `${runningCount}/${tasks.length} running` : `${tasks.length} tasks`}
        </span>
        <span className="flex-1 min-w-0 truncate text-left font-medium">
          {current.description || current.subagentType || current.taskId}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="max-h-[40vh] overflow-y-auto custom-scrollbar px-2 pb-2 flex flex-col gap-0.5">
          {tasks.map((t, i) => {
            const on = t.taskId === current.taskId;
            return (
              <button
                key={t.taskId || i}
                type="button"
                onClick={() => { vibrate(); onPick(t.taskId); setOpen(false); }}
                title={t.description || t.subagentType || t.taskId}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-brand text-xs transition-colors ${
                  on ? "bg-surface-2 text-text font-medium" : "text-text-muted hover:text-text hover:bg-surface-2/40"
                }`}
              >
                {on ? <Check size={12} className="shrink-0 text-brand-500" /> : <span className="w-3 shrink-0" />}
                <TaskPickerRow t={t} engine={engine} now={now} on={on} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Everything a pinned strip row could not say, drawn the way the agent itself is drawn.
 *
 * The strip names the work; this modal walks it: a chip per task when the tap
 * stood for several, then the task's own calls as the TIMELINE's tool cards — a
 * sub-agent's internals read here exactly as they do in the turn (its agent card even
 * draws its nested calls itself), and a background shell's card IS the command with its
 * output. Nothing else on the page: no stat tiles, no meta line — the cards are the
 * information, the modal is just the page they sit on.
 */
export interface AgentTaskModalProps {
  tasks?: any[];
  messages?: any[];
  engine?: string;
  sessionId?: string;
  onStopTask?: (taskId: string) => void;
  onClose?: () => void;
}

export const AgentTaskModal = memo(function AgentTaskModal({
  tasks = [],
  messages = [],
  engine = "claude",
  sessionId = "",
  onStopTask,
  onClose
}: AgentTaskModalProps) {
  const [now, setNow] = useState(() => Date.now());
  // Which task the panel is showing. `null` follows the group: until the reader picks one,
  // the panel shows the task it was opened for — or, that one gone, whatever is left.
  const [picked, setPicked] = useState<string | null>(null);
  const stored = useAiStore((s) => s.bySession[sessionId]?.harnessTasks);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // The store is the authority on status: a task that ended while this panel was open is
  // ended, and the copy handed in at the tap is stale the moment the CLI says so. A task
  // the store does not hold (a session it never loaded) keeps the copy it came with.
  const live = useMemo(
    () => tasks.map((t) => stored?.find((h) => h.taskId === t.taskId) || t),
    [tasks, stored]
  );
  const task = live.find((t) => t.taskId === picked) || live[0];
  if (!task) return null;
  const elapsed = taskElapsedMs(task, now);
  const running = !task.endedAt && (task.status === "running" || task.status === "paused");
  const started = taskStartTime(task);

  return (
    <ModalShell
      icon={<TaskIcon background={task.background} engine={engine} size={16} />}
      iconClass=""
      title={task.description || task.subagentType || "Task"}
      subtitle={
        started
          ? (running ? `Started ${started} · Running for ${clockText(elapsed)}` : `Started ${started} · Ended · ${clockText(elapsed)}`)
          : (running ? `Running for ${clockText(elapsed)}` : `Ended · ${clockText(elapsed)}`)
      }
      onClose={onClose}
      actions={running && task.taskId && onStopTask ? (
        <button
          type="button"
          onClick={() => { vibrate(); onStopTask(task.taskId); }}
          className="px-2.5 py-1 rounded-brand text-xs font-medium text-danger bg-danger/10 hover:bg-danger/20 transition-colors flex items-center gap-1.5"
          title="Stop this task"
        >
          <Square size={10} className="fill-current" />
          <span>Stop</span>
        </button>
      ) : null}
    >
      {live.length > 1 && (
        <TaskPicker tasks={live} current={task} engine={engine} now={now} onPick={setPicked} />
      )}

      {/* The task's card IS the interface — the very card the main timeline draws for
          it, bungled open: its header, its calls (a sub-agent's card draws those
          itself), its command and output (a background shell's card). */}
      <div className="p-3 flex-1 overflow-y-auto custom-scrollbar">
        <Calls task={task} messages={messages} engine={engine} running={running} />

        {task.summary && (
          <p className="mt-3 text-[11px] text-text-muted leading-relaxed">
            {task.summary}
          </p>
        )}

        {task.outputFile && (
          <p className="mt-3 font-mono text-[10px] text-text-subtle truncate" title={task.outputFile}>
            output · {task.outputFile}
          </p>
        )}
      </div>
    </ModalShell>
  );
});

/**
 * The task's work as the CLI itself prints it: prompt bubble, then its calls as flat
 * card rows — same cards the main timeline draws, but without the turn rail around
 * them, so the modal's narrow column keeps one level of indentation (a card's own
 * output border) instead of a staircase of nested rails.
 *
 * A background shell is a list of one: its card is the command with its output, and it
 * has no prompt bubble (nobody asked it anything).
 */
function Calls({ task, messages, engine, running }: { task: any; messages: any[]; engine: string; running: boolean }) {
  const row = findTaskTool(messages, task.toolUseId);
  if (!row) {
    return (
      <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-text-muted select-none">
        {running ? (
          <>
            <Loader2 size={24} className="animate-spin text-brand-500 opacity-80" />
            <div className="text-center">
              <div className="text-xs font-medium text-text">Task is running...</div>
              <div className="text-[11px] text-text-subtle mt-0.5">Waiting for task calls or tool events</div>
            </div>
          </>
        ) : (
          <>
            <TaskIcon background={task.background} engine={engine} size={28} className="opacity-40" />
            <div className="text-center">
              <div className="text-xs font-medium text-text">No calls recorded</div>
              <div className="text-[11px] text-text-subtle mt-0.5">This task ended without child tool calls</div>
            </div>
          </>
        )}
      </div>
    );
  }
  const calls = row.children?.length ? row.children : [row];
  const inputObj = (row.input && typeof row.input === "object" ? row.input : {}) as any;
  const prompt = inputObj.prompt || inputObj.description || "";
  const report = row.error || row.output || "";
  return (
    <div className="flex flex-col">
      {prompt && !row.async && (
        <MessageBubble message={{ id: `${row.id}:p`, role: "user", content: prompt }} engine={engine} />
      )}
      {calls.map((c: any) =>
        renderToolCard(engine, c, { deferred: !running, workspacePath: "" }) || (
          <AiToolCard key={c.id} {...c} engine={engine} workspacePath="" deferred={!running} />
        )
      )}
      {!running && report && (
        <AiTurn messages={[{ id: `${row.id}:r`, role: "assistant", content: String(report), isLive: false }]} engine={engine} isLive={false} />
      )}
    </div>
  );
}
