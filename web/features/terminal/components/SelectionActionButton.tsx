"use client";

import { ExternalLink, Copy, X, ListChecks } from "@/shared/components/ui/Icon";
import { LINK_PATTERNS } from "../constants/linkPatterns";
import { SELECTION_BAR } from "../constants/terminalConfig";
import { useI18n } from "@/shared/i18n";

export interface SelectionActionButtonProps {
  text: string;
  position?: { x: number; y: number } | null;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string) => void;
  onAddToNote?: (text: string) => void;
  onClose: () => void;
}

/**
 * Floating Action Button for selected text in terminal
 * Shows context menu with actions based on selection content
 */
export default function SelectionActionButton({
  text,
  position,
  onOpenUrl,
  onCopy,
  onAddToNote,
  onClose
}: SelectionActionButtonProps) {
  const { t } = useI18n();
  const detectedType = detectSelectionType(text);

  const handleAction = (action: string) => {
    if (action === "openUrl" && detectedType.isUrl && detectedType.match) {
      onOpenUrl(detectedType.match);
    } else if (action === "copy") {
      onCopy(text);
    } else if (action === "addNote" && onAddToNote) {
      onAddToNote(text);
      return; // don't close here — caller controls overlay swap
    }
    onClose();
  };

  // Non-modal bar near the finger so the selection ends stay draggable underneath
  const above = (position?.y ?? 0) > SELECTION_BAR.offsetPx * 2;
  const top = above ? (position?.y ?? 0) - SELECTION_BAR.offsetPx : (position?.y ?? 0) + SELECTION_BAR.offsetPx / 2;
  const btn = "px-3 py-2 flex items-center gap-1.5 hover:bg-surface-2 text-text text-xs rounded-brand transition-colors";

  return (
    <div
      className="card-elev fixed z-[60] flex items-center gap-0.5 p-1 shadow-lg -translate-x-1/2"
      style={{ top, left: `clamp(${SELECTION_BAR.edgePx}px, ${position?.x ?? 0}px, calc(100vw - ${SELECTION_BAR.edgePx}px))` }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <button onClick={() => handleAction("copy")} className={btn}>
        <Copy size={16} />
        <span>Copy</span>
      </button>
      {detectedType.isUrl && (
        <button onClick={() => handleAction("openUrl")} className={btn}>
          <ExternalLink size={16} />
          <span>Open</span>
        </button>
      )}
      {onAddToNote && (
        <button onClick={() => handleAction("addNote")} className={btn} aria-label={t("terminalPane.addToNote")}>
          <ListChecks size={16} />
        </button>
      )}
      <button onClick={onClose} className="px-2 py-2 text-text-muted hover:bg-surface-2 rounded-brand" aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
}

export interface SelectionTypeDetection {
  isUrl: boolean;
  isFile: boolean;
  match: string;
}

/**
 * Detect selection type (file, URL, or plain text)
 */
export function detectSelectionType(text: string): SelectionTypeDetection {
  const trimmed = text.trim();
  
  // Check if it's a URL
  const urlMatch = trimmed.match(LINK_PATTERNS.WEB_HTTP);
  if (urlMatch) {
    return { isUrl: true, isFile: false, match: urlMatch[0] };
  }
  
  // Check localhost
  const localhostMatch = trimmed.match(LINK_PATTERNS.WEB_LOCALHOST);
  if (localhostMatch) {
    return { isUrl: true, isFile: false, match: `http://${localhostMatch[0]}` };
  }
  
  // Check file with line numbers
  const fileWithLineMatch = trimmed.match(LINK_PATTERNS.FILE_WITH_LINE);
  if (fileWithLineMatch) {
    return { isUrl: false, isFile: true, match: fileWithLineMatch[0] };
  }
  
  // Check absolute file path
  const absoluteMatch = trimmed.match(LINK_PATTERNS.FILE_ABSOLUTE);
  if (absoluteMatch) {
    return { isUrl: false, isFile: true, match: absoluteMatch[0] };
  }
  
  // Check relative file path
  const relativeMatch = trimmed.match(LINK_PATTERNS.FILE_RELATIVE);
  if (relativeMatch) {
    return { isUrl: false, isFile: true, match: relativeMatch[0] };
  }
  
  // Plain text - only copy available
  return { isUrl: false, isFile: false, match: trimmed };
}
