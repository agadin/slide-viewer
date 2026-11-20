# Slide Viewer: contracts for parallel builders

Read `SPEC.md` (product decisions, NDPA format) and `CLAUDE.md` first. This file says **who owns which
file** and **which interfaces are frozen**, so six builders can work in separate worktrees without
merge conflicts. Paths are relative to `app/` unless they start with `tools/`, `docs/` or `.github/`.

## 1. File ownership

| Builder | Owns (create/edit freely) |
|---|---|
| **formats** | `src-tauri/src/source/**`, `src-tauri/src/slide.rs`, `src-tauri/build.rs`, `tools/fetch-libczi.sh`, `[dependencies]` in `src-tauri/Cargo.toml` (+ `Cargo.lock`) |
| **browser** | `src-tauri/src/scan.rs`, `src/components/Browser.tsx`, `src/lib/browser.ts`, `tests/browser.test.ts` |
| **annotations** | `src/lib/ndpa.ts`, `src/lib/annotations.ts`, `src/components/annotations/**`, `src/components/AnnotationPanel.tsx`, `src/lib/autosave.ts`, `tests/annotations.test.ts` |
| **filters** | `src/lib/filters/**`, `src/components/AdjustPanel.tsx`, `tests/filters.test.ts` |
| **viewer** | `src/components/SlideViewer.tsx`, `src/components/viewer/**`, `src/components/Toolbar.tsx`, `src/lib/keys.ts`, `tests/viewer.test.ts` |
| **release** | `tools/release.sh`, `.github/**`, `docs/**`, `README.md`, `src/components/UpdateBanner.tsx`, `src/components/AboutPane.tsx`, `src/components/HelpPanel.tsx`, `src/lib/help.ts` |

Rules:

- **Shared files** (`src/App.tsx`, `src/lib/store.ts`, `src-tauri/src/lib.rs`, `src/App.css`, `src/lib/types.ts`,
  `src/lib/settings.ts`, `src/lib/backend.ts`, `src/lib/menu.ts`, `src/lib/coords.ts`, `src/lib/viewerContext.ts`,
  `src/components/SettingsDialog.tsx`, `src/components/prefsUi.tsx`, `src/components/ContextMenu.tsx`,
  `tests/logic.test.ts`, `tests/harness.ts`, `src-tauri/src/files.rs`, `src-tauri/src/tiles.rs`, `package.json`):
  only **append** a small, clearly delimited block (`// ==== <builder>: … ====` … `// ==== end <builder> ====`),
  and only when your own files can't do it. Never rename or remove what others use.
  - `settings.ts`: edit **only your own block** (`ViewerSettings`, `AnnotationSettings`, `FilterSettings`,
    `BrowserSettings` + their defaults). New keys need no migration.
  - `store.ts`: you may add fields to **your own slice** interface + initial value. Use the generic patchers
    (`setBrowser`, `setAnnotations`, `setFilters`, `setFilterParams`, `setView`, `setUi`) from your own files.
  - `App.css`: put styles in your own CSS file imported by your component (e.g. `components/annotations/annotations.css`,
    `lib/filters/filters.css` imported from `AdjustPanel.tsx`). Use the existing tokens (`--glass`, `--tx-1…4`,
    `--fill-1…3`, `--accent`, `--ok`, `--bad`, `--sep`) and classes (`btn`, `tbtn`, `seg`, `check`, `kbd`, `muted`, `small`).
  - `package.json`: if you need an npm dependency, add one line; tell the integrator in your notes.
- `lib.rs` already registers **every** command below. You implement the module function it calls; you do not
  touch `invoke_handler`. If a command signature truly must change, say so in your notes rather than editing lib.rs.
- Tests: each builder owns `tests/<feature>.test.ts` (already imported by `tests/logic.test.ts`). Rust tests live
  in your own module (`#[cfg(test)]`).
- Help: release owns `docs/**`, but write your feature's help page as `docs/help/<feature>.md` in MSG's style
  (front matter `title`, `blurb`, `order`) — a new file in a folder doesn't conflict.
- Green bar before you finish: `cd app && npx tsc --noEmit && npm run test:logic`, `cd app/src-tauri && cargo check && cargo test`.
- Never modify `/Users/alexandergadin/vscode/micro-speed-grader`. Never commit `test-data/` or slides.

## 2. Tile scheme (frozen) — `src-tauri/src/tiles.rs`, `src/lib/backend.ts` `tileUrl`

```
slide://localhost/<id>/<z>/<level>/<x>_<y>.jpg     (Windows: http://slide.localhost/…)
slide://localhost/<id>/<level>/<x>_<y>.jpg         same with z = 0
```

- `id`: `SlideInfo.id` from `open_slide`. `z`: a `ZPlane.index`. `level`: **Deep-Zoom** level, OpenSeadragon's:
  `maxLevel = ceil(log2(max(width, height)))` is full resolution, each lower level halves (ceil). `x`/`y`: tile column/row.
- `tileSize = 256`, no overlap, JPEG q85. Edge tiles are smaller. Every backend serves the same geometry, so
  the frontend never cares about the format. Helpers: `source::dz_max_level`, `dz_level_size`, `dz_tile_rect`.

## 3. Rust: `SlideSource` (formats) — `src-tauri/src/source/mod.rs`

```rust
pub trait SlideSource: Send + Sync {
    fn info(&self) -> &SourceInfo;
    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String>;      // Deep-Zoom tile
    fn associated(&self, name: &str) -> Result<RgbImage, String>;                          // default: Err
    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String>; // default: stitch tiles
    fn overview(&self, max_px: u32, z: u32) -> Result<RgbImage, String>;                   // default: region of all, fitted
}
pub struct SourceInfo { format, vendor: Option<String>, width, height, mpp_x, mpp_y, calibrated: bool,
                        x_offset_nm, y_offset_nm, levels: Vec<LevelInfo>, z_planes: Vec<ZPlane>, associated: Vec<String> }
pub struct ZPlane { index: u32, offset_nm: Option<f64>, label: String }   // always ≥ 1 plane
pub struct SlideInfo { id, path, tile_size, max_level, #[serde(flatten)] source: SourceInfo }  // camelCase to JS
```

- Uncalibrated (no mpp): `mpp_x = mpp_y = 1.0`, `calibrated = false`. Non-Hamamatsu offsets are 0.
- Registry: `source::open_source(path)` tries `backends_for(path)` in order (`.czi` → CZI; OpenSlide exts → OpenSlide;
  plain exts → Plain; `.tif/.tiff` try OpenSlide then Plain). `SlideRegistry::{open, get, info, close}`.
  `supported_extensions()` feeds the folder scan. `.vsi` is out of scope.
- Status: `openslide.rs` works (wraps `slide.rs`, incl. associated images). `plain.rs`, `czi.rs` return
  `"unsupported: …"` errors (formats fills them in).

## 4. Tauri commands (all registered in lib.rs) — JS wrappers in `src/lib/backend.ts`

| Command (JS wrapper) | Args → result | Delegates to | Owner |
|---|---|---|---|
| `open_slide` (`openSlide`) | `path` → `SlideInfo` | `SlideRegistry::open` | formats |
| `close_slide` (`closeSlide`) | `id` → `bool` | `SlideRegistry::close` | formats |
| `slide_info` (`slideInfo`) | `id` → `SlideInfo \| null` | registry | formats |
| `slide_z_planes` (`slideZPlanes`) | `id` → `ZPlane[]` | `info().z_planes` | formats |
| `supported_extensions` (`supportedExtensions`) | → `string[]` (".ndpi", …) | `source::supported_extensions` | formats |
| `slide_associated` (`slideAssociated`) | `id, name, maxPx?, format?` → bytes | `SlideSource::associated` | formats |
| `slide_region` (`slideRegion`) | `id, {x,y,width,height,outWidth,outHeight,z}, format` → bytes | `SlideSource::region` | formats |
| `slide_overview` (`slideOverview`) | `id, maxPx, z, format="rgba"` → bytes (size = `fitSize(w,h,maxPx)`) | `SlideSource::overview` | formats |
| `scan_folder` (`scanFolder`) | `dir` → `ScanResult`; emits `"scan-progress"` (`ScanProgress`) | `scan::scan_folder(dir, ndpa_fallback_dir, &progress)` | browser |
| `slide_thumbnail` (`slideThumbnail`) | `path, maxPx` → JPEG bytes | `scan::thumbnail(reg, path, max_px, cache_dir)` | browser |
| `annotation_paths` (`annotationPaths`) | `slidePath` → `{primary, primaryExists, primaryWritable, fallback, fallbackExists}` | `files.rs` | annotations |
| `read_text` / `write_text` | `path, maxBytes?` / `path, contents, keepBackup` (atomic temp+rename, `.bak`) | `files::write_atomic` | shared |
| `read_bytes` / `write_bytes` / `save_png` | raw bytes; writes take a raw body + percent-encoded `path` header (wrappers do it) | `files.rs` | shared |
| `list_files`, `path_exists` | as in MSG | lib.rs | shared |
| `open_preferences`, `open_help` | windows | lib.rs | shared |

Image `format`: `"jpeg"` (default) | `"png"` | `"rgba"` (raw `w*h*4`, for `new ImageData`).
Other JS helpers in backend.ts: `pickFolder`, `pickSavePath`, `revealFile`, `openExternal`, `showHelp`, `tileUrl`,
`basename`/`dirname`/`joinPath`/`withExt`, `isMac`, `hasTauri`.

**Annotation files:** primary `<slide>.ndpa` next to the slide (`VMS104.ndpi.ndpa`); if `primaryWritable` is false,
use `fallback` (`<appData>/annotations/<fnv64(folder)>/<name>.ndpa`). Writes: `writeText(path, xml, true)`.

**Menu events** (`src/lib/menu.ts`, `useMenuEvent(id, cb)`; `fireMenu(id)` to trigger from a button):
`open_folder`, `rescan_folder` (browser) · `export_ndpa` (annotations) · `snapshot` (viewer) · `check_updates` (release) ·
`undo`, `redo`, `rotate_left`, `rotate_right`, `zoom_fit`, `prev_slide`, `next_slide` (viewer, already wired in keys.ts) ·
`toggle_browser`, `toggle_panel` (App). Preferences (⌘,) and Help open their own windows in Rust.

## 5. Store — `src/lib/store.ts` (zustand, `useStore`)

```ts
browser:     { root, scan: ScanResult|null, scanning, progress: ScanProgress|null, error, query, collapsedDirs: string[] }
slide:       { path, info: SlideInfo|null, loading, error, openNonce }          // openNonce++ on every successful open
annotations: { items: Annotation[], selection: string[], tool: Tool, undo: Annotation[][], redo: Annotation[][],
               doc: unknown /* ndpa.ts's preserved document */, filePath, save: SaveState, saveError, editingId }
filters:     { params: FilterParams, enabled: boolean /* bypass */, auto: AutoState }
view:        { rotation /* deg */, z /* ZPlane.index */, zoom, umPerScreenPx, magnification, homeNonce }
ui:          { sidebarOpen, panelOpen, panelTab: "annotations"|"adjust", help, settingsOpen, menu: ContextMenuState|null, toast }
```

Actions: `setBrowser/setSlide/setAnnotations/setFilters/setFilterParams/setView/setUi(patch)`,
`openSlide(path)` (flushes, resets annotations/view/auto, opens, closes the previous slide), `closeSlide()`,
`setTool(tool)`, `select(ids)`, `commit(items)` (= one undo step, marks `save: "dirty"`), `undo()`, `redo()`,
`registerFlush(name, fn|null)` + `flushAll()` (autosave registers a flusher; slide switches, updates and unload call it).

Types (`src/lib/types.ts`): `SlideInfo`, `ZPlane`, `LevelInfo`, `ScanEntry {path,name,dir,ext,size,modifiedMs,annotationPath}`,
`ScanResult`, `ScanProgress`, `AnnotationPaths`, `PtNm`, `Annotation {id, ndpaId, kind, title, details, color, points: PtNm[],
radiusNm?, closed?, ndpType?, displayName?, source?}`, `AnnotationKind = pin|ruler|freehand|circle|rectangle|other`,
`Tool = pan|pin|ruler|freehand|circle|rectangle` + `TOOLS` (keys V P R F C B), `SaveState`, `FilterParams` + `DEFAULT_FILTERS`
(neutral = no-op), `AutoState`, `StainMode`, `StainType`. **All annotation geometry is in nm (NDP.view coordinates).**

Settings (`src/lib/settings.ts`, `useSettings`): `s.viewer`, `s.annotations` (`defaultColor "#00ff00"`, `showTitles`, `autosaveMs 1000`),
`s.filters.autoOnOpen {levels, stain, normalize}`, `s.browser {lastFolder, thumbSize}`; `setSection("viewer", patch)`.
Preferences panes are your own components: `ViewerPrefs` (viewer/ViewerPrefs.tsx), `AnnotationPrefs`
(annotations/AnnotationPrefs.tsx), `AdjustPrefs` (exported from AdjustPanel.tsx), `BrowserPrefs` (exported from Browser.tsx).
Build them from `prefsUi.tsx` (`PrefGroup`, `PrefRow`, `Seg`, `Check`) and `controls.tsx` (`SliderRow`, `SearchField`).

## 6. Coordinates — `src/lib/coords.ts` (pure) and `src/lib/viewerContext.ts`

```ts
imageToNm(info, {x,y})  = { x: (x - width/2) * mppX*1000 + xOffsetNm,  y: (y - height/2) * mppY*1000 + yOffsetNm }
nmToImage(info, {x,y})  = inverse;   nmToPx / pxToNm;   magFromUmPerPx(u) = 10/u;  umPerPxFromMag(m) = 10/m
```

Rotation is a view property only; it never changes stored coordinates. Inside the viewer use the context:

```ts
const { viewer, info, host, coords, onFrame } = useViewer();      // ViewerContext from SlideViewer.tsx
coords: imageToNm, nmToImage, imageToScreen, screenToImage, nmToScreen, screenToNm,  // screen = CSS px in the viewer element
        screenPxPerNm(), umPerScreenPx(), eventToScreen(e)                            // screen conversions follow rotation (OSD)
useViewerFrame(cb)   // cb runs in OSD's draw frame (pan/zoom/rotate/resize/open): redraw overlays here
```

## 7. Viewer plug-in points — `src/components/SlideViewer.tsx` (viewer owns it; others don't edit it)

Mounted inside `.viewer-wrap` (position: relative, fills the centre column) while a slide is open:
`<AnnotationLayer/>` (annotations), `<Navigator/> <ScaleBar/> <ZoomPresets/> <ZSlider/> <Snapshot/>` (viewer).
`<Toolbar/>` floats at the bottom of the centre column (App.tsx).

- **AnnotationLayer** owns pointer input when `annotations.tool !== "pan"` (overlay with `pointer-events: auto`, or OSD
  handlers via `viewer.addHandler` / `setMouseNavEnabled`). In pan mode, clicks on annotations select them;
  everything else goes to OSD. It also exports nothing else; painting lives in `lib/annotations.ts`:
  `paintAnnotations(ctx, coords, items, {selection, showTitles, scale})` (Snapshot calls it).
- Keys: `lib/keys.ts` handles tools (V P R F C B), Esc → pan, ⌘Z/⌘⇧Z, `[ ]`/←→ (`stepSlide`), H/0 fit. Feature-specific
  keys (Delete, Enter to rename, Esc cancels a drawing) go in the feature's own listener; check `e.defaultPrevented`
  and call `e.preventDefault()` when you consume a key; register with `{ capture: true }` so you run before keys.ts.
- Context menus: `useStore.getState().setUi({ menu: { x, y, items: [{label, shortcut?, danger?, onSelect}, "sep"] } })`.

## 8. Filter pipeline — `src/lib/filters/pipeline.ts` (filters)

```ts
export const filterViewerOptions: Partial<OpenSeadragon.Options>;   // spread into OSD options at creation (e.g. { drawer: "webgl" })
export function useFilterPipeline(viewer: OpenSeadragon.Viewer | null, info: SlideInfo | null): void;  // hook, called every render
export function applyFiltersToCanvas(src: HTMLCanvasElement): HTMLCanvasElement;                       // same look on a plain canvas
```

The hook reads `filters.params` / `filters.enabled` from the store and must keep panning at 60 fps (GPU). Stain
estimation and auto levels read pixels with `slideOverview(info.id, 2048, z, "rgba")` (tissue pixels only).
`filters.auto` holds the results; `settings.filters.autoOnOpen` runs them when `slide.openNonce` changes.
Currently all three are no-ops (SlideViewer uses `drawer: "canvas"` unless `filterViewerOptions` overrides it).

## 9. Browser — `src/lib/browser.ts` (browser)

`openFolder(dir?)` (no arg → folder picker), `rescan()`, `stepSlide(±1)` are called from elsewhere; keep those names.
`scan.rs` contract: `scan_folder(dir, ndpa_fallback_dir, &dyn Fn(ScanProgress)) -> Result<ScanResult>` and
`thumbnail(reg, path, max_px, cache_dir) -> Result<Vec<u8> /* JPEG */>`; both are stubs returning "unsupported".
`ScanEntry.annotationPath` should check both the primary and fallback `.ndpa` locations (`files::primary_annotation_path`,
`files::fallback_annotation_path`).

## 10. Decisions made by the foundation

- Layout: grid with a top bar (title, toggles, help, preferences), a left browser column, the viewer, and a right panel
  with Annotations / Adjust tabs, in MSG's dark glass style. The toolbar floats at the bottom of the viewer.
- Preferences stay in their own window (localStorage-backed, as in MSG); key `sv.settings.v1`.
- Tile geometry is Deep-Zoom for every backend; z is a URL segment; the old 3-segment form means z 0.
- `slide.rs` keeps the OpenSlide FFI only; tile maths moved to `source/mod.rs` / `source/openslide.rs`.
- OpenSlide is also found in `src-tauri/frameworks/` during dev/tests (`tools/fetch-openslide.sh mac`).
- `pdfjs-dist`, `playwright` and MSG's UI/scale/realdata test scripts were dropped (grader-only).
- Rust real-slide test: `cargo test -- --ignored` (reads MSG's `images/VMS104.ndpi`, read-only).
