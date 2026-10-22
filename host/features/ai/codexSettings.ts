// Maps client Codex options to Codex app-server protocol schema
const MODE_TO_SANDBOX: Record<string, string> = {
  readOnly: "readOnly",
  default: "workspaceWrite",
  plan: "workspaceWrite",
  fullAccess: "dangerFullAccess"
};

const RAW_SANDBOX: Record<string, string> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess"
};

const MODE_TO_APPROVAL: Record<string, string> = {
  readOnly: "untrusted",
  default: "on-request",
  plan: "on-request",
  fullAccess: "never"
};

const DEFAULT_MODE = "default";

const MODE_LADDER = [["plan", "readOnly"], "default", "fullAccess"];

export const MODE_LABELS: Record<string, string> = { plan: "Plan", readOnly: "Read Only", default: "Default", fullAccess: "Full Access" };

export function nextModeUp(current: string): string | null {
  for (let i = 0; i < MODE_LADDER.length; i++) {
    const step = MODE_LADDER[i];
    if (Array.isArray(step) ? step.includes(current) : step === current) return (MODE_LADDER[i + 1] as string) ?? null;
  }
  return null;
}

// Pattern matching Codex refusal messages in assistant text
export const BLOCKED_TEXT_RE = /(?:can(?:not|'t|not)\s+(?:create|write|edit|modify|delete)|unable to\s+(?:create|write|edit|modify)|permission denied|operation not permitted|not permitted to|(?:workspace|sandbox)\s+is\s+read-?only|outside the (?:workspace|sandbox))/i;

const FEATURE_NAME_RE = /^[A-Za-z0-9_]+$/;

export interface SandboxPolicyOptions {
  mode?: string;
  sandbox?: string;
  networkAccess?: boolean;
  addDirs?: string[];
}

export function sandboxPolicyFor({ mode, sandbox, networkAccess = false, addDirs = [] }: SandboxPolicyOptions = {}) {
  const type = (mode && MODE_TO_SANDBOX[mode]) || (sandbox && RAW_SANDBOX[sandbox]) || MODE_TO_SANDBOX[DEFAULT_MODE];
  if (type === "dangerFullAccess") return { type };

  const policy = {
    type,
    writableRoots: (addDirs || []).filter((d): d is string => typeof d === "string" && Boolean(d)),
    networkAccess: Boolean(networkAccess),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  if (type === "readOnly") {
    return { type, networkAccess: policy.networkAccess };
  }
  return policy;
}

export function approvalPolicyFor({ mode }: { mode?: string } = {}) {
  return (mode && MODE_TO_APPROVAL[mode]) || MODE_TO_APPROVAL[DEFAULT_MODE];
}

export interface CollaborationModeOptions {
  planMode?: boolean;
  model?: string;
  effort?: string;
  planEffort?: string;
}

export function collaborationModeFor({ planMode = false, model = "", effort = "", planEffort = "" }: CollaborationModeOptions = {}) {
  return {
    mode: planMode ? "plan" : "default",
    settings: {
      model: model || "",
      reasoning_effort: planEffort || effort || null,
      developer_instructions: null
    }
  };
}

export interface TurnSettingsOptions {
  mode?: string;
  model?: string;
  effort?: string;
  personality?: string;
}

export function turnSettingsFor({ mode, model, effort, personality }: TurnSettingsOptions = {}) {
  const out: Record<string, any> = {
    sandboxPolicy: sandboxPolicyFor({ mode }),
    approvalPolicy: approvalPolicyFor({ mode })
  };
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (personality) out.personality = personality;
  return out;
}

export interface SpawnArgsOptions {
  enable?: string[];
  disable?: string[];
  skipGitRepoCheck?: boolean;
}

export function spawnArgsFor({ enable = [], disable = [], skipGitRepoCheck = false }: SpawnArgsOptions = {}): string[] {
  const args: string[] = [];
  for (const name of enable || []) {
    if (FEATURE_NAME_RE.test(String(name))) args.push("-c", `features.${name}=true`);
  }
  for (const name of disable || []) {
    if (FEATURE_NAME_RE.test(String(name))) args.push("-c", `features.${name}=false`);
  }
  if (skipGitRepoCheck) args.push("-c", "skip_git_repo_check=true");
  return args;
}
