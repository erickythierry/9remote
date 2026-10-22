// 2-way text clipboard sync between host OS and web client.
// Host polls its clipboard; on change pushes to web. Web copy/cut pushes back.
// `lastText` cache on both ends prevents echo loops.
import { getClipboardText, setClipboardText } from "../../lib/clipboardSystem.js";
import { errorMessage } from "../../lib/errorMessage.js";

const POLL_INTERVAL = 1000; // ms — pbpaste/xclip are cheap, 1s is responsive enough

// Narrow view of the socket this feature uses; satisfied by socket.io Socket and HostBus.
export interface ClipboardSocket {
  on<A extends unknown[]>(event: string, handler: (...args: A) => unknown): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}

export function setupClipboardHandlers(socket: ClipboardSocket): void {
  let lastText: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const text = await getClipboardText();
      if (text !== lastText) {
        lastText = text;
        socket.emit("clipboard:sync", { text, origin: "host" });
      }
    } catch (e) {
      // Clipboard read may fail transiently (no xclip, locked) — skip this tick
    } finally {
      polling = false;
    }
  };

  socket.on("clipboard:set", async ({ text }: { text?: unknown; origin?: unknown }) => {
    if (typeof text !== "string") return;
    if (text === lastText) return; // echo back from our own push
    try {
      await setClipboardText(text);
      lastText = text; // cache so the next poll doesn't re-push it
    } catch (e) {
      console.error("[clipboard] set failed:", errorMessage(e));
    }
  });

  timer = setInterval(poll, POLL_INTERVAL);
  poll();

  socket.on("disconnect", () => {
    if (timer) clearInterval(timer);
  });
}
