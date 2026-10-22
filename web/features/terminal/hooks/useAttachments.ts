"use client";

import { useState, useRef, useCallback } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS, CLIPBOARD_ATTACH_TIMEOUT } from "@/features/terminal/constants/terminalConfig";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

export interface AttachmentItem {
  id: number;
  name: string;
  type: string;
  size: number;
  content: string;
  isImage: boolean;
}

export interface UseAttachmentsOptions {
  bus?: { emit: (event: string, ...args: any[]) => void } | null;
  sessionId?: string | null;
}

// Attachment staging for the mobile input bar: pick/paste files, hold them as
// base64 until send, then push each into the host clipboard for the CLI to read.
// Extracted verbatim from MobileKeyboard.
export function useAttachments({ bus, sessionId }: UseAttachmentsOptions) {
  const { t } = useI18n();
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const attachIdRef = useRef(0);

  const fileToAttachment = useCallback((file: File): Promise<AttachmentItem | null> => new Promise((resolve) => {
    if (file.size > MAX_ATTACHMENT_SIZE) { alert(t("mobileKeyboard.fileTooLarge")); return resolve(null); }
    const reader = new FileReader();
    reader.onload = () => {
      const content = (reader.result as string).split(",")[1];
      const isImage = file.type.startsWith("image/");
      const name = file.name || `paste_${attachIdRef.current}.${isImage ? (file.type.split("/")[1] || "png") : "bin"}`;
      resolve({ id: ++attachIdRef.current, name, type: file.type, size: file.size, content, isImage });
    };
    reader.onerror = () => { alert(t("mobileKeyboard.readFileFailed")); resolve(null); };
    reader.readAsDataURL(file);
  }), [t]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return;
    const picked = Array.from(files).slice(0, room);
    const results = await Promise.all(picked.map(fileToAttachment));
    const entries = results.filter((item): item is AttachmentItem => item !== null);
    if (entries.length) { vibrate(); setAttachments((prev) => [...prev, ...entries]); }
  }, [attachments.length, fileToAttachment]);

  const removeAttachment = useCallback((id: number) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Push one attachment into the host OS clipboard + Ctrl+V, waiting for ack so
  // the CLI reads it before the next overwrites the clipboard.
  const sendOneAttachment = useCallback((att: AttachmentItem) => new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // No bus (foreign pane still connecting) — drop the attachment rather than
    // throwing; the timeout resolves the batch either way.
    bus?.emit("clipboard-attach", { sessionId, filename: att.name, type: att.type, content: att.content }, finish);
    setTimeout(finish, CLIPBOARD_ATTACH_TIMEOUT);
  }), [bus, sessionId]);

  const handleFileUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    vibrate();
    const files = event.target.files;
    if (files?.length) await addFiles(files);
    event.target.value = "";
  }, [addFiles]);

  // Paste on the input: attach any image/file items; let text paste fall through.
  const handleAttachPaste = useCallback((e: ClipboardEvent<any>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  return {
    attachments, setAttachments,
    addFiles, removeAttachment, sendOneAttachment, handleFileUpload, handleAttachPaste
  };
}
