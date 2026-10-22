"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback": () => void;
          "error-callback": () => void;
        }
      ) => string;
      reset?: (widgetId?: string) => void;
      remove?: (widgetId: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  siteKey?: string | null;
  onToken: (token: string) => void;
}

// Managed-mode Turnstile: invisible for most humans, a challenge only when
// Cloudflare's scoring doubts the client. Renders nothing when no sitekey is
// configured (dev), matching the backend skipping verification without a secret.
export default function TurnstileWidget({ siteKey, onToken }: TurnstileWidgetProps) {
  const holder = useRef<HTMLDivElement>(null);
  const tokenCb = useRef(onToken);

  useEffect(() => { tokenCb.current = onToken; }, [onToken]);

  useEffect(() => {
    if (!siteKey || !holder.current) return;
    let widgetId: string | null = null;

    const render = () => {
      if (!window.turnstile?.render || !holder.current) return;
      widgetId = window.turnstile.render(holder.current, {
        sitekey: siteKey,
        callback: (t) => tokenCb.current(t),
        "expired-callback": () => tokenCb.current(""),
        "error-callback": () => tokenCb.current("")
      });
    };

    if (window.turnstile?.render) {
      render();
    } else {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = render;
      document.head.appendChild(s);
    }

    return () => {
      if (widgetId != null) window.turnstile?.remove?.(widgetId);
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={holder} className="flex justify-center min-h-[33px]" aria-label="Captcha" />;
}
