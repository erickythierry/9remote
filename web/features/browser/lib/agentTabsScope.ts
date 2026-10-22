// Agent tabs for one workspace's strip. The host stamps each agent tab with the
// workspace of the terminal session that opened it; a tab with no known owner (agent
// run from a shell outside the app) stays visible everywhere so it is never lost.
export type AgentWorkspaceTab = {
  id: string | number;
  profile: string;
  workspaceId?: string | null;
  title?: string;
  windowId?: any;
  [key: string]: any;
};

export function agentTabsForWorkspace(
  agentTabs: AgentWorkspaceTab[] | null | undefined,
  { wsKey, profile, ownTabs }: { wsKey: string; profile: string; ownTabs: Array<{ id: string | number }> }
): AgentWorkspaceTab[] {
  if (!Array.isArray(agentTabs)) return [];
  return agentTabs.filter((t) => {
    if (t.workspaceId && t.workspaceId !== wsKey) return false;
    return !(t.profile === profile && ownTabs.some((b) => b.id === t.id));
  });
}
