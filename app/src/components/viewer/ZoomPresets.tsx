/**
 * Zoom presets and the magnification readout (top-right).
 * Owner: viewer (CONTRACTS.md). settings.viewer.showZoomBar.
 *
 * Calibrated slides: Fit, 1.25×, 2.5×, 5×, 10×, 20×, 40× (mag = 10 / µm per screen px, lib/coords.ts).
 * Presets above the scan's own resolution are dimmed ("digital zoom"), presets past the zoom limit
 * are hidden. Uncalibrated images show percentages of 1:1 instead.
 */
import { useStore } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import { useViewer } from "../../lib/viewerContext";
import { zoomToFit } from "../../lib/keys";
import { fmtMag, fmtPercent, nativeMag, PERCENT_PRESETS, presetState, ZOOM_PRESETS } from "./viewMath";
import { zoomToImageZoom, zoomToMag } from "./viewerHandle";
import { spokenMag } from "../../lib/announce";

export function ZoomPresets() {
  const { viewer, info } = useViewer();
  const show = useSettings((s) => s.s.viewer.showZoomBar);
  const mag = useStore((s) => s.view.magnification);
  const um = useStore((s) => s.view.umPerScreenPx);
  if (!viewer || !info || !show) return null;

  if (!info.calibrated) {
    const imageZoom = um ? 1 / um : 0; // mpp is 1, so µm per screen px = image px per screen px
    return (
      <div className="sv-zoom sv-glass" role="toolbar" aria-label="Zoom">
        <button className="tbtn" onClick={zoomToFit} title="Fit the whole image (0)" aria-label="Fit the whole image">
          Fit
        </button>
        {PERCENT_PRESETS.map((z) => (
          <button key={z} className="tbtn" onClick={() => zoomToImageZoom(z)} title={`Zoom to ${fmtPercent(z)}`} aria-label={`Zoom to ${fmtPercent(z)}`}>
            {fmtPercent(z)}
          </button>
        ))}
        <span className="readout" title="Zoom (100% = one image pixel per screen pixel)">
          <span className="sr-only">Current zoom </span>
          {fmtPercent(imageZoom)}
        </span>
      </div>
    );
  }

  const native = nativeMag(info.mppX);
  return (
    <div className="sv-zoom sv-glass" role="toolbar" aria-label="Zoom">
      <button className="tbtn" onClick={zoomToFit} title="Fit the whole slide (0)" aria-label="Fit the whole slide">
        Fit
      </button>
      {ZOOM_PRESETS.map((m) => {
        const st = presetState(m, info.mppX);
        if (st === "off") return null;
        return (
          <button
            key={m}
            className={`tbtn ${st === "digital" ? "digital" : ""} ${mag && Math.abs(mag - m) / m < 0.02 ? "on" : ""}`}
            onClick={() => zoomToMag(m)}
            aria-label={`${fmtMag(m)}: zoom to ${spokenMag(m)}${st === "digital" ? ", beyond the scan's resolution" : ""}`}
            aria-pressed={!!mag && Math.abs(mag - m) / m < 0.02}
            title={st === "digital" ? `${fmtMag(m)}: beyond the scan's ${fmtMag(native)} (pixels are enlarged)` : `Zoom to ${fmtMag(m)}`}
          >
            {fmtMag(m)}
          </button>
        );
      })}
      <span className="sr-only">Current magnification </span>
      <span className="readout" title={`Current magnification (scan: ${fmtMag(native)}, ${info.mppX.toFixed(3)} µm/px)`}>
        {fmtMag(mag)}
      </span>
    </div>
  );
}
