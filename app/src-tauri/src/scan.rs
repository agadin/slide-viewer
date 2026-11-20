//! Folder browser backend: recursive scan of a parent folder and slide thumbnails (disk-cached).
//! Owner: browser builder. The function signatures and the `ScanEntry`/`ScanResult`/`ScanProgress`
//! shapes are a CONTRACT (lib.rs wraps them as the `scan_folder` and `slide_thumbnail` commands;
//! the frontend mirrors them in app/src/lib/types.ts). Add fields, don't rename.
//! TODO(browser): implement. Until then both return "unsupported" errors.

use std::path::Path;

use serde::Serialize;

use crate::source::{unsupported, SlideRegistry};

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

/// Recursively list the supported slides under `dir` (see `source::is_supported`).
/// `ndpa_fallback_dir` is where annotations go when a slide's folder is read-only
/// (see `files::fallback_annotation_path`). `progress` may be called as often as convenient.
pub fn scan_folder(dir: &str, ndpa_fallback_dir: &Path, progress: &dyn Fn(ScanProgress)) -> Result<ScanResult, String> {
    let _ = (ndpa_fallback_dir, progress);
    Err(format!("{dir}: {}", unsupported("folder scan")))
}

/// A JPEG thumbnail of the slide at `path`, at most `max_px` on its long side. Prefer the
/// associated "thumbnail"/"macro" image, else the source's `overview`. Cache under `cache_dir`
/// keyed by path + size + mtime. `reg` is only used to reuse an already-open slide.
pub fn thumbnail(reg: &SlideRegistry, path: &str, max_px: u32, cache_dir: &Path) -> Result<Vec<u8>, String> {
    let _ = (reg, max_px, cache_dir);
    Err(format!("{path}: {}", unsupported("thumbnails")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn stubs_report_unsupported() {
        let e = super::scan_folder("/nonexistent", std::path::Path::new("/tmp"), &|_| {}).err().unwrap();
        assert!(e.contains("unsupported"));
    }
}
