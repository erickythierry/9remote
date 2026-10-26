"use client";

import React, { useEffect, useState, useRef } from "react";
import { Filemanager, WillowDark, Willow, type IApi, type IEntity } from "@svar-ui/react-filemanager";
import "@svar-ui/react-filemanager/all.css";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { Loader2 } from "@/shared/components/ui/Icon";

interface FileBusItem {
  path: string;
  name: string;
  type?: string;
  size?: number;
  modified?: number | string | Date;
}

interface FileBusResult {
  success?: boolean;
  files?: FileBusItem[];
}

interface FileBusService {
  getFiles: (path: string, showHidden?: boolean) => Promise<unknown>;
  createItem?: (path: string, type: string) => Promise<unknown>;
  renameItem?: (oldPath: string, newPath: string) => Promise<unknown>;
  deleteItem?: (path: string) => Promise<unknown>;
  moveItem?: (oldPath: string, newPath: string) => Promise<unknown>;
  copyItem?: (oldPath: string, newPath: string) => Promise<unknown>;
  downloadFile?: (path: string, options: { onSave: (blob: Blob) => void }) => void;
  uploadFiles?: (targetDir: string, items: { file: File; relativePath: string }[]) => Promise<unknown>;
}

const BRAND_VARS = {
  "--wx-color-primary": "var(--color-brand-300)",
  "--wx-color-primary-selected": "color-mix(in srgb, var(--color-brand-300) 18%, transparent)",
} as React.CSSProperties;

interface SvarFileManagerProps {
  initialPath: string;
  fileBus: FileBusService;
  onOpenFile?: (path: string) => void;
}

export default function SvarFileManager({
  initialPath,
  fileBus,
  onOpenFile,
}: SvarFileManagerProps) {
  const { theme } = useTheme();
  const isDark = theme !== "light";
  const [loading, setLoading] = useState(true);
  const [initialData, setInitialData] = useState<IEntity[]>([]);
  const apiRef = useRef<IApi | null>(null);

  const normalizedPath = initialPath.replace(/\/+$/, "") || "/";

  useEffect(() => {
    let cancelled = false;

    async function loadInitial() {
      setLoading(true);
      try {
        const res = (await fileBus.getFiles(normalizedPath, true)) as FileBusResult | undefined;
        if (cancelled) return;

        const segments = normalizedPath.split("/").filter(Boolean);
        const ancestors: IEntity[] = [];
        let acc = "";
        for (const seg of segments) {
          acc = `${acc}/${seg}`;
          ancestors.push({
            id: acc,
            name: seg,
            type: "folder",
            open: true,
            lazy: false,
          });
        }

        const files = (res?.files || []) as FileBusItem[];
        const children: IEntity[] = files.map((f) => ({
          id: f.path,
          name: f.name,
          type: f.type === "folder" ? "folder" : "file",
          size: f.size || 0,
          date: f.modified ? new Date(f.modified) : new Date(),
          lazy: f.type === "folder",
        }));

        setInitialData([...ancestors, ...children]);
      } catch (e) {
        console.error("Failed to load initial files for file manager:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadInitial();
    return () => {
      cancelled = true;
    };
  }, [normalizedPath, fileBus]);

  const initApi = (api: IApi) => {
    apiRef.current = api;

    api.on("request-data", async ({ id }: { id: string }) => {
      try {
        const res = (await fileBus.getFiles(id, true)) as FileBusResult | undefined;
        if (res?.success && Array.isArray(res.files)) {
          const files = res.files as FileBusItem[];
          const items: IEntity[] = files.map((f) => ({
            id: f.path,
            name: f.name,
            type: f.type === "folder" ? "folder" : "file",
            size: f.size || 0,
            date: f.modified ? new Date(f.modified) : new Date(),
            lazy: f.type === "folder",
          }));
          api.exec("provide-data", { id, data: items });
        }
      } catch (err) {
        console.error("Error loading folder contents:", err);
      }
    });

    api.on("create-file", async (ev: { file: { name: string; type?: "file" | "folder"; file?: File }; parent: string }) => {
      try {
        if (ev.file?.file) {
          fileBus.uploadFiles?.(ev.parent, [{ file: ev.file.file, relativePath: ev.file.name }]);
        } else {
          const parent = ev.parent === "/" ? "" : ev.parent;
          const itemPath = `${parent}/${ev.file.name}`;
          await fileBus.createItem?.(itemPath, ev.file.type || "file");
        }
      } catch (err) {
        console.error("Error creating item:", err);
      }
    });

    api.on("rename-file", async (ev: { id: string; name: string }) => {
      try {
        const oldPath = ev.id;
        const lastSlash = oldPath.lastIndexOf("/");
        const parent = lastSlash <= 0 ? "/" : oldPath.slice(0, lastSlash);
        const newPath = `${parent === "/" ? "" : parent}/${ev.name}`;
        await fileBus.renameItem?.(oldPath, newPath);
      } catch (err) {
        console.error("Error renaming item:", err);
      }
    });

    api.on("delete-files", async (ev: { ids: string[] }) => {
      try {
        if (Array.isArray(ev.ids)) {
          for (const id of ev.ids) {
            await fileBus.deleteItem?.(id);
          }
        }
      } catch (err) {
        console.error("Error deleting items:", err);
      }
    });

    api.on("move-files", async (ev: { ids: string[]; target: string }) => {
      try {
        if (Array.isArray(ev.ids)) {
          const target = ev.target === "/" ? "" : ev.target;
          for (const id of ev.ids) {
            const name = id.slice(id.lastIndexOf("/") + 1);
            const dest = `${target}/${name}`;
            if (fileBus.moveItem) {
              await fileBus.moveItem(id, dest);
            } else if (fileBus.renameItem) {
              await fileBus.renameItem(id, dest);
            }
          }
        }
      } catch (err) {
        console.error("Error moving items:", err);
      }
    });

    api.on("copy-files", async (ev: { ids: string[]; target: string }) => {
      try {
        if (Array.isArray(ev.ids)) {
          const target = ev.target === "/" ? "" : ev.target;
          for (const id of ev.ids) {
            const name = id.slice(id.lastIndexOf("/") + 1);
            const dest = `${target}/${name}`;
            await fileBus.copyItem?.(id, dest);
          }
        }
      } catch (err) {
        console.error("Error copying items:", err);
      }
    });

    api.on("download-file", (ev: { id: string }) => {
      try {
        if (ev.id && fileBus.downloadFile) {
          const name = ev.id.slice(ev.id.lastIndexOf("/") + 1);
          fileBus.downloadFile(ev.id, {
            onSave: (blob: Blob) => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = name;
              a.click();
              URL.revokeObjectURL(url);
            },
          });
        }
      } catch (err) {
        console.error("Error downloading file:", err);
      }
    });

    api.on("open-file", (ev: { id: string }) => {
      if (ev.id && onOpenFile) {
        onOpenFile(ev.id);
      }
    });
  };

  const ThemeWrapper = isDark ? WillowDark : Willow;

  if (loading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-surface-1 text-text-muted text-xs">
        <Loader2 className="animate-spin text-brand-500" size={24} />
        <span>Carregando arquivos...</span>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden bg-surface-1 select-none [&_.wx-theme]:h-full [&_.wx-theme]:w-full">
      <ThemeWrapper>
        {/* Inline vars: Tailwind utilities sit in @layer and lose to SVAR's unlayered theme CSS */}
        <div className="w-full h-full" style={BRAND_VARS}>
          <Filemanager
            data={initialData}
            panels={[{ path: normalizedPath }]}
            init={initApi}
          />
        </div>
      </ThemeWrapper>
    </div>
  );
}
