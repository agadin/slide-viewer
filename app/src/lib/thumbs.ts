/**
 * Slide thumbnails for the browser: fetched lazily (only rows on screen ask), a few at a time,
 * memoised as blob URLs. The Rust side (scan.rs `thumbnail`) caches the JPEGs on disk, keyed by
 * path + size + mtime. Owner: browser.
 */
import { useEffect, useState } from "react";
import { slideThumbnail } from "./backend";
import type { ScanEntry } from "./types";

/** pixel size asked of the backend (crisp up to the largest list size on a 2× screen) */
export const THUMB_PX = 256;
const MAX_PARALLEL = 4;
const MAX_URLS = 800;

/**
 * A small queue: at most `limit` jobs run at once; jobs not started yet can be cancelled (rows that
 * scrolled away before their turn). Jobs with the same key share one run.
 */
export class TaskQueue<T> {
  private running = 0;
  private waiting: { key: string; run: () => Promise<T>; subs: { resolve: (v: T) => void; reject: (e: unknown) => void }[] }[] = [];
  private active = new Map<string, Promise<T>>();
  constructor(private limit: number) {}

  get pending() {
    return this.waiting.length;
  }
  get inFlight() {
    return this.running;
  }

  push(key: string, run: () => Promise<T>): { promise: Promise<T>; cancel: () => void } {
    const act = this.active.get(key);
    if (act) return { promise: act, cancel: () => {} };
    let job = this.waiting.find((j) => j.key === key);
    if (!job) {
      job = { key, run, subs: [] };
      this.waiting.push(job);
    }
    const j = job;
    let sub!: { resolve: (v: T) => void; reject: (e: unknown) => void };
    const promise = new Promise<T>((resolve, reject) => {
      sub = { resolve, reject };
      j.subs.push(sub);
    });
    queueMicrotask(() => this.pump());
    return {
      promise,
      cancel: () => {
        const i = j.subs.indexOf(sub);
        if (i < 0 || !this.waiting.includes(j)) return; // already running: let it finish (it lands in the cache)
        j.subs.splice(i, 1);
        if (!j.subs.length) this.waiting.splice(this.waiting.indexOf(j), 1);
        sub.reject(new Error("cancelled"));
      },
    };
  }

  private pump() {
    while (this.running < this.limit && this.waiting.length) {
      const j = this.waiting.shift()!;
      this.running++;
      const p = j.run();
      this.active.set(j.key, p);
      p.then(
        (v) => j.subs.forEach((s) => s.resolve(v)),
        (e) => j.subs.forEach((s) => s.reject(e)),
      ).finally(() => {
        this.running--;
        this.active.delete(j.key);
        this.pump();
      });
    }
  }
}

/** identity of a thumbnail: a changed file (size / mtime) gets a new one */
export const thumbKey = (e: Pick<ScanEntry, "path" | "size" | "modifiedMs">) => `${e.path}|${e.size}|${e.modifiedMs}`;

const urls = new Map<string, string>(); // key → blob URL, oldest first
const failed = new Map<string, string>(); // key → error
const queue = new TaskQueue<string>(MAX_PARALLEL);

function remember(key: string, url: string) {
  urls.set(key, url);
  while (urls.size > MAX_URLS) {
    const [k, u] = urls.entries().next().value as [string, string];
    urls.delete(k);
    URL.revokeObjectURL(u);
  }
}

/** thumbnail URL if it's already loaded */
export const cachedThumb = (key: string) => urls.get(key) ?? null;

/** forget failures (e.g. after a rescan, so a fixed file gets another try) */
export const clearThumbFailures = () => failed.clear();

export type ThumbState = { url: string | null; error: string | null };

/**
 * The thumbnail for `entry`, loaded once `visible` turns true (null entry or `enabled` false: nothing).
 */
export function useThumb(entry: ScanEntry | null, visible: boolean): ThumbState {
  const key = entry ? thumbKey(entry) : "";
  const [state, setState] = useState<ThumbState>(() => ({ url: key ? cachedThumb(key) : null, error: key ? (failed.get(key) ?? null) : null }));
  useEffect(() => {
    if (!entry) return setState({ url: null, error: null });
    const have = cachedThumb(key);
    if (have || failed.has(key)) return setState({ url: have, error: failed.get(key) ?? null });
    setState({ url: null, error: null });
    if (!visible) return;
    let alive = true;
    const path = entry.path;
    const job = queue.push(key, async () => {
      const bytes = await slideThumbnail(path, THUMB_PX);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
      remember(key, url);
      return url;
    });
    job.promise.then(
      (url) => alive && setState({ url, error: null }),
      (e) => {
        if (e instanceof Error && e.message === "cancelled") return;
        failed.set(key, String(e));
        if (alive) setState({ url: null, error: String(e) });
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible]);
  return state;
}
