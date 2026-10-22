"use client";

import { create } from "zustand";
import { KANBAN_STATUSES, type KanbanStatus } from "@/shared/lib/jarvisConstants";

export interface KanbanTask {
  id?: string;
  title?: string;
  status: KanbanStatus | string;
  workspace?: string;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface KanbanBoard {
  tasks: Record<string, KanbanTask>;
}

export type KanbanSinkEvent =
  | { type: "move"; taskId: string; status: KanbanStatus }
  | { type: "delete"; taskId: string };

interface KanbanState {
  board: KanbanBoard;
  sink: ((event: KanbanSinkEvent) => void) | null;
  applyBoard(board: { tasks?: Record<string, KanbanTask> } | null | undefined): void;
  setSink(fn: unknown): void;
  moveTask(taskId: string, status: KanbanStatus): void;
  deleteTask(taskId: string): void;
}

// The web mirror of the Jarvis kanban board. The host owns the truth (daemon KV);
// applyBoard is what its broadcasts and getState replies land in. Hand moves are
// optimistic here and relayed through the sink the view wires to the bus, so the
// conductor and the user never edit two different boards.
const EMPTY: KanbanBoard = { tasks: {} };

/** Group tasks by column — pure, so a component memoizes it over the tasks object. */
export const columnsOf = (tasks: Record<string, KanbanTask> = {}): Record<KanbanStatus, KanbanTask[]> => {
  const byStatus = Object.fromEntries(KANBAN_STATUSES.map((s) => [s, [] as KanbanTask[]])) as Record<KanbanStatus, KanbanTask[]>;
  for (const task of Object.values(tasks)) {
    (byStatus[task.status as KanbanStatus] || byStatus.todo).push(task);
  }
  return byStatus;
};

/** A board shows its own workspace's cards; a task with no workspace is global. */
export const visibleTasks = (tasks: Record<string, KanbanTask> = {}, workspacePath = ""): Record<string, KanbanTask> => {
  const out: Record<string, KanbanTask> = {};
  for (const [id, task] of Object.entries(tasks)) {
    if (!task?.workspace || task.workspace === workspacePath) out[id] = task;
  }
  return out;
};

export const useKanbanStore = create<KanbanState>((set, get) => ({
  board: EMPTY,
  sink: null,

  applyBoard: (board) => set({ board: board?.tasks ? (board as KanbanBoard) : EMPTY }),

  setSink: (fn) => set({ sink: typeof fn === "function" ? (fn as (event: KanbanSinkEvent) => void) : null }),

  moveTask: (taskId, status) => {
    const task = get().board.tasks[taskId];
    if (!task || !KANBAN_STATUSES.includes(status)) return;
    set({ board: { tasks: { ...get().board.tasks, [taskId]: { ...task, status, updatedAt: Date.now() } } } });
    get().sink?.({ type: "move", taskId, status });
  },

  deleteTask: (taskId) => {
    if (!get().board.tasks[taskId]) return;
    const tasks = { ...get().board.tasks };
    delete tasks[taskId];
    set({ board: { tasks } });
    get().sink?.({ type: "delete", taskId });
  }
}));
