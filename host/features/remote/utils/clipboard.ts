// OS clipboard reader — robotjs has no clipboard API, shell out per-platform.
import { execFile } from "child_process";

interface CommandSpec {
  file: string;
  args: string[];
}

// Build command + args for reading the primary clipboard on each platform.
// Returns null on unsupported platforms — caller skips silently.
function readCommand(): CommandSpec | null {
  switch (process.platform) {
    case "darwin":
      return { file: "pbpaste", args: [] };
    case "win32":
      // -noprofile for speed; Get-Clipboard returns plain text (no RTF/HTML wrappers)
      return { file: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] };
    case "linux":
      // wl-paste (Wayland) preferred when present; fall back to xclip then xsel (X11)
      return null;
    default:
      return null;
  }
}

// Linux needs runtime detection (Wayland vs X11 + available tool).
let linuxCmd: CommandSpec | null | undefined = undefined;
function detectLinuxCommand(): CommandSpec | null {
  if (linuxCmd !== undefined) return linuxCmd;
  if (process.env.WAYLAND_DISPLAY) {
    linuxCmd = { file: "wl-paste", args: ["--no-newline"] };
  } else if (process.env.DISPLAY) {
    // xclip preferred; availability checked on first failure
    linuxCmd = { file: "xclip", args: ["-selection", "clipboard", "-o"] };
  } else {
    linuxCmd = null;
  }
  return linuxCmd;
}

// Fallback chain for X11 when xclip is missing.
const LINUX_FALLBACKS: CommandSpec[] = [
  { file: "xsel", args: ["--clipboard", "--output"] }
];

export function readClipboardText(maxLen: number): Promise<string | null> {
  return new Promise((resolve) => {
    let cmd = readCommand();
    if (process.platform === "linux") cmd = detectLinuxCommand();

    const tryCmd = (command: CommandSpec | null, fallbacks: CommandSpec[] = []): void => {
      if (!command) { resolve(null); return; }
      execFile(command.file, command.args, { timeout: 1500, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) {
          // ENOENT → tool absent. Try next fallback (Linux xclip→xsel); otherwise null.
          if ((err as NodeJS.ErrnoException).code === "ENOENT" && fallbacks.length > 0) {
            const [next, ...rest] = fallbacks;
            tryCmd(next, rest);
            return;
          }
          resolve(null);
          return;
        }
        // PowerShell Get-Clipboard appends a trailing newline — strip exactly one.
        let text = stdout.endsWith("\r\n") ? stdout.slice(0, -2)
          : stdout.endsWith("\n") ? stdout.slice(0, -1)
          : stdout;
        if (text.length > maxLen) text = text.slice(0, maxLen);
        // Drop control chars (keep \t \n \r) — avoids garbage from binary clipboard grabs.
        text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
        resolve(text.length > 0 ? text : null);
      });
    };

    tryCmd(cmd, process.platform === "linux" && process.env.DISPLAY ? LINUX_FALLBACKS : []);
  });
}
