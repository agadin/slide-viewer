/**
 * Preferences ▸ Pins & shapes (settings.annotations). Owner: annotations (CONTRACTS.md).
 */
import { useSettings } from "../../lib/settings";
import { PIN_COLORS } from "../../lib/ndpa";
import { Check, PrefGroup, PrefRow, Seg } from "../prefsUi";
import "./annotations.css";

const DELAYS: [string, string][] = [
  ["500", "0.5 s"],
  ["1000", "1 s"],
  ["3000", "3 s"],
];

export function AnnotationPrefs() {
  const a = useSettings((s) => s.s.annotations);
  const set = (p: Partial<typeof a>) => useSettings.getState().setSection("annotations", p);
  return (
    <>
      <PrefGroup title="New pins and shapes">
        <PrefRow label="Colour" help="Pins use NDP.view's pin colours, so they look the same there.">
          <div className="ann-colors">
            {PIN_COLORS.map((c) => (
              <button
                key={c.hex}
                className={`ann-swatch ${a.defaultColor === c.hex ? "on" : ""}`}
                style={{ background: c.hex }}
                title={c.name}
                aria-label={c.name}
                onClick={() => set({ defaultColor: c.hex })}
              />
            ))}
          </div>
        </PrefRow>
        <PrefRow label="Titles">
          <Check checked={a.showTitles} onChange={(v) => set({ showTitles: v })}>
            Show titles on the slide
          </Check>
        </PrefRow>
      </PrefGroup>
      <PrefGroup title="Saving">
        <PrefRow
          label="Autosave after"
          help="Annotations save as <slide>.ndpa next to the slide (NDP.view's format), keeping the previous version as .ndpa.bak. A read-only folder saves to the app's data folder instead."
        >
          <Seg value={String(a.autosaveMs)} options={DELAYS.some(([v]) => v === String(a.autosaveMs)) ? DELAYS : [...DELAYS, [String(a.autosaveMs), `${a.autosaveMs} ms`]]} onChange={(v) => set({ autosaveMs: Number(v) })} />
        </PrefRow>
      </PrefGroup>
    </>
  );
}
