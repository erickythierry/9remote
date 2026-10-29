"use client";

import React, { useEffect, useRef, useState, ReactNode, RefObject, MutableRefObject } from "react";
import Button from "@/shared/components/ui/Button";
import Btn from "@/shared/components/ui/KeyButton";
import {
  ChevronLeft, ChevronRight, RefreshCw, Keyboard, HelpCircle, Hand, Settings, MoreHorizontal, X, Bug, Monitor, Plus, CornerDownLeft, Mic, MicOff, History, Bell, Eye, EyeOff
} from "@/shared/components/ui/Icon";
import { useVoiceInput, localeToSpeechLang, useVoiceLang } from "@/shared/hooks/useVoiceInput";
import CommandSuggestions from "@/shared/components/ui/CommandSuggestions";
import CommandHistoryModal from "@/shared/components/ui/CommandHistoryModal";
import { useRemoteHistoryStore } from "@/shared/stores/historyStore";
import { vibrate } from "@/shared/utils/vibration";
import {
  REMOTE_CONFIG,
  REMOTE_KEY_POOL,
  REMOTE_DEFAULT_BOTTOM,
  REMOTE_DEFAULT_EXTRA,
  REMOTE_PINNED_KEY_ID,
  RemoteKeyPoolItem
} from "@/features/remote/constants/REMOTE_CONFIG";
import { useCustomKeys } from "@/shared/hooks/useCustomKeys";
import KeyCustomizeModal from "@/shared/components/ui/KeyCustomizeModal";
import { useI18n } from "@/shared/i18n";

const v = (fn?: (...args: any[]) => void, ...args: any[]) => { vibrate(); fn?.(...args); };

export interface RemoteControlsProps {
  streaming: boolean;
  canvasZoom: number;
  clipboardNew?: boolean;
  clipboardText?: string;
  onOpenClipboard?: () => void;
  selectionMode?: boolean;
  pointerMode?: string;
  handMode?: boolean;
  inputMode?: string;
  onToggleHandMode?: () => void;
  onTogglePointerMode?: () => void;
  modifierKeys: {
    ctrl: boolean;
    cmd: boolean;
    alt: boolean;
    shift: boolean;
    [key: string]: boolean;
  };
  textInputValue: string;
  textInputRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  keyboardOn?: boolean;
  showTextPanel?: boolean;
  onResetZoom?: () => void;
  onRefresh?: () => void;
  onToggleSelection?: () => void;
  onToggleModifier?: (modifier: "ctrl" | "cmd" | "alt" | "shift") => void;
  onToggleKeyboard?: () => void;
  onToggleTextPanel?: () => void;
  onToggleHelp?: () => void;
  onToggleDebug?: () => void;
  debugOn?: boolean;
  onEmitKey?: (key: string, modifiers?: string[], osAdaptive?: boolean) => void;
  onTextInputChange: (val: string) => void;
  onTextInputFocus?: () => void;
  onTextInputBlur?: () => void;
  onTextInputKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  onDirectInputChange?: (val: string) => void;
  onSendText?: (streaming: boolean) => void;
  onClose?: () => void;
  onDesktopSwitch?: (direction: string) => void;
  controlsHidden?: boolean;
  onToggleControlsHidden?: (hidden: boolean) => void;
  tallLandscape?: boolean;
}

export default function RemoteControls({
  streaming,
  canvasZoom,
  clipboardNew,
  clipboardText,
  onOpenClipboard,
  selectionMode,
  pointerMode,
  handMode,
  inputMode,
  onToggleHandMode,
  onTogglePointerMode,
  modifierKeys,
  textInputValue,
  textInputRef,
  keyboardOn,
  showTextPanel,
  onResetZoom,
  onRefresh,
  onToggleSelection,
  onToggleModifier,
  onToggleKeyboard,
  onToggleTextPanel,
  onToggleHelp,
  onToggleDebug,
  debugOn,
  onEmitKey,
  onTextInputChange,
  onTextInputFocus,
  onTextInputBlur,
  onTextInputKeyDown,
  onDirectInputChange,
  onSendText,
  onClose,
  onDesktopSwitch,
  controlsHidden,
  onToggleControlsHidden,
  tallLandscape
}: RemoteControlsProps) {
  const { t, locale } = useI18n();
  const panelInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [voiceLang] = useVoiceLang(locale);
  const [historyOpen, setHistoryOpen] = useState(false);
  const voice = useVoiceInput({
    lang: localeToSpeechLang(voiceLang),
    onText: (txt: string) => {
      onTextInputChange(txt);
      const el = panelInputRef.current;
      if (el) requestAnimationFrame(() => {
        try { el.selectionStart = el.selectionEnd = el.value.length; } catch {}
        el.scrollTop = el.scrollHeight;
      });
    },
  });

  useEffect(() => {
    const el = panelInputRef.current;
    if (!el || window.matchMedia("(orientation: landscape)").matches) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
  }, [textInputValue]);

  const toggleVoice = () => {
    if (voice.listening) { voice.stop(); return; }
    (document.activeElement as HTMLElement)?.blur();
    voice.start(textInputValue);
  };
  const sendText = () => {
    if (voice.listening) voice.stop();
    v(onSendText, streaming);
  };

  const landscapeRow = tallLandscape ? "" : "landscape:flex-wrap landscape:overflow-y-auto landscape:overflow-x-hidden landscape:py-2 landscape:pr-0 landscape:content-center landscape:justify-center";
  const rowClass = `flex gap-1.5 overflow-auto scroll-thin-x py-0.5 pr-2 ${landscapeRow} rounded-lg`;
  const [showExtra, setShowExtra] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);

  const [clipboardCountdown, setClipboardCountdown] = useState(0);
  useEffect(() => {
    if (!clipboardNew) { setClipboardCountdown(0); return; }
    setClipboardCountdown(Math.ceil(REMOTE_CONFIG.clipboardBadgeTimeout / 1000));
    const id = setInterval(() => {
      setClipboardCountdown(n => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [clipboardNew, clipboardText]);

  const bottomCustom = useCustomKeys("remoteDesktop.bottomKeys", REMOTE_KEY_POOL as any, REMOTE_DEFAULT_BOTTOM, "flat");
  const extraCustom = useCustomKeys("remoteDesktop.extraKeys", REMOTE_KEY_POOL as any, REMOTE_DEFAULT_EXTRA, "grid");

  useEffect(() => {
    if (!showTextPanel) return;
    const timer = setTimeout(() => panelInputRef.current?.focus(), 350);
    return () => clearTimeout(timer);
  }, [showTextPanel]);

  const pcCfg = REMOTE_CONFIG.pcModeControls;
  const show = (k: string) => inputMode !== "mouse" || (pcCfg as any)[k];
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  const renderPoolKey = (kc: any, idx: string | number, pinned = false, extraClass = "") => {
    const textCls = kc.label.length > 1 ? "text-[11px]" : "";
    const cls = `${extraClass} ${textCls}`.trim();
    if (kc.type === "modifier") {
      return (
        <Btn
          key={kc.id + idx}
          onClick={() => v(onToggleModifier, kc.modifier)}
          disabled={!streaming}
          active={kc.modifier ? modifierKeys[kc.modifier] : false}
          pinned={pinned}
          className={cls}
        >
          {kc.label}
        </Btn>
      );
    }
    if (kc.type === "desktop") {
      if (!onDesktopSwitch) return null;
      const SideIcon = kc.direction === "prev" ? ChevronLeft : kc.direction === "next" ? ChevronRight : Plus;
      return (
        <Btn
          key={kc.id + idx}
          onClick={() => v(onDesktopSwitch, kc.direction)}
          disabled={!streaming}
          pinned={pinned}
          className={cls}
          title={`${kc.direction} desktop`}
        >
          <Monitor size={12} />
          <SideIcon size={kc.direction === "new" ? 10 : 12} className="-ml-0.5" />
        </Btn>
      );
    }
    return (
      <Btn
        key={kc.id + idx}
        onClick={() => v(onEmitKey, kc.key, kc.modifiers || [], kc.osAdaptive)}
        disabled={!streaming}
        primary={!pinned && kc.primary}
        pinned={pinned}
        className={cls}
      >
        {kc.label}
      </Btn>
    );
  };

  return (
    <div className={`bg-bg select-none relative landscape:flex landscape:flex-col landscape:shrink-0 ${tallLandscape || controlsHidden ? "" : "landscape:h-full landscape:justify-end"} ${controlsHidden ? "landscape:w-12" : tallLandscape ? "landscape:w-full landscape:pl-12" : "landscape:w-64"}`}>
      {/* Hidden sink drives native keyboard. */}
      <textarea
        ref={textInputRef as any}
        rows={1}
        value={textInputValue}
        onChange={(e) => {
          if (keyboardOn) onDirectInputChange?.(e.target.value);
          else onTextInputChange(e.target.value);
        }}
        onKeyDown={onTextInputKeyDown}
        onFocus={onTextInputFocus}
        onBlur={onTextInputBlur}
        aria-hidden="true"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        name="remote-keyboard-sink"
        style={{
          position: "absolute", opacity: 0.01, width: 1, height: 1, border: 0, padding: 0,
          left: 0, top: 0, fontSize: 16, resize: "none", pointerEvents: "none", zIndex: -1
        }}
      />

      {/* Eye (collapse sidebar) — absolute top-right, landscape only, hidden when already collapsed */}
      <div className={`absolute top-1 right-1 z-30 ${controlsHidden || tallLandscape ? "hidden" : "hidden landscape:flex"}`}>
        <Btn onClick={() => { vibrate(); onToggleControlsHidden?.(true); }} title={t("remote.hideControls")}>
          <EyeOff size={14} />
        </Btn>
      </div>

      {/* Full controls — hidden in landscape when controlsHidden */}
      <div className={controlsHidden ? "landscape:hidden" : "contents"}>
      <div className={`${showTextPanel ? "flex" : "hidden"} landscape:flex ${tallLandscape ? "" : "landscape:flex-col"} relative z-30 px-2 py-1 gap-2 ${tallLandscape ? "landscape:px-0" : "landscape:gap-1 landscape:order-last"}`}>
        <div className="relative flex-1">
          <CommandSuggestions
            value={textInputValue}
            store={useRemoteHistoryStore}
            isMobile={isMobile}
            onSelect={(cmd) => { onTextInputChange(cmd); panelInputRef.current?.focus(); }}
          />
          <textarea
            ref={panelInputRef}
            rows={1}
            cols={1}
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            onFocus={onTextInputFocus}
            onKeyDown={(e) => {
              if (inputMode === "mouse" && e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (streaming) sendText();
              }
            }}
            placeholder={inputMode === "mouse" ? t("remoteControls.enterToSend") : t("remoteControls.typeToSend")}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            name="remote-batch-input"
            className={`block w-full px-3 py-2 pr-8 bg-surface-2 rounded text-text text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out resize-none overflow-y-auto ${tallLandscape ? "" : "landscape:!h-16"}`}
            disabled={!streaming}
          />
          {textInputValue ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onTextInputChange(""); panelInputRef.current?.focus(); }}
              title={t("voice.clear")}
              className="absolute right-1.5 top-1.5 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
            >
              <X size={14} />
            </button>
          ) : (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setHistoryOpen(true)}
              title={t("history.title")}
              className="absolute right-1.5 top-1.5 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
            >
              <History size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-2 items-center justify-end">
        {voice.active && (
          <div className="relative shrink-0">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleVoice}
              disabled={!streaming}
              title={voice.error === "not-allowed" || voice.error === "service-not-allowed" ? t("voice.denied") : t("voice.dictate")}
              className={`h-9 w-9 flex items-center justify-center rounded-full transition-all duration-150 ease-out disabled:opacity-40 ${
                voice.listening ? "bg-red-500/90 text-white animate-pulse" : voice.error ? "bg-surface-2 text-red-400" : "bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text"
              }`}
            >
              {voice.listening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          </div>
        )}
        <Button
          variant="primary"
          size="sm"
          className="!px-2.5 shrink-0"
          onMouseDown={(e) => e.preventDefault()}
          onClick={sendText}
          disabled={!streaming}
        >
          {textInputValue.trim() ? t("remoteControls.send") : <CornerDownLeft size={16} strokeWidth={2.5} />}
        </Button>
        </div>
      </div>

      {/* Extra keys panel — slides in ABOVE toolbar, 3 scrollable rows */}
      <div
        className={`overflow-hidden transition-all duration-300 ${showExtra ? "max-h-56 opacity-100" : "hidden"}`}
      >
        <div className="px-2 py-1">
          <div className="space-y-1">
            {extraCustom.rows.map((row: string[], rIdx: number) => (
              <div key={rIdx} className="flex items-center gap-1.5">
                <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto scroll-thin-x pr-3 rounded-lg">
                  {row.map((id: string, cIdx: number) => {
                    const kc = REMOTE_KEY_POOL.find(p => p.id === id);
                    return kc ? renderPoolKey(kc, rIdx * 100 + cIdx) : null;
                  })}
                </div>
                {rIdx === 0 && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { vibrate(); setShowCustomize(true); }}
                    className="shrink-0 h-10 w-10 flex items-center justify-center text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-all duration-150 ease-out"
                    title={t("remote.customizeKeys")}
                  >
                    <Settings size={16} />
                  </button>
                )}
                {rIdx > 0 && <div className="shrink-0 h-10 w-10" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top toolbar — portrait only */}
      <div className="flex items-center gap-1.5 px-2 py-1 landscape:hidden">
        <div className={`${rowClass} flex-1 min-w-0 px-0 py-0 landscape:py-0`}>
          {onClose && (
            <Btn onClick={() => v(onClose)} title={t("remote.back")} pinned className="landscape:hidden">
              <ChevronLeft size={16} />
            </Btn>
          )}
          {clipboardNew && clipboardText ? (
            <Btn
              onClick={() => v(onOpenClipboard)}
              className="!text-red-500 landscape:hidden"
              title={t("common.clipboard")}
            >
              <Bell size={14} className="shrink-0" />
              <span className="tabular-nums">{clipboardCountdown}</span>
            </Btn>
          ) : (
            <Btn onClick={() => v(onResetZoom)} disabled={!streaming} className="text-text landscape:hidden" title={t("remote.resetZoom")}>
              {Math.round(canvasZoom * 100)}%
            </Btn>
          )}
          <Btn onClick={() => v(onRefresh)} disabled={!streaming} title={t("remote.refresh")} className="landscape:hidden">
            <RefreshCw size={14} />
          </Btn>
          {show("rectangleSelect") && (
            <Btn onClick={() => v(onToggleSelection)} disabled={!streaming} active={selectionMode} title={t("remote.rectangleSelection")} className="landscape:hidden">
              □
            </Btn>
          )}
          {show("pointerModeToggle") && (
            <Btn
              onClick={() => v(onTogglePointerMode)}
              disabled={!streaming}
              active={pointerMode === "trackpad"}
              title={pointerMode === "trackpad" ? t("remoteControls.trackpadMode") : t("remoteControls.directMode")}
              className="landscape:hidden"
            >
              <span className="text-base leading-none">🖱️</span>
            </Btn>
          )}
          {show("handMode") && pointerMode === "trackpad" && (
            <Btn
              onClick={() => v(onToggleHandMode)}
              disabled={!streaming}
              active={handMode}
              title={t("remote.handMode")}
              className="landscape:hidden"
            >
              <Hand size={14} />
            </Btn>
          )}
          {show("keyboardToggle") && (
            <Btn onClick={() => v(onToggleKeyboard)} disabled={!streaming} active={keyboardOn} title={t("remote.toggleKeyboard")} className="landscape:hidden">
              <Keyboard size={14} />
            </Btn>
          )}
          {show("textPanel") && (
            <Btn onClick={() => v(onToggleTextPanel)} disabled={!streaming} active={showTextPanel} title={t("remote.textBatchInput")} className="landscape:hidden">
              Aa
            </Btn>
          )}
          {show("help") && (
            <Btn onClick={() => v(onToggleHelp)} title={t("remote.help")} className="landscape:hidden">
              <HelpCircle size={14} />
            </Btn>
          )}
        </div>
        {/* Pinned extra keys toggle — portrait only, outside scroll */}
        <Btn onClick={() => { vibrate(); setShowExtra(s => !s); }} active={showExtra} pinned className="landscape:hidden shrink-0" title={t("remote.extraKeys")}>
          {showExtra ? <X size={16} /> : <MoreHorizontal size={16} />}
        </Btn>
      </div>

      {/* Bottom row (customizable) — pin Enter at end. */}
      {show("modifierRow") && (() => {
        const mods = bottomCustom.keys.filter((kc: any) => kc.id !== REMOTE_PINNED_KEY_ID);
        const pinned = REMOTE_KEY_POOL.find(p => p.id === REMOTE_PINNED_KEY_ID);
        const extraBtn = (
          <Btn onClick={() => { vibrate(); setShowExtra(s => !s); }} active={showExtra} pinned title={t("remote.extraKeys")}>
            {showExtra ? <X size={16} /> : <MoreHorizontal size={16} />}
          </Btn>
        );
        const enterBtn = pinned ? renderPoolKey(pinned, "pinned", true) : null;
        return (
          <div className={`px-2 py-1 ${inputMode === "mouse" ? "" : "safe-area-bottom"} ${tallLandscape ? "landscape:px-0" : "landscape:py-2"}`}>
            {/* Portrait: modifier scroll + pinned Enter */}
            <div className="flex items-center gap-1.5 landscape:hidden">
              <div className={`${rowClass} flex-1 min-w-0`}>
                {mods.map((kc: any, idx: number) => renderPoolKey(kc, idx))}
              </div>
              {enterBtn}
            </div>
            {/* Tall landscape: single scroll row with ... + Enter */}
            <div className={`${rowClass} hidden ${tallLandscape ? "landscape:flex" : ""}`}>
              {mods.map((kc: any, idx: number) => renderPoolKey(kc, idx))}
              {extraBtn}
              {enterBtn}
            </div>
            {/* Phone landscape: 2 rows — 5 keys each */}
            <div className={`hidden ${tallLandscape ? "" : "landscape:flex"} landscape:flex-col gap-1`}>
              <div className="flex gap-1.5 overflow-x-auto scroll-thin-x">
                {mods.slice(0, 5).map((kc: any, idx: number) => renderPoolKey(kc, idx))}
                {extraBtn}
              </div>
              <div className="flex gap-1.5 overflow-x-auto scroll-thin-x">
                {mods.slice(5).map((kc: any, idx: number) => renderPoolKey(kc, idx))}
                {enterBtn}
              </div>
            </div>
          </div>
        );
      })()}
      </div>

      {/* Compact strip — landscape only when controlsHidden */}
      <div className={`flex-col gap-1.5 p-1.5 ${controlsHidden ? "hidden landscape:flex" : "hidden"}`}>
        <Btn onClick={() => { vibrate(); onToggleControlsHidden?.(false); }} title={t("remote.showControls")}>
          <Eye size={16} />
        </Btn>
        <Btn onClick={() => v(onToggleKeyboard)} disabled={!streaming} active={keyboardOn} title={t("remote.toggleKeyboard")}>
          <Keyboard size={16} />
        </Btn>
      </div>

      <KeyCustomizeModal
        isOpen={showCustomize}
        onClose={() => setShowCustomize(false)}
        title={t("remote.customizeRemoteKeys")}
        tabs={[
          { id: "bottom", label: t("remoteControls.bottomRow"), hook: bottomCustom as any, excludeIds: [REMOTE_PINNED_KEY_ID] },
          { id: "extra", label: t("remoteControls.extraPanel"), hook: extraCustom as any }
        ]}
      />
      <CommandHistoryModal
        isOpen={historyOpen}
        store={useRemoteHistoryStore}
        onSelect={(cmd) => { onTextInputChange(cmd); panelInputRef.current?.focus(); }}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}
