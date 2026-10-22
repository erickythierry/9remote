// How each past conversation was last opened: the chat UI ("ui") or the agent CLI
// in a terminal ("terminal"). Keyed by "<agent>:<conversationId>" rather than by
// session, so the answer outlives the terminal that held it and a history row can
// reopen the conversation the same way it was left.
import fs from "fs";
import path from "path";
import { PATHS } from "../../lib/constants.js";
import { createLogger } from "../../lib/logger.js";
import { baseOfAgentId } from "./customAgents.js";

const logger = createLogger("conversationModes");
const MODES_FILE = path.join(PATHS.STATE, "conversationModes.json");

export const MODE = Object.freeze({ UI: "ui", TERMINAL: "terminal" });
export type ConversationMode = typeof MODE[keyof typeof MODE];

let modes = load();

function load() {
  try {
    return (JSON.parse(fs.readFileSync(MODES_FILE, "utf8")) as Record<string, ConversationMode>) || {};
  } catch {
    return {};
  }
}

// A custom launcher shares its base engine's history, so its conversations key under the base.
const keyOf = (agentId: string, conversationId: string) => `${baseOfAgentId(agentId)}:${conversationId}`;

// The UI runs the base engine's CLI underneath, so it is not a mode of its own.
export const modeFromAgent = (agentId: string | null | undefined): ConversationMode => (agentId?.endsWith("-ui") ? MODE.UI : MODE.TERMINAL);
export const engineFromAgent = (agentId: string | null | undefined): string | null | undefined => baseOfAgentId(agentId);

export function getConversationMode(agentId: string | null | undefined, conversationId: string | null | undefined): ConversationMode | null {
  if (!agentId || !conversationId) return null;
  return modes[keyOf(engineFromAgent(agentId)!, conversationId)] || null;
}

export function setConversationMode(agentId: string | null | undefined, conversationId: string | null | undefined, mode: ConversationMode | null | undefined): void {
  if (!agentId || !conversationId || !mode) return;
  const key = keyOf(engineFromAgent(agentId)!, conversationId);
  if (modes[key] === mode) return;
  modes[key] = mode;
  try {
    fs.mkdirSync(path.dirname(MODES_FILE), { recursive: true });
    fs.writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2), "utf8");
  } catch (error) {
    logger.warn(`persist failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
