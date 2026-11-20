/**
 * Help references, without the bundled articles (so tests can use it under node).
 * A reference is "topic", "topic/anchor", "topic#anchor" or a Markdown link "topic.md#anchor".
 * Owner: release.
 */

export function parseRef(ref: string): { id: string; anchor: string } {
  const [file, hash = ""] = ref.split("#");
  const [id, anchor = hash] = file.replace(/\.md$/, "").replace(/^\.\//, "").split("/");
  return { id: id || "index", anchor };
}

/**
 * Everything in the app source that names a help page: data-help="…", showHelp("…"), and help="page/anchor" or
 * helpRef: "page/anchor" (those two only when the value looks like a reference, since `help` is also tooltip text).
 */
export function findHelpRefs(src: string): string[] {
  const out: string[] = [];
  const REF = String.raw`[a-z0-9-]+(?:[/#][a-z0-9-]+)?`;
  const re = new RegExp(
    String.raw`data-help="([^"{}]+)"|\bhelp="(${REF})"|showHelp\(\s*["'\x60]([^"'\x60$]+)["'\x60]\s*\)|\bhelp(?:Ref|Topic)?:\s*["'](${REF})["']`,
    "g",
  );
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

/** Does `ref` point at an article (and, if it has one, a heading) in `docs` (id → heading ids)? */
export function refResolves(ref: string, docs: Map<string, string[]>): boolean {
  const { id, anchor } = parseRef(ref);
  const headings = docs.get(id);
  return !!headings && (!anchor || headings.includes(anchor));
}
