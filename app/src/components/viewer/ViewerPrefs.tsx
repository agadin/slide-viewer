/**
 * Preferences ▸ Viewing pane (settings.viewer). Owner: viewer (CONTRACTS.md).
 */
import { useSettings } from "../../lib/settings";
import { SliderRow } from "../controls";
import { Check, PrefGroup, PrefRow, Seg } from "../prefsUi";

export function ViewerPrefs() {
  const v = useSettings((s) => s.s.viewer);
  const set = useSettings((s) => s.setSection);
  return (
    <PrefGroup>
      <PrefRow label="Scroll zoom speed" help="how far one scroll-wheel step zooms">
        <SliderRow label="" value={Math.round((v.zoomPerScroll - 1) * 100)} min={5} max={60} unit="%" onChange={(x) => set("viewer", { zoomPerScroll: 1 + x / 100 })} />
      </PrefRow>
      <PrefRow label="Double-click">
        <Check checked={v.dblClickZoom} onChange={(x) => set("viewer", { dblClickZoom: x })}>zooms in</Check>
      </PrefRow>
      <PrefRow label="Animation">
        <Check checked={v.animate} onChange={(x) => set("viewer", { animate: x })}>smooth zoom and pan</Check>
      </PrefRow>
      <PrefRow label="Over the slide">
        <Check checked={v.showNavigator} onChange={(x) => set("viewer", { showNavigator: x })}>overview map</Check>
        <Check checked={v.showScaleBar} onChange={(x) => set("viewer", { showScaleBar: x })}>scale bar</Check>
        <Check checked={v.showZoomPresets} onChange={(x) => set("viewer", { showZoomPresets: x })}>zoom presets and magnification</Check>
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
