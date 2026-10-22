"use client";

import { Terminal } from "@/shared/components/ui/Icon";
import { agentIconUrl, AGENT_ICON_CLS } from "../constants/agentCli";
import { AGENT_ICONS } from "../constants/agentLabels";

export interface PlainShellGlyphProps {
  size?: number;
  className?: string;
}

// A plain shell's avatar: black tile + white prompt glyph, same rounding as the agents' favicons
export function PlainShellGlyph({ size = 14, className = "" }: PlainShellGlyphProps) {
  return (
    <span style={{ width: size, height: size }} className={`flex items-center justify-center rounded-[3px] bg-neutral-800 shrink-0 ${className}`}>
      <Terminal size={size * 0.85} className="text-white" />
    </span>
  );
}

export interface SessionAgentIconProps {
  agent?: any;
  tool?: string | null;
}

// A terminal row's leading icon: the engine's bundled logo — UI engines get their
// own icon, a hook-reported tool falls back to the label's icon, and a plain shell
// gets the black terminal tile. Shared by the main tree and other hosts' trees.
export default function SessionAgentIcon({ agent = null, tool = null }: SessionAgentIconProps) {
  // Callers may hand the picked option object; only its id names the engine.
  const agentId = typeof agent === "string" ? agent : (agent?.id || null);
  if (agentId?.endsWith("-ui")) {
    const iconSrc = agentIconUrl(agentId);
    if (!iconSrc) return <PlainShellGlyph size={14} />;
    return <img src={iconSrc} alt="" draggable={false} className={`w-3.5 h-3.5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`} />;
  }
  if (tool && (AGENT_ICONS as Record<string, string>)[tool]) {
    return <img src={(AGENT_ICONS as Record<string, string>)[tool]} alt={tool} draggable={false} className={`w-3.5 h-3.5 flex-shrink-0 object-contain ${AGENT_ICON_CLS}`} />;
  }
  return <PlainShellGlyph size={14} />;
}
