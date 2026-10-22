import { LINK_PATTERNS, LINK_TYPES, type LinkType } from "../constants/linkPatterns";
import { useTerminalStore } from "@/shared/stores/terminalStore";

export interface LinkRangePoint {
  x: number;
  y: number;
}

export interface LinkRange {
  start: LinkRangePoint;
  end: LinkRangePoint;
}

export interface DetectedLink {
  range: LinkRange;
  text: string;
  activate: () => void;
  decorations?: {
    pointerCursor?: boolean;
    underline?: boolean;
  };
}

export interface ParsedFilePath {
  path: string;
  line: number | null;
  column: number | null;
}

// LRU cache for link detection results (performance optimization)
const detectionCache = new Map<string, DetectedLink[]>();
const MAX_CACHE_SIZE = 1000;

/**
 * Clear oldest entry from cache when size limit reached
 */
function evictOldestCacheEntry(): void {
  if (detectionCache.size >= MAX_CACHE_SIZE) {
    const firstKey = detectionCache.keys().next().value;
    if (firstKey !== undefined) {
      detectionCache.delete(firstKey);
    }
  }
}

/**
 * Detect all links in a terminal line
 * @param lineText - The terminal line text
 * @param bufferLineNumber - The buffer line number (y coordinate)
 * @param cwd - The terminal working directory
 * @returns Array of link objects with range, text, and activate function
 */
export function detectLinks(lineText: string, bufferLineNumber: number, cwd?: string | null): DetectedLink[] {
  // Early exit: skip lines without potential link characters
  if (!/[:/.]/.test(lineText)) {
    return [];
  }

  // Check cache first (cache by line content, not line number)
  if (detectionCache.has(lineText)) {
    const cachedLinks = detectionCache.get(lineText)!;
    // Update y coordinate for cached links (line number may have changed due to scrollback)
    return cachedLinks.map((link) => ({
      ...link,
      range: {
        start: { x: link.range.start.x, y: bufferLineNumber },
        end: { x: link.range.end.x, y: bufferLineNumber }
      }
    }));
  }

  const links: DetectedLink[] = [];

  // Check FILE_WITH_LINE first to avoid conflicts with other file patterns
  const withLineMatches = lineText.matchAll(LINK_PATTERNS.FILE_WITH_LINE);
  for (const match of withLineMatches) {
    const text = match[0];
    const startCol = match.index ?? 0;
    
    // Determine if absolute or relative path
    const isAbsolute = text.startsWith("/");
    const type = isAbsolute ? LINK_TYPES.FILE_ABSOLUTE : LINK_TYPES.FILE_RELATIVE;
    
    links.push({
      range: {
        start: { x: startCol, y: bufferLineNumber },
        end: { x: startCol + text.length, y: bufferLineNumber }
      },
      text,
      activate: () => handleLinkClick({ type, text }, cwd),
      decorations: {
        pointerCursor: true,
        underline: true
      }
    });
  }

  // Web links - HTTP/HTTPS
  const httpMatches = lineText.matchAll(LINK_PATTERNS.WEB_HTTP);
  for (const match of httpMatches) {
    const text = match[0];
    const startCol = match.index ?? 0;
    
    links.push({
      range: {
        start: { x: startCol, y: bufferLineNumber },
        end: { x: startCol + text.length, y: bufferLineNumber }
      },
      text,
      activate: () => handleLinkClick({ type: LINK_TYPES.WEB, text }),
      decorations: {
        pointerCursor: true,
        underline: true
      }
    });
  }

  // Web links - localhost
  const localhostMatches = lineText.matchAll(LINK_PATTERNS.WEB_LOCALHOST);
  for (const match of localhostMatches) {
    const text = match[0];
    const startCol = match.index ?? 0;
    const urlWithProtocol = `http://${text}`;
    
    links.push({
      range: {
        start: { x: startCol, y: bufferLineNumber },
        end: { x: startCol + text.length, y: bufferLineNumber }
      },
      text: urlWithProtocol,
      activate: () => handleLinkClick({ type: LINK_TYPES.WEB, text: urlWithProtocol }),
      decorations: {
        pointerCursor: true,
        underline: true
      }
    });
  }

  // Skip FILE_ABSOLUTE and FILE_RELATIVE if already matched by FILE_WITH_LINE
  const existingPaths = new Set(links.map((l) => {
    const parsed = parseFilePathWithLine(l.text);
    return parsed.path;
  }));

  // Absolute file paths
  const absoluteMatches = lineText.matchAll(LINK_PATTERNS.FILE_ABSOLUTE);
  for (const match of absoluteMatches) {
    const text = match[0];
    if (existingPaths.has(text)) continue; // Skip if already detected
    
    const startCol = match.index ?? 0;
    
    links.push({
      range: {
        start: { x: startCol, y: bufferLineNumber },
        end: { x: startCol + text.length, y: bufferLineNumber }
      },
      text,
      activate: () => handleLinkClick({ type: LINK_TYPES.FILE_ABSOLUTE, text }, cwd),
      decorations: {
        pointerCursor: true,
        underline: true
      }
    });
  }

  // Relative file paths
  const relativeMatches = lineText.matchAll(LINK_PATTERNS.FILE_RELATIVE);
  for (const match of relativeMatches) {
    const text = match[0];
    if (existingPaths.has(text)) continue; // Skip if already detected
    
    const startCol = match.index ?? 0;
    
    links.push({
      range: {
        start: { x: startCol, y: bufferLineNumber },
        end: { x: startCol + text.length, y: bufferLineNumber }
      },
      text,
      activate: () => handleLinkClick({ type: LINK_TYPES.FILE_RELATIVE, text }, cwd),
      decorations: {
        pointerCursor: true,
        underline: true
      }
    });
  }

  // Git modified pattern (extract file path)
  const gitMatches = lineText.matchAll(LINK_PATTERNS.GIT_MODIFIED);
  for (const match of gitMatches) {
    const fullText = match[0]; // "modified: src/file.js"
    const path = fullText.replace(/^modified:\s+/, "");
    const startCol = (match.index ?? 0) + fullText.indexOf(path);
    
    // Determine if absolute or relative
    const isAbsolute = path.startsWith("/");
    const type = isAbsolute ? LINK_TYPES.FILE_ABSOLUTE : LINK_TYPES.FILE_RELATIVE;
    
    links.push({
      range: {
        start: { x: startCol, y: bufferLineNumber },
        end: { x: startCol + path.length, y: bufferLineNumber }
      },
      text: path,
      activate: () => handleLinkClick({ type, text: path }, cwd),
      decorations: {
        pointerCursor: true,
        underline: true
      }
    });
  }

  // Cache results (store with y=0 as template, will be updated when retrieved)
  evictOldestCacheEntry();
  const cacheTemplate = links.map((link) => ({
    ...link,
    range: {
      start: { x: link.range.start.x, y: 0 },
      end: { x: link.range.end.x, y: 0 }
    }
  }));
  detectionCache.set(lineText, cacheTemplate);

  return links;
}

/**
 * Parse file path with optional line and column numbers
 * @param text - File path text (e.g., "file.js:123:45")
 * @returns Object with path, line, column properties
 */
export function parseFilePathWithLine(text: string): ParsedFilePath {
  const parts = text.split(":");
  
  if (parts.length === 1) {
    // No line numbers
    return {
      path: parts[0],
      line: null,
      column: null
    };
  }
  
  if (parts.length === 2) {
    // Only line number
    return {
      path: parts[0],
      line: parseInt(parts[1], 10),
      column: null
    };
  }
  
  // Both line and column
  return {
    path: parts[0],
    line: parseInt(parts[1], 10),
    column: parseInt(parts[2], 10)
  };
}

/**
 * Handle link click action based on link type
 * @param link - Link object with type and text
 * @param cwd - The working directory
 */
export function handleLinkClick(link: { type: LinkType; text: string }, cwd?: string | null): void {
  const { type, text } = link;

  if (type === LINK_TYPES.WEB) {
    window.open(text, "_blank");
    return;
  }

  const { path, line, column } = parseFilePathWithLine(text);

  if (type === LINK_TYPES.FILE_ABSOLUTE) {
    const { pushView } = useTerminalStore.getState();
    pushView({ type: "editor", path, line: line ?? undefined, column: column ?? undefined });
    return;
  }

  if (type === LINK_TYPES.FILE_RELATIVE) {
    const { pushView } = useTerminalStore.getState();
    // Resolve relative path against terminal cwd when available
    const resolved = cwd && !path.startsWith("/") ? `${cwd.replace(/\/$/, "")}/${path}` : path;
    pushView({ type: "editor", path: resolved, line: line ?? undefined, column: column ?? undefined });
  }
}
