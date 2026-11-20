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

## Version numbers and releases

The GitHub releases page (`agadin/slide-viewer`) is the record of versions. It must go up one step at a time with no gaps: 0.1.0 → 0.1.1 → 0.2.0. (Micro Speed Grader once jumped from 0.2.3 to 0.3.2 because versions were bumped in commits and never released. Don't repeat that here.)

**Rules**

- **Only change the version when releasing.** "Commit this" never means bump the version. When the user asks to "commit and bump the version", confirm they want a release, and release that same version straight away.
- **Before choosing a number, check what's actually released:** `gh release list --limit 5`. The next version follows the latest release, not whatever is in `package.json`. If nothing is released yet, the first release is the version already in the files (0.1.0).
- **Pick the step:** patch (0.1.3 → 0.1.4) for fixes and small additions; minor (0.1.x → 0.2.0) for a notable new feature, when the user asks. Never skip a number, and never reuse one. If a release fails part-way (e.g. Apple notarization), fix the problem and release the same number again; don't move on to the next one.
- **The version lives in five files, which must always match:** `app/package.json`, `app/package-lock.json` (top two entries), `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` and `app/src-tauri/Cargo.lock` (the `app` package; `cargo check` updates it). `npm run test:logic` fails when they don't match.

**One-time setup (the user does this, not Claude)**

- Updater key: `npx tauri signer generate -w ~/.tauri/slide-viewer.key`, then put the public key in `app/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (replacing the `TODO-…` placeholder) and commit it. `tools/release.sh` refuses to run while the placeholder is there. Never generate, move or overwrite this key: losing it breaks updates for every installed copy.
- Developer ID Application certificate in the keychain and an `xcrun notarytool` keychain profile named `notary` (the same as Micro Speed Grader's).

**Steps**

1. `gh release list --limit 5` and `git status`. Everything to ship must be committed and pushed to `main`.
2. Bump all five files to the new version, run `cd app/src-tauri && cargo check`, and commit as `v<version>` (e.g. `v0.1.1`). Push to `main`.
3. `tools/release.sh <version> "<notes for users>"`. It refuses to run unless HEAD is `origin/main` and the version files say `<version>`. It starts the Windows build on GitHub Actions (Build workflow, which also installs the result and opens a slide using only the installed DLLs), fetches OpenSlide (and libCZI, via `tools/fetch-libczi.sh`) and bundles every dylib in `app/src-tauri/frameworks/`, builds, signs and notarizes the universal macOS app and DMG, waits for the Windows installer and signs it for the updater locally (the updater key never goes to GitHub), writes `latest.json` (Apple silicon, Intel, Windows) and creates the GitHub release on that commit. It takes 10–15 minutes; run it in the background. If only the Windows build fails, fix it and rerun; `SKIP_WINDOWS=1` releases macOS only (say so in the notes).
4. Nothing to revert: the script doesn't rewrite version files. `git status` should be clean.
5. Check: `gh release view v<version>` lists `Slide-Viewer_<version>_macOS.dmg`, `Slide-Viewer.app.tar.gz` and its `.sig`, `Slide-Viewer_<version>_Windows-x64-setup.exe` and its `.sig`, and `latest.json`, and the release is marked Latest.

Notes:

- Release notes are read by students in the update message: describe what changed for them in plain words, not commit messages.
- If notarization fails with "A required agreement is missing or has expired", the user has to accept the agreement at developer.apple.com. Then rerun step 3 with the same version.
- Native libraries: OpenSlide comes from `tools/fetch-openslide.sh` and libCZI from `tools/fetch-libczi.sh` (both pinned and checksummed, `mac|windows`). On Windows every DLL in `app/src-tauri/lib/` is bundled next to the exe (`"lib/*.dll"` in `tauri.windows.conf.json`), so a library that needs extra DLLs only has to have its fetch script put them there. On macOS, `release.sh` passes every `frameworks/*.dylib` to the bundle.
- Never run a release, generate keys or push tags unless the user asked for that release.

## Help pages and links

- Help pages are `docs/help/*.md` with front matter `title`, `blurb`, `order`; they're shown in the app's Help window and on GitHub. When a feature changes, update its page.
- `npm run test:logic` (tests/release.test.ts) checks that every link, anchor and image in `docs/help` and `README.md` resolves, that the README links every help page, and that every in-app help reference (`data-help="page/anchor"`, `help="…"`, `showHelp("…")`, `helpRef: "…"`) names a real page and heading. Anchors are GitHub-style heading slugs (`## Exam answers` → `annotating/exam-answers`).
