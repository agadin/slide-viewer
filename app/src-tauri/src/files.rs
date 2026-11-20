//! Generic file helpers behind the file commands in lib.rs. Shared (foundation); builders call
//! these but should not need to change them.

use std::path::{Path, PathBuf};

/// Crash-safe write: write to a temp file next to the target, then rename over it.
/// With `keep_backup`, the previous version is kept as `<file>.bak`.
pub fn write_atomic(path: &str, contents: &[u8], keep_backup: bool) -> Result<(), String> {
    let target = PathBuf::from(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
    }
    let mut tmp = target.clone().into_os_string();
    tmp.push(".tmp-write");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, contents).map_err(|e| format!("{path}: {e}"))?;
    if keep_backup && target.exists() {
        let mut bak = target.clone().into_os_string();
        bak.push(".bak");
        let _ = std::fs::copy(&target, PathBuf::from(bak));
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{path}: {e}")
    })
}

/// Can we create files in `dir`? (Tries a real temp file: permission bits lie on network shares.)
pub fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".slide-viewer-probe-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// FNV-1a 64: a stable hash (std's hasher isn't guaranteed stable across Rust versions).
pub fn stable_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// `<slide>.ndpa` next to the slide, e.g. VMS104.ndpi → VMS104.ndpi.ndpa
pub fn primary_annotation_path(slide_path: &str) -> String {
    format!("{slide_path}.ndpa")
}

/// Where a slide's annotations go when its folder is read-only:
/// `<fallback_dir>/<hash of the slide's folder>/<slide file name>.ndpa`.
pub fn fallback_annotation_path(fallback_dir: &Path, slide_path: &str) -> String {
    let p = Path::new(slide_path);
    let folder = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "slide".into());
    fallback_dir
        .join(format!("{:016x}", stable_hash(&folder)))
        .join(format!("{name}.ndpa"))
        .to_string_lossy()
        .to_string()
}

/// Decode a percent-encoded header value (the frontend sends paths with encodeURIComponent).
pub fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or("bad percent-encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad percent-encoding")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "path is not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_paths() {
        assert_eq!(percent_decode("%2FUsers%2Fa%20b%2F%C3%A9.png").unwrap(), "/Users/a b/é.png");
        assert!(percent_decode("%2").is_err());
    }

    #[test]
    fn annotation_paths() {
        assert_eq!(primary_annotation_path("/a/VMS104.ndpi"), "/a/VMS104.ndpi.ndpa");
        let f = fallback_annotation_path(Path::new("/data/annotations"), "/ro/VMS104.ndpi");
        assert!(f.starts_with("/data/annotations/") && f.ends_with("/VMS104.ndpi.ndpa"), "{f}");
        assert_eq!(f, fallback_annotation_path(Path::new("/data/annotations"), "/ro/VMS104.ndpi"));
        assert_ne!(f, fallback_annotation_path(Path::new("/data/annotations"), "/other/VMS104.ndpi"));
    }

    #[test]
    fn atomic_write_keeps_backup() {
        let dir = std::env::temp_dir().join(format!("sv-files-{}", std::process::id()));
        let p = dir.join("a.ndpa");
        let ps = p.to_string_lossy().to_string();
        write_atomic(&ps, b"one", true).unwrap();
        write_atomic(&ps, b"two", true).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        assert_eq!(std::fs::read(dir.join("a.ndpa.bak")).unwrap(), b"one");
        assert!(dir_writable(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
