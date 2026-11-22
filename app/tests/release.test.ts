// Release builder's tests: the help wiki (docs/help) and README links resolve, every help reference in the
// app points at a real page and heading, and the release plumbing agrees on names, versions and bundling.
// Run from app/ (npm run test:logic).
import fs from "node:fs";
import path from "node:path";
import { eq, ok, test } from "./harness";
import { parseMarkdown, slug, type Doc } from "../src/lib/markdown";
import { findHelpRefs, parseRef, refResolves } from "../src/lib/helpRefs";

const ROOT = path.resolve("..");
const HELP = path.join(ROOT, "docs/help");
const read = (p: string) => fs.readFileSync(p, "utf8");

const helpDocs = (): Map<string, Doc> =>
  new Map(
    fs
      .readdirSync(HELP)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [f.replace(/\.md$/, ""), parseMarkdown(read(path.join(HELP, f)))]),
  );

/** problems with the Markdown links and images in `file` (relative to its own folder) */
function badLinks(file: string, docs: Map<string, Doc>): string[] {
  const bad: string[] = [];
  const dir = path.dirname(file);
  const src = read(file).replace(/```[\s\S]*?```/g, "");
  const name = path.relative(ROOT, file);
  const headingsOf = (p: string): string[] | null => {
    if (path.dirname(p) === HELP && p.endsWith(".md")) return docs.get(path.basename(p, ".md"))?.headings.map((h) => h.id) ?? null;
    if (p.endsWith(".md") && fs.existsSync(p)) return parseMarkdown(read(p)).headings.map((h) => h.id);
    return null;
  };
  // images: ![alt](src) and <img src="…">
  for (const m of src.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]*\ssrc="([^"]+)"/g)) {
    const s = m[1] ?? m[2];
    if (/^https?:/.test(s)) continue;
    if (!fs.existsSync(path.resolve(dir, s))) bad.push(`${name}: image ${s}`);
  }
  for (const m of src.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?|mailto):/.test(href)) continue;
    const [f, anchor] = href.split("#");
    // GitHub-relative links in the README (../../releases) leave the repo; they're fine on GitHub
    if (f.startsWith("../../")) continue;
    const target = f ? path.resolve(dir, f) : file;
    if (!fs.existsSync(target)) {
      bad.push(`${name}: link ${href}`);
      continue;
    }
    if (anchor) {
      const hs = headingsOf(target);
      if (!hs || !hs.includes(anchor)) bad.push(`${name}: anchor ${href}`);
    }
  }
  return bad;
}

test("release: help wiki articles and links", () => {
  const docs = helpDocs();
  const need = ["index", "getting-started", "viewing", "annotating", "measuring", "adjustments-and-stains", "file-formats", "shortcuts", "troubleshooting"];
  eq(
    need.filter((n) => !docs.has(n)),
    [],
    `the help pages exist (${docs.size} articles)`,
  );
  const meta: string[] = [];
  for (const [id, d] of docs) {
    if (!d.meta.title) meta.push(`${id}: no title`);
    if (id !== "index" && !d.meta.blurb) meta.push(`${id}: no blurb`);
    if (d.meta.order === undefined || Number.isNaN(Number(d.meta.order))) meta.push(`${id}: no order`);
  }
  eq(meta, [], "every article has title, blurb and order front matter");
  const ids = [...docs.values()].map((d) => d.headings.map((h) => h.id));
  ok(
    ids.every((hs) => new Set(hs).size === hs.length),
    "no article has two headings with the same anchor",
  );
  const bad = fs
    .readdirSync(HELP)
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) => badLinks(path.join(HELP, f), docs));
  eq(bad, [], "every link, anchor and image in docs/help resolves");
});

test("release: README and other docs links resolve", () => {
  const docs = helpDocs();
  const files = [path.join(ROOT, "README.md")];
  for (const f of fs.readdirSync(path.join(ROOT, "docs"))) if (f.endsWith(".md")) files.push(path.join(ROOT, "docs", f));
  const bad = files.filter((f) => fs.existsSync(f)).flatMap((f) => badLinks(f, docs));
  ok(fs.existsSync(files[0]), "README.md exists");
  eq(bad, [], `README and docs/*.md links resolve (${files.length} files)`);
  const readme = read(files[0]);
  const linked = new Set([...readme.matchAll(/docs\/help\/([a-z0-9-]+)\.md/g)].map((m) => m[1]));
  eq(
    [...docs.keys()].filter((id) => !linked.has(id)),
    [],
    "the README links every help page",
  );
});

test("release: every in-app help reference resolves", () => {
  const docs = helpDocs();
  const heads = new Map([...docs].map(([id, d]) => [id, d.headings.map((h) => h.id)]));
  const srcDir = path.resolve("src");
  const refs = new Map<string, string>();
  for (const f of fs.readdirSync(srcDir, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f) || f.endsWith("helpRefs.ts")) continue;
    for (const r of findHelpRefs(read(path.join(srcDir, f)))) refs.set(r, f);
  }
  // placeholders in comments
  for (const r of ["article", "article/section", "topic", "topic/anchor"]) refs.delete(r);
  const bad = [...refs].filter(([r]) => !refResolves(r, heads)).map(([r, f]) => `${r} (${f})`);
  ok(refs.has("index") && refs.has("shortcuts"), `found the app's help references (${refs.size})`);
  eq(bad, [], "every data-help / help= / showHelp() reference names a real page and heading");

  // the matcher and resolver themselves
  eq(
    findHelpRefs(`<div data-help="viewing/rotate"/> showHelp("annotating/exam-answers"); <Modal help="measuring"/> x = { helpRef: "file-formats#slides" }; showHelp(hitRef(h))`),
    ["viewing/rotate", "annotating/exam-answers", "measuring", "file-formats#slides"],
    "findHelpRefs picks up every reference form",
  );
  eq(parseRef("annotating.md#exam-answers"), { id: "annotating", anchor: "exam-answers" }, "parseRef: Markdown link");
  eq(parseRef("viewing/rotate"), { id: "viewing", anchor: "rotate" }, "parseRef: topic/anchor");
  eq(parseRef(""), { id: "index", anchor: "" }, "parseRef: empty is the home page");
  ok(refResolves("annotating/exam-answers", heads) && !refResolves("annotating/nope", heads) && !refResolves("nope", heads), "refResolves");
  eq(slug("Where annotations are saved"), "where-annotations-are-saved", "GitHub-style heading ids");
});

test("release: names, versions and bundling agree", () => {
  const app = path.resolve(".");
  const pkg = JSON.parse(read(path.join(app, "package.json")));
  const conf = JSON.parse(read(path.join(app, "src-tauri/tauri.conf.json")));
  const cargo = read(path.join(app, "src-tauri/Cargo.toml"));
  const cargoVer = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  const versions: Record<string, string | undefined> = { "package.json": pkg.version, "tauri.conf.json": conf.version, "Cargo.toml": cargoVer };
  const lockPath = path.join(app, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(read(lockPath));
    versions["package-lock.json"] = lock.version;
    versions["package-lock.json packages['']"] = lock.packages?.[""]?.version;
  }
  const cargoLock = path.join(app, "src-tauri/Cargo.lock");
  if (fs.existsSync(cargoLock)) versions["Cargo.lock"] = /\[\[package\]\]\nname = "app"\nversion = "([^"]+)"/.exec(read(cargoLock))?.[1];
  ok(new Set(Object.values(versions)).size === 1, `the version files match: ${JSON.stringify(versions)}`);

  eq(conf.productName, "Slide Viewer", "productName");
  eq(conf.identifier, "edu.rice.slideviewer", "bundle identifier");
  const rel = read(path.join(ROOT, "tools/release.sh"));
  ok(/REPO=agadin\/slide-viewer\b/.test(rel), "release.sh publishes to agadin/slide-viewer");
  ok(rel.includes(".tauri/slide-viewer.key"), "release.sh signs with ~/.tauri/slide-viewer.key");
  ok(rel.includes(`NAME="${conf.productName}"`), "release.sh uses the productName for the .app and DMG");
  eq(
    conf.plugins?.updater?.endpoints,
    ["https://github.com/agadin/slide-viewer/releases/latest/download/latest.json"],
    "the updater reads latest.json from this repo's releases",
  );
  ok(read(path.join(app, "src/components/AboutPane.tsx")).includes('"https://github.com/agadin/slide-viewer"'), "About links this repo");

  // no leftovers from the sister app in what ships or builds it
  const shipped = [
    path.join(ROOT, "tools/release.sh"),
    ...fs.readdirSync(path.join(ROOT, ".github/workflows")).map((f) => path.join(ROOT, ".github/workflows", f)),
    ...fs.readdirSync(HELP).filter((f) => f.endsWith(".md")).map((f) => path.join(HELP, f)),
    path.join(app, "src/components/UpdateBanner.tsx"),
    path.join(app, "src/components/AboutPane.tsx"),
    path.join(app, "src/components/HelpPanel.tsx"),
    path.join(app, "src/lib/help.ts"),
  ];
  const left = shipped.filter((f) => /micro[- ]speed[- ]grader|msgrade/i.test(read(f))).map((f) => path.relative(ROOT, f));
  eq(left, [], "no Micro Speed Grader names left in release files and docs");

  // Windows bundles every DLL the fetch scripts leave in src-tauri/lib (OpenSlide, libCZI, …)
  const win = JSON.parse(read(path.join(app, "src-tauri/tauri.windows.conf.json")));
  eq(win.bundle?.resources?.["lib/*.dll"], "./", "Windows bundles lib/*.dll next to the exe");
  const build = read(path.join(ROOT, ".github/workflows/build.yml"));
  ok(build.includes("fetch-libczi.sh") && build.includes("fetch-openslide.sh"), "the Build workflow fetches OpenSlide and (when present) libCZI");
  ok(fs.existsSync(path.join(app, "src-tauri/examples/smoke.rs")), "the smoke example the Build workflow runs exists");
});

// Every npm package that ships in the app (not dev tools) is under a licence the project allows (SPEC:
// MIT / Apache and licences like them; fonts under the OFL). A new one fails here until it's checked
// and added. The Rust side is checked by cargo-deny (src-tauri/deny.toml).
test("release: licences of the npm packages that ship", () => {
  const allowed = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "OFL-1.1"]);
  const fits = (l: string) => l.split(/\s+OR\s+/).some((x) => allowed.has(x.replace(/[()]/g, "")));
  const lock = JSON.parse(read(path.resolve("package-lock.json")));
  const bad = Object.entries(lock.packages as Record<string, { dev?: boolean; license?: string }>)
    .filter(([k, v]) => k && !v.dev && !fits(v.license ?? ""))
    .map(([k, v]) => `${k.replace(/.*node_modules\//, "")}: ${v.license ?? "no licence"}`);
  eq(bad, [], "every shipped npm package has an allowed licence");
});
