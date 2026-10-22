import { spawn, spawnSync, execFile, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { EMULATOR, EMULATOR_ARGS, EMULATOR_ARGS_LOW_POWER, GPU_HOST_ARGS, QEMU_MEMORY_ARGS, ADB_TIMEOUTS, IDLE_SHUTDOWN_MS, IDLE_CHECK_MS, SDK_SETUP } from "./constants.js";
import { connectionCount } from "../../api/ui.js";
import { PATHS } from "../../lib/constants.js";
import { findAdb, listDevices, listDevicesAsync, listSerials, listSerialsAsync } from "./adb.js";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../lib/errorMessage.js";

const logger = createLogger("mobile");

class BootError extends Error {
  constructor(message: string, readonly gpuRejected: boolean) { super(message); }
}

let cachedEmulator: string | null | undefined;
let probedAt = 0;
const running = new Map<string, ChildProcess>();

export function sdkRoots(): string[] {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, "Library/Android/sdk"),
    path.join(home, "Android/Sdk"),
    path.join(home, "AppData/Local/Android/Sdk")
  ].filter((r): r is string => Boolean(r));
}

export function findEmulator(): string | null {
  if (cachedEmulator !== undefined && (cachedEmulator || Date.now() - probedAt < SDK_SETUP.reprobeMs)) return cachedEmulator;
  probedAt = Date.now();
  const exe = process.platform === "win32" ? "emulator.exe" : "emulator";
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["emulator"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split("\n")[0]?.trim();
    if (first) { cachedEmulator = first; return cachedEmulator; }
  }
  cachedEmulator = sdkRoots().map((r) => path.join(r, "emulator", exe)).find((p) => fs.existsSync(p)) || null;
  return cachedEmulator;
}

export function resetEmulatorCache(): void {
  cachedEmulator = undefined;
  probedAt = 0;
}

function avdRamSizeMb(avdName: string): number | null {
  for (const root of [process.env.ANDROID_AVD_HOME, path.join(os.homedir(), ".android", "avd")].filter((r): r is string => Boolean(r))) {
    const ini = path.join(root, `${avdName}.avd`, "config.ini");
    if (!fs.existsSync(ini)) continue;
    const m = fs.readFileSync(ini, "utf8").match(/^hw\.ramSize\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  }
  return null;
}

export function canManageEmulators(): boolean {
  return Boolean(findEmulator());
}

function parseAvdList(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter((l) => l && !l.includes(" "));
}

export function listAvds(): string[] {
  const bin = findEmulator();
  if (!bin) return [];
  const r = spawnSync(bin, ["-list-avds"], { encoding: "utf8", timeout: ADB_TIMEOUTS.command });
  if (r.status !== 0) return [];
  return parseAvdList(r.stdout);
}

export async function listAvdsAsync(): Promise<string[]> {
  const bin = findEmulator();
  if (!bin) return [];
  try {
    const { stdout } = await execFileAsync(bin, ["-list-avds"], { timeout: ADB_TIMEOUTS.command });
    return parseAvdList(stdout);
  } catch { return []; }
}

function avdNameOf(serial: string): string | null {
  const adb = findAdb();
  if (!adb) return null;
  const r = spawnSync(adb, ["-s", serial, "emu", "avd", "name"], { encoding: "utf8", timeout: 3000 });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK") || null;
}

export async function avdNameOfAsync(serial: string): Promise<string | null> {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const { stdout } = await execFileAsync(adb, ["-s", serial, "emu", "avd", "name"], { timeout: 3000 });
    return stdout.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK") || null;
  } catch { return null; }
}

export async function listAll(): Promise<Array<Record<string, unknown>>> {
  const online = await listDevicesAsync();
  const bySerial = new Map();
  for (const d of online) {
    bySerial.set(d.serial, { ...d, avdName: d.isEmulator ? await avdNameOfAsync(d.serial) : null });
  }

  const out = [];
  const claimed = new Set();
  for (const avd of await listAvdsAsync()) {
    const live = [...bySerial.values()].find((d) => d.avdName === avd);
    if (live) claimed.add(live.serial);
    out.push({
      id: `avd:${avd}`,
      avdName: avd,
      name: avd.replace(/_/g, " "),
      serial: live?.serial ?? null,
      state: live ? "running" : (starting.has(avd) ? "starting" : "stopped"),
      kind: "emulator",
      canStop: Boolean(live)
    });
  }

  for (const [serial, d] of bySerial) {
    if (claimed.has(serial)) continue;
    out.push({
      id: `dev:${serial}`,
      avdName: d.avdName,
      name: d.name || serial,
      serial,
      state: "running",
      kind: d.isEmulator ? "emulator" : "physical",
      canStop: false
    });
  }
  return out;
}

const starting = new Set<string>();

export function isStarting(avdName: string): boolean {
  return starting.has(avdName);
}

export async function isHostStarted(serial: string | null | undefined): Promise<boolean> {
  if (!serial?.startsWith("emulator-")) return false;
  const owned = readOwned();
  if (owned.size === 0) return false;
  const avdName = await avdNameOfAsync(serial);
  return Boolean(avdName && owned.has(avdName));
}

export const isAgentStarted = isHostStarted;

async function bootedSerialFor(avdName: string): Promise<string | null> {
  for (const d of await listSerialsAsync()) {
    if (d.serial.startsWith("emulator-") && await avdNameOfAsync(d.serial) === avdName) return d.serial;
  }
  return null;
}

async function isBootCompleted(serial: string): Promise<boolean> {
  const adb = findAdb();
  if (!adb) return false;
  try {
    const { stdout } = await execFileAsync(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 4000 });
    return stdout.trim() === "1";
  } catch { return false; }
}

export async function startAvd(avdName: string, onProgress?: (phase: string) => void, opts: { lowPower?: boolean } = {}): Promise<string> {
  const bin = findEmulator();
  if (!bin) throw new Error("Android emulator binary not found");
  if (!listAvds().includes(avdName)) throw new Error(`Unknown AVD: ${avdName}`);

  const existing = await bootedSerialFor(avdName);
  if (existing) return existing;
  if (starting.has(avdName)) throw new Error("Already starting");

  starting.add(avdName);
  try {
    // Try -gpu host first; fall back to default if unsupported.
    try {
      return await bootOnce(bin, avdName, onProgress, opts, GPU_HOST_ARGS);
    } catch (err) {
      if (!(err instanceof BootError) || !err.gpuRejected || gpuHostUnsupported.has(bin)) throw err;
      gpuHostUnsupported.add(bin);
      logger.warn(`📱 -gpu host rejected (${err.message}); retrying with the emulator's default`);
      return await bootOnce(bin, avdName, onProgress, opts, []);
    }
  } finally {
    starting.delete(avdName);
  }
}

const gpuHostUnsupported = new Set<string>();

const OWNED_FILE = path.join(PATHS.STATE, "mobileOwnedAvds.json");

function readOwned(): Set<string> {
  try { return new Set(JSON.parse(fs.readFileSync(OWNED_FILE, "utf8"))); }
  catch { return new Set(); }
}

function writeOwned(names: Set<string>): void {
  try {
    fs.mkdirSync(PATHS.STATE, { recursive: true });
    fs.writeFileSync(OWNED_FILE, JSON.stringify([...names]));
  } catch {}
}

function markOwned(avdName: string): void {
  const owned = readOwned();
  if (owned.has(avdName)) return;
  owned.add(avdName);
  writeOwned(owned);
}

function unmarkOwned(avdName: string): void {
  const owned = readOwned();
  if (!owned.delete(avdName)) return;
  writeOwned(owned);
}

let idleSince: number | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

function stopIdleWatch(): void {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  idleSince = null;
}

async function checkIdle(): Promise<void> {
  const owned = readOwned();
  if (owned.size === 0) { stopIdleWatch(); return; }
  if (connectionCount() > 0) { idleSince = null; return; }
  if (idleSince === null) { idleSince = Date.now(); return; }
  if (Date.now() - idleSince < IDLE_SHUTDOWN_MS) return;

  const minutes = Math.round(IDLE_SHUTDOWN_MS / 60000);
  for (const avdName of owned) {
    const serial = await bootedSerialFor(avdName);
    if (!serial) { unmarkOwned(avdName); running.delete(avdName); continue; }
    logger.info(`📱 No client for ${minutes} min — stopping ${avdName}`);
    try { await stopAvd(serial); } catch (e) { logger.warn(`idle stop failed: ${errorMessage(e)}`); }
  }
  stopIdleWatch();
}

function startIdleWatch(): void {
  if (idleTimer) return;
  idleSince = null;
  idleTimer = setInterval(() => { checkIdle(); }, IDLE_CHECK_MS);
  idleTimer.unref?.();
}

if (readOwned().size > 0) startIdleWatch();

async function bootOnce(bin: string, avdName: string, onProgress: ((phase: string) => void) | undefined, opts: { lowPower?: boolean }, gpuArgs: string[]): Promise<string> {
  onProgress?.("launching");
  const args = opts.lowPower ? EMULATOR_ARGS_LOW_POWER : EMULATOR_ARGS;
  const gpu = gpuHostUnsupported.has(bin) ? [] : gpuArgs;
  // -qemu must come last: arguments after it are passed to QEMU directly.
  const memArgs = QEMU_MEMORY_ARGS(avdRamSizeMb(avdName) ?? NaN);
  const child = spawn(bin, ["-avd", avdName, ...args, ...gpu, ...memArgs], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.unref();
  running.set(avdName, child);

  // Emulator logs GPU/driver info to stderr on healthy boot; only non-zero exit is failure.
  let stderrTail = "";
  let exitError = null;
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-400); });
  child.on("exit", (code) => {
    running.delete(avdName);
    if (code !== 0) {
      const hint = stderrTail.split("\n").filter((l) => /error|failed|cannot/i.test(l)).pop();
      exitError = hint?.trim().slice(0, 200) || `emulator exited with code ${code}`;
    }
  });

  const deadline = Date.now() + EMULATOR.bootTimeoutMs;
  const launchedAt = Date.now();
  let sawSerial: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, EMULATOR.bootPollMs));
    if (exitError) {
      const failed = new BootError(exitError, gpuArgs.length > 0 && !sawSerial
        && Date.now() - launchedAt < EMULATOR.flagRejectMs);
      throw failed;
    }
    const serial: string | null = sawSerial || await bootedSerialFor(avdName);
    if (serial) {
      if (!sawSerial) { sawSerial = serial; onProgress?.("booting"); }
      if (await isBootCompleted(serial)) {
        onProgress?.("ready");
        markOwned(avdName);
        startIdleWatch();
        logger.info(`📱 AVD ${avdName} booted → ${serial}${opts.lowPower ? " (low power)" : ""}`);
        return serial;
      }
    }
  }
  throw new Error(`${avdName} did not finish booting in ${Math.round(EMULATOR.bootTimeoutMs / 1000)}s`);
}

export async function stopAvd(serial: string): Promise<boolean> {
  const adb = findAdb();
  if (!adb) throw new Error("adb not found");
  const avdName = await avdNameOfAsync(serial);
  try { await execFileAsync(adb, ["-s", serial, "emu", "kill"], { timeout: 10_000 }); } catch { /* already gone */ }

  const deadline = Date.now() + EMULATOR.shutdownTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await listSerialsAsync()).some((d) => d.serial === serial)) {
      if (avdName) { running.delete(avdName); unmarkOwned(avdName); }
      logger.info(`📱 AVD ${avdName || serial} stopped`);
      return true;
    }
  }
  const child = avdName && running.get(avdName);
  if (child) { try { process.kill(-(child.pid ?? NaN), "SIGKILL"); } catch { /* already gone */ } running.delete(avdName); }
  return !(await listSerialsAsync()).some((d) => d.serial === serial);
}
