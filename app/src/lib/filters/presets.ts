/** Adjustment presets, and the preset applied after stain-type detection. Pure. Owner: filters. */
import { DEFAULT_FILTERS, type FilterParams, type StainAnalysis } from "../types";

export interface Preset {
  id: string;
  label: string;
  /** what it does, for the tooltip */
  hint: string;
  /** params patch on top of DEFAULT_FILTERS (presets replace the current look; levels/normalise are kept) */
  params: Partial<FilterParams>;
}

export const PRESETS: Preset[] = [
  { id: "crisp", label: "Crisp", hint: "A little more contrast, colour and sharpness", params: { contrast: 0.15, saturation: 0.15, sharpen: 0.5, sharpenRadius: 1 } },
  { id: "pale", label: "Pale slide", hint: "Darker mid-tones and stronger colour for faded or thin sections", params: { gamma: 0.8, contrast: 0.2, saturation: 0.35 } },
  { id: "dark", label: "Dark slide", hint: "Lift the mid-tones of a heavily stained or dark scan", params: { gamma: 1.4, brightness: 0.05 } },
  { id: "nuclei", label: "Nuclei", hint: "Haematoxylin only (H&E separation)", params: { stain: { mode: "he", channel: 0, vectors: null } } },
  { id: "eosin", label: "Eosin", hint: "Eosin only (H&E separation)", params: { stain: { mode: "he", channel: 1, vectors: null } } },
  { id: "dab", label: "DAB", hint: "DAB only (H-DAB separation)", params: { stain: { mode: "hdab", channel: 1, vectors: null } } },
  { id: "mono", label: "Grey", hint: "Greyscale with extra contrast", params: { grayscale: true, contrast: 0.2 } },
  { id: "dark-field", label: "Inverted", hint: "Negative image (dark background)", params: { invert: true } },
];

/** the params a preset produces: DEFAULT_FILTERS + preset, keeping the current auto levels and normalisation */
export function applyPreset(current: FilterParams, preset: Preset): FilterParams {
  return { ...DEFAULT_FILTERS, levels: current.levels, normalize: current.normalize, ...preset.params };
}

/**
 * The adjustment patch for a detected stain: mild, type-appropriate viewing tweaks, and the stain-separation
 * vectors primed with the slide's own estimate (separation stays off until the student picks a channel).
 */
export function presetForAnalysis(a: StainAnalysis): Partial<FilterParams> {
  const vectors = a.vectors && a.confidence >= 0.3 ? a.vectors.map((r) => r.slice()) : null;
  switch (a.stainType) {
    case "he":
      return { contrast: 0.08, stain: { mode: "none", channel: 0, vectors } };
    case "hdab":
      return { contrast: 0.15, saturation: 0.05, stain: { mode: "none", channel: 1, vectors } };
    case "special":
      if (a.subtype === "silver") return { contrast: 0.2, gamma: 1.1, stain: { mode: "none", channel: 0, vectors: null } };
      return { contrast: 0.1, saturation: 0.15, stain: { mode: "none", channel: 0, vectors: null } };
    default:
      return {};
  }
}

/** which separation mode estimated vectors belong to */
export const modeForAnalysis = (a: StainAnalysis | null) => (a?.stainType === "hdab" ? "hdab" : "he") as "he" | "hdab";
