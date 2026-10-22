// Popup = connection status + the one control that matters: cutting host
// access. Everything actionable lives in the 9remote web UI.
type PopupStatus = { version?: string; host?: string; paused?: boolean; connected?: boolean };
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const ask = (msg: { t: string; paused?: boolean }) => new Promise<PopupStatus | null>((resolve) => chrome.runtime.sendMessage(msg, resolve));

async function render() {
  const s = await ask({ t: "status" });
  if (!s) return;
  $("ver").textContent = "v" + (s.version || "");
  $("host").textContent = s.host || "";
  const paused = Boolean(s.paused);
  $("dot").className = "dot " + (paused ? "cut" : s.connected ? "on" : "off");
  $("label").textContent = paused ? "Bridge paused" : s.connected ? "Connected" : "Reconnecting…";
  $("pauseHint").textContent = paused ? "Blocked until you turn it back on" : "Host may drive this browser";
  ($("bridge") as HTMLInputElement).checked = !paused;
}

$("bridge").addEventListener("change", async (e) => {
  await ask({ t: "setPaused", paused: !(e.currentTarget as HTMLInputElement).checked });
  render();
});

render();
