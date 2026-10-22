"use client";

import HtmlViewer from "./HtmlViewer";
import MermaidViewer from "./MermaidViewer";
import MarkdownViewer from "./MarkdownViewer";

export interface TextPreviewProps {
  kind?: string | null;
  filePath: string;
  fileBus: any;
  content?: string | null;
  reloadKey?: number;
}

// Unified renderer for text files with a rendered preview (html, markdown, mermaid).
export default function TextPreview({ kind, filePath, fileBus, content, reloadKey = 0 }: TextPreviewProps) {
  if (kind === "html") {
    return <HtmlViewer filePath={filePath} fileBus={fileBus} reloadKey={reloadKey} />;
  }
  if (kind === "mermaid") {
    return <MermaidViewer content={content} reloadKey={reloadKey} />;
  }
  if (kind === "markdown") {
    return <MarkdownViewer content={content} />;
  }
  return null;
}
