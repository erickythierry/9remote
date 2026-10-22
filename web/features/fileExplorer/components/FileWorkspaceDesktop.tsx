"use client";

import { useState, useCallback, useEffect, useRef, type MouseEvent, type MutableRefObject } from "react";
import ActivityBar from "./ActivityBar";
import SidebarPanel from "./SidebarPanel";
import EditorArea from "./EditorArea";
import StatusBar from "./StatusBar";
import CommandPalette from "./CommandPalette";
import BottomPanel from "./BottomPanel";
import { usePersistedState } from "@/shared/hooks/usePersistedState";
import { useFileExplorerShortcuts } from "../hooks/useFileExplorerShortcuts";
import {
  ACTIVITY_PANELS,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  STORAGE_KEYS,
  MAX_OPEN_TABS,
  GIT_REFRESH_EVENT
} from "../constants/fileExplorer";

interface FileWorkspaceDesktopProps {
  workspace: string;
  fileBus: any;
  onBack?: () => void;
  onSwitchWorkspace?: () => void;
  initialOpenedFiles?: string[];
  onOpenedFilesChange?: (files: string[], activeFile: string | null) => void;
  bus?: any;
  connected?: boolean;
  sessions?: any[];
  onCreateTerminalSession?: (name?: string) => Promise<any> | any;
  onDeleteTerminalSession?: (sessionId: string) => Promise<any> | any;
  onRenameTerminalSession?: (sessionId: string, newName: string) => Promise<any> | any;
  initialActiveFile?: string | null;
  viewType?: string;
  openFileRef?: MutableRefObject<((filePath: string, opts?: any) => void) | null>;
}

// Desktop-only VSCode-like layout: ActivityBar | Sidebar | EditorArea + StatusBar
export default function FileWorkspaceDesktop({
  workspace,
  fileBus,
  onBack,
  onSwitchWorkspace,
  initialOpenedFiles,
  onOpenedFilesChange,
  bus,
  connected,
  sessions,
  onCreateTerminalSession,
  onDeleteTerminalSession,
  onRenameTerminalSession,
  initialActiveFile,
  viewType,
  openFileRef
}: FileWorkspaceDesktopProps) {
  const [activePanel, setActivePanel] = usePersistedState<string>(STORAGE_KEYS.activityPanel, ACTIVITY_PANELS.explorer);

  // Sync sidebar panel with the view that opened this layout (folder → explorer, git → scm).
  useEffect(() => {
    if (viewType === "git") setActivePanel(ACTIVITY_PANELS.scm);
    else if (viewType === "files") setActivePanel(ACTIVITY_PANELS.explorer);
  }, [viewType, setActivePanel]);

  const [sidebarVisible, setSidebarVisible] = usePersistedState(STORAGE_KEYS.sidebarVisible, true);
  const [sidebarWidth, setSidebarWidth] = usePersistedState(STORAGE_KEYS.sidebarWidth, SIDEBAR_DEFAULT_WIDTH);
  const [bottomVisible, setBottomVisible] = usePersistedState(STORAGE_KEYS.bottomPanelVisible, false);
  const [bottomHeight, setBottomHeight] = usePersistedState(
    STORAGE_KEYS.bottomPanelHeight,
    BOTTOM_PANEL_DEFAULT_HEIGHT
  );
  const containerRef = useRef<HTMLDivElement>(null);
  // Width animates on open/close but must track the pointer 1:1 while dragging.
  const [resizing, setResizing] = useState(false);

  // Drag-resize sidebar (percentage of container)
  const startResize = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setResizing(true);
      const onMove = (ev: globalThis.MouseEvent) => {
        if (ev.buttons === 0) {
          onUp();
          return;
        }
        const pct = ((ev.clientX - rect.left) / rect.width) * 100;
        const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, pct));
        setSidebarWidth(clamped);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        setResizing(false);
      };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onUp);
    },
    [setSidebarWidth]
  );

  // Tabs state - lifted here so ActivityBar/Sidebar/Editor share
  const [openedFiles, setOpenedFiles] = useState<string[]>(initialOpenedFiles || []);
  const [activeFile, setActiveFile] = useState<string | null>(
    initialActiveFile || initialOpenedFiles?.[0] || null
  );

  // Editor state for status bar
  const [editorState, setEditorState] = useState<{
    line: number;
    column: number;
    language: string;
    encoding: string;
    jumpLine?: number;
    jumpColumn?: number;
  }>({ line: 1, column: 1, language: "", encoding: "UTF-8" });
  const [gitBranch, setGitBranch] = useState("");
  const [previewRequest, setPreviewRequest] = useState<{ path: string | null; seq: number }>({
    path: null,
    seq: 0
  });

  // Command palette
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"commands" | "files">("commands");

  // Persist opened files + active file
  useEffect(() => {
    onOpenedFilesChange?.(openedFiles, activeFile);
  }, [openedFiles, activeFile, onOpenedFilesChange]);

  // Open file (from explorer/search/quick-open)
  const handleOpenFile = useCallback((filePath: string, opts: { line?: number; column?: number; preview?: boolean } = {}) => {
    // Newest at head (LRU); cap at MAX_OPEN_TABS, evicting oldest from the tail
    setOpenedFiles((prev) => [filePath, ...prev.filter((p) => p !== filePath)].slice(0, MAX_OPEN_TABS));
    setActiveFile(filePath);
    if (opts.line) setEditorState((s) => ({ ...s, jumpLine: opts.line, jumpColumn: opts.column }));
    // Bumped seq, not a boolean: reopening an already-open tab must re-trigger preview.
    if (opts.preview) setPreviewRequest((r) => ({ path: filePath, seq: r.seq + 1 }));
  }, []);

  // Expose openFile via ref so the parent layout can route GitPanel/explorer clicks
  // into the workspace tabs without pushing a new editor view onto the stack.
  useEffect(() => {
    if (openFileRef) openFileRef.current = handleOpenFile;
  }, [openFileRef, handleOpenFile]);

  const handleCloseFile = useCallback(
    (filePath: string) => {
      setOpenedFiles((prev) => {
        const next = prev.filter((p) => p !== filePath);
        if (activeFile === filePath) setActiveFile(next[0] || null);
        return next;
      });
    },
    [activeFile]
  );

  const handleCloseOthers = useCallback((filePath: string) => {
    setOpenedFiles([filePath]);
    setActiveFile(filePath);
  }, []);

  const handleCloseAll = useCallback(() => {
    setOpenedFiles([]);
    setActiveFile(null);
  }, []);

  // Load git branch (tracks activeFile directory or workspace)
  useEffect(() => {
    if (!fileBus) return;
    const targetDir = activeFile
      ? activeFile.slice(0, Math.max(activeFile.lastIndexOf("/"), activeFile.lastIndexOf("\\")))
      : workspace;
    const fetchBranch = () => {
      if (!targetDir) return;
      fileBus
        .gitBranch?.(targetDir)
        .then((r: any) => {
          if (r?.success) setGitBranch(r.branch || "");
          else if (workspace && targetDir !== workspace) {
            fileBus
              .gitBranch?.(workspace)
              .then((rw: any) => {
                if (rw?.success) setGitBranch(rw.branch || "");
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    };
    fetchBranch();
    if (typeof window === "undefined") return;
    window.addEventListener(GIT_REFRESH_EVENT, fetchBranch);
    return () => window.removeEventListener(GIT_REFRESH_EVENT, fetchBranch);
  }, [workspace, fileBus, activeFile]);

  // Keyboard shortcuts
  useFileExplorerShortcuts({
    onToggleSidebar: () => setSidebarVisible((v) => !v),
    onTogglePanel: () => setBottomVisible((v) => !v),
    onSave: () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("fileExplorer:save"));
      }
    },
    onCloseTab: () => {
      if (activeFile) handleCloseFile(activeFile);
    },
    onCommandPalette: () => {
      setPaletteMode("commands");
      setPaletteOpen(true);
    },
    onQuickOpen: () => {
      setPaletteMode("files");
      setPaletteOpen(true);
    }
  });

  return (
    <div className="h-full bg-bg flex flex-col">
      {/* Top area: ActivityBar + Sidebar + Editor */}
      <div className="flex-1 min-h-0 flex">
        <ActivityBar
          activePanel={activePanel}
          onSelectPanel={(p) => {
            if (activePanel === p && sidebarVisible) {
              setSidebarVisible(false);
            } else {
              setActivePanel(p);
              setSidebarVisible(true);
            }
          }}
          onBack={onBack}
        />

        <div ref={containerRef} className="flex-1 min-w-0 min-h-0 flex relative">
          {/* Collapsing by width (rather than unmounting) keeps the panel's scroll position
              and lets the editor slide over instead of snapping. */}
          <div
            className={`bg-surface flex-shrink-0 overflow-hidden min-h-0 flex flex-col ${
              resizing ? "" : "transition-[width] duration-200 ease-out"
            }`}
            style={{ width: sidebarVisible ? `${sidebarWidth}%` : 0 }}
            aria-hidden={!sidebarVisible}
          >
            <SidebarPanel
              activePanel={activePanel}
              workspace={workspace}
              fileBus={fileBus}
              onOpenFile={handleOpenFile}
              onSwitchWorkspace={onSwitchWorkspace}
              activeFile={activeFile}
            />
          </div>
          <div
            onMouseDown={startResize}
            className={`cursor-col-resize bg-border hover:bg-brand-500/50 flex-shrink-0 ${
              resizing ? "" : "transition-[width,background-color] duration-200 ease-out"
            } ${sidebarVisible ? "w-1" : "w-0"}`}
          />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <EditorArea
              workspace={workspace}
              fileBus={fileBus}
              openedFiles={openedFiles}
              activeFile={activeFile}
              onActivateFile={setActiveFile}
              onCloseFile={handleCloseFile}
              onCloseOthers={handleCloseOthers}
              onCloseAll={handleCloseAll}
              onOpenFile={handleOpenFile}
              onEditorStateChange={(cursor) => setEditorState((s) => ({ ...s, ...cursor }))}
              previewRequest={previewRequest.path ? { path: previewRequest.path, seq: previewRequest.seq } : null}
            />
            {bottomVisible && bus && (
              <BottomPanel
                height={bottomHeight}
                onResize={setBottomHeight}
                onClose={() => setBottomVisible(false)}
                bus={bus}
                connected={Boolean(connected)}
                sessions={sessions}
                onCreateSession={onCreateTerminalSession as any}
                onDeleteSession={onDeleteTerminalSession}
                onRenameSession={onRenameTerminalSession}
              />
            )}
          </div>
        </div>
      </div>

      <StatusBar
        gitBranch={gitBranch}
        line={editorState.line}
        column={editorState.column}
        language={editorState.language}
        encoding={editorState.encoding}
        activeFile={activeFile}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        bottomVisible={bottomVisible}
        onTogglePanel={() => setBottomVisible((v) => !v)}
      />

      {paletteOpen && (
        <CommandPalette
          mode={paletteMode}
          workspace={workspace}
          fileBus={fileBus}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={handleOpenFile}
          onSetMode={setPaletteMode}
          onAction={(actionId) => {
            setPaletteOpen(false);
            if (actionId === "toggleSidebar") setSidebarVisible((v) => !v);
            else if (actionId === "togglePanel") setBottomVisible((v) => !v);
            else if (actionId === "closeAll") handleCloseAll();
            else if (actionId === "switchWorkspace") onSwitchWorkspace?.();
            else if (actionId === "openExplorer") {
              setActivePanel(ACTIVITY_PANELS.explorer);
              setSidebarVisible(true);
            } else if (actionId === "openSearch") {
              setActivePanel(ACTIVITY_PANELS.search);
              setSidebarVisible(true);
            } else if (actionId === "openScm") {
              setActivePanel(ACTIVITY_PANELS.scm);
              setSidebarVisible(true);
            } else if (actionId === "openSettings") {
              setActivePanel(ACTIVITY_PANELS.settings);
              setSidebarVisible(true);
            }
          }}
        />
      )}
    </div>
  );
}