// A permission grant as the lines a person decides on.
//
// Codex can ask for more access than the thread opened with — the network, or paths
// outside the sandbox — and it says so as a PROFILE (the server's own
// `RequestPermissionProfile`: `network` and `fileSystem`), not as a command line. Printed
// raw, a profile is a wall of nulls; what a reader needs is the two or three facts it
// amounts to, next to the CLI's own sentence about why it is asking.

interface FileSystemPath {
  type?: "path" | "glob_pattern" | "special";
  path?: string;
  pattern?: string;
  value?: string;
}

interface PermissionProfile {
  network?: { enabled: boolean | null } | null;
  fileSystem?: {
    read?: string[];
    write?: string[];
    entries?: Array<{ path?: FileSystemPath | string; access?: string }>;
  } | null;
}

interface PermissionGrantInput {
  kind?: string;
  reason?: string;
  permissions?: PermissionProfile;
}

// Returns "" for anything that is not a grant, so the caller can fall through to the
// command line every other gate carries.
export function permissionGrantText(input?: PermissionGrantInput | null): string {
  if (input?.kind !== "permission_grant") return "";
  const lines: string[] = [];
  const reason = String(input.reason || "").trim();
  if (reason) lines.push(reason);
  lines.push(...permissionLines(input.permissions));
  return lines.join("\n");
}

/** The profile's own facts, one per line. Exported for the test. */
export function permissionLines(permissions: PermissionProfile = {}): string[] {
  const out: string[] = [];
  // `enabled: null` is the server saying nothing either way, which is not a request.
  if (permissions?.network?.enabled) out.push("• network access");
  const fs = permissions?.fileSystem || {};
  for (const p of fs.read || []) out.push(`• read ${p}`);
  for (const p of fs.write || []) out.push(`• write ${p}`);
  for (const e of fs.entries || []) {
    const where = pathText(e?.path);
    if (where) out.push(`• ${e.access || "access"} ${where}`);
  }
  return out;
}

/** A `FileSystemPath` as one string — the three spellings it comes in. */
function pathText(p?: FileSystemPath | string): string {
  if (typeof p === "string") return p;
  return p?.path || p?.pattern || p?.value || "";
}
