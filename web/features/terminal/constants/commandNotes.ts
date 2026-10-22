/**
 * Command Notes Constants
 */

export interface CommandNoteItem {
  command: string;
}

export interface CommandNotesConfig {
  storageKey: string;
  maxNotes: number;
}

export const COMMAND_NOTES_CONFIG: CommandNotesConfig = {
  storageKey: "9remote_command_notes_v2",
  maxNotes: 50
};

// Default popular commands (created if localStorage is empty)
export const DEFAULT_COMMAND_NOTES: CommandNoteItem[] = [
  { command: "npm i 9router -g" },
  { command: "curl -fsSL https://claude.ai/install.sh | bash" },
  { command: "npm i -g @openai/codex" },
  { command: "curl -fsSL https://opencode.ai/install | bash" },
];
