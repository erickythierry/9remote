#!/usr/bin/env node
// PTY Daemon: manages persistent PTY sessions across server restarts.

import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "child_process";
import type { Readable } from "stream";
import pty from "node-pty";
import { resolveShell, buildShellArgs, DAEMON_VERSION } from "./constants.js";
import { createRouter, type RouteHandler } from "./daemonRouter.js";
import { createKvStore, kvRoutes } from "./daemonKv.js";
import { takeBufferTail, takeBufferRange, bufferTotal } from "./bufferSlice.js";

// NREMOTE_HOME keeps daemon state inside client root to isolate test daemon.
const SOCKET_DIR = process.env.NREMOTE_HOME || path.join(os.homedir(), ".9remote");
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\9remote-pty"
  : path.join(SOCKET_DIR, "pty-daemon.sock");

// PID file for updater and app lifecycle management.
const PID_FILE = path.join(SOCKET_DIR, "pids", "ptyDaemon.pid");

// Narrow view of the node-pty instance this daemon drives.
type PtyProcess = {
  process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: () => void): unknown;
};

// Fields the routes read from a client message; all optional because the wire is untrusted.
type DaemonMessage = {
  type?: string; requestId?: string; sessionId?: string; procId?: string; timeout?: number;
  name?: string; cols?: number; rows?: number; shellId?: string; cwd?: string;
  from?: number; have?: number; data?: string; enc?: string; signal?: string; client?: unknown;
  bin?: string; args?: string[]; env?: Record<string, string>; windowsVerbatimArguments?: boolean;
  key?: string; value?: unknown;
};

type ProcOptions = {
  bin?: string; args?: string[]; cwd?: string; env?: Record<string, string>; windowsVerbatimArguments?: boolean;
};

type DaemonSession = {
  pty: PtyProcess;
  buffer: Buffer[];
  modes: Set<string>;
  name: string | undefined;
  createdAt: number;
  cwd: string;
  shellId: string;
  shellLabel: string;
  zdotDir: string | null;
  pending: string | null;
  flushScheduled: boolean;
  procTimer: NodeJS.Timeout | null;
  foregroundProcess: string | null;
};

type ProcLine = { n: number; data: Buffer };

type DaemonProc = {
  id: string;
  epoch: number;
  child: ChildProcessWithoutNullStreams | null;
  cwd: string | undefined;
  lines: ProcLine[];
  lineCount: number;
  bytes: number;
  exited: boolean;
  exitedAt?: number;
  exitCode: number | null;
  tail: string;
};

const errMsg = (e: unknown): string => (e as { message: string }).message;

const sessions = new Map<string, DaemonSession>();
const clients = new Set<net.Socket>();

const MAX_BUFFER_SIZE = 2 * 1024 * 1024;
const JOIN_REPLAY_SIZE = 256 * 1024;
const HISTORY_CHUNK_SIZE = 256 * 1024;
const MAX_LOG_SIZE = 5 * 1024 * 1024;

// Buffer storage = Buffer[] (byte-accurate) to keep total/have consistent across multibyte/ANSI.
const RESTORE_MODES = ["1049", "1047", "1000", "1002", "1003", "1006", "1015", "1005"];
const DEC_PRIVATE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

function applyModes(modes: Set<string>, data: string) {
  if (typeof data !== "string") data = String(data);
  for (const m of data.matchAll(DEC_PRIVATE_RE)) {
    const set = m[2] === "h";
    for (const n of m[1].split(";")) {
      if (set) modes.add(`?${n}`);
      else modes.delete(`?${n}`);
    }
  }
}

function restoreSeq(modes: Set<string>): string {
  const active = RESTORE_MODES.filter((n) => modes.has(`?${n}`));
  return active.length ? `\x1b[?${active.join(";")}h` : "";
}

const LOG_DIR = path.join(SOCKET_DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "daemon.log");
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function checkLogSize() {
  try {
    if (fs.existsSync(LOG_PATH)) {
      const stats = fs.statSync(LOG_PATH);
      if (stats.size > MAX_LOG_SIZE) {
        const content = fs.readFileSync(LOG_PATH, "utf8");
        const truncated = content.slice(-1024 * 1024);
        fs.writeFileSync(LOG_PATH, truncated);
      }
    }
  } catch (e) {
  }
}

function logError(message: string, error: unknown = null) {
  checkLogSize();
  const timestamp = new Date().toISOString();
  let logLine = `[${timestamp}] ERROR: ${message}`;
  if (error) {
    logLine += ` - ${errMsg(error) || error}`;
  }
  logLine += "\n";

  try {
    fs.appendFileSync(LOG_PATH, logLine);
  } catch (e) {
  }

  console.error(logLine.trim());
}

function getDefaultCwd(): string {
  if (process.env.CODESPACES === "true") {
    return process.env.CODESPACE_VSCODE_FOLDER || "/workspaces";
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function buildShellEnv(shellPath: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "en_US.UTF-8"
  };
  // Don't leak agent internals (PORT, NODE_ENV) into user shells.
  delete env.PORT;
  delete env.NODE_ENV;

  const isZsh = shellPath.includes("zsh");
  const isBash = shellPath.includes("bash");

  let zdotDir: string | null = null;
  if (isZsh) {
    // zsh ignores a bare env hook; write a real .zshrc into a temp ZDOTDIR so precmd fires.
    zdotDir = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-zsh-"));
    const tmpZshrc = path.join(zdotDir, ".zshrc");
    const home = env.HOME || os.homedir();
    // Temp ZDOTDIR injected for OSC 7; source HOME login files skipped by zsh.
    let body = "";
    body += `[ -f "${home}/.zprofile" ] && source "${home}/.zprofile"\n`;
    body += `[ -f "${home}/.zshrc" ] && source "${home}/.zshrc"\n`;
    body += `[ -f "${home}/.zlogin" ] && source "${home}/.zlogin"\n`;
    // Append OSC 7 to precmd_functions so a user-defined precmd in .zshrc still runs.
    body += "NineRemoteOsc7() { print -Pn \"\\e]7;file://%m\${PWD}\\e\\\\\" }\n";
    body += "precmd_functions+=( NineRemoteOsc7 )\n";
    fs.writeFileSync(tmpZshrc, body);
    env.ZDOTDIR = zdotDir;
  } else if (isBash) {
    const existingPrompt = env.PROMPT_COMMAND || "";
    env.PROMPT_COMMAND = `printf "\\e]7;file://%s\\a" "\${HOSTNAME}\${PWD}"${existingPrompt ? `; ${existingPrompt}` : ""}`;
  }

  // cmd.exe: OSC 7 via PROMPT env var.
  if (/cmd\.exe$/i.test(shellPath)) {
    env.PROMPT = `$E]7;file://${process.env.COMPUTERNAME || ""}/$P$E\\$G$S`;
  }

  return { env, zdotDir };
}

function broadcast(message: unknown) {
  const data = JSON.stringify(message) + "\n";
  for (const client of clients) {
    try {
      client.write(data);
    } catch (e) {
    }
  }
}

function send(client: unknown, message: unknown) {
  try {
    // Router passes its client as unknown; it is always a net.Socket here.
    (client as net.Socket).write(JSON.stringify(message) + "\n");
  } catch (e) {
  }
}

// Managed child processes: daemon owns the process, agent handles parsing/protocol.
const procs = new Map<string, DaemonProc>();
// procEpoch identifies process incarnation so stale exits are ignored.
let procEpoch = 0;
const PROC_BUFFER_SIZE = 512 * 1024;
// Bound max stream line length before flushing as-is.
const PROC_MAX_LINE = 256 * 1024;
const PROC_KILL_GRACE_MS = 3000;
// An exited proc keeps its buffered lines for a late re-attach, then frees them.
const PROC_EXIT_GRACE_MS = 60 * 60 * 1000;

function procLinesSince(proc: DaemonProc, from: number | { from?: number } = 0) {
  const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
  const out = [];
  for (const l of proc.lines) {
    if (l.n > f) out.push({ n: l.n, enc: "b64", data: l.data.toString("base64") });
  }
  return out;
}

function createProc(procId: string, { bin, args = [], cwd, env, windowsVerbatimArguments }: ProcOptions = {}) {
  if (!procId) return { success: false, error: "Missing procId" };
  if (!bin) return { success: false, error: "Missing bin" };
  const existing = procs.get(procId);
  if (existing && !existing.exited) return { success: false, error: "Process already running" };

  const child = spawn(bin, args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : getDefaultCwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(env || {}) },
    // Own session/group: stopping a CLI can then signal the whole tree like a closed terminal.
    detached: process.platform !== "win32",
    // Windows .cmd shims arrive pre-escaped for cmd.exe (rewritten at the client
    // door via cross-spawn) — Node must not quote them a second time.
    windowsVerbatimArguments: windowsVerbatimArguments === true
  });

  const proc: DaemonProc = {
    id: procId,
    epoch: ++procEpoch,
    child,
    cwd,
    lines: [],
    lineCount: 0,
    bytes: 0,
    exited: false,
    exitCode: null,
    tail: ""
  };
  procs.set(procId, proc);

  const emitLine = (text: string) => {
    const data = Buffer.from(text, "utf8");
    proc.lineCount++;
    proc.lines.push({ n: proc.lineCount, data });
    proc.bytes += data.length;
    while (proc.bytes > PROC_BUFFER_SIZE && proc.lines.length > 1) {
      proc.bytes -= proc.lines[0].data.length;
      proc.lines.shift();
    }
    broadcast({ type: "procLine", procId, epoch: proc.epoch, n: proc.lineCount, enc: "b64", data: data.toString("base64") });
  };

  const pump = (stream: Readable) => {
    stream.on("data", (chunk: Buffer) => {
      proc.tail += chunk.toString("utf8");
      if (proc.tail.length > PROC_MAX_LINE) {
        emitLine(proc.tail);
        proc.tail = "";
        return;
      }
      const parts = proc.tail.split("\n");
      proc.tail = parts.pop() || "";
      for (const part of parts) emitLine(part);
    });
  };
  pump(child.stdout);
  pump(child.stderr);
  // A CLI dying mid-write EPIPEs its stdin — exit is reported via "close" below.
  child.stdin.on("error", () => {});

  child.on("error", (err: Error) => {
    proc.exited = true;
    proc.exitedAt = Date.now();
    broadcast({ type: "procExit", procId, epoch: proc.epoch, code: null, error: err.message });
  });
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    if (proc.tail) { emitLine(proc.tail); proc.tail = ""; }
    proc.exited = true;
    proc.exitedAt = Date.now();
    proc.exitCode = code;
    proc.child = null;
    broadcast({ type: "procExit", procId, epoch: proc.epoch, code, signal: signal || null });
  });

  return { success: true, procId, epoch: proc.epoch, pid: child.pid };
}

function attachProc(procId: string, from: number | { from?: number } = 0) {
  if (typeof from === "object" && from !== null) from = from.from ?? 0;
  from = Number(from) || 0;
  const proc = procs.get(procId);
  if (!proc) return { success: false, error: "Process not found" };
  return {
    success: true,
    alive: !proc.exited,
    epoch: proc.epoch,
    lines: procLinesSince(proc, from),
    total: proc.lineCount,
    oldest: proc.lines[0]?.n ?? proc.lineCount + 1,
    exitCode: proc.exitCode
  };
}

function writeProc(procId: string, data: string, enc: string = "b64") {
  const proc = procs.get(procId);
  if (!proc?.child?.stdin?.writable) return { success: false, error: "Process not writable" };
  proc.child.stdin.write(enc === "b64" ? Buffer.from(data, "base64") : data);
  return { success: true };
}

// Close stdin for non-interactive CLI engines.
function endInputProc(procId: string) {
  const proc = procs.get(procId);
  if (!proc?.child?.stdin?.writable) return { success: false, error: "Process not writable" };
  try { proc.child.stdin.end(); } catch (e) { return { success: false, error: errMsg(e) }; }
  return { success: true };
}

function signalProc(procId: string, signal: string = "SIGINT") {
  const proc = procs.get(procId);
  if (!proc?.child) return { success: false, error: "Process not running" };
  try {
    // Wire name passed straight to kill; an unknown name throws and is reported below.
    proc.child.kill(signal as NodeJS.Signals);
  } catch (e) {
    return { success: false, error: errMsg(e) };
  }
  return { success: true };
}

// Signal the CLI's whole process group — mirrors a terminal, where closing the tab reaches every process the CLI spawned.
function killProcTree(child: ChildProcess | null | undefined, signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      // Windows cannot deliver a graceful SIGINT — tree-kill directly (spawn errors are async, so they need a handler).
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]).on("error", () => {});
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {}
}

function stopProc(procId: string) {
  const proc = procs.get(procId);
  if (!proc) return { success: false, error: "Process not found" };
  const child = proc.child;
  if (child) {
    killProcTree(child, "SIGINT");
    // SIGKILL stays armed even after a graceful exit — INT-ignoring grandchildren (shell `&` jobs) would otherwise orphan.
    const timer = setTimeout(() => killProcTree(child, "SIGKILL"), PROC_KILL_GRACE_MS);
    timer.unref?.();
  }
  procs.delete(procId);
  return { success: true };
}

// Free exited procs' buffers after the grace window — one sweeper, no per-proc timers to leak.
setInterval(() => {
  const now = Date.now();
  for (const [id, proc] of procs) {
    if (proc.exited && proc.exitedAt && now - proc.exitedAt >= PROC_EXIT_GRACE_MS) procs.delete(id);
  }
}, 10 * 60 * 1000).unref?.();

function createSession(sessionId: string, name: string | undefined, cols = 80, rows = 24, shellId: string | null = null, cwd: string | null = null) {
  if (sessions.has(sessionId)) {
    return { success: false, error: "Session already exists" };
  }

  const shellConfig = resolveShell(shellId);
  if (!cwd || !fs.existsSync(cwd)) cwd = getDefaultCwd();

  try {
    const { env: shellEnv, zdotDir } = buildShellEnv(shellConfig.path);
    shellEnv.NINE_REMOTE_SESSION_ID = sessionId;

    const ptyProcess: PtyProcess = pty.spawn(shellConfig.path, buildShellArgs(shellConfig), {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv,
      useConpty: process.platform === "win32"
    });

    // PowerShell OSC 7 prompt is injected via -NoExit -Command arg.
    const session: DaemonSession = {
      pty: ptyProcess,
      buffer: [],
      modes: new Set(),
      name,
      createdAt: Date.now(),
      cwd,
      shellId: shellConfig.id,
      shellLabel: shellConfig.label,
      zdotDir,
      pending: null,
      flushScheduled: false,
      procTimer: null,
      foregroundProcess: getSessionForegroundProcess({ pty: ptyProcess }) || shellConfig.id
    };

    // Coalesce same-tick onData chunks into one output packet via setImmediate.
    const flushOutput = () => {
      session.flushScheduled = false;
      const pending = session.pending;
      if (!pending) return;
      session.pending = null;
      broadcast({
        type: "output",
        sessionId,
        enc: "b64",
        data: Buffer.from(pending).toString("base64")
      });
    };

    ptyProcess.onData((data: string) => {
      session.buffer.push(Buffer.from(data, "utf-8"));
      applyModes(session.modes, data);
      // Track live cwd from OSC 7 escape sequence.
      const osc7 = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)/);
      if (osc7) {
        let next: string;
        try { next = decodeURIComponent(osc7[1]); } catch { next = osc7[1]; }
        // Win drive paths gain a leading slash from file://host/<drive>:/ — strip it.
        if (process.platform === "win32" && /^\/[a-zA-Z]:[\\/]/.test(next)) next = next.slice(1);
        if (next && next !== session.cwd) {
          session.cwd = next;
          broadcast({ type: "cwdChange", sessionId, cwd: next });
        }
      }
      const totalSize = bufferTotal(session.buffer);
      if (totalSize > MAX_BUFFER_SIZE) {
        session.buffer = [takeBufferTail(session.buffer, MAX_BUFFER_SIZE)];
      }

      session.pending = session.pending === null ? data : session.pending + data;
      if (!session.flushScheduled) {
        session.flushScheduled = true;
        setImmediate(flushOutput);
      }

      if (session.procTimer) clearTimeout(session.procTimer);
      session.procTimer = setTimeout(() => {
        session.procTimer = null;
        checkSessionForegroundProcess(session, sessionId);
      }, 250);
    });

    ptyProcess.onExit(() => {
      if (session.procTimer) clearTimeout(session.procTimer);
      sessions.delete(sessionId);
      if (session.zdotDir) fs.rm(session.zdotDir, { recursive: true, force: true }, () => {});
      broadcast({ type: "sessionClosed", sessionId });
    });

    sessions.set(sessionId, session);
    return { success: true, sessionId, cwd, shellId: shellConfig.id, shellLabel: shellConfig.label };
  } catch (error) {
    logError("Failed to create session", error);
    return { success: false, error: errMsg(error) };
  }
}

function getSessionForegroundProcess(session: { pty?: PtyProcess } | null | undefined): string | null {
  if (!session?.pty) return null;
  try {
    const raw = session.pty.process;
    return raw ? path.basename(raw) : null;
  } catch {
    return null;
  }
}

function checkSessionForegroundProcess(session: DaemonSession, sessionId: string) {
  if (!session?.pty) return;
  const proc = getSessionForegroundProcess(session);
  if (proc && proc !== session.foregroundProcess) {
    const prev = session.foregroundProcess;
    session.foregroundProcess = proc;
    if (prev !== null) {
      broadcast({
        type: "processChange",
        sessionId,
        process: proc,
        prevProcess: prev
      });
    }
  }
}

const kvStore = createKvStore(500);

const router = createRouter({
  deps: { sessions, procs, send, broadcast, DAEMON_VERSION, kv: kvStore },
  send
});

const terminalRoutes = {
  ping: () => ({ version: DAEMON_VERSION }),

  listSessions: () => ({
    sessions: Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      name: s.name,
      createdAt: s.createdAt,
      shellId: s.shellId,
      shellLabel: s.shellLabel,
      cwd: s.cwd,
      foregroundProcess: s.foregroundProcess || getSessionForegroundProcess(s)
    }))
  }),

  createSession: (m: DaemonMessage) => createSession(
    m.sessionId || `session-${Date.now()}`,
    m.name, m.cols, m.rows, m.shellId, m.cwd
  ),

  joinSession: (m: DaemonMessage) => {
    const session = sessions.get(m.sessionId!);
    if (!session) return { success: false, error: "Session not found" };
    const client = m.client;
    // Restore terminal modes before history replay so alt-screen/mouse modes persist.
    const restore = restoreSeq(session.modes);
    if (restore) {
      send(client, { type: "output", sessionId: m.sessionId, enc: "b64", replay: true, data: Buffer.from(restore).toString("base64") });
    }
    const history = takeBufferTail(session.buffer, JOIN_REPLAY_SIZE);
    if (history && history.length) {
      send(client, { type: "output", sessionId: m.sessionId, enc: "b64", replay: true, data: history.toString("base64") });
    }
    return {
      success: true,
      name: session.name,
      cwd: session.cwd,
      shellId: session.shellId,
      shellLabel: session.shellLabel,
      total: bufferTotal(session.buffer),
      replaySize: history ? history.length : 0
    };
  },

  requestHistory: (m: DaemonMessage) => {
    // Return chunk of older buffer history preceding what client currently has.
    const session = sessions.get(m.sessionId!);
    if (!session) return { success: false, error: "Session not found" };
    const total = bufferTotal(session.buffer);
    const have = Math.max(0, Math.min(m.have || 0, total));
    const remaining = total - have;
    const chunkLen = Math.min(HISTORY_CHUNK_SIZE, remaining);
    const { prefix, extra = 0 } = chunkLen > 0 ? takeBufferRange(session.buffer, have, chunkLen) : { prefix: Buffer.alloc(0), extra: 0 };
    return {
      success: true,
      sessionId: m.sessionId,
      enc: "b64",
      prefix: prefix && prefix.length ? prefix.toString("base64") : "",
      prefixLen: prefix ? prefix.length : 0,
      total,
      remaining: Math.max(0, remaining - chunkLen)
    };
  },

  input: (m: DaemonMessage) => {
    const session = sessions.get(m.sessionId!);
    if (!session?.pty) return {};
    session.pty.write(m.data!);
    if (session.procTimer) clearTimeout(session.procTimer);
    session.procTimer = setTimeout(() => {
      session.procTimer = null;
      checkSessionForegroundProcess(session, m.sessionId!);
    }, 300);
    return {};
  },

  resize: (m: DaemonMessage) => {
    const session = sessions.get(m.sessionId!);
    if (!session?.pty) return {};
    try {
      session.pty.resize(m.cols!, m.rows!);
    } catch (e) {
    }
    return {};
  },

  deleteSession: (m: DaemonMessage) => {
    const session = sessions.get(m.sessionId!);
    if (!session) return { success: false, error: "Session not found" };
    if (session.pty) session.pty.kill();
    sessions.delete(m.sessionId!);
    broadcast({ type: "sessionClosed", sessionId: m.sessionId });
    return { success: true };
  },

  getCwd: (m: DaemonMessage) => ({ cwd: sessions.get(m.sessionId!)?.cwd || null })
};

const procRoutes = {
  start: (m: DaemonMessage) => createProc(m.procId!, m),
  attach: (m: DaemonMessage) => attachProc(m.procId!, m.from),

  lines: (m: DaemonMessage) => {
    const p = procs.get(m.procId!);
    if (!p) return { success: false, error: "Process not found" };
    return {
      success: true,
      epoch: p.epoch,
      lines: procLinesSince(p, m.from || 0),
      total: p.lineCount,
      oldest: p.lines[0]?.n ?? p.lineCount + 1
    };
  },

  write: (m: DaemonMessage) => writeProc(m.procId!, m.data!, m.enc),
  endInput: (m: DaemonMessage) => endInputProc(m.procId!),
  signal: (m: DaemonMessage) => signalProc(m.procId!, m.signal),
  stop: (m: DaemonMessage) => stopProc(m.procId!),

  list: () => ({
    success: true,
    procs: Array.from(procs.values()).map((p) => ({ procId: p.id, alive: !p.exited, total: p.lineCount, cwd: p.cwd }))
  })
};

router.register("terminal", terminalRoutes);
router.register("proc", procRoutes);
router.register("kv", kvRoutes as unknown as Record<string, RouteHandler>);
// Ensure all promised routes are registered at startup.
router.assertComplete();

function handleMessage(client: net.Socket, message: DaemonMessage) {
  router.enqueue({ client, message: { ...message, client } });
}

function startDaemon() {
  if (!fs.existsSync(SOCKET_DIR)) {
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
    } catch (e) {
      logError("Failed to create socket directory", e);
      process.exit(1);
    }
  }

  if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch (e) {
      logError("Failed to remove stale socket", e);
      process.exit(1);
    }
  }

  const server = net.createServer((client: net.Socket) => {
    clients.add(client);

    let buffer = "";

    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message: DaemonMessage = JSON.parse(line);
            handleMessage(client, message);
          } catch (e) {
            logError("Invalid message", line);
          }
        }
      }
    });

    client.on("close", () => {
      clients.delete(client);
    });

    client.on("error", (err: Error) => {
      logError("Client error", err);
      clients.delete(client);
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    logError("Server error", err);
    if (err.code === "EADDRINUSE") {
      logError("Socket already in use, exiting");
    }
    process.exit(1);
  });

  server.listen(SOCKET_PATH, () => {
    if (process.platform !== "win32") {
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    }
  });

  // Write PID for targeted process cleanup.
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  } catch {}

  const cleanupAndExit = () => {
    for (const [, session] of sessions) {
      if (session.procTimer) clearTimeout(session.procTimer);
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }
    for (const [, proc] of procs) {
      killProcTree(proc.child, "SIGINT");
    }
    try { server.close(); } catch {}
    if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
      try { fs.unlinkSync(SOCKET_PATH); } catch {}
    }
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };

  process.on("SIGTERM", cleanupAndExit);
  process.on("SIGINT", cleanupAndExit);
}

startDaemon();
