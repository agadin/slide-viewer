//! Ventana / Roche BIF reader, the fallback for `.bif` files OpenSlide rejects (VENTANA DP 200
//! scans, whose tile joints say `Direction="LEFT"`; OpenSlide 4.0 only accepts RIGHT and UP).
//! Owner: formats builder.
//!
//! A BIF is a little-endian BigTIFF:
//! - IFD 0 "Label_Image" (the slide photo, exposed as "macro", as OpenSlide does), optionally
//!   "Thumbnail", plus "Probability_Image" (scanner tissue map, ignored). IFD 0's XMP (tag 700)
//!   holds `<iScan ScanRes="0.25" Magnification="40" …>`: ScanRes is µm per level-0 pixel.
//! - Pyramid levels with ImageDescription "level=N mag=M …", tiled JPEG. Level 0's XMP holds
//!   `<EncodeInfo>`: per scanned area (`SlideStitchInfo/ImageInfo`) its tile grid (NumCols ×
//!   NumRows tiles of Width × Height), its stage position (Pos-X/Pos-Y) and one `TileJointInfo`
//!   per pair of neighbouring tiles, saying by how many pixels they overlap (OverlapX/OverlapY).
//!   `AoiOrigin/AOIn` gives where the area's tiles start in the TIFF tile grid.
//!
//! Level 0 is NOT stitched: each TIFF tile is one camera tile, stored on a plain grid, and
//! neighbouring tiles repeat the pixels they overlap. Lower levels are plain downsamples of that
//! raw grid (level 1 is exactly half of level 0's TIFF size), so every level is stitched with the
//! level-0 tile positions divided by the level's downsample, like OpenSlide's sub-tile grid.
//!
//! Tile numbers (1-based) run serpentine from the bottom-left: row 0 is the bottom row, numbered
//! left to right, the next row up right to left, and so on (OpenSlide's `get_tile_coordinates`).
//! For DP 200 files that numbering still holds: on Ventana-1.bif every LEFT joint has Tile2 one
//! column to the right of Tile1 in that numbering (1→2, 46→45, …), the joints with OverlapX=24
//! line up in the same columns on every row (3|4, 7|8, …: the camera's 4-tile frames), and the
//! image itself repeats exactly 24 px at those TIFF tile boundaries and nowhere else. So LEFT
//! joins the same pair of tiles RIGHT does; we accept either order of Tile1/Tile2.
//!
//! Unlike OpenSlide, which averages all overlaps into one tile advance (fine for older iScan
//! files whose joints are all alike, but on DP 200 files 0 px within a frame and 24 px between
//! frames, which would leave ~5–18 px seams at every tile), each tile is placed with the
//! overlaps of its own row and column. Joints with confidence 0 use the confidence-weighted mean.

use std::fs::File;
use std::io::BufReader;
use std::sync::{Arc, Mutex};

use image::{imageops::FilterType, RgbImage};

use super::cache::Lru;
use super::plain::{samples_to_rgb, MAX_PLAUSIBLE_MPP};
use super::{dz_tile_rect, LevelInfo, SlideSource, SourceInfo, MAX_STITCH_PIXELS};

const TAG_DESCRIPTION: u16 = 270;
const TAG_WIDTH: u16 = 256;
const TAG_HEIGHT: u16 = 257;
const TAG_COMPRESSION: u16 = 259;
const TAG_X_RESOLUTION: u16 = 282;
const TAG_RESOLUTION_UNIT: u16 = 296;
const TAG_TILE_WIDTH: u16 = 322;
const TAG_TILE_LENGTH: u16 = 323;
const TAG_TILE_OFFSETS: u16 = 324;
const TAG_TILE_BYTE_COUNTS: u16 = 325;
const TAG_JPEG_TABLES: u16 = 347;
const TAG_XMP: u16 = 700;

/// Decoded TIFF tiles kept per slide.
const TILE_CACHE_BYTES: usize = 192 * 1024 * 1024;

// ---------------------------------------------------------------- file access

fn read_at(f: &File, buf: &mut [u8], off: u64) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        f.read_exact_at(buf, off).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = f.seek_read(&mut buf[done..], off + done as u64).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("unexpected end of file".into());
            }
            done += n;
        }
        Ok(())
    }
}

fn read_vec(f: &File, off: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut v = vec![0u8; len];
    read_at(f, &mut v, off)?;
    Ok(v)
}

// ---------------------------------------------------------------- TIFF / BigTIFF directories

/// One IFD entry: field type, count and the raw value/offset field (4 or 8 bytes, little endian).
#[derive(Clone, Copy, Debug)]
struct Entry {
    ty: u16,
    count: u64,
    raw: [u8; 8],
}

#[derive(Debug, Default)]
struct Ifd {
    entries: Vec<(u16, Entry)>,
}

fn type_size(ty: u16) -> u64 {
    match ty {
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 | 16 | 17 | 18 => 8,
        _ => 1,
    }
}

/// The directories of a little-endian classic TIFF or BigTIFF (tags are read on demand).
struct Tiff {
    file: File,
    big: bool,
    ifds: Vec<Ifd>,
}

impl Tiff {
    fn open(path: &str) -> Result<Tiff, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let head = read_vec(&file, 0, 16.min(len as usize))?;
        if head.len() < 8 || &head[0..2] != b"II" {
            return Err("not a little-endian TIFF".into());
        }
        let (big, mut off) = match u16::from_le_bytes([head[2], head[3]]) {
            42 => (false, u32::from_le_bytes(head[4..8].try_into().unwrap()) as u64),
            43 if head.len() == 16 => (true, u64::from_le_bytes(head[8..16].try_into().unwrap())),
            _ => return Err("not a TIFF".into()),
        };
        let (count_len, entry_len, next_len) = if big { (8u64, 20u64, 8u64) } else { (2, 12, 4) };
        let mut ifds = Vec::new();
        let mut seen = std::collections::HashSet::new();
        while off != 0 && off + count_len <= len && ifds.len() < 1024 && seen.insert(off) {
            let c = read_vec(&file, off, count_len as usize)?;
            let n = if big { u64::from_le_bytes(c.try_into().unwrap()) } else { u16::from_le_bytes([c[0], c[1]]) as u64 };
            if n > 4096 {
                return Err("implausible TIFF directory".into());
            }
            let body = read_vec(&file, off + count_len, (n * entry_len + next_len) as usize)?;
            let mut ifd = Ifd::default();
            for e in body[..(n * entry_len) as usize].chunks_exact(entry_len as usize) {
                let tag = u16::from_le_bytes([e[0], e[1]]);
                let ty = u16::from_le_bytes([e[2], e[3]]);
                let mut raw = [0u8; 8];
                let count = if big {
                    raw.copy_from_slice(&e[12..20]);
                    u64::from_le_bytes(e[4..12].try_into().unwrap())
                } else {
                    raw[..4].copy_from_slice(&e[8..12]);
                    u32::from_le_bytes(e[4..8].try_into().unwrap()) as u64
                };
                ifd.entries.push((tag, Entry { ty, count, raw }));
            }
            let nx = &body[(n * entry_len) as usize..];
            off = if big { u64::from_le_bytes(nx[..8].try_into().unwrap()) } else { u32::from_le_bytes(nx[..4].try_into().unwrap()) as u64 };
            ifds.push(ifd);
        }
        if ifds.is_empty() {
            return Err("TIFF without directories".into());
        }
        Ok(Tiff { file, big, ifds })
    }

    fn entry(&self, ifd: usize, tag: u16) -> Option<Entry> {
        self.ifds.get(ifd)?.entries.iter().find(|(t, _)| *t == tag).map(|(_, e)| *e)
    }

    /// The raw bytes of a tag's value.
    fn bytes(&self, ifd: usize, tag: u16) -> Option<Vec<u8>> {
        let e = self.entry(ifd, tag)?;
        let len = e.count.checked_mul(type_size(e.ty))?;
        if len > 256 << 20 {
            return None;
        }
        if len <= if self.big { 8 } else { 4 } {
            return Some(e.raw[..len as usize].to_vec());
        }
        let off = if self.big { u64::from_le_bytes(e.raw) } else { u32::from_le_bytes(e.raw[..4].try_into().unwrap()) as u64 };
        read_vec(&self.file, off, len as usize).ok()
    }

    /// An integer tag as a list (BYTE, SHORT, LONG, LONG8).
    fn uints(&self, ifd: usize, tag: u16) -> Option<Vec<u64>> {
        let ty = self.entry(ifd, tag)?.ty;
        let b = self.bytes(ifd, tag)?;
        Some(match ty {
            1 | 7 => b.iter().map(|v| *v as u64).collect(),
            3 => b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]]) as u64).collect(),
            4 | 13 => b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap()) as u64).collect(),
            16 | 18 => b.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect(),
            _ => return None,
        })
    }

    fn uint(&self, ifd: usize, tag: u16) -> Option<u64> {
        self.uints(ifd, tag).and_then(|v| v.first().copied())
    }

    fn rational(&self, ifd: usize, tag: u16) -> Option<f64> {
        let e = self.entry(ifd, tag)?;
        if e.ty != 5 {
            return None;
        }
        let b = self.bytes(ifd, tag)?;
        let n = u32::from_le_bytes(b[0..4].try_into().ok()?) as f64;
        let d = u32::from_le_bytes(b[4..8].try_into().ok()?) as f64;
        (d > 0.0).then_some(n / d)
    }

    /// A text tag (ASCII, or BYTE/UNDEFINED like XMP), without trailing NULs.
    fn text(&self, ifd: usize, tag: u16) -> Option<String> {
        let b = self.bytes(ifd, tag)?;
        let end = b.iter().rposition(|c| *c != 0).map(|i| i + 1).unwrap_or(0);
        Some(String::from_utf8_lossy(&b[..end]).into_owned())
    }
}

fn decode_jpeg(bytes: &[u8]) -> Result<RgbImage, String> {
    image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).map(|i| i.to_rgb8()).map_err(|e| e.to_string())
}

/// A TIFF JPEG tile with shared tables: tables without their EOI + the tile without its SOI.
fn merge_jpeg_tables(tables: &[u8], tile: &[u8]) -> Vec<u8> {
    if tables.len() < 4 || !tile.starts_with(&[0xFF, 0xD8]) {
        return tile.to_vec();
    }
    let mut v = Vec::with_capacity(tables.len() + tile.len());
    v.extend_from_slice(&tables[..tables.len() - 2]);
    v.extend_from_slice(&tile[2..]);
    v
}

// ---------------------------------------------------------------- minimal XML

/// One start tag: name, attributes, parent element (index into the list).
#[derive(Debug, Clone)]
struct Element {
    name: String,
    attrs: Vec<(String, String)>,
    parent: Option<usize>,
}

impl Element {
    fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
    fn num(&self, k: &str) -> Result<f64, String> {
        let v = self.attr(k).ok_or_else(|| format!("<{}> without {k}", self.name))?;
        v.trim().parse::<f64>().map_err(|_| format!("<{}> has bad {k}={v:?}", self.name))
    }
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The elements of an XML document in document order (enough for Ventana's attribute-only XML:
/// text content, CDATA and namespaces are ignored).
fn parse_xml(s: &str) -> Vec<Element> {
    let mut out: Vec<Element> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while let Some(p) = s[i..].find('<') {
        let start = i + p + 1;
        if s[start..].starts_with("!--") {
            i = s[start..].find("-->").map(|q| start + q + 3).unwrap_or(s.len());
            continue;
        }
        // end of tag, skipping '>' inside quotes
        let mut j = start;
        let mut quote = 0u8;
        while j < b.len() {
            let c = b[j];
            if quote != 0 {
                if c == quote {
                    quote = 0;
                }
            } else if c == b'"' || c == b'\'' {
                quote = c;
            } else if c == b'>' {
                break;
            }
            j += 1;
        }
        let tag = &s[start..j.min(s.len())];
        i = (j + 1).min(s.len());
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let name = name.trim();
            if let Some(k) = stack.iter().rposition(|&e| out[e].name == name) {
                stack.truncate(k);
            }
            continue;
        }
        let self_closing = tag.trim_end().ends_with('/');
        let body = tag.trim_end().trim_end_matches('/');
        let name_end = body.find(|c: char| c.is_whitespace()).unwrap_or(body.len());
        let name = body[..name_end].to_string();
        let mut attrs = Vec::new();
        let mut rest = &body[name_end..];
        while let Some(eq) = rest.find('=') {
            let key = rest[..eq].trim().to_string();
            let after = rest[eq + 1..].trim_start();
            let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
            let Some(close) = after[1..].find(q) else { break };
            attrs.push((key, unescape(&after[1..1 + close])));
            rest = &after[close + 2..];
        }
        out.push(Element { name, attrs, parent: stack.last().copied() });
        if !self_closing {
            stack.push(out.len() - 1);
        }
    }
    out
}

// ---------------------------------------------------------------- stitching layout

/// One `TileJointInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct Joint {
    pub direction: String,
    pub tile1: i64,
    pub tile2: i64,
    pub overlap_x: f64,
    pub overlap_y: f64,
    pub confidence: f64,
}

/// One scanned area (`ImageInfo` + its `AoiOrigin` entry).
#[derive(Debug, Clone, PartialEq)]
pub struct Area {
    /// first tile of the area in the TIFF tile grid, in pixels (AoiOrigin OriginX/OriginY)
    pub origin_x: i64,
    pub origin_y: i64,
    pub cols: i64,
    pub rows: i64,
    pub tile_w: i64,
    pub tile_h: i64,
    /// stage position (level-0 px); Pos-Y is measured from the bottom
    pub pos_x: f64,
    pub pos_y: f64,
    pub joints: Vec<Joint>,
}

/// Areas from a level-0 `<EncodeInfo>` XML (scanned ones only).
pub fn parse_encode_info(xml: &str) -> Result<Vec<Area>, String> {
    let els = parse_xml(xml);
    let is_child = |e: &Element, parent: &str| e.parent.map(|p| els[p].name == parent).unwrap_or(false);
    let infos: Vec<usize> = (0..els.len()).filter(|&i| els[i].name == "ImageInfo" && is_child(&els[i], "SlideStitchInfo")).collect();
    let origins: Vec<usize> = (0..els.len()).filter(|&i| is_child(&els[i], "AoiOrigin")).collect();
    if infos.is_empty() {
        return Err("no SlideStitchInfo/ImageInfo in level-0 XML".into());
    }
    if !origins.is_empty() && origins.len() != infos.len() {
        return Err("inconsistent area metadata (ImageInfo vs AoiOrigin)".into());
    }
    let mut areas = Vec::new();
    for (k, &ii) in infos.iter().enumerate() {
        let info = &els[ii];
        if info.attr("AOIScanned").map(|v| v.trim() == "0").unwrap_or(false) {
            continue;
        }
        let (ox, oy) = match origins.get(k) {
            Some(&o) => (els[o].num("OriginX")? as i64, els[o].num("OriginY")? as i64),
            None if infos.len() == 1 => (0, 0),
            None => return Err("missing AoiOrigin".into()),
        };
        let mut joints = Vec::new();
        for j in els.iter().filter(|e| e.name == "TileJointInfo" && e.parent == Some(ii)) {
            joints.push(Joint {
                direction: j.attr("Direction").unwrap_or("").trim().to_uppercase(),
                tile1: j.num("Tile1")? as i64,
                tile2: j.num("Tile2")? as i64,
                overlap_x: j.num("OverlapX").unwrap_or(0.0),
                overlap_y: j.num("OverlapY").unwrap_or(0.0),
                confidence: j.num("Confidence").unwrap_or(100.0),
            });
        }
        areas.push(Area {
            origin_x: ox,
            origin_y: oy,
            cols: info.num("NumCols")? as i64,
            rows: info.num("NumRows")? as i64,
            tile_w: info.num("Width")? as i64,
            tile_h: info.num("Height")? as i64,
            pos_x: info.num("Pos-X")?,
            pos_y: info.num("Pos-Y")?,
            joints,
        });
    }
    if areas.is_empty() {
        return Err("no scanned areas".into());
    }
    Ok(areas)
}

/// (column, row) of 1-based tile number `n` in an area, row 0 at the top: tiles are numbered
/// serpentine from the bottom-left (bottom row left to right, next row right to left, …).
pub fn tile_coords(n: i64, cols: i64, rows: i64) -> Result<(i64, i64), String> {
    if n < 1 || n > cols * rows {
        return Err(format!("tile number out of range: {n}"));
    }
    let t = n - 1;
    let mut col = t % cols;
    let row_from_bottom = t / cols;
    if row_from_bottom % 2 == 1 {
        col = cols - 1 - col;
    }
    Ok((col, rows - 1 - row_from_bottom))
}

/// Where one TIFF tile of level 0 goes in the stitched image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    /// TIFF tile grid position
    pub col: u32,
    pub row: u32,
    /// top-left in stitched level-0 pixels
    pub x: f64,
    pub y: f64,
}

/// The stitched level 0: cells in painting order (later cells cover earlier ones where they overlap).
#[derive(Debug, Clone)]
pub struct Layout {
    pub tile_w: u32,
    pub tile_h: u32,
    pub cells: Vec<Cell>,
    pub width: i64,
    pub height: i64,
}

/// Confidence-weighted mean overlap of the joints that have confidence, or 0.
fn mean_overlap(vals: &[(f64, f64)]) -> f64 {
    let w: f64 = vals.iter().map(|v| v.1).sum();
    if w > 0.0 { vals.iter().map(|v| v.0 * v.1).sum::<f64>() / w } else { 0.0 }
}

/// Positions of every tile of every area, from the joints' overlaps.
pub fn compute_layout(areas: &[Area], tile_w: u32, tile_h: u32) -> Result<Layout, String> {
    let (tw, th) = (tile_w as f64, tile_h as f64);
    struct Placed {
        cells: Vec<Cell>,
        w: f64,
        h: f64,
        pos_x: f64,
        pos_y: f64,
    }
    let mut placed = Vec::new();
    for a in areas {
        if a.tile_w != tile_w as i64 || a.tile_h != tile_h as i64 {
            return Err(format!("tile size mismatch: TIFF {tile_w}x{tile_h}, XML {}x{}", a.tile_w, a.tile_h));
        }
        if a.cols < 1 || a.rows < 1 || a.cols * a.rows > 1 << 22 {
            return Err(format!("bad tile grid {}x{}", a.cols, a.rows));
        }
        if a.origin_x < 0 || a.origin_y < 0 || a.origin_x % a.tile_w != 0 || a.origin_y % a.tile_h != 0 {
            return Err("area origin not on a tile boundary".into());
        }
        let (cols, rows) = (a.cols as usize, a.rows as usize);
        // hx[r][c]: overlap between (c, r) and (c+1, r); vy[c][r]: between (c, r) and (c, r+1)
        let mut hx: Vec<Vec<Option<f64>>> = vec![vec![None; cols.saturating_sub(1)]; rows];
        let mut vy: Vec<Vec<Option<f64>>> = vec![vec![None; rows.saturating_sub(1)]; cols];
        let (mut hs, mut vs) = (Vec::new(), Vec::new());
        for j in &a.joints {
            let (c1, r1) = tile_coords(j.tile1, a.cols, a.rows)?;
            let (c2, r2) = tile_coords(j.tile2, a.cols, a.rows)?;
            let horizontal = match j.direction.as_str() {
                // RIGHT: tile 2 is right of tile 1 (OpenSlide). LEFT (DP 200): the same pair of
                // horizontal neighbours; in practice tile 2 is right of tile 1 too.
                "RIGHT" | "LEFT" => true,
                "UP" | "DOWN" => false,
                d => return Err(format!("bad tile joint direction {d:?}")),
            };
            let ok = if horizontal { r1 == r2 && (c1 - c2).abs() == 1 } else { c1 == c2 && (r1 - r2).abs() == 1 };
            if !ok {
                return Err(format!("unexpected tile joint {} {}→{}: ({c1},{r1}) ({c2},{r2})", j.direction, j.tile1, j.tile2));
            }
            let v = if horizontal { j.overlap_x } else { j.overlap_y };
            if !v.is_finite() || v.abs() > (if horizontal { tw } else { th }) / 2.0 {
                return Err(format!("implausible tile overlap {v}"));
            }
            let usable = j.confidence > 0.0;
            if horizontal {
                if usable {
                    hx[r1 as usize][c1.min(c2) as usize] = Some(v);
                }
                hs.push((v, j.confidence.max(0.0)));
            } else {
                if usable {
                    vy[c1 as usize][r1.min(r2) as usize] = Some(v);
                }
                vs.push((v, j.confidence.max(0.0)));
            }
        }
        let (mh, mv) = (mean_overlap(&hs), mean_overlap(&vs));
        let (sc, sr) = ((a.origin_x / a.tile_w) as u32, (a.origin_y / a.tile_h) as u32);
        let mut cells = Vec::with_capacity(cols * rows);
        let (mut w, mut h) = (0f64, 0f64);
        // y of each cell runs down its column, x along its row
        let mut col_y = vec![0f64; cols];
        for r in 0..rows {
            let mut x = 0f64;
            for c in 0..cols {
                if c > 0 {
                    x += tw - hx[r][c - 1].unwrap_or(mh);
                }
                if r > 0 {
                    col_y[c] += th - vy[c][r - 1].unwrap_or(mv);
                }
                cells.push(Cell { col: sc + c as u32, row: sr + r as u32, x, y: col_y[c] });
                w = w.max(x + tw);
                h = h.max(col_y[c] + th);
            }
        }
        placed.push(Placed { cells, w, h, pos_x: a.pos_x, pos_y: a.pos_y });
    }
    // areas relative to each other: Pos-X from the left, Pos-Y from the bottom (OpenSlide)
    let top = placed.iter().map(|p| p.pos_y + p.h).fold(f64::MIN, f64::max);
    let ax: Vec<f64> = placed.iter().map(|p| p.pos_x).collect();
    let ay: Vec<f64> = placed.iter().map(|p| top - p.pos_y - p.h).collect();
    let (minx, miny) = (ax.iter().cloned().fold(f64::MAX, f64::min), ay.iter().cloned().fold(f64::MAX, f64::min));
    let mut cells = Vec::new();
    let (mut width, mut height) = (0f64, 0f64);
    for (k, p) in placed.iter().enumerate() {
        let (dx, dy) = ((ax[k] - minx).round(), (ay[k] - miny).round());
        width = width.max(dx + p.w);
        height = height.max(dy + p.h);
        cells.extend(p.cells.iter().map(|c| Cell { x: c.x + dx, y: c.y + dy, ..*c }));
    }
    Ok(Layout { tile_w, tile_h, cells, width: width.ceil() as i64, height: height.ceil() as i64 })
}

/// A plain grid (Ventana TIFF without stitching info): every tile where the TIFF puts it.
pub fn grid_layout(width: u64, height: u64, tile_w: u32, tile_h: u32) -> Layout {
    let (across, down) = (width.div_ceil(tile_w as u64) as u32, height.div_ceil(tile_h as u64) as u32);
    let mut cells = Vec::with_capacity((across * down) as usize);
    for row in 0..down {
        for col in 0..across {
            cells.push(Cell { col, row, x: (col * tile_w) as f64, y: (row * tile_h) as f64 });
        }
    }
    Layout { tile_w, tile_h, cells, width: width as i64, height: height as i64 }
}

/// Paint the stitched rectangle (lx, ly, lw × lh) of a level with downsample `ds`. `read_raw`
/// returns a rectangle (x, y, w, h) of that level's raw (unstitched) TIFF image.
pub fn compose<F>(layout: &Layout, ds: f64, raw_w: u32, raw_h: u32, lx: i64, ly: i64, lw: u32, lh: u32, mut read_raw: F) -> Result<RgbImage, String>
where
    F: FnMut(u32, u32, u32, u32) -> Result<RgbImage, String>,
{
    let mut out = RgbImage::from_pixel(lw.max(1), lh.max(1), image::Rgb([255, 255, 255]));
    let (tw, th) = (layout.tile_w as f64, layout.tile_h as f64);
    for c in &layout.cells {
        // the cell's pixels in the raw level, and where they go in the stitched level
        let sx0 = ((c.col as f64 * tw / ds).round() as i64).min(raw_w as i64);
        let sx1 = (((c.col + 1) as f64 * tw / ds).round() as i64).min(raw_w as i64);
        let sy0 = ((c.row as f64 * th / ds).round() as i64).min(raw_h as i64);
        let sy1 = (((c.row + 1) as f64 * th / ds).round() as i64).min(raw_h as i64);
        if sx1 <= sx0 || sy1 <= sy0 {
            continue;
        }
        let dx = (c.x / ds).round() as i64;
        let dy = (c.y / ds).round() as i64;
        let ix0 = dx.max(lx);
        let iy0 = dy.max(ly);
        let ix1 = (dx + sx1 - sx0).min(lx + lw as i64);
        let iy1 = (dy + sy1 - sy0).min(ly + lh as i64);
        if ix1 <= ix0 || iy1 <= iy0 {
            continue;
        }
        let part = read_raw((sx0 + ix0 - dx) as u32, (sy0 + iy0 - dy) as u32, (ix1 - ix0) as u32, (iy1 - iy0) as u32)?;
        image::imageops::replace(&mut out, &part, ix0 - lx, iy0 - ly);
    }
    Ok(out)
}

// ---------------------------------------------------------------- the backend

struct Level {
    ifd: usize,
    width: u32,
    height: u32,
    tile_w: u32,
    tile_h: u32,
    across: u32,
    offsets: Vec<u64>,
    counts: Vec<u64>,
    tables: Option<Vec<u8>>,
    /// relative to level 0 (from the magnifications)
    downsample: f64,
}

pub struct BifSource {
    path: String,
    tiff: Tiff,
    info: SourceInfo,
    levels: Vec<Level>,
    layout: Layout,
    associated: Vec<(String, usize)>,
    tiles: Mutex<Lru<(usize, u32), Arc<RgbImage>>>,
}

/// `key=value` pairs of a level's ImageDescription ("level=0 mag=40 quality=95").
fn desc_field(desc: &str, key: &str) -> Option<String> {
    desc.split_whitespace().find_map(|kv| kv.strip_prefix(key).and_then(|r| r.strip_prefix('=')).map(|v| v.to_string()))
}

/// µm per pixel from `<iScan ScanRes="…">` (None when absent or implausible).
pub fn scan_res(xml: &str) -> Option<f64> {
    parse_xml(xml).iter().filter(|e| e.name == "iScan").find_map(|e| e.attr("ScanRes")?.trim().parse::<f64>().ok()).filter(|v| *v > 0.0 && *v <= MAX_PLAUSIBLE_MPP)
}

impl BifSource {
    pub fn open(path: &str) -> Result<BifSource, String> {
        let tiff = Tiff::open(path).map_err(|e| format!("{path}: {e}"))?;
        // Ventana files carry an <iScan> element in the first directory's XMP
        let iscan_xml = (0..tiff.ifds.len()).filter_map(|i| tiff.text(i, TAG_XMP)).find(|x| x.contains("<iScan"));
        let Some(iscan_xml) = iscan_xml else {
            return Err(format!("{path}: not a Ventana BIF (no iScan metadata)"));
        };
        let mut levels: Vec<(i64, f64, usize)> = Vec::new();
        let mut associated = Vec::new();
        for i in 0..tiff.ifds.len() {
            let desc = tiff.text(i, TAG_DESCRIPTION).unwrap_or_default();
            if desc.contains("level=") {
                let lv = desc_field(&desc, "level").and_then(|v| v.parse::<i64>().ok());
                let mag = desc_field(&desc, "mag").and_then(|v| v.parse::<f64>().ok());
                if let (Some(lv), Some(mag)) = (lv, mag) {
                    if mag > 0.0 {
                        levels.push((lv, mag, i));
                    }
                }
            } else if desc == "Label Image" || desc == "Label_Image" {
                associated.push(("macro".to_string(), i));
            } else if desc == "Thumbnail" {
                associated.push(("thumbnail".to_string(), i));
            }
        }
        levels.sort_by_key(|l| l.0);
        let Some(&(0, mag0, ifd0)) = levels.first() else {
            return Err(format!("{path}: BIF without a level 0"));
        };
        let mut lv = Vec::new();
        for &(_, mag, ifd) in &levels {
            let compression = tiff.uint(ifd, TAG_COMPRESSION).unwrap_or(1);
            if compression != 7 {
                // OpenSlide reads other codecs through libtiff; DP 200 levels are always JPEG
                if ifd == ifd0 {
                    return Err(format!("{path}: unsupported BIF compression {compression}"));
                }
                continue;
            }
            let (Some(w), Some(h), Some(tw), Some(th)) =
                (tiff.uint(ifd, TAG_WIDTH), tiff.uint(ifd, TAG_HEIGHT), tiff.uint(ifd, TAG_TILE_WIDTH), tiff.uint(ifd, TAG_TILE_LENGTH))
            else {
                if ifd == ifd0 {
                    return Err(format!("{path}: level 0 is not tiled"));
                }
                continue;
            };
            if tw == 0 || th == 0 || w == 0 || h == 0 || w > u32::MAX as u64 || h > u32::MAX as u64 {
                return Err(format!("{path}: bad level size"));
            }
            let across = w.div_ceil(tw) as u32;
            let n = across as u64 * h.div_ceil(th);
            let offsets = tiff.uints(ifd, TAG_TILE_OFFSETS).unwrap_or_default();
            let counts = tiff.uints(ifd, TAG_TILE_BYTE_COUNTS).unwrap_or_default();
            if (offsets.len() as u64) < n || (counts.len() as u64) < n {
                return Err(format!("{path}: missing tile offsets"));
            }
            lv.push(Level {
                ifd,
                width: w as u32,
                height: h as u32,
                tile_w: tw as u32,
                tile_h: th as u32,
                across,
                offsets,
                counts,
                tables: tiff.bytes(ifd, TAG_JPEG_TABLES),
                downsample: mag0 / mag,
            });
        }
        let l0 = &lv[0];
        let layout = match tiff.text(ifd0, TAG_XMP).filter(|x| x.contains("EncodeInfo")) {
            Some(xml) => compute_layout(&parse_encode_info(&xml).map_err(|e| format!("{path}: {e}"))?, l0.tile_w, l0.tile_h)
                .map_err(|e| format!("{path}: {e}"))?,
            None => grid_layout(l0.width as u64, l0.height as u64, l0.tile_w, l0.tile_h),
        };
        for c in &layout.cells {
            if c.col >= l0.across || c.row as u64 >= (l0.height as u64).div_ceil(l0.tile_h as u64) {
                return Err(format!("{path}: stitching info refers to tiles outside the image"));
            }
        }
        // lower levels must be downsamples of the same raw grid
        let (w0, first_ifd) = (l0.width as f64, l0.ifd);
        lv.retain(|l| l.ifd == first_ifd || (l.width as f64 - w0 / l.downsample).abs() <= l.downsample.max(2.0) + 1.0);

        // calibration: ScanRes, else level 0's TIFF resolution (pixels per cm / inch)
        let mut mpp = scan_res(&iscan_xml);
        if mpp.is_none() {
            let unit = tiff.uint(ifd0, TAG_RESOLUTION_UNIT).unwrap_or(2);
            mpp = tiff.rational(ifd0, TAG_X_RESOLUTION).and_then(|r| match unit {
                2 => Some(25400.0 / r),
                3 => Some(10000.0 / r),
                _ => None,
            });
            mpp = mpp.filter(|v| *v > 0.0 && *v <= MAX_PLAUSIBLE_MPP);
        }
        let mut info = SourceInfo::basic("bif", layout.width, layout.height);
        info.vendor = Some("ventana".into());
        if let Some(m) = mpp {
            info.mpp_x = m;
            info.mpp_y = m;
            info.calibrated = true;
        }
        info.levels = lv
            .iter()
            .map(|l| LevelInfo {
                width: (layout.width as f64 / l.downsample).ceil() as i64,
                height: (layout.height as f64 / l.downsample).ceil() as i64,
                downsample: l.downsample,
            })
            .collect();
        info.associated = associated.iter().map(|(n, _)| n.clone()).collect();
        Ok(BifSource { path: path.to_string(), tiff, info, levels: lv, layout, associated, tiles: Mutex::new(Lru::new(TILE_CACHE_BYTES)) })
    }

    /// One decoded TIFF tile of a level (white when the tile is empty).
    fn raw_tile(&self, li: usize, idx: u32) -> Result<Arc<RgbImage>, String> {
        if let Some(t) = self.tiles.lock().unwrap().get(&(li, idx)) {
            return Ok(t);
        }
        let l = &self.levels[li];
        let (off, len) = (l.offsets[idx as usize], l.counts[idx as usize]);
        let img = if len == 0 || len > 64 << 20 {
            RgbImage::from_pixel(l.tile_w, l.tile_h, image::Rgb([255, 255, 255]))
        } else {
            let bytes = read_vec(&self.tiff.file, off, len as usize)?;
            let bytes = match &l.tables {
                Some(t) => merge_jpeg_tables(t, &bytes),
                None => bytes,
            };
            decode_jpeg(&bytes).map_err(|e| format!("BIF tile {idx}: {e}"))?
        };
        let img = Arc::new(img);
        self.tiles.lock().unwrap().put((li, idx), img.clone(), img.as_raw().len() + 64);
        Ok(img)
    }

    /// A rectangle of a level's raw TIFF image.
    fn read_raw(&self, li: usize, x: u32, y: u32, w: u32, h: u32) -> Result<RgbImage, String> {
        let l = &self.levels[li];
        let mut out = RgbImage::from_pixel(w.max(1), h.max(1), image::Rgb([255, 255, 255]));
        let x1 = (x + w).min(l.width);
        let y1 = (y + h).min(l.height);
        if x1 <= x || y1 <= y {
            return Ok(out);
        }
        for ty in y / l.tile_h..=(y1 - 1) / l.tile_h {
            for tx in x / l.tile_w..=(x1 - 1) / l.tile_w {
                let t = self.raw_tile(li, ty * l.across + tx)?;
                image::imageops::overlay(&mut out, &*t, (tx * l.tile_w) as i64 - x as i64, (ty * l.tile_h) as i64 - y as i64);
            }
        }
        Ok(out)
    }

    fn read_associated(&self, ifd: usize) -> Result<RgbImage, String> {
        use tiff::decoder::{Decoder, Limits};
        let f = File::open(&self.path).map_err(|e| e.to_string())?;
        let mut d = Decoder::new(BufReader::new(f)).map_err(|e| e.to_string())?.with_limits(Limits::unlimited());
        d.seek_to_image(ifd).map_err(|e| e.to_string())?;
        let (w, h) = d.dimensions().map_err(|e| e.to_string())?;
        if w as u64 * h as u64 > 1 << 28 {
            return Err("associated image too large".into());
        }
        let ct = d.colortype().map_err(|e| e.to_string())?;
        let data = d.read_image().map_err(|e| e.to_string())?;
        let rgb = samples_to_rgb(data, ct, (w * h) as usize, None, false)?;
        RgbImage::from_raw(w, h, rgb).ok_or_else(|| "bad associated image".into())
    }
}

impl SlideSource for BifSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (fx, fy, fw, fh, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        self.region(fx, fy, fw, fh, tw, th, z)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        let (_, ifd) = self.associated.iter().find(|(n, _)| n == name).ok_or_else(|| format!("no associated image named {name:?}"))?;
        self.read_associated(*ifd)
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, _z: u32) -> Result<RgbImage, String> {
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        let need = (w as f64 / out_w as f64).min(h as f64 / out_h as f64).max(1.0);
        // coarsest level that is still at least as fine as needed
        let mut li = 0;
        for (i, l) in self.levels.iter().enumerate() {
            if l.downsample <= need * 1.0001 && l.downsample > self.levels[li].downsample {
                li = i;
            }
        }
        let l = &self.levels[li];
        let ds = l.downsample;
        let lx = (x as f64 / ds).floor() as i64;
        let ly = (y as f64 / ds).floor() as i64;
        let lw = (((x + w) as f64 / ds).ceil() as i64 - lx).max(1) as u32;
        let lh = (((y + h) as f64 / ds).ceil() as i64 - ly).max(1) as u32;
        if lw as u64 * lh as u64 > MAX_STITCH_PIXELS {
            return Err("region too large".into());
        }
        let img = compose(&self.layout, ds, l.width, l.height, lx, ly, lw, lh, |rx, ry, rw, rh| self.read_raw(li, rx, ry, rw, rh))?;
        Ok(if img.dimensions() != (out_w, out_h) { image::imageops::resize(&img, out_w, out_h, FilterType::Triangle) } else { img })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = "/Users/alexandergadin/vscode/slide-viewer/test-data/formats/Ventana__Ventana-1.bif";

    fn joint(dir: &str, t1: i64, t2: i64, ox: f64, oy: f64) -> String {
        format!(r#"<TileJointInfo FlagJoined="1" Confidence="100" Direction="{dir}" Tile1="{t1}" Tile2="{t2}" OverlapX="{ox}" OverlapY="{oy}"/>"#)
    }

    #[test]
    fn xml_elements_and_attributes() {
        let x = r#"<?xml version='1.0'?><!-- c > --><A k="1" s='a &amp; b'><B v="x>y"/><C/></A><D/>"#;
        let e = parse_xml(x);
        assert_eq!(e.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["A", "B", "C", "D"]);
        assert_eq!(e[0].attr("s"), Some("a & b"));
        assert_eq!(e[1].attr("v"), Some("x>y"));
        assert_eq!(e[1].parent, Some(0));
        assert_eq!(e[2].parent, Some(0));
        assert_eq!(e[3].parent, None);
        assert_eq!(scan_res(r#"<Metadata><iScan Magnification="40" ScanRes="0.25"/></Metadata>"#), Some(0.25));
        assert_eq!(scan_res(r#"<iScan Magnification="40"/>"#), None);
        assert_eq!(desc_field("level=3 mag=5 quality=95", "mag").as_deref(), Some("5"));
    }

    #[test]
    fn serpentine_numbering() {
        // 3 × 2: bottom row 1 2 3 (left to right), top row 6 5 4
        assert_eq!(tile_coords(1, 3, 2).unwrap(), (0, 1));
        assert_eq!(tile_coords(3, 3, 2).unwrap(), (2, 1));
        assert_eq!(tile_coords(4, 3, 2).unwrap(), (2, 0));
        assert_eq!(tile_coords(6, 3, 2).unwrap(), (0, 0));
        assert!(tile_coords(0, 3, 2).is_err());
        assert!(tile_coords(7, 3, 2).is_err());
    }

    /// A DP 200-style area: 3 × 2 tiles of 100 px, LEFT joints, 10 px overlap between columns 1|2.
    fn dp200_xml(dir: &str) -> String {
        let mut j = String::new();
        // bottom row: 1(0) 2(1) 3(2); top row: 6(0) 5(1) 4(2)
        j += &joint(dir, 1, 2, 0.0, 0.0);
        j += &joint(dir, 6, 5, 0.0, 0.0);
        j += &joint(dir, 2, 3, 10.0, 0.0);
        j += &joint(dir, 5, 4, 10.0, 0.0);
        j += &joint("UP", 1, 6, 0.0, 4.0);
        j += &joint("UP", 2, 5, 0.0, 4.0);
        j += &joint("UP", 3, 4, 0.0, 4.0);
        format!(
            r#"<?xml version='1.0' encoding='utf-8' ?>
<EncodeInfo Ver="2"><SlideInfo><AoiInfo XIMAGESIZE="100" YIMAGESIZE="100" NumRows="2" NumCols="3"/></SlideInfo>
<SlideStitchInfo><ImageInfo AOIScanned="1" AOIIndex="0" NumRows="2" NumCols="3" Width="100" Height="100" Pos-X="500" Pos-Y="700">
{j}</ImageInfo><FrameInfo><Frame XY="0,0"/></FrameInfo></SlideStitchInfo>
<AoiOrigin><AOI0 OriginX="0" OriginY="0"/></AoiOrigin></EncodeInfo>"#
        )
    }

    #[test]
    fn parses_encode_info() {
        let a = parse_encode_info(&dp200_xml("LEFT")).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].cols, a[0].rows, a[0].tile_w, a[0].pos_x, a[0].pos_y), (3, 2, 100, 500.0, 700.0));
        assert_eq!(a[0].joints.len(), 7);
        assert_eq!(a[0].joints[2], Joint { direction: "LEFT".into(), tile1: 2, tile2: 3, overlap_x: 10.0, overlap_y: 0.0, confidence: 100.0 });
        assert!(parse_encode_info("<EncodeInfo/>").is_err());
    }

    #[test]
    fn layout_uses_each_joint() {
        let l = compute_layout(&parse_encode_info(&dp200_xml("LEFT")).unwrap(), 100, 100).unwrap();
        let at = |c: u32, r: u32| l.cells.iter().find(|x| x.col == c && x.row == r).map(|x| (x.x, x.y)).unwrap();
        assert_eq!(at(0, 0), (0.0, 0.0));
        assert_eq!(at(1, 0), (100.0, 0.0));
        assert_eq!(at(2, 0), (190.0, 0.0)); // 10 px overlap between columns 1 and 2
        assert_eq!(at(2, 1), (190.0, 96.0)); // 4 px between the rows
        assert_eq!((l.width, l.height), (290, 196));
        // RIGHT joins the same tiles the same way
        let r = compute_layout(&parse_encode_info(&dp200_xml("RIGHT")).unwrap(), 100, 100).unwrap();
        assert_eq!(r.cells, l.cells);
        // the TIFF tile size must match
        assert!(compute_layout(&parse_encode_info(&dp200_xml("LEFT")).unwrap(), 64, 64).is_err());
    }

    #[test]
    fn layout_rejects_bad_joints() {
        let bad = dp200_xml("LEFT").replace(r#"Direction="UP" Tile1="1" Tile2="6""#, r#"Direction="SIDEWAYS" Tile1="1" Tile2="6""#);
        assert!(compute_layout(&parse_encode_info(&bad).unwrap(), 100, 100).unwrap_err().contains("direction"));
        // tiles 1 and 3 are not neighbours
        let far = dp200_xml("LEFT").replace(r#"Tile1="1" Tile2="2""#, r#"Tile1="1" Tile2="3""#);
        assert!(compute_layout(&parse_encode_info(&far).unwrap(), 100, 100).is_err());
        // a joint without confidence falls back to the mean of the others
        let unsure = dp200_xml("LEFT").replace(r#"Confidence="100" Direction="LEFT" Tile1="2" Tile2="3""#, r#"Confidence="0" Direction="LEFT" Tile1="2" Tile2="3""#);
        let l = compute_layout(&parse_encode_info(&unsure).unwrap(), 100, 100).unwrap();
        let c = l.cells.iter().find(|c| c.col == 2 && c.row == 1).unwrap();
        assert!((c.x - (200.0 - 10.0 / 3.0)).abs() < 1e-9, "{c:?}");
    }

    #[test]
    fn layout_places_areas_by_stage_position() {
        let one = parse_encode_info(&dp200_xml("LEFT")).unwrap().remove(0);
        // a second 3 × 2 area stored below the first in the TIFF grid, 1000 px right and with its
        // bottom 300 px below the first's on the stage
        let two = Area { origin_x: 0, origin_y: 200, pos_x: 1500.0, pos_y: 400.0, ..one.clone() };
        let l = compute_layout(&[one, two], 100, 100).unwrap();
        let first = l.cells.iter().find(|c| c.col == 0 && c.row == 0).unwrap();
        let second = l.cells.iter().find(|c| c.col == 0 && c.row == 2).unwrap();
        assert_eq!((first.x, first.y), (0.0, 0.0));
        assert_eq!((second.x, second.y), (1000.0, 300.0));
        assert_eq!((l.width, l.height), (1290, 496));
    }

    /// Cut a known image into overlapping camera tiles, store them on a raw grid at level 0 and
    /// half size at level 1, and check that `compose` puts the image back together.
    #[test]
    fn compose_restores_the_scene() {
        let scene = RgbImage::from_fn(290, 196, |x, y| image::Rgb([(x * 7 % 251) as u8, (y * 13 % 251) as u8, ((x + y) % 256) as u8]));
        let l = compute_layout(&parse_encode_info(&dp200_xml("LEFT")).unwrap(), 100, 100).unwrap();
        let mut raw = RgbImage::from_pixel(300, 200, image::Rgb([255, 0, 255]));
        for c in &l.cells {
            let t = image::imageops::crop_imm(&scene, c.x as u32, c.y as u32, 100, 100).to_image();
            image::imageops::replace(&mut raw, &t, (c.col * 100) as i64, (c.row * 100) as i64);
        }
        let read = |r: &RgbImage| {
            let r = r.clone();
            move |x: u32, y: u32, w: u32, h: u32| Ok(image::imageops::crop_imm(&r, x, y, w, h).to_image())
        };
        let full = compose(&l, 1.0, 300, 200, 0, 0, 290, 196, read(&raw)).unwrap();
        assert_eq!(full, scene);
        // an offset window crossing both overlaps
        let win = compose(&l, 1.0, 300, 200, 150, 50, 100, 100, read(&raw)).unwrap();
        assert_eq!(win, image::imageops::crop_imm(&scene, 150, 50, 100, 100).to_image());
        // outside the image is white
        let edge = compose(&l, 1.0, 300, 200, 280, 0, 20, 10, read(&raw)).unwrap();
        assert_eq!(*edge.get_pixel(15, 5), image::Rgb([255, 255, 255]));
        // level 1: the raw grid at half size; stitched pixels land at half the positions
        let raw1 = image::imageops::resize(&raw, 150, 100, FilterType::Nearest);
        let half = compose(&l, 2.0, 150, 100, 0, 0, 145, 98, read(&raw1)).unwrap();
        let want = image::imageops::resize(&scene, 145, 98, FilterType::Nearest);
        let diff: u64 = half.as_raw().iter().zip(want.as_raw()).map(|(a, b)| (*a as i64 - *b as i64).unsigned_abs()).sum();
        let magenta = half.pixels().filter(|p| p.0 == [255, 0, 255]).count();
        assert_eq!(magenta, 0, "no raw-grid padding shows");
        assert!(diff as f64 / (half.as_raw().len() as f64) < 20.0);
    }

    #[test]
    fn jpeg_tables_merge() {
        let t = [0xFF, 0xD8, 1, 2, 0xFF, 0xD9];
        assert_eq!(merge_jpeg_tables(&t, &[0xFF, 0xD8, 9, 0xFF, 0xD9]), vec![0xFF, 0xD8, 1, 2, 9, 0xFF, 0xD9]);
    }

    /// A tiny Ventana TIFF without stitching info: a grid layout, calibration from ScanRes.
    #[test]
    fn opens_a_synthetic_ventana_tiff() {
        let dir = std::env::temp_dir().join(format!("bif-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.bif");
        let img = RgbImage::from_fn(64, 48, |x, y| image::Rgb([(x * 4) as u8, (y * 5) as u8, 128]));
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 95).encode(img.as_raw(), 64, 48, image::ExtendedColorType::Rgb8).unwrap();
        let xmp = b"<?xml version='1.0'?><iScan Magnification=\"40\" ScanRes=\"0.465\"/>\0";
        let desc = b"level=0 mag=40 quality=95\0";
        // classic TIFF: header, IFD at 8, then data
        let entries: Vec<(u16, u16, u32, Vec<u8>)> = vec![
            (256, 3, 1, 64u16.to_le_bytes().to_vec()),
            (257, 3, 1, 48u16.to_le_bytes().to_vec()),
            (259, 3, 1, 7u16.to_le_bytes().to_vec()),
            (270, 2, desc.len() as u32, desc.to_vec()),
            (322, 3, 1, 64u16.to_le_bytes().to_vec()),
            (323, 3, 1, 48u16.to_le_bytes().to_vec()),
            (324, 4, 1, vec![]), // patched below
            (325, 4, 1, (jpg.len() as u32).to_le_bytes().to_vec()),
            (700, 1, xmp.len() as u32, xmp.to_vec()),
        ];
        let ifd_len = 2 + entries.len() * 12 + 4;
        let mut data = Vec::new();
        let mut ifd = (entries.len() as u16).to_le_bytes().to_vec();
        let data_start = 8 + ifd_len;
        let jpg_off = data_start as u32;
        data.extend_from_slice(&jpg);
        for (tag, ty, count, val) in &entries {
            ifd.extend_from_slice(&tag.to_le_bytes());
            ifd.extend_from_slice(&ty.to_le_bytes());
            ifd.extend_from_slice(&count.to_le_bytes());
            let v = if *tag == 324 { jpg_off.to_le_bytes().to_vec() } else { val.clone() };
            if v.len() <= 4 {
                let mut f = v.clone();
                f.resize(4, 0);
                ifd.extend_from_slice(&f);
            } else {
                ifd.extend_from_slice(&((data_start + data.len()) as u32).to_le_bytes());
                data.extend_from_slice(&v);
            }
        }
        ifd.extend_from_slice(&0u32.to_le_bytes());
        let mut file = b"II*\0".to_vec();
        file.extend_from_slice(&8u32.to_le_bytes());
        file.extend_from_slice(&ifd);
        file.extend_from_slice(&data);
        std::fs::write(&p, &file).unwrap();
        let s = BifSource::open(p.to_str().unwrap()).unwrap();
        assert_eq!((s.info.width, s.info.height), (64, 48));
        assert!(s.info.calibrated && (s.info.mpp_x - 0.465).abs() < 1e-9);
        assert_eq!(s.info.vendor.as_deref(), Some("ventana"));
        let r = s.region(0, 0, 64, 48, 64, 48, 0).unwrap();
        let px = r.get_pixel(40, 30);
        assert!((px[0] as i32 - 160).abs() < 12 && (px[1] as i32 - 150).abs() < 12, "{px:?}");
        // not a Ventana file without iScan
        std::fs::write(&p, file.iter().map(|b| if *b == b'S' { b'X' } else { *b }).collect::<Vec<_>>()).unwrap();
        assert!(BifSource::open(p.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The DP 200 sample (joint direction LEFT) that OpenSlide rejects. `BIF_DUMP=<dir>` saves
    /// a full-resolution crop across tile joints and the overview as PNG.
    #[test]
    #[ignore]
    fn real_dp200_bif() {
        let p = std::env::var("BIF_SAMPLE").unwrap_or(REAL.into());
        if !std::path::Path::new(&p).exists() {
            eprintln!("skipping: {p} not present");
            return;
        }
        let s = BifSource::open(&p).unwrap();
        let i = s.info();
        eprintln!("{}", serde_json::to_string(i).unwrap());
        assert_eq!(i.vendor.as_deref(), Some("ventana"));
        assert!(i.calibrated && (i.mpp_x - 0.25).abs() < 1e-9);
        // 23 × 21 tiles of 1024 px, 24 px overlap at five column joints
        assert_eq!((i.width, i.height), (23 * 1024 - 5 * 24, 21 * 1024));
        assert!(i.associated.contains(&"macro".to_string()));
        assert!(s.associated("macro").unwrap().width() > 100);
        let o = s.overview(1024, 0).unwrap();
        assert!(o.width() <= 1024 && o.height() <= 1024);
        let max = super::super::dz_max_level(i.width, i.height);
        assert_eq!(s.tile(max, 20, 40, 0).unwrap().dimensions(), (256, 256));
        // the stitched pixels across the 3|4 joint continue smoothly: compare the jump across the
        // joint with the jump between ordinary neighbouring columns
        let (jx, y0) = (4 * 1024 - 24, 8 * 1024);
        let r = s.region(jx - 64, y0, 128, 1024, 128, 1024, 0).unwrap();
        let col_diff = |a: u32, b: u32| (0..1024).map(|y| (0..3).map(|c| (r.get_pixel(a, y)[c] as f64 - r.get_pixel(b, y)[c] as f64).abs()).sum::<f64>()).sum::<f64>() / 1024.0;
        let at_joint = col_diff(63, 64);
        let typical = (col_diff(30, 31) + col_diff(100, 101)) / 2.0;
        eprintln!("column jump at joint {at_joint:.1}, elsewhere {typical:.1}");
        assert!(at_joint < typical * 2.0 + 5.0, "seam at the tile joint");
        if let Ok(dir) = std::env::var("BIF_DUMP") {
            s.region(3 * 1024, 7 * 1024, 2048, 2048, 2048, 2048, 0).unwrap().save(format!("{dir}/bif_joints_full.png")).unwrap();
            s.region(3 * 1024 + 900, 8 * 1024 - 200, 400, 400, 400, 400, 0).unwrap().save(format!("{dir}/bif_joint_zoom.png")).unwrap();
            o.save(format!("{dir}/bif_overview.png")).unwrap();
            // the spot where the raw tile grid shows a 24 px repeat (TIFF x = 4096, y ≈ 9000),
            // and a 2 × 2 tile corner at the 7|8 joint
            s.region(4096 - 24 - 256, 9000, 512, 400, 512, 400, 0).unwrap().save(format!("{dir}/bif_joint_3_4.png")).unwrap();
            s.region(8 * 1024 - 48 - 512, 9 * 1024 - 512, 1024, 1024, 1024, 1024, 0).unwrap().save(format!("{dir}/bif_corner_7_8.png")).unwrap();
            // level 2 (downsample 4) across four frame joints
            s.region(2048, 6144, 4096 * 3, 4096, 3072, 1024, 0).unwrap().save(format!("{dir}/bif_level2.png")).unwrap();
            s.region(0, 0, i.width, i.height, 3000, (3000.0 * i.height as f64 / i.width as f64) as u32, 0).unwrap().save(format!("{dir}/bif_overview_3000.png")).unwrap();
        }
    }
}
