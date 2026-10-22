"use client";

import { create } from "zustand";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { normalizePathsResponse } from "@/features/fileExplorer/constants/fileExplorer.js";
import { uploadFiles as transferUpload, downloadFile as transferDownload, streamMedia as transferStream, type DownloadMeta, type UploadItem, type UploadCallbacks } from "@/features/fileExplorer/lib/fileTransfer.js";

// Host replies are untrusted JSON; consumers validate them, so they stay `unknown` here.
type Reply = unknown;
type Resolve = (value: Reply) => void;

// Minimal socket surface this store uses (emit for requests, on/off for watchers).
export interface FileBusSocket {
  emit(event: string, ...args: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

export type { UploadItem, UploadCallbacks };
type GetBus = () => FileBusSocket | null;
type GetProtocol = () => { current: unknown } | null;

interface TransferCallbacks {
  onSave?: (blob: Blob, meta: DownloadMeta) => void;
  onProgress?: (ratio: number) => void;
  onError?: (err: unknown) => void;
  [key: string]: unknown;
}

const normResolve = (resolve: Resolve): Resolve => (res) => {
  resolve(normalizePathsResponse(res));
};

const NOT_CONNECTED = { success: false, error: "Not connected" };

// One file API, any bus: the main singleton and every fleet host's facade are the
// same object built over a different bus getter — the only per-host difference.
// `getLiveBus` is the subscription door: unlike one-shot requests it must attach
// the moment the bus object exists (socket.io allows `on` before connect), so a
// watcher registering pre-connect never misses the first events.
export function makeFileBus(getBus: GetBus, getProtocol: GetProtocol = () => null, getLiveBus: GetBus = getBus) {
  return {
  getSystemInfo: () => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getSystemInfo", resolve);
  }),

  getFiles: (dirPath: string, showHidden = false) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getFiles", { dirPath, showHidden }, normResolve(resolve));
  }),

  readFile: (filePath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readFile", { filePath }, resolve);
  }),

  readImage: (filePath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readImage", { filePath }, resolve);
  }),

  readMedia: (filePath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("readMedia", { filePath }, resolve);
  }),

  writeFile: (filePath: string, content: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("writeFile", { filePath, content }, resolve);
  }),

  createItem: (itemPath: string, type: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("createItem", { itemPath, type }, resolve);
  }),

  deleteItem: (itemPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("deleteItem", { itemPath }, resolve);
  }),

  renameItem: (oldPath: string, newPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("renameItem", { oldPath, newPath }, resolve);
  }),

  copyItem: (srcPath: string, destPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("copyItem", { srcPath, destPath }, resolve);
  }),

  gitStatus: (repoPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitStatus", { repoPath }, normResolve(resolve));
  }),

  gitChangedCount: (repoPath: string, force: boolean | undefined) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitChangedCount", { repoPath, force }, resolve);
  }),

  gitFileStatus: (repoPath: string, filePath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitFileStatus", { repoPath, filePath }, normResolve(resolve));
  }),

  gitDiff: (repoPath: string, file: string, status: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitDiff", { repoPath, file, status }, resolve);
  }),

  gitShowMedia: (repoPath: string, file: string, ref = "HEAD") => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitShowMedia", { repoPath, file, ref }, resolve);
  }),

  searchFiles: (workspace: string, query: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("searchFiles", { workspace, query }, normResolve(resolve));
  }),

  gitDiscard: (repoPath: string, file: string, status: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitDiscard", { repoPath, file, status }, resolve);
  }),

  searchInFiles: (workspace: string, query: string, options: Record<string, unknown> = {}) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const { caseSensitive = false, wholeWord = false, regex = false, includeGlob = "", excludeGlob = "" } = options;
    bus.emit("searchInFiles", { workspace, query, caseSensitive, wholeWord, regex, includeGlob, excludeGlob }, normResolve(resolve));
  }),

  replaceInFiles: (workspace: string, query: string, replacement: string, options: Record<string, unknown> = {}, files: string[] = []) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    const { caseSensitive = false, regex = false, includeGlob = "", excludeGlob = "" } = options;
    bus.emit("replaceInFiles", { workspace, query, replacement, caseSensitive, regex, includeGlob, excludeGlob, files }, resolve);
  }),

  watchDir: (dirPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("watchDir", { dirPath }, resolve);
  }),

  unwatchDir: (dirPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("unwatchDir", { dirPath }, resolve);
  }),

  onFileChange: (handler: (...args: unknown[]) => void): (() => void) => {
    const bus = getLiveBus();
    if (!bus) return () => {};
    bus.on("fileChange", handler);
    return () => bus.off("fileChange", handler);
  },

  revealInOS: (filePath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("revealInOS", { filePath }, resolve);
  }),

  openInTerminal: (dirPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("openInTerminal", { dirPath }, resolve);
  }),

  getFileTree: (dirPath: string, depth = 1, showHidden = false) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("getFileTree", { dirPath, depth, showHidden }, normResolve(resolve));
  }),

  gitBranch: (repoPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranch", { repoPath }, resolve);
  }),

  gitScanRepos: (rootPath: string, maxDepth: number | undefined, force: boolean | undefined) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitScanRepos", { rootPath, maxDepth, force }, resolve);
  }),

  gitWorkspaceChangedCount: (rootPath: string, maxDepth: number | undefined, force: boolean | undefined, fetch: boolean | undefined) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorkspaceChangedCount", { rootPath, maxDepth, force, fetch }, resolve);
  }),

  gitRefreshRepos: (rootPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitRefreshRepos", { rootPath }, resolve);
  }),

  gitWorktreeList: (repoPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeList", { repoPath }, resolve);
  }),

  gitWorktreeAdd: (repoPath: string, worktreePath: string, branch: string | undefined, newBranch: boolean | undefined) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeAdd", { repoPath, worktreePath, branch, newBranch }, resolve);
  }),

  gitWorktreeRemove: (repoPath: string, worktreePath: string, opts: Record<string, unknown> = {}) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitWorktreeRemove", { repoPath, worktreePath, ...opts }, resolve);
  }),

  gitBranchList: (repoPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranchList", { repoPath }, resolve);
  }),

  gitBranchCheckout: (repoPath: string, branch: string, create: boolean | undefined) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitBranchCheckout", { repoPath, branch, create }, resolve);
  }),

  gitBranchSwitch: (repoPath: string, branch: string, opts: Record<string, unknown> = {}) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, code: "notConnected", error: "Not connected" });
    bus.emit("gitBranchSwitch", { repoPath, branch, ...opts }, resolve);
  }),

  gitAdd: (repoPath: string, files: string[]) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitAdd", { repoPath, files }, resolve);
  }),

  gitReset: (repoPath: string, files: string[]) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitReset", { repoPath, files }, resolve);
  }),

  gitCommit: (repoPath: string, message: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitCommit", { repoPath, message }, resolve);
  }),

  gitPush: (repoPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitPush", { repoPath }, resolve);
  }),

  gitPull: (repoPath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitPull", { repoPath }, resolve);
  }),

  gitLog: (repoPath: string, limit = 50) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("gitLog", { repoPath, limit }, normResolve(resolve));
  }),

  uploadFiles: (targetDir: string, items: UploadItem[], callbacks?: UploadCallbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(null, new Error("Not connected"));
      return Promise.resolve();
    }
    return transferUpload({
      bus,
      protocolRef: getProtocol(),
      targetDir,
      items,
      callbacks
    });
  },

  downloadFile: (filePath: string, callbacks?: TransferCallbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(new Error("Not connected"));
      return Promise.resolve();
    }
    return transferDownload({
      bus,
      protocolRef: getProtocol(),
      filePath,
      ...callbacks
    });
  },

  streamMedia: (filePath: string, callbacks?: TransferCallbacks) => {
    const bus = getBus();
    if (!bus) {
      callbacks?.onError?.(new Error("Not connected"));
      return { cancel: () => {} };
    }
    return transferStream({
      bus,
      filePath,
      ...callbacks
    });
  },

  previewStart: (filePath: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false, error: "Not connected" });
    bus.emit("preview:start", { filePath }, resolve);
  }),

  previewEnd: (sessionId: string) => new Promise<Reply>((resolve) => {
    const bus = getBus();
    if (!bus) return resolve({ success: false });
    bus.emit("preview:end", { sessionId }, resolve);
  })
  };
}

export type FileBus = ReturnType<typeof makeFileBus>;

const getMainBus = (): FileBusSocket | null => {
  const state = useConnectionStore.getState();
  if (!state.connected) return null;
  return (state.busRef?.current || state.bus) as FileBusSocket | null;
};
const getMainProtocol = (): { current: unknown } | null => useConnectionStore.getState().protocolRef as { current: unknown } | null;
// Ungated: the bus object existing is enough to subscribe.
const getMainLiveBus = (): FileBusSocket | null => {
  const state = useConnectionStore.getState();
  return (state.busRef?.current || state.bus) as FileBusSocket | null;
};

export const useFileBusStore = create<FileBus>(() => makeFileBus(getMainBus, getMainProtocol, getMainLiveBus));

export { NOT_CONNECTED };
