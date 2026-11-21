/**
 * Right panel ▸ Annotations: the slide's pins and shapes. Owner: annotations (CONTRACTS.md).
 * Click a row to select it and show it on the slide; double-click (or ✎) renames; the swatch recolours;
 * the eye hides it from view (not saved); × deletes. The selected row also edits its notes (NDP.view's
 * "details"). A soft warning appears when two annotations share a title (exam answers should be unique).
 * The footer shows the save state, where the file is, and "Export .ndpa…".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { basename, revealFile } from "../lib/backend";
import { fireMenu } from "../lib/menu";
import {
  kindLabel,
  deleteAnnotations,
  duplicateTitles,
  measureText,
  renameAnnotation,
  requestJump,
  toggleHidden,
  updateAnnotation,
  useAnnUi,
} from "../lib/annotations";
import { PIN_COLORS } from "../lib/ndpa";
import type { Annotation, SaveState } from "../lib/types";
import { IconExport, IconPencil, IconTrash } from "./icons";
import "./annotations/annotations.css";
import { annotationRowName, colorName } from "../lib/announce"; // a11y(semantics)

const EyeIcon = ({ off }: { off: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
    {off && <path d="M2.5 13.5l11-11" />}
  </svg>
);

const SAVE_TEXT: Record<SaveState, string> = { idle: "", dirty: "Unsaved changes…", saving: "Saving…", saved: "Saved", error: "Not saved" };

export function AnnotationPanel() {
  const info = useStore((s) => s.slide.info);
  const items = useStore((s) => s.annotations.items);
  const selection = useStore((s) => s.annotations.selection);
  const save = useStore((s) => s.annotations.save);
  const saveError = useStore((s) => s.annotations.saveError);
  const filePath = useStore((s) => s.annotations.filePath);
  const hidden = useAnnUi((s) => s.hidden);
  const notice = useAnnUi((s) => s.notice);
  const loadError = useAnnUi((s) => s.loadError);
  const dups = useMemo(() => duplicateTitles(items), [items]);
  const dupIds = useMemo(() => new Set([...dups.values()].flat()), [dups]);
  const listRef = useRef<HTMLUListElement>(null);

  // keep the selected row in view (selection usually comes from the slide)
  useEffect(() => {
    if (selection.length !== 1) return;
    listRef.current?.querySelector(`[data-id="${CSS.escape(selection[0])}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  if (!info) return <div className="ann-panel"><p className="ann-empty">Open a slide to see its pins and shapes.</p></div>;

  const dupTitles = [...dups.keys()].map((k) => items.find((a) => a.title.trim().toLowerCase() === k)?.title.trim() ?? k);
  const allHidden = items.length > 0 && items.every((a) => hidden.includes(a.id));

  return (
    <div className="ann-panel">
      <div className="ann-head">
        <h2 className="sv-h2">
          <b>{items.length ? `${items.length} annotation${items.length === 1 ? "" : "s"}` : "No annotations"}</b>
        </h2>
        <span className="grow" />
        {items.length > 0 && (
          <button
            className="tbtn"
            title={allHidden ? "Show all" : "Hide all"}
            aria-label={allHidden ? "Show all annotations" : "Hide all annotations"}
            onClick={() => useAnnUi.setState({ hidden: allHidden ? [] : items.map((a) => a.id) })}
          >
            <EyeIcon off={allHidden} />
          </button>
        )}
      </div>

      {!info.calibrated && <div className="ann-note">This slide has no pixel size, so measurements are in pixels.</div>}
      {loadError && <div className="ann-note bad">{loadError}</div>}
      {notice && <div className="ann-note warn">{notice}</div>}
      {dupTitles.length > 0 && (
        <div className="ann-note warn" role="status">
          {dupTitles.length === 1 ? (
            <>
              Two or more annotations are titled <b>“{dupTitles[0]}”</b>. That's fine for notes, but exam answers need one pin per title.
            </>
          ) : (
            <>
              Repeated titles: {dupTitles.map((t, i) => (
                <span key={t}>
                  {i ? ", " : ""}
                  <b>“{t}”</b>
                </span>
              ))}
              . Exam answers need one pin per title.
            </>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <p className="ann-empty">
          Press <span className="kbd">P</span> and click to place a pin, then type its title (for example <i>Q1</i>). <span className="kbd">R</span> measures,{" "}
          <span className="kbd">F</span> <span className="kbd">C</span> <span className="kbd">B</span> draw shapes. Everything saves automatically next to the slide.
        </p>
      ) : (
        <ul className="ann-list" ref={listRef} aria-label="Annotations">
          {items.map((a, i) => (
            <Row
              key={a.id}
              a={a}
              index={i}
              total={items.length}
              selected={selection.includes(a.id)}
              hidden={hidden.includes(a.id)}
              dup={dupIds.has(a.id)}
              calibrated={info.calibrated}
            />
          ))}
        </ul>
      )}

      <div className="ann-foot">
        <span className={`ann-status ${save === "error" ? "error" : ""}`} title={saveError ?? filePath ?? ""}>
          {save === "error" ? `Not saved: ${saveError ?? "unknown error"}` : SAVE_TEXT[save] || (filePath ? basename(filePath) : "")}
        </span>
        <span className="grow" />
        {filePath && save !== "idle" && save !== "dirty" && (
          <button className="tbtn" onClick={() => void revealFile(filePath)} title={filePath}>
            Show file
          </button>
        )}
        <button className="tbtn" onClick={() => fireMenu("export_ndpa")} title="Save a copy of this slide's annotations (.ndpa) somewhere else">
          <IconExport /> Export .ndpa…
        </button>
      </div>
    </div>
  );
}

function Row({
  a,
  index,
  total,
  selected,
  hidden,
  dup,
  calibrated,
}: {
  a: Annotation;
  index: number;
  total: number;
  selected: boolean;
  hidden: boolean;
  dup: boolean;
  calibrated: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [colors, setColors] = useState(false);
  const m = measureText(a, calibrated);
  const name = a.title.trim() ? `“${a.title.trim()}”` : "untitled annotation";
  const select = (e: { shiftKey: boolean; metaKey: boolean }) => {
    const st = useStore.getState();
    const sel = st.annotations.selection;
    if (e.shiftKey || e.metaKey) st.select(sel.includes(a.id) ? sel.filter((x) => x !== a.id) : [...sel, a.id]);
    else {
      st.select([a.id]);
      requestJump(a.id);
    }
  };
  return (
    <li className={`ann-row ${selected ? "sel" : ""} ${hidden ? "hidden" : ""}`} data-id={a.id} onClick={select} onDoubleClick={() => setRenaming(true)}>
      <button
        className="ann-swatch"
        style={{ background: a.color }}
        title="Colour"
        aria-label={`Colour of ${name}: ${colorName(a.color)}. Change`}
        aria-expanded={colors}
        onClick={(e) => {
          e.stopPropagation();
          setColors((c) => !c);
        }}
      />
      <div
        className="ann-main"
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={renaming ? undefined : annotationRowName(a, m, { index, total, hidden, duplicate: dup })}
        aria-current={selected && !renaming ? "true" : undefined}
        onKeyDown={(e) => {
          if (renaming || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            select(e);
          } else if (e.key === "F2") {
            e.preventDefault();
            setRenaming(true);
          }
        }}
      >
        {renaming ? (
          <input
            className="ann-rename"
            aria-label={`Title of ${name}`}
            autoFocus
            defaultValue={a.title}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") {
                e.currentTarget.value = a.title;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              setRenaming(false);
              if (e.currentTarget.value.trim() !== a.title) renameAnnotation(a.id, e.currentTarget.value);
            }}
          />
        ) : (
          <span className={`ann-title ${a.title ? "" : "empty"}`} title={a.title}>
            {a.title || "Untitled"}
            {dup && (
              <span className="ann-dup" title="Another annotation has this title" aria-hidden>
                ⚠
              </span>
            )}
          </span>
        )}
        {" "}
        <span className="ann-sub">{[kindLabel(a), m].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="ann-actions" onClick={(e) => e.stopPropagation()}>
        <button className="tbtn" title="Rename (double-click)" aria-label={`Rename ${name}`} onClick={() => setRenaming(true)}>
          <IconPencil />
        </button>
        <button className="tbtn" title={hidden ? "Show" : "Hide"} aria-label={`${hidden ? "Show" : "Hide"} ${name}`} onClick={() => toggleHidden(a.id)}>
          <EyeIcon off={hidden} />
        </button>
        <button
          className="tbtn"
          title="Delete"
          aria-label={`Delete ${name}`}
          onClick={(e) => {
            // a11y(audit): the row goes away, so put the focus on the next row (or the previous one, or the
            // slide) instead of losing it on <body> (WCAG 2.4.3)
            const li = e.currentTarget.closest("li");
            const sib = (li?.nextElementSibling ?? li?.previousElementSibling)?.querySelector<HTMLElement>(".ann-main");
            deleteAnnotations([a.id]);
            requestAnimationFrame(() => (sib?.isConnected ? sib : document.querySelector<HTMLElement>(".openseadragon-canvas"))?.focus());
          }}
        >
          <IconTrash />
        </button>
      </div>
      {colors && (
        <div className="ann-colors" role="group" aria-label={`Colours for ${name}`} onClick={(e) => e.stopPropagation()}>
          {PIN_COLORS.map((c) => (
            <button
              key={c.hex}
              className={`ann-swatch ${a.color === c.hex ? "on" : ""}`}
              style={{ background: c.hex }}
              title={c.name}
              aria-label={c.name}
              aria-pressed={a.color === c.hex}
              onClick={() => updateAnnotation(a.id, { color: c.hex })}
            />
          ))}
          {a.kind !== "pin" && (
            <input type="color" value={a.color} title="Any colour" aria-label="Any colour" onChange={(e) => updateAnnotation(a.id, { color: e.target.value })} />
          )}
        </div>
      )}
      {selected && (
        <textarea
          key={`${a.id}:${a.details}`}
          className="ann-details"
          placeholder="Notes (saved with the annotation)"
          aria-label={`Notes for ${name}`}
          defaultValue={a.details}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onBlur={(e) => e.currentTarget.value !== a.details && updateAnnotation(a.id, { details: e.currentTarget.value })}
        />
      )}
    </li>
  );
}
