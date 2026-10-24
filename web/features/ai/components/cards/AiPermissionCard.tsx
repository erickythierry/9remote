"use client";

import { memo, useState } from "react";
import { Shield, Check, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { permissionGrantText } from "../../lib/permissionGrant";

export interface AiPermissionCardProps {
  requestId?: string;
  tool?: string;
  input?: any;
  failed?: boolean;
  onResolve?: (requestId: string, action: string, msg?: string, answers?: any, updatedInput?: any) => void;
}

export const AiPermissionCard = memo(function AiPermissionCard({
  requestId = "",
  tool = "",
  input = {},
  failed = false,
  onResolve
}: AiPermissionCardProps) {
  const [customMsg, setCustomMsg] = useState("");
  const [showInput, setShowInput] = useState(false);
  const isBash = typeof input?.command === "string";
  const [isEditing, setIsEditing] = useState(false);
  const [editedCommand, setEditedCommand] = useState(input?.command || "");

  // A permission GRANT (codex asking for more than the thread opened with) has no command
  // to show: what it wants is a profile — network, or paths outside the sandbox — and the
  // CLI's own sentence about why. Printed as those lines, because the raw JSON of a
  // profile is a wall of nulls nobody can decide on. Every other gate keeps its command.
  const command = permissionGrantText(input)
    || input?.command || input?.path || JSON.stringify(input || {});

  const handleAllow = () => {
    vibrate();
    const updated = isEditing && isBash && editedCommand.trim() !== input?.command?.trim()
      ? { ...input, command: editedCommand }
      : null;
    onResolve?.(requestId, "allow", "", null, updated);
  };

  const handleDeny = () => {
    vibrate();
    onResolve?.(requestId, "deny", customMsg || "User denied");
  };

  return (
    <div className="my-3 p-3 rounded-brand-lg border border-warning/30 bg-surface shadow-sm text-xs">
      <div className="flex items-center gap-2 mb-2 text-warning font-medium">
        <Shield size={16} />
        <span>Permission Request</span>
        {/* MCP tools are named mcp__<server>__<tool> — one unbreakable word. Without wrapping
            it runs past the card and scrolls the pane sideways; the full name stays in title. */}
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning uppercase min-w-0 break-all" title={tool}>
          {tool || "Action"}
        </span>
      </div>

      {isEditing ? (
        <div className="mb-3">
          <textarea
            value={editedCommand}
            onChange={(e) => setEditedCommand(e.target.value)}
            className="w-full p-2.5 rounded bg-bg font-mono text-[11px] text-text border border-brand-500 focus:outline-none min-h-[70px] max-h-[180px]"
            autoFocus
          />
        </div>
      ) : (
        <div className="p-2.5 rounded bg-bg font-mono text-[11px] text-text break-all border border-border-subtle mb-3 max-h-[140px] overflow-y-auto">
          {command}
        </div>
      )}

      {showInput && (
        <div className="mb-3">
          <input
            type="text"
            value={customMsg}
            onChange={(e) => setCustomMsg(e.target.value)}
            placeholder="Reason for denial or alternative instructions..."
            className="w-full px-2.5 py-1.5 rounded bg-bg border border-border-subtle text-xs text-text placeholder-text-muted focus:outline-none focus:border-brand-500"
            autoFocus
          />
        </div>
      )}

      {failed && (
        <div className="mb-3 text-[11px] text-danger leading-snug">
          Not sent — the host did not answer. Try again.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 justify-end">
        {isBash && (
          <button
            type="button"
            onClick={() => setIsEditing(!isEditing)}
            className="px-2.5 py-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            {isEditing ? "Cancel edit" : "Edit command"}
          </button>
        )}

        {!showInput ? (
          <button
            type="button"
            onClick={() => setShowInput(true)}
            className="px-2.5 py-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            Add note
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowInput(false)}
            className="px-2.5 py-1.5 rounded text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            Hide note
          </button>
        )}

        <button
          type="button"
          onClick={handleDeny}
          className="px-3 py-1.5 rounded bg-surface-2 hover:bg-danger/20 text-danger flex items-center gap-1 font-medium transition-colors"
        >
          <X size={14} />
          <span>Deny</span>
        </button>

        <button
          type="button"
          onClick={handleAllow}
          className="px-3.5 py-1.5 rounded bg-brand-500 hover:bg-brand-600 text-white flex items-center gap-1 font-medium transition-colors shadow-sm"
        >
          <Check size={14} />
          <span>{isEditing ? "Allow with edit" : "Allow"}</span>
        </button>
      </div>
    </div>
  );
});
