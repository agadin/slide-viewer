//! The `slide://` tile URL scheme. FROZEN CONTRACT (CONTRACTS.md); shared by every backend.
//!
//!   /<slide id>/<z>/<level>/<x>_<y>.jpg   focal plane z (a `ZPlane::index`)
//!   /<slide id>/<level>/<x>_<y>.jpg       the same with z = 0 (MSG's original form)
//!
//! `level` is the Deep-Zoom level (OpenSeadragon's), `x`/`y` the tile column/row.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TilePath {
    pub id: u32,
    pub z: u32,
    pub level: u32,
    pub x: u32,
    pub y: u32,
}

pub fn parse_tile_path(p: &str) -> Option<TilePath> {
    let parts: Vec<&str> = p.trim_start_matches('/').split('/').collect();
    let (id, z, level, file) = match parts.as_slice() {
        [id, level, file] => (*id, "0", *level, *file),
        [id, z, level, file] => (*id, *z, *level, *file),
        _ => return None,
    };
    let num = |s: &str| -> Option<u32> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let (x, y) = file.strip_suffix(".jpg")?.split_once('_')?;
    Some(TilePath { id: num(id)?, z: num(z)?, level: num(level)?, x: num(x)?, y: num(y)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_paths() {
        let t = |id, z, level, x, y| Some(TilePath { id, z, level, x, y });
        assert_eq!(parse_tile_path("/3/12/4_7.jpg"), t(3, 0, 12, 4, 7));
        assert_eq!(parse_tile_path("3/12/4_7.jpg"), t(3, 0, 12, 4, 7));
        assert_eq!(parse_tile_path("/3/2/12/4_7.jpg"), t(3, 2, 12, 4, 7));
        assert_eq!(parse_tile_path("/3/12/4_7.png"), None);
        assert_eq!(parse_tile_path("/3/12/4_7.jpg/x"), None);
        assert_eq!(parse_tile_path("/3/1/2/12/4_7.jpg"), None);
        assert_eq!(parse_tile_path("/a/12/4_7.jpg"), None);
        assert_eq!(parse_tile_path("/3/12/-4_7.jpg"), None);
        assert_eq!(parse_tile_path("/3/+1/12/4_7.jpg"), None);
    }
}
