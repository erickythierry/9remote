// '/' menu assembly: host commands first, then live engine commands (opencode's
// GET /command feed, omp's available_commands_update), then skills — one entry
// per name with first-wins dedupe, lowercase substring filter on the name.

export interface SlashItem {
  name: string;
  description: string;
  isCommand?: boolean;
  isSkill?: boolean;
  [key: string]: any;
}

export function buildSlashItems({
  staticCommands = [],
  liveCommands = [],
  skills = [],
  filter = ""
}: {
  staticCommands?: any[];
  liveCommands?: any[];
  skills?: any[];
  filter?: string;
} = {}): SlashItem[] {
  const live = (liveCommands || []).map((c: any) => ({
    name: `/${c.name}`,
    description: c.description || "",
    isCommand: true
  }));
  const skillCmds = (skills || []).map((s: any) => ({
    name: `/${s.name || s.id}`,
    description: s.description || `Skill: ${s.name || s.id}`,
    isSkill: true
  }));
  const seen = new Set<string>();
  const needle = String(filter || "").toLowerCase();
  return [...(staticCommands || []), ...live, ...skillCmds].filter((cmd: any) => {
    if (seen.has(cmd.name) || !cmd.name.toLowerCase().includes(needle)) return false;
    seen.add(cmd.name);
    return true;
  });
}
