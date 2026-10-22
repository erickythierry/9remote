// PTY Daemon Client: connects to persistent PTY daemon over local socket.

import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import crossSpawnParse from "cross-spawn/lib/parse.js";
import { fileURLToPath } from "url";
import { DAEMON_VERSION } from "./constants.js";
import { NODE_BIN, nodeSpawnEnv, PATHS } from "../../lib/constants.js";
import type {
  DaemonCreateSessionResult,
  DaemonHistoryResult,
  DaemonJoinSessionResult,
  DaemonProcAttachResult,
  DaemonProcInfo,
  DaemonProcLinesResult,
  DaemonProcListResult,
  DaemonProcResult,
  DaemonSessionList,
  DaemonSessionSummary
} from "./daemonTypes.js";

export type {
  DaemonCreateSessionResult,
  DaemonHistoryResult,
  DaemonJoinSessionResult,
  DaemonProcAttachResult,
  DaemonProcInfo,
  DaemonProcLinesResult,
  DaemonProcListResult,
  DaemonProcResult,
  DaemonSessionList,
  DaemonSessionSummary
} from "./daemonTypes.js";

type DaemonRequest = { type: string; requestId?: number; [key: string]: unknown };
type DaemonResponseMessage = {
  type: string;
  requestId?: number;
  sessionId?: string;
  enc?: string;
  replay?: boolean;
  data?: string;
  procId?: string;
  epoch?: number;
  n?: number;
  process?: string;
  prevProcess?: string | null;
  cwd?: string | null;
  code?: number | null;
  signal?: string | null;
  error?: string;
  [key: string]: unknown;
};
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type DaemonClientEvent = "connected" | "disconnected" | "output" | "sessionClosed" | "cwdChange" | "processChange" | "procLine" | "procExit";
type ProcStartOptions = { bin: string; args?: string[]; cwd?: string | null; env?: NodeJS.ProcessEnv };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOCKET_DIR = PATHS.ROOT;
const SOCKET_PATH = process.platform === "win32"
  ? "\\\\.\\pipe\\9remote-pty"
  : path.join(SOCKET_DIR, "pty-daemon.sock");

const DAEMON_SCRIPT_SOURCE = path.join(__dirname, "ptyDaemon.js");
const DAEMON_SCRIPT_DIST = path.join(__dirname, "ptyDaemon.cjs");

// Local modules copied to runtime dir so dev-mode daemon imports resolve.
const DAEMON_LOCAL_MODULES = ["constants.js", "bufferSlice.js", "daemonRouter.js", "daemonRoutes.js", "daemonKv.js"];

// Run from runtime copy to avoid locking node_modules on Windows during upgrades.
const DAEMON_RUNTIME_DIR = path.join(SOCKET_DIR, "daemon");

function getCliVersion(): string {
  if (typeof __CLI_VERSION__ !== "undefined") return __CLI_VERSION__;
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "unknown";
  }
}

// Hand-rolled recursive copy for Node 14 compatibility.
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function findPackageDir(startDir: string, pkg: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const findNodePtyDir = (startDir: string): string | null => findPackageDir(startDir, "node-pty");

// Clean older daemon version folders when daemon is not alive.
function cleanupOldDaemonVersions(currentVersion: string): void {
  try {
    if (!fs.existsSync(DAEMON_RUNTIME_DIR)) return;
    const pidFile = path.join(SOCKET_DIR, "pids", "ptyDaemon.pid");
    let alive = false;
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch {}
      }
    } catch {}
    if (alive) return;
    for (const name of fs.readdirSync(DAEMON_RUNTIME_DIR)) {
      if (name === `v${currentVersion}`) continue;
      try { fs.rmSync(path.join(DAEMON_RUNTIME_DIR, name), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function prepareDaemonCopy(sourceScript: string): { script: string; cwd: string } | null {
  cleanupOldDaemonVersions(DAEMON_VERSION);
  const runtimeDir = path.join(DAEMON_RUNTIME_DIR, `v${DAEMON_VERSION}`);

  // Dev mode mirrors relative paths for local imports; bundled .cjs stays flat.
  const isDev = sourceScript.endsWith(".js");
  const scriptDir = isDev ? path.join(runtimeDir, "features", "terminal") : runtimeDir;
  const copiedScript = path.join(scriptDir, path.basename(sourceScript));
  const copiedPtyDir = path.join(scriptDir, "node_modules", "node-pty");

  const copiedModules = () => DAEMON_LOCAL_MODULES.map((n) => path.join(scriptDir, n));
  const isPrepared = () => !isDev
    ? fs.existsSync(copiedScript) && fs.existsSync(copiedPtyDir)
    : fs.existsSync(copiedScript) && fs.existsSync(copiedPtyDir) && copiedModules().every((p) => fs.existsSync(p));
  if (isPrepared()) {
    return { script: copiedScript, cwd: scriptDir };
  }

  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.copyFileSync(sourceScript, copiedScript);

    // Dev mode: copy only allowlisted local modules preserving layout.
    if (isDev) {
      const srcDir = path.dirname(sourceScript);
      for (const name of DAEMON_LOCAL_MODULES) {
        fs.copyFileSync(path.join(srcDir, name), path.join(scriptDir, name));
      }
      const libDest = path.join(runtimeDir, "lib");
      fs.mkdirSync(libDest, { recursive: true });
      fs.copyFileSync(path.resolve(srcDir, "..", "..", "lib", "constants.js"), path.join(libDest, "constants.js"));
    }

    const ptyDir = findNodePtyDir(path.dirname(sourceScript));
    if (!ptyDir) return null;
    copyDirSync(ptyDir, copiedPtyDir);

    return { script: copiedScript, cwd: scriptDir };
  } catch {
    return null;
  }
}

let client: net.Socket | null = null;
let connected = false;
let messageBuffer = "";
let requestId = 0;
const pendingRequests = new Map<number, PendingRequest>();
const eventHandlers = new Map<string, Array<(data: unknown) => void>>();

function nextRequestId() {
  return ++requestId;
}

export function on(event: string, handler: (data: unknown) => void): void {
  if (!eventHandlers.has(event)) {
    eventHandlers.set(event, []);
  }
  eventHandlers.get(event)?.push(handler);
}

export function off(event: string, handler: (data: unknown) => void): void {
  const handlers = eventHandlers.get(event);
  if (handlers) {
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }
}

function emit(event: string, data?: unknown): void {
  const handlers = eventHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (e) {
        console.error(`[DaemonClient] Error in ${event} handler:`, e);
      }
    }
  }
}

function send(message: DaemonRequest): boolean {
  if (!client || !connected) {
    return false;
  }
  try {
    client.write(JSON.stringify(message) + "\n");
    return true;
  } catch (e) {
    console.error("[DaemonClient] Send error:", e);
    return false;
  }
}

function request<T = Record<string, unknown>>(message: DaemonRequest, timeout = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextRequestId();
    message.requestId = id;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Request timeout"));
    }, timeout);

    pendingRequests.set(id, { resolve: (value) => resolve(value as T), reject, timer });

    if (!send(message)) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new Error("Not connected to daemon"));
    }
  });
}

function handleMessage(message: DaemonResponseMessage): void {
  const { type, requestId: reqId, ...data } = message;

  if (reqId && pendingRequests.has(reqId)) {
    const pending = pendingRequests.get(reqId);
    if (!pending) return;
    const { resolve, timer } = pending;
    clearTimeout(timer);
    pendingRequests.delete(reqId);
    resolve({ type, ...data });
    return;
  }

  switch (type) {
    case "output":
      // Pass base64 untouched when enc="b64" to avoid re-encoding over socket.io.
      emit("output", {
        sessionId: data.sessionId,
        enc: data.enc,
        // replay:true marks join-replay packets for alt-screen mode sequencing.
        replay: data.replay === true,
        data: data.enc === "b64" ? data.data : Buffer.from(data.data as string, "base64")
      });
      break;

    case "sessionClosed":
      emit("sessionClosed", data.sessionId);
      break;

    case "cwdChange":
      emit("cwdChange", { sessionId: data.sessionId, cwd: data.cwd });
      break;

    case "processChange":
      emit("processChange", {
        sessionId: data.sessionId,
        process: data.process,
        prevProcess: data.prevProcess
      });
      break;

    case "procLine":
      emit("procLine", {
        procId: data.procId,
        epoch: data.epoch,
        n: data.n,
        data: Buffer.from(data.data as string, "base64").toString("utf8")
      });
      break;

    case "procExit":
      emit("procExit", { procId: data.procId, epoch: data.epoch, code: data.code, signal: data.signal, error: data.error });
      break;

    case "error":
      console.error("[DaemonClient] ❌", data.error || "Daemon error");
      break;

    case "pong":
      break;

    default:
      console.log("[DaemonClient] Unknown message:", type);
  }
}

function isDaemonRunning(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const testClient = net.connect(SOCKET_PATH);
    const timeout = setTimeout(() => {
      testClient.destroy();
      resolve(false);
    }, 1000);

    testClient.on("connect", () => {
      clearTimeout(timeout);
      testClient.destroy();
      resolve(true);
    });

    testClient.on("error", () => {
      clearTimeout(timeout);
      if (process.platform !== "win32" && fs.existsSync(SOCKET_PATH)) {
        try {
          fs.unlinkSync(SOCKET_PATH);
        } catch (e) {
        }
      }
      resolve(false);
    });
  });
}

function getDaemonScript(): { script: string; cwd: string } | null {
  if (!fs.existsSync(SOCKET_DIR)) {
    fs.mkdirSync(SOCKET_DIR, { recursive: true });
  }

  const sourceScript = fs.existsSync(DAEMON_SCRIPT_SOURCE)
    ? DAEMON_SCRIPT_SOURCE
    : (fs.existsSync(DAEMON_SCRIPT_DIST) ? DAEMON_SCRIPT_DIST : null);

  if (!sourceScript) {
    console.error("[DaemonClient] ❌ Daemon script not found");
    return null;
  }

  const copy = prepareDaemonCopy(sourceScript);
  if (copy) return copy;

  return { script: sourceScript, cwd: __dirname };
}

async function startDaemon(): Promise<boolean> {
  if (!fs.existsSync(SOCKET_DIR)) {
    try {
      fs.mkdirSync(SOCKET_DIR, { recursive: true });
    } catch (e) {
      console.error("[DaemonClient] Failed to create socket directory:", errorMessage(e));
      return false;
    }
  }

  const daemonInfo = getDaemonScript();
  if (!daemonInfo) {
    return false;
  }

  const { script, cwd } = daemonInfo;

  const logDir = path.join(SOCKET_DIR, "logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logPath = path.join(logDir, "daemon.log");
  let logFd: number | "ignore";

  try {
    logFd = fs.openSync(logPath, "w");
  } catch (e) {
    console.error("[DaemonClient] Failed to open log file:", errorMessage(e));
    logFd = "ignore";
  }

  const daemon = spawn(NODE_BIN, [script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: cwd,
    env: nodeSpawnEnv(),
  });

  daemon.unref();

  if (typeof logFd === "number") {
    try {
      fs.closeSync(logFd);
    } catch (e) {
    }
  }

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await isDaemonRunning()) {
      return true;
    }
  }

  console.error("[DaemonClient] ❌ Failed to start daemon");
  try {
    const log = fs.readFileSync(logPath, "utf8");
    if (log.trim()) {
      console.error("[DaemonClient] Daemon log:");
      console.error(log);
    }
  } catch (e) {
  }
  return false;
}

// Probe running daemon version over a throwaway socket.
function probeDaemonVersion(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const probe = net.connect(SOCKET_PATH);
    let buf = "";
    const done = (v: string | null) => { try { probe.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(null), 2000);
    probe.on("connect", () => probe.write(JSON.stringify({ type: "ping", requestId: -1 }) + "\n"));
    probe.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        const msg: { version?: string } = JSON.parse(buf.slice(0, nl));
        done(msg.version || "unknown");
      }
      catch { done(null); }
    });
    probe.on("error", () => { clearTimeout(timer); done(null); });
  });
}

async function killStaleDaemon(): Promise<void> {
  try {
    const pidFile = path.join(SOCKET_DIR, "pids", "ptyDaemon.pid");
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 20; i++) {
    if (!(await isDaemonRunning())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Shared in-flight connect promise to avoid duplicate concurrent connections.
let connectingPromise: Promise<boolean> | null = null;

async function connectToDaemon(): Promise<boolean> {
  if (connected) return true;
  if (connectingPromise) return connectingPromise;
  connectingPromise = _connectToDaemon().finally(() => { connectingPromise = null; });
  return connectingPromise;
}

async function _connectToDaemon(): Promise<boolean> {
  if (connected) return true;

  try {
    if (await isDaemonRunning()) {
      const v = await probeDaemonVersion();
      if (v !== DAEMON_VERSION) {
        console.log(`[DaemonClient] Daemon v${v} != v${DAEMON_VERSION}, restarting`);
        await killStaleDaemon();
      }
    }
    if (!(await isDaemonRunning())) {
      if (!(await startDaemon())) {
        console.error("[DaemonClient] ❌ Failed to start daemon");
        return false;
      }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error("[DaemonClient] ❌ Connection timeout after 5s");
        if (client) client.destroy();
        resolve(false);
      }, 5000);

      client = net.connect(SOCKET_PATH);

      client.on("connect", () => {
        clearTimeout(timeout);
        connected = true;
        emit("connected");
        resolve(true);
      });

      client.on("data", (chunk) => {
        messageBuffer += chunk.toString();
        const lines = messageBuffer.split("\n");
        messageBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
      handleMessage(JSON.parse(line) as DaemonResponseMessage);
            } catch (e) {
              console.error("[DaemonClient] Invalid message:", line);
            }
          }
        }
      });

      client.on("close", () => {
        connected = false;
        client = null;
        emit("disconnected");

        setTimeout(() => {
          if (!connected) connectToDaemon();
        }, 2000);
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        console.error("[DaemonClient] ❌ Connection error:", err.message);
        console.error("[DaemonClient] Error code:", "code" in err ? err.code : undefined);
        resolve(false);
      });
    });
  } catch (e) {
    console.error("[DaemonClient] ❌ Connect error:", e);
    return false;
  }
}

export async function initDaemonClient(): Promise<boolean> {
  return connectToDaemon();
}

// Daemon per-process KV for agent session state.
export async function kvSet(key: string, value: unknown): Promise<Record<string, unknown>> {
  return await call("kv.set", { key, value });
}

export async function kvGet(key: string): Promise<unknown | null> {
  const result = await call<{ value?: unknown }>("kv.get", { key });
  return result?.value ?? null;
}

export async function kvDel(key: string): Promise<Record<string, unknown>> {
  return await call("kv.del", { key });
}

export function isConnected(): boolean {
  return connected;
}

export async function listSessions(): Promise<DaemonSessionSummary[]> {
  const result = await call<DaemonSessionList>("terminal.listSessions");
  return result.sessions || [];
}

export async function createSession(name: string | undefined, cols = 80, rows = 24, shellId: string | null = null, sessionId = `session-${Date.now()}`, cwd: string | null = null): Promise<DaemonCreateSessionResult> {
  const result = await call<DaemonCreateSessionResult>("terminal.createSession", { sessionId, name, cols, rows, shellId, cwd });
  return result;
}

export async function getSessionCwd(sessionId: string): Promise<string | null> {
  try {
    const result = await call<{ cwd: string | null }>("terminal.getCwd", { sessionId });
    return result.cwd || null;
  } catch {
    return null;
  }
}

export async function joinSession(sessionId: string): Promise<DaemonJoinSessionResult> {
  const result = await call<DaemonJoinSessionResult>("terminal.joinSession", { sessionId });
  return result;
}

// Fetch older-than-tail prefix when web scrolls to top.
export async function requestHistory(sessionId: string | undefined, have: number): Promise<DaemonHistoryResult> {
  const result = await call<DaemonHistoryResult>("terminal.requestHistory", { sessionId, have });
  return result;
}

export function call<T = Record<string, unknown>>(type: string, args: Record<string, unknown> = {}, timeout?: number): Promise<T> {
  return request({ type, ...args }, timeout);
}

function post(type: string, args: Record<string, unknown> = {}): boolean {
  return send({ type, ...args });
}

export function sendInput(sessionId: string, data: string): boolean {
  return post("terminal.input", { sessionId, data });
}

export function resizeSession(sessionId: string, cols: number, rows: number): boolean {
  return post("terminal.resize", { sessionId, cols, rows });
}

// Managed child processes owned by daemon to survive agent restarts.
// On Windows npm-installed CLIs are .cmd shims a bare spawn cannot exec — rewrite
// to a cmd.exe invocation with safely escaped args HERE (one door, before the wire),
// so the daemon's plain spawn keeps working. POSIX passes through untouched.
// windowsVerbatimArguments must ride along: parse() pre-escapes for cmd.exe, and a
// plain spawn would re-quote the escaped string into garbage.
export function procStart(procId: string, { bin, args = [], cwd, env }: ProcStartOptions): Promise<DaemonProcResult> {
  let windowsVerbatimArguments;
  if (process.platform === "win32") {
    const parsed = crossSpawnParse(bin, args, { env: env || process.env });
    bin = parsed.command;
    args = parsed.args;
    windowsVerbatimArguments = parsed.options.windowsVerbatimArguments === true || undefined;
  }
  return call("proc.start", { procId, bin, args, cwd, env, windowsVerbatimArguments });
}

export function procAttach(procId: string, from = 0): Promise<DaemonProcAttachResult> {
  return call("proc.attach", { procId, from });
}

export function procLines(procId: string, from = 0): Promise<DaemonProcLinesResult> {
  return call("proc.lines", { procId, from });
}

export function procWrite(procId: string, data: string, enc: "b64" | "utf8" = "b64"): Promise<DaemonProcResult> {
  return call("proc.write", { procId, data, enc });
}

export function procEndInput(procId: string): Promise<DaemonProcResult> {
  return call("proc.endInput", { procId });
}

export function procSignal(procId: string, signal = "SIGINT"): Promise<DaemonProcResult> {
  return call("proc.signal", { procId, signal });
}

export function procStop(procId: string): Promise<DaemonProcResult> {
  return call("proc.stop", { procId });
}

export async function procList(): Promise<DaemonProcInfo[]> {
  const result = await call<DaemonProcListResult>("proc.list");
  return result.procs || [];
}

export async function deleteSession(sessionId: string): Promise<DaemonProcResult> {
  const result = await call<DaemonProcResult>("terminal.deleteSession", { sessionId });
  return result;
}
