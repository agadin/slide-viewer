/**
 * TODO(browser builder): folder browsing logic: open/rescan a parent folder (backend.scanFolder,
 * "scan-progress" events), remember the last folder (settings.browser.lastFolder), tree building from
 * ScanEntry.dir, name search, natural sort, stepping through slides.
 * Owner: browser (CONTRACTS.md). Minimal working stand-ins below.
 *
 * CONTRACT: lib/keys.ts calls `stepSlide(±1)`; App/menus call `openFolder()` and `rescan()`.
 */
import { pickFolder, scanFolder } from "./backend";
import { useStore } from "./store";

/** Choose (dir omitted → folder picker) and scan a parent folder. */
export async function openFolder(dir?: string): Promise<void> {
  const root = dir ?? (await pickFolder());
  if (!root) return;
  useStore.getState().setBrowser({ root, scanning: true, error: null, scan: null });
  await rescan();
}

export async function rescan(): Promise<void> {
  const { root } = useStore.getState().browser;
  if (!root) return;
  useStore.getState().setBrowser({ scanning: true, error: null });
  try {
    const scan = await scanFolder(root);
    if (useStore.getState().browser.root === root) useStore.getState().setBrowser({ scan, scanning: false });
  } catch (e) {
    if (useStore.getState().browser.root === root) useStore.getState().setBrowser({ scanning: false, error: String(e) });
  }
}

/** Open the previous (-1) or next (+1) slide in the browser's order. */
export function stepSlide(delta: number): void {
  const st = useStore.getState();
  const entries = st.browser.scan?.entries ?? [];
  if (!entries.length) return;
  const i = entries.findIndex((e) => e.path === st.slide.path);
  const next = entries[i < 0 ? 0 : (i + delta + entries.length) % entries.length];
  if (next && next.path !== st.slide.path) void st.openSlide(next.path);
}
