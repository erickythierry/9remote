// Bidirectional JSON-RPC stdio client across AI CLI engines
export interface ProcLike {
  onLine?: ((line: string, n?: number) => void) | null;
  onExit?: ((info: any) => void) | null;
  onRefused?: ((err?: any) => void) | null;
  write(text: string): boolean | void;
  closeStdin?(): void;
  signal?(sig?: string): void;
  stop?(): Promise<any>;
  [key: string]: any;
}

export interface JsonRpcClientOptions {
  extractId?: (msg: any) => any;
  extractMethod?: (msg: any) => string | null;
  encodeResponse?: (id: any, result: any) => any;
  encodeError?: (id: any, message: string) => any;
  encodeNotification?: (method: string, params: any) => any;
  encodeRequest?: (id: any, method: string, params: any) => any;
  decodeResponse?: (msg: any) => { id: any; error: any; result: any };
  onMessage?: ((msg: any) => void) | null;
}

interface PendingRequest {
  resolve: (val: any) => void;
  reject: (err: any) => void;
  settle: (fn: (arg: any) => void, arg: any) => void;
}

export class JsonRpcClient {
  proc: ProcLike;
  private _extractId: (msg: any) => any;
  private _extractMethod: (msg: any) => string | null;
  private _encodeResponse: (id: any, result: any) => any;
  private _encodeError: (id: any, message: string) => any;
  private _encodeNotification: (method: string, params: any) => any;
  private _encodeRequest: (id: any, method: string, params: any) => any;
  private _decodeResponse: (msg: any) => { id: any; error: any; result: any };
  private _onMessage: ((msg: any) => void) | null;

  private _nextId: number;
  private _pending: Map<any, PendingRequest>;
  private _handlers: Map<string, (params: any, id?: any) => any>;
  private _exitHandlers: ((info: any) => void)[];
  closed: boolean;
  dead: boolean;
  isTurnRunning?: boolean;
  private _early: any[];

  constructor(proc: ProcLike, {
    extractId = defaultId, extractMethod = defaultMethod,
    encodeResponse = defaultEncodeResponse, encodeError = defaultEncodeError,
    encodeNotification = defaultEncodeNotification, encodeRequest = defaultEncodeRequest,
    decodeResponse = defaultDecodeResponse, onMessage = null
  }: JsonRpcClientOptions = {}) {
    this.proc = proc;
    this._extractId = extractId;
    this._extractMethod = extractMethod;
    this._encodeResponse = encodeResponse;
    this._encodeError = encodeError;
    this._encodeNotification = encodeNotification;
    this._encodeRequest = encodeRequest;
    this._decodeResponse = decodeResponse;
    this._onMessage = onMessage;

    this._nextId = 1;
    this._pending = new Map();
    this._handlers = new Map();
    this._exitHandlers = [];
    this.closed = false;
    this.dead = false;
    this._early = [];
    this.attach();
  }

  attach(): this {
    this.proc.onLine = (line: string) => this._receive(line);
    this.proc.onExit = (info: any) => this._handleExit(info);
    return this;
  }

  request(method: string, params: any = {}, { timeoutMs = 0 }: { timeoutMs?: number } = {}): Promise<any> {
    if (this.dead || this.closed) {
      return Promise.reject(new Error("Codex app-server has exited or been closed"));
    }
    const id = this._nextId++;
    let timer: NodeJS.Timeout | null = null;
    const answer = new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve,
        reject,
        settle: (fn, arg) => { if (timer) clearTimeout(timer); timer = null; this._pending.delete(id); fn(arg); }
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const pending = this._pending.get(id);
        if (!pending) return;
        pending.settle(pending.reject, new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    this.proc.write(JSON.stringify(this._encodeRequest(id, method, params)) + "\n");
    this._drainEarly();
    return answer;
  }

  notify(method: string, params: any = {}, onRefused: (() => void) | null = null): boolean {
    if (this.dead || this.closed) {
      onRefused?.();
      return false;
    }
    return this._write(JSON.stringify(this._encodeNotification(method, params)) + "\n", onRefused);
  }

  respond(id: any, result: any): boolean {
    if (this.dead || this.closed) return false;
    return this._write(JSON.stringify(this._encodeResponse(id, result)) + "\n");
  }

  private _write(text: string, onRefused: (() => void) | null = null): boolean {
    this.proc.onRefused = onRefused;
    const ok = this.proc.write(text) !== false;
    if (!ok) onRefused?.();
    return ok;
  }

  on(method: string, fn: (params: any, id?: any) => any): this {
    this._handlers.set(method, fn);
    return this;
  }

  onExit(fn: (info: any) => void): this {
    this._exitHandlers.push(fn);
    return this;
  }

  // Buffers early responses that arrive before corresponding request is written
  feed(line: string) {
    this._feedEarly(line);
  }

  private _feedEarly(line: string) {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text) return;
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    const { id } = this._decodeResponse(msg);
    const method = this._extractMethod(msg);
    if (method == null && id != null && !this._pending.has(id)) {
      this._early.push(msg);
      return;
    }
    this._receive(text);
  }

  private _drainEarly() {
    if (!this._early.length) return;
    const queued = this._early;
    this._early = [];
    for (const msg of queued) this._receive(JSON.stringify(msg));
  }

  private _receive(line: string) {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text) return;
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    const id = this._extractId(msg);
    const method = this._extractMethod(msg);

    if (method == null) {
      const answer = this._decodeResponse(msg);
      const pending = answer.id != null ? this._pending.get(answer.id) : (id != null ? this._pending.get(id) : null);
      if (!pending) {
        // Route unhandled non-response messages (e.g. Claude stream events)
        this._onMessage?.(msg);
        return;
      }
      if (answer.error) pending.settle(pending.reject, new Error(answer.error.message || answer.error || "request failed"));
      else pending.settle(pending.resolve, answer.result);
      return;
    }

    const handler = this._handlers.get(method);

    if (id != null) {
      if (!handler) {
        this.proc.write(JSON.stringify(
          this._encodeError(id, `unhandled server request: ${method}`)
        ) + "\n");
        return;
      }
      const answer = handler(msg.params || {}, id);
      if (answer && typeof answer.then === "function") answer.then((r: any) => r !== undefined && this.respond(id, r));
      else if (answer !== undefined) this.respond(id, answer);
      return;
    }

    if (handler) handler(msg.params || {});
    else this._onMessage?.(msg);
  }

  private _handleExit(info: any) {
    if (this.dead) return;
    this.dead = true;
    this.isTurnRunning = false;
    const err = new Error(`Codex app-server exited (code ${info?.code ?? "?"})`);
    for (const pending of [...this._pending.values()]) pending.settle(pending.reject, err);
    this._pending.clear();
    for (const fn of this._exitHandlers) fn(info);
  }

  close() {
    this.closed = true;
  }

  // Stop listening without treating process exit as an error
  detach() {
    this.closed = true;
    this.proc.onLine = null;
    this.proc.onExit = null;
    const err = new Error("Codex app-server was replaced");
    for (const pending of [...this._pending.values()]) pending.settle(pending.reject, err);
    this._pending.clear();
  }
}

const defaultEncodeResponse = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });
const defaultEncodeError = (id: any, message: string) => ({ jsonrpc: "2.0", id, error: { code: -32601, message } });
const defaultEncodeNotification = (method: string, params: any) => ({ jsonrpc: "2.0", method, params });
const defaultEncodeRequest = (id: any, method: string, params: any) => ({ jsonrpc: "2.0", id, method, params });
const defaultDecodeResponse = (msg: any) => ({ id: msg.id ?? null, error: msg.error, result: msg.result });
const defaultId = (msg: any) => (msg.id === undefined ? null : msg.id);
const defaultMethod = (msg: any) => (typeof msg.method === "string" ? msg.method : null);
