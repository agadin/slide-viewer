/**
 * Preferences ▸ Accessibility (settings.a11y). Owner: a11y (visual). Applied by lib/a11y.ts.
 */
import { useSettings, type A11ySettings, type A11yTri } from "../lib/settings";
import { ANNOTATION_SCALES, TEXT_SCALES, useOsPrefs } from "../lib/a11y";
import { Check, PrefGroup, PrefRow, Seg } from "./prefsUi";

const pct = (k: number) => `${Math.round(k * 100)}%`;

export function AccessibilityPrefs() {
  const a = useSettings((s) => s.s.a11y);
  const os = useOsPrefs();
  const set = (p: Partial<A11ySettings>) => useSettings.getState().setSection("a11y", p);
  const triOpts = (osOn: boolean): [A11yTri, string][] => [
    ["system", `Follow system (${osOn ? "on" : "off"})`],
    ["on", "On"],
    ["off", "Off"],
  ];
  return (
    <>
      <PrefGroup title="Text">
        <PrefRow label="Text size" help="Makes the text in menus, panels and Preferences larger. The slide is not changed.">
          <Seg
            value={String(a.textScale)}
            options={TEXT_SCALES.map((k) => [String(k), pct(k)] as [string, string])}
            onChange={(v) => set({ textScale: Number(v) })}
          />
        </PrefRow>
        <PrefRow
          label="High contrast"
          help="Solid panels instead of see-through glass, stronger borders, and larger annotation labels on a solid background."
        >
          <Seg value={a.highContrast} options={triOpts(os.moreContrast)} onChange={(v) => set({ highContrast: v })} />
        </PrefRow>
      </PrefGroup>
      <PrefGroup title="Motion">
        <PrefRow label="Reduce motion" help="Zooming and panning jump straight to the new view, and the interface doesn't animate.">
          <Seg value={a.reduceMotion} options={triOpts(os.reducedMotion)} onChange={(v) => set({ reduceMotion: v })} />
        </PrefRow>
      </PrefGroup>
      <PrefGroup title="Keyboard">
        <PrefRow
          label="Single-key shortcuts"
          help="Keys such as P, N, + and [ only work while the slide has the focus (Tab to it), so speech input or a stray key press elsewhere can't change tools or slides. Shortcuts with ⌘ or Ctrl always work."
        >
          <Check checked={!!a.singleKeysOnSlide} onChange={(v) => set({ singleKeysOnSlide: v })}>
            only when the slide has the focus
          </Check>
        </PrefRow>
      </PrefGroup>
      <PrefGroup title="Pins and shapes">
        <PrefRow label="Colour" help="Draws a white edge round pins and outlines, and writes the colour's name in each label.">
          <Check checked={a.colorBlindSafe} onChange={(v) => set({ colorBlindSafe: v })}>
            colour-blind-safe display
          </Check>
        </PrefRow>
        <PrefRow label="Pin and label size" help="Only changes how they're drawn here; the saved file is the same.">
          <Seg
            value={String(a.annotationScale)}
            options={ANNOTATION_SCALES.map((k) => [String(k), pct(k)] as [string, string])}
            onChange={(v) => set({ annotationScale: Number(v) })}
          />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
