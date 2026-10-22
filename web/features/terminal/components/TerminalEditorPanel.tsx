"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startWidthDrag } from "@/shared/utils/dragResize";
import { Save, X, ExternalLink, Eye, FileCode } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { EDITOR_PANEL_WIDTH } from "../constants/terminalConfig";
import { resolveFileIcon } from "@/features/fileExplorer/constants/fileIcons";
import { isDiffPath, parseRepoDiffPath, makeDiffPath, GIT_STATUS_COLORS, getTextPreviewKind } from "@/features/fileExplorer/constants/fileExplorer";
import { isPreviewable } from "@/features/fileExplorer/components/FilePreview";
import { useFileDocument } from "@/features/fileExplorer/hooks/useFileDocument";
import { useUnsavedGuard } from "@/features/fileExplorer/hooks/useUnsavedGuard";
import { useDirWatch, usePageVisible } from "@/features/fileExplorer/hooks/useDirWatch";
import UnsavedDialog from "@/features/fileExplorer/components/UnsavedDialog";
import CodeEditor from "@/features/fileExplorer/components/CodeEditor";
import FilePreview from "@/features/fileExplorer/components/FilePreview";
import TextPreview from "@/features/fileExplorer/components/TextPreview";
import DiffView from "@/features/fileExplorer/components/DiffView";

export interface TerminalEditorPanelProps {
  filePath?: string | null;
  workspace?: string | null;
  fileBus?: any;
  width?: number;
  onResize?: (width: number) => void;
  onClose?: () => void;
  onOpenFull?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  isDesktop?: boolean;
  previewSeq?: number;
  artifactTitle?: string | null;
  jump?: { line?: number; column?: number } | null;
}

// A file opened from the tree, edited without leaving the terminal. Narrow on purpose —
// this is for a quick read or fix, not a replacement for the full editor view.
export default function TerminalEditorPanel({
  filePath = "",
  workspace,
  fileBus,
  width,
  onResize,
  onClose,
  onOpenFull,
  onOpenFile,
  isDesktop = true,
  previewSeq = 0,
  artifactTitle = null,
  jump = null
}: TerminalEditorPanelProps) {
  const { t } = useI18n();

  // The Git tab opens a "git-diff:…" tab id, not a path on disk — reading it as one is
  // what produced "file not found". It carries the repo the path belongs to, since the
  // panel lists nested repos and worktrees alongside the workspace root.
  const isDiff = isDiffPath(filePath || "");
  const diff = isDiff ? parseRepoDiffPath(filePath || "") : null;
  const diffRepo = diff?.repoPath || workspace;
  const displayPath = isDiff && diff ? diff.filePath : (filePath || "");
  // What the editor would open for this diff. git reports repo-relative paths, so a diff
  // read from a nested repo must carry its repo along or the file is not found.
  const diffAbsPath = diff
    ? (diff.repoPath
      ? `${diff.repoPath.replace(/\/$/, "")}/${diff.filePath}`
      : diff.filePath.startsWith("/") ? diff.filePath : `${workspace?.replace(/\/$/, "") || ""}/${diff.filePath}`)
    : "";
  const editable = !!filePath && !isDiff && !isPreviewable(filePath);

  const doc = useFileDocument({ filePath: editable && filePath ? filePath : "", fileBus });
  // The watch callback must not be rebuilt on every keystroke — doc is a new object each
  // render, so it is read through a ref instead of captured. Synced in an effect, the
  // same shape useDirWatch uses for its own callback ref.
  const docRef = useRef(doc);
  useEffect(() => { docRef.current = doc; }, [doc]);
  const guard = useUnsavedGuard({ dirty: editable && doc.dirty, onSave: doc.save });

  // Text files with rendered forms (html, markdown, mermaid) can flip between source and preview.
  const previewKind = !editable || !filePath ? null : getTextPreviewKind(filePath);
  // A non-zero previewSeq is the opener saying "show this rendered" — the tree's Preview
  // action, and every artifact the AI opens. Read at mount too, not only on a later
  // change: the panel is mounted BY that first open, so a seq compared against its own
  // initial value never fires and the first artifact would land on its source.
  const wantsRendered = previewSeq > 0;
  const [showRendered, setShowRendered] = useState(wantsRendered);
  const [saveSeq, setSaveSeq] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  const [prevSaved, setPrevSaved] = useState(false);
  const [lastPreviewSeq, setLastPreviewSeq] = useState(previewSeq);
  // Adjust during render (not in an effect) — the sanctioned reset-on-prop pattern.
  // Either a new file or a fresh request re-reads the opener's intent, so manually
  // flipping to the source lasts until the next open rather than forever.
  if (lastPath !== filePath || lastPreviewSeq !== previewSeq) {
    setLastPath(filePath);
    setLastPreviewSeq(previewSeq);
    setShowRendered(wantsRendered);
  }
  // Edge-trigger justSaved into a counter the preview can reload on.
  if (doc.justSaved !== prevSaved) {
    setPrevSaved(doc.justSaved);
    if (doc.justSaved) setSaveSeq((s) => s + 1);
  }

  // Escape closes, but goes through the guard so it cannot throw away unsaved edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") guard.guard(onClose || (() => {})); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [guard, onClose]);

  // Follow the file on disk. An artifact is usually a file the AI is still working on,
  // and a panel showing yesterday's render while the terminal reports a rewrite is worse
  // than no panel at all. The watcher reports the whole directory, so the file is picked
  // out here; a rendered preview reloads outright, while the code view defers to
  // useFileDocument, which protects unsaved edits.
  const fileDir = filePath && !isDiff ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const watchDirs = useMemo(() => (fileDir ? [fileDir] : []), [fileDir]);
  const pageVisible = usePageVisible();
  const onDiskChanged = useCallback(() => {
    setSaveSeq((seq) => seq + 1);
    docRef.current?.onChangedOnDisk();
  }, []);
  useDirWatch({
    dirs: watchDirs,
    fileBus,
    enabled: !!fileBus && watchDirs.length > 0 && pageVisible,
    onDirsChanged: onDiskChanged
  });

  const fileIconElement = resolveFileIcon({ name: displayPath }, 14);
  const name = artifactTitle || displayPath.split("/").filter(Boolean).pop() || "";
  const statusColor = diff ? GIT_STATUS_COLORS[diff.status] : null;

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      if (!onResize) return;
      startWidthDrag(e, {
        startWidth: width || EDITOR_PANEL_WIDTH.default,
        axis: -1,
        onWidth: onResize
      });
    },
    [onResize, width]
  );

  return (
    <div
      style={{ width: isDesktop ? (width || EDITOR_PANEL_WIDTH.default) : "100%" }}
      className={`relative h-full flex flex-col bg-surface border-l border-border select-text ${isDesktop ? "" : "w-full"}`}
    >
      <div
        style={{ height: PANEL_HEADER_HEIGHT }}
        className="flex items-center justify-between px-3 border-b border-border bg-surface shrink-0 text-xs select-none gap-2"
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {fileIconElement}
          <span className="font-medium text-text truncate" title={displayPath}>
            {name}
          </span>
          {diff && (
            <span
              className="text-[10px] font-mono font-bold px-1 rounded-[2px] shrink-0"
              style={{ color: statusColor || undefined, background: `${statusColor || "currentColor"}20` }}
            >
              {diff.status}
            </span>
          )}
          {editable && doc.dirty && (
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" title={t("editor.unsaved")} />
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0 text-text-muted">
          {previewKind && (
            <button
              onClick={() => { vibrate(); setShowRendered((v) => !v); }}
              className={`p-1 rounded hover:bg-surface-2 transition-colors ${showRendered ? "text-brand-500" : ""}`}
              title={showRendered ? t("fileExplorer.showSource") : t("fileExplorer.showPreview")}
              aria-label={showRendered ? t("fileExplorer.showSource") : t("fileExplorer.showPreview")}
            >
              {showRendered ? <FileCode size={14} /> : <Eye size={14} />}
            </button>
          )}

          {editable && doc.dirty && (
            <button
              onClick={() => { vibrate(); doc.save(); }}
              disabled={doc.saving}
              className="p-1 rounded hover:bg-surface-2 text-brand-500 hover:text-brand-400 disabled:opacity-40 transition-colors"
              title={t("common.save")}
              aria-label={t("common.save")}
            >
              <Save size={14} />
            </button>
          )}

          {onOpenFull && (
            <button
              onClick={() => {
                vibrate();
                const target = diff ? diffAbsPath : (filePath || "");
                if (target) onOpenFull(target);
              }}
              className="p-1 rounded hover:bg-surface-2 hover:text-text transition-colors"
              title={t("editor.openInEditor")}
              aria-label={t("editor.openInEditor")}
            >
              <ExternalLink size={14} />
            </button>
          )}

          {onClose && (
            <button
              onClick={() => guard.guard(onClose)}
              className="p-1 rounded hover:bg-surface-2 hover:text-text transition-colors"
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {editable && doc.staleOnDisk && (
        <div className="px-3 py-1 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-xs flex items-center justify-between shrink-0">
          <span className="truncate">{t("editor.changedOnDisk")}</span>
          <button
            onClick={() => { vibrate(); doc.reload(); }}
            className="shrink-0 px-1.5 py-0.5 rounded-[3px] hover:bg-amber-500/20 font-medium transition-colors"
          >
            {t("editor.reloadFromDisk")}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden bg-editor-bg">
        {isDiff && diff ? (
          <DiffView diffPath={makeDiffPath(diff.status, diff.filePath)} workspace={diffRepo || undefined} fileBus={fileBus} compact />
        ) : filePath && isPreviewable(filePath) ? (
          <FilePreview filePath={filePath} fileBus={fileBus} />
        ) : showRendered && previewKind && filePath ? (
          <TextPreview kind={previewKind} filePath={filePath} fileBus={fileBus} content={doc.content} reloadKey={saveSeq} />
        ) : doc.loading ? (
          <div className="h-full flex items-center justify-center text-text-muted text-xs">{t("common.loading")}</div>
        ) : (
          <CodeEditor
            filePath={filePath || ""}
            content={doc.content}
            onTextChanged={doc.onTextChanged}
            onRegisterView={doc.register}
            onSave={doc.save}
            line={jump?.line}
            column={jump?.column}
            compact
          />
        )}
      </div>

      <UnsavedDialog
        isOpen={guard.asking}
        fileName={name}
        onSave={guard.saveThenLeave}
        onDiscard={guard.discardAndLeave}
        onCancel={guard.cancel}
      />

      {isDesktop && (
        <div
          onPointerDown={startResize}
          className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
        />
      )}
    </div>
  );
}
