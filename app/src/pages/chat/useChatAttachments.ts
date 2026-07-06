import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TFunction } from "i18next";
import { ingestFile, ingestPath, type Attachment } from "@/lib/llm/attachments";

interface UseChatAttachmentsOptions {
  t: TFunction;
  bindWorkspace: (path: string) => Promise<void>;
  setStreamError: (message: string | null) => void;
}

export function useChatAttachments({
  t,
  bindWorkspace,
  setStreamError,
}: UseChatAttachmentsOptions) {
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([]);
  const bindWorkspaceRef = useRef(bindWorkspace);
  const tRef = useRef(t);
  const setStreamErrorRef = useRef(setStreamError);

  useEffect(() => {
    bindWorkspaceRef.current = bindWorkspace;
    tRef.current = t;
    setStreamErrorRef.current = setStreamError;
  }, [bindWorkspace, setStreamError, t]);

  function showAttachmentError(error: "unsupported" | "image-too-large" | "file-too-large" | "read-failed"): void {
    if (error === "image-too-large") {
      setStreamErrorRef.current(tRef.current("chat.attachments.imageTooLarge", { mb: 20 }));
      return;
    }
    setStreamErrorRef.current(tRef.current("chat.attachments.unsupportedType"));
  }

  async function addFiles(files: FileList | File[]): Promise<void> {
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      const res = await ingestFile(f);
      if ("error" in res) {
        showAttachmentError(res.error);
      } else {
        next.push(res);
      }
    }
    if (next.length) setDraftAttachments((prev) => [...prev, ...next]);
  }

  async function handleDroppedPaths(paths: string[]): Promise<void> {
    for (const p of [...new Set(paths)]) {
      const res = await ingestPath(p);
      if ("error" in res) {
        showAttachmentError(res.error);
      } else if (res.kind === "folder") {
        await bindWorkspaceRef.current(res.path);
      } else {
        setDraftAttachments((prev) => [...prev, res]);
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    let un: (() => void) | undefined;
    void listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
      void handleDroppedPaths(e.payload.paths ?? []);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        un = fn;
      }
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  function handlePaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function removeAttachment(id: string): void {
    setDraftAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  return {
    addFiles,
    draftAttachments,
    handlePaste,
    removeAttachment,
    setDraftAttachments,
  };
}
