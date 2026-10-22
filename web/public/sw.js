"use strict";
(() => {
  // web/workers/serviceWorker.ts
  self.addEventListener("install", () => {
    self.skipWaiting();
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => caches.delete(cacheName))
        );
      })
    );
    return self.clients.claim();
  });
  self.addEventListener("fetch", () => {
  });
  self.addEventListener("push", (event) => {
    if (!event.data) return;
    event.waitUntil(
      (async () => {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (clientList.some((c) => c.visibilityState === "visible")) return;
        try {
          const data = event.data.json();
          const title = data.title || "9Remote";
          const options = {
            body: data.body || "Notification",
            icon: "/icon-192.png",
            badge: "/icon-192.png",
            data: data.data || { url: "/workspace" },
            vibrate: [200, 100, 200],
            tag: "9remote-notification",
            renotify: true
          };
          await self.registration.showNotification(title, options);
          if (self.registration.setAppBadge) {
            const badgeCount = typeof data.badge === "number" ? data.badge : 1;
            await self.registration.setAppBadge(badgeCount);
          }
        } catch (error) {
          console.error("Push event error:", error);
        }
      })()
    );
  });
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    if (self.registration.clearAppBadge) {
      self.registration.clearAppBadge().catch(() => {
      });
    }
    const url = event.notification.data?.url || "/workspace";
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({ type: "NOTIFICATION_CLICK", url });
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
    );
  });
})();
