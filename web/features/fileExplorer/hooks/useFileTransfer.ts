"use client";

import { useState, useCallback, useEffect, useRef, type DragEvent } from "react";
import { dataTransferToItems, type UploadItem } from "@/features/fileExplorer/lib/dataTransfer";
import { vibrate } from "@/shared/utils/vibration";

export interface TransferState {
  total: number;
  done: number;
  current: string;
  ratio: number;
}

export interface ConflictState {
  name: string;
  resolve: (choice: "overwrite" | "skip" | "cancel") => void;
}

export interface DownloadState {
  name: string;
  ratio: number;
}

export interface UseFileTransferOptions {
  fileBus: any;
  currentPath: string;
  isBrowsing?: boolean;
  onDone?: (path: string) => void;
  onError?: (err: string) => void;
}

// Upload (drop / paste) and download plumbing for the mobile explorer: progress
// state, the overwrite prompt, and drag-over highlighting.
// Extracted verbatim from FileExplorer.
export function useFileTransfer({ fileBus, currentPath, isBrowsing, onDone, onError }: UseFileTransferOptions) {
  const [transfer, setTransfer] = useState<TransferState | null>(null);      // { total, done, current, ratio }
  const [dragOver, setDragOver] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);      // { name, resolve }
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null); // { name, ratio }

  // Kick off an upload batch into the current directory.
  // Batches can overlap (a second drop while the first is still uploading), and
  // they share one progress slot: without a stamp the older batch's completion
  // would clear the newer batch's UI, and its progress events would fight for
  // the same bar. Only the newest batch may write.
  const uploadSeqRef = useRef(0);
  const startUpload = useCallback(async (items: UploadItem[]) => {
    if (!items.length || !fileBus.uploadFiles) return;
    const seq = ++uploadSeqRef.current;
    const isCurrent = () => seq === uploadSeqRef.current;
    setTransfer({ total: items.length, done: 0, current: items[0]?.file?.name || "", ratio: 0 });
    await fileBus.uploadFiles(currentPath, items, {
      onConflict: ({ file }: { file: File }, relativePath?: string) => new Promise((resolve) => {
        setConflict({ name: relativePath || file.name, resolve });
      }),
      onProgress: (file: File, ratio: number) => { if (isCurrent()) setTransfer((p) => p ? { ...p, current: file.name, ratio } : p); },
      onFileDone: (_file: File) => { if (isCurrent()) setTransfer((p) => p ? { ...p, done: p.done + 1 } : p); }
    });
    if (isCurrent()) setTransfer(null);
    onDone?.(currentPath);
  }, [fileBus, currentPath, onDone]);

  const handleDrop = useCallback(async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (isBrowsing) return;
    const items = await dataTransferToItems(e.dataTransfer);
    if (items.length) { vibrate(); startUpload(items); }
  }, [isBrowsing, startUpload]);

  const handleDragOver = useCallback((e: DragEvent<HTMLElement>) => { e.preventDefault(); if (!isBrowsing) setDragOver(true); }, [isBrowsing]);
  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => { e.preventDefault(); setDragOver(false); }, []);

  // Paste files from OS clipboard (folders aren't exposed via clipboard — files only).
  useEffect(() => {
    if (isBrowsing) return;
    const onPaste = async (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (!files.length) return;
      const items = files.map((f) => ({ file: f, relativePath: f.name }));
      vibrate();
      startUpload(items);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [isBrowsing, startUpload]);

  // Trigger a browser save for a file or folder (folder arrives as .zip).
  // Same single-slot problem as uploads: a second download started while one is
  // running would share the progress bar, and whichever finished first would
  // clear it for both.
  const downloadSeqRef = useRef(0);
  const handleDownload = useCallback((file: { name: string; path: string }) => {
    if (!fileBus.downloadFile) return;
    const seq = ++downloadSeqRef.current;
    const isCurrent = () => seq === downloadSeqRef.current;
    setDownloadState({ name: file.name, ratio: 0 });
    fileBus.downloadFile(file.path, {
      onSave: (blob: Blob, meta?: { fileName?: string }) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = meta?.fileName || file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        if (isCurrent()) setDownloadState(null);
      },
      onProgress: (ratio: number) => { if (isCurrent()) setDownloadState((p) => p ? { ...p, ratio } : p); },
      onError: (e: any) => { onError?.(e.message || "Download failed"); if (isCurrent()) setDownloadState(null); }
    });
  }, [fileBus, onError]);

  // Mirrors the original inline handler: resolve THEN clear, never inside an
  // updater (StrictMode would double-invoke it and answer the prompt twice).
  const resolveConflict = useCallback((choice: "overwrite" | "skip" | "cancel") => {
    conflict?.resolve(choice);
    setConflict(null);
  }, [conflict]);

  return {
    transfer, dragOver, conflict, downloadState,
    startUpload, handleDrop, handleDragOver, handleDragLeave, handleDownload, resolveConflict
  };
}
