/**
 * TODO(annotations builder): right panel ▸ Annotations tab: list of the slide's annotations
 * (title, kind, measurement), select/zoom to, rename, recolour, delete, duplicate-title warning,
 * save status, "Export .ndpa…" (menu "export_ndpa").
 * Owner: annotations (CONTRACTS.md). Currently a stub.
 */
import { useStore } from "../lib/store";

export function AnnotationPanel() {
  const n = useStore((s) => s.annotations.items.length);
  const info = useStore((s) => s.slide.info);
  return (
    <div className="stub panel-stub">
      <b>Annotations</b>
      <p className="muted small">{info ? `${n} annotation${n === 1 ? "" : "s"} on this slide.` : "Open a slide to see its pins and shapes."}</p>
      <p className="muted small">The annotation list is being built.</p>
    </div>
  );
}
