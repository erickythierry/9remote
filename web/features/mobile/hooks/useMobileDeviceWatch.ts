"use client";

import { useEffect } from "react";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { connOf } from "@/shared/transport/hostConn";

export function useMobileDeviceWatch() {
  const onlineHeads = useFleetStore((s) => `${s.currentKey}|` + Object.values(s.hosts)
    .filter((h: any) => h.status === "online" || h.status === "full")
    .map((h: any) => h.key)
    .join(","));

  useEffect(() => {
    const st = useFleetStore.getState();
    const headsPart = onlineHeads.slice(onlineHeads.indexOf("|") + 1);
    const cleanups: (() => void)[] = [];
    for (const key of headsPart.split(",").filter(Boolean)) {
      const head = key === st.currentKey ? null : key;
      const bus = connOf(head).bus;
      if (!bus) continue;
      const apply = (res: any) => {
        (useFleetStore.getState() as any)._patchHost(key, { mobileDeviceCount: Number(res?.count) || 0 });
      };
      bus.on("mobile:devicesChanged", apply);
      bus.emit("mobile:deviceCount", {}, (res: any) => {
        if (res && typeof res.count === "number") apply(res);
      });
      cleanups.push(() => bus.off("mobile:devicesChanged", apply));
    }
    return () => { for (const fn of cleanups) fn(); };
  }, [onlineHeads]);
}
