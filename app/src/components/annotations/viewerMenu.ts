/**
 * The right-click menus over the slide. With the tool bar and zoom bar hidden (the default,
 * Preferences ▸ Viewing), this is where annotations are placed and the zoom is changed.
 *
 *   empty slide  → Add pin ▸ / Add flag ▸ (colours), Ruler / Freehand / Circle / Rectangle,
 *                  Zoom ▸ (fit, in, out, presets), Rotate ▸, Undo / Redo, Snapshot
 *   annotation   → Rename, Pin style ▸ (pins), Colour ▸, Delete
 *
 * a11y: the same menus open from the keyboard (⇧F10 / the Menu key, or ↵ with the keyboard cursor on;
 * AnnotationLayer.tsx), at the keyboard cursor or at the selected annotation. Ticked items (`checked`)
 * are announced as radio items by ContextMenu.tsx, so every item in a choice list sets `checked`.
 */
import { useStore, type MenuItemSpec } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import { PIN_COLORS, nearestPinColor } from "../../lib/ndpa";
import { TOOLS, type Annotation, type PinStyle, type Tool } from "../../lib/types";
import { rotateStep, rotateTo, zoomToFit } from "../../lib/keys";
import { fireMenu } from "../../lib/menu";
import { zoomBy, zoomToImageZoom, zoomToMag } from "../viewer/viewerHandle";
import { fmtMag, fmtPercent, nativeMag, PERCENT_PRESETS, presetState, ZOOM_PRESETS } from "../viewer/viewMath";

type Item = MenuItemSpec | "sep";
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** the colour list for a pin/flag submenu; the default colour is ticked */
function colourItems(onPick: (hex: string) => void, current?: string): Item[] {
  const cur = current ? nearestPinColor(current).hex : nearestPinColor(useSettings.getState().s.annotations.defaultColor).hex;
  return PIN_COLORS.map((c) => ({ label: cap(c.name), swatch: c.hex, checked: c.hex === cur, onSelect: () => onPick(c.hex) }));
}

/** Zoom ▸ : fit, in / out, and the magnification presets (percentages for uncalibrated images) */
export function zoomItems(): Item[] {
  const info = useStore.getState().slide.info;
  const mag = useStore.getState().view.magnification;
  const items: Item[] = [
    { label: "Fit the slide", shortcut: "0", onSelect: zoomToFit },
    { label: "Zoom in", shortcut: "+", onSelect: () => zoomBy(2) },
    { label: "Zoom out", shortcut: "−", onSelect: () => zoomBy(0.5) },
  ];
  if (!info) return items;
  items.push("sep");
  if (!info.calibrated) {
    for (const z of PERCENT_PRESETS) items.push({ label: fmtPercent(z), onSelect: () => zoomToImageZoom(z) });
    return items;
  }
  const native = nativeMag(info.mppX);
  for (const m of ZOOM_PRESETS) {
    const st = presetState(m, info.mppX);
    if (st === "off") continue;
    items.push({
      label: st === "digital" ? `${fmtMag(m)}  (beyond the scan's ${fmtMag(native)})` : fmtMag(m),
      checked: !!mag && Math.abs(mag - m) / m < 0.02,
      onSelect: () => zoomToMag(m),
    });
  }
  return items;
}

const rotateItems = (): Item[] => [
  { label: "Rotate left 90°", shortcut: ",", onSelect: () => rotateStep(90, -1) },
  { label: "Rotate right 90°", shortcut: ".", onSelect: () => rotateStep(90, 1) },
  { label: "Reset rotation", disabled: useStore.getState().view.rotation === 0, onSelect: () => rotateTo(0) },
];

const SHAPES: { tool: Tool; label: string }[] = [
  { tool: "ruler", label: "Measure (ruler)" },
  { tool: "freehand", label: "Draw freehand outline" },
  { tool: "circle", label: "Draw circle" },
  { tool: "rectangle", label: "Draw rectangle" },
];

/** menu for a right-click on the slide (not on an annotation) */
export function slideMenu(o: { placePin: (style: PinStyle, hex: string) => void; startShape: (tool: Tool) => void }): Item[] {
  const s = useStore.getState();
  const key = (t: Tool) => TOOLS.find((x) => x.id === t)?.key.toUpperCase();
  return [
    { label: "Add pin here", submenu: colourItems((hex) => o.placePin("pin", hex)) },
    { label: "Add flag here", submenu: colourItems((hex) => o.placePin("flag", hex)) },
    "sep",
    ...SHAPES.map((x) => ({ label: x.label, shortcut: key(x.tool), checked: s.annotations.tool === x.tool, onSelect: () => o.startShape(x.tool) })),
    "sep",
    { label: "Zoom", submenu: zoomItems() },
    { label: "Rotate", submenu: rotateItems() },
    "sep",
    { label: "Undo", shortcut: "⌘Z", disabled: !s.annotations.undo.length, onSelect: s.undo },
    { label: "Redo", shortcut: "⌘⇧Z", disabled: !s.annotations.redo.length, onSelect: s.redo },
    { label: "Save view as PNG…", shortcut: "⇧S", onSelect: () => fireMenu("snapshot") },
  ];
}

/** menu for a right-click on an annotation */
export function annotationMenu(
  a: Annotation,
  ids: string[],
  o: { rename: () => void; update: (patch: Partial<Annotation>) => void; remove: () => void },
): Item[] {
  const items: Item[] = [{ label: "Rename…", shortcut: "F2", onSelect: o.rename }];
  if (a.kind === "pin") {
    const style = a.pinStyle ?? "pin";
    items.push({
      label: "Style",
      submenu: [
        { label: "Pin", checked: style === "pin", onSelect: () => o.update({ pinStyle: undefined }) },
        { label: "Flag", checked: style === "flag", onSelect: () => o.update({ pinStyle: "flag" }) },
      ],
    });
  }
  items.push({ label: "Colour", submenu: colourItems((hex) => o.update({ color: hex }), a.color) });
  items.push("sep", { label: "Zoom", submenu: zoomItems() });
  items.push("sep", { label: ids.length > 1 ? `Delete ${ids.length} annotations` : "Delete", shortcut: "⌫", danger: true, onSelect: o.remove });
  return items;
}
