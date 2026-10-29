"use client";

import MermaidViewer from "./MermaidViewer";
import MarkdownViewer from "./MarkdownViewer";

export interface TextPreviewProps {
  kind?: string | null;
  filePath?: string;
  fileBus?: any;
  content?: string | null;
  reloadKey?: number;
}

// Unified renderer for text files with a rendered preview (markdown, mermaid).
// HTML has no branch here: its rendered view is the remote browser pane.
export default function TextPreview({ kind, content, reloadKey = 0 }: TextPreviewProps) {
  if (kind === "mermaid") {
    return <MermaidViewer content={content} reloadKey={reloadKey} />;
  }
  if (kind === "markdown") {
    return <MarkdownViewer content={content} />;
  }
  return null;
}
