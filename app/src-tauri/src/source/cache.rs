//! Small shared helpers for the backends: a byte-budgeted LRU, the tile-caching wrapper every
//! opened source goes through, and the app cache directory (for plain-image disk pyramids and
//! extracted CZI attachments).
//! Owner: formats builder.

use std::collections::HashMap;
use std::hash::Hash;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use image::RgbImage;

use super::{SlideSource, SourceInfo};

// ---------------------------------------------------------------- cache directory

static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once at startup (lib.rs setup) with the app cache dir. Before that (and in tests)
/// the backends use `<temp>/slide-viewer-cache`.
pub fn set_cache_dir(dir: PathBuf) {
    let _ = CACHE_DIR.set(dir);
}

/// Root of the backend caches; `sub` is created if missing.
pub fn cache_dir(sub: &str) -> PathBuf {
    let base = CACHE_DIR.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("slide-viewer-cache"));
    let d = base.join(sub);
    let _ = std::fs::create_dir_all(&d);
    d
}

/// FNV-1a 64 of a string: stable across runs (cache keys).
pub fn fnv64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// A cache key for a file that changes when the file does (path + size + mtime).
pub fn file_key(path: &str) -> String {
    let meta = std::fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{:016x}", fnv64(&format!("{path}\u{0}{size}\u{0}{mtime}")))
}

// ---------------------------------------------------------------- LRU

/// Least-recently-used map with a cost budget (e.g. bytes). Eviction is O(n), which is fine
/// for the few hundred entries the tile caches hold.
pub struct Lru<K, V> {
    map: HashMap<K, (V, u64, usize)>,
    tick: u64,
    used: usize,
    budget: usize,
}

impl<K: Hash + Eq + Clone, V: Clone> Lru<K, V> {
    pub fn new(budget: usize) -> Self {
        Lru { map: HashMap::new(), tick: 0, used: 0, budget }
    }

    pub fn get(&mut self, k: &K) -> Option<V> {
        self.tick += 1;
        let t = self.tick;
        self.map.get_mut(k).map(|e| {
            e.1 = t;
            e.0.clone()
        })
    }

    pub fn put(&mut self, k: K, v: V, cost: usize) {
        if cost > self.budget {
            return;
        }
        self.tick += 1;
        if let Some(old) = self.map.insert(k, (v, self.tick, cost)) {
            self.used -= old.2;
        }
        self.used += cost;
        while self.used > self.budget {
            let Some(oldest) = self.map.iter().min_by_key(|(_, e)| e.1).map(|(k, _)| k.clone()) else { break };
            if let Some(e) = self.map.remove(&oldest) {
                self.used -= e.2;
            }
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn used(&self) -> usize {
        self.used
    }
}

// ---------------------------------------------------------------- tile-caching wrapper

/// Per-slide tile cache budget (decoded RGB). Frontend tiles are also cached by the webview,
/// so this mainly serves `region`/`overview` stitching and re-requests after a filter change.
pub const TILE_CACHE_BYTES: usize = 96 * 1024 * 1024;

/// Wraps a backend and remembers its recent Deep-Zoom tiles.
pub struct CachedSource {
    inner: Arc<dyn SlideSource>,
    tiles: Mutex<Lru<(u32, u32, u32, u32), Arc<RgbImage>>>,
}

impl CachedSource {
    pub fn new(inner: Arc<dyn SlideSource>) -> CachedSource {
        CachedSource { inner, tiles: Mutex::new(Lru::new(TILE_CACHE_BYTES)) }
    }
}

impl SlideSource for CachedSource {
    fn info(&self) -> &SourceInfo {
        self.inner.info()
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let key = (level, x, y, z);
        if let Some(t) = self.tiles.lock().unwrap().get(&key) {
            return Ok((*t).clone());
        }
        let t = self.inner.tile(level, x, y, z)?;
        let cost = t.as_raw().len() + 64;
        self.tiles.lock().unwrap().put(key, Arc::new(t.clone()), cost);
        Ok(t)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        self.inner.associated(name)
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String> {
        self.inner.region(x, y, w, h, out_w, out_h, z)
    }

    fn overview(&self, max_px: u32, z: u32) -> Result<RgbImage, String> {
        self.inner.overview(max_px, z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_least_recent() {
        let mut l: Lru<u32, u32> = Lru::new(3);
        l.put(1, 10, 1);
        l.put(2, 20, 1);
        l.put(3, 30, 1);
        assert_eq!(l.get(&1), Some(10)); // 2 is now the oldest
        l.put(4, 40, 1);
        assert_eq!(l.get(&2), None);
        assert_eq!(l.get(&1), Some(10));
        assert_eq!(l.len(), 3);
        l.put(5, 50, 10); // larger than the budget: ignored
        assert_eq!(l.get(&5), None);
        l.put(1, 11, 2); // replace grows cost, evicts the oldest (3)
        assert_eq!(l.used(), 3);
        assert_eq!(l.get(&3), None);
    }

    #[test]
    fn keys_are_stable() {
        assert_eq!(fnv64(""), 0xcbf29ce484222325);
        assert_ne!(fnv64("a"), fnv64("b"));
        assert_eq!(file_key("/nonexistent/x"), file_key("/nonexistent/x"));
    }
}
