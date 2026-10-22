"use client";

import { memo, type ReactNode, type RefObject, type MouseEvent, type TouchEvent, type DragEvent } from "react";
import Icon from "@/shared/components/ui/Icon";
import { GIT_STATUS_COLORS, EXPLORER_ROW, actionRightFor } from "../constants/fileExplorer";
import { resolveFileIcon, resolveFolderIcon } from "../constants/fileIcons";

const TRUNCATED_NOTE = "Showing first 300 entries — use search for the rest.";

export const metricsFor = (compact?: boolean) => (compact ? EXPLORER_ROW.compact : EXPLORER_ROW.normal);

export const indentFor = (depth: number, compact: boolean = false) => {
  const m = metricsFor(compact);
  return m.indentBase + depth * m.indentStep;
};

/** Git badge, right-aligned: an amber dot for "contains changes", the status letters otherwise. */
function GitBadge({ status }: { status?: string }) {
  if (!status) return null;
  if (status === "folder-changed") {
    return (
      <span
        className="ml-auto mr-2 w-1.5 h-1.5 rounded-full bg-git-modified shrink-0"
        title="Contains modified files"
      />
    );
  }
  const color = (GIT_STATUS_COLORS as Record<string, string>)[status] || "text-text-muted";
  return (
    <span
      className={`ml-auto mr-2 text-[10px] font-semibold font-mono shrink-0 ${color}`}
      title={
        status === "M"
          ? "Modified"
          : status === "A"
            ? "Added"
            : status === "?"
              ? "Untracked"
              : status === "D"
                ? "Deleted"
                : status
      }
    >
      {status === "?" ? "U" : status}
    </span>
  );
}

const nameColor = (status?: string) => {
  if (!status) return "";
  if (status === "folder-changed") return "text-git-modified";
  return (GIT_STATUS_COLORS as Record<string, string>)[status] || "";
};

export function TruncatedNote({ depth, compact = false }: { depth: number; compact?: boolean }) {
  return (
    <div
      className="text-[11px] text-text-muted italic py-0.5 pr-2"
      style={{ paddingLeft: indentFor(depth, compact) }}
    >
      {TRUNCATED_NOTE}
    </div>
  );
}

export interface ExplorerFileItem {
  name: string;
  path: string;
  type?: string;
  size?: number;
  sizeFormatted?: string;
  [key: string]: any;
}

export interface ExplorerRowProps {
  file: ExplorerFileItem;
  depth: number;
  isFolder?: boolean;
  isExpanded?: boolean;
  isLoading?: boolean;
  isActive?: boolean;
  isSelected?: boolean;
  isRenaming?: boolean;
  isDragOver?: boolean;
  isCut?: boolean;
  gitStatus?: string;
  renameValue?: string;
  renameInputRef?: RefObject<HTMLInputElement | null>;
  onRenameChange?: (val: string) => void;
  onRenameSubmit?: () => void;
  onRenameCancel?: () => void;
  onToggleFolder?: (file: ExplorerFileItem) => void;
  onClick?: (file: ExplorerFileItem, e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent, file: ExplorerFileItem) => void;
  onTouchStart?: (e: TouchEvent, file: ExplorerFileItem) => void;
  onTouchEnd?: () => void;
  onDragStart?: (e: DragEvent, file: ExplorerFileItem) => void;
  onDragOver?: (e: DragEvent, file: ExplorerFileItem) => void;
  onDragLeave?: (file: ExplorerFileItem) => void;
  onDrop?: (e: DragEvent, file: ExplorerFileItem) => void;
  compact?: boolean;
  children?: ReactNode;
}

// One row of the desktop file tree: expander, icon, name (or rename input),
// git badge and the overflow button. Recursion lives in the parent.
// Extracted verbatim from ExplorerPanel.renderRow.
function ExplorerRow({
  file,
  depth,
  isFolder,
  isExpanded,
  isLoading,
  isActive,
  isSelected,
  isRenaming,
  isDragOver,
  isCut,
  gitStatus,
  renameValue,
  renameInputRef,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onToggleFolder,
  onClick,
  onContextMenu,
  onTouchStart,
  onTouchEnd,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  compact = false,
  children
}: ExplorerRowProps) {
  const m = metricsFor(compact);
  return (
    <div>
      <div
        data-path={file.path}
        draggable={!isRenaming}
        onDragStart={(e) => onDragStart?.(e, file)}
        onDragOver={(e) => onDragOver?.(e, file)}
        onDragLeave={() => onDragLeave?.(file)}
        onDrop={(e) => onDrop?.(e, file)}
        className={`group relative flex items-center gap-1 rounded-[3px] mx-0.5 pr-2 cursor-pointer select-none ${m.text} ${m.padY} ${isCut ? "opacity-50" : ""} ${
          isDragOver
            ? "bg-brand-500/30 ring-1 ring-brand-500"
            : isSelected
              ? "bg-brand-500/25"
              : isActive
                ? "bg-brand-500/15"
                : "hover:bg-surface-2"
        }`}
        style={{ paddingLeft: indentFor(depth, compact) }}
        onContextMenu={(e) => onContextMenu?.(e, file)}
        onTouchStart={(e) => onTouchStart?.(e, file)}
        onTouchEnd={onTouchEnd}
        onTouchMove={onTouchEnd}
        onClick={(e) => !isRenaming && onClick?.(file, e)}
      >
        {isFolder ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onToggleFolder?.(file);
            }}
            className="flex items-center justify-center w-4 h-4 text-text-muted"
          >
            {isLoading ? (
              <Icon name="Loader2" size={m.chevron - 2} className="animate-spin" />
            ) : (
              <Icon
                name="ChevronRight"
                size={m.chevron}
                className={`transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`}
              />
            )}
          </span>
        ) : (
          <span className="w-4 h-4" />
        )}

        <span className="shrink-0 relative">
          {isFolder ? resolveFolderIcon(file.name, isExpanded, m.icon) : resolveFileIcon(file, m.icon)}
          {isFolder && gitStatus === "folder-changed" && (
            <span
              className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-git-modified ring-1 ring-bg"
              title="Folder contains modified files"
            />
          )}
        </span>

        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={onRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameSubmit?.();
              else if (e.key === "Escape") onRenameCancel?.();
            }}
            className={`flex-1 bg-surface-3 text-text ${m.text} px-1 py-0.5 rounded outline-none border border-brand-500`}
          />
        ) : (
          <span className={`flex-1 truncate ${nameColor(gitStatus) || "text-text"}`} title={file.name}>
            {file.name}
          </span>
        )}

        {!isRenaming && <GitBadge status={gitStatus} />}

        {/* Overflow floats OVER the name (git-panel style, no reserved space) — the
            terminal action moved into the context menu. It steps aside only for the badge
            this row actually has, so an unmarked row keeps it flush with the edge. */}
        {!isRenaming && (
          <div
            className="absolute top-1/2 -translate-y-1/2 flex items-center pl-2 pr-1 rounded-[3px] bg-surface-2 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ right: actionRightFor(gitStatus) }}
          >
            <button
              onClick={(e) => onContextMenu?.(e, file)}
              className="p-0.5 text-text-muted hover:text-text"
            >
              <Icon name="MoreHorizontal" size={m.chevron} />
            </button>
          </div>
        )}
      </div>

      {children}
    </div>
  );
}

// Leaf rows (children undefined) re-render only when their own visible flags change;
// a folder row with open children still re-renders with its children. The parent passes
// one stable handler set that takes `file` — a closure per row would defeat this.
export default memo(ExplorerRow);