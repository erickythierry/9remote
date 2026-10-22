"use client";

import { useState, useEffect } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";

export interface PdfViewerProps {
  filePath: string;
  fileBus: any;
}

// PDF preview. Streamed over the FILE channel and assembled into a Blob URL
// (lighter than a base64 data URL, no bus bloat) → built-in browser viewer.
export default function PdfViewer({ filePath, fileBus }: PdfViewerProps) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let revoke: string | null = null;
    const chunks: BlobPart[] = [];
    let mime = "application/pdf";

    setLoading(true);
    setError("");
    setSrc("");

    const cancel = fileBus.streamMedia(filePath, {
      onMeta: ({ mime: m }: { mime?: string }) => { if (!cancelled && m) mime = m; },
      onChunk: (payload: BlobPart) => { if (!cancelled) chunks.push(payload); },
      onDone: () => {
        if (cancelled) return;
        const blob = new Blob(chunks, { type: mime });
        const url = URL.createObjectURL(blob);
        revoke = url;
        setSrc(url);
        setLoading(false);
      },
      onError: (e: any) => {
        if (cancelled) return;
        setError(e.message || "Failed to load PDF");
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
      cancel?.();
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [filePath, fileBus]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted gap-2">
        <Loader2 className="animate-spin" size={20} />
        <span>Loading PDF...</span>
      </div>
    );
  }
  if (error) {
    return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }

  return <iframe src={src} title="PDF preview" className="h-full w-full bg-bg" />;
}
