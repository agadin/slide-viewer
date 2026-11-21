// Visual accessibility (owner: a11y visual): theme-token contrast read straight from App.css, the 12 px text
// floor, colour names, the root classes/variables, and the reduced-motion / annotation style helpers.
import fs from "node:fs";
import path from "node:path";
import { eq, ok, test } from "./harness";
import { a11yRootState, annotationStyleFor, colorName, contrast, parseColor, reduceMotionOn, highContrastOn } from "../src/lib/a11y";
import { a11yDefaults, mergeSettings } from "../src/lib/settings";

const css = fs.readFileSync(path.resolve("src/App.css"), "utf8");
/** the custom properties of the first block that starts with `selector {` */
function tokens(selector: string): Record<string, string> {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) return {};
  const body = css.slice(i, css.indexOf("\n}", i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const root = tokens(":root");
const hc = { ...root, ...tokens(":root.a11y-hc") };

// surfaces: the opaque app backgrounds, and glass over the darkest and the brightest slide
// (a white slide behind the glass blur's brightness(0.92) is about #ebebeb)
const SLIDE_WHITE = "#ebebeb", SLIDE_DARK = "#222225";
const surfaces = (t: Record<string, string>): [string, string[]][] => [
  ["window #121214", ["#121214"]],
  ["side panel #18181b", ["#18181b"]],
  ["viewer #222225", ["#222225"]],
  ["preferences #2a2a2f", ["#2a2a2f"]],
  ["glass over a white slide", [t["--glass"], SLIDE_WHITE]],
  ["glass over a dark slide", [t["--glass"], SLIDE_DARK]],
  ["strong glass over a white slide", [t["--glass-strong"], SLIDE_WHITE]],
];

for (const [name, t] of [["default", root], ["high contrast", hc]] as const)
  test(`a11y visual: ${name} text tokens meet WCAG AA contrast on every surface`, () => {
    ok(Object.keys(t).length > 10, "read the tokens from App.css");
    for (const [sname, [bg, ...under]] of surfaces(t)) {
      for (const k of ["--tx-1", "--tx-2", "--tx-3", "--accent", "--ok", "--auto"]) {
        const c = contrast(t[k], bg, ...under);
        ok(c >= 4.5, `${k} on ${sname}: ${c.toFixed(2)} ≥ 4.5`);
      }
      // --tx-4: disabled text and decorations: still at least 3:1 (UI component level)
      const c4 = contrast(t["--tx-4"], bg, ...under);
      ok(c4 >= 3, `--tx-4 on ${sname}: ${c4.toFixed(2)} ≥ 3`);
    }
    // error text sits on the opaque panels and on strong glass (menus, toasts)
    for (const [sname, [bg, ...under]] of surfaces(t).filter(([n]) => !n.startsWith("glass over a white"))) {
      const c = contrast(t["--bad"], bg, ...under);
      ok(c >= 4.5, `--bad on ${sname}: ${c.toFixed(2)} ≥ 4.5`);
    }
    // dark text on the accent (highlighted menu rows, selected Preferences pane)
    ok(contrast("#06182a", t["--accent"]) >= 4.5, "menu highlight text on the accent");
  });

test("a11y visual: the focus ring stands out on glass and on a white slide (≥ 3:1 each side)", () => {
  for (const t of [root, hc]) {
    ok(contrast(t["--focus"], t["--focus-halo"]) >= 3, `ring ${t["--focus"]} against its halo`);
    ok(contrast(t["--focus-halo"], SLIDE_WHITE) >= 3, "halo against a white slide");
    ok(contrast(t["--focus"], t["--glass"], SLIDE_DARK) >= 3, "ring against dark glass");
    ok(contrast(t["--focus"], "#18181b") >= 3, "ring against the side panel");
  }
});

test("a11y visual: no font size under 12 px, and every one scales with --ts", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".css")) files.push(p);
    }
  };
  walk(path.resolve("src"));
  const bad: string[] = [];
  for (const f of files)
    fs.readFileSync(f, "utf8")
      .split("\n")
      .forEach((l, i) => {
        if (!/^\s*font(-size)?:/.test(l) || !/\d+(\.\d+)?px/.test(l)) return;
        const where = `${path.relative(path.resolve("src"), f)}:${i + 1}`;
        if (!l.includes("var(--ts")) bad.push(`${where} doesn't scale`);
        for (const m of l.matchAll(/([\d.]+)px/g)) if (+m[1] < 12) bad.push(`${where} ${m[1]}px`);
      });
  eq(bad, [], "font sizes ≥ 12 px and calc(… * var(--ts))");
});

test("a11y visual: parseColor and contrast basics", () => {
  eq(parseColor("#fff"), [255, 255, 255, 1], "#fff");
  eq(parseColor("rgba(16, 16, 20, 0.5)"), [16, 16, 20, 0.5], "rgba()");
  ok(Math.abs(contrast("#000", "#fff") - 21) < 0.01, "black on white is 21:1");
  ok(Math.abs(contrast("#777", "#777") - 1) < 0.01, "same colour is 1:1");
});

test("a11y visual: colour names for NDP.view's pin colours", () => {
  eq(
    ["#00ff00", "#ff0000", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#000000", "#ffffff", "#ff8000", "#808080"].map(colorName),
    ["green", "red", "blue", "yellow", "cyan", "magenta", "black", "white", "orange", "grey"],
    "names",
  );
  eq(colorName("nonsense"), "", "unknown colour → empty");
});

test("a11y visual: settings merge, root classes and variables", () => {
  eq(mergeSettings({}).a11y, a11yDefaults, "defaults fill a missing block");
  eq(mergeSettings({ a11y: { textScale: 1.3 } }).a11y.textScale, 1.3, "saved value kept");
  const os = { reducedMotion: false, moreContrast: false };
  const d = a11yRootState(a11yDefaults, os);
  eq(d.vars["--ts"], "1", "--ts 1 by default");
  ok(!d.classes["a11y-ts"] && !d.classes["a11y-hc"] && !d.classes["a11y-rm"] && !d.classes["a11y-cb"], "no classes by default");
  const big = a11yRootState({ ...a11yDefaults, textScale: 1.5, highContrast: "on", colorBlindSafe: true }, os);
  eq(big.vars["--ts"], "1.5", "--ts 1.5");
  ok(big.classes["a11y-ts"] && big.classes["a11y-hc"] && big.classes["a11y-cb"], "text, contrast and colour classes");
  eq(a11yRootState({ ...a11yDefaults, textScale: 99 }, os).vars["--ts"], "2", "text scale clamped");
});

test("a11y visual: reduce motion and high contrast follow the OS unless set", () => {
  const sys = { ...a11yDefaults };
  ok(reduceMotionOn(sys, { reducedMotion: true }), "system: OS reduce → on");
  ok(!reduceMotionOn(sys, { reducedMotion: false }), "system: OS normal → off");
  ok(!reduceMotionOn({ ...sys, reduceMotion: "off" }, { reducedMotion: true }), "off overrides the OS");
  ok(reduceMotionOn({ ...sys, reduceMotion: "on" }, { reducedMotion: false }), "on overrides the OS");
  ok(highContrastOn(sys, { moreContrast: true }), "system: OS more contrast → on");
  ok(a11yRootState({ ...sys, reduceMotion: "on" }, { reducedMotion: false, moreContrast: false }).classes["a11y-rm"], "a11y-rm class");
});

test("a11y visual: annotation display style", () => {
  const os = { reducedMotion: false, moreContrast: false };
  eq(annotationStyleFor(a11yDefaults, os), { pinScale: 1, labelScale: 1, halo: false, colorNames: false, solidLabels: false }, "defaults draw as before");
  const cb = annotationStyleFor({ ...a11yDefaults, colorBlindSafe: true, annotationScale: 1.5 }, os);
  ok(cb.halo && cb.colorNames && cb.pinScale === 1.5 && cb.labelScale === 1.5, "colour-blind-safe + 150 %");
  const h = annotationStyleFor({ ...a11yDefaults, highContrast: "on" }, os);
  ok(h.solidLabels && h.labelScale > 1 && h.halo, "high contrast: solid, larger labels");
});
