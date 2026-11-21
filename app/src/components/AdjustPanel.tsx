/**
 * Right panel ▸ Adjust tab: tone / colour / sharpen sliders with numeric fields, presets, stain separation
 * (H&E, H-DAB, estimated or custom vectors; one channel or the recombination), colour normalisation, and the
 * one-click Auto actions with a "Detected: H&E (82%)" readout. Also AdjustPrefs (Preferences ▸ Adjustments).
 * Filter state is per slide (lib/filters/pipeline.ts keeps filters.bySlide). Owner: filters.
 */
import { useState, type ReactNode } from "react";
import { isTilted, useStore } from "../lib/store";
import { useSettings } from "../lib/settings";
import { DEFAULT_FILTERS, type FilterParams, type StainMode } from "../lib/types";
import { REF_VECTORS, STAIN_NAMES, validVectors } from "../lib/filters/math";
import { stainLabel } from "../lib/filters/stain";
import { PRESETS, applyPreset, modeForAnalysis } from "../lib/filters/presets";
import { autoLevels, detectStain, estimateVectors, normalise } from "../lib/filters/auto";
import { Check, PrefGroup, PrefRow } from "./prefsUi";
import { clamp } from "../lib/util";
import "../lib/filters/filters.css";
import { sliderValueText } from "../lib/announce"; // a11y(semantics)
import { undoAdjustment, useAdjustmentUndoCount } from "../lib/filters/history";
import { rotateStep, rotateTo } from "../lib/keys";
import { signedDeg } from "./viewer/viewMath";

/** short stain names that fit the narrow panel; the full name is in the tooltip / aria-label */
const SHORT_STAIN: Record<string, string> = { Haematoxylin: "Haem.", Eosin: "Eosin", DAB: "DAB" };
const shortStain = (n: string | undefined) => (n ? (SHORT_STAIN[n] ?? n.slice(0, 6)) : "");

const set = (p: Partial<FilterParams>) => useStore.getState().setFilterParams(p);

/** slider + numeric field. `scale` converts the stored value to the shown one (e.g. 0.25 → 25 %). */
function Slider(p: {
  label: string;
  value: number;
  def: number;
  min: number;
  max: number;
  step: number;
  scale?: number;
  unit?: string;
  digits?: number;
  disabled?: boolean;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const k = p.scale ?? 1;
  const shown = p.value * k;
  const digits = p.digits ?? 0;
  const [draft, setDraft] = useState<string | null>(null);
  const changed = Math.abs(p.value - p.def) > 1e-6;
  return (
    <div className={`adj-row ${changed ? "changed" : ""}`} title={p.hint}>
      <span className="adj-label" onDoubleClick={() => p.onChange(p.def)} title={`${p.hint ? p.hint + ". " : ""}Double-click to reset`}>
        {p.label}
      </span>
      <input
        type="range"
        min={p.min * k}
        max={p.max * k}
        step={p.step * k}
        value={shown}
        disabled={p.disabled}
        aria-label={p.label}
        aria-valuetext={sliderValueText(p.label, shown, digits, p.unit)}
        onChange={(e) => p.onChange(Number(e.target.value) / k)}
        onDoubleClick={() => p.onChange(p.def)}
        style={{ ["--fill" as string]: `${((p.value - p.min) / (p.max - p.min)) * 100}%` }}
      />
      <label className="num adj-num">
        <input
          type="number"
          step={p.step * k}
          min={p.min * k}
          max={p.max * k}
          disabled={p.disabled}
          aria-label={`${p.label}${p.unit ? ` (${p.unit})` : ""}`}
          value={draft ?? shown.toFixed(digits)}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(v)) p.onChange(clamp(v, p.min * k, p.max * k) / k);
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
        {p.unit && <u>{p.unit}</u>}
      </label>
    </div>
  );
}

function Section(p: { title: string; children: ReactNode; aside?: ReactNode }) {
  const id = `adj-sec-${p.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section className="adj-sec" aria-labelledby={id}>
      <div className="adj-sec-h">
        <h3 id={id} className="sv-h2" style={{ flex: 1 }}>
          {p.title}
        </h3>
        {p.aside}
      </div>
      {p.children}
    </section>
  );
}

function VectorEditor({ vectors, names, onChange }: { vectors: number[][]; names: string[]; onChange: (v: number[][]) => void }) {
  return (
    <table className="adj-vec" aria-label="Stain vectors">
      <thead>
        <tr>
          <th />
          <th>R</th>
          <th>G</th>
          <th>B</th>
        </tr>
      </thead>
      <tbody>
        {vectors.slice(0, 2).map((row, i) => (
          <tr key={i}>
            <th scope="row" title={names[i]}>
              {shortStain(names[i]) || `S${i + 1}`}
            </th>
            {row.map((x, j) => (
              <td key={j}>
                <input
                  aria-label={`${names[i] ?? `Stain ${i + 1}`} ${"RGB"[j]} component`}
                  type="number"
                  step={0.01}
                  min={0}
                  max={1}
                  value={Number(x.toFixed(3))}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    const next = vectors.map((r) => r.slice());
                    next[i][j] = clamp(v, 0, 1);
                    onChange(next);
                  }}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AdjustPanel() {
  const info = useStore((s) => s.slide.info);
  const params = useStore((s) => s.filters.params);
  const enabled = useStore((s) => s.filters.enabled);
  const auto = useStore((s) => s.filters.auto);
  const analysis = useStore((s) => s.filters.analysis);
  const [busy, setBusy] = useState<string | null>(null);
  const undoCount = useAdjustmentUndoCount();
  const rotation = useStore((s) => s.view.rotation);
  const tiltX = useStore((s) => s.view.tiltX);
  const tiltY = useStore((s) => s.view.tiltY);
  const tilted = isTilted({ tiltX, tiltY });

  const run = (name: string, fn: () => Promise<unknown>) => async () => {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const st = params.stain;
  const mode = st.mode;
  const names = mode === "none" ? [] : STAIN_NAMES[mode];
  const custom = mode !== "none" && validVectors(st.vectors);
  const estimatedMatch = !!analysis?.vectors && custom && JSON.stringify(analysis.vectors) === JSON.stringify(st.vectors);
  const shownVectors = mode === "none" ? null : custom ? st.vectors! : REF_VECTORS[mode];
  const isDefault = JSON.stringify(params) === JSON.stringify(DEFAULT_FILTERS);
  const disabled = !info;
  const running = auto.status === "running" || !!busy;

  const setMode = (m: StainMode) => {
    if (m === "none") return set({ stain: { ...st, mode: "none" } });
    // keep estimated / custom vectors only when they belong to this mode
    const keep = validVectors(st.vectors) && (st.mode === m || (st.mode === "none" && analysis?.vectors && modeForAnalysis(analysis) === m));
    set({ stain: { mode: m, channel: st.channel, vectors: keep ? st.vectors : null } });
  };

  let readout: ReactNode;
  if (!info) readout = <span className="muted">Open a slide to adjust it.</span>;
  else if (auto.status === "running") readout = <span className="muted">Analysing the slide…</span>;
  else if (auto.status === "error") readout = <span className="warn">{auto.error}</span>;
  else if (analysis)
    readout = (
      <span title={`Tissue: ${Math.round(analysis.tissueFraction * 100)}% of the overview. Scores: ${Object.entries(analysis.scores).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}`}>
        Detected: <b>{stainLabel(analysis.stainType, analysis.subtype)}</b> <span className="muted">({Math.round(analysis.confidence * 100)}%)</span>
      </span>
    );
  else readout = <span className="muted">Not analysed yet. Auto buttons look at a small overview of the whole slide.</span>;

  return (
    <div
      className={`adj ${disabled ? "adj-off" : ""}`}
      onKeyDown={(e) => {
        // ⌘Z / Ctrl+Z inside the Adjust tab undoes adjustments (on the slide it still undoes annotations)
        const t = e.target as HTMLElement;
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && t.tagName !== "INPUT") {
          if (undoAdjustment()) {
            e.preventDefault();
            e.stopPropagation();
          }
        }
      }}
    >
      <div className="adj-head">
        <label className="check" title="Compare with the original image (\)">
          <input type="checkbox" className="switch" checked={enabled} onChange={(e) => useStore.getState().setFilters({ enabled: e.target.checked })} />
          Adjustments
        </label>
        <span className="sp" />
        <button className="btn ghost" disabled={!undoCount} onClick={() => undoAdjustment()} title="Undo the last adjustment, e.g. Normalise or Estimate vectors (⌘Z while in this tab)">
          Undo
        </button>
        <button className="btn ghost" disabled={isDefault} onClick={() => set({ ...DEFAULT_FILTERS })} title="Reset every adjustment for this slide (Undo brings them back)">
          Reset
        </button>
      </div>

      <Section title="Auto">
        <div className="adj-readout" id="adj-readout">
          {readout}
        </div>
        <div className="adj-auto">
          <button disabled={disabled || running} aria-label={busy === "levels" ? "Auto levels, working" : undefined} aria-describedby="adj-readout" onClick={run("levels", autoLevels)} title="Black / white points and gamma from the tissue (background ignored)">
            {busy === "levels" ? "…" : "Auto levels"}
          </button>
          <button disabled={disabled || running} aria-label={busy === "stain" ? "Detect stain, working" : undefined} aria-describedby="adj-readout" onClick={run("stain", () => detectStain())} title="Detect the stain (H&E, H-DAB, special) and apply a matching preset">
            {busy === "stain" ? "…" : "Detect stain"}
          </button>
          <button disabled={disabled || running} aria-label={busy === "vectors" ? "Estimate vectors, working" : undefined} aria-describedby="adj-readout" onClick={run("vectors", estimateVectors)} title="Estimate this slide's stain vectors (Macenko) for stain separation">
            {busy === "vectors" ? "…" : "Estimate vectors"}
          </button>
          <button
            className={params.normalize ? "on" : ""}
            aria-pressed={params.normalize}
            disabled={disabled || running}
            aria-label={busy === "norm" ? "Normalise, working" : "Normalise"}
            onClick={run("norm", () => normalise())}
            title={params.normalize ? "Normalised: click again to turn it off" : "Normalise colours to a reference H&E (Macenko). Click again, or Undo, to turn it off"}
          >
            {busy === "norm" ? "…" : params.normalize ? "Normalised ✓" : "Normalise"}
          </button>
        </div>
      </Section>

      <Section title="Presets">
        <div className="adj-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="btn" disabled={disabled} title={p.hint} onClick={() => useStore.getState().setFilters({ params: applyPreset(params, p), enabled: true })}>
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="Tone"
        aside={
          params.levels && (
            <button className="adj-chip" onClick={() => set({ levels: null })} title={`Black ${params.levels.black.map((x) => x.toFixed(2)).join(" ")} · White ${params.levels.white.map((x) => x.toFixed(2)).join(" ")}. Click to remove.`}>
              Levels on ✕
            </button>
          )
        }
      >
        <Slider label="Gamma" value={params.gamma} def={1} min={0.2} max={3} step={0.01} digits={2} hint=">1 brightens mid-tones" onChange={(v) => set({ gamma: v })} disabled={disabled} />
        <Slider label="Brightness" value={params.brightness} def={0} min={-1} max={1} step={0.01} scale={100} unit="%" onChange={(v) => set({ brightness: v })} disabled={disabled} />
        <Slider label="Contrast" value={params.contrast} def={0} min={-1} max={1} step={0.01} scale={100} unit="%" onChange={(v) => set({ contrast: v })} disabled={disabled} />
      </Section>

      <Section title="Colour">
        <Slider label="Saturation" value={params.saturation} def={0} min={-1} max={1} step={0.01} scale={100} unit="%" onChange={(v) => set({ saturation: v })} disabled={disabled} />
        <Slider label="Hue" value={params.hue} def={0} min={-180} max={180} step={1} unit="°" onChange={(v) => set({ hue: v })} disabled={disabled} />
        <div className="adj-checks">
          <Check checked={params.grayscale} onChange={(v) => set({ grayscale: v })}>
            Greyscale
          </Check>
          <Check checked={params.invert} onChange={(v) => set({ invert: v })}>
            Invert
          </Check>
        </div>
      </Section>

      <Section title="Sharpen">
        <Slider label="Amount" value={params.sharpen} def={0} min={0} max={2} step={0.01} scale={100} unit="%" hint="Unsharp mask strength" onChange={(v) => set({ sharpen: v })} disabled={disabled} />
        <Slider label="Radius" value={params.sharpenRadius} def={1} min={0.5} max={5} step={0.1} digits={1} unit="px" hint="Unsharp mask radius in screen pixels" onChange={(v) => set({ sharpenRadius: v })} disabled={disabled || params.sharpen === 0} />
      </Section>

      <Section
        title="Rotate"
        aside={
          rotation !== 0 ? (
            <button className="btn ghost small" onClick={() => rotateTo(0)} title="Straighten the slide again">
              Reset
            </button>
          ) : undefined
        }
      >
        <Slider
          label="Angle"
          value={signedDeg(rotation)}
          def={0}
          min={-180}
          max={180}
          step={0.5}
          digits={1}
          unit="°"
          hint="Tilt the whole slide (the overview map turns with it; annotations stay where they are on the tissue)"
          onChange={(v) => rotateTo(v)}
          disabled={disabled}
        />
        <div className="adj-rot">
          <button className="btn" disabled={disabled} onClick={() => rotateStep(90, -1)} title="Rotate left 90° (,)">
            ⟲ 90°
          </button>
          <button className="btn" disabled={disabled} onClick={() => rotateTo(signedDeg(rotation) - 1)} title="1° left">
            −1°
          </button>
          <button className="btn" disabled={disabled} onClick={() => rotateTo(signedDeg(rotation) + 1)} title="1° right">
            +1°
          </button>
          <button className="btn" disabled={disabled} onClick={() => rotateStep(90, 1)} title="Rotate right 90° (.)">
            90° ⟳
          </button>
        </div>
        <div className="adj-sub">
          <span className="muted small">Perspective</span>
          {tilted && (
            <button className="btn ghost small" onClick={() => useStore.getState().setView({ tiltX: 0, tiltY: 0 })} title="Look straight down again">
              Straighten
            </button>
          )}
        </div>
        <Slider
          label="Tip forward"
          value={tiltX}
          def={0}
          min={-60}
          max={60}
          step={1}
          unit="°"
          hint="Look at the slide at an angle, as if tipping the glass towards or away from you"
          onChange={(v) => useStore.getState().setView({ tiltX: v })}
          disabled={disabled}
        />
        <Slider
          label="Tip sideways"
          value={tiltY}
          def={0}
          min={-60}
          max={60}
          step={1}
          unit="°"
          hint="Tip the slide to the left or right"
          onChange={(v) => useStore.getState().setView({ tiltY: v })}
          disabled={disabled}
        />
        {tilted && <p className="muted small adj-note">Viewing only while tilted: pan and zoom work, but annotations and the scale bar come back when you straighten it.</p>}
      </Section>

      <Section title="Stain separation">
        <div className="seg wide adj-seg" role="group" aria-label="Stain separation">
          {(
            [
              ["none", "Off"],
              ["he", "H&E"],
              ["hdab", "H-DAB"],
            ] as [StainMode, string][]
          ).map(([m, l]) => (
            <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} disabled={disabled} onClick={() => setMode(m)}>
              {l}
            </button>
          ))}
        </div>
        {mode !== "none" && (
          <>
            <div className="seg wide adj-seg" role="group" aria-label="Stain channel">
              {[-1, 0, 1].map((c) => (
                <button
                  key={c}
                  className={st.channel === c ? "on" : ""}
                  aria-pressed={st.channel === c}
                  aria-label={c < 0 ? "All stains" : `${names[c]} only`}
                  onClick={() => set({ stain: { ...st, channel: c } })}
                  title={c < 0 ? "Recombine the separated stains (drops the residual)" : `Show ${names[c]} only`}
                >
                  {c < 0 ? "All" : shortStain(names[c])}
                </button>
              ))}
            </div>
            <div className="adj-vec-h">
              <span className="muted small">Vectors: {custom ? (estimatedMatch ? "estimated from this slide" : "custom") : "reference (Ruifrok)"}</span>
              <span className="sp" />
              {custom && (
                <button className="btn ghost" onClick={() => set({ stain: { ...st, vectors: null } })} title="Use the reference vectors">
                  Reference
                </button>
              )}
            </div>
            {shownVectors && <VectorEditor vectors={shownVectors} names={names} onChange={(v) => set({ stain: { ...st, vectors: v } })} />}
          </>
        )}
        <div className="adj-checks">
          <Check checked={params.normalize} onChange={(v) => void normalise(v)}>
            Normalise to reference H&amp;E
          </Check>
        </div>
        {params.normalize && !analysis?.vectors && <p className="muted small">Normalisation starts once the slide has been analysed.</p>}
      </Section>
    </div>
  );
}

/** Preferences ▸ Adjustments */
export function AdjustPrefs() {
  const f = useSettings((s) => s.s.filters);
  const setSection = useSettings((s) => s.setSection);
  const setAuto = (patch: Partial<typeof f.autoOnOpen>) => setSection("filters", { autoOnOpen: { ...f.autoOnOpen, ...patch } });
  return (
    <>
      <PrefGroup title="When a slide opens">
        <PrefRow label="Auto levels" help="Set black / white points and gamma from the tissue.">
          <Check checked={f.autoOnOpen.levels} onChange={(v) => setAuto({ levels: v })}>
            Apply
          </Check>
        </PrefRow>
        <PrefRow label="Detect stain" help="Recognise H&E, H-DAB or special stains and apply a matching preset.">
          <Check checked={f.autoOnOpen.stain} onChange={(v) => setAuto({ stain: v })}>
            Apply
          </Check>
        </PrefRow>
        <PrefRow label="Normalise colours" help="Match H&E slides to a reference H&E. Other stains are left alone.">
          <Check checked={f.autoOnOpen.normalize} onChange={(v) => setAuto({ normalize: v })}>
            Apply
          </Check>
        </PrefRow>
      </PrefGroup>
      <p className="help">
        Adjustments are kept per slide while the app is open. The analysis looks at a small overview of the whole slide and only at
        tissue, so the white background doesn't skew it. Press <span className="kbd">\</span> in the viewer to compare with the original.
      </p>
    </>
  );
}
