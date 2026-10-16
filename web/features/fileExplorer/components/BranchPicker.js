"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, GitBranch, GitFork, Loader2, Plus, Search } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

const MENU_WIDTH = 260;
const VIEWPORT_MARGIN = 8;

// Searchable branch list anchored under the branch name. A remote ref ("origin/x") that
// already has a local twin is hidden: picking it would just land on the local one.
export default function BranchPicker({ anchor, branches, loading, onSelect, onCreate, onClose }) {
  const { t } = useI18n();
  const ref = useRef(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(anchor.x, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const top = Math.min(anchor.y, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    el.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
    el.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
  }, [anchor, branches.length]);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onEsc = (e) => { if (e.key === "Escape") onClose(); };
    // Deferred so the click that opened the picker does not close it.
    const id = setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("keydown", onEsc);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const { local, remote, exact } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const localNames = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
    const match = (b) => !q || b.name.toLowerCase().includes(q);
    const hasLocalTwin = (b) => localNames.has(b.name.slice(b.name.indexOf("/") + 1));
    return {
      local: branches.filter((b) => !b.isRemote && match(b)),
      remote: branches.filter((b) => b.isRemote && !hasLocalTwin(b) && match(b)),
      exact: branches.some((b) => b.name === query.trim())
    };
  }, [branches, query]);

  const name = query.trim();
  const canCreate = name && !exact;
  const empty = !local.length && !remote.length;

  const row = (b) => {
    const blocked = b.checkedOut && !b.isCurrent;
    return (
      <button
        key={b.name}
        type="button"
        disabled={b.isCurrent || blocked}
        onClick={() => { vibrate(); onSelect(b); }}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
          b.isCurrent || blocked ? "text-text-subtle cursor-default" : "text-text hover:bg-surface-2"
        }`}
        title={blocked ? t("git.branchInWorktree") : b.name}
      >
        {b.isCurrent ? <Check size={12} className="flex-shrink-0 text-brand-500" />
          : blocked ? <GitFork size={12} className="flex-shrink-0" />
            : <GitBranch size={12} className="flex-shrink-0 text-text-muted" />}
        <span className="flex-1 truncate">{b.name}</span>
        {b.isCurrent && <span className="text-[10px] text-text-muted">{t("git.branchCurrent")}</span>}
        {blocked && <span className="text-[10px] text-text-muted truncate max-w-[40%]">{t("git.branchInWorktree")}</span>}
      </button>
    );
  };

  const header = (label) => (
    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
  );

  return (
    <div
      ref={ref}
      className="fixed z-50 flex flex-col max-h-[min(360px,70vh)] rounded-lg border border-border bg-surface shadow-elev animate-in fade-in"
      style={{ left: anchor.x, top: anchor.y, width: MENU_WIDTH }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Search size={12} className="text-text-muted flex-shrink-0" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCreate && empty) onCreate(name);
          }}
          placeholder={t("git.branchSearch")}
          className="flex-1 min-w-0 bg-transparent text-xs text-text placeholder-text-subtle focus:outline-none"
        />
        {loading && <Loader2 size={12} className="animate-spin text-text-muted flex-shrink-0" />}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable pb-1">
        {local.length > 0 && <>{header(t("git.branchLocal"))}{local.map(row)}</>}
        {remote.length > 0 && <>{header(t("git.branchRemote"))}{remote.map(row)}</>}
        {empty && !loading && !canCreate && (
          <div className="px-3 py-3 text-xs text-text-muted">{t("git.branchNone")}</div>
        )}
        {canCreate && (
          <button
            type="button"
            onClick={() => { vibrate(); onCreate(name); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-text hover:bg-surface-2 border-t border-border mt-1"
          >
            <Plus size={12} className="flex-shrink-0 text-text-muted" />
            <span className="truncate">{t("git.branchCreate", { name })}</span>
          </button>
        )}
      </div>
    </div>
  );
}
