/** Building blocks for Preferences panes (shared; used by every feature's prefs pane). */
import type { ReactNode } from "react";

/** one labelled row: label | control (+ help text) */
export function PrefRow({ label, children, help }: { label: string; children: ReactNode; help?: ReactNode }) {
  return (
    <div className="prow2">
      <label>{label}</label>
      <div className="ctl">
        {children}
        {help && <span className="help">{help}</span>}
      </div>
    </div>
  );
}

export function PrefGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="group">
      {title && <div className="gt">{title}</div>}
      {children}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
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
