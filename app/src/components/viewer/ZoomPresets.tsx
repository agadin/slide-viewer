/**
 * Zoom presets and the magnification readout (top-right).
 * Owner: viewer (CONTRACTS.md). settings.viewer.showZoomPresets.
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

export function ZoomPresets() {
  const { viewer, info } = useViewer();
  const show = useSettings((s) => s.s.viewer.showZoomPresets);
  const mag = useStore((s) => s.view.magnification);
  const um = useStore((s) => s.view.umPerScreenPx);
  if (!viewer || !info || !show) return null;

  if (!info.calibrated) {
    const imageZoom = um ? 1 / um : 0; // mpp is 1, so µm per screen px = image px per screen px
    return (
      <div className="sv-zoom sv-glass" role="toolbar" aria-label="Zoom">
        <button className="tbtn" onClick={zoomToFit} title="Fit the whole image (0)">
          Fit
        </button>
        {PERCENT_PRESETS.map((z) => (
          <button key={z} className="tbtn" onClick={() => zoomToImageZoom(z)} title={`Zoom to ${fmtPercent(z)}`}>
            {fmtPercent(z)}
          </button>
        ))}
        <span className="readout" title="Zoom (100% = one image pixel per screen pixel)">
          {fmtPercent(imageZoom)}
        </span>
      </div>
    );
  }

  const native = nativeMag(info.mppX);
  return (
    <div className="sv-zoom sv-glass" role="toolbar" aria-label="Zoom">
      <button className="tbtn" onClick={zoomToFit} title="Fit the whole slide (0)">
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
            title={st === "digital" ? `${fmtMag(m)}: beyond the scan's ${fmtMag(native)} (pixels are enlarged)` : `Zoom to ${fmtMag(m)}`}
          >
            {fmtMag(m)}
          </button>
        );
      })}
      <span className="readout" title={`Current magnification (scan: ${fmtMag(native)}, ${info.mppX.toFixed(3)} µm/px)`}>
        {fmtMag(mag)}
      </span>
    </div>
  );
}
