/**
 * TODO(viewer builder): Preferences ▸ Viewing pane (settings.viewer).
 * Owner: viewer (CONTRACTS.md). Currently a stub.
 */
import { useSettings } from "../../lib/settings";
import { SliderRow } from "../controls";
import { Check, PrefGroup, PrefRow } from "../prefsUi";

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
      </PrefRow>
    </PrefGroup>
  );
}
