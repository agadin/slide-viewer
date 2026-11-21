/**
 * Bottom-edge bar for files that hold more than a single picture. Each part only shows when it's needed:
 *  - Image / Position picker: a .lif with several images, an .nd2 with several stage positions
 *    (SlideInfo.series). Picking one reopens the file at that image (store.openSlide(path, series));
 *    the annotations belong to the file, so they stay.
 *  - Time slider with play / pause: a time series (SlideInfo.timePoints). Writes store `view.t`;
 *    SlideViewer fades to the new time point like it does for focal planes.
 * Keys: T / ⇧T step time points (lib/keys.ts). Owner: viewer (CONTRACTS.md).
 */
import { useEffect } from "react";
import { useStore } from "../../lib/store";
import { useSettings } from "../../lib/settings";
import { useViewer } from "../../lib/viewerContext";
import { stepTime } from "../../lib/keys";

/** time between frames while playing */
export const PLAY_MS = 700;

export function TimeBar() {
  const { viewer, info } = useViewer();
  const t = useStore((s) => s.view.t);
  const playing = useStore((s) => s.view.playing);
  const setView = useStore((s) => s.setView);
  const path = useStore((s) => s.slide.path);
  const loading = useStore((s) => s.slide.loading);
  const toolbar = useSettings((s) => s.s.viewer.showToolbar);

  const times = info?.timePoints ?? [];
  const series = info?.series ?? [];
  const hasTime = times.length > 1;
  const hasSeries = series.length > 1;

  // playback: step (and loop) while playing; stops when the slide changes (openSlide resets the view)
  useEffect(() => {
    if (!playing || !hasTime) return;
    const id = window.setInterval(() => stepTime(1, true), PLAY_MS);
    return () => window.clearInterval(id);
  }, [playing, hasTime]);

  if (!viewer || !info || (!hasTime && !hasSeries)) return null;

  const pos = Math.max(0, times.findIndex((p) => p.index === t));
  const label = hasTime ? times[pos].label : "";
  const kind = info.seriesKind || "Image";

  return (
    <div className={`sv-timebar sv-glass ${toolbar ? "above-tools" : ""}`} role="group" aria-label={hasTime ? "Time series" : kind}>
      {hasSeries && (
        <label className="series" title={`${kind} ${info.seriesIndex + 1} of ${series.length}: ${series[info.seriesIndex] ?? ""}`}>
          <span className="muted">{kind}</span>
          <select
            value={info.seriesIndex}
            disabled={loading}
            onChange={(e) => path && void useStore.getState().openSlide(path, Number(e.target.value))}
            aria-label={`${kind} (${series.length} in this file)`}>
            {series.map((name, i) => (
              <option key={i} value={i}>
                {i + 1}. {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {hasTime && (
        <>
          <button className="tbtn" onClick={() => stepTime(-1)} disabled={pos <= 0} title="Previous time point (⇧T)" aria-label="Previous time point">
            ◀
          </button>
          <button
            className="tbtn play"
            onClick={() => setView({ playing: !playing })}
            title={playing ? "Pause" : "Play the time series"}
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button className="tbtn" onClick={() => stepTime(1)} disabled={pos >= times.length - 1} title="Next time point (T)" aria-label="Next time point">
            ▶▏
          </button>
          <input
            type="range"
            min={0}
            max={times.length - 1}
            step={1}
            value={pos}
            style={{ "--fill": `${(pos / (times.length - 1)) * 100}%` } as React.CSSProperties}
            onChange={(e) => setView({ t: times[Number(e.target.value)].index, playing: false })}
            title="Time point"
            aria-label="Time point"
            aria-valuetext={`${label}, time point ${pos + 1} of ${times.length}`}
          />
          <span className="tlabel" title={label} aria-hidden>
            {label}
          </span>
          <span className="muted" aria-hidden>
            {pos + 1}/{times.length}
          </span>
        </>
      )}
    </div>
  );
}
