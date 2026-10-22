import { useEffect, useState, useCallback } from "react";

// Client bridge to the native paywall (StoreKit/Play Billing) inside the app shell.
// Native owns products, purchase and restore; web only opens the sheet and reads
// entitlement. Browser (no window.MOBILE_APP) → isNative=false, use the web flow.

interface Entitlement {
  plan: string | null;
  status: string;
  expiresAt: string | null;
  [key: string]: unknown;
}

interface NativeWindow extends Window {
  MOBILE_APP?: unknown;
  ReactNativeWebView?: { postMessage(message: string): void };
  handleIAPEvent?: (payload: unknown) => void;
}

const nativeWin = (): NativeWindow => window as NativeWindow;

const isAvailable = (): boolean =>
  typeof window !== "undefined" && !!nativeWin().MOBILE_APP && !!nativeWin().ReactNativeWebView;

const INACTIVE: Entitlement = { plan: null, status: "inactive", expiresAt: null };

export default function useMobileIAP() {
  const [entitlement, setEntitlement] = useState<Entitlement>(INACTIVE);

  useEffect(() => {
    if (!isAvailable()) return;
    const handler = (event: Event | { detail?: unknown; kind?: unknown; entitlement?: unknown }) => {
      const payload = (("detail" in event && event.detail) || event) as { kind?: unknown; entitlement?: Entitlement };
      if (payload?.kind === "entitlement" && payload.entitlement) {
        setEntitlement(payload.entitlement);
      }
    };
    window.addEventListener("handleIAPEvent", handler as EventListener);
    if (!nativeWin().handleIAPEvent) {
      nativeWin().handleIAPEvent = (payload: unknown) =>
        window.dispatchEvent(new CustomEvent("handleIAPEvent", { detail: payload }));
    }
    nativeWin().ReactNativeWebView!.postMessage(JSON.stringify({ type: "IAP_GET_ENTITLEMENT" }));
    return () => window.removeEventListener("handleIAPEvent", handler as EventListener);
  }, []);

  const openPaywall = useCallback(() => {
    if (!isAvailable()) return;
    nativeWin().ReactNativeWebView!.postMessage(JSON.stringify({ type: "SHOW_PAYWALL" }));
  }, []);

  return {
    isNative: isAvailable(),
    entitlement,
    isPro: entitlement.status === "active",
    openPaywall
  };
}
