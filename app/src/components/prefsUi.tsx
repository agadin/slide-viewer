/** Building blocks for Preferences panes (shared; used by every feature's prefs pane). */
import { useId, type ReactNode } from "react";

/** one labelled row: label | control (+ help text) */
export function PrefRow({ label, children, help }: { label: string; children: ReactNode; help?: ReactNode }) {
  // a11y: the row label names the group of controls beside it, so a screen reader says "Text size, group"
  const id = useId();
  return (
    <div className="prow2">
      <label id={id}>{label}</label>
      <div className="ctl" role="group" aria-labelledby={id} aria-describedby={help ? `${id}-help` : undefined}>
        {children}
        {help && (
          <span className="help" id={`${id}-help`}>
            {help}
          </span>
        )}
      </div>
    </div>
  );
}

export function PrefGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="group">
      {title && (
        <div className="gt" role="heading" aria-level={3}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, ReactNode][];
  onChange: (v: T) => void;
  /** a11y: the group's spoken name (a PrefRow already names it) */
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" className={value === v ? "on" : ""} aria-pressed={value === v} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
