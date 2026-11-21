// Accessibility audit fixes (WCAG 2.1 AA): character-key shortcuts that can be limited to the slide (2.1.4),
// dialog focus wrapping (2.4.3), annotation-list names that start with the visible text (2.5.3), no
// clashing key bindings, and the help pages that document keyboard and screen-reader use.
// The browser audit itself (axe-core + a keyboard-only walk) is tests/ui/a11y-audit.mjs: `npm run test:a11y`.
import fs from "node:fs";
import path from "node:path";
import { test, ok, eq } from "./harness";
import { characterKeyBlocked, isCharacterKey, keyAction, KEYBOARD_KEYS } from "../src/lib/keys";
import { wrapIndex } from "../src/lib/focus";
import { annotationRowName, KEY_HINT } from "../src/lib/announce";
import { a11yDefaults, mergeSettings } from "../src/lib/settings";
import { TOOLS } from "../src/lib/types";

// npm run test:logic runs from app/ (as tests/release.test.ts assumes)
const docs = path.resolve("../docs/help");
const read = (f: string) => fs.readFileSync(path.join(docs, f), "utf8");
const docsOk = fs.existsSync(docs);

test("a11y audit: character-key shortcuts can be limited to the slide (2.1.4)", () => {
  ok(isCharacterKey({ key: "p" }), "p is a character key");
  ok(isCharacterKey({ key: "P", shiftKey: true }), "⇧P is a character key");
  ok(isCharacterKey({ key: " " }), "Space is a character key");
  ok(isCharacterKey({ key: "[" }), "[ is a character key");
  ok(!isCharacterKey({ key: "z", metaKey: true }), "⌘Z is not");
  ok(!isCharacterKey({ key: "ArrowLeft" }), "arrows are not");
  ok(!isCharacterKey({ key: "Escape" }), "Esc is not");
  ok(!isCharacterKey({ key: "F2" }), "F2 is not");
  ok(!isCharacterKey({ key: "ArrowUp", altKey: true }), "⌥ arrows are not");
  ok(!characterKeyBlocked({ key: "p", target: null }, false), "off: P works anywhere");
  ok(characterKeyBlocked({ key: "p", target: null }, true), "on: P is ignored off the slide");
  ok(!characterKeyBlocked({ key: "z", metaKey: true, target: null }, true), "on: ⌘Z still works anywhere");
  ok(!characterKeyBlocked({ key: "Escape", target: null }, true), "on: Esc still works anywhere");
  eq(a11yDefaults.singleKeysOnSlide, false, "off by default (keys work as before)");
  eq(mergeSettings({ a11y: { textScale: 1.3 } }).a11y.singleKeysOnSlide, false, "old settings files get the default");
});

test("a11y audit: Tab wraps round inside a dialog (2.4.3)", () => {
  eq(wrapIndex(2, 3, 1), 0, "Tab on the last goes to the first");
  eq(wrapIndex(0, 3, -1), 2, "⇧Tab on the first goes to the last");
  eq(wrapIndex(1, 3, 1), 2, "Tab in the middle moves on");
  eq(wrapIndex(-1, 3, 1), 0, "from outside, Tab goes to the first");
  eq(wrapIndex(-1, 3, -1), 2, "from outside, ⇧Tab goes to the last");
  eq(wrapIndex(0, 0, 1), -1, "nothing to focus");
});

test("a11y audit: annotation rows are named by their visible text first (2.5.3)", () => {
  const pin = { title: "Q1", kind: "pin" as const, color: "#00ff00" };
  eq(annotationRowName(pin, null, { index: 1, total: 5 }), "Q1, Pin, green, 2 of 5", "pin row");
  const r = annotationRowName({ title: "", kind: "ruler", color: "#ff0000" }, "245 µm", { hidden: true, duplicate: true });
  ok(r.startsWith("Untitled, Ruler · 245 µm"), `ruler row starts with what's shown: ${r}`);
  ok(r.includes("hidden") && r.includes("title used more than once"), "hidden and duplicate are said");
});

test("a11y audit: no key does two things", () => {
  for (const t of TOOLS) eq(keyAction({ key: t.key })?.kind, "tool", `${t.key.toUpperCase()} picks the ${t.id} tool and nothing else`);
  const letters = new Map<string, string>();
  for (const k of "abcdefghijklmnopqrstuvwxyz0123456789+-=,.[]") {
    const a = keyAction({ key: k });
    if (a) letters.set(k, a.kind);
  }
  ok(letters.get("x") === "cursor" && letters.get("n") === "cycle" && letters.get("m") === "map", "X, N, M have one meaning each");
  ok(!TOOLS.some((t) => ["x", "n", "m", "h"].includes(t.key)), "no tool key reuses X, N, M or H");
  eq(keyAction({ key: "N", shiftKey: true }), { kind: "cycle", dir: -1 }, "⇧N steps back");
  eq(keyAction({ key: "P", shiftKey: true }), null, "⇧P is left to the keyboard cursor (flag)");
});

test("a11y audit: help pages document keyboard and screen-reader use", () => {
  if (!docsOk) return ok(true, "docs/help not found (skipped)");
  const a = read("accessibility.md");
  for (const h of ["## Keyboard only", "## Screen readers", "## Accessibility preferences", "## Colour vision", "## Known limitations"])
    ok(a.includes(h), `accessibility.md has "${h}"`);
  ok(/VoiceOver/.test(a) && /NVDA/.test(a), "VoiceOver and NVDA notes");
  ok(/picture/i.test(a) && /annotation list/i.test(a), "says the slide image is visual and what the text alternative is");
  ok(read("index.md").includes("(accessibility.md)"), "linked from the help index");
  const s = read("shortcuts.md");
  for (const k of ["| X |", "| N / ⇧N |", "↵ or F2", "⇧F10", "⌥ + arrow", "| Space |", "## Menus", "## Keyboard cursor"]) ok(s.includes(k), `shortcuts.md lists ${k}`);
  ok(!s.includes("| ] or → | Next slide"), "shortcuts.md says the arrows pan while the keyboard cursor is on");
  ok(KEYBOARD_KEYS.length >= 10, "KEYBOARD_KEYS lists the keyboard-only keys");
  ok(/X turns on the keyboard cursor/.test(KEY_HINT), "the slide's spoken hint mentions the keyboard cursor");
});
