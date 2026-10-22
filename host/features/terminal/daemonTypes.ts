export type DaemonFailure = { success: false; error: string };
export type DaemonSuccess = { success: true };
export type DaemonSessionSummary = {
  id: string;
  name: string;
  createdAt: number;
  shellId: string;
  shellLabel: string;
  cwd: string;
  foregroundProcess: string | null;
};
export type DaemonSessionList = { sessions: DaemonSessionSummary[] };
export type DaemonCreateSessionResult = DaemonFailure | (DaemonSuccess & {
  sessionId: string;
  cwd: string;
  shellId: string;
  shellLabel: string;
});
export type DaemonJoinSessionResult = DaemonFailure | (DaemonSuccess & {
  name: string;
  cwd: string;
  shellId: string;
  shellLabel: string;
  total: number;
  replaySize: number;
});
export type DaemonHistoryResult = DaemonFailure | (DaemonSuccess & {
  sessionId: string;
  enc: "b64";
  prefix: string;
  prefixLen: number;
  total: number;
  remaining: number;
});
export type DaemonProcLine = { n: number; enc: "b64"; data: string };
export type DaemonProcResult = DaemonFailure | (DaemonSuccess & { procId?: string; epoch?: number; pid?: number });
export type DaemonProcAttachResult = DaemonFailure | (DaemonSuccess & {
  alive: boolean;
  epoch: number;
  lines: DaemonProcLine[];
  total: number;
  oldest: number;
  exitCode: number | null;
});
export type DaemonProcLinesResult = DaemonFailure | (DaemonSuccess & {
  epoch: number;
  lines: DaemonProcLine[];
  total: number;
  oldest: number;
});
export type DaemonProcInfo = { procId: string; alive: boolean; total: number; cwd?: string };
export type DaemonProcListResult = DaemonSuccess & { procs: DaemonProcInfo[] };
