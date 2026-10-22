"use client";

import { ChevronRight, Folder, Pencil, Plus, Trash2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import IconMenu from "@/shared/components/ui/IconMenu";
import { useWorkspaceGit } from "../hooks/useWorkspaceGit";
import { workspaceGitPath } from "../lib/workspaceGrouping";
import { isDefaultBranch } from "../constants/terminalConfig";
import BranchBadge from "./BranchBadge";

// Hidden until the row is hovered on pointer devices; dimmed but visible on touch.
// The row must carry the plain `group` class for this to fire. Shared by the
// sidebar's trees — the main host's and every other host's.
export const REVEAL_CLS = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60 transition-opacity";

export interface WorkspaceHeaderProps {
  workspace: any;
  isActive?: boolean;
  connected?: boolean;
  collapsed?: boolean;
  fileBus?: any;
  onToggleCollapse?: () => void;
  onSelect?: () => void;
  onNewTerminal?: () => void;
  onDelete?: () => void;
  onRename?: () => void;
  onAddWorkspace?: (() => void) | null;
  mobile?: boolean;
}

// One workspace folder row: chevron + folder + name (+ off-default branch badge)
// and the new-terminal / rename / delete actions a caller wires. Null callbacks
// hide their action, so a read-only tree (another host's) renders the same shape.
export default function WorkspaceHeader({
  workspace, isActive, connected, collapsed, fileBus,
  onToggleCollapse, onSelect, onNewTerminal, onDelete, onRename,
  onAddWorkspace = null,
  mobile = false
}: WorkspaceHeaderProps) {
  const { t } = useI18n();
  const gitPath = workspaceGitPath(workspace);
  // No fileBus (another host's tree) must NOT fall back to the main host's bus —
  // that would scan this workspace's path on the wrong machine.
  const { branch, dirty } = useWorkspaceGit(gitPath, fileBus, { enabled: !!fileBus });

  // No select door (mobile session list): the row itself toggles the group, not just the chevron.
  const rowClick = onSelect || (onToggleCollapse ? () => { vibrate(); onToggleCollapse(); } : undefined);

  return (
    <div
      onClick={rowClick}
      className={`group flex items-center justify-between px-2 py-1.5 rounded-[4px] cursor-pointer ${
        isActive ? "bg-surface-2 text-text font-medium" : "text-text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {onToggleCollapse && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); vibrate(); onToggleCollapse(); }}
            className="p-0.5 text-text-muted hover:text-text rounded"
          >
            <ChevronRight size={14} className={`transform transition-transform ${collapsed ? "" : "rotate-90"}`} />
          </button>
        )}
        <Folder size={14} className="shrink-0 text-text-muted" />
        <span className="truncate text-xs">{workspace?.name || t("workspaces.unnamed")}</span>
        {branch && !isDefaultBranch(branch) && (
          <BranchBadge branch={branch} dirty={dirty} className="shrink-0 text-[10px]" />
        )}
      </div>

      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <IconMenu
          size={mobile ? 18 : 13.5}
          label={t("sessions.sessionActions")}
          revealCls=""
          items={[
            onNewTerminal && connected && {
              icon: Plus, label: t("terminal.newTerminal"),
              onClick: () => onNewTerminal()
            },
            onAddWorkspace && connected && {
              icon: Folder, label: t("workspaces.newWorkspace"),
              onClick: () => onAddWorkspace?.()
            },
            onRename && {
              icon: Pencil, label: t("workspaces.rename"),
              onClick: () => onRename()
            },
            onDelete && connected && {
              icon: Trash2, label: t("workspaces.delete"), danger: true,
              onClick: () => onDelete()
            }
          ]}
        />
      </div>
    </div>
  );
}
