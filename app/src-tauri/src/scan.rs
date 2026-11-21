//! Folder browser backend: recursive scan of a parent folder and slide thumbnails (disk-cached).
//! Owner: browser builder. The function signatures and the `ScanEntry`/`ScanResult`/`ScanProgress`
//! shapes are a CONTRACT (lib.rs wraps them as the `scan_folder` and `slide_thumbnail` commands;
//! the frontend mirrors them in app/src/lib/types.ts). Add fields, don't rename.
//!
//! Scan rules (docs/help/browser.md explains them to users):
//! - every extension `source::is_supported` accepts (the formats registry) is listed;
//! - hidden folders/files (".x", and Windows hidden/system), OS/system folders, app bundles and
//!   MIRAX `.mrxs` and Olympus `.vsi` (`_X_`) data folders are skipped; symlinked folders are followed once (loops are cut by
//!   remembering canonical paths);
//! - a DICOM WSI folder (many `.dcm` files) is listed once, and the JPEG tiles that sit next to a
//!   Hamamatsu `.vms`/`.vmu` are not listed as separate images;
//! - unreadable folders are reported in `errors`, never fatal; huge trees stop at `MAX_*`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use image::{imageops::FilterType, RgbImage};
use serde::Serialize;

use crate::files;
use crate::source::{self, SlideRegistry, SlideSource};

/// One slide file found under the scanned root.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    /// absolute path
    pub path: String,
    /// file name, e.g. "VMS104.ndpi"
    pub name: String,
    /// folder relative to the root, "/"-separated; "" for files directly in the root
    pub dir: String,
    /// lower-case extension with the dot, e.g. ".ndpi"
    pub ext: String,
    pub size: u64,
    /// modification time, ms since the Unix epoch (0 if unknown)
    pub modified_ms: u64,
    /// the annotation file found for it (next to the slide, or in the app-data fallback), if any
    pub annotation_path: Option<String>,
    /// number of annotations (`ndpviewstate` elements) in `annotation_path`; None when there is no file
    pub annotation_count: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    /// sorted by dir, then name (natural order)
    pub entries: Vec<ScanEntry>,
    /// unreadable folders etc. (shown quietly, never fatal)
    pub errors: Vec<String>,
}

/// Emitted as the "scan-progress" event while scanning.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub root: String,
    pub folders: u32,
    pub found: u32,
}

/// Stop descending after this many folders / slides / levels (someone picked their whole disk).
pub const MAX_FOLDERS: u32 = 50_000;
pub const MAX_SLIDES: usize = 20_000;
pub const MAX_DEPTH: usize = 32;
/// Annotation files larger than this aren't opened just to count them.
const MAX_NDPA_BYTES: u64 = 32 * 1024 * 1024;
/// Progress events at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(120);

/// Folder names never worth scanning (OS, recycle bins, tool caches).
const SKIP_DIRS: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    "__macosx",
    "node_modules",
    "@eadir",
    "lost+found",
    "$windows.~bt",
    "$windows.~ws",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
];
/// macOS bundles and packages look like folders but are single documents/apps.
const PACKAGE_EXTS: &[&str] = &[
    "app", "bundle", "framework", "photoslibrary", "musiclibrary", "tvlibrary", "plugin", "kext", "xcodeproj", "xcworkspace", "pkg", "lproj",
    "imovielibrary", "fcpbundle", "logicx", "nib", "xcassets",
];

/// Natural, case-insensitive order: "Slide 2" < "slide 10" (ties broken by the raw string).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < ab.len() && j < bb.len() {
        let (ca, cb) = (ab[i], bb[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let si = i;
            while i < ab.len() && ab[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < bb.len() && bb[j].is_ascii_digit() {
                j += 1;
            }
            let na = trim_zeros(&ab[si..i]);
            let nb = trim_zeros(&bb[sj..j]);
            let o = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if o != Ordering::Equal {
                return o;
            }
        } else {
            // compare by char so multi-byte names stay together; ASCII folded to lower case
            let ca_ch = a[i..].chars().next().unwrap();
            let cb_ch = b[j..].chars().next().unwrap();
            let o = fold(ca_ch).cmp(&fold(cb_ch));
            if o != Ordering::Equal {
                return o;
            }
            i += ca_ch.len_utf8();
            j += cb_ch.len_utf8();
        }
    }
    (ab.len() - i).cmp(&(bb.len() - j)).then_with(|| a.cmp(b))
}

fn trim_zeros(d: &[u8]) -> &[u8] {
    let k = d.iter().position(|&c| c != b'0').unwrap_or(d.len());
    &d[k..]
}

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Order of the scan result: folder by folder (component-wise, so a folder's own slides come
/// before its subfolders), then by name.
pub fn entry_cmp(a: &ScanEntry, b: &ScanEntry) -> Ordering {
    dir_cmp(&a.dir, &b.dir).then_with(|| natural_cmp(&a.name, &b.name))
}

pub fn dir_cmp(a: &str, b: &str) -> Ordering {
    let pa = a.split('/').filter(|s| !s.is_empty());
    let pb = b.split('/').filter(|s| !s.is_empty());
    let (va, vb): (Vec<&str>, Vec<&str>) = (pa.collect(), pb.collect());
    for (x, y) in va.iter().zip(vb.iter()) {
        let o = natural_cmp(x, y);
        if o != Ordering::Equal {
            return o;
        }
    }
    va.len().cmp(&vb.len())
}

fn lower_ext(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i..].to_lowercase(),
        _ => String::new(),
    }
}

fn mtime_ms(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(windows)]
fn os_hidden(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    m.file_attributes() & (0x2 | 0x4) != 0 // HIDDEN | SYSTEM
}
#[cfg(not(windows))]
fn os_hidden(_m: &fs::Metadata) -> bool {
    false
}

/// A folder we never descend into (by name or shape).
fn skip_dir(name: &str, path: &Path) -> bool {
    if name.starts_with('.') || name.starts_with('~') {
        return true;
    }
    let l = name.to_lowercase();
    if SKIP_DIRS.contains(&l.as_str()) {
        return true;
    }
    if let Some(i) = l.rfind('.') {
        if PACKAGE_EXTS.contains(&&l[i + 1..]) {
            return true;
        }
    }
    // the macOS user Library (someone picked their home folder)
    l == "library" && path.join("Preferences").is_dir() && path.join("Caches").is_dir()
}

/// Count `<ndpviewstate` elements without parsing (NDP.view writes exactly one per annotation).
pub fn count_ndpa_annotations(path: &Path) -> Option<u32> {
    let m = fs::metadata(path).ok()?;
    if !m.is_file() {
        return None;
    }
    if m.len() > MAX_NDPA_BYTES {
        return Some(0);
    }
    let bytes = fs::read(path).ok()?;
    let needle = b"<ndpviewstate";
    Some(bytes.windows(needle.len()).filter(|w| w.eq_ignore_ascii_case(needle)).count() as u32)
}

struct Walker<'a> {
    root: String,
    fallback_dir: &'a Path,
    progress: &'a dyn Fn(ScanProgress),
    visited: HashSet<PathBuf>,
    entries: Vec<ScanEntry>,
    errors: Vec<String>,
    folders: u32,
    last_progress: Instant,
    writable: HashMap<PathBuf, bool>,
    truncated: bool,
}

impl Walker<'_> {
    fn tick(&mut self, force: bool) {
        if force || self.last_progress.elapsed() >= PROGRESS_EVERY {
            self.last_progress = Instant::now();
            (self.progress)(ScanProgress { root: self.root.clone(), folders: self.folders, found: self.entries.len() as u32 });
        }
    }

    fn walk(&mut self, dir: &Path, rel: &str, depth: usize) {
        if self.truncated {
            return;
        }
        if depth > MAX_DEPTH {
            self.errors.push(format!("{}: nested too deeply, not scanned", dir.display()));
            return;
        }
        if self.folders >= MAX_FOLDERS || self.entries.len() >= MAX_SLIDES {
            self.truncated = true;
            self.errors.push(format!(
                "Stopped after {} folders and {} slides; choose a smaller folder to see everything",
                self.folders,
                self.entries.len()
            ));
            return;
        }
        // symlink loops (and the same folder reached twice) are cut here
        let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        if !self.visited.insert(canon) {
            return;
        }
        self.folders += 1;
        self.tick(false);

        let rd = match fs::read_dir(dir) {
            Ok(r) => r,
            Err(e) => {
                self.errors.push(format!("{}: {e}", dir.display()));
                return;
            }
        };
        let mut files: Vec<(String, PathBuf, fs::Metadata)> = Vec::new();
        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        for item in rd {
            let Ok(item) = item else { continue };
            let name = item.file_name().to_string_lossy().to_string();
            let path = item.path();
            // follows symlinks; broken links are skipped silently
            let Ok(meta) = fs::metadata(&path) else { continue };
            if os_hidden(&meta) {
                continue;
            }
            if meta.is_dir() {
                if !skip_dir(&name, &path) {
                    dirs.push((name, path));
                }
            } else if meta.is_file() && !name.starts_with('.') && !name.starts_with("~$") && meta.len() > 0 {
                files.push((name, path, meta));
            }
        }
        files.sort_by(|a, b| natural_cmp(&a.0, &b.0));
        dirs.sort_by(|a, b| natural_cmp(&a.0, &b.0));

        let exts: Vec<String> = files.iter().map(|f| lower_ext(&f.0)).collect();
        // MIRAX: "X.mrxs" keeps its tiles in the folder "X"
        let mrxs_dirs: HashSet<String> = files
            .iter()
            .zip(&exts)
            .filter(|(_, e)| *e == ".mrxs")
            .map(|(f, _)| f.0[..f.0.len() - 5].to_lowercase())
            .collect();
        // Olympus: "X.vsi" keeps its pixels in the folder "_X_"
        let vsi_dirs: HashSet<String> = files
            .iter()
            .zip(&exts)
            .filter(|(_, e)| *e == ".vsi")
            .map(|(f, _)| format!("_{}_", &f.0[..f.0.len() - 4]).to_lowercase())
            .collect();
        let has_vms = exts.iter().any(|e| e == ".vms" || e == ".vmu");
        let mut dicom_listed = false;

        for ((name, path, meta), ext) in files.into_iter().zip(exts) {
            let ps = path.to_string_lossy().to_string();
            if !source::is_supported(&ps) {
                continue;
            }
            if has_vms && matches!(ext.as_str(), ".jpg" | ".jpeg") {
                continue; // the VMS tiles / map image
            }
            if ext == ".dcm" {
                if dicom_listed {
                    continue; // one DICOM WSI per folder: OpenSlide opens the series from any file
                }
                dicom_listed = true;
            }
            let (annotation_path, annotation_count) = self.annotation_for(&ps, dir);
            self.entries.push(ScanEntry {
                path: ps,
                name,
                dir: rel.to_string(),
                ext,
                size: meta.len(),
                modified_ms: mtime_ms(&meta),
                annotation_path,
                annotation_count,
            });
            if self.entries.len() >= MAX_SLIDES {
                break;
            }
        }
        self.tick(false);

        for (name, path) in dirs {
            if mrxs_dirs.contains(&name.to_lowercase()) || vsi_dirs.contains(&name.to_lowercase()) {
                continue;
            }
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            self.walk(&path, &r, depth + 1);
        }
    }

    /// The annotation file the app would load for this slide: next to it, or the app-data copy
    /// (used when the slide's folder is read-only).
    fn annotation_for(&mut self, slide: &str, dir: &Path) -> (Option<String>, Option<u32>) {
        let primary = files::primary_annotation_path(slide);
        let fallback = files::fallback_annotation_path(self.fallback_dir, slide);
        let (pe, fe) = (Path::new(&primary).is_file(), Path::new(&fallback).is_file());
        let pick = match (pe, fe) {
            (false, false) => return (None, None),
            (true, false) => primary,
            (false, true) => fallback,
            (true, true) => {
                // both exist: the copy in app data is the student's own when the folder is read-only
                let w = *self.writable.entry(dir.to_path_buf()).or_insert_with(|| files::dir_writable(dir));
                if w { primary } else { fallback }
            }
        };
        let n = count_ndpa_annotations(Path::new(&pick));
        (Some(pick), n)
    }
}

/// Recursively list the supported slides under `dir` (see `source::is_supported`).
/// `ndpa_fallback_dir` is where annotations go when a slide's folder is read-only
/// (see `files::fallback_annotation_path`). `progress` may be called as often as convenient.
pub fn scan_folder(dir: &str, ndpa_fallback_dir: &Path, progress: &dyn Fn(ScanProgress)) -> Result<ScanResult, String> {
    let root = Path::new(dir);
    let meta = fs::metadata(root).map_err(|e| format!("{dir}: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{dir}: not a folder"));
    }
    let mut w = Walker {
        root: dir.to_string(),
        fallback_dir: ndpa_fallback_dir,
        progress,
        visited: HashSet::new(),
        entries: Vec::new(),
        errors: Vec::new(),
        folders: 0,
        last_progress: Instant::now() - PROGRESS_EVERY,
        writable: HashMap::new(),
        truncated: false,
    };
    w.walk(root, "", 0);
    w.tick(true);
    let mut entries = w.entries;
    entries.sort_by(entry_cmp);
    Ok(ScanResult { root: dir.to_string(), entries, errors: w.errors })
}

// ---------------------------------------------------------------- thumbnails

/// Cache key: path + size + mtime + requested size, so a replaced file gets a new thumbnail.
pub fn thumb_cache_key(path: &str, size: u64, modified_ms: u64, max_px: u32) -> String {
    format!("{:016x}", files::stable_hash(&format!("v1|{path}|{size}|{modified_ms}|{max_px}")))
}

/// Pick the thumbnail image: the associated "thumbnail" when there is one, else the whole slide
/// (`overview`, which reads the lowest pyramid level), else the "macro" photo of the glass.
pub fn render_thumbnail(src: &dyn SlideSource, max_px: u32) -> Result<RgbImage, String> {
    let info = src.info();
    let has = |n: &str| info.associated.iter().any(|a| a == n);
    if has("thumbnail") {
        if let Ok(img) = src.associated("thumbnail") {
            return Ok(fit_image(img, max_px));
        }
    }
    match src.overview(max_px, 0) {
        Ok(img) => Ok(img),
        Err(e) => {
            if has("macro") {
                if let Ok(img) = src.associated("macro") {
                    return Ok(fit_image(img, max_px));
                }
            }
            Err(e)
        }
    }
}

fn fit_image(img: RgbImage, max_px: u32) -> RgbImage {
    let (w, h) = source::fit(img.width() as i64, img.height() as i64, max_px);
    if (w, h) == (img.width(), img.height()) {
        img
    } else {
        image::imageops::resize(&img, w, h, FilterType::Triangle)
    }
}

/// Keep the thumbnail cache bounded (oldest files go first).
const MAX_CACHE_FILES: usize = 4000;

fn prune_cache(cache_dir: &Path) {
    let Ok(rd) = fs::read_dir(cache_dir) else { return };
    let mut v: Vec<(u64, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".jpg"))
        .map(|e| (e.metadata().map(|m| mtime_ms(&m)).unwrap_or(0), e.path()))
        .collect();
    if v.len() <= MAX_CACHE_FILES {
        return;
    }
    v.sort();
    let extra = v.len() - MAX_CACHE_FILES * 3 / 4;
    for (_, p) in v.into_iter().take(extra) {
        let _ = fs::remove_file(p);
    }
}

/// A JPEG thumbnail of the slide at `path`, at most `max_px` on its long side. Prefer the
/// associated "thumbnail"/"macro" image, else the source's `overview`. Cache under `cache_dir`
/// keyed by path + size + mtime. `reg` is only used to reuse an already-open slide.
pub fn thumbnail(reg: &SlideRegistry, path: &str, max_px: u32, cache_dir: &Path) -> Result<Vec<u8>, String> {
    // The registry has no public lookup by path, and opening through it would register (and leak)
    // a slide; a short-lived source of our own is cheap, so `reg` is unused for now.
    let _ = reg;
    let meta = fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path}: not a file"));
    }
    if !source::is_supported(path) {
        return Err(format!("{path}: not a supported image format"));
    }
    let key = thumb_cache_key(path, meta.len(), mtime_ms(&meta), max_px);
    let file = cache_dir.join(format!("{key}.jpg"));
    if let Ok(b) = fs::read(&file) {
        if b.starts_with(&[0xFF, 0xD8]) {
            return Ok(b);
        }
    }
    let src = source::open_source(path)?;
    let img = render_thumbnail(&*src, max_px)?;
    drop(src);
    let jpg = source::encode_jpeg(&img, 82)?;
    // best effort: a cache that can't be written just means we render again next time
    if fs::create_dir_all(cache_dir).is_ok() {
        let tmp = cache_dir.join(format!("{key}.{}.tmp", std::process::id()));
        if fs::write(&tmp, &jpg).is_ok() && fs::rename(&tmp, &file).is_err() {
            let _ = fs::remove_file(&tmp);
        }
        if key.ends_with('0') {
            prune_cache(cache_dir); // about one write in 16
        }
    }
    Ok(jpg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::SourceInfo;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sv-scan-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path, body: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn natural_order() {
        assert_eq!(natural_cmp("Slide 2", "slide 10"), Ordering::Less);
        assert_eq!(natural_cmp("VMS104", "VMS0105"), Ordering::Less);
        assert_eq!(natural_cmp("a", "A"), Ordering::Greater); // tie broken by raw bytes, stable
        assert_eq!(natural_cmp("abc", "abcd"), Ordering::Less);
        assert_eq!(natural_cmp("é1", "é2"), Ordering::Less);
        let mut v = vec!["x10", "x9", "X1", "x01b"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["X1", "x01b", "x9", "x10"]);
        assert_eq!(dir_cmp("", "a"), Ordering::Less);
        assert_eq!(dir_cmp("a", "a/b"), Ordering::Less);
        assert_eq!(dir_cmp("a/b", "a b"), Ordering::Less, "component-wise: a's subfolders before 'a b'");
        assert_eq!(dir_cmp("Week 2", "Week 10"), Ordering::Less);
    }

    #[test]
    fn scans_a_tree() {
        let root = tmpdir("tree");
        let fb = tmpdir("tree-fallback");
        touch(&root.join("VMS104.ndpi"), b"x");
        touch(
            &root.join("VMS104.ndpi.ndpa"),
            b"<annotations><ndpviewstate id=\"1\"/><ndpviewstate id=\"2\"></ndpviewstate></annotations>",
        );
        touch(&root.join("notes.txt"), b"x");
        touch(&root.join("empty.svs"), b"");
        touch(&root.join("Week 10/b.svs"), b"x");
        touch(&root.join("Week 2/a.TIF"), b"x");
        touch(&root.join("Week 2/sub/c.png"), b"x");
        touch(&root.join(".hidden/h.ndpi"), b"x");
        touch(&root.join("__MACOSX/m.ndpi"), b"x");
        touch(&root.join("Viewer.app/Contents/x.png"), b"x");
        // MIRAX: the data folder is skipped, the .mrxs listed
        touch(&root.join("mirax/S1.mrxs"), b"x");
        touch(&root.join("mirax/S1/Data0000.dat"), b"x");
        touch(&root.join("mirax/S1/Slidedat.ini"), b"x");
        touch(&root.join("mirax/S1/preview.jpg"), b"x");
        // Olympus VSI: the _X_ data folder (with its .ets stacks) is skipped, the .vsi listed
        touch(&root.join("olympus/OS-2.vsi"), b"x");
        touch(&root.join("olympus/_OS-2_/stack1/frame_t.ets"), b"x");
        touch(&root.join("olympus/_OS-2_/stack10001/frame_t.ets"), b"x");
        // DICOM series: one entry
        touch(&root.join("dicom/1.dcm"), b"x");
        touch(&root.join("dicom/2.dcm"), b"x");
        // VMS: tiles next to it are not listed
        touch(&root.join("vms/s.vms"), b"x");
        touch(&root.join("vms/s.jpg"), b"x");
        touch(&root.join("vms/s_map.jpg"), b"x");
        // annotation only in the fallback dir
        let fallback = files::fallback_annotation_path(&fb, &root.join("Week 10/b.svs").to_string_lossy());
        touch(Path::new(&fallback), b"<annotations><ndpviewstate id=\"1\"/></annotations>");
        #[cfg(unix)]
        {
            // a symlink loop must not hang or duplicate
            std::os::unix::fs::symlink(&root, root.join("Week 2/loop")).unwrap();
        }

        let seen = std::cell::Cell::new(0u32);
        let r = scan_folder(&root.to_string_lossy(), &fb, &|p| {
            seen.set(seen.get() + 1);
            assert!(p.found <= 20);
        })
        .unwrap();
        let names: Vec<String> = r.entries.iter().map(|e| format!("{}|{}", e.dir, e.name)).collect();
        assert_eq!(
            names,
            vec!["|VMS104.ndpi", "dicom|1.dcm", "mirax|S1.mrxs", "olympus|OS-2.vsi", "vms|s.vms", "Week 2|a.TIF", "Week 2/sub|c.png", "Week 10|b.svs"],
        );
        assert!(seen.get() >= 1, "progress was reported");
        let v = &r.entries[0];
        assert_eq!(v.ext, ".ndpi");
        assert_eq!(v.size, 1);
        assert!(v.modified_ms > 0);
        assert_eq!(v.annotation_count, Some(2));
        assert!(v.annotation_path.as_deref().unwrap().ends_with("VMS104.ndpi.ndpa"));
        assert_eq!(r.entries[5].ext, ".tif");
        assert_eq!(r.entries[5].annotation_path, None);
        assert_eq!(r.entries[7].annotation_path.as_deref(), Some(fallback.as_str()));
        assert_eq!(r.entries[7].annotation_count, Some(1));
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(scan_folder(&root.join("VMS104.ndpi").to_string_lossy(), &fb, &|_| {}).is_err());
        assert!(scan_folder("/nonexistent/sv", &fb, &|_| {}).is_err());
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&fb);
    }

    /// a synthetic source with optional associated images
    struct Fake(SourceInfo, bool);
    impl SlideSource for Fake {
        fn info(&self) -> &SourceInfo {
            &self.0
        }
        fn tile(&self, level: u32, x: u32, y: u32, _z: u32) -> Result<RgbImage, String> {
            if self.1 {
                return Err("broken tiles".into());
            }
            let (_, _, _, _, tw, th) = source::dz_tile_rect(self.0.width, self.0.height, level, x, y)?;
            Ok(RgbImage::from_pixel(tw, th, image::Rgb([10, 20, 30])))
        }
        fn associated(&self, name: &str) -> Result<RgbImage, String> {
            let c = if name == "thumbnail" { 1 } else { 2 };
            Ok(RgbImage::from_pixel(1000, 500, image::Rgb([c, c, c])))
        }
    }

    #[test]
    fn thumbnail_choice() {
        let mut info = SourceInfo::basic("fake", 4000, 2000);
        let t = render_thumbnail(&Fake(info.clone(), false), 256).unwrap();
        assert_eq!((t.width(), t.height()), (256, 128));
        assert_eq!(t.get_pixel(5, 5).0, [10, 20, 30], "no associated images: the overview");
        info.associated = vec!["macro".into(), "thumbnail".into()];
        let t = render_thumbnail(&Fake(info.clone(), false), 256).unwrap();
        assert_eq!((t.width(), t.height(), t.get_pixel(0, 0).0[0]), (256, 128, 1), "the thumbnail image wins");
        info.associated = vec!["macro".into()];
        let t = render_thumbnail(&Fake(info.clone(), true), 256).unwrap();
        assert_eq!(t.get_pixel(0, 0).0[0], 2, "macro when the pyramid can't be read");
        info.associated = vec![];
        assert!(render_thumbnail(&Fake(info, true), 256).is_err());
    }

    #[test]
    fn thumbnail_cache_key() {
        let a = thumb_cache_key("/a/x.ndpi", 10, 5, 256);
        assert_eq!(a, thumb_cache_key("/a/x.ndpi", 10, 5, 256));
        assert_ne!(a, thumb_cache_key("/a/x.ndpi", 11, 5, 256));
        assert_ne!(a, thumb_cache_key("/a/x.ndpi", 10, 6, 256));
        assert_ne!(a, thumb_cache_key("/a/x.ndpi", 10, 5, 128));
        assert_ne!(a, thumb_cache_key("/b/x.ndpi", 10, 5, 256));
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn thumbnail_errors() {
        let reg = SlideRegistry::default();
        let d = tmpdir("thumb-err");
        assert!(thumbnail(&reg, "/nonexistent/x.ndpi", 256, &d).is_err());
        touch(&d.join("a.txt"), b"x");
        assert!(thumbnail(&reg, &d.join("a.txt").to_string_lossy(), 256, &d).unwrap_err().contains("not a supported"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn counts_ndpa() {
        let d = tmpdir("count");
        let p = d.join("a.ndpa");
        touch(&p, b"<annotations>\n\t<ndpviewstate id=\"1\">\n\t</ndpviewstate>\n\t<NDPVIEWSTATE id=\"2\"/></annotations>");
        assert_eq!(count_ndpa_annotations(&p), Some(2));
        assert_eq!(count_ndpa_annotations(&d.join("none.ndpa")), None);
        let _ = fs::remove_dir_all(&d);
    }

    /// Real slides (read-only): `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn real_folder_and_thumbnail() {
        let dir = "/Users/alexandergadin/vscode/micro-speed-grader/images";
        if !Path::new(dir).is_dir() {
            return;
        }
        let fb = tmpdir("real-fb");
        let r = scan_folder(dir, &fb, &|_| {}).unwrap();
        assert!(r.entries.iter().any(|e| e.name == "VMS104.ndpi"));
        let annotated = r.entries.iter().find(|e| e.name == "VMS109.ndpi").unwrap();
        assert!(annotated.annotation_count.unwrap_or(0) > 0, "{annotated:?}");
        let cache = tmpdir("real-cache");
        let reg = SlideRegistry::default();
        let p = format!("{dir}/VMS104.ndpi");
        let t0 = Instant::now();
        let a = thumbnail(&reg, &p, 256, &cache).unwrap();
        let cold = t0.elapsed();
        let t1 = Instant::now();
        let b = thumbnail(&reg, &p, 256, &cache).unwrap();
        let warm = t1.elapsed();
        assert!(a.starts_with(&[0xFF, 0xD8]) && a == b);
        eprintln!("thumbnail: cold {cold:?}, cached {warm:?}, {} bytes", a.len());
        let _ = fs::remove_dir_all(&cache);
        let _ = fs::remove_dir_all(&fb);
    }

    /// Leica `.scn` and iScan `.bif` samples from `tools/fetch-format-samples.py`
    /// (`cargo test -- --ignored`; `SV_FORMAT_SAMPLES=<dir>` when they're elsewhere, e.g. in the
    /// main checkout when testing a worktree): each is listed once and its thumbnail shows tissue,
    /// not the blank glass around a small scanned region.
    #[test]
    #[ignore]
    fn real_scn_and_bif_samples() {
        let data = std::env::var_os("SV_FORMAT_SAMPLES")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats"));
        let names = ["Leica__Leica-1.scn", "Leica__Leica-2.scn", "Ventana__OS-2.bif"];
        let present: Vec<&str> = names.iter().copied().filter(|n| data.join(n).is_file()).collect();
        if present.is_empty() {
            eprintln!("skipping: no samples in {}", data.display());
            return;
        }
        // a folder of links, so the scan sees only these files
        let d = tmpdir("scn-bif");
        for n in &present {
            #[cfg(unix)]
            std::os::unix::fs::symlink(data.join(n), d.join(n)).unwrap();
            #[cfg(not(unix))]
            return;
        }
        let fb = tmpdir("scn-bif-fb");
        let r = scan_folder(&d.to_string_lossy(), &fb, &|_| {}).unwrap();
        let listed: Vec<&str> = r.entries.iter().map(|e| e.name.as_str()).collect();
        let mut want = present.clone();
        want.sort();
        assert_eq!(listed, want, "{:?}", r.errors);
        let cache = tmpdir("scn-bif-cache");
        let reg = SlideRegistry::default();
        for e in &r.entries {
            if e.name == "Leica__Leica-1.scn" {
                // the scanned region (openslide.bounds-*), not the whole 53130 × 153470 glass
                let i = source::open_source(&e.path).unwrap().info().clone();
                assert_eq!((i.width, i.height, i.mpp_x), (36832, 38432, 0.5));
            }
            let jpg = thumbnail(&reg, &e.path, 256, &cache).unwrap_or_else(|err| panic!("{}: {err}", e.name));
            let img = image::load_from_memory(&jpg).unwrap().to_rgb8();
            // tissue (stained, so coloured or dark) vs white/grey background
            let n = img
                .pixels()
                .filter(|p| {
                    let (lo, hi) = (p.0.iter().min().copied().unwrap() as u32, p.0.iter().max().copied().unwrap() as u32);
                    hi - lo > 20 || (p[0] as u32 + p[1] as u32 + p[2] as u32) < 3 * 200
                })
                .count();
            let frac = n as f64 / (img.width() * img.height()) as f64;
            // and some picture at all: the spread of brightness
            let lum: Vec<f64> = img.pixels().map(|p| (p[0] as f64 + p[1] as f64 + p[2] as f64) / 3.0).collect();
            let mean = lum.iter().sum::<f64>() / lum.len() as f64;
            let sd = (lum.iter().map(|l| (l - mean).powi(2)).sum::<f64>() / lum.len() as f64).sqrt();
            eprintln!("{}: thumbnail {}x{}, {:.0}% tissue, brightness sd {sd:.1}", e.name, img.width(), img.height(), frac * 100.0);
            assert!(sd > 5.0, "{}: thumbnail is flat (sd {sd:.1})", e.name);
            if e.ext == ".scn" {
                // H&E: most of the scanned region is tissue (the whole glass would be < 10%).
                // (OS-2.bif is a very pale Ki67 stain, so this isn't asked of it.)
                assert!(frac > 0.25, "{}: thumbnail is mostly blank ({:.1}% tissue)", e.name, frac * 100.0);
            }
        }
        for p in [d, fb, cache] {
            let _ = fs::remove_dir_all(p);
        }
    }
}
