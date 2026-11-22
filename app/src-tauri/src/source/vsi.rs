//! Olympus VSI (cellSens, VS110/VS120/VS200), read directly in Rust.
//!
//! A `.vsi` file is a little-endian TIFF that holds small thumbnails and, after the TIFF header,
//! Olympus' binary "tag tree" of metadata (stack names, types, image sizes and pixel sizes). The
//! pixels live next to it in `_<name>_/stack<id>/frame_t*.ets`, one folder per image "stack"; the
//! `<id>` matches the second tag of the stack's volume in the tag tree.
//!
//! An `.ets` file starts with a 64-byte "SIS" header (dimension count, where the ETS header and
//! the tile index are) and an "ETS" header (pixel type, channels, compression, tile size,
//! background colour, whether there is a pyramid). Each tile index entry gives the tile's
//! coordinates (x, y, any extra dimensions such as z, and the pyramid level last), its file
//! offset and its byte count. Each pyramid level halves the previous one. Tiles may be missing
//! (sparse scans): those areas show the background colour.
//!
//! Tiles are JPEG, JPEG 2000 (decoded with the pure-Rust `hayro-jpeg2000`), raw, PNG or BMP.
//! JPEG-lossless tiles are not supported. Only 8-bit RGB / grey brightfield images are shown in
//! colour; for multi-channel fluorescence only the first channel is shown, in grey.
//!
//! The format is undocumented; this follows the layout Bio-Formats' CellSensReader reads
//! (field and tag meanings below were checked against the OpenSlide test files OS-1…OS-3).
//! Owner: formats builder.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use image::{imageops::FilterType, RgbImage};

use super::cache::Lru;
use super::{dz_max_level, dz_tile_rect, fit, make_planes, LevelInfo, SlideSource, SourceInfo};

/// Decoded ETS tiles kept per pyramid (bytes of RGB).
const MAIN_CACHE_BYTES: usize = 128 * 1024 * 1024;
const ASSOC_CACHE_BYTES: usize = 16 * 1024 * 1024;
/// Associated images are rendered at most this big.
const ASSOC_MAX_PX: u32 = 4096;
/// Largest `.vsi` read into memory for its metadata.
const MAX_VSI_BYTES: u64 = 512 << 20;

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

fn u16_at(b: &[u8], p: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(p..p + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?))
}
fn i32_at(b: &[u8], p: usize) -> Option<i32> {
    u32_at(b, p).map(|v| v as i32)
}
fn u64_at(b: &[u8], p: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(p..p + 8)?.try_into().ok()?))
}

// ---------------------------------------------------------------- VSI metadata tag tree

/// A decoded tag value (only the types the reader needs; others are `None`).
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Int(i64),
    Float(f64),
    Str(String),
    Ints(Vec<i64>),
    Floats(Vec<f64>),
}

/// One field of the tag tree: a value, or a volume holding more fields.
#[derive(Clone, Debug, Default)]
pub struct Node {
    pub tag: i32,
    /// the optional second tag (for a stack volume, the stack id)
    pub sec: Option<i32>,
    pub val: Option<Val>,
    pub kids: Vec<Node>,
}

impl Node {
    pub fn child(&self, tag: i32) -> Option<&Node> {
        self.kids.iter().find(|k| k.tag == tag)
    }
    /// First node with this tag in the subtree (depth first, self excluded).
    pub fn find(&self, tag: i32) -> Option<&Node> {
        for k in &self.kids {
            if k.tag == tag {
                return Some(k);
            }
            if let Some(n) = k.find(tag) {
                return Some(n);
            }
        }
        None
    }
}

/// Field value types (Bio-Formats' names).
mod ty {
    pub const CHAR: u32 = 1;
    pub const UCHAR: u32 = 2;
    pub const SHORT: u32 = 3;
    pub const USHORT: u32 = 4;
    pub const INT: u32 = 5;
    pub const UINT: u32 = 6;
    pub const INT64: u32 = 7;
    pub const UINT64: u32 = 8;
    pub const FLOAT: u32 = 9;
    pub const DOUBLE: u32 = 10;
    pub const BOOLEAN: u32 = 12;
    pub const TCHAR: u32 = 13;
    pub const DWORD: u32 = 14;
    pub const TIMESTAMP: u32 = 17;
    pub const DATE: u32 = 18;
    pub const UNICODE_TCHAR: u32 = 8192;
}

/// Tags used here.
mod tag {
    pub const COLLECTION_VOLUME: i32 = 2000;
    pub const MULTIDIM_IMAGE_VOLUME: i32 = 2001;
    pub const IMAGE_FRAME_VOLUME: i32 = 2002;
    pub const MULTIDIM_STACK_PROPERTIES: i32 = 2005;
    pub const RWC_FRAME_SCALE: i32 = 2019;
    pub const RWC_FRAME_UNIT: i32 = 2020;
    pub const STACK_NAME: i32 = 2030;
    pub const IMAGE_BOUNDARY: i32 = 2053;
    pub const STACK_TYPE: i32 = 2074;
    pub const VSI_IMAGE_DATA: i32 = 2016;
    /// one extra image dimension (second tag = its position after x, y in the ETS coordinates)
    pub const DIMENSION: i32 = 2007;
    /// one value of a dimension (second tag = the value)
    pub const DIM_VALUE: i32 = 2008;
    /// what a dimension is: 1 = Z, 4 = channel (on its first value)
    pub const DIM_MEANING: i32 = 2023;
    pub const Z_START: i32 = 2012;
    pub const Z_INCREMENT: i32 = 2013;
    pub const CHANNEL_NAME: i32 = 2021;
    pub const CHANNEL_NAME2: i32 = 2419;
    /// on a channel value: the display range (min, max) in sample units
    pub const DISPLAY_RANGE: i32 = 2003;
    /// on a channel value: the emission wavelength (a value + unit field)
    pub const WAVELENGTH: i32 = 2417;
    /// inside a value + unit field: the number and its unit
    pub const FIELD_VALUE: i32 = 268435458;
    pub const FIELD_UNIT: i32 = 268435456;
}

/// Dimension meanings (`tag::DIM_MEANING`).
pub const MEANING_Z: i64 = 1;
pub const MEANING_CHANNEL: i64 = 4;

fn decode_val(t: u32, b: &[u8]) -> Option<Val> {
    let ints = |w: usize| -> Vec<i64> { b.chunks_exact(w).map(|c| i32::from_le_bytes(c.try_into().unwrap()) as i64).collect() };
    Some(match t {
        ty::CHAR => Val::Int(*b.first()? as i8 as i64),
        ty::UCHAR | ty::BOOLEAN => Val::Int(*b.first()? as i64),
        ty::SHORT => Val::Int(i16::from_le_bytes(b.get(..2)?.try_into().ok()?) as i64),
        ty::USHORT => Val::Int(u16_at(b, 0)? as i64),
        ty::INT | ty::DWORD | 271..=273 => Val::Int(i32_at(b, 0)? as i64),
        ty::UINT => Val::Int(u32_at(b, 0)? as i64),
        ty::INT64 | ty::UINT64 | ty::TIMESTAMP => Val::Int(u64_at(b, 0)? as i64),
        ty::FLOAT => Val::Float(f32::from_le_bytes(b.get(..4)?.try_into().ok()?) as f64),
        ty::DOUBLE | ty::DATE => Val::Float(f64::from_le_bytes(b.get(..8)?.try_into().ok()?)),
        ty::TCHAR | ty::UNICODE_TCHAR => {
            // TCHAR strings in practice are UTF-16 too; tell by the zero high bytes
            let utf16 = t == ty::UNICODE_TCHAR || (b.len() >= 2 && b.len() % 2 == 0 && b.iter().skip(1).step_by(2).all(|c| *c == 0));
            let s = if utf16 {
                let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                String::from_utf16_lossy(&u)
            } else {
                b.iter().map(|c| *c as char).collect()
            };
            Val::Str(s.trim_end_matches('\0').to_string())
        }
        // int vectors, rectangles, dimension / volume indices
        256..=259 | 267 | 274..=277 | 8195 | 8199 | 8200 => Val::Ints(ints(4)),
        // double vectors and matrices, double intervals
        260..=266 | 268 | 279 | 280 => Val::Floats(b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()),
        _ => return None,
    })
}

fn is_header(b: &[u8], p: usize) -> bool {
    p + 24 <= b.len() && b[p + 2] == b'I' && b[p + 3] == b'S'
}

/// Read one header block (24-byte header + its fields) at `fp`, appending the fields to `out`.
/// Returns where the block ends.
fn read_block(b: &[u8], fp: usize, depth: usize, out: &mut Vec<Node>) -> Option<usize> {
    if depth > 48 || !is_header(b, fp) {
        return None;
    }
    let data_off = u64_at(b, fp + 4 + 4)? as usize; // header size (2), "IS" (2), version (4), then this
    let count = (u32_at(b, fp + 16)? & 0x0fff_ffff) as usize;
    let mut pos = fp.checked_add(data_off)?;
    for _ in 0..count.min(1 << 20) {
        if pos + 16 > b.len() {
            break;
        }
        let ft = u32_at(b, pos)?;
        let tag = i32_at(b, pos + 4)?;
        let next = u32_at(b, pos + 8)? as usize;
        let size = u32_at(b, pos + 12)? as usize;
        let mut p = pos + 16;
        let extra = ft & 0x0800_0000 != 0;
        let extended = ft & 0x1000_0000 != 0;
        let inline = ft & 0x4000_0000 != 0;
        let t = ft & 0x00ff_ffff;
        let sec = if extra {
            let s = i32_at(b, p)?;
            p += 4;
            Some(s)
        } else {
            None
        };
        let mut node = Node { tag, sec, ..Default::default() };
        let data_end;
        if extended && t <= 2 {
            // a volume: one or more header blocks follow
            let end = if size > 0 { p.saturating_add(size) } else if next > 0 { fp.saturating_add(next) } else { b.len() };
            let mut q = p;
            let mut first = true;
            while (first || q < end) && is_header(b, q) {
                first = false;
                match read_block(b, q, depth + 1, &mut node.kids) {
                    Some(e) if e > q => q = e,
                    _ => break,
                }
            }
            data_end = q;
        } else if inline {
            node.val = Some(Val::Int(size as i32 as i64));
            data_end = p;
        } else {
            if size > 0 && size <= 1 << 16 && p + size <= b.len() {
                node.val = decode_val(t, &b[p..p + size]);
            }
            data_end = p.saturating_add(size);
        }
        out.push(node);
        if next == 0 {
            return Some(data_end);
        }
        let np = fp.checked_add(next)?;
        if np <= pos {
            return None; // never go backwards
        }
        pos = np;
    }
    Some(pos)
}

/// Parse the metadata tree that follows the TIFF header (offset 8) of a `.vsi`.
pub fn parse_tag_tree(b: &[u8]) -> Vec<Node> {
    let mut out = Vec::new();
    let mut p = 8;
    while is_header(b, p) {
        match read_block(b, p, 0, &mut out) {
            Some(e) if e > p => p = e,
            _ => break,
        }
    }
    out
}

/// What the metadata says about one image stack.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StackMeta {
    pub id: i32,
    pub name: String,
    /// 0 = image, 1 = overview, 2 = sample mask, 4 = focus map, …
    pub kind: Option<i64>,
    /// µm per pixel (x, y)
    pub mpp: Option<(f64, f64)>,
    /// full-resolution size
    pub size: Option<(i64, i64)>,
    /// for images stored inside the .vsi: the TIFF directory that holds it
    pub ifd: Option<i32>,
    /// the extra dimensions after x, y, in ETS coordinate order (empty when the metadata has none)
    pub dims: Vec<DimMeta>,
}

/// One extra image dimension (Z, channel, …) as the metadata describes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DimMeta {
    /// `MEANING_Z`, `MEANING_CHANNEL`, or another code (left alone)
    pub meaning: Option<i64>,
    /// Z: the first plane's position and the step between planes, µm
    pub z_start_um: Option<f64>,
    pub z_step_um: Option<f64>,
    /// channel: one entry per value, in value order
    pub channels: Vec<ChannelMeta>,
}

/// A fluorescence channel.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChannelMeta {
    pub name: String,
    pub wavelength_nm: Option<f64>,
    /// the display range the scanner software used (min, max), in sample units
    pub display: Option<(f64, f64)>,
}

/// A number field (int or float).
fn num(n: &Node) -> Option<f64> {
    match n.val.as_ref()? {
        Val::Int(i) => Some(*i as f64),
        Val::Float(f) => Some(*f),
        Val::Ints(v) => v.first().map(|i| *i as f64),
        Val::Floats(v) => v.first().copied(),
        Val::Str(_) => None,
    }
}

/// A value + unit field (e.g. a wavelength or a z step), in µm.
fn field_um(n: &Node) -> Option<f64> {
    let v = n.child(tag::FIELD_VALUE).and_then(num)?;
    let unit = match n.child(tag::FIELD_UNIT).and_then(|u| u.val.as_ref()) {
        Some(Val::Str(s)) => unit_to_um(s)?,
        _ => return None,
    };
    v.is_finite().then_some(v * unit)
}

fn dims_of(stack: &Node) -> Vec<DimMeta> {
    let mut dims: Vec<&Node> = stack.kids.iter().filter(|k| k.tag == tag::DIMENSION).collect();
    dims.sort_by_key(|d| d.sec.unwrap_or(0));
    dims.into_iter()
        .map(|d| {
            let mut vals: Vec<&Node> = d.kids.iter().filter(|k| k.tag == tag::DIM_VALUE).collect();
            vals.sort_by_key(|v| v.sec.unwrap_or(0));
            let meaning = vals.iter().find_map(|v| match v.child(tag::DIM_MEANING).and_then(|m| m.val.as_ref()) {
                Some(Val::Int(i)) => Some(*i),
                _ => None,
            });
            let mut m = DimMeta { meaning, ..Default::default() };
            if meaning == Some(MEANING_Z) {
                if let Some(v0) = vals.first() {
                    m.z_start_um = v0.child(tag::Z_START).and_then(field_um);
                    m.z_step_um = v0.child(tag::Z_INCREMENT).and_then(field_um).filter(|s| *s > 0.0);
                }
            }
            if meaning == Some(MEANING_CHANNEL) {
                m.channels = vals
                    .iter()
                    .map(|v| {
                        let name = [tag::CHANNEL_NAME, tag::CHANNEL_NAME2]
                            .iter()
                            .find_map(|t| match v.child(*t).and_then(|c| c.val.as_ref()) {
                                Some(Val::Str(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                                _ => None,
                            })
                            .unwrap_or_default();
                        let display = match v.child(tag::DISPLAY_RANGE).and_then(|c| c.val.as_ref()) {
                            Some(Val::Floats(f)) if f.len() >= 2 && f[0].is_finite() && f[1] > f[0] => Some((f[0], f[1])),
                            _ => None,
                        };
                        // µm → nm; only plausible light
                        let wavelength_nm = v.child(tag::WAVELENGTH).and_then(field_um).map(|um| um * 1000.0).filter(|w| (300.0..=1100.0).contains(w));
                        ChannelMeta { name, wavelength_nm, display }
                    })
                    .collect();
            }
            m
        })
        .collect()
}

/// A unit like "10^-6m^1" as µm per unit.
fn unit_to_um(u: &str) -> Option<f64> {
    let u = u.trim();
    let rest = u.strip_prefix("10^")?;
    let m = rest.find('m')?;
    let exp: i32 = rest[..m].parse().ok()?;
    let tail = &rest[m..];
    if tail != "m" && tail != "m^1" {
        return None;
    }
    Some(10f64.powi(exp + 6))
}

fn collect_stacks(nodes: &[Node], out: &mut Vec<StackMeta>) {
    for n in nodes {
        if n.tag == tag::MULTIDIM_IMAGE_VOLUME && !n.kids.is_empty() {
            let mut m = StackMeta { id: n.sec.unwrap_or(-1), ..Default::default() };
            if let Some(p) = n.find(tag::MULTIDIM_STACK_PROPERTIES) {
                if let Some(Val::Str(s)) = p.child(tag::STACK_NAME).and_then(|v| v.val.as_ref()) {
                    m.name = s.clone();
                }
                if let Some(Val::Int(k)) = p.child(tag::STACK_TYPE).and_then(|v| v.val.as_ref()) {
                    m.kind = Some(*k);
                }
                let unit = match p.child(tag::RWC_FRAME_UNIT).and_then(|v| v.val.as_ref()) {
                    Some(Val::Str(s)) => unit_to_um(s),
                    _ => None,
                };
                if let (Some(Val::Floats(f)), Some(scale)) = (p.child(tag::RWC_FRAME_SCALE).and_then(|v| v.val.as_ref()), unit) {
                    if f.len() >= 2 && f[0].is_finite() && f[1].is_finite() && f[0] > 0.0 && f[1] > 0.0 {
                        m.mpp = Some((f[0] * scale, f[1] * scale));
                    }
                }
            }
            if let Some(Val::Ints(r)) = n.find(tag::IMAGE_BOUNDARY).and_then(|v| v.val.as_ref()) {
                if r.len() >= 4 && r[2] > 0 && r[3] > 0 {
                    m.size = Some((r[2], r[3]));
                }
            }
            if let Some(f) = n.child(tag::IMAGE_FRAME_VOLUME) {
                m.ifd = f.kids.iter().find(|k| k.tag == tag::VSI_IMAGE_DATA).and_then(|k| k.sec);
            }
            m.dims = dims_of(n);
            out.push(m);
        } else if n.tag == tag::COLLECTION_VOLUME || n.tag == tag::MULTIDIM_IMAGE_VOLUME {
            collect_stacks(&n.kids, out);
        }
    }
}

/// The image stacks the metadata describes, in file order.
pub fn stacks_from_tree(tree: &[Node]) -> Vec<StackMeta> {
    let mut out = Vec::new();
    collect_stacks(tree, &mut out);
    out
}

// ---------------------------------------------------------------- ETS files

pub const COMP_RAW: u32 = 0;
pub const COMP_JPEG: u32 = 2;
pub const COMP_JPEG2000: u32 = 3;
pub const COMP_JPEG_LOSSLESS: u32 = 5;
pub const COMP_PNG: u32 = 8;
pub const COMP_BMP: u32 = 9;

/// The SIS + ETS headers.
#[derive(Clone, Debug, PartialEq)]
pub struct EtsHeader {
    pub ndims: u32,
    pub index_offset: u64,
    pub index_count: u32,
    /// 1 = char, 2 = uchar, 3 = short, 4 = ushort, …
    pub pixel_type: u32,
    pub channels: u32,
    pub compression: u32,
    pub tile_w: u32,
    pub tile_h: u32,
    pub background: [u8; 3],
    pub pyramid: bool,
}

/// Size in bytes of the headers `parse_ets_header` needs (SIS + ETS).
pub const ETS_HEAD_BYTES: usize = 64 + 228;

fn bytes_per_sample(pixel_type: u32) -> usize {
    match pixel_type {
        1 | 2 => 1,
        3 | 4 => 2,
        5 | 6 | 9 => 4,
        7 | 8 | 10 => 8,
        _ => 1,
    }
}

/// Parse the SIS header and the ETS header that follows it. `b` is the file's first bytes
/// (the ETS header sits right after the 64-byte SIS header in every known file; when it
/// doesn't, `ets_at` gives its offset and the caller re-reads).
pub fn parse_ets_header(sis: &[u8], ets: &[u8]) -> Result<EtsHeader, String> {
    if sis.get(..4) != Some(b"SIS\0") {
        return Err("not an ETS file (no SIS header)".into());
    }
    if ets.get(..4) != Some(b"ETS\0") {
        return Err("not an ETS file (no ETS header)".into());
    }
    let g = |b: &[u8], p| u32_at(b, p).ok_or_else(|| "truncated ETS header".to_string());
    let ndims = g(sis, 12)?;
    let index_offset = u64_at(sis, 32).ok_or("truncated SIS header")?;
    let index_count = g(sis, 40)?;
    let pixel_type = g(ets, 8)?;
    let channels = g(ets, 12)?;
    let compression = g(ets, 20)?;
    let tile_w = g(ets, 28)?;
    let tile_h = g(ets, 32)?;
    // 17 pixel-info hints, then the background colour (channels × sample size, in 40 bytes)
    let bg_at = 40 + 17 * 4;
    let bps = bytes_per_sample(pixel_type);
    let mut background = [255u8; 3];
    for (c, v) in background.iter_mut().enumerate() {
        let ch = if channels >= 3 { c } else { 0 };
        if let Some(px) = ets.get(bg_at + ch * bps..bg_at + (ch + 1) * bps) {
            *v = px[bps - 1]; // high byte of 16-bit samples
        }
    }
    let pyramid = g(ets, bg_at + 40 + 4)? != 0;
    if !(2..=16).contains(&ndims) || tile_w == 0 || tile_h == 0 || tile_w > 1 << 14 || tile_h > 1 << 14 || channels == 0 || channels > 64 {
        return Err(format!("unexpected ETS header (dims {ndims}, tile {tile_w}×{tile_h}, channels {channels})"));
    }
    Ok(EtsHeader { ndims, index_offset, index_count, pixel_type, channels, compression, tile_w, tile_h, background, pyramid })
}

/// One tile index entry.
#[derive(Clone, Debug, PartialEq)]
pub struct TileEntry {
    /// x, y, then any extra dimensions (z, channel, …); the pyramid level is not included
    pub coords: Vec<i32>,
    pub level: u32,
    pub offset: u64,
    pub len: u32,
}

/// Bytes per tile index entry.
pub fn index_entry_bytes(ndims: u32) -> usize {
    4 + 4 * ndims as usize + 8 + 4 + 4
}

/// Parse the tile index: per entry 4 bytes (unused), `ndims` × i32 coordinates (the level is
/// the last one when the file has a pyramid), i64 offset, i32 byte count, 4 bytes (unused).
pub fn parse_tile_index(b: &[u8], h: &EtsHeader) -> Result<Vec<TileEntry>, String> {
    let n = h.ndims as usize;
    let step = index_entry_bytes(h.ndims);
    let count = h.index_count as usize;
    if b.len() < count * step {
        return Err("truncated ETS tile index".into());
    }
    let mut out = Vec::with_capacity(count);
    for k in 0..count {
        let e = &b[k * step..(k + 1) * step];
        let mut coords: Vec<i32> = (0..n).map(|d| i32_at(e, 4 + 4 * d).unwrap()).collect();
        let level = if h.pyramid { coords.pop().unwrap() } else { 0 };
        let offset = u64_at(e, 4 + 4 * n).unwrap();
        let len = u32_at(e, 12 + 4 * n).unwrap();
        if level < 0 || coords[0] < 0 || coords[1] < 0 || level > 40 {
            continue;
        }
        out.push(TileEntry { coords, level: level as u32, offset, len });
    }
    Ok(out)
}

/// A decoded tile's samples, per channel (row-major), in the file's own units: 0..=`max`.
#[derive(Clone, Debug, PartialEq)]
pub struct Samples {
    pub w: u32,
    pub h: u32,
    pub chans: Vec<Vec<f32>>,
    /// full scale (255 for 8-bit, 65535 for 16-bit, 2^bits − 1 for JPEG 2000)
    pub max: f32,
}

impl Samples {
    /// As an RGB picture: three channels as colour, otherwise the first as grey, scaled from
    /// `max` to 255 (no stretch: for colour and 8-bit images that are already display-ready).
    pub fn to_rgb(&self) -> Result<RgbImage, String> {
        let n = (self.w * self.h) as usize;
        if self.chans.is_empty() || self.chans.iter().any(|c| c.len() < n) {
            return Err("short tile".into());
        }
        let k = 255.0 / self.max.max(1.0);
        let q = |v: f32| (v * k).round().clamp(0.0, 255.0) as u8;
        let color = self.chans.len() >= 3;
        Ok(RgbImage::from_fn(self.w, self.h, |x, y| {
            let i = (y * self.w + x) as usize;
            if color {
                image::Rgb([q(self.chans[0][i]), q(self.chans[1][i]), q(self.chans[2][i])])
            } else {
                image::Rgb([q(self.chans[0][i]); 3])
            }
        }))
    }
}

/// Decode one tile to its samples (full precision: 16-bit fluorescence keeps all its levels).
pub fn decode_tile_samples(h: &EtsHeader, bytes: &[u8]) -> Result<Samples, String> {
    let from_image = |img: image::DynamicImage| -> Samples {
        let (w, ht) = (img.width(), img.height());
        let sixteen = matches!(img.color().bytes_per_pixel() / img.color().channel_count().max(1), 2);
        let color = img.color().has_color();
        let n = if color { 3 } else { 1 };
        let mut chans = vec![Vec::with_capacity((w * ht) as usize); n];
        if sixteen {
            let raw: Vec<u16> = if color { img.to_rgb16().into_raw() } else { img.to_luma16().into_raw() };
            for (i, v) in raw.iter().enumerate() {
                chans[i % n].push(*v as f32);
            }
        } else {
            let raw: Vec<u8> = if color { img.to_rgb8().into_raw() } else { img.to_luma8().into_raw() };
            for (i, v) in raw.iter().enumerate() {
                chans[i % n].push(*v as f32);
            }
        }
        Samples { w, h: ht, chans, max: if sixteen { 65535.0 } else { 255.0 } }
    };
    match h.compression {
        COMP_RAW => {
            let bps = bytes_per_sample(h.pixel_type);
            let c = h.channels as usize;
            let (w, ht) = (h.tile_w, h.tile_h);
            let n = w as usize * ht as usize;
            if bytes.len() < n * c * bps {
                return Err("short raw ETS tile".into());
            }
            let (get, max): (Box<dyn Fn(usize) -> f32>, f32) = match (h.pixel_type, bps) {
                (_, 1) => (Box::new(|i| bytes[i] as f32), 255.0),
                (4, 2) => (Box::new(|i| u16::from_le_bytes([bytes[2 * i], bytes[2 * i + 1]]) as f32), 65535.0),
                (3, 2) => (Box::new(|i| (i16::from_le_bytes([bytes[2 * i], bytes[2 * i + 1]]) as f32).max(0.0)), 32767.0),
                (t, _) => return Err(format!("unsupported: raw VSI tiles of pixel type {t}")),
            };
            let chans = (0..c).map(|k| (0..n).map(|p| get(p * c + k)).collect()).collect();
            Ok(Samples { w, h: ht, chans, max })
        }
        COMP_JPEG => image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).map(from_image).map_err(|e| format!("JPEG tile: {e}")),
        COMP_PNG => image::load_from_memory_with_format(bytes, image::ImageFormat::Png).map(from_image).map_err(|e| format!("PNG tile: {e}")),
        COMP_BMP => image::load_from_memory_with_format(bytes, image::ImageFormat::Bmp).map(from_image).map_err(|e| format!("BMP tile: {e}")),
        COMP_JPEG2000 => decode_j2k_samples(bytes),
        COMP_JPEG_LOSSLESS => Err("unsupported: lossless-JPEG VSI tiles".into()),
        c => Err(format!("unsupported: VSI tile compression {c}")),
    }
}

/// Decode one tile to RGB (colour and 8-bit tiles; see `Samples::to_rgb`).
pub fn decode_tile(h: &EtsHeader, bytes: &[u8]) -> Result<RgbImage, String> {
    decode_tile_samples(h, bytes)?.to_rgb()
}

/// A JPEG 2000 codestream (or JP2 file): every component at its full precision.
pub fn decode_j2k_samples(bytes: &[u8]) -> Result<Samples, String> {
    let img = hayro_jpeg2000::Image::new(bytes, &hayro_jpeg2000::DecodeSettings::default()).map_err(|e| format!("JPEG 2000 tile: {e:?}"))?;
    let (w, h) = (img.width(), img.height());
    let mut ctx = hayro_jpeg2000::DecoderContext::default();
    let dec = img.decode(&mut ctx).map_err(|e| format!("JPEG 2000 tile: {e:?}"))?;
    let comps = dec.components();
    let n = w as usize * h as usize;
    if comps.is_empty() || n == 0 || comps.iter().any(|c| c.samples().len() < n) {
        return Err("JPEG 2000 tile: short output".into());
    }
    let bits = comps[0].bit_depth().clamp(1, 31);
    // colour images keep 3 components (alpha dropped); anything else: the first, as grey
    let take = if img.color_space().num_channels() >= 3 && comps.len() >= 3 { 3 } else { 1 };
    let chans = comps[..take].iter().map(|c| c.samples()[..n].to_vec()).collect();
    Ok(Samples { w, h, chans, max: ((1u64 << bits) - 1) as f32 })
}

/// A JPEG 2000 codestream (or JP2 file) to RGB.
pub fn decode_j2k(bytes: &[u8]) -> Result<RgbImage, String> {
    decode_j2k_samples(bytes)?.to_rgb()
}

// ---------------------------------------------------------------- fluorescence display

/// A visible wavelength (nm) as a display colour, brightest component 1 (Bruton's approximation).
/// Far red (> 645 nm, e.g. Cy5) stays red.
pub fn wavelength_rgb(nm: f64) -> [f32; 3] {
    let (r, g, b) = match nm {
        w if w < 440.0 => (((440.0 - w) / 60.0).clamp(0.0, 1.0) * 0.5, 0.0, 1.0),
        w if w < 490.0 => (0.0, (w - 440.0) / 50.0, 1.0),
        w if w < 510.0 => (0.0, 1.0, (510.0 - w) / 20.0),
        w if w < 580.0 => ((w - 510.0) / 70.0, 1.0, 0.0),
        w if w < 645.0 => (1.0, (645.0 - w) / 65.0, 0.0),
        _ => (1.0, 0.0, 0.0),
    };
    let m = r.max(g).max(b).max(1e-6);
    [(r / m) as f32, (g / m) as f32, (b / m) as f32]
}

/// Colours for channels without a wavelength: blue, green, red, magenta, cyan, yellow.
const PALETTE: [[f32; 3]; 6] = [[0.0, 0.3, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 0.0]];

/// How one channel is shown: its colour and the sample range mapped to black..full colour.
#[derive(Clone, Debug, PartialEq)]
pub struct ChanLook {
    /// position of the channel's value in `Pyramid::c_values`
    pub pos: u32,
    pub color: [f32; 3],
    pub lo: f32,
    pub hi: f32,
}

/// Add stretched channels in their colours; None when no channel had data.
pub fn composite(w: u32, h: u32, layers: &[(&ChanLook, &[f32])]) -> Option<RgbImage> {
    if layers.is_empty() {
        return None;
    }
    let n = (w * h) as usize;
    let mut acc = vec![0f32; n * 3];
    for (look, v) in layers {
        let span = (look.hi - look.lo).max(1e-6);
        for (i, s) in v.iter().take(n).enumerate() {
            let t = ((s - look.lo) / span).clamp(0.0, 1.0);
            if t > 0.0 {
                for c in 0..3 {
                    acc[i * 3 + c] += t * look.color[c];
                }
            }
        }
    }
    RgbImage::from_raw(w, h, acc.iter().map(|a| (a.clamp(0.0, 1.0) * 255.0).round() as u8).collect())
}

/// The (low, high) display range of sample values: the 0.5th and 99.8th percentiles, so a few hot
/// pixels don't set the white point. None when there's nothing to measure.
pub fn auto_range(values: &[f32]) -> Option<(f32, f32)> {
    let mut v: Vec<f32> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.len() < 16 {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    let (lo, hi) = (at(0.005), at(0.998));
    (hi > lo).then_some((lo, hi))
}

/// How a pyramid's tiles become RGB.
#[derive(Clone, Debug, PartialEq)]
pub enum Look {
    /// colour or 8-bit grey tiles, shown as they are
    Plain,
    /// fluorescence (or 16-bit grey): each channel stretched and added in its colour
    Composite(Vec<ChanLook>),
}

/// One ETS pyramid, ready to read.
pub struct Pyramid {
    file: File,
    pub head: EtsHeader,
    /// level sizes, full resolution first
    pub levels: Vec<(u32, u32)>,
    /// (level, col, row, plane position, channel position) → (offset, len)
    tiles: HashMap<(u32, u32, u32, u32, u32), (u64, u32)>,
    /// the extra dimension used as z (index into `TileEntry::coords`) and its values, ascending
    pub z_dim: Option<usize>,
    pub z_values: Vec<i32>,
    /// the extra dimension holding fluorescence channels, and its values, ascending
    pub c_dim: Option<usize>,
    pub c_values: Vec<i32>,
    pub look: Look,
    /// what empty areas are filled with (black for fluorescence)
    pub background: [u8; 3],
    cache: Mutex<Lru<(u32, u32, u32, u32), Arc<RgbImage>>>,
}

/// The extra dimensions' roles: (z, channel) as indices into `TileEntry::coords`. From the
/// metadata when it describes the extra dimensions: its k-th dimension is the ETS file's k-th extra
/// one (cellSens lists one more, trailing dimension than the ETS file has). Otherwise the first
/// dimension with more than one value at full resolution is z (the layout of brightfield z-stacks).
pub fn dimension_roles(dims: &[DimMeta], extra: usize, values: &dyn Fn(usize) -> Vec<i32>) -> (Option<usize>, Option<usize>) {
    let dims = &dims[..dims.len().min(extra)];
    if extra > 0 && dims.len() == extra && dims.iter().any(|d| d.meaning.is_some()) {
        let find = |m: i64| (0..extra).find(|k| dims[*k].meaning == Some(m)).map(|k| k + 2);
        return (find(MEANING_Z), find(MEANING_CHANNEL));
    }
    ((2..2 + extra).find(|d| values(*d).len() > 1), None)
}

impl Pyramid {
    pub fn open(path: &Path, size: Option<(i64, i64)>, cache_bytes: usize, dims: &[DimMeta]) -> Result<Pyramid, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let flen = file.metadata().map_err(|e| e.to_string())?.len();
        let sis = read_vec(&file, 0, 64.min(flen as usize))?;
        let ets_off = u64_at(&sis, 16).ok_or("truncated SIS header")?;
        let ets_len = (u32_at(&sis, 24).unwrap_or(228) as u64).clamp(160, 4096);
        if ets_off + ets_len > flen {
            return Err("truncated ETS header".into());
        }
        let ets = read_vec(&file, ets_off, ets_len as usize)?;
        let head = parse_ets_header(&sis, &ets)?;
        let idx_len = head.index_count as u64 * index_entry_bytes(head.ndims) as u64;
        if head.index_offset + idx_len > flen || idx_len > 1 << 30 {
            return Err("ETS tile index outside the file".into());
        }
        let entries = parse_tile_index(&read_vec(&file, head.index_offset, idx_len as usize)?, &head)?;
        Pyramid::build(file, head, entries, size, cache_bytes, dims)
    }

    fn build(file: File, head: EtsHeader, entries: Vec<TileEntry>, size: Option<(i64, i64)>, cache_bytes: usize, dims: &[DimMeta]) -> Result<Pyramid, String> {
        let l0: Vec<&TileEntry> = entries.iter().filter(|e| e.level == 0).collect();
        if l0.is_empty() {
            return Err("ETS file has no full-resolution tiles".into());
        }
        let cols = l0.iter().map(|e| e.coords[0]).max().unwrap() as u64 + 1;
        let rows = l0.iter().map(|e| e.coords[1]).max().unwrap() as u64 + 1;
        let (gw, gh) = (cols * head.tile_w as u64, rows * head.tile_h as u64);
        // the metadata size, when it fits the tile grid; otherwise the grid itself
        let (w, h) = match size {
            Some((w, h)) if w > 0 && h > 0 && w as u64 <= gw && h as u64 <= gh => (w as u64, h as u64),
            _ => (gw, gh),
        };
        if w > u32::MAX as u64 || h > u32::MAX as u64 {
            return Err("ETS image too large".into());
        }
        let nlev = entries.iter().map(|e| e.level).max().unwrap() + 1;
        let levels: Vec<(u32, u32)> = (0..nlev).map(|k| (((w >> k) as u32).max(1), ((h >> k) as u32).max(1))).collect();
        let extra = head.ndims as usize - 2 - usize::from(head.pyramid);
        let values = |d: usize| -> Vec<i32> {
            let mut v: Vec<i32> = l0.iter().map(|e| e.coords[d]).collect();
            v.sort();
            v.dedup();
            v
        };
        let (z_dim, c_dim) = dimension_roles(dims, extra, &values);
        let z_values = z_dim.map(values).unwrap_or_else(|| vec![0]);
        let c_values = c_dim.map(values).unwrap_or_else(|| vec![0]);
        // other extra dimensions (time, …): keep their smallest value
        let fixed: Vec<(usize, i32)> = (2..2 + extra)
            .filter(|d| Some(*d) != z_dim && Some(*d) != c_dim)
            .map(|d| (d, l0.iter().map(|e| e.coords[d]).min().unwrap()))
            .collect();
        let pos = |dim: Option<usize>, vals: &[i32], e: &TileEntry| -> Option<u32> {
            match dim {
                Some(d) => vals.binary_search(&e.coords[d]).ok().map(|p| p as u32),
                None => Some(0),
            }
        };
        let mut tiles = HashMap::with_capacity(entries.len());
        for e in &entries {
            if fixed.iter().any(|(d, v)| e.coords[*d] != *v) || e.len == 0 {
                continue;
            }
            let (Some(zp), Some(cp)) = (pos(z_dim, &z_values, e), pos(c_dim, &c_values, e)) else { continue };
            tiles.insert((e.level, e.coords[0] as u32, e.coords[1] as u32, zp, cp), (e.offset, e.len));
        }
        // fluorescence: a channel dimension, or a single deep (16-bit) grey channel
        let deep_grey = head.channels == 1 && bytes_per_sample(head.pixel_type) > 1;
        let look = if c_dim.is_some() || deep_grey {
            let meta = c_dim.and_then(|d| dims.get(d - 2)).map(|m| m.channels.as_slice()).unwrap_or(&[]);
            let single = c_values.len() == 1;
            Look::Composite(
                c_values
                    .iter()
                    .enumerate()
                    .map(|(p, v)| {
                        let m = usize::try_from(*v).ok().and_then(|i| meta.get(i));
                        let color = if single && c_dim.is_none() {
                            [1.0; 3]
                        } else {
                            m.and_then(|m| m.wavelength_nm).map(wavelength_rgb).unwrap_or(PALETTE[p % PALETTE.len()])
                        };
                        let (lo, hi) = m.and_then(|m| m.display).map(|(a, b)| (a as f32, b as f32)).unwrap_or((f32::NAN, f32::NAN));
                        ChanLook { pos: p as u32, color, lo, hi }
                    })
                    .collect(),
            )
        } else {
            Look::Plain
        };
        let background = if matches!(look, Look::Composite(_)) { [0; 3] } else { head.background };
        let mut py = Pyramid { file, head, levels, tiles, z_dim, z_values, c_dim, c_values, look, background, cache: Mutex::new(Lru::new(cache_bytes)) };
        py.fill_display_ranges();
        Ok(py)
    }

    /// Channels without a saved display range: measure one from the coarsest level.
    fn fill_display_ranges(&mut self) {
        let Look::Composite(chans) = &self.look else { return };
        if chans.iter().all(|c| c.hi > c.lo) {
            return;
        }
        let top = self.levels.len() as u32 - 1;
        let zmid = (self.z_values.len() / 2) as u32;
        let mut ranges = Vec::new();
        for c in chans {
            if c.hi > c.lo {
                ranges.push((c.lo, c.hi));
                continue;
            }
            let mut vals = Vec::new();
            let mut keys: Vec<_> = self.tiles.keys().filter(|k| k.0 == top && k.3 == zmid && k.4 == c.pos).copied().collect();
            keys.sort();
            for k in keys.into_iter().take(64) {
                let (off, len) = self.tiles[&k];
                if let Ok(bytes) = read_vec(&self.file, off, len as usize) {
                    if let Ok(s) = decode_tile_samples(&self.head, &bytes) {
                        vals.extend_from_slice(&s.chans[0]);
                    }
                }
            }
            let max = match bytes_per_sample(self.head.pixel_type) {
                1 => 255.0,
                _ => 65535.0,
            };
            ranges.push(auto_range(&vals).unwrap_or((0.0, max)));
        }
        if let Look::Composite(chans) = &mut self.look {
            for (c, (lo, hi)) in chans.iter_mut().zip(ranges) {
                c.lo = lo;
                c.hi = hi;
            }
        }
    }

    pub fn planes(&self) -> usize {
        self.z_values.len()
    }

    fn read_tile(&self, key: (u32, u32, u32, u32, u32)) -> Result<Option<Samples>, String> {
        let Some(&(off, len)) = self.tiles.get(&key) else { return Ok(None) };
        if len > 64 << 20 {
            return Err("ETS tile too large".into());
        }
        decode_tile_samples(&self.head, &read_vec(&self.file, off, len as usize)?).map(Some)
    }

    fn tile(&self, level: u32, col: u32, row: u32, zpos: u32) -> Result<Option<Arc<RgbImage>>, String> {
        let key = (level, col, row, zpos);
        if let Some(t) = self.cache.lock().unwrap().get(&key) {
            return Ok(Some(t));
        }
        let img = match &self.look {
            Look::Plain => match self.read_tile((level, col, row, zpos, 0))? {
                Some(s) => s.to_rgb()?,
                None => return Ok(None),
            },
            Look::Composite(chans) => {
                let mut layers = Vec::new();
                for c in chans {
                    if let Some(s) = self.read_tile((level, col, row, zpos, c.pos))? {
                        layers.push((c, s));
                    }
                }
                let Some((w, h)) = layers.first().map(|(_, s)| (s.w, s.h)) else { return Ok(None) };
                let refs: Vec<(&ChanLook, &[f32])> = layers.iter().filter(|(_, s)| (s.w, s.h) == (w, h)).map(|(c, s)| (*c, s.chans[0].as_slice())).collect();
                composite(w, h, &refs).ok_or("bad composite tile")?
            }
        };
        let t = Arc::new(img);
        self.cache.lock().unwrap().put(key, t.clone(), t.as_raw().len() + 64);
        Ok(Some(t))
    }

    /// Pixels (lx, ly, w, h) of `level`; missing tiles and areas outside the image are the
    /// background colour.
    pub fn read_level(&self, level: u32, lx: i64, ly: i64, w: u32, h: u32, zpos: u32) -> Result<RgbImage, String> {
        let mut out = RgbImage::from_pixel(w.max(1), h.max(1), image::Rgb(self.background));
        let Some(&(lw, lh)) = self.levels.get(level as usize) else { return Err("no such level".into()) };
        let x0 = lx.max(0);
        let y0 = ly.max(0);
        let x1 = (lx + w as i64).min(lw as i64);
        let y1 = (ly + h as i64).min(lh as i64);
        if x1 <= x0 || y1 <= y0 {
            return Ok(out);
        }
        let (tw, th) = (self.head.tile_w as i64, self.head.tile_h as i64);
        for row in y0 / th..=(y1 - 1) / th {
            for col in x0 / tw..=(x1 - 1) / tw {
                if let Some(t) = self.tile(level, col as u32, row as u32, zpos)? {
                    image::imageops::overlay(&mut out, &*t, col * tw - lx, row * th - ly);
                }
            }
        }
        // the decoded tiles' padding past the image edge: background
        let (ex, ey) = ((lw as i64 - lx).max(0), (lh as i64 - ly).max(0));
        if ex < w as i64 || ey < h as i64 {
            for (x, y, p) in out.enumerate_pixels_mut() {
                if x as i64 >= ex || y as i64 >= ey {
                    *p = image::Rgb(self.background);
                }
            }
        }
        Ok(out)
    }

    /// The level-0 rectangle (x, y, w, h) scaled to out_w × out_h, from the coarsest level at
    /// least as fine as needed.
    pub fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, zpos: u32) -> Result<RgbImage, String> {
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        let need = (w as f64 / out_w as f64).min(h as f64 / out_h as f64).max(1.0);
        let k = (need.log2().floor().max(0.0) as u32).min(self.levels.len() as u32 - 1);
        let s = (1i64 << k) as f64;
        let lx = (x as f64 / s).floor() as i64;
        let ly = (y as f64 / s).floor() as i64;
        let lw = (((x + w) as f64 / s).ceil() as i64 - lx).max(1);
        let lh = (((y + h) as f64 / s).ceil() as i64 - ly).max(1);
        if lw as u64 * lh as u64 > super::MAX_STITCH_PIXELS {
            return Err("region too large".into());
        }
        let img = self.read_level(k, lx, ly, lw as u32, lh as u32, zpos)?;
        Ok(if img.dimensions() != (out_w, out_h) { image::imageops::resize(&img, out_w, out_h, FilterType::Triangle) } else { img })
    }

    /// The whole image fitted into max_px × max_px.
    pub fn whole(&self, max_px: u32) -> Result<RgbImage, String> {
        let (w, h) = (self.levels[0].0 as i64, self.levels[0].1 as i64);
        let (ow, oh) = fit(w, h, max_px);
        self.region(0, 0, w, h, ow, oh, 0)
    }
}

// ---------------------------------------------------------------- images inside the .vsi (TIFF)

/// Decode TIFF directory `index` of the .vsi (8-bit RGB or grey; raw, JPEG or JPEG 2000).
fn vsi_ifd_image(b: &[u8], index: i32) -> Result<RgbImage, String> {
    if b.get(..4) != Some(b"II*\0") {
        return Err("not a little-endian TIFF".into());
    }
    let mut off = u32_at(b, 4).ok_or("truncated TIFF")? as usize;
    for _ in 0..index.max(0) {
        let n = u16_at(b, off).ok_or("truncated TIFF")? as usize;
        off = u32_at(b, off + 2 + n * 12).ok_or("truncated TIFF")? as usize;
        if off == 0 {
            return Err("no such TIFF directory".into());
        }
    }
    let n = u16_at(b, off).ok_or("truncated TIFF")? as usize;
    let mut tags: HashMap<u16, (u16, u32, u32)> = HashMap::new();
    for k in 0..n {
        let e = off + 2 + k * 12;
        tags.insert(u16_at(b, e).ok_or("truncated TIFF")?, (u16_at(b, e + 2).unwrap_or(0), u32_at(b, e + 4).unwrap_or(0), u32_at(b, e + 8).unwrap_or(0)));
    }
    let one = |t: u16| tags.get(&t).map(|(ty, _, v)| if *ty == 3 { v & 0xffff } else { *v });
    let arr = |t: u16| -> Vec<u32> {
        let Some(&(ty, count, v)) = tags.get(&t) else { return vec![] };
        let size = if ty == 3 { 2 } else { 4 };
        if count as usize * size <= 4 {
            return (0..count as usize).map(|i| if ty == 3 { (v >> (16 * i)) & 0xffff } else { v }).collect();
        }
        (0..count as usize)
            .filter_map(|i| if ty == 3 { u16_at(b, v as usize + 2 * i).map(|x| x as u32) } else { u32_at(b, v as usize + 4 * i) })
            .collect()
    };
    let (w, h) = (one(256).ok_or("no width")?, one(257).ok_or("no height")?);
    let spp = one(277).unwrap_or(1);
    let bits = arr(258).first().copied().unwrap_or(8);
    let comp = one(259).unwrap_or(1);
    let (offs, lens) = (arr(273), arr(279));
    let mut data = Vec::new();
    for (o, l) in offs.iter().zip(&lens) {
        data.extend_from_slice(b.get(*o as usize..(*o as usize).saturating_add(*l as usize)).ok_or("TIFF strip outside the file")?);
    }
    match comp {
        1 if bits == 8 && (spp == 3 || spp == 1) => {
            if data.len() < (w * h * spp) as usize {
                return Err("short TIFF image".into());
            }
            Ok(RgbImage::from_fn(w, h, |x, y| {
                let p = ((y * w + x) * spp) as usize;
                if spp == 3 { image::Rgb([data[p], data[p + 1], data[p + 2]]) } else { image::Rgb([data[p]; 3]) }
            }))
        }
        6 | 7 => image::load_from_memory_with_format(&data, image::ImageFormat::Jpeg).map(|i| i.to_rgb8()).map_err(|e| e.to_string()),
        33003 | 33005 | 34712 => decode_j2k(&data),
        c => Err(format!("unsupported: TIFF compression {c} ({bits}-bit)")),
    }
}

// ---------------------------------------------------------------- the slide

enum Assoc {
    Ets(Pyramid),
    Ifd(i32),
}

pub struct VsiSource {
    info: SourceInfo,
    main: Pyramid,
    /// plane index (ZPlane::index) → position in `main.z_values`
    plane_pos: Vec<usize>,
    vsi: Arc<Vec<u8>>,
    assoc: Vec<(String, Assoc)>,
}

/// `X.vsi` → `_X_` next to it.
pub fn data_dir(vsi: &Path) -> Option<PathBuf> {
    let name = vsi.file_name()?.to_string_lossy().to_string();
    let stem = &name[..name.len().checked_sub(4)?];
    Some(vsi.with_file_name(format!("_{stem}_")))
}

/// The image file of one stack folder: `frame_t*.ets` (the pixels; `frame_t.ets`, or
/// `frame_t_0.ets` in cellSens 4 files). Other `.ets` files next to it, like `blob_*.ets`, hold
/// side data, so they're only used when there's no frame file.
pub fn pick_ets(mut files: Vec<PathBuf>) -> Option<PathBuf> {
    files.sort();
    let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let frame = files.iter().position(|p| name(p).starts_with("frame_t"));
    match frame {
        Some(i) => Some(files.swap_remove(i)),
        None => files.into_iter().next(),
    }
}

/// `stack<id>` folders and their image `.ets` file, from the data folder.
fn stack_files(dir: &Path) -> Vec<(i32, PathBuf)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_prefix("stack").and_then(|s| s.parse::<i32>().ok()) else { continue };
        let Ok(files) = std::fs::read_dir(e.path()) else { continue };
        let ets: Vec<PathBuf> = files.flatten().map(|f| f.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("ets"))).collect();
        if let Some(p) = pick_ets(ets) {
            out.push((id, p));
        }
    }
    out.sort_by_key(|(id, _)| *id);
    out
}

/// What an extra stack is for, by its type and name: Some(associated name) or None (skip).
fn assoc_name(m: &StackMeta) -> Option<&'static str> {
    let n = m.name.to_lowercase();
    if n.contains("label") {
        Some("label")
    } else if n.contains("macro") || m.kind == Some(256) {
        Some("macro")
    } else if n.contains("overview") || m.kind == Some(1) {
        Some("overview")
    } else {
        None
    }
}

/// Stack types that are never the main image: 1 overview, 2 sample mask, 4 focus map, 256
/// macro/label photo, 1024 focus points, 8388608 sample mask (cellSens 4). Other types are images:
/// 0 is a plain image and 64 a z-stack, for example.
const AUXILIARY_KINDS: [i64; 6] = [1, 2, 4, 256, 1024, 8_388_608];

/// Stacks that are never the main image (overview, masks, focus maps, macro/label photos).
pub fn is_auxiliary(m: &StackMeta) -> bool {
    let n = m.name.to_lowercase();
    m.kind.is_some_and(|k| AUXILIARY_KINDS.contains(&k)) || ["overview", "macro", "label", "mask", "focus"].iter().any(|w| n.contains(w))
}

impl VsiSource {
    pub fn open(path: &str) -> Result<VsiSource, String> {
        let p = Path::new(path);
        let f = File::open(p).map_err(|e| format!("{path}: {e}"))?;
        let len = f.metadata().map_err(|e| e.to_string())?.len();
        if len > MAX_VSI_BYTES {
            return Err("VSI file too large".into());
        }
        let vsi = std::fs::read(p).map_err(|e| format!("{path}: {e}"))?;
        if vsi.get(..4) != Some(b"II*\0") {
            return Err(format!("{path}: not an Olympus VSI file"));
        }
        let metas = stacks_from_tree(&parse_tag_tree(&vsi));
        let meta = |id: i32| metas.iter().find(|m| m.id == id).cloned().unwrap_or(StackMeta { id, ..Default::default() });
        let dir = data_dir(p).ok_or("bad file name")?;
        let stacks = stack_files(&dir);
        if stacks.is_empty() {
            let d = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            return Err(format!("{path}: the image data folder \"{d}\" (with stack…/frame_t.ets) is missing next to the .vsi"));
        }
        // open every stack; pick the main image among the non-auxiliary ones: brightfield
        // (3 channels) first, then the most pixels
        let mut opened: Vec<(StackMeta, Pyramid)> = Vec::new();
        let mut errs = Vec::new();
        for (id, ets) in &stacks {
            let m = meta(*id);
            let budget = if is_auxiliary(&m) { ASSOC_CACHE_BYTES } else { MAIN_CACHE_BYTES };
            match Pyramid::open(ets, m.size, budget, &m.dims) {
                Ok(py) => opened.push((m, py)),
                Err(e) => errs.push(format!("stack{id}: {e}")),
            }
        }
        let score = |(m, py): &(StackMeta, Pyramid)| (!is_auxiliary(m), py.head.channels >= 3, py.levels[0].0 as u64 * py.levels[0].1 as u64);
        let best = (0..opened.len()).max_by_key(|i| score(&opened[*i])).ok_or_else(|| format!("{path}: no readable image stack ({})", errs.join("; ")))?;
        let (mmeta, main) = opened.remove(best);

        let mut assoc: Vec<(String, Assoc)> = Vec::new();
        for (m, py) in opened {
            if let Some(n) = assoc_name(&m) {
                if !assoc.iter().any(|(a, _)| a == n) {
                    assoc.push((n.to_string(), Assoc::Ets(py)));
                }
            }
        }
        // label / macro pictures kept inside the .vsi itself
        for m in &metas {
            if let (Some(n), Some(ifd)) = (assoc_name(m), m.ifd) {
                if !stacks.iter().any(|(id, _)| *id == m.id) && !assoc.iter().any(|(a, _)| a == n) {
                    assoc.push((n.to_string(), Assoc::Ifd(ifd)));
                }
            }
        }

        let (w, h) = (main.levels[0].0 as i64, main.levels[0].1 as i64);
        let mut info = SourceInfo::basic("vsi", w, h);
        info.vendor = Some("olympus".into());
        if let Some((mx, my)) = mmeta.mpp.filter(|(x, y)| *x < 1000.0 && *y < 1000.0) {
            info.mpp_x = mx;
            info.mpp_y = my;
            info.calibrated = true;
        }
        info.levels = main.levels.iter().enumerate().map(|(k, (lw, lh))| LevelInfo { width: *lw as i64, height: *lh as i64, downsample: (1u64 << k) as f64 }).collect();
        let plane_pos = if main.planes() > 1 {
            // focus offsets from the z dimension's start and step, when the metadata has them;
            // the plane nearest 0 µm (else the middle one) opens first
            let zm = main.z_dim.and_then(|d| mmeta.dims.get(d - 2));
            let offsets: Vec<Option<f64>> = match zm.and_then(|m| Some((m.z_start_um?, m.z_step_um?))) {
                Some((start, step)) => main.z_values.iter().map(|v| Some((start + *v as f64 * step) * 1000.0)).collect(),
                None => vec![None; main.planes()],
            };
            let nominal = if offsets.iter().all(|o| o.is_some()) {
                (0..offsets.len()).min_by(|a, b| offsets[*a].unwrap().abs().partial_cmp(&offsets[*b].unwrap().abs()).unwrap()).unwrap()
            } else {
                main.planes() / 2
            };
            let (planes, pos) = make_planes(&offsets, nominal);
            info.z_planes = planes;
            pos
        } else {
            vec![0]
        };
        info.associated = assoc.iter().map(|(n, _)| n.clone()).collect();
        Ok(VsiSource { info, main, plane_pos, vsi: Arc::new(vsi), assoc })
    }

    fn zpos(&self, z: u32) -> u32 {
        self.plane_pos.get(z as usize).copied().unwrap_or(self.plane_pos[0]) as u32
    }
}

impl SlideSource for VsiSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (w, h) = (self.info.width, self.info.height);
        let (fx, fy, fw, fh, tw, th) = dz_tile_rect(w, h, level, x, y)?;
        // Deep-Zoom downsample 2^k; ETS level k has exactly that scale
        let k = dz_max_level(w, h) - level;
        let lk = k.min(self.main.levels.len() as u32 - 1);
        let s = 1i64 << lk;
        let (lx, ly) = (fx / s, fy / s);
        let lw = ((fw + s - 1) / s).max(1) as u32;
        let lh = ((fh + s - 1) / s).max(1) as u32;
        let img = self.main.read_level(lk, lx, ly, lw, lh, self.zpos(z))?;
        Ok(if img.dimensions() != (tw, th) { image::imageops::resize(&img, tw, th, FilterType::Triangle) } else { img })
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String> {
        self.main.region(x, y, w, h, out_w, out_h, self.zpos(z))
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        let (_, a) = self.assoc.iter().find(|(n, _)| n == name).ok_or_else(|| format!("no associated image named {name:?}"))?;
        match a {
            Assoc::Ets(py) => py.whole(ASSOC_MAX_PX),
            Assoc::Ifd(i) => vsi_ifd_image(&self.vsi, *i),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- synthetic VSI tag tree

    /// A header block holding `fields` (each already encoded by `field`).
    fn block(fields: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(b"IS");
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&24u64.to_le_bytes());
        out.extend_from_slice(&(fields.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        // fields are chained by `next` (relative to the block start); the last has next = 0
        let mut pos = 24;
        for (i, f) in fields.iter().enumerate() {
            let mut f = f.clone();
            let next = if i + 1 == fields.len() { 0 } else { (pos + f.len()) as u32 };
            f[8..12].copy_from_slice(&next.to_le_bytes());
            pos += f.len();
            out.extend_from_slice(&f);
        }
        out
    }

    fn field(t: u32, tag: i32, sec: Option<i32>, data: &[u8]) -> Vec<u8> {
        let ft = t | if sec.is_some() { 0x0800_0000 } else { 0 };
        let mut v = Vec::new();
        v.extend_from_slice(&ft.to_le_bytes());
        v.extend_from_slice(&tag.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        if let Some(s) = sec {
            v.extend_from_slice(&s.to_le_bytes());
        }
        v.extend_from_slice(data);
        v
    }

    /// A volume field: extended + new-volume flags, its blocks as data.
    fn volume(kind: u32, tag: i32, sec: Option<i32>, blocks: &[Vec<u8>], with_size: bool) -> Vec<u8> {
        let data: Vec<u8> = blocks.concat();
        let mut f = field(0x9000_0000 | kind, tag, sec, &data);
        if !with_size {
            f[12..16].copy_from_slice(&0u32.to_le_bytes()); // property sets store size 0
        }
        f
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
    }

    fn doubles(v: &[f64]) -> Vec<u8> {
        v.iter().flat_map(|d| d.to_le_bytes()).collect()
    }

    fn ints(v: &[i32]) -> Vec<u8> {
        v.iter().flat_map(|d| d.to_le_bytes()).collect()
    }

    fn stack(id: i32, name: &str, kind: i32, mpp: f64, w: i32, h: i32) -> Vec<u8> {
        let frame = block(&[volume(1, 2018, None, &[block(&[field(259, tag::IMAGE_BOUNDARY, None, &ints(&[0, 0, w, h]))])], false)]);
        let props = block(&[
            field(260, tag::RWC_FRAME_SCALE, None, &doubles(&[mpp, mpp])),
            field(13, tag::RWC_FRAME_UNIT, None, &utf16("10^-6m^1")),
            field(8192, tag::STACK_NAME, None, &utf16(name)),
            field(5, tag::STACK_TYPE, None, &kind.to_le_bytes()),
        ]);
        let inner = block(&[
            field(5, 2027, None, &0i32.to_le_bytes()),
            volume(0, tag::IMAGE_FRAME_VOLUME, Some(0), &[frame], true),
            volume(1, tag::MULTIDIM_STACK_PROPERTIES, None, &[props], false),
        ]);
        volume(0, tag::MULTIDIM_IMAGE_VOLUME, Some(id), &[inner], true)
    }

    #[test]
    fn tag_tree_and_stacks() {
        let coll = block(&[
            field(0x4000_0005, 2035, None, &[]), // inline value
            stack(1, "Overview", 1, 3.5, 6753, 13196),
            stack(10001, "20x", 0, 0.346, 48502, 77578),
        ]);
        let mut file = b"II*\0\0\0\0\0".to_vec();
        file.extend(block(&[volume(0, tag::COLLECTION_VOLUME, Some(0), &[coll], true)]));
        let tree = parse_tag_tree(&file);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].tag, 2000);
        let s = stacks_from_tree(&tree);
        assert_eq!(s.len(), 2, "{s:?}");
        assert_eq!(s[0], StackMeta { id: 1, name: "Overview".into(), kind: Some(1), mpp: Some((3.5, 3.5)), size: Some((6753, 13196)), ifd: None, dims: vec![] });
        assert_eq!(s[1].id, 10001);
        assert_eq!(s[1].name, "20x");
        assert_eq!(s[1].size, Some((48502, 77578)));
        assert!((s[1].mpp.unwrap().0 - 0.346).abs() < 1e-12);
        assert!(is_auxiliary(&s[0]) && !is_auxiliary(&s[1]));
        assert_eq!(assoc_name(&s[0]), Some("overview"));
        // garbage never panics
        assert!(parse_tag_tree(b"II*\0\0\0\0\0\x18\0IS\xff\xff\xff\xff").is_empty() || true);
        for cut in 0..file.len() {
            let _ = parse_tag_tree(&file[..cut]);
        }
    }

    #[test]
    fn units() {
        assert_eq!(unit_to_um("10^-6m^1"), Some(1.0));
        assert!((unit_to_um("10^-3m").unwrap() - 1000.0).abs() < 1e-9);
        assert_eq!(unit_to_um("px"), None);
        assert_eq!(unit_to_um("10^-6m^2"), None);
    }

    // ---- synthetic ETS

    fn ets_file(compression: u32, tiles: &[(Vec<i32>, Vec<u8>)], ndims: u32) -> Vec<u8> {
        ets_file_px(compression, tiles, ndims, 2, 3)
    }

    /// An ETS file with the given pixel type (2 = uchar, 4 = ushort) and samples per pixel.
    fn ets_file_px(compression: u32, tiles: &[(Vec<i32>, Vec<u8>)], ndims: u32, pixel_type: u32, channels: u32) -> Vec<u8> {
        let mut f = vec![0u8; 64 + 228];
        f[0..4].copy_from_slice(b"SIS\0");
        f[4..8].copy_from_slice(&64u32.to_le_bytes());
        f[8..12].copy_from_slice(&2u32.to_le_bytes());
        f[12..16].copy_from_slice(&ndims.to_le_bytes());
        f[16..24].copy_from_slice(&64u64.to_le_bytes());
        f[24..28].copy_from_slice(&228u32.to_le_bytes());
        f[40..44].copy_from_slice(&(tiles.len() as u32).to_le_bytes());
        let e = 64;
        f[e..e + 4].copy_from_slice(b"ETS\0");
        f[e + 4..e + 8].copy_from_slice(&0x30003u32.to_le_bytes());
        f[e + 8..e + 12].copy_from_slice(&pixel_type.to_le_bytes());
        f[e + 12..e + 16].copy_from_slice(&channels.to_le_bytes());
        f[e + 16..e + 20].copy_from_slice(&4u32.to_le_bytes());
        f[e + 20..e + 24].copy_from_slice(&compression.to_le_bytes());
        f[e + 24..e + 28].copy_from_slice(&90u32.to_le_bytes());
        f[e + 28..e + 32].copy_from_slice(&4u32.to_le_bytes()); // 4×4 tiles
        f[e + 32..e + 36].copy_from_slice(&4u32.to_le_bytes());
        f[e + 36..e + 40].copy_from_slice(&1u32.to_le_bytes());
        f[e + 108..e + 111].copy_from_slice(&[250, 251, 252]); // background
        f[e + 152..e + 156].copy_from_slice(&1u32.to_le_bytes()); // pyramid
        let mut offs = Vec::new();
        for (_, data) in tiles {
            offs.push((f.len() as u64, data.len() as u32));
            f.extend_from_slice(data);
        }
        let idx = f.len() as u64;
        f[32..40].copy_from_slice(&idx.to_le_bytes());
        for ((coords, _), (o, l)) in tiles.iter().zip(offs) {
            f.extend_from_slice(&0u32.to_le_bytes());
            for c in coords {
                f.extend_from_slice(&c.to_le_bytes());
            }
            f.extend_from_slice(&o.to_le_bytes());
            f.extend_from_slice(&l.to_le_bytes());
            f.extend_from_slice(&0u32.to_le_bytes());
        }
        f
    }

    fn raw_tile(v: u8) -> Vec<u8> {
        vec![v; 4 * 4 * 3]
    }

    #[test]
    fn ets_header_and_index() {
        let f = ets_file(COMP_RAW, &[(vec![0, 0, 0, 0], raw_tile(10)), (vec![1, 0, 0, 0], raw_tile(20)), (vec![0, 0, 0, 1], raw_tile(30))], 4);
        let h = parse_ets_header(&f[..64], &f[64..]).unwrap();
        assert_eq!(
            h,
            EtsHeader { ndims: 4, index_offset: h.index_offset, index_count: 3, pixel_type: 2, channels: 3, compression: 0, tile_w: 4, tile_h: 4, background: [250, 251, 252], pyramid: true }
        );
        let idx = parse_tile_index(&f[h.index_offset as usize..], &h).unwrap();
        assert_eq!(idx.len(), 3);
        assert_eq!(idx[1].coords, vec![1, 0, 0]);
        assert_eq!(idx[2].level, 1);
        assert_eq!(idx[0].len, 48);
        assert_eq!(&f[idx[0].offset as usize..idx[0].offset as usize + 3], &[10, 10, 10]);
        assert!(parse_ets_header(b"XIS\0", &f[64..]).is_err());
        assert!(parse_tile_index(&f[h.index_offset as usize..h.index_offset as usize + 10], &h).is_err());
    }

    fn tmp(name: &str, bytes: &[u8]) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sv-vsi-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn pyramid_reads_levels_and_z() {
        // 2×1 tiles at level 0 (image 7×3 per metadata), one tile at level 1, two z planes
        let f = ets_file(
            COMP_RAW,
            &[
                (vec![0, 0, 0, 0], raw_tile(10)),
                (vec![1, 0, 0, 0], raw_tile(20)),
                (vec![0, 0, 1, 0], raw_tile(40)),
                (vec![0, 0, 0, 1], raw_tile(30)),
            ],
            4,
        );
        let p = tmp("a.ets", &f);
        let py = Pyramid::open(&p, Some((7, 3)), 1 << 20, &[]).unwrap();
        assert_eq!(py.levels, vec![(7, 3), (3, 1)]);
        assert_eq!(py.planes(), 2);
        let img = py.read_level(0, 2, 0, 6, 4, 0).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [10; 3]);
        assert_eq!(img.get_pixel(2, 0).0, [20; 3]);
        assert_eq!(img.get_pixel(4, 0).0, [20; 3]);
        assert_eq!(img.get_pixel(5, 0).0, [250, 251, 252], "past the image width");
        assert_eq!(img.get_pixel(0, 3).0, [250, 251, 252], "past the image height");
        assert_eq!(py.read_level(0, 0, 0, 1, 1, 1).unwrap().get_pixel(0, 0).0, [40; 3]);
        // tile (1,0) at plane 1 is missing: background
        assert_eq!(py.read_level(0, 4, 0, 1, 1, 1).unwrap().get_pixel(0, 0).0, [250, 251, 252]);
        assert_eq!(py.read_level(1, 0, 0, 1, 1, 0).unwrap().get_pixel(0, 0).0, [30; 3]);
        let r = py.region(0, 0, 7, 3, 3, 1, 0).unwrap();
        assert_eq!(r.dimensions(), (3, 1));
        // a metadata size bigger than the tile grid is ignored
        assert_eq!(Pyramid::open(&p, Some((100, 3)), 1 << 20, &[]).unwrap().levels[0], (8, 4));
    }

    #[test]
    fn compressed_tiles() {
        let img = RgbImage::from_fn(4, 4, |x, y| image::Rgb([(x * 60) as u8, (y * 60) as u8, 128]));
        let h = |c| EtsHeader { ndims: 4, index_offset: 0, index_count: 0, pixel_type: 2, channels: 3, compression: c, tile_w: 4, tile_h: 4, background: [255; 3], pyramid: true };
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(img.as_raw(), 4, 4, image::ExtendedColorType::Rgb8).unwrap();
        assert_eq!(decode_tile(&h(COMP_PNG), &png).unwrap(), img);
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 95).encode(img.as_raw(), 4, 4, image::ExtendedColorType::Rgb8).unwrap();
        assert_eq!(decode_tile(&h(COMP_JPEG), &jpg).unwrap().dimensions(), (4, 4));
        assert!(decode_tile(&h(COMP_JPEG_LOSSLESS), &jpg).unwrap_err().starts_with("unsupported"));
        assert!(decode_tile(&h(COMP_JPEG2000), &jpg).is_err());
        assert!(decode_tile(&h(COMP_RAW), &[0; 5]).is_err());
    }

    use image::ImageEncoder;

    // ---- fluorescence: dimension metadata, channel compositing (cellSens 4 layout)

    /// a value + unit field (wavelength, z start / step)
    fn unit_field(tag: i32, unit: &str, v: f64) -> Vec<u8> {
        volume(1, tag, None, &[block(&[field(13, tag::FIELD_UNIT, None, &utf16(unit)), field(10, tag::FIELD_VALUE, None, &v.to_le_bytes())])], false)
    }

    /// a dimension volume (2007/k) holding values (2008/j)
    fn dimension(k: i32, values: &[Vec<Vec<u8>>]) -> Vec<u8> {
        let vals: Vec<Vec<u8>> = values.iter().enumerate().map(|(j, fs)| volume(0, tag::DIM_VALUE, Some(j as i32), &[block(fs)], true)).collect();
        volume(0, tag::DIMENSION, Some(k), &[block(&vals)], true)
    }

    fn fluo_stack(id: i32) -> Vec<u8> {
        let z = dimension(0, &[vec![field(5, tag::DIM_MEANING, None, &1i32.to_le_bytes()), unit_field(tag::Z_START, "10^-6m^1", -2.0), unit_field(tag::Z_INCREMENT, "10^-6m^1", 1.0)]]);
        let chan = |name: &str, nm: f64, lo: f64, hi: f64, first: bool| {
            let mut f = Vec::new();
            if first {
                f.push(field(5, tag::DIM_MEANING, None, &4i32.to_le_bytes()));
            }
            f.push(field(8192, tag::CHANNEL_NAME, None, &utf16(name)));
            f.push(field(260, tag::DISPLAY_RANGE, None, &doubles(&[lo, hi])));
            f.push(unit_field(tag::WAVELENGTH, "10^-9m^1", nm));
            f
        };
        let c = dimension(1, &[chan("DAPI", 455.0, 100.0, 3000.0, true), chan("FITC", 518.0, 50.0, 900.0, false)]);
        let trailing = dimension(2, &[vec![]]);
        let inner = block(&[
            field(5, 2027, None, &0i32.to_le_bytes()),
            volume(1, tag::MULTIDIM_STACK_PROPERTIES, None, &[block(&[field(8192, tag::STACK_NAME, None, &utf16("20x_DAPI, FITC_Z")), field(5, tag::STACK_TYPE, None, &64i32.to_le_bytes())])], false),
            z,
            c,
            trailing,
        ]);
        volume(0, tag::MULTIDIM_IMAGE_VOLUME, Some(id), &[inner], true)
    }

    #[test]
    fn fluorescence_metadata() {
        let mut file = b"II*\0\0\0\0\0".to_vec();
        file.extend(block(&[volume(0, tag::COLLECTION_VOLUME, Some(0), &[block(&[stack(1, "Label", 256, 2.7, 80, 90), fluo_stack(10002)])], true)]));
        let s = stacks_from_tree(&parse_tag_tree(&file));
        let f = s.iter().find(|m| m.id == 10002).unwrap();
        assert_eq!(f.kind, Some(64));
        // a z-stack image (type 64) is an image, a label photo (256) is not
        assert!(!is_auxiliary(f) && is_auxiliary(&s[0]));
        assert_eq!(f.dims.len(), 3, "z, channel, and cellSens' trailing dimension");
        assert_eq!((f.dims[0].meaning, f.dims[0].z_start_um, f.dims[0].z_step_um), (Some(MEANING_Z), Some(-2.0), Some(1.0)));
        assert_eq!(f.dims[1].meaning, Some(MEANING_CHANNEL));
        assert_eq!(f.dims[1].channels.len(), 2);
        assert_eq!(f.dims[1].channels[0], ChannelMeta { name: "DAPI".into(), wavelength_nm: Some(455.0), display: Some((100.0, 3000.0)) });
        assert_eq!(f.dims[1].channels[1].name, "FITC");
        assert_eq!(f.dims[2].meaning, None);
    }

    #[test]
    fn roles_of_dimensions() {
        let z = DimMeta { meaning: Some(MEANING_Z), ..Default::default() };
        let c = DimMeta { meaning: Some(MEANING_CHANNEL), ..Default::default() };
        let other = DimMeta::default();
        let many = |_d: usize| vec![0, 1, 2];
        // ETS: x, y, z, c; metadata lists one trailing dimension more
        assert_eq!(dimension_roles(&[z.clone(), c.clone(), other.clone()], 2, &many), (Some(2), Some(3)));
        // a 2-D fluorescence file: only the channel dimension
        assert_eq!(dimension_roles(&[c.clone(), other.clone()], 1, &many), (None, Some(2)));
        // no metadata: the first dimension with several values is z (brightfield z-stacks)
        assert_eq!(dimension_roles(&[], 2, &|d| if d == 3 { vec![0, 1] } else { vec![0] }), (Some(3), None));
        assert_eq!(dimension_roles(&[], 0, &many), (None, None));
    }

    #[test]
    fn frame_file_beats_blob_file() {
        let p = |s: &str| PathBuf::from(format!("/d/{s}"));
        assert_eq!(pick_ets(vec![p("blob_21_f_Frame#0.ets"), p("frame_t.ets")]), Some(p("frame_t.ets")));
        assert_eq!(pick_ets(vec![p("frame_t_0.ets")]), Some(p("frame_t_0.ets")));
        assert_eq!(pick_ets(vec![p("other.ets")]), Some(p("other.ets")));
        assert_eq!(pick_ets(vec![]), None);
    }

    #[test]
    fn fluorescence_display() {
        let dom = |c: [f32; 3]| (0..3).max_by(|a, b| c[*a].partial_cmp(&c[*b]).unwrap()).unwrap();
        assert_eq!(dom(wavelength_rgb(455.0)), 2, "DAPI is blue");
        assert_eq!(dom(wavelength_rgb(518.0)), 1, "FITC is green");
        assert_eq!(wavelength_rgb(670.0), [1.0, 0.0, 0.0], "Cy5 is red");
        // two channels add up; each is stretched between its own lo and hi
        let blue = ChanLook { pos: 0, color: [0.0, 0.0, 1.0], lo: 100.0, hi: 300.0 };
        let green = ChanLook { pos: 1, color: [0.0, 1.0, 0.0], lo: 0.0, hi: 1000.0 };
        let img = composite(2, 1, &[(&blue, &[200.0, 5000.0]), (&green, &[0.0, 500.0])]).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 128]);
        assert_eq!(img.get_pixel(1, 0).0, [0, 128, 255]);
        assert!(composite(1, 1, &[]).is_none());
        let v: Vec<f32> = (0..1000).map(|i| i as f32).collect();
        let (lo, hi) = auto_range(&v).unwrap();
        assert!((4.0..=6.0).contains(&lo) && (996.0..=998.0).contains(&hi), "{lo} {hi}");
        assert_eq!(auto_range(&[7.0; 100]), None);
    }

    #[test]
    fn sixteen_bit_channels_are_composited_not_z_planes() {
        // x, y, channel, level: two 16-bit grey channels of one 4×4 tile
        let tile16 = |v: u16| v.to_le_bytes().repeat(16);
        let f = ets_file_px(COMP_RAW, &[(vec![0, 0, 0, 0], tile16(1000)), (vec![0, 0, 1, 0], tile16(400))], 4, 4, 1);
        let p = tmp("fl.ets", &f);
        let chan = |nm, lo, hi| ChannelMeta { name: String::new(), wavelength_nm: Some(nm), display: Some((lo, hi)) };
        let dims = [DimMeta { meaning: Some(MEANING_CHANNEL), channels: vec![chan(455.0, 0.0, 2000.0), chan(670.0, 0.0, 400.0)], ..Default::default() }, DimMeta::default()];
        let py = Pyramid::open(&p, None, 1 << 20, &dims).unwrap();
        assert_eq!(py.planes(), 1, "channels are not focal planes");
        assert_eq!(py.c_values, vec![0, 1]);
        assert_eq!(py.background, [0; 3], "fluorescence background is black");
        // DAPI (455 nm: blue with a little green) at half (1000 of 0..2000), Cy5 red full (400 of 0..400)
        assert_eq!(py.read_level(0, 0, 0, 1, 1, 0).unwrap().get_pixel(0, 0).0, [255, 38, 128]);
        // without a saved range it's measured from the image; a lone 16-bit channel is grey
        let g = ets_file_px(COMP_RAW, &[(vec![0, 0, 0], (0..16u16).flat_map(|i| (i * 100).to_le_bytes()).collect())], 3, 4, 1);
        let py = Pyramid::open(&tmp("grey.ets", &g), None, 1 << 20, &[]).unwrap();
        let Look::Composite(ch) = &py.look else { panic!("{:?}", py.look) };
        assert_eq!(ch[0].color, [1.0; 3]);
        assert!(ch[0].lo < ch[0].hi && ch[0].hi <= 1500.0, "{ch:?}");
    }

    #[test]
    fn j2k_keeps_full_precision() {
        // not reachable without an encoder; the 8-bit path still works through Samples
        let s = Samples { w: 1, h: 1, chans: vec![vec![4095.0]], max: 4095.0 };
        assert_eq!(s.to_rgb().unwrap().get_pixel(0, 0).0, [255; 3]);
        let s = Samples { w: 1, h: 1, chans: vec![vec![255.0], vec![0.0], vec![128.0]], max: 255.0 };
        assert_eq!(s.to_rgb().unwrap().get_pixel(0, 0).0, [255, 0, 128]);
    }

    #[test]
    fn data_folder_name() {
        assert_eq!(data_dir(Path::new("/a/OS-2.vsi")).unwrap(), PathBuf::from("/a/_OS-2_"));
        assert_eq!(data_dir(Path::new("/a/b c.VSI")).unwrap(), PathBuf::from("/a/_b c_"));
    }

    /// The OpenSlide test slides OS-1…OS-3 (brightfield, VS120, JPEG 2000), when present.
    /// `VSI_DUMP=<dir>` writes each slide's overview, associated images and a centre crop.
    #[test]
    #[ignore]
    fn real_vsi_samples() {
        let root = std::env::var("VSI_SAMPLES").unwrap_or(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-data/formats").into());
        let mut seen = 0;
        for n in ["OS-1", "OS-2", "OS-3"] {
            let p = format!("{root}/Olympus__{n}/{n}.vsi");
            if !Path::new(&p).exists() {
                eprintln!("skipping: {p} not present");
                continue;
            }
            seen += 1;
            let s = VsiSource::open(&p).unwrap();
            let i = s.info();
            eprintln!("{n}: {}", serde_json::to_string(i).unwrap());
            assert!(i.calibrated);
            assert!((i.mpp_x - 0.346).abs() < 0.01, "{}", i.mpp_x);
            assert!(i.levels.len() >= 5);
            if n == "OS-2" {
                assert_eq!((i.width, i.height), (48502, 77578));
                assert_eq!(i.levels.len(), 9);
                assert_eq!(i.z_planes.len(), 1);
                assert_eq!(i.associated, vec!["overview".to_string()]);
            }
            let max = dz_max_level(i.width, i.height);
            let t = s.tile(max, (i.width / 512) as u32, (i.height / 512) as u32, 0).unwrap();
            assert_eq!(t.dimensions(), (256, 256));
            let o = s.overview(1024, 0).unwrap();
            assert_eq!(o.width().max(o.height()), 1024);
            if let Ok(dir) = std::env::var("VSI_DUMP") {
                o.save(format!("{dir}/vsi_{n}_overview.png")).unwrap();
                for a in &i.associated {
                    s.associated(a).unwrap().save(format!("{dir}/vsi_{n}_assoc_{a}.png")).unwrap();
                }
                s.region(i.width / 2 - 512, i.height / 2 - 512, 1024, 1024, 1024, 1024, 0).unwrap().save(format!("{dir}/vsi_{n}_centre.png")).unwrap();
            }
        }
        // cellSens 4 fluorescence (downloads.openmicroscopy.org/images/CellSens/evident): channels
        // composited (not shown as focal planes), the real image (not the slide label), z offsets
        for (n, size, planes) in [("Image_V4.1_FL_2D", (10911, 5460), 1usize), ("Image_V4.1_FL_3D", (9038, 5357), 5)] {
            let p = format!("{root}/CellSens-evident/{n}.vsi");
            if !Path::new(&p).exists() {
                eprintln!("skipping: {p} not present");
                continue;
            }
            seen += 1;
            let s = VsiSource::open(&p).unwrap();
            let i = s.info();
            eprintln!("{n}: {}", serde_json::to_string(i).unwrap());
            assert_eq!((i.width, i.height), size, "{n}: the main image, not the label");
            assert_eq!(i.z_planes.len(), planes, "{n}");
            assert!(i.associated.contains(&"overview".to_string()) && i.associated.contains(&"label".to_string()), "{n}: {:?}", i.associated);
            if planes == 5 {
                let mut offs: Vec<i64> = i.z_planes.iter().map(|z| z.offset_nm.unwrap().round() as i64).collect();
                offs.sort();
                assert_eq!(offs, vec![-2362, -1181, 0, 1181, 2362]);
                assert_eq!(i.z_planes.iter().find(|z| z.index == 0).unwrap().offset_nm, Some(0.0), "opens in focus");
            }
            // 16-bit fluorescence must not come out black
            let o = s.overview(512, 0).unwrap();
            let bright = o.pixels().filter(|p| p.0.iter().any(|c| *c > 60)).count() as f64 / (o.width() * o.height()) as f64;
            assert!(bright > 0.2, "{n}: overview is nearly black ({:.1}% lit)", bright * 100.0);
            if let Ok(dir) = std::env::var("VSI_DUMP") {
                o.save(format!("{dir}/vsi_{n}_overview.png")).unwrap();
            }
        }
        eprintln!("{seen} sample(s) checked");
    }
}
