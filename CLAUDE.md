# Slide Viewer: notes for Claude

Read `SPEC.md` first. It holds the agreed product decisions and the NDPA format.

- Sister app: `/Users/alexandergadin/vscode/micro-speed-grader` (MSG). It is read-only reference. Never modify it.
  It has its own CLAUDE.md with release rules; the same release discipline applies here
  (versions in package.json, package-lock.json, tauri.conf.json, Cargo.toml, Cargo.lock must match; no version gaps).
- NDPA compatibility with NDP.view2 and with MSG's `parseNdpa` is the top correctness requirement. Never drop
  unknown XML when writing annotations back.
- Run `tools/fetch-openslide.sh mac` once on a new machine before `cargo check` / `tauri dev`.
- Before committing: `cd app && npx tsc --noEmit && npm run test:logic`, and `cd app/src-tauri && cargo check && cargo test`.
- `test-data/` and the real slides in MSG's `images/` are course material: never commit them.
- Help pages live in `docs/help/*.md`; update the page when a feature changes.
