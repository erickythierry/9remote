"use client";

import { type MouseEvent } from "react";
import { GIT_STATUS_COLORS } from "../constants/fileExplorer";
import { resolveFileIcon } from "../constants/fileIcons";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

const FILE_ICON_SIZE = 18;

function getFileIcon(file: any) {
  return resolveFileIcon(file, FILE_ICON_SIZE);
}

// Get relative path from workspace
function getRelativePath(filePath: string, workspacePath?: string | null) {
  if (!workspacePath) return filePath;
  return filePath.replace(workspacePath + "/", "");
}

// Get git status color class
function getStatusColor(status?: string) {
  if (status === "folder-changed") return "text-yellow-400";
  return (status && (GIT_STATUS_COLORS as Record<string, string>)[status]) || "";
}

interface FileTreeProps {
  files: any[];
  loading?: boolean;
  onFileClick: (file: any) => void;
  onFolderClick: (file: any) => void;
  onMoreClick?: (file: any, pos: { x: number; y: number }) => void;
  selectedPath?: string | null;
  gitStatusMap?: Record<string, string>;
  workspacePath?: string | null;
}

export default function FileTree({
  files,
  loading,
  onFileClick,
  onFolderClick,
  onMoreClick,
  selectedPath,
  gitStatusMap = {},
  workspacePath
}: FileTreeProps) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted">{t("common.loading")}</div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted">{t("files.emptyFolder")}</div>
      </div>
    );
  }

  const handleMoreClick = (e: MouseEvent<HTMLButtonElement>, file: any) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    onMoreClick?.(file, { x: rect.right, y: rect.top });
  };

  return (
    <div>
      {files.map((file) => {
        const relativePath = getRelativePath(file.path, workspacePath);
        const gitStatus = gitStatusMap[relativePath];
        const statusColor = getStatusColor(gitStatus);

        return (
          <div
            key={file.path}
            className={`w-full px-4 py-1.5 flex items-center gap-2.5 border-b border-border hover:bg-surface-2 transition ${
              selectedPath === file.path ? "bg-surface-2" : ""
            }`}
          >
            <button
              onClick={() => {
                vibrate();
                file.type === "folder" ? onFolderClick(file) : onFileClick(file);
              }}
              className="flex-1 flex items-center gap-2.5 text-left min-w-0"
            >
              <span className="flex-shrink-0 relative">
                {getFileIcon(file)}
                {file.type === "folder" && gitStatus === "folder-changed" && (
                  <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-git-modified ring-1 ring-bg" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className={`truncate text-sm ${statusColor || "text-text"}`} title={file.name}>
                  {file.name}
                  {gitStatus === "folder-changed" && (
                    <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-git-modified align-middle" />
                  )}
                  {gitStatus && gitStatus !== "folder-changed" && (
                    <span className={`ml-2 text-xs font-semibold ${statusColor}`}>
                      [{gitStatus === "?" ? "U" : gitStatus}]
                    </span>
                  )}
                </div>
                {file.type !== "folder" && file.sizeFormatted && (
                  <div className="text-text-subtle text-xs">{file.sizeFormatted}</div>
                )}
              </div>
            </button>

            {/* More button (workspace mode only) */}
            {onMoreClick && (
              <button
                onClick={(e) => {
                  vibrate();
                  handleMoreClick(e, file);
                }}
                className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded transition flex-shrink-0"
                title={t("menu.settings")}
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
            )}

            {file.type === "folder" && (
              <button
                onClick={() => {
                  vibrate();
                  onFolderClick(file);
                }}
                className="p-1 text-text-muted flex-shrink-0"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}