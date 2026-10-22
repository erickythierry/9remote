import type { WorkspaceView } from "@/features/terminal/constants/routeConfig";

export interface AgentCli {
  id: string;
  label?: string;
  cmd?: string;
  [key: string]: unknown;
}

export interface AgentHistoryRow {
  id?: string;
  sessionId?: string;
  title?: string;
  name?: string;
  mode?: string;
  agent?: string;
  branch?: string;
  updatedAt?: number;
  resume?: string | null;
  cwd?: string | null;
  openSessionId?: string | null;
  [key: string]: unknown;
}

export interface ArtifactItem {
  path: string;
  title?: string;
  sessionId?: string | null;
  [key: string]: unknown;
}

export interface MobileSession {
  id?: string;
  sessionId?: string;
  serial?: string;
  meta?: any;
  [key: string]: unknown;
}

export interface MobileFloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalStoreState {
  viewStack: WorkspaceView[];
  openedSessions: string[];
  activeWorkspaceId: string | null;
  fullMode: boolean;
  livePanes: string[];
  mountedWorkspaces: Record<string, boolean>;
  drafts: Record<string, string>;
  collapsedWorkspaces: Record<string, boolean>;
  cwdBySession: Record<string, string>;
  pendingStartup: Record<string, string>;
  artifactsBySession: Record<string, ArtifactItem[]>;
  hiddenPaneSessionIds: string[];
  agentBySession: Record<string, string>;
  // Claude chat tabs showing their terminal instead of the chat (both stay mounted).
  terminalViewBySession: Record<string, boolean>;
  agentHistory: Record<string, { at: number; sessions: AgentHistoryRow[] }>;

  setActiveWorkspaceId(workspaceId: string | null): void;
  touchLivePane(sessionIds: string | string[]): void;
  markWorkspaceMounted(workspaceId: string | null): void;
  isWorkspaceMounted(workspaceId: string | null): boolean;
  setDraft(sessionId: string, text: string): void;
  toggleWorkspace(key: string): void;
  setCwd(sessionId: string, cwd: string): void;
  pushView(view: WorkspaceView): void;
  popView(): void;
  setViewStack(viewStack: WorkspaceView[]): void;
  addOpenedSession(sessionId: string): void;
  removeOpenedSession(sessionId: string): void;
  replaceOpenedSession(oldId: string | null, newId: string): void;
  clearOpenedSessions(): void;
  reorderOpenedSessions(orderedIds: string[]): void;
  closeSession(sessionId: string): void;
  getCurrentView(): WorkspaceView | undefined;
  getSelectedSession(): string | null | undefined;
  reset(): void;

  sidebarCollapsed: boolean;
  toggleSidebar(): void;
  setSidebarCollapsed(value: boolean): void;
  sidebarWidth: number;
  setSidebarWidth(width: number): void;
  fullModes: Record<string, boolean>;
  toggleFullMode(workspaceId?: string | null): void;
  setFullMode(workspaceIdOrValue: string | boolean | null, value?: boolean): void;
  toggleHidePane(sessionId: string): void;
  unhidePane(sessionId: string): void;
  paneWidths: Record<string, number | null>;
  setPaneWidth(workspaceId: string, width: number | null): void;
  rightPanelOpen: boolean;
  rightPanelTabs: Record<string, string>;
  rightPanelWidth: number;
  rightPanelWasOpen: boolean | null;
  toggleRightPanel(): void;
  closeRightPanel(): void;
  openRightPanel(): void;
  setRightPanelTab(tab: string, workspacePath?: string | null): void;
  rightPanelRoots: Record<string, string>;
  setRightPanelRoot(workspacePath: string | null, rootPath: string | null): void;
  setRightPanelWidth(width: number): void;
  editorFilePath: string | null;
  editorPanelWidth: number;
  editorPreviewSeq: number;
  artifactTitle: string | null;
  artifactSessionId: string | null;
  editorJump: { line: number; column?: number; seq: number } | null;
  setEditorPanelWidth(width: number): void;
  openEditorFile(filePath: string, options?: { preview?: boolean; artifactTitle?: string; artifactSessionId?: string; line?: number; column?: number }): void;
  closeEditorFile(): void;
  hiddenHeaderButtons: string[];
  hiddenHeaderButtonsMigrated: boolean;
  toggleHeaderButton(id: string): void;
  mobileLowPower: boolean;
  setMobileLowPower(on: boolean): void;
  mobileOpen: boolean;
  mobileMode: string;
  mobilePanelWidth: number;
  mobileFloatRect: MobileFloatRect | null;
  setMobileOpen(open: boolean): void;
  setMobileMode(mode: string): void;
  setMobilePanelWidth(width: number): void;
  setMobileFloatRect(rect: MobileFloatRect | null): void;
  mobileSession: MobileSession | null;
  setMobileSession(session: MobileSession | null | ((current: MobileSession | null) => MobileSession | null)): void;

  webglEnabled: boolean;
  setWebglEnabled(enabled: boolean): void;
  fontSize: number | null;
  setFontSize(size: number | null): void;
  terminalTheme: string;
  setTerminalTheme(key: string): void;
  terminalBackgrounds: string[];
  setTerminalBackgrounds(keys: string[]): void;
  terminalBackgroundOpacity: number | null;
  setTerminalBackgroundOpacity(value: number | null): void;
  customBackgrounds: Array<{ id: string; dataUrl: string; [key: string]: unknown }>;
  setCustomBackgrounds(items: Array<{ id: string; dataUrl: string; [key: string]: unknown }>): void;
  backgroundBySession: Record<string, string>;
  setSessionBackground(sessionId: string, key: string | null): void;
  showFolderButton: boolean;
  showNoteButton: boolean;
  setShowFolderButton(value: boolean): void;
  setShowNoteButton(value: boolean): void;
  noteChips: string[];
  addNoteChip(text: string): void;
  removeNoteChip(text: string): void;
  pinnedNotes: Record<string, boolean>;
  setNotePinned(sessionId: string, pinned: boolean): void;

  agentCaps: Record<string, unknown>;
  setAgentCaps(caps: Record<string, unknown>): void;
  artifactEnabled: boolean;
  setArtifactEnabled(enabled: boolean): void;
  mcpClients: string[];
  setMcpClients(ids: string[]): void;
  agentClisBy: Record<string, { list: AgentCli[]; at: number }>;
  setAgentClis(hostKey: string, list: AgentCli[]): void;
  setAgentHistory(cwd: string, sessions: AgentHistoryRow[]): void;
  invalidateAgentHistory(): void;
  setSessionAgent(sessionId: string, agentId: string): void;
  setTerminalView(sessionId: string, on: boolean): void;
  queueStartup(sessionId: string, command: string): void;
  consumeStartup(sessionId: string): string | null;
  pushArtifact(sessionId: string, item: ArtifactItem): void;
  removeArtifact(sessionId: string, filePath: string): void;

  terminalBackground?: string | null;
}

export type NavigationSlice = Pick<TerminalStoreState,
  | "viewStack" | "openedSessions" | "activeWorkspaceId" | "livePanes" | "mountedWorkspaces" | "drafts"
  | "collapsedWorkspaces" | "cwdBySession"
  | "setActiveWorkspaceId" | "touchLivePane" | "markWorkspaceMounted" | "isWorkspaceMounted" | "setDraft" | "toggleWorkspace" | "setCwd"
  | "pushView" | "popView" | "setViewStack" | "addOpenedSession" | "removeOpenedSession" | "replaceOpenedSession" | "clearOpenedSessions"
  | "reorderOpenedSessions" | "closeSession" | "getCurrentView" | "getSelectedSession" | "reset"
>;

export type LayoutSlice = Pick<TerminalStoreState,
  | "sidebarCollapsed" | "toggleSidebar" | "setSidebarCollapsed" | "sidebarWidth" | "setSidebarWidth" | "fullModes" | "fullMode" | "toggleFullMode" | "setFullMode"
  | "hiddenPaneSessionIds" | "toggleHidePane" | "unhidePane" | "paneWidths" | "setPaneWidth" | "rightPanelOpen" | "rightPanelTabs" | "rightPanelWidth"
  | "rightPanelWasOpen" | "toggleRightPanel" | "closeRightPanel" | "openRightPanel" | "setRightPanelTab" | "rightPanelRoots"
  | "setRightPanelRoot" | "setRightPanelWidth" | "editorFilePath" | "editorPanelWidth" | "editorPreviewSeq" | "artifactTitle"
  | "artifactSessionId" | "editorJump" | "setEditorPanelWidth" | "openEditorFile" | "closeEditorFile" | "hiddenHeaderButtons"
  | "hiddenHeaderButtonsMigrated" | "toggleHeaderButton" | "mobileLowPower" | "setMobileLowPower" | "mobileOpen" | "mobileMode"
  | "mobilePanelWidth" | "mobileFloatRect" | "setMobileOpen" | "setMobileMode" | "setMobilePanelWidth" | "setMobileFloatRect"
  | "mobileSession" | "setMobileSession"
>;

export type ThemeSlice = Pick<TerminalStoreState,
  | "webglEnabled" | "setWebglEnabled" | "fontSize" | "setFontSize" | "terminalTheme" | "setTerminalTheme"
  | "terminalBackgrounds" | "setTerminalBackgrounds" | "terminalBackgroundOpacity" | "setTerminalBackgroundOpacity"
  | "customBackgrounds" | "setCustomBackgrounds" | "backgroundBySession" | "setSessionBackground" | "showFolderButton"
  | "showNoteButton" | "setShowFolderButton" | "setShowNoteButton" | "noteChips" | "addNoteChip" | "removeNoteChip"
  | "pinnedNotes" | "setNotePinned"
>;

export type AgentSlice = Pick<TerminalStoreState,
  | "agentCaps" | "setAgentCaps" | "artifactEnabled" | "setArtifactEnabled" | "mcpClients" | "setMcpClients" | "agentClisBy"
  | "setAgentClis" | "agentHistory" | "setAgentHistory" | "invalidateAgentHistory" | "agentBySession" | "setSessionAgent"
  | "terminalViewBySession" | "setTerminalView"
  | "pendingStartup" | "queueStartup" | "consumeStartup" | "artifactsBySession" | "pushArtifact" | "removeArtifact"
>;
