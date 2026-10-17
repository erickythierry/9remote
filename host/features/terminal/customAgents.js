import fs from "fs";
import path from "path";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("customAgents");
const FILE = path.join(PATHS.CONFIG, "customAgents.json");

// User-defined launchers that borrow a catalog agent's behaviour (resume, rename, hooks,
// chat UI). The id is "<base>+<slug>" so every consumer can recover the base engine from
// the id alone, with no lookup.
export const CUSTOM_SEP = "+";
export const CUSTOM_LABEL_MAX = 40;
export const CUSTOM_CMD_MAX = 512;
const SLUG_MAX = 32;
// The command is typed into a shell, so a line break would start a second command.
const CMD_FORBIDDEN_RE = /[\0\r\n]/;

const stripUi = (agentId) => (agentId?.endsWith("-ui") ? agentId.slice(0, -3) : agentId);

/** The agent id without its chat-UI suffix: what the terminal surface is running. */
export const surfaceAgent = stripUi;

/** The catalog engine an agent id stands on ("claude+9r-ui" → "claude"). */
export function baseOfAgentId(agentId) {
  const surface = stripUi(agentId);
  const at = surface?.indexOf(CUSTOM_SEP) ?? -1;
  return at === -1 ? surface : surface.slice(0, at);
}

const isCustomId = (agentId) => !!agentId && stripUi(agentId).includes(CUSTOM_SEP);

/** True when `detected` is only the base CLI that a custom launcher runs underneath. */
export function agentOverridesDetected(current, detected) {
  return isCustomId(current) && stripUi(current) !== detected && baseOfAgentId(current) === detected;
}

const valid = (a) => a && typeof a.id === "string" && isCustomId(a.id) && typeof a.label === "string" && typeof a.cmd === "string";

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(list) ? list.filter(valid) : [];
  } catch {
    return [];
  }
}

let agents = load();

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(agents, null, 2), "utf8");
}

export const customAgentList = () => agents;

export function customAgentById(agentId) {
  const surface = stripUi(agentId);
  return agents.find((a) => a.id === surface) || null;
}

const binToken = (cmd) => cmd.trim().split(/\s+/)[0].split("/").pop().replace(/\.(exe|cmd|bat|ps1)$/i, "");

/** The custom agent a typed launch token belongs to, or null. */
export function customIdByBin(token) {
  return agents.find((a) => binToken(a.cmd) === token)?.id || null;
}

// shortcut: whitespace split, no quote parsing; upgrade when a command needs quoted args.
export function splitCommand(cmd) {
  const [bin, ...args] = cmd.trim().split(/\s+/);
  return { bin, args };
}

const slugOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX) || "agent";

/** Validates and stores a launcher. `base` must already be checked against the catalog. */
export function addCustomAgent({ label, base, cmd }) {
  const cleanLabel = String(label || "").trim();
  const cleanCmd = String(cmd || "").trim();
  if (!cleanLabel || cleanLabel.length > CUSTOM_LABEL_MAX) return { error: "Invalid name" };
  if (!cleanCmd || cleanCmd.length > CUSTOM_CMD_MAX || CMD_FORBIDDEN_RE.test(cleanCmd)) return { error: "Invalid command" };
  const slug = slugOf(cleanLabel);
  let id = `${base}${CUSTOM_SEP}${slug}`;
  for (let n = 2; agents.some((a) => a.id === id); n++) id = `${base}${CUSTOM_SEP}${slug}-${n}`;
  const agent = { id, base, label: cleanLabel, cmd: cleanCmd };
  agents = [...agents, agent];
  try {
    persist();
  } catch (e) {
    agents = agents.filter((a) => a !== agent);
    logger.warn(`persist failed: ${e.message}`);
    return { error: "Could not save" };
  }
  return { agent };
}

export function removeCustomAgent(agentId) {
  const next = agents.filter((a) => a.id !== agentId);
  if (next.length === agents.length) return false;
  agents = next;
  persist();
  return true;
}
