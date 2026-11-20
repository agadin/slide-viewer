# Slide Viewer — v1 spec

A desktop whole-slide image viewer for **students** studying histology. Inspired by Hamamatsu
NDP.view2. Students open a parent folder of slides, browse them, view them with image
adjustments, measure, and place named pins and shapes. Those are saved as `.ndpa` files that open
in NDP.view2 **and** are read by Micro Speed Grader (MSG) for grading practical exams.

The sister app is Micro Speed Grader at `/Users/alexandergadin/vscode/micro-speed-grader`.
Its code is the base of this repo (copied and adapted, not shared). Read it freely for patterns,
UI style and behaviour, but **never modify it**.

## Decisions (agreed with the user, 2026-11-20)

| Topic | Decision |
|---|---|
| Stack | Tauri 2 + React 19 + TypeScript + Vite + OpenSeadragon 6 + Zustand, Rust backend. Same as MSG. |
| Name | **Slide Viewer**, identifier `edu.rice.slideviewer` |
| Platforms | macOS (universal, signed + notarized) and Windows x64, GitHub releases + Tauri updater, like MSG |
| Code reuse | Copy and adapt from MSG (already done for the base; see "What was copied") |
| Pin purpose | Both exam answers (for MSG) and personal study notes |
| Pin naming | **Free-text titles**, as in NDP.view2. There is no question picker. |
| Annotation types | Pin, ruler (saved as a linear annotation), freehand/polygon, circle, rectangle |
| Existing `.ndpa` | Load all, allow editing, and **preserve everything we don't understand** when writing back |
| Save location | `<slide file name>.ndpa` next to the slide (e.g. `VMS104.ndpi.ndpa`), autosaved. If that folder is read-only, fall back to the app data dir. Also offer "Export .ndpa…" |
| Folder browsing | Pick a parent folder → recursive scan → collapsible sidebar tree mirroring subfolders, a thumbnail per slide, name search, remember the last folder, and a badge on slides that have annotations |
| Formats | OpenSlide formats (.ndpi .svs .tif/.tiff .scn .mrxs .vms .vmu .bif .svslide, DICOM WSI) + plain images (.jpg .jpeg .png .bmp .webp, flat TIFF) + **.czi via libCZI** (now). **.vsi is phase 2** (not in v1) |
| Filters | Gamma, brightness, contrast, saturation, hue, grayscale, invert, sharpen/unsharp mask, stain separation (H&E, H-DAB) |
| Stain auto | Auto stain-vector estimation (Macenko), stain-type detection (H&E vs H-DAB/IHC vs special stains such as PAS, trichrome, silver) with an automatic preset, colour normalisation to a reference H&E, auto levels/gamma from the tissue histogram (ignoring the background). Every one is a one-click "Auto", and there is a preference to apply automatically when a slide opens |
| Extras in v1 | Overview map + scale bar + zoom presets, annotation list panel, PNG snapshot export, view rotation, focal planes (z-stack) where the format has them |

## NDPA compatibility (most important correctness requirement)

Reference files from real NDP.view2 exports are in `test-data/*.ndpi.ndpa` (pins only, gitignored).
MSG's reader is `app/src/lib/ndpa.ts` (copied here). Its tests are in MSG `app/tests/logic.test.ts`.

Format, as written by NDP.view2:

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<annotations>
	<ndpviewstate id="1">
		<title>Q1</title>
		<details/>
		<coordformat>nanometers</coordformat>
		<lens>6.015852</lens>          <!-- objective magnification of the saved view -->
		<x>4463083</x><y>-343024</y><z>0</z>  <!-- view centre, nm -->
		<showtitle>1</showtitle>
		<showhistogram>0</showhistogram>
		<showlineprofile>0</showlineprofile>
		<annotation type="pin" displayname="AnnotatePin" color="#00ff00">
			<x>4602860</x><y>-257548</y>
			<icon>pingreen</icon><stricon>iconpingreen</stricon>
		</annotation>
	</ndpviewstate>
</annotations>
```

- One `ndpviewstate` per annotation. `id` values are unique and increasing. Tabs are used for indentation, and the file is UTF-8.
- **Coordinates are nanometres from the slide centre**, using the Hamamatsu offsets.
  Image px → nm: `xNm = (px - width/2) * mppX*1000 + xOffsetNm` (see `nmToImage`/`imageToNm` in
  `app/src/components/SlideViewer.tsx`; `xOffsetNm` comes from `hamamatsu.XOffsetFromSlideCentre` in `slide.rs`).
  For non-Hamamatsu or plain images the offset is 0. If mpp is unknown, use 1 µm/px **and** mark
  the slide "uncalibrated" in the UI (the ruler shows px).
- Shape types (from our knowledge of NDP.view2; **the exact element names must be checked** against a
  real NDP.view2 file. The user can supply one that contains each shape. Until then, write
  what is below and make the parser accept variations):
  - circle: `type="circle" displayname="AnnotateCircle"`, `<x> <y> <radius>` (nm), `<measuretype>3</measuretype>`
  - freehand/polygon: `type="freehand" displayname="AnnotateFreehand"`, `<measuretype>0</measuretype><closed>1</closed><pointlist><point><x/><y/></point>…</pointlist>`
  - rectangle: `type="freehand" displayname="AnnotateRectangle"`, `<specialtype>rectangle</specialtype>`, 4-point pointlist, closed
  - ruler/line: `type="linear" displayname="AnnotateRuler"` (or `AnnotateLine`), 2-point `<pointlist>`, with `<measuretype>1</measuretype>` for rulers
- **Verified against real NDP.view2 exports** (test-data/VMS104-shapes and VMS105-shapes, 2026-11-20), which
  supersede the guesses above where they differ:
  - circle: `<x> <y> <radius>` then `<measuretype>0</measuretype>`
  - freehand: `type="freehand" displayname="AnnotateFreehand"`, `<measuretype>0</measuretype><closed>1</closed><pointlist>`;
    an open line is `displayname="AnnotateFreehandLine"` with `<closed>0</closed>`
  - rectangle: as above, with `displayname="AnnotateRectangle"` and `<specialtype>rectangle</specialtype>` after the pointlist
  - ruler: `type="linearmeasure" displayname="AnnotateRuler"` with `<x1> <y1> <x2> <y2>` (no pointlist, no measuretype)
  - arrow: `type="pointer" displayname="AnnotatePointer"` with `<x1>..<y2>`
  - pins can also use flag icons (`<icon>flagred</icon><stricon>iconflagred</stricon>`)
  - MSG's `parseNdpa` skips x1..y2 geometry, so it does not see rulers or arrows (from either app).
  - `tests/ndpa-oracle.test.ts` checks every new shape's element names and order against the real export
    (not against our own tables), byte preservation of every test file, ids, MSG's reader and VMS104 nm↔px.
  - A new viewstate's `<z>` is the focal offset in nm of the plane it was made on (0 = nominal focus), not a plane index.
  - Characters XML 1.0 can't hold (control characters, U+FFFE/FFFF, unpaired surrogates) are dropped when writing,
    so a pasted title can never make the file unreadable.
- **Round-trip preservation:** parse into a DOM. Keep each annotation's original `ndpviewstate`
  node and mutate only the fields we edit. Unknown elements and attributes, and their order, must survive.
  The test is that parse → serialize with no edits gives semantically identical XML for every file in `test-data/`.
- **MSG compatibility:** a file this app writes must parse with MSG's `parseNdpa` into the same
  titles and coordinates. Exam mode is just free-text titles like `1`, `Q1`, `Question 3`; MSG's
  `matchTitle` handles those. A soft warning (not a block) appears when two pins on one slide share a title.
- Writes are atomic (temp file + rename) and keep a `.bak` of the previous version (`write_text` with
  `keep_backup` already does this). Autosave is debounced, around 1 s after the last edit.
- Colours: pins default to green `#00ff00` with the matching `icon`/`stricon` (pingreen). If the user picks another
  colour, map it to the nearest NDP.view pin icon colour (red, green, blue, yellow, …). Check MSG/NDP files for the names.

## Architecture

```
app/src-tauri/src/
  lib.rs              Tauri commands + setup (copied from MSG; trim grader-only commands)
  slide.rs            OpenSlide FFI + tile rendering (copied from MSG)
  source/mod.rs       trait SlideSource { info(), tile(level,x,y,z), associated(name), z_planes() }
                      + registry that picks a backend by extension/probe
  source/openslide.rs wraps slide.rs
  source/plain.rs     plain images: decode with the `image`/`tiff` crates, build a downsampled pyramid in memory
                      (or on-disk cache for huge flat TIFFs), serve tiles in the same scheme
  source/czi.rs       libCZI via FFI (vendored/built in build.rs or fetched like OpenSlide; pinned + checksummed)
  scan.rs             recursive folder scan + thumbnails (associated "thumbnail"/"macro"/"label" or lowest level), disk-cached
app/src/
  App.tsx             shell: sidebar (browser) | viewer | right panel (annotations / adjustments)
  lib/store.ts        zustand store: folder, current slide, annotations, filter state, tool, prefs
  lib/ndpa.ts         parse (MSG's) + new preserving model + serializer
  lib/annotations.ts  annotation model + undo/redo
  lib/filters/*.ts    filter params, WebGL shader pipeline, stain math (Macenko, detection, normalisation, auto levels)
  components/SlideViewer.tsx   OSD viewer (adapted from MSG): tiles, overlay canvas, tools, rotation, z slider
  components/Browser.tsx       folder picker + tree + thumbnails + search
  components/AnnotationPanel.tsx, AdjustPanel.tsx, Toolbar.tsx, Navigator / ScaleBar, SnapshotDialog
```

Tile protocol: keep MSG's custom-protocol tile scheme (`parse_tile_path`) and add `z` for focal planes.
Every backend serves the same scheme, so the frontend doesn't care about the format.

Focal planes: OpenSlide exposes only one plane of a multi-plane NDPI. Support z where the backend
supports it (CZI). For NDPI z-stacks, read the extra TIFF directories directly if that is
feasible. Otherwise hide the slider for that slide and record it as a follow-up. Don't fake it.

Filters must run on the GPU and stay interactive (60 fps while panning). Recommended approach: a WebGL
post-process pass over the OSD canvas, or OSD 6's WebGL drawer with a custom shader. Stain estimation runs on a
low-res level (a thumbnail of at most about 2k px) and uses only tissue pixels (OD threshold).

Ruler: click-drag to measure in µm or mm (use `measure.ts` `fmtLength`). Escape cancels. Release creates a
linear annotation that is saved in the `.ndpa`.

## UI

Follow MSG's look: `App.css`, IBM Plex Sans/Mono, overlay title bar with traffic lights, panels, dialogs,
context menus and keyboard-first interaction. Read MSG `Grader.tsx`, `SlideViewer.tsx` and `docs/help/` for how
it feels. Toolbar tools: Pan (V), Pin (P), Ruler (R), Freehand (F), Circle (C), Rectangle (B).
Delete removes the selection, ⌘Z/⌘⇧Z undo and redo, double-click renames, and arrow keys/[ ] step through slides in the folder.

## What was copied from MSG

The Tauri project (config, capabilities, icons, Entitlements, build.rs), `src-tauri/src/*`, `tools/fetch-openslide.sh`,
`tools/release.sh`, CI workflows, `App.css`, `main.tsx`, and the generic components (Modal, ContextMenu, controls,
icons, UpdateBanner, AboutPane, HelpPanel, SettingsDialog, SlideViewer) and libs (backend, measure,
ndpa, settings, util, markdown, help, types). Many of these still hold grader-specific code. **Strip the grader
parts and adapt them.** There is no `App.tsx` yet. Before a release, a new updater key is
needed (`npx tauri signer generate -w ~/.tauri/slide-viewer.key`). The user does that.

## Test data

- `test-data/*.ndpi.ndpa`: real NDP.view2 exports (pins).
- Real slides (47 GB, read-only, **do not copy**): `/Users/alexandergadin/vscode/micro-speed-grader/images/*.ndpi`
  (VMS104.ndpi etc., which match the test-data annotations).
- Plain images, .svs and .czi samples: generate small ones in tests, or download public samples (OpenSlide
  test data at openslide.cs.cmu.edu, Zeiss CZI samples) into a gitignored `test-data/` folder.

## Done means

- `cd app && npx tsc --noEmit && npm run test:logic` pass, and `cargo check` + `cargo test` pass.
- The app runs with `npm run tauri dev`, opens `micro-speed-grader/images/`, browses, views VMS104.ndpi,
  shows the existing VMS104 annotations, and new pins and shapes autosave. The resulting file re-opens identically and parses with MSG's parser.
- Help pages exist in `docs/help/` for each feature, in MSG's style.

## Out of scope for v1

.vsi (Olympus), cloud or LMS submission, multi-user features, AI tissue segmentation.
