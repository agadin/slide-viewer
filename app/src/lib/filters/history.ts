/**
 * Undo for the Adjust tab: every change to the filter params (sliders, presets, Auto levels, Detect
 * stain, Estimate vectors, Normalise, Reset) can be stepped back with the panel's Undo button or ⌘Z
 * while the focus is in the Adjust tab. Separate from the annotation undo stack on purpose: ⌘Z on the
 * slide still undoes annotations.
 *
 * Recorded by watching the store, so every way of changing the params is covered. A slider drag makes
 * many small changes; changes less than COALESCE_MS apart count as one step.
 */
import { useSyncExternalStore } from "react";
import { useStore } from "../store";
import type { FilterParams } from "../types";

const COALESCE_MS = 600;
const MAX_STEPS = 60;

let past: FilterParams[] = [];
let lastAt = 0;
let restoring = false;
let slidePath: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

useStore.subscribe((now, before) => {
  // a new slide starts a fresh history
  if (now.slide.path !== slidePath) {
    slidePath = now.slide.path;
    past = [];
    lastAt = 0;
    emit();
    return;
  }
  if (now.filters.params === before.filters.params || restoring) return;
  // switching slides restores that slide's own params (pipeline.ts installFilterState, which also
  // rewrites filters.bySlide in the same update): that is not an adjustment to undo
  if (now.filters.bySlide !== before.filters.bySlide) return;
  const t = performance.now();
  if (t - lastAt > COALESCE_MS || !past.length) {
    past.push(before.filters.params);
    if (past.length > MAX_STEPS) past.shift();
    emit();
  }
  lastAt = t;
});

/** step the adjustments back one change; false when there is nothing to undo */
export function undoAdjustment(): boolean {
  const prev = past.pop();
  if (!prev) return false;
  restoring = true;
  try {
    useStore.getState().setFilters({ params: prev });
  } finally {
    restoring = false;
  }
  lastAt = 0;
  emit();
  return true;
}

/** how many adjustment steps can be undone (re-renders the caller when it changes) */
export function useAdjustmentUndoCount(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => past.length,
  );
}
