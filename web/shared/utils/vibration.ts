/**
 * Vibration utility with iOS Safari fallback
 * Uses hidden switch input trick for WebKit browsers that don't support Vibration API
 */

type AppWindow = Window & {
  __TAURI__?: unknown;
  ReactNativeWebView?: { postMessage: (message: string) => void };
  DEVICE_INFO?: { platform?: string };
};

export function vibrate(duration: number = 10): void {
  const appWindow = window as AppWindow;
  // Tauri desktop: WebKit reports MacIntel + maxTouchPoints>1 (trackpad), which would
  // falsely trip the iOS haptic fallback below and inject DOM churn into every click.
  if (appWindow.__TAURI__) return;
  // Android Expo shell: navigator.vibrate exists in Android WebView but is a no-op
  // there, so the native bridge must win. UA gate — DEVICE_INFO is injected post-load
  // and can be missing. iOS keeps its WebView haptic path below.
  if (appWindow.ReactNativeWebView && /Android/i.test(navigator.userAgent)) {
    try {
      appWindow.ReactNativeWebView.postMessage(JSON.stringify({ type: "HAPTIC", style: "selection" }));
    } catch {}
    return;
  }

  // Standard Vibration API (Android browsers)
  if (navigator.vibrate) {
    navigator.vibrate(duration);
    return;
  }

  // iOS Safari fallback: toggle hidden switch input for haptic feedback
  if (typeof document !== "undefined") {
    const isIOS = typeof navigator !== "undefined" && (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      appWindow.DEVICE_INFO?.platform === "ios" || // expo shell replaces the whole UA
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
    if (!isIOS) return;

    const el = document.createElement("div");
    const id = Math.random().toString(36).slice(2);
    el.innerHTML = `<input type="checkbox" id="${id}" switch /><label for="${id}"></label>`;
    el.setAttribute("style", "display:none !important;opacity:0 !important;visibility:hidden !important;");
    document.body.appendChild(el);
    el.querySelector("label")!.click();
    setTimeout(() => el.remove(), 100);
  }
}
