// Pure helpers for control-channel routing and diagnostics.
// Extracted verbatim from ProtocolManager.
import type { ProtocolAdapter, TransportChannel } from "../types";

// Short per-tab tag appended to deviceId so concurrent tabs don't collide.
export function randomTag() {
  return Math.random().toString(36).slice(2, 10);
}


// Sum inbound traffic (bytesReceived + responsesReceived) over the nominated/selected
// ICE candidate-pairs of a RTCStatsReport. Returns null if no selected pair exists yet.
// Used by the liveness probe to verify whether bytes or STUN keepalives are flowing.
export function selectedIceTraffic(report: RTCStatsReport): number | null {
  let total = 0, found = false;
  for (const v of report.values()) {
    const pair = v as RTCStats & { nominated?: boolean; selected?: boolean; bytesReceived?: number; responsesReceived?: number };
    if (pair.type === "candidate-pair" && (pair.nominated || pair.selected)) {
      found = true;
      total += (pair.bytesReceived ?? 0) + (pair.responsesReceived ?? 0);
    }
  }
  return found ? total : null;
}
export const selectedIceResponses = selectedIceTraffic;

/**
 * Pick the best ready adapter for a channel: the profile's preferred adapter if
 * it's up, else the highest-priority one that supports the channel.
 */
type RoutingProfile = { channels: Partial<Record<TransportChannel, { prefer?: string }>> };

type AdapterMetadata = { id: string; priority: Record<string, number> };

export function pickAdapter(adapters: Map<string, ProtocolAdapter>, profile: RoutingProfile, channel: TransportChannel): ProtocolAdapter | null {
  const cfg = profile.channels[channel];
  if (!cfg) return null;

  const candidates = [...adapters.values()]
    .filter((a) => a.supports(channel) && a.ready);

  if (!candidates.length) return null;

  // Dynamic priority resolution — highest score wins, extensible for any future protocol
  candidates.sort((a, b) => {
    const classB = b.constructor as Function & AdapterMetadata;
    const classA = a.constructor as Function & AdapterMetadata;
    const pB = b.getPriority ? b.getPriority(channel) : (classB.priority[channel] ?? 0);
    const pA = a.getPriority ? a.getPriority(channel) : (classA.priority[channel] ?? 0);
    if (pB !== pA) return pB - pA;
    // Tie-breaker: if scores are identical, use the profile preference
    if (cfg.prefer) {
      if (classB.id === cfg.prefer) return 1;
      if (classA.id === cfg.prefer) return -1;
    }
    return 0;
  });

  return candidates[0] || null;
}
