type TauriEvent<T> = { payload: T };

export {};

declare global {
  interface Window {
    __TAURI__?: {
      event?: {
        listen: (
          eventName: string,
          handler: (event: TauriEvent<string>) => void
        ) => Promise<unknown>;
      };
    };
  }
}

const status = document.getElementById("status")!;
const stage = document.getElementById("stage")!;

let failed = false;

function setStatus(message: string) {
  if (failed) return;
  status.style.opacity = "0";
  setTimeout(() => {
    status.textContent = message;
    status.style.opacity = "1";
  }, 150);
}

function setError(message: string) {
  failed = true;
  stage.classList.add("failed");
  status.style.opacity = "1";
  status.textContent = message;
}

async function initTauri() {
  try {
    if (!window.__TAURI__?.event?.listen) return;
    await window.__TAURI__.event.listen("setup_progress", event => setStatus(event.payload));
    await window.__TAURI__.event.listen("setup_ready", () => setStatus("Ready! Loading..."));
    await window.__TAURI__.event.listen("setup_error", event => setError(event.payload));
  } catch {
    // Keep startup rendering if the event bridge is unavailable.
  }
}

void initTauri();
