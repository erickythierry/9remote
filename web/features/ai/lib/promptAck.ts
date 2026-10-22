// Settle-once ack wrapper for ai:prompt (#48): an emit into a dead-but-not-closed
// carrier never errors and never callbacks, so the prompt must time out on its
// own — same discipline as the gate resolver in useAiSession.
export type PromptAckResponse = { ok?: boolean; queued?: boolean; error?: string };

export function emitPromptAck<Payload, Timer = ReturnType<typeof setTimeout>>(
  emit: (payload: Payload, done: (response: PromptAckResponse | null | undefined) => void) => void,
  payload: Payload,
  timeoutMs: number,
  onLost: (reason: string) => void,
  schedule?: (callback: () => void, delayMs: number) => Timer,
  clear?: (timer: Timer) => void
): void {
  let settled = false;
  const timer: { current: Timer | undefined } = { current: undefined };
  const clearTimer = clear ?? ((handle: Timer) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const scheduleTimer = schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as Timer);
  const done = (res: PromptAckResponse | null | undefined): void => {
    if (settled) return;
    settled = true;
    if (timer.current !== undefined) clearTimer(timer.current);
    // ok|queued both mean the host received it — the user_message echo draws the bubble.
    if (res?.ok) return;
    onLost(res?.error || "timeout");
  };
  emit(payload, done);
  timer.current = scheduleTimer(() => done(null), timeoutMs);
}
