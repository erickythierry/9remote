// Server-side adapter registry.

import type { BaseProtocol } from "./BaseProtocol.js";

export type ProtocolAdapter = BaseProtocol & {
  socket?: { disconnect?: (close?: boolean) => unknown } | null;
  setPeerCaps?: (caps: Record<string, unknown>) => void;
  _peerEnv2?: boolean;
};

export type ProtocolAdapterConstructor = { readonly id: string; new (): ProtocolAdapter };

const registry = new Map<string, ProtocolAdapterConstructor>();

export function registerProtocol(AdapterClass: ProtocolAdapterConstructor): void {
  if (!AdapterClass?.id) throw new Error("Adapter missing static id");
  registry.set(AdapterClass.id, AdapterClass);
}

export function getProtocol(id: string): ProtocolAdapterConstructor | undefined {
  return registry.get(id);
}

export function listProtocols(): ProtocolAdapterConstructor[] {
  return [...registry.values()];
}
