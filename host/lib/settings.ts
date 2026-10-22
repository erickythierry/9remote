// Persisted boolean toggles (desktopEnabled, autoApprove, ...) in one file.
import fs from "fs";
import path from "path";
import { PATHS } from "./constants.js";
import { writeJsonAtomic } from "./atomicFile.js";

const FILE = path.join(PATHS.CONFIG, "settings.json");
type Settings = {
  desktopEnabled?: boolean;
  autoApprove?: boolean;
  artifactEnabled?: boolean;
  voiceConfig?: { openrouterKey?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

function ensureDir() {
  if (!fs.existsSync(PATHS.CONFIG)) fs.mkdirSync(PATHS.CONFIG, { recursive: true });
}

export function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Settings || {}; } catch { return {}; }
}

export function writeSettings(patch: Partial<Settings>): Settings | null {
  try {
    ensureDir();
    const next = { ...readSettings(), ...patch };
    writeJsonAtomic(FILE, next);
    return next;
  } catch { return null; }
}
