"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

// Manage a persisted list of key IDs (flat) OR 2D grid of IDs.
// mode "flat"  → state: string[]          → for single-row bars
// mode "grid"  → state: string[][]        → for multi-row panels (fixed row count)
export interface KeyItem {
  id: string;
  [key: string]: any;
}

type Mode = "flat" | "grid";
type Ids = string[] | string[][];

export function useCustomKeys<K extends KeyItem, D extends Ids>(
  storageKey: string,
  pool: K[],
  defaultValue: D,
  mode: Mode = "flat",
  legacyDefaults: D[] = []
) {
  const [state, setState, reset] = usePersistedState<D>(storageKey, defaultValue);
  const map = useMemo(() => new Map(pool.map((k) => [k.id, k] as const)), [pool]);

  // Migrate: if persisted state exactly matches a legacy default, upgrade to current default.
  // Only fires when the user never customized — idempotent (after upgrade, no legacy match).
  const flatState: string[] | undefined = mode === "grid" ? (state as string[][] | undefined)?.flat() : (state as string[] | undefined);
  const equals = (a: unknown, b: unknown): boolean => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  const isLegacy = !!flatState && legacyDefaults.some((legacy) => mode === "grid" ? equals((legacy as string[][]).flat(), flatState) : equals(legacy, flatState));
  const migrated = isLegacy ? defaultValue : state;

  const resolve = useCallback((ids: string[]) => ids.map((id) => map.get(id)).filter((k): k is K => !!k), [map]);

  // Expected row count for grid mode = defaultValue.length (source of truth)
  const expectedRowCount = mode === "grid" && Array.isArray(defaultValue) ? defaultValue.length : 1;

  // Normalize shape defensively. If legacy/corrupted shape in grid mode → fallback to default.
  const rows = useMemo((): string[][] => {
    if (mode === "grid") {
      const validGrid = Array.isArray(migrated) && migrated.length === expectedRowCount && (migrated as unknown[]).every(Array.isArray);
      if (validGrid) return migrated as string[][];
      return defaultValue as string[][]; // restore default when shape invalid (e.g. legacy flat)
    }
    return [Array.isArray(migrated) ? (migrated as string[]) : []];
  }, [migrated, mode, defaultValue, expectedRowCount]);
  const keys = useMemo(() => resolve(rows.flat()), [rows, resolve]);
  const available = useMemo(() => {
    const used = new Set(keys.map((k) => k.id));
    return pool.filter((k) => !used.has(k.id));
  }, [keys, pool]);

  // Get/set a single row (always returns array)
  const getRow = useCallback((r: number): string[] => (mode === "grid" ? (migrated as string[][])[r] || [] : (migrated as string[])), [migrated, mode]);

  // Persist migration: when state matched a legacy default, write upgraded value back.
  useEffect(() => {
    if (isLegacy) setState(defaultValue);
  }, [isLegacy, defaultValue, setState]);

  const updateRows = useCallback((fn: (rows: string[][]) => string[][] | string[]) => {
    setState((prev) => {
      if (mode === "grid") {
        const validGrid = Array.isArray(prev) && (prev as unknown[]).length === expectedRowCount && (prev as unknown[]).every(Array.isArray);
        const base = validGrid ? (prev as string[][]).map((r) => [...r]) : (defaultValue as string[][]).map((r) => [...r]);
        return fn(base) as D;
      }
      const flat = Array.isArray(prev) ? (prev as string[]) : [];
      return fn([[...flat]])[0] as D;
    });
  }, [setState, mode, defaultValue, expectedRowCount]);

  const add = useCallback((id: string, row = 0) => {
    updateRows((rowsArr) => {
      if (!rowsArr[row]) rowsArr[row] = [];
      if (!rowsArr.flat().includes(id)) rowsArr[row] = [...rowsArr[row], id];
      return rowsArr;
    });
  }, [updateRows]);

  const removeAt = useCallback((row: number, col: number) => {
    updateRows((rowsArr) => {
      if (!rowsArr[row]) return rowsArr;
      rowsArr[row] = rowsArr[row].filter((_, i) => i !== col);
      return rowsArr;
    });
  }, [updateRows]);

  const replaceAt = useCallback((row: number, col: number, id: string) => {
    updateRows((rowsArr) => {
      if (!rowsArr[row]) rowsArr[row] = [];
      const existing = rowsArr.flat().indexOf(id);
      // If id already placed elsewhere, remove it first (uniqueness)
      if (existing >= 0) {
        for (const r of rowsArr) {
          const ci = r.indexOf(id);
          if (ci >= 0) r.splice(ci, 1);
        }
      }
      // Insert/replace at target
      if (col >= rowsArr[row].length) rowsArr[row].push(id);
      else rowsArr[row][col] = id;
      return rowsArr;
    });
  }, [updateRows]);

  const swap = useCallback((a: { row: number; col: number }, b: { row: number; col: number }) => {
    updateRows((rowsArr) => {
      const rA = rowsArr[a.row], rB = rowsArr[b.row];
      if (!rA || !rB) return rowsArr;
      const tmp = rA[a.col];
      rA[a.col] = rB[b.col];
      rB[b.col] = tmp;
      return rowsArr;
    });
  }, [updateRows]);

  return {
    mode, rows, keys, available,
    getRow, add, removeAt, replaceAt, swap, reset
  };
}
