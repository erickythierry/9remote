// How many messages of a long chat the list keeps mounted. A turn carrying a diff and a
// tool's output can run to hundreds of KB, so the DOM holds a byte budget instead of the
// whole log; the rest is revealed on scroll-up.

export const PAGE_BUDGET_BYTES = 128 * 1024;
export const MAX_MOUNTED_BYTES = 512 * 1024;

interface ToolByteInput {
  command?: string;
  output?: string;
}

interface DiffByteInput {
  diff?: string;
  file?: string;
}

export interface MessageWindowItem {
  id?: string | number | null;
  role?: string;
  content?: string;
  thinking?: string;
  tools?: ToolByteInput[];
  diffs?: DiffByteInput[];
}

export function estimateMessageBytes(msg?: MessageWindowItem | null): number {
  if (!msg) return 0;
  let bytes = (msg.content?.length || 0) + (msg.thinking?.length || 0);
  if (Array.isArray(msg.tools)) {
    for (const t of msg.tools) {
      bytes += (t.command?.length || 0) + (t.output?.length || 0) + 120;
    }
  }
  if (Array.isArray(msg.diffs)) {
    for (const d of msg.diffs) {
      bytes += (d.diff?.length || 0) + (d.file?.length || 0) + 80;
    }
  }
  return Math.max(bytes, 100);
}

export function countMessagesByBudget(
  messages: MessageWindowItem[],
  budgetBytes: number,
  fromIndex?: number,
  minCount = 2
): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const end = Math.min(fromIndex ?? messages.length, messages.length);
  let accumulated = 0;
  let count = 0;
  for (let i = end - 1; i >= 0; i--) {
    accumulated += estimateMessageBytes(messages[i]);
    count++;
    if (accumulated >= budgetBytes && count >= minCount) break;
  }
  return end - count;
}

export function windowTop(
  prevTopId: MessageWindowItem["id"],
  messages: MessageWindowItem[],
  pageBytes: number,
  ceilingBytes: number
): { id: MessageWindowItem["id"]; index: number } {
  if (!messages?.length) return { id: null, index: 0 };
  const fresh = countMessagesByBudget(messages, pageBytes, undefined);
  const held = prevTopId != null ? messages.findIndex((m) => m.id === prevTopId) : -1;
  const bound = countMessagesByBudget(messages, Math.max(ceilingBytes, pageBytes), undefined);
  const index = held < 0 ? fresh : Math.max(held, bound);
  return { id: messages[index].id, index };
}

export const MAX_AUTO_PAGES = 40;

export function opensMidTurn(messages: MessageWindowItem[], hiddenCount: number, hasOlder: boolean): boolean {
  if (!hasOlder || !messages?.length) return false;
  return messages[hiddenCount]?.role !== "user";
}
