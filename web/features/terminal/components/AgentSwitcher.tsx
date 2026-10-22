"use client";

import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronUp, Pencil, Trash2, Check, X } from "@/shared/components/ui/Icon";
import { maskApiKey } from "@/shared/utils/formatters";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";

// Deterministic accent per card slot — stable color regardless of key order changes
const ACCENTS = [
  { name: "indigo", rgb: "99,102,241", angle: "0% 0%" },
  { name: "green", rgb: "34,197,94", angle: "100% 0%" },
  { name: "amber", rgb: "245,158,11", angle: "0% 100%" },
  { name: "pink", rgb: "236,72,153", angle: "100% 100%" },
  { name: "cyan", rgb: "6,182,212", angle: "50% 0%" }
];

const accentOf = (i: number) => ACCENTS[i % ACCENTS.length];

// Relative time label
function relTime(iso: any, t: any): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return t("login.justNow");
  if (m < 60) return t("login.minutesAgo", { n: m });
  if (h < 24) return t("login.hoursAgo", { n: h });
  if (d < 7) return t("login.daysAgo", { n: d });
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Pure-CSS MacBook illustration; accent tints the screen glow + active code line
function MacBook({ accent }: { accent: { name: string; rgb: string; angle: string } }) {
  return (
    <div className="as-mac" style={{ "--accent-rgb": accent.rgb, "--accent-angle": accent.angle } as React.CSSProperties}>
      <div className="as-mac__screen">
        <span className="as-mac__cam" />
        <div className="as-mac__desk">
          <div className="as-mac__bar"><i /><i /><i /></div>
          <div className="as-mac__lns">
            <span className="as-mac__ln a" />
            <span className="as-mac__ln b" />
            <span className="as-mac__ln c" />
            <span className="as-mac__ln b" />
          </div>
        </div>
      </div>
      <div className="as-mac__base"><span className="as-mac__notch" /></div>
    </div>
  );
}

export interface AgentSwitcherProps {
  variant?: "login" | "menu";
  keys?: any[];
  currentApiKey?: string | null;
  onSelect?: (key: any) => void;
  loadingKey?: string | null;
}

/**
 * AgentSwitcher — card grid of saved API keys rendered as colored MacBooks.
 * variant="login": inline block replacing the saved-keys list.
 * variant="menu":  fixed-bottom dock inside the slide menu (shown only when >1 key).
 *
 * Edit mode (pencil in header): cards wiggle, labels become rename inputs,
 * each card gets a delete (×) button. Tap a card outside edit mode = connect.
 */
export default function AgentSwitcher({
  variant = "login",
  keys = [],
  currentApiKey = null,
  onSelect,
  loadingKey = null
}: AgentSwitcherProps) {
  const { t } = useI18n();
  const { renameKey, removeKey, moveKey, loadKeys } = useApiKeyStorage();
  // Local copy so rename/delete reflect immediately without parent re-render
  const [localKeys, setLocalKeys] = useState<any[]>(keys);
  useEffect(() => { setLocalKeys(keys); }, [keys]);
  const refresh = useCallback(() => setLocalKeys(loadKeys()), [loadKeys]);

  const [editMode, setEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);

  const enterRename = useCallback((item: any) => {
    setEditingId(item.id);
    setDraft(item.label || "");
  }, []);

  const commitRename = useCallback(() => {
    if (editingId) {
      renameKey(editingId, draft.trim());
      refresh();
    }
    setEditingId(null);
  }, [editingId, draft, renameKey, refresh]);

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    removeKey(pendingDelete.id);
    refresh();
    setPendingDelete(null);
  }, [pendingDelete, removeKey, refresh]);

  if (localKeys.length === 0) return null;
  const isMenu = variant === "menu";
  if (isMenu && localKeys.length < 2) return null;

  return (
    <div className={`as-root ${isMenu ? "as-menu" : "as-login"}`}>
      <div className="as-head">
          <h3>{t("agentSwitcher.title")}</h3>
          <button
            type="button"
            onClick={() => { vibrate(); setEditMode((v) => !v); setEditingId(null); }}
            className={`as-edit-btn ${editMode ? "as-edit-btn--on" : ""}`}
            aria-label={editMode ? t("common.done") : t("common.edit")}
            title={editMode ? t("common.done") : t("common.edit")}
          >
            {editMode ? <Check size={15} /> : <Pencil size={15} />}
          </button>
        </div>

        <div className={`as-row ${editMode ? "as-row--edit" : ""}`}>
          {localKeys.map((item, i) => {
            const accent = accentOf(i);
            const isActive = !isMenu && currentApiKey && item.key === currentApiKey;
            const isEditing = editingId === item.id;
            const isLoading = loadingKey === item.key;
            return (
              <div
                key={item.id}
                className={`as-card ${isActive ? "as-card--active" : ""}`}
                style={{ "--accent-rgb": accent.rgb, "--accent-angle": accent.angle } as React.CSSProperties}
                onClick={() => {
                  if (editMode || isEditing) return;
                  vibrate();
                  onSelect?.(item.key);
                }}
                role="button"
                tabIndex={0}
              >
                {isActive && (
                  <span className="as-on">
                    <span className="as-pulse" />
                    <span className="as-on-tx">{t("agentSwitcher.active")}</span>
                  </span>
                )}
                {editMode && !isEditing && (
                  <button
                    type="button"
                    className="as-del"
                    onClick={(e) => { e.stopPropagation(); vibrate(); setPendingDelete(item); }}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
                {editMode && !isEditing && (
                  // Reorder: saved-key order is the host list order everywhere
                  <div className="as-mv" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="as-mv-btn"
                      disabled={i === 0}
                      onClick={() => { vibrate(); moveKey(item.id, -1); refresh(); }}
                      aria-label={t("common.moveUp")}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      className="as-mv-btn"
                      disabled={i === localKeys.length - 1}
                      onClick={() => { vibrate(); moveKey(item.id, 1); refresh(); }}
                      aria-label={t("common.moveDown")}
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                )}
                <div className="as-mac-wrap">
                  <MacBook accent={accent} />
                </div>
                {isEditing ? (
                  <div className="as-rename" onClick={(e) => e.stopPropagation()}>
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      placeholder={t("login.namePlaceholder")}
                      className="as-rename-input"
                    />
                    <button type="button" className="as-rename-ok" onClick={commitRename}><Check size={13} /></button>
                    <button type="button" className="as-rename-x" onClick={() => setEditingId(null)}><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <div
                      className={`as-lbl ${editMode ? "as-lbl--edit" : ""}`}
                      onClick={editMode ? (e) => { e.stopPropagation(); vibrate(); enterRename(item); } : undefined}
                    >
                      {item.label || t("agentSwitcher.unnamed")}
                    </div>
                    <div className="as-sub">
                      {isLoading ? t("agentSwitcher.connecting") : relTime(item.lastLoginDate, t)}
                    </div>
                    <div className="as-key" title={item.key}>{maskApiKey(item.key)}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>

      {pendingDelete && (
        <div className="as-confirm-overlay" onClick={() => setPendingDelete(null)}>
          <div className="as-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="as-confirm-icon"><Trash2 size={22} /></div>
            <h4>{t("login.deleteKeyTitle")}</h4>
            <p>{t("login.deleteKeyConfirm", { name: pendingDelete.label })}</p>
            <div className="as-confirm-actions">
              <button type="button" className="as-confirm-cancel" onClick={() => setPendingDelete(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="as-confirm-del" onClick={confirmDelete}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        .as-login{padding:0}
        .as-menu{position:fixed;left:0;right:0;bottom:0;z-index:40;padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
        .as-root{width:100%;max-width:100%;box-sizing:border-box}
        .as-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px}
        .as-head h3{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--color-text-subtle,rgba(255,255,255,0.45));margin:0}
        .as-edit-btn{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;border:none;background:transparent;color:var(--color-text-muted,rgba(255,255,255,0.55));cursor:pointer;transition:all .15s}
        .as-edit-btn:hover{color:var(--color-text,#fff);background:var(--color-surface-2,rgba(255,255,255,0.06))}
        .as-edit-btn--on{background:var(--color-brand-500,#6366f1);color:#fff}
        .as-edit-btn--on:hover{background:var(--color-brand-600,#4f46e5);color:#fff}

        .as-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;width:100%;box-sizing:border-box}
        .as-menu .as-row{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:2px}
        .as-menu .as-card{flex:0 0 150px;scroll-snap-align:start}

        .as-card{position:relative;display:flex;flex-direction:column;align-items:center;padding:12px 10px 10px;border-radius:12px;background:var(--color-surface-2,rgba(255,255,255,0.04));border:1px solid var(--color-border-subtle,rgba(255,255,255,0.08));box-sizing:border-box;cursor:pointer;user-select:none;transition:transform .15s,border-color .15s,background .15s;outline:none;text-align:center}
        .as-card:hover{background:var(--color-surface-3,rgba(255,255,255,0.07));border-color:rgba(var(--accent-rgb),0.35);transform:translateY(-1px)}
        .as-card--active{background:rgba(var(--accent-rgb),0.08);border-color:rgba(var(--accent-rgb),0.55);box-shadow:0 0 0 1px rgba(var(--accent-rgb),0.3)}
        .as-card:active{transform:scale(0.98)}

        .as-row--edit .as-card{cursor:default;animation:as-wiggle .25s ease-in-out infinite alternate}
        .as-row--edit .as-card:nth-child(2n){animation-delay:.08s}
        .as-row--edit .as-card:nth-child(3n){animation-delay:.16s}
        .as-row--edit .as-card:hover{transform:none}
        @keyframes as-wiggle{0%{transform:rotate(-0.4deg)}100%{transform:rotate(0.4deg)}}

        .as-on{position:absolute;top:6px;right:6px;display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:999px;background:rgba(34,197,94,0.15);color:#4ade80;font-size:9.5px;font-weight:600}
        .as-pulse{width:5px;height:5px;border-radius:50%;background:#4ade80;box-shadow:0 0 6px #4ade80}

        .as-del{position:absolute;top:6px;right:6px;z-index:2;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:none;background:var(--color-danger,#ef4444);color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);transition:transform .1s}
        .as-del:hover{transform:scale(1.1)}

        .as-mv{position:absolute;top:6px;left:6px;z-index:2;display:flex;flex-direction:column;gap:2px}
        .as-mv-btn{display:flex;align-items:center;justify-content:center;width:18px;height:14px;border-radius:3px;border:none;background:var(--color-surface-3,rgba(255,255,255,0.15));color:var(--color-text,#fff);cursor:pointer;padding:0}
        .as-mv-btn:disabled{opacity:.25;cursor:default}

        .as-mac-wrap{width:100%;display:flex;justify-content:center;margin-bottom:6px}
        .as-mac{width:90px;display:flex;flex-direction:column;align-items:center}
        .as-mac__screen{width:76px;height:48px;border-radius:5px 5px 1px 1px;background:#050507;border:1.5px solid #222228;position:relative;display:flex;flex-direction:column;align-items:center;padding:3px;box-sizing:border-box;box-shadow:0 0 16px -2px rgba(var(--accent-rgb),0.35)}
        .as-mac__cam{width:2px;height:2px;border-radius:50%;background:#444;position:absolute;top:1.5px;left:50%;transform:translateX(-50%)}
        .as-mac__desk{width:100%;height:100%;border-radius:2px;background:radial-gradient(ellipse at var(--accent-angle,100% 0%),rgba(var(--accent-rgb),0.25) 0%,#09090d 75%);display:flex;flex-direction:column;padding:2px 3px;box-sizing:border-box;overflow:hidden}
        .as-mac__bar{display:flex;gap:2px;margin-bottom:3px}
        .as-mac__bar i{display:inline-block;width:2.5px;height:2.5px;border-radius:50%;background:#ffffff22}
        .as-mac__bar i:first-child{background:#ff5f56;box-shadow:0 0 2px #ff5f56}
        .as-mac__bar i:nth-child(2){background:#ffbd2e}
        .as-mac__bar i:nth-child(3){background:#27c93f}
        .as-mac__lns{display:flex;flex-direction:column;gap:2px}
        .as-mac__ln{height:2px;border-radius:1px;background:#ffffff15}
        .as-mac__ln.a{width:60%;background:rgba(var(--accent-rgb),0.85);box-shadow:0 0 4px rgba(var(--accent-rgb),0.5)}
        .as-mac__ln.b{width:80%}
        .as-mac__ln.c{width:45%}
        .as-mac__base{width:90px;height:4px;border-radius:0 0 4px 4px;background:linear-gradient(to bottom,#404048,#232328);position:relative;box-shadow:0 2px 4px rgba(0,0,0,0.5)}
        .as-mac__notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:14px;height:2px;border-radius:0 0 2px 2px;background:#18181c}

        .as-lbl{font-size:12px;font-weight:600;color:var(--color-text,#fff);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
        .as-lbl--edit{border-bottom:1px dashed var(--color-border,#555);cursor:pointer}
        .as-sub{font-size:10px;color:var(--color-text-subtle,rgba(255,255,255,0.4));margin-top:2px;line-height:1.2}
        .as-key{font-size:9.5px;font-family:monospace;color:var(--color-text-muted,rgba(255,255,255,0.55));margin-top:2px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

        .as-rename{display:flex;align-items:center;gap:3px;width:100%;margin-top:2px}
        .as-rename-input{flex:1;min-width:0;height:20px;font-size:11px;padding:0 4px;border-radius:4px;border:1px solid var(--color-brand-500,#6366f1);background:var(--color-surface,#000);color:var(--color-text,#fff);outline:none}
        .as-rename-ok,.as-rename-x{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:4px;border:none;cursor:pointer;padding:0}
        .as-rename-ok{background:var(--color-brand-500,#6366f1);color:#fff}
        .as-rename-x{background:var(--color-surface-3,rgba(255,255,255,0.1));color:var(--color-text,#fff)}

        .as-confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px}
        .as-confirm{width:100%;max-width:320px;border-radius:14px;background:var(--color-surface-2,#1a1a20);border:1px solid var(--color-border-subtle,rgba(255,255,255,0.1));padding:18px;text-align:center;box-shadow:0 12px 36px rgba(0,0,0,0.5)}
        .as-confirm-icon{width:44px;height:44px;border-radius:50%;background:rgba(239,68,68,0.15);color:#ef4444;display:flex;align-items:center;justify-content:center;margin:0 auto 10px}
        .as-confirm h4{font-size:14px;font-weight:600;color:var(--color-text,#fff);margin:0 0 6px}
        .as-confirm p{font-size:12px;color:var(--color-text-muted,rgba(255,255,255,0.6));margin:0 0 14px;word-break:break-word}
        .as-confirm-actions{display:flex;gap:8px}
        .as-confirm-cancel,.as-confirm-del{flex:1;height:32px;border-radius:8px;font-size:12px;font-weight:500;border:none;cursor:pointer;transition:all .15s}
        .as-confirm-cancel{background:var(--color-surface-3,rgba(255,255,255,0.1));color:var(--color-text,#fff)}
        .as-confirm-del{background:#ef4444;color:#fff}
        .as-confirm-del:hover{background:#dc2626}
      `}</style>
    </div>
  );
}
