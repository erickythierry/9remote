// Adapter registry — DRY plugin point.
// Adapter file imports + calls registerProtocol(Class) once at module load.

import type { ProtocolAdapter } from "./types";

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
