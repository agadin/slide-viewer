/**
 * Preferences ▸ Viewing pane (settings.viewer). Owner: viewer (CONTRACTS.md).
 */
import { useSettings } from "../../lib/settings";
import { NAV_MAX, NAV_MIN } from "./Navigator";
import { SliderRow } from "../controls";
import { Check, PrefGroup, PrefRow, Seg } from "../prefsUi";

export function ViewerPrefs() {
  const v = useSettings((s) => s.s.viewer);
  const set = useSettings((s) => s.setSection);
  return (
    <PrefGroup>
      <PrefRow label="Scroll zoom speed" help="how far one scroll-wheel step zooms">
        <SliderRow label="" name="Scroll zoom speed" value={Math.round((v.zoomPerScroll - 1) * 100)} min={5} max={60} unit="%" onChange={(x) => set("viewer", { zoomPerScroll: 1 + x / 100 })} />
      </PrefRow>
      <PrefRow label="Double-click">
        <Check checked={v.dblClickZoom} onChange={(x) => set("viewer", { dblClickZoom: x })}>zooms in</Check>
      </PrefRow>
      <PrefRow label="Animation">
        <Check checked={v.animate} onChange={(x) => set("viewer", { animate: x })}>smooth zoom and pan</Check>
      </PrefRow>
      <PrefRow label="Over the slide">
        <Check checked={v.showNavigator} onChange={(x) => set("viewer", { showNavigator: x })}>overview map (M)</Check>
        <Check checked={v.showScaleBar} onChange={(x) => set("viewer", { showScaleBar: x })}>scale bar</Check>
        <Check checked={v.showZoomBar} onChange={(x) => set("viewer", { showZoomBar: x })}>zoom bar (presets and magnification)</Check>
        <Check checked={v.showToolbar} onChange={(x) => set("viewer", { showToolbar: x })}>tool bar (pin, ruler and shape tools)</Check>
      </PrefRow>
      <PrefRow label="Overview map size" help="Or drag the map's bottom-right corner. Drag its top edge to move it; double-click either to put it back.">
        <SliderRow label="" name="Overview map size" value={v.navSize ?? 200} min={NAV_MIN} max={NAV_MAX} unit=" px" onChange={(x) => set("viewer", { navSize: x })} />
        {(v.navPos || (v.navSize ?? 200) !== 200) && (
          <button className="btn ghost" onClick={() => set("viewer", { navPos: null, navSize: 200 })}>
            Reset Map
          </button>
        )}
      </PrefRow>
      <PrefRow label="Scale bar position">
        <Seg
          value={v.scaleBarPos ?? "bottom-left"}
          options={[
            ["bottom-left", "Bottom left"],
            ["bottom-right", "Bottom right"],
            ["top-left", "Top left"],
            ["top-right", "Top right"],
          ]}
          onChange={(x) => set("viewer", { scaleBarPos: x as typeof v.scaleBarPos })}
        />
      </PrefRow>
      <PrefRow label="Window" help="Takes effect the next time Slide Viewer opens. ⌃⌘F switches full screen any time.">
        <Check checked={v.openFullScreen} onChange={(x) => set("viewer", { openFullScreen: x })}>open full screen</Check>
      </PrefRow>
      <PrefRow label="Free rotation step" help="Shift-click the rotate buttons, or press ⇧, and ⇧. (the , and . keys turn 90°)">
        <Seg
          value={String(v.rotateStep)}
          options={[
            ["5", "5°"],
            ["15", "15°"],
            ["30", "30°"],
            ["45", "45°"],
          ]}
          onChange={(x) => set("viewer", { rotateStep: Number(x) })}
        />
      </PrefRow>
    </PrefGroup>
  );
}
