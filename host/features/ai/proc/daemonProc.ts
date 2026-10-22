// Driver for daemon-managed CLI processes across agent restarts.
import * as daemonClient from "../../terminal/ptyDaemonClient.js";

export interface ToLinesResult {
  lines: string[];
  rest: string;
}

export function toLines(text: string | Buffer): ToLinesResult {
  const parts = String(text).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export interface LineRecord {
  n: number;
  data: string;
  enc?: string;
}

export interface StartResultOptions {
  lines?: any[];
  after?: any[];
  missed?: number;
  release?: () => void;
  closeStdin?: (() => void) | null;
}

export interface StartResult {
  lines: any[];
  after: any[];
  missed: number;
  release: () => void;
  commit: (feed: (line: string) => void) => void;
  alive?: boolean;
  closeStdin?: () => void;
}

export interface DaemonProcOptions {
  procId: string;
  client?: typeof daemonClient;
}

export class DaemonProc {
  procId: string;
  client: typeof daemonClient;
  onLine: ((line: string, n?: number) => void) | null;
  onExit: ((info: { code: number | null; signal: string | null; error?: string }) => void) | null;
  onRefused: ((info?: { code: null; error: string }) => void) | null;
  dead: boolean;
  attached: boolean;
  private _lastLine: number;
  private _epoch: any;
  private _hold: any[] | null;

  private _handleLine: (msg: any) => void;
  private _handleExit: (msg: any) => void;

  constructor({ procId, client = daemonClient }: DaemonProcOptions) {
    this.procId = procId;
    this.client = client;
    this.onLine = null;
    this.onExit = null;
    this.onRefused = null;
    this.dead = false;
    this.attached = false;
    this._lastLine = 0;
    this._epoch = null;
    this._hold = null;
    this._handleLine = ({ procId: id, epoch, n, data }: any) => {
      if (id !== this.procId) return;
      if (epoch != null && epoch !== this._epoch) return;
      if (n <= this._lastLine) return;
      if (this._hold) this._hold.push({ n, data });
      else {
        this._lastLine = n;
        this.onLine?.(decodeLine(data), n);
      }
    };
    this._handleExit = ({ procId: id, epoch, code, signal, error }: any) => {
      if (id !== this.procId || this.dead) return;
      if (epoch != null && epoch !== this._epoch) return;
      this.dead = true;
      this._unsubscribe();
      this.onExit?.({ code, signal, error });
    };
  }

  private _subscribe() {
    if (this.attached) return;
    this.client.on("procLine", this._handleLine);
    this.client.on("procExit", this._handleExit);
    this.attached = true;
  }

  private _unsubscribe() {
    if (!this.attached) return;
    this.client.off("procLine", this._handleLine);
    this.client.off("procExit", this._handleExit);
    this.attached = false;
  }

  private _openHold() {
    if (!this._hold) this._hold = [];
    return this._hold;
  }

  private _result(total: number, lines: any[], oldest?: number | null) {
    const first = lines[0]?.n ?? oldest ?? null;
    const missed = first == null ? 0 : Math.max(0, first - (this._lastLine + 1));
    this._lastLine = Math.max(this._lastLine, total ?? 0);
    const after = this._openHold();
    let released = false;
    return {
      lines,
      after,
      missed,
      release: () => {
        if (released) return;
        released = true;
        this._hold = null;
        for (const held of after) {
          if (held.n <= this._lastLine) continue;
          this._lastLine = held.n;
          this.onLine?.(decodeLine(held.data), held.n);
        }
      }
    };
  }

  /** Start CLI under daemon; returns initial buffered lines. */
  async start({ bin, args = [], cwd, env = {}, from = 0, keepStdin = false }: {
    bin: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    from?: number;
    keepStdin?: boolean;
  }): Promise<StartResult> {
    this._lastLine = from;
    this._hold = null;
    this.dead = false;
    this._subscribe();
    this._openHold();
    try {
      const res = await (this.client as any).procStart(this.procId, { bin, args, cwd, env });
      if (!res.success) throw new Error(res.error || "Failed to start process");
      this._epoch = res.epoch ?? null;
      const fetched = await (this.client as any).procLines(this.procId, from);
      const result = this._result(fetched.total, fetched.lines || [], fetched.oldest);
      return startResult(keepStdin ? result : { ...result, closeStdin: () => this.closeStdin() });
    } catch (e) {
      this._unsubscribe();
      throw e;
    }
  }

  /** Re-attach to a running daemon process. */
  async attach(from: number | { from?: number; epoch?: any } = 0, epoch: any = null): Promise<{ alive: boolean } & StartResult> {
    if (typeof from === "object" && from !== null) {
      epoch = from.epoch ?? null;
      from = from.from ?? 0;
    }
    from = Number(from) || 0;
    this._lastLine = from;
    this._subscribe();
    this._openHold();
    const res = await (this.client as any).procAttach(this.procId, from);
    if (!res.success) {
      this._unsubscribe();
      return { alive: false, ...startResult() };
    }
    this._epoch = res.epoch ?? null;
    this.dead = !res.alive;
    if (this.dead) this._unsubscribe();
    if (epoch != null && res.epoch !== epoch) this._lastLine = 0;
    return { alive: Boolean(res.alive), ...startResult(this._result(res.total, res.lines || [], res.oldest)) };
  }

  get lineNo(): number {
    return this._lastLine;
  }

  get epoch(): any {
    return this._epoch;
  }

  async lines(from: number = 0): Promise<StartResult> {
    this._openHold();
    const res = await (this.client as any).procLines(this.procId, from);
    if (!res.success) return startResult();
    return startResult(this._result(res.total, res.lines || [], res.oldest));
  }

  /** Write text to process stdin via daemon. */
  write(text: string | Buffer): boolean {
    if (this.dead) return false;
    const onRefused = this.onRefused;
    (this.client as any).procWrite(this.procId, Buffer.from(String(text)).toString("base64"))
      .then((res: any) => {
        if (res?.success) return;
        this.dead = true;
        this._unsubscribe();
        onRefused?.({ code: null, error: res?.error || "Process not writable" });
      })
      .catch(() => {});
    return true;
  }

  /** Close stdin for non-interactive engines. */
  closeStdin() {
    return (this.client as any).procEndInput(this.procId);
  }

  /** Send signal to process. */
  signal(signal: string = "SIGINT") {
    return (this.client as any).procSignal(this.procId, signal);
  }

  async stop() {
    this._unsubscribe();
    return await (this.client as any).procStop(this.procId);
  }
}

export function decodeLine(line: any): string {
  if (typeof line === "string") return line;
  if (!line?.data) return "";
  return line.enc === "b64" ? Buffer.from(line.data, "base64").toString("utf8") : line.data;
}

/** Standard return shape for start/attach calls. */
export function startResult({ lines = [], after = [], missed = 0, release = () => {}, closeStdin = null }: StartResultOptions = {}): StartResult {
  return {
    lines,
    after,
    missed,
    release,
    commit: (feed: (line: string) => void) => {
      for (const line of lines) feed(decodeLine(line));
      release();
      closeStdin?.();
    }
  };
}
