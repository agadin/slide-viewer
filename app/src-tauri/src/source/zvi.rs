//! Zeiss AxioVision `.zvi` (the format before `.czi`). Owner: formats builder.
//!
//! A ZVI file is an OLE2 compound document (read with the `cfb` crate). The pixels live in
//! `Image/Item(n)/Contents`, one stream per plane: a run of OLE VARIANTs (the 12th is a blob
//! whose bytes 8..28 give the Z, C, T and tile indices), then a fixed header
//! (`version, width, height, depth, bytes per pixel, pixel format, valid bits`) and the raw,
//! row-major, little-endian pixels (BGR order for colour). `Image/Item(n)/Tags/Contents` holds
//! that plane's tags (channel colour and name, stage position, focus position) and
//! `Image/Tags/Contents` the image's (size, scaling). A tag list is `i32` count at byte 8, then
//! `VARIANT value, VT_I4 id, VT_I4 attribute` per tag. Layout as documented by Bio-Formats'
//! `ZeissZVIReader` (read for reference; this is an independent implementation).
//!
//! Display: ZVI images are flat, so each focal plane becomes a Deep-Zoom pyramid
//! (`pyramid.rs`), built on first use: in memory, or on disk in the app cache for big mosaics.
//! - brightfield colour (BGR24 / BGRA32 / BGR48) is shown as is (48-bit with a percentile stretch);
//! - grey channels are stretched (0.1 % → 99.9 % percentiles of the in-focus plane, one stretch
//!   for all planes so focusing doesn't flicker) and summed in each channel's colour from the
//!   tags (Bio-Formats' COLORREF `0x00BBGGRR`); a single 8-bit grey channel is shown as is;
//! - mosaic tiles are placed by their stage position (µm) divided by the pixel size;
//! - Z-stacks become focal planes; the middle plane is the nominal one.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use image::{imageops::FilterType, RgbImage};

use super::cache::{cache_dir, file_key};
use super::plain::{MAX_PIXELS, MAX_PLAUSIBLE_MPP, MEM_PIXELS};
use super::pyramid::{Canvas, Pyramid};
use super::{dz_max_level, dz_tile_rect, fit, make_planes, LevelInfo, SlideSource, SourceInfo, TILE_SIZE};

/// Planes whose pyramids stay in memory, by total bytes (older planes are dropped and rebuilt).
const MEM_PLANE_BUDGET: u64 = 384 << 20;
/// Bump when the rendering (stretch, colours, layout) changes, so cached mosaics are rebuilt.
const RENDER_VERSION: u32 = 1;
/// Disk pyramids kept in the cache (oldest are removed).
const KEEP_DISK: usize = 6;
/// Percentiles of the grey stretch.
const STRETCH_LO: f64 = 0.001;
const STRETCH_HI: f64 = 0.999;

// ---------------------------------------------------------------- VARIANTs and tags (pure)

/// One OLE VARIANT value as the ZVI streams use them.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Empty,
    Int(i64),
    Real(f64),
    Str(String),
    /// VT_BLOB: the payload's byte range in the stream
    Blob(usize, usize),
    Other,
}

impl Val {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Val::Int(i) => Some(*i as f64),
            Val::Real(r) => Some(*r),
            Val::Str(s) => s.trim().parse().ok(),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Val::Int(i) => Some(*i),
            Val::Real(r) if r.fract() == 0.0 => Some(*r as i64),
            _ => None,
        }
    }
}

fn u16_at(b: &[u8], p: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(p..p + 2)?.try_into().ok()?))
}
fn i32_at(b: &[u8], p: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?))
}
fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?))
}

/// Read the VARIANT at `p`: (value, offset after it). None when truncated or of a type whose
/// length we can't know.
pub fn read_variant(b: &[u8], p: usize) -> Option<(Val, usize)> {
    let vt = u16_at(b, p)?;
    let q = p + 2;
    let f8 = |o: usize| -> Option<[u8; 8]> { b.get(o..o + 8)?.try_into().ok() };
    Some(match vt {
        0 | 1 => (Val::Empty, q),
        2 | 11 => (Val::Int(u16_at(b, q)? as i16 as i64), q + 2),
        3 | 22 => (Val::Int(i32_at(b, q)? as i64), q + 4),
        19 | 23 => (Val::Int(u32_at(b, q)? as i64), q + 4),
        4 => (Val::Real(f32::from_le_bytes(b.get(q..q + 4)?.try_into().ok()?) as f64), q + 4),
        5 | 7 => (Val::Real(f64::from_le_bytes(f8(q)?)), q + 8),
        20 => (Val::Int(i64::from_le_bytes(f8(q)?)), q + 8),
        21 => (Val::Int(u64::from_le_bytes(f8(q)?) as i64), q + 8),
        8 | 69 => {
            // byte length, UTF-16LE text (usually NUL-terminated)
            let n = u32_at(b, q)? as usize;
            let raw = b.get(q + 4..q + 4 + n)?;
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            let s = String::from_utf16_lossy(&units).trim_end_matches('\0').to_string();
            (Val::Str(s), q + 4 + n)
        }
        9 | 13 => (Val::Other, q + 16),
        63 | 65 => {
            let n = u32_at(b, q)? as usize;
            b.get(q + 4..q + 4 + n)?;
            (Val::Blob(q + 4, n), q + 4 + n)
        }
        66 => {
            let n = u16_at(b, q)? as usize;
            (Val::Other, q + 2 + n)
        }
        _ => return None,
    })
}

/// A `Tags/Contents` stream: (tag id, value) in file order.
pub fn parse_tags(b: &[u8]) -> Vec<(u32, Val)> {
    let mut out = Vec::new();
    let Some(n) = i32_at(b, 8) else { return out };
    let mut p = 12;
    for _ in 0..n.max(0) {
        let Some((v, q)) = read_variant(b, p) else { break };
        // VT_I4 id, VT_I4 attribute
        let (Some(id), Some(_attr)) = (i32_at(b, q + 2), i32_at(b, q + 8)) else { break };
        out.push((id as u32, v));
        p = q + 12;
    }
    out
}

fn tag<'a>(tags: &'a [(u32, Val)], id: u32) -> Option<&'a Val> {
    tags.iter().find(|(i, _)| *i == id).map(|(_, v)| v)
}

// tag ids (Bio-Formats' BaseZeissReader names)
const T_SCALE_X: u32 = 769;
const T_UNIT_X: u32 = 770;
const T_SCALE_Y: u32 = 772;
const T_UNIT_Y: u32 = 773;
const T_SCALE_Z: u32 = 775;
const T_UNIT_Z: u32 = 776;
const T_CHANNEL_COLOR: u32 = 1282;
const T_CHANNEL_NAME: u32 = 1284;
const T_FOCUS: u32 = 2072;
const T_STAGE_X: u32 = 2073;
const T_STAGE_Y: u32 = 2074;

/// A scale value in µm, from a "Scale Factor" and its unit code (AxioVision: 76 µm, 77 nm,
/// 75 mm, 74 cm, 72 m; anything else is taken as µm as Bio-Formats does).
pub fn scale_um(factor: f64, unit: Option<i64>) -> f64 {
    factor
        * match unit {
            Some(72) => 1e6,
            Some(74) => 1e4,
            Some(75) => 1e3,
            Some(77) => 1e-3,
            _ => 1.0,
        }
}

fn mpp_plausible(m: f64) -> bool {
    m.is_finite() && m > 0.001 && m <= MAX_PLAUSIBLE_MPP
}

/// How a plane's pixels are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pixels {
    Gray8,
    Gray16,
    Bgr24,
    Bgra32,
    Bgr48,
}

impl Pixels {
    pub fn bytes(self) -> usize {
        match self {
            Pixels::Gray8 => 1,
            Pixels::Gray16 => 2,
            Pixels::Bgr24 => 3,
            Pixels::Bgra32 => 4,
            Pixels::Bgr48 => 6,
        }
    }
    pub fn is_color(self) -> bool {
        matches!(self, Pixels::Bgr24 | Pixels::Bgra32 | Pixels::Bgr48)
    }
    fn is16(self) -> bool {
        matches!(self, Pixels::Gray16 | Pixels::Bgr48)
    }
    /// AxioVision pixel format code, falling back to bytes per pixel.
    pub fn from_codes(format: u32, bytes_pp: u32) -> Option<Pixels> {
        let by_format = match format {
            1 => Some(Pixels::Bgr24),
            2 => Some(Pixels::Bgra32),
            3 => Some(Pixels::Gray8),
            4 => Some(Pixels::Gray16),
            8 => Some(Pixels::Bgr48),
            _ => None,
        };
        match by_format {
            Some(p) if p.bytes() as u32 == bytes_pp => Some(p),
            _ => match bytes_pp {
                1 => Some(Pixels::Gray8),
                2 => Some(Pixels::Gray16),
                3 => Some(Pixels::Bgr24),
                4 => Some(Pixels::Bgra32),
                6 => Some(Pixels::Bgr48),
                _ => None,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
    None,
    Jpeg,
    Zlib,
}

/// The header of an `Item(n)/Contents` stream.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemHeader {
    pub z: i32,
    pub c: i32,
    pub t: i32,
    pub tile: i32,
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
    pub valid_bits: u32,
    pub compression: Compression,
    /// where the pixel data starts in the stream
    pub data_offset: usize,
}

/// Parse the start of an `Item(n)/Contents` stream (a few KB is enough).
pub fn parse_item_header(b: &[u8]) -> Result<ItemHeader, String> {
    let bad = |what: &str| format!("ZVI image header: {what}");
    let mut p = 0;
    for _ in 0..11 {
        p = read_variant(b, p).ok_or_else(|| bad("truncated"))?.1;
    }
    // 12th: the blob with Z, C, T and tile
    let (Val::Blob(o, n), q) = read_variant(b, p).ok_or_else(|| bad("truncated"))? else {
        return Err(bad("no index block"));
    };
    if n < 28 {
        return Err(bad("short index block"));
    }
    let at = |k: usize| i32_at(b, o + k).unwrap_or(0);
    let (z, c, t, tile) = (at(8), at(12), at(16), at(24));
    p = q;
    for _ in 0..5 {
        p = read_variant(b, p).ok_or_else(|| bad("truncated"))?.1;
    }
    let f = |k: usize| u32_at(b, p + 4 * k).ok_or_else(|| bad("truncated"));
    // [0] version, [1] width, [2] height, [3] depth, [4] bytes/px, [5] format, [6] valid bits
    let (width, height, bpp, format, valid) = (f(1)?, f(2)?, f(4)?, f(5)?, f(6)?);
    if width == 0 || height == 0 {
        return Err(bad("empty image"));
    }
    let pixels = Pixels::from_codes(format, bpp).ok_or_else(|| bad(&format!("unsupported pixel type {format} ({bpp} bytes)")))?;
    let mut data_offset = p + 28;
    let compression = if valid <= 1 {
        if b.get(data_offset..data_offset + 3) == Some(b"WZL") {
            data_offset += 8;
            Compression::Zlib
        } else {
            Compression::Jpeg
        }
    } else {
        Compression::None
    };
    Ok(ItemHeader { z, c, t, tile, width, height, pixels, valid_bits: valid, compression, data_offset })
}

// ---------------------------------------------------------------- display maths (pure)

/// Low/high sample values at the given fractions of a histogram (hi > lo).
pub fn percentile_range(hist: &[u64], lo: f64, hi: f64) -> (u32, u32) {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return (0, hist.len().saturating_sub(1).max(1) as u32);
    }
    let find = |frac: f64| -> u32 {
        let want = (frac * total as f64).ceil().max(1.0) as u64;
        let mut acc = 0;
        for (v, &n) in hist.iter().enumerate() {
            acc += n;
            if acc >= want {
                return v as u32;
            }
        }
        hist.len() as u32 - 1
    };
    let (l, h) = (find(lo), find(hi));
    if h > l { (l, h) } else { (l, l + 1) }
}

/// The background level of a fluorescence channel: the histogram's peak (in 256 buckets
/// between `lo` and `hi`) when it lies in the darker half of that range, i.e. the background is
/// dark. None for bright-background (brightfield) channels.
pub fn background_peak(hist: &[u64], lo: u32, hi: u32) -> Option<u32> {
    let total: u64 = hist.iter().sum();
    if total == 0 || hi <= lo {
        return None;
    }
    let width = ((hi - lo) as usize).div_ceil(256).max(1);
    let mut best = (0u64, lo as usize);
    let mut start = lo as usize;
    while start < hi as usize {
        let n: u64 = hist[start..(start + width).min(hi as usize)].iter().sum();
        if n > best.0 {
            best = (n, start);
        }
        start += width;
    }
    let peak = (best.1 + width / 2) as u32;
    (peak < lo + (hi - lo) / 2).then_some(peak)
}

/// Sample value → 0..255 for a (lo, hi) stretch.
pub fn stretch_lut(lo: u32, hi: u32, n: usize) -> Vec<u8> {
    let span = (hi.saturating_sub(lo)).max(1) as f64;
    (0..n).map(|v| ((v as f64 - lo as f64) / span * 255.0).round().clamp(0.0, 255.0) as u8).collect()
}

/// COLORREF (0x00BBGGRR) → RGB. 0 (black, i.e. unset) → None.
pub fn colorref(v: i64) -> Option<[u8; 3]> {
    let v = v as u32 & 0xFF_FFFF;
    (v != 0).then(|| [(v & 0xFF) as u8, (v >> 8 & 0xFF) as u8, (v >> 16 & 0xFF) as u8])
}

/// Colours for channels without one: blue, green, red, then the mixes.
const DEFAULT_COLORS: [[u8; 3]; 6] = [[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 0, 255], [0, 255, 255], [255, 255, 0]];

// ---------------------------------------------------------------- the source

struct Item {
    path: PathBuf,
    h: ItemHeader,
}

/// One displayed channel (a C index).
struct Channel {
    c: i32,
    color: [u8; 3],
    name: String,
}

/// One tile of the mosaic (a tile index) and where its top-left goes in level-0 px.
struct TilePos {
    tile: i32,
    x: u32,
    y: u32,
}

pub struct ZviSource {
    path: String,
    info: SourceInfo,
    file: Mutex<cfb::CompoundFile<File>>,
    /// (z position, c, tile) → item, t = 0 only
    items: HashMap<(usize, i32, i32), Item>,
    channels: Vec<Channel>,
    tiles: Vec<TilePos>,
    pixels: Pixels,
    /// z index of each z position (sorted ascending)
    zs: Vec<i32>,
    /// for each ZPlane::index, its z position
    plane_pos: Vec<usize>,
    nominal: usize,
    /// one LUT per channel (for colour: one for all three samples)
    luts: OnceLock<Vec<Vec<u8>>>,
    planes: Mutex<PlaneCache>,
    build: Mutex<()>,
}

#[derive(Default)]
struct PlaneCache {
    /// z position → (pyramid, bytes in memory, last use)
    map: HashMap<usize, (Arc<Pyramid>, u64, u64)>,
    clock: u64,
}

impl ZviSource {
    pub fn open(path: &str) -> Result<ZviSource, String> {
        let mut cf = cfb::open(path).map_err(|e| format!("{path}: not a ZVI file ({e})"))?;
        // the image streams: Image/Item(n)/Contents, or Image/Contents alone for single images
        let mut streams: Vec<(i64, PathBuf)> = Vec::new();
        for e in cf.walk() {
            if !e.is_stream() || e.len() <= 1024 {
                continue;
            }
            let p = e.path();
            let parts: Vec<String> = p.iter().map(|s| s.to_string_lossy().to_string()).collect();
            // ["/", "Image", "Item(n)", "Contents"]
            if parts.len() == 4 && parts[1] == "Image" && parts[3] == "Contents" {
                if let Some(n) = parts[2].strip_prefix("Item(").and_then(|s| s.strip_suffix(')')).and_then(|s| s.parse().ok()) {
                    streams.push((n, p.to_path_buf()));
                }
            }
        }
        if streams.is_empty() && cf.is_stream("/Image/Contents") && cf.entry("/Image/Contents").map(|e| e.len() > 1024).unwrap_or(false) {
            streams.push((0, PathBuf::from("/Image/Contents")));
        }
        if streams.is_empty() {
            return Err(format!("{path}: no images in this ZVI file"));
        }
        streams.sort();
        let image_tags = read_stream(&mut cf, Path::new("/Image/Tags/Contents"), usize::MAX).map(|b| parse_tags(&b)).unwrap_or_default();

        struct Raw {
            path: PathBuf,
            h: ItemHeader,
            tags: Vec<(u32, Val)>,
        }
        let mut raws = Vec::new();
        for (_, sp) in &streams {
            let head = read_stream(&mut cf, sp, 8192)?;
            let h = parse_item_header(&head).map_err(|e| format!("{path}: {e}"))?;
            if h.t != 0 {
                continue;
            }
            let tp = sp.parent().map(|d| d.join("Tags").join("Contents"));
            let tags = tp.and_then(|tp| read_stream(&mut cf, &tp, usize::MAX).ok()).map(|b| parse_tags(&b)).unwrap_or_default();
            raws.push(Raw { path: sp.clone(), h, tags });
        }
        if raws.is_empty() {
            return Err(format!("{path}: no images at the first time point"));
        }
        let pixels = raws[0].h.pixels;
        if raws.iter().any(|r| r.h.pixels.is_color() != pixels.is_color()) {
            return Err(format!("{path}: mixes colour and grey planes"));
        }
        if let Some(r) = raws.iter().find(|r| r.h.compression == Compression::Zlib) {
            return Err(format!("{path}: zlib-compressed ZVI planes are not supported ({})", r.path.display()));
        }

        // calibration
        let num = |id: u32| tag(&image_tags, id).and_then(Val::as_f64);
        let unit = |id: u32| tag(&image_tags, id).and_then(Val::as_i64);
        let mx = num(T_SCALE_X).map(|f| scale_um(f, unit(T_UNIT_X)));
        let my = num(T_SCALE_Y).map(|f| scale_um(f, unit(T_UNIT_Y))).or(mx);
        let mpp = match (mx, my) {
            (Some(x), Some(y)) if mpp_plausible(x) && mpp_plausible(y) => Some((x, y)),
            _ => None,
        };
        let scale_z = num(T_SCALE_Z).map(|f| scale_um(f, unit(T_UNIT_Z))).filter(|z| z.is_finite() && *z > 0.0);

        // Z
        let mut zs: Vec<i32> = raws.iter().map(|r| r.h.z).collect();
        zs.sort();
        zs.dedup();
        let zpos = |z: i32| zs.binary_search(&z).unwrap();
        let nominal = (zs.len() - 1) / 2;
        let focus: Vec<Option<f64>> = zs
            .iter()
            .map(|&z| raws.iter().find(|r| r.h.z == z).and_then(|r| tag(&r.tags, T_FOCUS)).and_then(Val::as_f64))
            .collect();
        // the Z step (scale) gives clean labels; the measured focus positions jitter (±25 nm)
        let offsets: Vec<Option<f64>> = if zs.len() <= 1 {
            vec![]
        } else if let Some(dz) = scale_z {
            zs.iter().map(|&z| Some(((z - zs[nominal]) as f64 * dz * 1000.0).round())).collect()
        } else if focus.iter().all(Option::is_some) && focus.first() != focus.last() {
            let f0 = focus[nominal].unwrap();
            focus.iter().map(|f| Some(((f.unwrap() - f0) * 1000.0).round())).collect()
        } else {
            vec![None; zs.len()]
        };
        let (z_planes, plane_pos) = make_planes(&offsets, nominal);

        // channels, in C order, with their colours
        let mut cs: Vec<i32> = raws.iter().map(|r| r.h.c).collect();
        cs.sort();
        cs.dedup();
        if pixels.is_color() {
            cs.truncate(1);
        }
        let channels: Vec<Channel> = cs
            .iter()
            .enumerate()
            .map(|(k, &c)| {
                let r = raws.iter().find(|r| r.h.c == c);
                let color = r.and_then(|r| tag(&r.tags, T_CHANNEL_COLOR)).and_then(Val::as_i64).and_then(colorref);
                let name = match r.and_then(|r| tag(&r.tags, T_CHANNEL_NAME)) {
                    Some(Val::Str(s)) => s.clone(),
                    _ => format!("C{c}"),
                };
                let color = match (cs.len(), color) {
                    (1, None) => [255, 255, 255],
                    (_, Some(col)) => col,
                    (_, None) => DEFAULT_COLORS[k % DEFAULT_COLORS.len()],
                };
                Channel { c, color, name }
            })
            .collect();

        // mosaic layout: tiles of the nominal plane / first channel
        let mut tile_ids: Vec<i32> = raws.iter().map(|r| r.h.tile).collect();
        tile_ids.sort();
        tile_ids.dedup();
        let stage: Vec<(i32, u32, u32, Option<(f64, f64)>)> = tile_ids
            .iter()
            .map(|&t| {
                let r = raws.iter().find(|r| r.h.tile == t).unwrap();
                let sx = tag(&r.tags, T_STAGE_X).and_then(Val::as_f64);
                let sy = tag(&r.tags, T_STAGE_Y).and_then(Val::as_f64);
                (t, r.h.width, r.h.height, sx.zip(sy))
            })
            .collect();
        let tiles = layout_tiles(&stage, mpp)?;
        let width = tiles.iter().zip(&stage).map(|(p, s)| p.x as u64 + s.1 as u64).max().unwrap_or(1);
        let height = tiles.iter().zip(&stage).map(|(p, s)| p.y as u64 + s.2 as u64).max().unwrap_or(1);
        if width * height > MAX_PIXELS || width > u32::MAX as u64 || height > u32::MAX as u64 {
            return Err(format!("{path}: image too large ({width} × {height})"));
        }

        let items: HashMap<(usize, i32, i32), Item> = raws
            .into_iter()
            .filter(|r| cs.contains(&r.h.c))
            .map(|r| ((zpos(r.h.z), r.h.c, r.h.tile), Item { path: r.path, h: r.h }))
            .collect();

        let mut info = SourceInfo::basic("zvi", width as i64, height as i64);
        info.vendor = Some("zeiss".into());
        if let Some((x, y)) = mpp {
            info.mpp_x = x;
            info.mpp_y = y;
            info.calibrated = true;
        }
        info.z_planes = z_planes;
        let lsizes = super::pyramid::level_sizes(width as u32, height as u32);
        info.levels = lsizes
            .iter()
            .enumerate()
            .filter(|(k, l)| *k == 0 || l.0.max(l.1) >= TILE_SIZE)
            .map(|(k, l)| LevelInfo { width: l.0 as i64, height: l.1 as i64, downsample: (1u64 << k) as f64 })
            .collect();
        info.associated = vec!["thumbnail".into()];
        Ok(ZviSource {
            path: path.to_string(),
            info,
            file: Mutex::new(cf),
            items,
            channels,
            tiles,
            pixels,
            zs,
            plane_pos,
            nominal,
            luts: OnceLock::new(),
            planes: Mutex::new(PlaneCache::default()),
            build: Mutex::new(()),
        })
    }

    /// Channel names and colours (for the smoke run / logs).
    pub fn channel_summary(&self) -> Vec<(String, [u8; 3])> {
        self.channels.iter().map(|c| (c.name.clone(), c.color)).collect()
    }

    /// Number of distinct Z planes.
    pub fn z_count(&self) -> usize {
        self.zs.len()
    }

    /// A plane's samples as u16 (grey: 1 per px; colour: R, G, B per px).
    fn read_item(&self, it: &Item) -> Result<Vec<u16>, String> {
        let h = &it.h;
        let n = h.width as usize * h.height as usize;
        let bytes = {
            let mut cf = self.file.lock().unwrap();
            let mut s = cf.open_stream(&it.path).map_err(|e| format!("{}: {e}", it.path.display()))?;
            s.seek(SeekFrom::Start(h.data_offset as u64)).map_err(|e| e.to_string())?;
            let mut v = Vec::new();
            match h.compression {
                Compression::None => {
                    v.resize(n * h.pixels.bytes(), 0);
                    s.read_exact(&mut v).map_err(|e| format!("{}: {e}", it.path.display()))?;
                }
                _ => {
                    s.read_to_end(&mut v).map_err(|e| e.to_string())?;
                }
            }
            v
        };
        if h.compression == Compression::Jpeg {
            let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).map_err(|e| format!("ZVI JPEG plane: {e}"))?;
            if img.width() != h.width || img.height() != h.height {
                return Err("ZVI JPEG plane has the wrong size".into());
            }
            return Ok(if h.pixels.is_color() {
                img.to_rgb8().into_raw().into_iter().map(u16::from).collect()
            } else {
                img.to_luma8().into_raw().into_iter().map(u16::from).collect()
            });
        }
        Ok(decode_raw(&bytes, h.pixels, n))
    }

    /// The stretch of each channel, from the nominal plane (sampling at most 16 tiles).
    fn luts(&self) -> Result<&Vec<Vec<u8>>, String> {
        if let Some(l) = self.luts.get() {
            return Ok(l);
        }
        let is16 = self.pixels.is16();
        let n = if is16 { 65536 } else { 256 };
        let identity = !is16 && (self.pixels.is_color() || self.channels.len() == 1);
        let mut out = Vec::new();
        for ch in &self.channels {
            if identity {
                out.push((0..256).map(|v| v as u8).collect());
                continue;
            }
            let mut hist = vec![0u64; n];
            let step = self.tiles.len().div_ceil(16).max(1);
            for tp in self.tiles.iter().step_by(step) {
                let Some(it) = self.items.get(&(self.nominal, ch.c, tp.tile)) else { continue };
                let s = self.read_item(it)?;
                let stride = (s.len() / 2_000_000).max(1);
                for &v in s.iter().step_by(stride) {
                    hist[(v as usize).min(n - 1)] += 1;
                }
            }
            let (mut lo, hi) = percentile_range(&hist, STRETCH_LO, STRETCH_HI);
            // fluorescence: the dark background is black, not dim grey/green
            if let Some(bg) = background_peak(&hist, lo, hi) {
                lo = lo.max(bg).min(hi - 1);
            }
            out.push(stretch_lut(lo, hi, n));
        }
        let _ = self.luts.set(out);
        Ok(self.luts.get().unwrap())
    }

    /// One mosaic tile of z position `zp`, composited to RGB8 (w × h).
    fn render_tile(&self, zp: usize, tp: &TilePos) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
        let luts = self.luts()?;
        let mut acc: Option<(u32, u32, Vec<u32>)> = None;
        for (ch, lut) in self.channels.iter().zip(luts) {
            let Some(it) = self.items.get(&(zp, ch.c, tp.tile)) else { continue };
            let s = self.read_item(it)?;
            let (w, h) = (it.h.width, it.h.height);
            let a = acc.get_or_insert_with(|| (w, h, vec![0u32; w as usize * h as usize * 3]));
            if (a.0, a.1) != (w, h) {
                continue;
            }
            if self.pixels.is_color() {
                for (o, &v) in a.2.iter_mut().zip(&s) {
                    *o = lut[v as usize] as u32 * 255;
                }
            } else {
                let col = ch.color.map(|c| c as u32);
                for (o, &v) in a.2.chunks_exact_mut(3).zip(&s) {
                    let l = lut[v as usize] as u32;
                    o[0] += l * col[0];
                    o[1] += l * col[1];
                    o[2] += l * col[2];
                }
            }
        }
        Ok(acc.map(|(w, h, a)| (w, h, a.into_iter().map(|v| (v / 255).min(255) as u8).collect())))
    }

    /// Build (or fetch) the pyramid of z position `zp`.
    fn plane(&self, zp: usize) -> Result<Arc<Pyramid>, String> {
        if let Some(p) = self.cached_plane(zp) {
            return Ok(p);
        }
        let _g = self.build.lock().unwrap();
        if let Some(p) = self.cached_plane(zp) {
            return Ok(p);
        }
        let (w, h) = (self.info.width as u32, self.info.height as u32);
        let big = w as u64 * h as u64 > MEM_PIXELS;
        let bg = if self.pixels.is_color() { 255 } else { 0 };
        let pyr = if big {
            let root = cache_dir("zvi");
            let dir = root.join(cache_key(&self.path)).join(format!("z{zp}"));
            if let Some(p) = open_cached(&dir, w, h) {
                p
            } else {
                prune(&root, &self.path);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(dir.join("complete"));
                let mut c = Canvas::disk(&dir.join("L0.rgb"), w, h)?;
                if bg != 0 {
                    let row = vec![bg; w as usize * 3];
                    for y in 0..h {
                        c.write_rect(0, y, w, 1, &row)?;
                    }
                }
                self.paint(zp, &mut c)?;
                let p = Pyramid::on_disk(c, &dir, MEM_PIXELS / 4)?;
                std::fs::write(dir.join("complete"), format!("{w} {h}")).map_err(|e| e.to_string())?;
                p
            }
        } else {
            let mut c = Canvas::Mem(RgbImage::from_pixel(w, h, image::Rgb([bg, bg, bg])));
            self.paint(zp, &mut c)?;
            let Canvas::Mem(img) = c else { unreachable!() };
            Pyramid::in_memory(img)?
        };
        let pyr = Arc::new(pyr);
        let bytes = if big { (MEM_PIXELS / 4) * 4 } else { w as u64 * h as u64 * 4 };
        let mut pc = self.planes.lock().unwrap();
        pc.clock += 1;
        let now = pc.clock;
        pc.map.insert(zp, (pyr.clone(), bytes, now));
        while pc.map.len() > 1 && pc.map.values().map(|v| v.1).sum::<u64>() > MEM_PLANE_BUDGET {
            let oldest = *pc.map.iter().min_by_key(|(_, v)| v.2).unwrap().0;
            pc.map.remove(&oldest);
        }
        Ok(pyr)
    }

    fn cached_plane(&self, zp: usize) -> Option<Arc<Pyramid>> {
        let mut pc = self.planes.lock().unwrap();
        pc.clock += 1;
        let now = pc.clock;
        pc.map.get_mut(&zp).map(|e| {
            e.2 = now;
            e.0.clone()
        })
    }

    fn paint(&self, zp: usize, c: &mut Canvas) -> Result<(), String> {
        for tp in &self.tiles {
            if let Some((tw, th, rgb)) = self.render_tile(zp, tp)? {
                c.write_rect(tp.x, tp.y, tw, th, &rgb)?;
            }
        }
        Ok(())
    }

    fn zpos(&self, z: u32) -> usize {
        self.plane_pos.get(z as usize).copied().unwrap_or(self.nominal)
    }

    fn fitted(&self, max_px: u32, z: u32) -> Result<RgbImage, String> {
        let pyr = self.plane(self.zpos(z))?;
        let k = pyr.level_at_least(max_px);
        let (w, h) = pyr.levels[k].size();
        let img = pyr.crop(k, 0, 0, w, h)?;
        let (ow, oh) = fit(self.info.width, self.info.height, max_px);
        Ok(if (ow, oh) != (w, h) { image::imageops::resize(&img, ow, oh, FilterType::Triangle) } else { img })
    }
}

impl SlideSource for ZviSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (_, _, _, _, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        let native = (dz_max_level(self.info.width, self.info.height) - level) as usize;
        self.plane(self.zpos(z))?.crop(native, x * TILE_SIZE, y * TILE_SIZE, tw, th)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        match name {
            "thumbnail" => self.fitted(512, 0),
            _ => Err(format!("no associated image named {name:?}")),
        }
    }

    fn overview(&self, max_px: u32, z: u32) -> Result<RgbImage, String> {
        self.fitted(max_px, z)
    }
}

/// Raw little-endian samples → u16 per sample, colour as R, G, B (alpha dropped).
pub fn decode_raw(b: &[u8], px: Pixels, n: usize) -> Vec<u16> {
    let le16 = |c: &[u8]| u16::from_le_bytes([c[0], c[1]]);
    match px {
        Pixels::Gray8 => b.iter().take(n).map(|&v| v as u16).collect(),
        Pixels::Gray16 => b.chunks_exact(2).take(n).map(le16).collect(),
        Pixels::Bgr24 => b.chunks_exact(3).take(n).flat_map(|p| [p[2] as u16, p[1] as u16, p[0] as u16]).collect(),
        Pixels::Bgra32 => b.chunks_exact(4).take(n).flat_map(|p| [p[2] as u16, p[1] as u16, p[0] as u16]).collect(),
        Pixels::Bgr48 => b.chunks_exact(6).take(n).flat_map(|p| [le16(&p[4..6]), le16(&p[2..4]), le16(&p[0..2])]).collect(),
    }
}

/// Where each tile's top-left goes (level-0 px). `stage`: (tile id, w, h, stage x/y in µm).
/// One tile → (0, 0). Several → stage position / pixel size, shifted so the minimum is 0.
fn layout_tiles(stage: &[(i32, u32, u32, Option<(f64, f64)>)], mpp: Option<(f64, f64)>) -> Result<Vec<TilePos>, String> {
    if stage.len() <= 1 {
        return Ok(stage.iter().map(|s| TilePos { tile: s.0, x: 0, y: 0 }).collect());
    }
    let (Some((mx, my)), true) = (mpp, stage.iter().all(|s| s.3.is_some())) else {
        return Err("a ZVI mosaic without stage positions or pixel size".into());
    };
    let xs: Vec<f64> = stage.iter().map(|s| s.3.unwrap().0 / mx).collect();
    let ys: Vec<f64> = stage.iter().map(|s| s.3.unwrap().1 / my).collect();
    Ok(place(stage, &xs, &ys))
}

fn place(stage: &[(i32, u32, u32, Option<(f64, f64)>)], xs: &[f64], ys: &[f64]) -> Vec<TilePos> {
    let x0 = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let y0 = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    stage
        .iter()
        .zip(xs.iter().zip(ys))
        .map(|(s, (x, y))| TilePos { tile: s.0, x: (x - x0).round() as u32, y: (y - y0).round() as u32 })
        .collect()
}

fn read_stream(cf: &mut cfb::CompoundFile<File>, p: &Path, max: usize) -> Result<Vec<u8>, String> {
    let s = cf.open_stream(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let mut v = Vec::new();
    s.take(max as u64).read_to_end(&mut v).map_err(|e| e.to_string())?;
    Ok(v)
}

/// The disk-pyramid folder of a file: changes with the file and with `RENDER_VERSION`.
fn cache_key(path: &str) -> String {
    format!("{}-r{RENDER_VERSION}", file_key(path))
}

fn open_cached(dir: &Path, w: u32, h: u32) -> Option<Pyramid> {
    let meta = std::fs::read_to_string(dir.join("complete")).ok()?;
    if meta.trim() != format!("{w} {h}") {
        return None;
    }
    let l0 = Canvas::open_disk(&dir.join("L0.rgb"), w, h).ok()?;
    let _ = std::fs::write(dir.join("used"), b"");
    Pyramid::on_disk(l0, dir, MEM_PIXELS / 4).ok()
}

/// Keep the most recently used files' disk pyramids (never the one being opened).
fn prune(root: &Path, path: &str) {
    let keep = cache_key(path);
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir() && e.file_name().to_string_lossy() != keep)
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    if dirs.len() < KEEP_DISK {
        return;
    }
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in dirs.into_iter().skip(KEEP_DISK - 1) {
        let _ = std::fs::remove_dir_all(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vt_i4(v: i32) -> Vec<u8> {
        let mut b = 3u16.to_le_bytes().to_vec();
        b.extend_from_slice(&v.to_le_bytes());
        b
    }
    fn vt_r8(v: f64) -> Vec<u8> {
        let mut b = 5u16.to_le_bytes().to_vec();
        b.extend_from_slice(&v.to_le_bytes());
        b
    }
    fn vt_str(s: &str) -> Vec<u8> {
        let mut u: Vec<u8> = s.encode_utf16().chain([0]).flat_map(|c| c.to_le_bytes()).collect();
        let mut b = 8u16.to_le_bytes().to_vec();
        b.extend_from_slice(&(u.len() as u32).to_le_bytes());
        b.append(&mut u);
        b
    }
    fn vt_blob(payload: &[u8]) -> Vec<u8> {
        let mut b = 65u16.to_le_bytes().to_vec();
        b.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        b.extend_from_slice(payload);
        b
    }

    /// A tag stream as AxioVision writes it.
    pub fn tag_stream(tags: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut b = vt_i4(0x2000_1000);
        b.extend(vt_i4(tags.len() as i32));
        for (id, v) in tags {
            b.extend_from_slice(v);
            b.extend(vt_i4(*id as i32));
            b.extend(vt_i4(0x81));
        }
        b
    }

    /// An `Item(n)/Contents` stream (header + pixels) like the real files' layout.
    pub fn item_stream(z: i32, c: i32, tile: i32, w: u32, h: u32, bpp: u32, format: u32, pixels: &[u8]) -> Vec<u8> {
        let mut b = vt_i4(0x3000_1003);
        b.extend(vt_i4(0));
        b.extend([0, 0, 0, 0]); // two VT_EMPTY
        b.extend(vt_i4(w as i32));
        b.extend(vt_i4(h as i32));
        b.extend(vt_i4(1));
        b.extend(vt_i4(format as i32));
        b.extend(vt_i4(0));
        b.extend(vt_i4(16));
        b.extend(vt_blob(&[0; 16]));
        let mut idx = vec![0u8; 128];
        for (k, v) in [(8, z), (12, c), (16, 0), (24, tile)] {
            idx[k..k + 4].copy_from_slice(&v.to_le_bytes());
        }
        b.extend(vt_blob(&idx));
        b.extend(9u16.to_le_bytes());
        b.extend([0; 16]);
        b.extend(vt_str("Tags"));
        for _ in 0..3 {
            b.extend(9u16.to_le_bytes());
            b.extend([0; 16]);
        }
        for v in [0x1000_2000u32, w, h, 1, bpp, format, if bpp == 1 || bpp == 3 { 8 } else { 16 }] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b.extend_from_slice(pixels);
        b
    }

    #[test]
    fn variants() {
        assert_eq!(read_variant(&vt_i4(-5), 0), Some((Val::Int(-5), 6)));
        assert_eq!(read_variant(&vt_r8(0.0645), 0), Some((Val::Real(0.0645), 10)));
        assert_eq!(read_variant(&vt_str("Cy3"), 0).unwrap().0, Val::Str("Cy3".into()));
        assert_eq!(read_variant(&[0, 0], 0), Some((Val::Empty, 2)));
        assert_eq!(read_variant(&vt_blob(&[1, 2, 3]), 0), Some((Val::Blob(6, 3), 9)));
        assert_eq!(read_variant(&[3, 0, 1], 0), None, "truncated");
        assert_eq!(read_variant(&[0xFF, 0x7F], 0), None, "unknown type");
    }

    #[test]
    fn tags_parse() {
        let s = tag_stream(&[(515, vt_i4(1480)), (769, vt_r8(0.0645)), (770, vt_i4(76)), (1284, vt_str("FITC")), (1281, vec![0, 0])]);
        let t = parse_tags(&s);
        assert_eq!(t.len(), 5);
        assert_eq!(tag(&t, 515), Some(&Val::Int(1480)));
        assert_eq!(tag(&t, 769).and_then(Val::as_f64), Some(0.0645));
        assert_eq!(tag(&t, 1284), Some(&Val::Str("FITC".into())));
        assert_eq!(tag(&t, 1281), Some(&Val::Empty));
        // a truncated stream keeps what it read
        assert_eq!(parse_tags(&s[..s.len() - 3]).len(), 4);
        assert!(parse_tags(&[1, 2]).is_empty());
    }

    #[test]
    fn item_header_parse() {
        let px: Vec<u8> = (0..6 * 4 * 2).map(|i| i as u8).collect();
        let s = item_stream(3, 1, 7, 6, 4, 2, 4, &px);
        let h = parse_item_header(&s).unwrap();
        assert_eq!((h.z, h.c, h.t, h.tile), (3, 1, 0, 7));
        assert_eq!((h.width, h.height, h.pixels, h.valid_bits), (6, 4, Pixels::Gray16, 16));
        assert_eq!(h.compression, Compression::None);
        assert_eq!(&s[h.data_offset..], &px[..]);
        // colour
        let h = parse_item_header(&item_stream(0, 0, 0, 2, 2, 3, 1, &[0; 12])).unwrap();
        assert_eq!(h.pixels, Pixels::Bgr24);
        // unknown format code falls back to bytes per pixel
        assert_eq!(Pixels::from_codes(99, 6), Some(Pixels::Bgr48));
        assert_eq!(Pixels::from_codes(4, 3), Some(Pixels::Bgr24));
        assert_eq!(Pixels::from_codes(0, 5), None);
        assert!(parse_item_header(&s[..40]).is_err());
    }

    #[test]
    fn raw_decoding() {
        assert_eq!(decode_raw(&[1, 2, 3, 4, 5, 6], Pixels::Bgr24, 2), vec![3, 2, 1, 6, 5, 4]);
        assert_eq!(decode_raw(&[1, 2, 3, 9], Pixels::Bgra32, 1), vec![3, 2, 1]);
        assert_eq!(decode_raw(&[0x34, 0x12], Pixels::Gray16, 1), vec![0x1234]);
        assert_eq!(decode_raw(&[1, 0, 2, 0, 3, 0], Pixels::Bgr48, 1), vec![3, 2, 1]);
    }

    #[test]
    fn display_maths() {
        // 1000 samples at 100, 10 outliers at 4000, 10 at 0
        let mut hist = vec![0u64; 4096];
        hist[0] = 10;
        hist[100] = 980;
        hist[200] = 10;
        hist[4000] = 1;
        let (lo, hi) = percentile_range(&hist, 0.001, 0.999);
        assert_eq!((lo, hi), (0, 200), "one outlier in 1001 does not set the white point");
        let flat = {
            let mut h = vec![0u64; 256];
            h[50] = 10;
            h
        };
        assert_eq!(percentile_range(&flat, 0.001, 0.999), (50, 51));
        // dark background peak at 100 → black point; a bright (brightfield) peak is left alone
        assert_eq!(background_peak(&hist, 0, 256), Some(100));
        let mut bright = vec![0u64; 256];
        bright[20] = 10;
        bright[240] = 50;
        assert_eq!(background_peak(&bright, 20, 241), None);
        let lut = stretch_lut(100, 200, 256);
        assert_eq!((lut[0], lut[100], lut[150], lut[200], lut[255]), (0, 0, 128, 255, 255));
        assert_eq!(colorref(255), Some([255, 0, 0]));
        assert_eq!(colorref(0xFF0000), Some([0, 0, 255]));
        assert_eq!(colorref(65280), Some([0, 255, 0]));
        assert_eq!(colorref(0), None);
        assert_eq!(scale_um(0.0645, Some(76)), 0.0645);
        assert!((scale_um(64.5, Some(77)) - 0.0645).abs() < 1e-12);
    }

    #[test]
    fn mosaic_layout() {
        let stage = vec![(0, 100, 50, Some((10.0, 20.0))), (1, 100, 50, Some((15.0, 20.0))), (2, 100, 50, Some((10.0, 22.5)))];
        let t = layout_tiles(&stage, Some((0.05, 0.05))).unwrap();
        assert_eq!(t.iter().map(|p| (p.tile, p.x, p.y)).collect::<Vec<_>>(), vec![(0, 0, 0), (1, 100, 0), (2, 0, 50)]);
        assert!(layout_tiles(&stage, None).is_err());
        assert_eq!(layout_tiles(&stage[..1], None).unwrap()[0].x, 0);
    }

    /// Write a tiny two-channel, two-plane ZVI and open it end to end.
    #[test]
    fn synthetic_file_opens() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("sv-zvi-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.zvi");
        let (w, h) = (40u32, 30u32);
        {
            let mut cf = cfb::create(&p).unwrap();
            cf.create_storage_all("/Image/Tags").unwrap();
            cf.create_stream("/Image/Tags/Contents")
                .unwrap()
                .write_all(&tag_stream(&[(769, vt_r8(0.25)), (770, vt_i4(76)), (772, vt_r8(0.25)), (773, vt_i4(76)), (775, vt_r8(0.5)), (776, vt_i4(76))]))
                .unwrap();
            let mut n = 0;
            for z in 0..2 {
                for c in 0..2 {
                    // channel 0 bright on the left half, channel 1 on the right; plane 1 dimmer
                    let px: Vec<u8> = (0..w * h)
                        .flat_map(|i| {
                            let x = i % w;
                            let on = (x < w / 2) == (c == 0);
                            let v: u16 = if on { 4000 / (z as u16 + 1) } else { 100 };
                            v.to_le_bytes()
                        })
                        .collect();
                    let base = format!("/Image/Item({n})");
                    cf.create_storage_all(&format!("{base}/Tags")).unwrap();
                    cf.create_stream(&format!("{base}/Contents")).unwrap().write_all(&item_stream(z, c, 0, w, h, 2, 4, &px)).unwrap();
                    let color = if c == 0 { 0xFF0000 } else { 0x00FF00 };
                    cf.create_stream(&format!("{base}/Tags/Contents"))
                        .unwrap()
                        .write_all(&tag_stream(&[(1282, vt_i4(color)), (1284, vt_str(if c == 0 { "DAPI" } else { "FITC" })), (2072, vt_r8(100.0 + z as f64 * 0.5))]))
                        .unwrap();
                    n += 1;
                }
            }
            cf.flush().unwrap();
        }
        let s = ZviSource::open(p.to_str().unwrap()).unwrap();
        let i = s.info();
        assert_eq!((i.width, i.height, i.calibrated, i.mpp_x), (40, 30, true, 0.25));
        assert_eq!(i.z_planes.len(), 2);
        assert_eq!(i.z_planes[0].index, 0, "the middle (first of two) plane is nominal");
        assert_eq!(i.z_planes[1].offset_nm, Some(500.0));
        assert_eq!(s.channel_summary(), vec![("DAPI".to_string(), [0, 0, 255]), ("FITC".to_string(), [0, 255, 0])]);
        let max = dz_max_level(40, 30);
        let t = s.tile(max, 0, 0, 0).unwrap();
        assert_eq!(t.dimensions(), (40, 30));
        assert_eq!(t.get_pixel(2, 2).0, [0, 0, 255], "DAPI half is blue");
        assert_eq!(t.get_pixel(38, 2).0, [0, 255, 0], "FITC half is green");
        let dim = s.tile(max, 0, 0, 1).unwrap();
        assert!(dim.get_pixel(2, 2).0[2] < 200, "plane 1 is dimmer with the same stretch");
        assert_eq!(s.overview(20, 0).unwrap().dimensions(), (20, 15));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sample(name: &str) -> Option<String> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats/Zeiss").join(name);
        p.exists().then(|| p.to_string_lossy().to_string())
    }

    /// Real files from the OpenSlide test data (see test-data/formats/Zeiss; not committed).
    #[test]
    #[ignore]
    fn real_zvi_samples() {
        for (name, w, h, planes) in [("Zeiss-1-Merged.zvi", 1480, 1132, 1), ("Zeiss-2-Merged.zvi", 1488, 1140, 1), ("Zeiss-1-Stacked.zvi", 1388, 1040, 13)] {
            let Some(p) = sample(name) else {
                eprintln!("skip {name}: not downloaded");
                continue;
            };
            let s = ZviSource::open(&p).unwrap();
            let i = s.info();
            assert_eq!((i.width, i.height, i.z_planes.len()), (w, h, planes), "{name}");
            assert!(i.calibrated && (i.mpp_x - 0.0645).abs() < 1e-9, "{name}");
            assert_eq!(s.channels.len(), 3, "{name}");
            let o = s.overview(1024, 0).unwrap();
            eprintln!("{name}: {:?} z {:?}", s.channel_summary(), i.z_planes.iter().map(|z| &z.label).collect::<Vec<_>>());
            // ZVI_PNG_DIR=/tmp/x saves the overviews (and the top and bottom planes) to look at
            if let Ok(d) = std::env::var("ZVI_PNG_DIR") {
                o.save(Path::new(&d).join(format!("{name}.png"))).unwrap();
                let ends = if planes > 1 { vec![&i.z_planes[0], &i.z_planes[planes - 1]] } else { vec![] };
                for z in ends {
                    s.overview(1024, z.index).unwrap().save(Path::new(&d).join(format!("{name}.z{}.png", z.index))).unwrap();
                }
            }
            // fluorescence: a mostly dark background with bright nuclei
            let mean: f64 = o.as_raw().iter().map(|&v| v as f64).sum::<f64>() / o.as_raw().len() as f64;
            assert!(mean > 5.0 && mean < 160.0, "{name}: mean {mean}");
        }
    }

    /// The 1.1 GB mosaic (9 × 14 tiles, 3 channels): stage positions → an 11382 × 13208 image
    /// built as a disk pyramid. `ZVI_PNG_DIR` also saves the overview and a full-resolution
    /// region across a tile corner.
    #[test]
    #[ignore]
    fn real_zvi_mosaic() {
        let Some(p) = sample("Zeiss-4-Mosaic.zvi") else {
            eprintln!("skip: not downloaded");
            return;
        };
        let t0 = std::time::Instant::now();
        let s = ZviSource::open(&p).unwrap();
        let i = s.info();
        eprintln!("open {:?}: {} × {}, {} tiles, {:?}", t0.elapsed(), i.width, i.height, s.tiles.len(), s.channel_summary());
        assert_eq!((i.width, i.height), (11382, 13208));
        assert_eq!(s.tiles.len(), 126);
        assert!((i.mpp_x - 0.3225).abs() < 1e-9);
        let o = s.overview(1024, 0).unwrap();
        eprintln!("first plane {:?}", t0.elapsed());
        // tile (5, 6) starts at about (6245, 5616), in tissue; this region straddles that corner
        let r = s.region(6045, 5416, 400, 400, 400, 400, 0).unwrap();
        if let Ok(d) = std::env::var("ZVI_PNG_DIR") {
            o.save(Path::new(&d).join("Zeiss-4-Mosaic.zvi.png")).unwrap();
            r.save(Path::new(&d).join("Zeiss-4-Mosaic.corner.png")).unwrap();
        }
        let t1 = std::time::Instant::now();
        drop(s);
        let again = ZviSource::open(&p).unwrap();
        assert_eq!(again.overview(1024, 0).unwrap(), o);
        eprintln!("reopen from the disk cache {:?}", t1.elapsed());
    }
}
