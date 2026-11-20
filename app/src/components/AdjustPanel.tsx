/**
 * TODO(filters builder): right panel ▸ Adjust tab: gamma, brightness, contrast, saturation, hue,
 * grayscale, invert, sharpen, stain separation (H&E, H-DAB), one-click Auto (levels, stain vectors +
 * type detection with preset, normalisation), reset, before/after (filters.enabled).
 * Also AdjustPrefs (Preferences ▸ Adjustments: settings.filters.autoOnOpen).
 * Owner: filters (CONTRACTS.md). Currently a stub.
 */
import { useStore } from "../lib/store";

export function AdjustPanel() {
  const gamma = useStore((s) => s.filters.params.gamma);
  return (
    <div className="stub panel-stub">
      <b>Adjust</b>
      <p className="muted small">Gamma {gamma.toFixed(2)}. Image adjustments are being built.</p>
    </div>
  );
}

export function AdjustPrefs() {
  return <p className="stub muted">Adjustment preferences are coming.</p>;
}
