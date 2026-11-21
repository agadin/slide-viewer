//! Nikon NIS-Elements `.nd2`. Owner: formats builder.
//!
//! Two container formats share the extension:
//! - **Modern** (NIS-Elements 3.2 and later): a run of chunks, each a 16-byte header (magic
//!   `0x0ABECEDA`, u32 name length, u64 data length), the name and the data. The file ends with
//!   `"ND2 CHUNK MAP SIGNATURE 0000001!"` and the u64 position of the chunk map, whose data
//!   lists every chunk as `name!` + u64 position + u64 size. The chunks used here:
//!   - `ImageAttributesLV!` (or `ImageAttributes!` as XML): width, height, bytes per row,
//!     components per pixel, bits per component, frame count, compression, pixel type;
//!   - `ImageCalibrationLV|0!` (or XML `ImageCalibration|0!`): µm per pixel;
//!   - `ImageMetadataLV!` (or XML `ImageMetadata!`): the experiment, a nest of loops (time,
//!     XY positions, Z, channels) that says how frame numbers map to time point, stage position
//!     and Z (`LoopNest`), with the time intervals and the positions' names;
//!   - `ImageMetadataSeqLV|0!` (or XML `ImageMetadataSeq|0!`): the channels (name, colour,
//!     emission spectrum);
//!   - `CustomData|Z!`: the Z position of every frame (f64 µm), when recorded;
//!   - `ImageDataSeq|n!`: frame n, an f64 timestamp then the pixels (interleaved components,
//!     rows padded to the row length), raw or zlib-compressed.
//!
//!   Metadata is Nikon's "LV" binary variant (typed, named items; levels nest) or the same tree
//!   as XML (`runtype`/`value` attributes); both are parsed into one `Var` tree.
//! - **Legacy** (older NIS-Elements): a JPEG 2000 (JP2) file whose `jp2c` boxes hold one
//!   codestream per frame and channel, and whose `xml ` boxes hold the same metadata as XML.
//!
//! Layout as described by the open-source readers `nd2` (Python, BSD), `nd2-rs` and
//! `openreadout-nd2` (MIT/Apache); this is an independent implementation.
//!
//! Display: ND2 frames are flat, so each (time point, focal plane) becomes a Deep-Zoom pyramid
//! (`pyramid.rs`), built on first use in memory, or on disk in the app cache for big stitched
//! images. RGB (brightfield camera) images are shown as they are; a single 8-bit channel as grey;
//! other channels are stretched (0.5 → 99.8 % of the in-focus plane at the first time point, one
//! stretch for all planes and times) and added in the colour of their emission wavelength (or the
//! colour saved in the file).
//!
//! Each XY stage position is a series (`open_series`), named as in the experiment. Time points
//! are labelled from the timestamp that starts each frame (legacy: `dTimeMSec`), else from the
//! loop's interval.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use image::{imageops::FilterType, RgbImage};

use super::cache::{cache_dir, file_key};
use super::plain::{MAX_PIXELS, MAX_PLAUSIBLE_MPP, MEM_PIXELS};
use super::pyramid::{Canvas, Pyramid};
use super::vsi::{auto_range, composite, decode_j2k_samples, wavelength_rgb, ChanLook};
use super::{dz_max_level, dz_tile_rect, fit, make_planes, make_time_points, split_z, LevelInfo, SlideSource, SourceInfo, TILE_SIZE};

/// Chunk header magic (little-endian on disk: `DA CE BE 0A`).
pub const CHUNK_MAGIC: u32 = 0x0ABE_CEDA;
/// The last 40 bytes of a modern file: this, then the u64 position of the chunk map.
pub const MAP_SIGNATURE: &[u8; 32] = b"ND2 CHUNK MAP SIGNATURE 0000001!";
/// A legacy (JPEG 2000) ND2 starts with the JP2 signature box.
const JP2_SIGNATURE: [u8; 12] = [0, 0, 0, 12, b'j', b'P', b' ', b' ', 13, 10, 0x87, 10];

/// Planes whose pyramids stay in memory, by total bytes (older planes are dropped and rebuilt).
const MEM_PLANE_BUDGET: u64 = 384 << 20;
/// Bump when the rendering (stretch, colours) changes, so cached disk pyramids are rebuilt.
const RENDER_VERSION: u32 = 1;
/// Disk pyramids kept in the cache (oldest are removed).
const KEEP_DISK: usize = 6;
/// Disk pyramids kept per file (planes × time points × positions; least recently used go).
const KEEP_PLANES: usize = 24;
/// Largest decompressed frame we hold in memory (zlib frames are decompressed whole).
const MAX_FRAME_BYTES: u64 = 4 << 30;
/// Samples per channel used to measure the stretch.
const STRETCH_SAMPLES: usize = 2_000_000;
/// Deepest metadata nesting we follow.
const MAX_DEPTH: usize = 64;

// ---------------------------------------------------------------- the metadata tree

/// One metadata value. LV and XML metadata both become this tree.
#[derive(Debug, Clone, PartialEq)]
pub enum Var {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    /// named children, in file order (unnamed items, `no_name` in XML, have the name "")
    Level(Vec<(String, Var)>),
}

impl Var {
    pub fn children(&self) -> &[(String, Var)] {
        match self {
            Var::Level(c) => c,
            _ => &[],
        }
    }

    /// A direct child by name.
    pub fn get(&self, key: &str) -> Option<&Var> {
        self.children().iter().find(|(n, _)| n == key).map(|(_, v)| v)
    }

    /// The shallowest descendant with this name (breadth first).
    pub fn find(&self, key: &str) -> Option<&Var> {
        let mut level: Vec<&Var> = vec![self];
        while !level.is_empty() {
            let mut next = Vec::new();
            for v in level {
                for (n, c) in v.children() {
                    if n == key {
                        return Some(c);
                    }
                    next.push(c);
                }
            }
            level = next;
        }
        None
    }

    /// Every descendant with this name, in file order (depth first).
    pub fn find_all<'a>(&'a self, key: &str, out: &mut Vec<&'a Var>) {
        for (n, c) in self.children() {
            if n == key {
                out.push(c);
            }
            c.find_all(key, out);
        }
    }

    pub fn num(&self) -> Option<f64> {
        match self {
            Var::Int(i) => Some(*i as f64),
            Var::Float(f) => Some(*f),
            Var::Bool(b) => Some(*b as u8 as f64),
            Var::Str(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    pub fn text(&self) -> Option<&str> {
        match self {
            Var::Str(s) => Some(s),
            _ => None,
        }
    }

    /// `find(key)` as a number.
    pub fn num_at(&self, key: &str) -> Option<f64> {
        self.find(key)?.num()
    }
}

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(p..p.checked_add(4)?)?.try_into().ok()?))
}
fn u64_at(b: &[u8], p: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(p..p.checked_add(8)?)?.try_into().ok()?))
}

/// Parse LV binary metadata (the whole chunk) into a level.
pub fn parse_lv(b: &[u8]) -> Var {
    Var::Level(lv_items(b, usize::MAX, 0))
}

/// Up to `count` LV items from `b`. Stops quietly at anything malformed (keeping what it read).
fn lv_items(b: &[u8], count: usize, depth: usize) -> Vec<(String, Var)> {
    let mut out = Vec::new();
    if depth > MAX_DEPTH {
        return out;
    }
    let mut p = 0usize;
    for _ in 0..count {
        if p + 2 > b.len() {
            break;
        }
        let start = p;
        let (t, nl) = (b[p], b[p + 1] as usize);
        p += 2;
        if t == 76 {
            // the rest is zlib-compressed (after 10 bytes we don't need)
            let Some(z) = b.get(p + 10..) else { break };
            let mut dec = Vec::new();
            if flate2::read::ZlibDecoder::new(z).take(256 << 20).read_to_end(&mut dec).is_ok() {
                out.extend(lv_items(&dec, usize::MAX, depth + 1));
            }
            break;
        }
        let Some(raw) = b.get(p..p + nl * 2) else { break };
        p += nl * 2;
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let name = String::from_utf16_lossy(&units).trim_end_matches('\0').to_string();
        let v = match t {
            1 => {
                let Some(&x) = b.get(p) else { break };
                p += 1;
                Var::Bool(x != 0)
            }
            2 => {
                let Some(x) = u32_at(b, p) else { break };
                p += 4;
                Var::Int(x as i32 as i64)
            }
            3 => {
                let Some(x) = u32_at(b, p) else { break };
                p += 4;
                Var::Int(x as i64)
            }
            4 | 5 | 7 => {
                let Some(x) = u64_at(b, p) else { break };
                p += 8;
                Var::Int(x as i64)
            }
            6 => {
                let Some(x) = u64_at(b, p) else { break };
                p += 8;
                Var::Float(f64::from_bits(x))
            }
            8 => {
                // UTF-16LE, NUL-terminated
                let mut q = p;
                let mut units = Vec::new();
                loop {
                    let Some(c) = b.get(q..q + 2) else { break };
                    q += 2;
                    let u = u16::from_le_bytes([c[0], c[1]]);
                    if u == 0 {
                        break;
                    }
                    units.push(u);
                }
                p = q;
                Var::Str(String::from_utf16_lossy(&units))
            }
            9 => {
                let Some(n) = u64_at(b, p) else { break };
                let n = n as usize;
                let Some(bytes) = b.get(p + 8..(p + 8).saturating_add(n)) else { break };
                p += 8 + n;
                // big blobs (thumbnails, LUTs) aren't needed
                Var::Bytes(if n <= 1 << 20 { bytes.to_vec() } else { Vec::new() })
            }
            11 => {
                let (Some(ic), Some(len)) = (u32_at(b, p), u64_at(b, p + 4)) else { break };
                p += 12;
                let end = start.saturating_add(len as usize);
                let Some(body) = b.get(p..end) else { break };
                let kids = lv_items(body, ic as usize, depth + 1);
                // the level's items are followed by a table of ic u64 offsets
                p = end.saturating_add(ic as usize * 8);
                Var::Level(kids)
            }
            _ => break,
        };
        out.push((name, v));
    }
    out
}

fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(j) = rest.find(';') else { break };
        let ent = &rest[1..j];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => out.push(c),
            None => out.push_str(&rest[..=j]),
        }
        rest = &rest[j + 1..];
    }
    out.push_str(rest);
    out
}

/// The attributes of a start tag's text (after the name).
fn xml_attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = s;
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim().to_string();
        let after = rest[eq + 1..].trim_start();
        let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
        let Some(end) = after[1..].find(q) else { break };
        out.push((name, xml_unescape(&after[1..1 + end])));
        rest = &after[end + 2..];
    }
    out
}

/// A leaf value from its `runtype` and `value` attributes.
fn xml_leaf(runtype: &str, value: &str) -> Var {
    if runtype.contains("String") {
        return Var::Str(value.to_string());
    }
    if runtype == "bool" {
        return Var::Bool(value == "true" || value == "1");
    }
    if let Ok(i) = value.parse::<i64>() {
        return Var::Int(i);
    }
    if let Ok(f) = value.parse::<f64>() {
        return Var::Float(f);
    }
    Var::Str(value.to_string())
}

/// Parse NIS-Elements XML metadata (`<name runtype=".." value=".."/>` leaves inside nested
/// elements) into a level. Text content and unknown constructs are ignored.
pub fn parse_xml(b: &[u8]) -> Var {
    let s = String::from_utf8_lossy(b);
    // (name, attrs, children)
    let mut stack: Vec<(String, Vec<(String, String)>, Vec<(String, Var)>)> = vec![(String::new(), vec![], vec![])];
    let norm = |n: &str| if n == "no_name" { String::new() } else { n.to_string() };
    let leaf = |attrs: &[(String, String)], kids: Vec<(String, Var)>| -> Var {
        let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        match get("value") {
            Some(v) if kids.is_empty() => xml_leaf(get("runtype").unwrap_or(""), v),
            _ => Var::Level(kids),
        }
    };
    let mut rest: &str = &s;
    while let Some(i) = rest.find('<') {
        rest = &rest[i..];
        if rest.starts_with("<!--") {
            let Some(e) = rest.find("-->") else { break };
            rest = &rest[e + 3..];
            continue;
        }
        let Some(e) = rest.find('>') else { break };
        let tag = &rest[1..e];
        rest = &rest[e + 1..];
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let name = name.trim();
            // close up to the matching element (tolerating unclosed ones)
            if let Some(k) = stack.iter().rposition(|f| f.0 == norm(name) || f.0 == name) {
                if k == 0 {
                    continue;
                }
                while stack.len() > k {
                    let (n, a, kids) = stack.pop().unwrap();
                    let v = leaf(&a, kids);
                    stack.last_mut().unwrap().2.push((n, v));
                }
            }
            continue;
        }
        let self_closing = tag.ends_with('/');
        let tag = tag.trim_end_matches('/');
        let (name, attr_text) = match tag.find(char::is_whitespace) {
            Some(k) => (&tag[..k], &tag[k..]),
            None => (tag, ""),
        };
        let attrs = xml_attrs(attr_text);
        if stack.len() > MAX_DEPTH {
            continue;
        }
        if self_closing {
            let v = leaf(&attrs, vec![]);
            stack.last_mut().unwrap().2.push((norm(name), v));
        } else {
            stack.push((norm(name), attrs, vec![]));
        }
    }
    while stack.len() > 1 {
        let (n, a, kids) = stack.pop().unwrap();
        let v = leaf(&a, kids);
        stack.last_mut().unwrap().2.push((n, v));
    }
    Var::Level(stack.pop().unwrap().2)
}

/// LV or XML, whichever the bytes are.
pub fn parse_meta(b: &[u8]) -> Var {
    let start = b.iter().position(|c| !c.is_ascii_whitespace() && *c != 0xEF && *c != 0xBB && *c != 0xBF).unwrap_or(0);
    if b.get(start) == Some(&b'<') { parse_xml(b) } else { parse_lv(b) }
}

// ---------------------------------------------------------------- the modern container

/// Chunk names and their (position, size) from the chunk map's data.
pub fn parse_chunk_map(d: &[u8]) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    let mut p = 0;
    while p < d.len() {
        let Some(e) = d[p..].iter().position(|&c| c == b'!') else { break };
        let name = String::from_utf8_lossy(&d[p..p + e + 1]).to_string();
        p += e + 1;
        let (Some(pos), Some(size)) = (u64_at(d, p), u64_at(d, p + 8)) else { break };
        p += 16;
        if name.as_bytes() == MAP_SIGNATURE {
            break;
        }
        out.push((name, pos, size));
    }
    out
}

fn read_exact_at(f: &mut File, pos: u64, n: usize) -> Result<Vec<u8>, String> {
    f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
    let mut v = vec![0u8; n];
    f.read_exact(&mut v).map_err(|e| format!("truncated file ({e})"))?;
    Ok(v)
}

/// A chunk's data range (position, length) from its header at `pos`.
fn chunk_data(f: &mut File, pos: u64, file_len: u64) -> Result<(u64, u64), String> {
    let h = read_exact_at(f, pos, 16)?;
    if u32_at(&h, 0) != Some(CHUNK_MAGIC) {
        return Err(format!("no ND2 chunk at {pos}"));
    }
    let nl = u32_at(&h, 4).unwrap() as u64;
    let dl = u64_at(&h, 8).unwrap();
    let start = pos + 16 + nl;
    if start.checked_add(dl).is_none_or(|e| e > file_len) {
        return Err(format!("ND2 chunk at {pos} runs past the end of the file"));
    }
    Ok((start, dl))
}

/// The chunk map of a modern file: name → (data position, data length).
fn read_chunk_map(f: &mut File) -> Result<HashMap<String, (u64, u64)>, String> {
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < 40 + 16 {
        return Err("too short for an ND2 file".into());
    }
    let tail = read_exact_at(f, len - 40, 40)?;
    if &tail[..32] != MAP_SIGNATURE {
        return Err("no ND2 chunk map (the file may be incomplete)".into());
    }
    let (mp, ml) = chunk_data(f, u64_at(&tail, 32).unwrap(), len)?;
    if ml > 256 << 20 {
        return Err("ND2 chunk map too large".into());
    }
    let map = read_exact_at(f, mp, ml as usize)?;
    let mut out = HashMap::new();
    for (name, pos, _) in parse_chunk_map(&map) {
        if pos >= len {
            continue;
        }
        if let Ok(r) = chunk_data(f, pos, len) {
            out.insert(name, r);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- image attributes

/// The frame layout (`ImageAttributes`).
#[derive(Debug, Clone, PartialEq)]
pub struct Attrs {
    pub width: u32,
    pub height: u32,
    /// bytes per row in a raw frame (rows may be padded)
    pub row_bytes: usize,
    /// components (channels) per pixel
    pub comps: usize,
    pub bits_in_memory: u32,
    pub bits_significant: u32,
    pub seq_count: usize,
    /// 0 lossless (zlib), 1 lossy, 2 none
    pub compression: i64,
    /// 1 unsigned integer, 2 float, 3 signed integer
    pub pixel_type: i64,
}

impl Attrs {
    pub fn bytes_per_sample(&self) -> usize {
        self.bits_in_memory.div_ceil(8) as usize
    }
    /// Bytes of one row's samples, without padding.
    pub fn tight_row(&self) -> usize {
        self.width as usize * self.comps * self.bytes_per_sample()
    }
}

pub fn attrs_from(v: &Var) -> Result<Attrs, String> {
    let n = |k: &str| v.num_at(k);
    let (Some(w), Some(h)) = (n("uiWidth"), n("uiHeight")) else {
        return Err("ND2 image attributes without a size".into());
    };
    let comps = n("uiComp").unwrap_or(1.0) as usize;
    let bits = n("uiBpcInMemory").unwrap_or(16.0) as u32;
    let a = Attrs {
        width: w as u32,
        height: h as u32,
        row_bytes: 0,
        comps,
        bits_in_memory: bits,
        bits_significant: n("uiBpcSignificant").map(|b| b as u32).filter(|b| *b > 0 && *b <= bits).unwrap_or(bits),
        seq_count: n("uiSequenceCount").unwrap_or(1.0) as usize,
        compression: n("eCompression").unwrap_or(2.0) as i64,
        pixel_type: n("ePixelType").unwrap_or(1.0) as i64,
    };
    if a.width == 0 || a.height == 0 || a.width > 1 << 20 || a.height > 1 << 20 {
        return Err(format!("ND2 image of implausible size {} × {}", a.width, a.height));
    }
    if a.comps == 0 || a.comps > 64 {
        return Err(format!("ND2 image with {} components", a.comps));
    }
    if !matches!(a.bits_in_memory, 8 | 16 | 32) {
        return Err(format!("unsupported: ND2 images with {} bits per sample", a.bits_in_memory));
    }
    if a.bits_in_memory == 32 && a.pixel_type != 2 && a.pixel_type != 1 {
        return Err(format!("unsupported: ND2 pixel type {}", a.pixel_type));
    }
    let tight = a.tight_row();
    let rb = n("uiWidthBytes").map(|r| r as usize).unwrap_or(0);
    Ok(Attrs { row_bytes: if rb >= tight { rb } else { tight }, ..a })
}

/// Decode `rows` rows of interleaved samples (each `stride` bytes apart) into one f32 plane
/// per component.
pub fn decode_rows(b: &[u8], a: &Attrs, rows: u32, stride: usize) -> Result<Vec<Vec<f32>>, String> {
    let (w, c, bps) = (a.width as usize, a.comps, a.bytes_per_sample());
    let rows = rows as usize;
    if rows == 0 || b.len() < (rows - 1) * stride + w * c * bps {
        return Err("short ND2 frame".into());
    }
    let mut out = vec![Vec::with_capacity(w * rows); c];
    for r in 0..rows {
        let row = &b[r * stride..r * stride + w * c * bps];
        match (bps, a.pixel_type) {
            (1, _) => {
                for (i, &v) in row.iter().enumerate() {
                    out[i % c].push(v as f32);
                }
            }
            (2, 3) => {
                for (i, s) in row.chunks_exact(2).enumerate() {
                    out[i % c].push(i16::from_le_bytes([s[0], s[1]]) as f32);
                }
            }
            (2, _) => {
                for (i, s) in row.chunks_exact(2).enumerate() {
                    out[i % c].push(u16::from_le_bytes([s[0], s[1]]) as f32);
                }
            }
            (4, 2) => {
                for (i, s) in row.chunks_exact(4).enumerate() {
                    out[i % c].push(f32::from_le_bytes([s[0], s[1], s[2], s[3]]));
                }
            }
            (4, 3) => {
                for (i, s) in row.chunks_exact(4).enumerate() {
                    out[i % c].push(i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32);
                }
            }
            (4, _) => {
                for (i, s) in row.chunks_exact(4).enumerate() {
                    out[i % c].push(u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f32);
                }
            }
            _ => return Err(format!("unsupported: ND2 samples of {bps} bytes")),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- experiment loops (Z)

/// Loop types (`eType`).
pub const LOOP_TIME: i64 = 1;
pub const LOOP_XY: i64 = 2;
pub const LOOP_Z: i64 = 4;
pub const LOOP_SPECTRAL: i64 = 6;
pub const LOOP_NE_TIME: i64 = 8;

/// One loop of the experiment that produces frames.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Loop {
    pub kind: i64,
    pub count: usize,
    /// Z loops: the step (µm) and whether the stack runs top to bottom
    pub step_um: Option<f64>,
    pub inverted: bool,
    /// time loops: (time points, interval in ms) per phase, in order (one phase for a plain
    /// time loop); empty when the interval isn't known
    pub periods: Vec<(usize, f64)>,
    /// XY loops: the names of the (valid) positions, `count` of them, or empty
    pub names: Vec<String>,
}

fn is_experiment(v: &Var) -> bool {
    v.get("eType").is_some() && v.get("uLoopPars").is_some()
}

fn collect_experiments<'a>(v: &'a Var, out: &mut Vec<&'a Var>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    for (n, c) in v.children() {
        if n == "uLoopPars" {
            continue;
        }
        if is_experiment(c) {
            out.push(c);
        }
        collect_experiments(c, out, depth + 1);
    }
}

/// The frame-producing loops, outermost first. Modern files nest the inner loops in
/// `ppNextLevelEx`; legacy ones list them side by side (`LoopNo00`, `LoopNo01`, …); both come
/// out in file order. Channel (spectral) loops are skipped: channels are components of a frame.
pub fn loops_from(exp: &Var) -> Vec<Loop> {
    let mut nodes = Vec::new();
    if is_experiment(exp) {
        nodes.push(exp);
    }
    collect_experiments(exp, &mut nodes, 0);
    nodes
        .into_iter()
        .filter_map(|e| {
            let kind = e.get("eType")?.num()? as i64;
            if kind == LOOP_SPECTRAL {
                return None;
            }
            let pars = e.get("uLoopPars")?;
            let mut count = pars.num_at("uiCount").unwrap_or(1.0).max(1.0) as usize;
            let mut names = Vec::new();
            if kind == LOOP_XY {
                // modern: Points/<n>/dPosName; older: a list of names
                let mut found = Vec::new();
                pars.find_all("dPosName", &mut found);
                pars.find_all("pPosName", &mut found);
                for v in found {
                    match v {
                        Var::Str(s) => names.push(s.trim().to_string()),
                        Var::Level(c) => names.extend(c.iter().filter_map(|(_, s)| s.text()).map(|s| s.trim().to_string())),
                        _ => {}
                    }
                }
                if let Some(valid) = validity(e.get("pItemValid")).filter(|v| v.len() == count) {
                    if names.len() == count {
                        names = names.into_iter().zip(&valid).filter(|(_, ok)| **ok).map(|(n, _)| n).collect();
                    }
                    count = valid.iter().filter(|&&b| b).count().max(1);
                }
                if names.len() != count {
                    names.clear();
                }
            }
            let (step_um, inverted) = if kind == LOOP_Z {
                (pars.num_at("dZStep").filter(|s| s.is_finite() && *s != 0.0).map(f64::abs), pars.num_at("bZInverted").is_some_and(|b| b != 0.0))
            } else {
                (None, false)
            };
            let periods = match kind {
                LOOP_TIME => {
                    // the measured mean interval, else the one asked for
                    let p = pars.num_at("dAvgPeriodDiff").filter(|p| p.is_finite() && *p > 0.0).or_else(|| pars.num_at("dPeriod").filter(|p| p.is_finite() && *p > 0.0));
                    p.map(|p| vec![(count, p)]).unwrap_or_default()
                }
                LOOP_NE_TIME => ne_periods(pars),
                _ => vec![],
            };
            Some(Loop { kind, count, step_um, inverted, periods, names })
        })
        .collect()
}

/// Per-item flags (`pItemValid`, `pPeriodValid`): bytes, or a list of booleans.
fn validity(v: Option<&Var>) -> Option<Vec<bool>> {
    match v? {
        Var::Bytes(b) if !b.is_empty() => Some(b.iter().map(|&x| x != 0).collect()),
        Var::Level(c) if !c.is_empty() => c.iter().map(|(_, x)| x.num().map(|n| n != 0.0)).collect(),
        _ => None,
    }
}

/// The phases of an NE time loop (`pPeriod`, the valid ones): (time points, interval ms).
/// Empty when any interval is unknown.
fn ne_periods(pars: &Var) -> Vec<(usize, f64)> {
    let Some(pp) = pars.find("pPeriod") else { return vec![] };
    let phases: Vec<&Var> = pp.children().iter().map(|(_, v)| v).filter(|v| matches!(v, Var::Level(_))).collect();
    let valid = validity(pars.find("pPeriodValid")).filter(|v| v.len() == phases.len());
    let mut out = Vec::new();
    for (k, ph) in phases.into_iter().enumerate() {
        if valid.as_ref().is_some_and(|v| !v[k]) {
            continue;
        }
        let n = ph.get("uiCount").and_then(Var::num).unwrap_or(0.0) as usize;
        let p = ph.get("dAvgPeriodDiff").and_then(Var::num).filter(|p| p.is_finite() && *p > 0.0).or_else(|| ph.get("dPeriod").and_then(Var::num));
        match p.filter(|p| p.is_finite() && *p > 0.0) {
            Some(p) if n > 0 => out.push((n, p)),
            _ => return vec![],
        }
    }
    out
}

/// The axes the viewer shows: time, XY stage position, Z.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Axis {
    Time,
    Xy,
    Z,
}

fn axis_of(kind: i64) -> Option<Axis> {
    match kind {
        LOOP_TIME | LOOP_NE_TIME => Some(Axis::Time),
        LOOP_XY => Some(Axis::Xy),
        LOOP_Z => Some(Axis::Z),
        _ => None,
    }
}

/// How frame numbers follow from the loops: frame = Σ index × stride, the innermost loop
/// varying fastest. The first loop of each axis is that axis; any other loop (another of the
/// same kind, or one we don't know) stays at its first item.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopNest {
    /// the loops, outermost first, their counts cut to the frames that exist (an interrupted
    /// acquisition keeps only whole iterations)
    pub loops: Vec<Loop>,
    /// frames between successive items of each loop
    pub strides: Vec<usize>,
}

impl LoopNest {
    pub fn new(loops: &[Loop], frames: usize) -> LoopNest {
        let strides: Vec<usize> = (0..loops.len()).map(|k| loops[k + 1..].iter().map(|l| l.count.max(1)).product::<usize>().max(1)).collect();
        let loops = loops.iter().zip(&strides).map(|(l, s)| Loop { count: l.count.min(frames / s).max(1), ..l.clone() }).collect();
        LoopNest { loops, strides }
    }

    /// The loop that is this axis.
    pub fn axis(&self, a: Axis) -> Option<usize> {
        self.loops.iter().position(|l| axis_of(l.kind) == Some(a))
    }

    /// Items along an axis (1 when the experiment has no such loop).
    pub fn count(&self, a: Axis) -> usize {
        self.axis(a).map_or(1, |k| self.loops[k].count)
    }

    /// The frame-number offset of item `i` along an axis.
    pub fn offset(&self, a: Axis, i: usize) -> usize {
        self.axis(a).map_or(0, |k| i * self.strides[k])
    }

    /// The frame of (position, time point, plane in loop order).
    pub fn frame(&self, xy: usize, t: usize, z: usize) -> usize {
        self.offset(Axis::Xy, xy) + self.offset(Axis::Time, t) + self.offset(Axis::Z, z)
    }
}

/// Seconds since the first time point, for `n` time points: from the frames' timestamps (ms,
/// the first frame of each time point) when they rise steadily, else from the loop's intervals,
/// else unknown.
pub fn time_seconds(stamps_ms: &[Option<f64>], time_loop: Option<&Loop>, n: usize) -> Vec<Option<f64>> {
    let stamps: Option<Vec<f64>> = stamps_ms.iter().map(|s| s.filter(|v| v.is_finite())).collect();
    if let Some(s) = stamps.filter(|s| s.len() == n && n > 1)
        && s.windows(2).all(|w| w[1] >= w[0])
        && s[n - 1] > s[0]
    {
        return s.iter().map(|v| Some((v - s[0]) / 1000.0)).collect();
    }
    let periods = time_loop.map(|l| l.periods.as_slice()).unwrap_or(&[]);
    if periods.is_empty() {
        return vec![None; n];
    }
    // phase k's interval applies to its time points after the first one overall
    let mut out = Vec::with_capacity(n);
    let (mut t, mut phase, mut left) = (0.0, 0usize, periods[0].0);
    for i in 0..n {
        if i > 0 {
            while left == 0 && phase + 1 < periods.len() {
                phase += 1;
                left = periods[phase].0;
            }
            t += periods[phase].1;
        }
        left = left.saturating_sub(1);
        out.push(Some(t / 1000.0));
    }
    out
}

/// How focal planes sit among the frames: plane k (loop order) is frame `k * stride`.
#[derive(Debug, Clone, PartialEq)]
pub struct ZLayout {
    pub count: usize,
    pub stride: usize,
    pub step_um: Option<f64>,
    pub inverted: bool,
}

/// The Z loop's place among `frames` frames (one plane when there is no usable Z loop).
pub fn z_layout(loops: &[Loop], frames: usize) -> ZLayout {
    z_layout_of(&LoopNest::new(loops, frames))
}

fn z_layout_of(nest: &LoopNest) -> ZLayout {
    let single = ZLayout { count: 1, stride: 1, step_um: None, inverted: false };
    let Some(k) = nest.axis(Axis::Z) else { return single };
    let l = &nest.loops[k];
    if l.count <= 1 {
        return single;
    }
    ZLayout { count: l.count, stride: nest.strides[k], step_um: l.step_um, inverted: l.inverted }
}

/// Z of each plane (µm, loop order): from the per-frame positions when the file has them
/// (`CustomData|Z!`, legacy `dZPos`), else from the step.
pub fn plane_z(z: &ZLayout, frame_z: &[f64]) -> Vec<Option<f64>> {
    let from_frames: Option<Vec<f64>> = (0..z.count).map(|k| frame_z.get(k * z.stride).copied().filter(|v| v.is_finite())).collect();
    if let Some(v) = from_frames
        && v.iter().any(|x| (x - v[0]).abs() > 1e-6)
    {
        return v.into_iter().map(Some).collect();
    }
    match z.step_um {
        Some(s) => (0..z.count).map(|k| Some(k as f64 * if z.inverted { -s } else { s })).collect(),
        None => vec![None; z.count],
    }
}

// ---------------------------------------------------------------- channels

/// One channel as the metadata describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ChanMeta {
    pub name: String,
    /// the display colour saved in the file (not white)
    pub color: Option<[u8; 3]>,
    pub emission_nm: Option<f64>,
    /// transmitted light (brightfield, phase contrast, DIC): shown in grey
    pub transmitted: bool,
    /// components this plane has (3 for an RGB camera)
    pub comps: usize,
}

/// Mean of a spectrum's non-zero wavelengths.
fn spectrum_nm(s: &Var) -> Option<f64> {
    let mut pts = Vec::new();
    s.find_all("dWavelength", &mut pts);
    s.find_all("uiWavelength", &mut pts);
    let v: Vec<f64> = pts.iter().filter_map(|p| p.num()).filter(|w| *w > 200.0 && *w < 2000.0).collect();
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}

fn emission_nm(plane: &Var) -> Option<f64> {
    for key in ["pFluorescentProbe", "pFilterPath"] {
        if let Some(part) = plane.get(key) {
            let mut specs = Vec::new();
            part.find_all("m_EmissionSpectrum", &mut specs);
            if let Some(nm) = specs.iter().find_map(|s| spectrum_nm(s)) {
                return Some(nm);
            }
        }
    }
    None
}

/// The channels of `ImageMetadataSeq` (`sPicturePlanes`), in component order.
pub fn channels_from(seq: &Var) -> Vec<ChanMeta> {
    let Some(pp) = seq.find("sPicturePlanes") else { return vec![] };
    let planes = pp.get("sPlaneNew").or_else(|| pp.get("sPlane"));
    let Some(planes) = planes else { return vec![] };
    planes
        .children()
        .iter()
        .filter(|(_, p)| matches!(p, Var::Level(_)))
        .map(|(_, p)| {
            let saved = p.get("uiColor").and_then(Var::num).map(|c| c as u32 & 0xFF_FFFF);
            let color = saved.filter(|c| *c != 0 && *c != 0xFF_FFFF);
            let name = p.get("sDescription").and_then(Var::text).unwrap_or("").to_string();
            // NIS-Elements shows transmitted channels in white; the modality mask's bit 1 is brightfield
            let brightfield = p.get("uiModalityMask").and_then(Var::num).is_some_and(|m| m as u64 & 2 != 0);
            let transmitted = saved == Some(0xFF_FFFF) || brightfield || is_transmitted_name(&name);
            ChanMeta {
                name,
                transmitted,
                // COLORREF: 0x00BBGGRR
                color: color.map(|c| [(c & 0xFF) as u8, (c >> 8 & 0xFF) as u8, (c >> 16 & 0xFF) as u8]),
                emission_nm: emission_nm(p),
                comps: p.get("uiCompCount").and_then(Var::num).map(|n| n as usize).unwrap_or(1).max(1),
            }
        })
        .collect()
}

/// Channel names that mean transmitted light ("DIC", "Phase 40x", "Brightfield", "BF", "TL").
fn is_transmitted_name(name: &str) -> bool {
    let n = name.to_lowercase();
    ["dic", "phase", "bright", "trans"].iter().any(|k| n.contains(k)) || n.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| matches!(w, "bf" | "ph" | "tl" | "pc"))
}

/// Colours for channels with neither wavelength nor colour: blue, green, red, magenta, cyan, yellow.
const PALETTE: [[f32; 3]; 6] = [[0.0, 0.3, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 0.0]];

/// Display colours of an RGB frame's three components, which are stored blue first.
pub const RGB_COMPONENTS: [[f32; 3]; 3] = [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]];

/// Display colour of channel `k` of `n`: one channel, or transmitted light, is grey; otherwise
/// the emission wavelength's colour, else the saved colour, else the palette.
pub fn channel_color(ch: Option<&ChanMeta>, k: usize, n: usize) -> [f32; 3] {
    if n == 1 || ch.is_some_and(|c| c.transmitted) {
        return [1.0; 3];
    }
    if let Some(nm) = ch.and_then(|c| c.emission_nm).filter(|nm| (380.0..=800.0).contains(nm)) {
        return wavelength_rgb(nm);
    }
    if let Some(c) = ch.and_then(|c| c.color) {
        let m = c.iter().copied().max().unwrap_or(1).max(1) as f32;
        return c.map(|v| v as f32 / m);
    }
    PALETTE[k % PALETTE.len()]
}

/// The background level of a fluorescence channel: the most common value (in 256 buckets
/// between `lo` and `hi`) when it lies in the darker half of that range. None for a bright
/// background (transmitted light), where the stretch is left alone.
pub fn background_level(v: &[f32], lo: f32, hi: f32) -> Option<f32> {
    if hi <= lo || v.is_empty() {
        return None;
    }
    let mut hist = [0u64; 256];
    let k = 256.0 / (hi - lo);
    for &x in v {
        if x >= lo && x <= hi {
            hist[(((x - lo) * k) as usize).min(255)] += 1;
        }
    }
    let peak = hist.iter().enumerate().max_by_key(|(_, n)| **n).map(|(i, _)| i)?;
    let level = lo + (peak as f32 + 0.5) / k;
    (peak < 128 && level < hi).then_some(level)
}

// ---------------------------------------------------------------- the legacy (JPEG 2000) container

/// The top-level boxes of a JP2 file: (type, payload position, payload length).
pub fn jp2_boxes(f: &mut File) -> Result<Vec<([u8; 4], u64, u64)>, String> {
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut out = Vec::new();
    let mut p = 0u64;
    while p + 8 <= len {
        let h = read_exact_at(f, p, 16.min((len - p) as usize))?;
        let l32 = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let typ: [u8; 4] = h[4..8].try_into().unwrap();
        let (hl, bl) = match l32 {
            0 => (8, len - p),
            1 if h.len() >= 16 => (16, u64::from_be_bytes(h[8..16].try_into().unwrap())),
            1 => break,
            l => (8, l),
        };
        if bl < hl || p + bl > len {
            break;
        }
        out.push((typ, p + hl, bl - hl));
        p += bl;
    }
    Ok(out)
}

/// What a legacy file's `xml ` boxes hold, by their root element.
#[derive(Default)]
struct LegacyXml {
    calibration: Option<f64>,
    attributes: Option<Var>,
    experiment: Option<Var>,
    /// per sequence index: the frame's metadata
    seq: Vec<Var>,
}

fn legacy_xml(f: &mut File, boxes: &[([u8; 4], u64, u64)]) -> Result<LegacyXml, String> {
    let mut x = LegacyXml::default();
    let mut seq: Vec<(usize, Var)> = Vec::new();
    for (t, pos, len) in boxes {
        if t != b"xml " || *len > 64 << 20 {
            continue;
        }
        let b = read_exact_at(f, *pos, *len as usize)?;
        let text = String::from_utf8_lossy(&b[..b.len().min(400)]).to_string();
        let root = text.split("-->").last().unwrap_or("").trim_start();
        if root.starts_with("<CalibrationSeq") {
            if x.calibration.is_none() {
                x.calibration = parse_xml(&b).num_at("dCalibration");
            }
        } else if root.starts_with("<Calibration ") {
            if let Some(i) = String::from_utf8_lossy(&b).find("Calibration_11=\"") {
                let s = String::from_utf8_lossy(&b[i + 16..]).to_string();
                let v = s.split('"').next().and_then(|v| v.parse().ok());
                x.calibration = x.calibration.or(v);
            }
        } else if root.starts_with("<AdvancedImageAttributes") {
            x.attributes = Some(parse_xml(&b));
        } else if root.starts_with("<MetadataSeq") {
            let idx = root.split("_SEQUENCE_INDEX=\"").nth(1).and_then(|s| s.split('"').next()).and_then(|s| s.parse().ok()).unwrap_or(seq.len());
            seq.push((idx, parse_xml(&b)));
        } else if root.starts_with("<Metadata") {
            x.experiment = Some(parse_xml(&b));
        }
    }
    seq.sort_by_key(|s| s.0);
    x.seq = seq.into_iter().map(|s| s.1).collect();
    Ok(x)
}

// ---------------------------------------------------------------- the source

enum Frames {
    /// per sequence index: the frame chunk's data (position, length), timestamp included
    Modern { attrs: Attrs, frames: Vec<Option<(u64, u64)>> },
    /// JPEG 2000 codestreams, `per_frame` per sequence index (one per channel, or one for all)
    Legacy { streams: Vec<(u64, u64)>, per_frame: usize, width: u32, height: u32 },
}

/// A frame's pixels, ready to read rows from.
enum FrameData {
    File { file: File, start: u64 },
    Mem(Vec<u8>),
}

pub struct Nd2Source {
    path: String,
    info: SourceInfo,
    frames: Frames,
    /// the XY position shown (`SourceInfo::series_index`)
    series: usize,
    /// for each z position (slider order), its sequence index at the first time point (this
    /// XY position's frames)
    z_frames: Vec<usize>,
    /// for each time point, what it adds to the sequence index
    t_frames: Vec<usize>,
    /// for each ZPlane::index, its z position
    plane_pos: Vec<usize>,
    nominal: usize,
    channels: Vec<ChanMeta>,
    /// components per frame (channels, or 3 for RGB)
    comps: usize,
    /// an RGB camera image: shown as is (8-bit) or with one stretch for all three
    rgb: bool,
    eight_bit: bool,
    looks: OnceLock<Vec<ChanLook>>,
    planes: Mutex<PlaneCache>,
    build: Mutex<()>,
}

#[derive(Default)]
struct PlaneCache {
    /// (time point, z position) → (pyramid, bytes in memory, last use)
    map: HashMap<(usize, usize), (Arc<Pyramid>, u64, u64)>,
    clock: u64,
}

/// Frame size, components, depth and calibration, as either container gives them.
struct Geometry {
    w: u32,
    h: u32,
    comps: usize,
    bits: u32,
    mpp: Option<(f64, f64)>,
}

/// What maps (position, time, plane) to frames, and each frame's time (ms) by sequence index.
struct LoopMeta<'a> {
    loops: &'a [Loop],
    n_frames: usize,
    frame_z: &'a [f64],
    stamp: &'a mut dyn FnMut(usize) -> Option<f64>,
}

fn mpp_plausible(m: f64) -> bool {
    m.is_finite() && m > 0.001 && m <= MAX_PLAUSIBLE_MPP
}

impl Nd2Source {
    /// XY stage position number `series` of the file (`SourceInfo::series`; 0 is the first).
    pub fn open_series(path: &str, series: u32) -> Result<Nd2Source, String> {
        let mut f = File::open(path).map_err(|e| format!("{path}: {e}"))?;
        let head = read_exact_at(&mut f, 0, 12).map_err(|e| format!("{path}: {e}"))?;
        let series = series as usize;
        if u32_at(&head, 0) == Some(CHUNK_MAGIC) {
            Self::open_modern(path, &mut f, series)
        } else if head == JP2_SIGNATURE {
            Self::open_legacy(path, &mut f, series)
        } else {
            Err(format!("{path}: not an ND2 file"))
        }
    }

    pub fn open(path: &str) -> Result<Nd2Source, String> {
        Self::open_series(path, 0)
    }

    fn open_modern(path: &str, f: &mut File, series: usize) -> Result<Nd2Source, String> {
        let map = read_chunk_map(f).map_err(|e| format!("{path}: {e}"))?;
        let mut chunk = |names: &[&str]| -> Option<Vec<u8>> {
            let (pos, len) = names.iter().find_map(|n| map.get(*n))?;
            if *len > 256 << 20 {
                return None;
            }
            read_exact_at(f, *pos, *len as usize).ok()
        };
        let attrs_v = chunk(&["ImageAttributesLV!", "ImageAttributes!"]).map(|b| parse_meta(&b)).ok_or_else(|| format!("{path}: no ND2 image attributes"))?;
        let attrs = attrs_from(&attrs_v).map_err(|e| format!("{path}: {e}"))?;
        if attrs.compression == 1 {
            return Err(format!("{path}: unsupported: lossy-compressed ND2 frames"));
        }
        let calib = chunk(&["ImageCalibrationLV|0!", "ImageCalibration|0!"]).map(|b| parse_meta(&b));
        let seq0 = chunk(&["ImageMetadataSeqLV|0!", "ImageMetadataSeq|0!"]).map(|b| parse_meta(&b));
        let exp = chunk(&["ImageMetadataLV!", "ImageMetadata!"]).map(|b| parse_meta(&b));
        let frame_z: Vec<f64> = chunk(&["CustomData|Z!"]).map(|b| b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()).unwrap_or_default();

        // frames by sequence index
        let mut frames: Vec<Option<(u64, u64)>> = Vec::new();
        for (name, r) in &map {
            if let Some(n) = name.strip_prefix("ImageDataSeq|").and_then(|s| s.strip_suffix('!')).and_then(|s| s.parse::<usize>().ok()) {
                if n >= frames.len() {
                    frames.resize(n + 1, None);
                }
                frames[n] = Some(*r);
            }
        }
        if frames.first().copied().flatten().is_none() {
            return Err(format!("{path}: no image data in this ND2 file"));
        }
        let n_frames = frames.iter().take_while(|f| f.is_some()).count();

        let mpp = calib.as_ref().and_then(|c| c.num_at("dCalibration")).or_else(|| seq0.as_ref().and_then(|s| s.num_at("dCalibration")));
        let aspect = calib.as_ref().and_then(|c| c.num_at("dAspect")).filter(|a| a.is_finite() && *a > 0.0).unwrap_or(1.0);
        let channels = seq0.as_ref().map(channels_from).unwrap_or_default();
        let loops = exp.as_ref().map(loops_from).unwrap_or_default();
        let (w, h, comps, bits) = (attrs.width, attrs.height, attrs.comps, attrs.bits_in_memory);
        // each frame starts with its acquisition time (f64 ms)
        let mut stamp = |seq: usize| -> Option<f64> {
            let (pos, len) = frames.get(seq).copied().flatten()?;
            if len < 8 {
                return None;
            }
            read_exact_at(f, pos, 8).ok().map(|b| f64::from_le_bytes(b.try_into().unwrap()))
        };
        let g = Geometry { w, h, comps, bits, mpp: mpp.map(|m| (m, m * aspect)) };
        let meta = LoopMeta { loops: &loops, n_frames, frame_z: &frame_z, stamp: &mut stamp };
        let src = Frames::Modern { attrs, frames: frames.clone() };
        Self::finish(path, src, g, channels, meta, series)
    }

    fn open_legacy(path: &str, f: &mut File, series: usize) -> Result<Nd2Source, String> {
        let boxes = jp2_boxes(f).map_err(|e| format!("{path}: {e}"))?;
        let streams: Vec<(u64, u64)> = boxes.iter().filter(|b| &b.0 == b"jp2c").map(|b| (b.1, b.2)).collect();
        if streams.is_empty() {
            return Err(format!("{path}: no images in this ND2 file"));
        }
        let x = legacy_xml(f, &boxes)?;
        let seq0 = x.seq.first();
        let mut channels = seq0.map(channels_from).unwrap_or_default();
        let virt = x.attributes.as_ref().and_then(|a| a.num_at("VirtualComponents")).map(|v| v as usize).filter(|v| *v >= 1);
        // size, components and depth from the first codestream
        let first = read_exact_at(f, streams[0].0, streams[0].1 as usize)?;
        let s0 = decode_j2k_samples(&first).map_err(|e| format!("{path}: {e}"))?;
        let comps = virt.unwrap_or(channels.len().max(1)).max(s0.chans.len());
        // a colour codestream holds a whole frame; otherwise each channel is its own codestream
        let per_frame = if s0.chans.len() >= comps { 1 } else { comps };
        channels.truncate(comps);
        let n_frames = streams.len() / per_frame;
        if n_frames == 0 {
            return Err(format!("{path}: incomplete ND2 frame"));
        }
        let loops = x.experiment.as_ref().map(loops_from).unwrap_or_default();
        let frame_z: Vec<f64> = x.seq.iter().map(|s| s.num_at("dZPos").unwrap_or(f64::NAN)).collect();
        let bits = if s0.max > 255.0 { 16 } else { 8 };
        let mut stamp = |seq: usize| x.seq.get(seq).and_then(|s| s.num_at("dTimeMSec"));
        let g = Geometry { w: s0.w, h: s0.h, comps, bits, mpp: x.calibration.map(|m| (m, m)) };
        let meta = LoopMeta { loops: &loops, n_frames, frame_z: &frame_z, stamp: &mut stamp };
        let src = Frames::Legacy { streams, per_frame, width: s0.w, height: s0.h };
        Self::finish(path, src, g, channels, meta, series)
    }

    fn finish(path: &str, frames: Frames, g: Geometry, mut channels: Vec<ChanMeta>, meta: LoopMeta, series: usize) -> Result<Nd2Source, String> {
        let Geometry { w, h, comps, bits, mpp } = g;
        let LoopMeta { loops, n_frames, frame_z, stamp } = meta;
        if w as u64 * h as u64 > MAX_PIXELS {
            return Err(format!("{path}: image too large ({w} × {h})"));
        }
        // one plane of three components (a colour camera)
        let rgb = comps == 3 && (channels.len() == 1 && channels[0].comps == 3 || channels.is_empty() && bits == 8);
        if !rgb {
            while channels.len() < comps {
                channels.push(ChanMeta { name: format!("C{}", channels.len() + 1), color: None, emission_nm: None, transmitted: false, comps: 1 });
            }
            channels.truncate(comps);
        }

        // XY positions: one source each
        let nest = LoopNest::new(loops, n_frames);
        let n_pos = nest.count(Axis::Xy);
        if series >= n_pos {
            return Err(format!("{path}: stage position {} not found (the file has {n_pos})", series + 1));
        }
        let base = nest.frame(series, 0, 0);

        // time points: the first frame of each, this position
        let nt = nest.count(Axis::Time);
        let t_frames: Vec<usize> = (0..nt).map(|t| nest.offset(Axis::Time, t)).collect();
        let time_loop = nest.axis(Axis::Time).map(|k| &nest.loops[k]);
        let stamps: Vec<Option<f64>> = if nt > 1 { t_frames.iter().map(|o| stamp(base + o)).collect() } else { vec![] };
        let seconds = time_seconds(&stamps, time_loop, nt);

        // Z: planes in loop order → sorted bottom to top for the slider, middle one nominal
        let zl = z_layout_of(&nest);
        let zs = plane_z(&zl, frame_z.get(base..).unwrap_or(&[]));
        let mut order: Vec<usize> = (0..zl.count).collect();
        if zs.iter().all(Option::is_some) {
            order.sort_by(|&a, &b| zs[a].unwrap().total_cmp(&zs[b].unwrap()));
        }
        let nominal = (order.len() - 1) / 2;
        let offsets: Vec<Option<f64>> = if order.len() <= 1 {
            vec![]
        } else {
            let z0 = zs[order[nominal]];
            order.iter().map(|&k| zs[k].zip(z0).map(|(z, z0)| ((z - z0) * 1000.0).round())).collect()
        };
        let (z_planes, plane_pos) = make_planes(&offsets, nominal);
        let z_frames: Vec<usize> = order.iter().map(|&k| base + k * zl.stride).collect();

        let mut info = SourceInfo::basic("nd2", w as i64, h as i64);
        info.vendor = Some("nikon".into());
        if let Some((x, y)) = mpp.filter(|(x, y)| mpp_plausible(*x) && mpp_plausible(*y)) {
            info.mpp_x = x;
            info.mpp_y = y;
            info.calibrated = true;
        }
        info.z_planes = z_planes;
        info.levels = super::pyramid::level_sizes(w, h)
            .iter()
            .enumerate()
            .filter(|(k, l)| *k == 0 || l.0.max(l.1) >= TILE_SIZE)
            .map(|(k, l)| LevelInfo { width: l.0 as i64, height: l.1 as i64, downsample: (1u64 << k) as f64 })
            .collect();
        info.associated = vec!["thumbnail".into()];
        info.time_points = make_time_points(&seconds);
        if n_pos > 1 {
            let names = nest.axis(Axis::Xy).map(|k| nest.loops[k].names.as_slice()).unwrap_or(&[]);
            info.series = (0..n_pos).map(|i| names.get(i).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| format!("Position {}", i + 1))).collect();
        }
        info.series_index = series as u32;
        info.series_kind = "Position".into();
        Ok(Nd2Source {
            path: path.to_string(),
            info,
            frames,
            series,
            z_frames,
            t_frames,
            plane_pos,
            nominal,
            channels,
            comps,
            rgb,
            eight_bit: bits == 8,
            looks: OnceLock::new(),
            planes: Mutex::new(PlaneCache::default()),
            build: Mutex::new(()),
        })
    }

    /// Channel names and display colours (for logs and tests).
    pub fn channel_summary(&self) -> Vec<(String, [u8; 3])> {
        if self.rgb {
            return vec![("RGB".into(), [255, 255, 255])];
        }
        let n = self.channels.len();
        self.channels.iter().enumerate().map(|(k, c)| (c.name.clone(), channel_color(Some(c), k, n).map(|v| (v * 255.0).round() as u8))).collect()
    }

    /// Number of focal planes.
    pub fn z_count(&self) -> usize {
        self.z_frames.len()
    }

    // ------------------------------------------------ reading frames

    fn open_frame(&self, seq: usize) -> Result<FrameData, String> {
        let Frames::Modern { attrs, frames } = &self.frames else { return Err("not a chunked ND2".into()) };
        let (pos, len) = frames.get(seq).copied().flatten().ok_or_else(|| format!("ND2 frame {seq} is missing"))?;
        if len < 8 {
            return Err(format!("ND2 frame {seq} is empty"));
        }
        let mut file = File::open(&self.path).map_err(|e| format!("{}: {e}", self.path))?;
        if attrs.compression == 0 {
            file.seek(SeekFrom::Start(pos + 8)).map_err(|e| e.to_string())?;
            let mut v = Vec::new();
            flate2::read::ZlibDecoder::new(file.take(len - 8)).take(MAX_FRAME_BYTES).read_to_end(&mut v).map_err(|e| format!("ND2 frame {seq}: {e}"))?;
            return Ok(FrameData::Mem(v));
        }
        let need = (attrs.height as u64 - 1) * attrs.row_bytes as u64 + attrs.tight_row() as u64;
        if len - 8 < need {
            return Err(format!("ND2 frame {seq} is short"));
        }
        Ok(FrameData::File { file, start: pos + 8 })
    }

    /// Row stride of a frame's data (decompressed frames may be unpadded).
    fn stride(&self, fd: &FrameData) -> usize {
        let Frames::Modern { attrs, .. } = &self.frames else { return 0 };
        match fd {
            FrameData::Mem(v) if v.len() < attrs.height as usize * attrs.row_bytes => attrs.tight_row(),
            _ => attrs.row_bytes,
        }
    }

    /// Rows y0..y0+rows of an opened frame, per component.
    fn frame_rows(&self, fd: &mut FrameData, y0: u32, rows: u32) -> Result<Vec<Vec<f32>>, String> {
        let Frames::Modern { attrs, .. } = &self.frames else { return Err("not a chunked ND2".into()) };
        let stride = self.stride(fd);
        let n = (rows as usize - 1) * stride + attrs.tight_row();
        let off = y0 as usize * stride;
        match fd {
            FrameData::Mem(v) => {
                let b = v.get(off..off + n).ok_or("short ND2 frame")?;
                decode_rows(b, attrs, rows, stride)
            }
            FrameData::File { file, start } => {
                let b = read_exact_at(file, *start + off as u64, n)?;
                decode_rows(&b, attrs, rows, stride)
            }
        }
    }

    /// A whole legacy frame, per component.
    fn legacy_frame(&self, seq: usize) -> Result<(u32, u32, Vec<Vec<f32>>), String> {
        let Frames::Legacy { streams, per_frame, width, height } = &self.frames else { return Err("not a legacy ND2".into()) };
        let mut file = File::open(&self.path).map_err(|e| format!("{}: {e}", self.path))?;
        let mut chans = Vec::new();
        for k in 0..*per_frame {
            let (pos, len) = *streams.get(seq * per_frame + k).ok_or_else(|| format!("ND2 frame {seq} is missing"))?;
            let b = read_exact_at(&mut file, pos, len as usize)?;
            let s = decode_j2k_samples(&b)?;
            if (s.w, s.h) != (*width, *height) {
                return Err("ND2 frames of different sizes".into());
            }
            chans.extend(s.chans);
        }
        chans.truncate(self.comps);
        Ok((*width, *height, chans))
    }

    // ------------------------------------------------ display

    /// How each component is shown, measured on the nominal plane.
    fn looks(&self) -> Result<&Vec<ChanLook>, String> {
        if let Some(l) = self.looks.get() {
            return Ok(l);
        }
        let n = self.comps;
        let fixed = self.eight_bit && (self.rgb || n == 1);
        let mut samples: Vec<Vec<f32>> = vec![Vec::new(); n];
        if !fixed {
            let seq = self.z_frames[self.nominal];
            match &self.frames {
                Frames::Modern { attrs, .. } => {
                    let mut fd = self.open_frame(seq)?;
                    let (w, h) = (attrs.width as usize, attrs.height as usize);
                    let rows_wanted = (STRETCH_SAMPLES / w.max(1)).clamp(1, h);
                    let ystep = (h / rows_wanted).max(1);
                    let xstep = ((w * h.div_ceil(ystep)) / STRETCH_SAMPLES).max(1);
                    for y in (0..h).step_by(ystep) {
                        let row = self.frame_rows(&mut fd, y as u32, 1)?;
                        for (s, r) in samples.iter_mut().zip(row) {
                            s.extend(r.into_iter().step_by(xstep));
                        }
                    }
                }
                Frames::Legacy { .. } => {
                    let (_, _, chans) = self.legacy_frame(seq)?;
                    for (s, c) in samples.iter_mut().zip(chans) {
                        let step = (c.len() / STRETCH_SAMPLES).max(1);
                        s.extend(c.into_iter().step_by(step));
                    }
                }
            }
        }
        let full = if self.eight_bit { 255.0 } else { 65535.0 };
        let range = |v: &[f32]| if fixed { (0.0, 255.0) } else { auto_range(v).unwrap_or((0.0, full)) };
        let looks: Vec<ChanLook> = if self.rgb {
            let all: Vec<f32> = samples.concat();
            let (lo, hi) = range(&all);
            // colour cameras store B, G, R
            RGB_COMPONENTS.into_iter().enumerate().map(|(k, color)| ChanLook { pos: k as u32, color, lo, hi }).collect()
        } else {
            (0..n)
                .map(|k| {
                    let (mut lo, hi) = range(&samples[k]);
                    // fluorescence: the dark background is black, not a coloured haze
                    let transmitted = n == 1 && self.eight_bit || self.channels.get(k).is_some_and(|c| c.transmitted);
                    if !fixed && !transmitted && let Some(bg) = background_level(&samples[k], lo, hi) {
                        lo = bg;
                    }
                    ChanLook { pos: k as u32, color: channel_color(self.channels.get(k), k, n), lo, hi }
                })
                .collect()
        };
        let _ = self.looks.set(looks);
        Ok(self.looks.get().unwrap())
    }

    fn render(&self, w: u32, rows: u32, chans: &[Vec<f32>]) -> Result<RgbImage, String> {
        let looks = self.looks()?;
        let layers: Vec<(&ChanLook, &[f32])> = looks.iter().zip(chans).map(|(l, c)| (l, c.as_slice())).collect();
        composite(w, rows, &layers).ok_or_else(|| "ND2 frame without channels".into())
    }

    fn paint(&self, t: usize, zp: usize, c: &mut Canvas) -> Result<(), String> {
        let seq = self.z_frames[zp] + self.t_frames.get(t).copied().unwrap_or(0);
        match &self.frames {
            Frames::Modern { attrs, .. } => {
                let mut fd = self.open_frame(seq)?;
                let (w, h) = (attrs.width, attrs.height);
                // strips of about 32 MB of samples
                let strip = ((32usize << 20) / (w as usize * self.comps * 4).max(1)).clamp(1, 1024) as u32;
                let mut y = 0;
                while y < h {
                    let rows = strip.min(h - y);
                    let chans = self.frame_rows(&mut fd, y, rows)?;
                    let img = self.render(w, rows, &chans)?;
                    c.write_rect(0, y, w, rows, img.as_raw())?;
                    y += rows;
                }
            }
            Frames::Legacy { .. } => {
                let (w, h, chans) = self.legacy_frame(seq)?;
                let img = self.render(w, h, &chans)?;
                c.write_rect(0, 0, w, h, img.as_raw())?;
            }
        }
        Ok(())
    }

    /// Build (or fetch) the pyramid of time point `t`, z position `zp` (built on first use).
    fn plane(&self, t: usize, zp: usize) -> Result<Arc<Pyramid>, String> {
        let key = (t, zp);
        if let Some(p) = self.cached_plane(key) {
            return Ok(p);
        }
        let _g = self.build.lock().unwrap();
        if let Some(p) = self.cached_plane(key) {
            return Ok(p);
        }
        let (w, h) = (self.info.width as u32, self.info.height as u32);
        let big = w as u64 * h as u64 > MEM_PIXELS;
        let pyr = if big {
            let root = cache_dir("nd2");
            let file_dir = root.join(cache_key(&self.path));
            let name = if (self.series, t) == (0, 0) { format!("z{zp}") } else { format!("p{}-t{t}-z{zp}", self.series) };
            let dir = file_dir.join(&name);
            if let Some(p) = open_cached(&dir, w, h) {
                p
            } else {
                prune(&root, &self.path);
                prune_planes(&file_dir, &name);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(dir.join("complete"));
                let mut c = Canvas::disk(&dir.join("L0.rgb"), w, h)?;
                self.paint(t, zp, &mut c)?;
                let p = Pyramid::on_disk(c, &dir, MEM_PIXELS / 4)?;
                std::fs::write(dir.join("complete"), format!("{w} {h}")).map_err(|e| e.to_string())?;
                let _ = std::fs::write(dir.join("used"), b"");
                p
            }
        } else {
            let mut c = Canvas::Mem(RgbImage::new(w, h));
            self.paint(t, zp, &mut c)?;
            let Canvas::Mem(img) = c else { unreachable!() };
            Pyramid::in_memory(img)?
        };
        let pyr = Arc::new(pyr);
        let bytes = if big { (MEM_PIXELS / 4) * 4 } else { w as u64 * h as u64 * 4 };
        let mut pc = self.planes.lock().unwrap();
        pc.clock += 1;
        let now = pc.clock;
        pc.map.insert(key, (pyr.clone(), bytes, now));
        while pc.map.len() > 1 && pc.map.values().map(|v| v.1).sum::<u64>() > MEM_PLANE_BUDGET {
            let oldest = *pc.map.iter().min_by_key(|(_, v)| v.2).unwrap().0;
            pc.map.remove(&oldest);
        }
        Ok(pyr)
    }

    fn cached_plane(&self, key: (usize, usize)) -> Option<Arc<Pyramid>> {
        let mut pc = self.planes.lock().unwrap();
        pc.clock += 1;
        let now = pc.clock;
        pc.map.get_mut(&key).map(|e| {
            e.2 = now;
            e.0.clone()
        })
    }

    /// A tile `z` (plane + time, `split_z`) as (time point, z position).
    fn locate(&self, z: u32) -> Result<(usize, usize), String> {
        let (plane, t) = split_z(z);
        if t as usize >= self.t_frames.len().max(1) {
            return Err(format!("ND2 time point {} not found", t + 1));
        }
        Ok((t as usize, self.plane_pos.get(plane as usize).copied().unwrap_or(self.nominal)))
    }

    fn fitted(&self, max_px: u32, z: u32) -> Result<RgbImage, String> {
        let (t, zp) = self.locate(z)?;
        let pyr = self.plane(t, zp)?;
        let k = pyr.level_at_least(max_px);
        let (w, h) = pyr.levels[k].size();
        let img = pyr.crop(k, 0, 0, w, h)?;
        let (ow, oh) = fit(self.info.width, self.info.height, max_px);
        Ok(if (ow, oh) != (w, h) { image::imageops::resize(&img, ow, oh, FilterType::Triangle) } else { img })
    }
}

impl SlideSource for Nd2Source {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (_, _, _, _, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        let native = (dz_max_level(self.info.width, self.info.height) - level) as usize;
        let (t, zp) = self.locate(z)?;
        self.plane(t, zp)?.crop(native, x * TILE_SIZE, y * TILE_SIZE, tw, th)
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

/// Keep a file's most recently used plane pyramids (a long time series of a big image would
/// otherwise fill the disk); `building` is about to be made.
fn prune_planes(file_dir: &Path, building: &str) {
    let Ok(rd) = std::fs::read_dir(file_dir) else { return };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir() && e.file_name().to_string_lossy() != building)
        .map(|e| {
            let p = e.path();
            let used = std::fs::metadata(p.join("used")).or_else(|_| e.metadata()).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            (used, p)
        })
        .collect();
    if dirs.len() < KEEP_PLANES {
        return;
    }
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in dirs.into_iter().skip(KEEP_PLANES - 1) {
        let _ = std::fs::remove_dir_all(p);
    }
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

    // ------------------------------------------------ writing synthetic files

    /// LV item header: type, name length (UTF-16 units with the NUL), name.
    fn lv_head(t: u8, name: &str) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().chain([0]).collect();
        let mut b = vec![t, units.len() as u8];
        b.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        b
    }
    fn lv_u32(name: &str, v: u32) -> Vec<u8> {
        let mut b = lv_head(3, name);
        b.extend(v.to_le_bytes());
        b
    }
    fn lv_i32(name: &str, v: i32) -> Vec<u8> {
        let mut b = lv_head(2, name);
        b.extend(v.to_le_bytes());
        b
    }
    fn lv_f64(name: &str, v: f64) -> Vec<u8> {
        let mut b = lv_head(6, name);
        b.extend(v.to_le_bytes());
        b
    }
    fn lv_bool(name: &str, v: bool) -> Vec<u8> {
        let mut b = lv_head(1, name);
        b.push(v as u8);
        b
    }
    fn lv_str(name: &str, v: &str) -> Vec<u8> {
        let mut b = lv_head(8, name);
        b.extend(v.encode_utf16().chain([0]).flat_map(|u| u.to_le_bytes()));
        b
    }
    fn lv_bytes(name: &str, v: &[u8]) -> Vec<u8> {
        let mut b = lv_head(9, name);
        b.extend((v.len() as u64).to_le_bytes());
        b.extend_from_slice(v);
        b
    }
    /// A level: header, item count, length (from the item's start to the end of its items),
    /// the items, then the offsets table NIS-Elements writes after them.
    fn lv_level(name: &str, items: &[Vec<u8>]) -> Vec<u8> {
        let mut b = lv_head(11, name);
        let body: Vec<u8> = items.concat();
        let len = b.len() + 12 + body.len();
        b.extend((items.len() as u32).to_le_bytes());
        b.extend((len as u64).to_le_bytes());
        b.extend(body);
        let mut off = 0u64;
        for it in items {
            b.extend(off.to_le_bytes());
            off += it.len() as u64;
        }
        b
    }

    /// A chunk: header, name, data.
    fn chunk(name: &str, data: &[u8]) -> Vec<u8> {
        let mut b = CHUNK_MAGIC.to_le_bytes().to_vec();
        b.extend((name.len() as u32).to_le_bytes());
        b.extend((data.len() as u64).to_le_bytes());
        b.extend(name.as_bytes());
        b.extend_from_slice(data);
        b
    }

    /// A whole modern file from (name, data) chunks: signature chunk, the chunks, the map, the tail.
    fn nd2_file(chunks: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut f = chunk("ND2 FILE SIGNATURE CHUNK NAME01!", b"Ver3.0");
        let mut map = Vec::new();
        for (name, data) in chunks {
            let pos = f.len() as u64;
            let c = chunk(name, data);
            map.extend(name.as_bytes());
            map.extend(pos.to_le_bytes());
            map.extend((c.len() as u64).to_le_bytes());
            f.extend(c);
        }
        let map_pos = f.len() as u64;
        map.extend(MAP_SIGNATURE);
        map.extend(map_pos.to_le_bytes());
        map.extend(0u64.to_le_bytes());
        f.extend(chunk("ND2 FILEMAP SIGNATURE NAME 0001!", &map));
        f.extend(MAP_SIGNATURE);
        f.extend(map_pos.to_le_bytes());
        f
    }

    fn attributes(w: u32, h: u32, row_bytes: u32, comps: u32, bits: u32, frames: u32, compression: i32) -> Vec<u8> {
        lv_level(
            "SLxImageAttributes",
            &[
                lv_u32("uiWidth", w),
                lv_u32("uiWidthBytes", row_bytes),
                lv_u32("uiHeight", h),
                lv_u32("uiComp", comps),
                lv_u32("uiBpcInMemory", bits),
                lv_u32("uiBpcSignificant", bits),
                lv_u32("uiSequenceCount", frames),
                lv_i32("eCompression", compression),
                lv_u32("ePixelType", 1),
            ],
        )
    }

    /// One `sPlaneNew` entry (named `a<k>`) with an emission filter.
    fn plane(k: usize, name: &str, color: u32, emission: f64) -> Vec<u8> {
        let point = lv_level("Point0", &[lv_u32("eType", 4), lv_f64("dWavelength", emission)]);
        let spectrum = lv_level("m_EmissionSpectrum", &[lv_u32("uiCount", 1), lv_level("pPoint", &[point])]);
        let filter = lv_level("", &[lv_str("m_sName", "Custom"), spectrum]);
        lv_level(
            &format!("a{k}"),
            &[lv_u32("uiCompCount", 1), lv_level("pFilterPath", &[lv_level("m_pFilter", &[filter])]), lv_u32("uiColor", color), lv_str("sDescription", name)],
        )
    }

    fn metadata_seq(planes: Vec<Vec<u8>>) -> Vec<u8> {
        let n = planes.len() as u32;
        lv_level(
            "SLxPictureMetadata",
            &[lv_f64("dZPos", 100.0), lv_level("sPicturePlanes", &[lv_u32("uiCount", n), lv_u32("uiCompCount", n), lv_level("sPlaneNew", &planes)])],
        )
    }

    /// Time (2) > Z (3) > channels: 6 frames.
    fn experiment() -> Vec<u8> {
        let spect = lv_level("", &[lv_u32("eType", 6), lv_level("uLoopPars", &[lv_u32("uiCount", 2)])]);
        let z = lv_level(
            "",
            &[
                lv_u32("eType", 4),
                lv_level("uLoopPars", &[lv_u32("uiCount", 3), lv_f64("dZStep", 0.5), lv_bool("bZInverted", false)]),
                lv_level("ppNextLevelEx", &[spect]),
            ],
        );
        lv_level(
            "SLxExperiment",
            &[lv_u32("eType", 1), lv_level("uLoopPars", &[lv_u32("uiCount", 2), lv_f64("dPeriod", 1000.0)]), lv_bytes("pItemValid", &[1, 1]), lv_level("ppNextLevelEx", &[z])],
        )
    }

    /// One 2-channel, 16-bit frame: channel 0 bright on the left half, channel 1 on the right,
    /// `dim` divides the bright value; rows padded by `pad` bytes.
    fn frame_pixels(w: u32, h: u32, pad: usize, dim: u16) -> Vec<u8> {
        let mut b = Vec::new();
        for _y in 0..h {
            for x in 0..w {
                let left = x < w / 2;
                for c in 0..2 {
                    let on = left == (c == 0);
                    let v: u16 = if on { 4000 / dim } else { 100 + (x % 7) as u16 };
                    b.extend(v.to_le_bytes());
                }
            }
            b.extend(vec![0xEE; pad]);
        }
        b
    }

    fn synthetic(compression: i32) -> Vec<u8> {
        let (w, h, pad) = (40u32, 30u32, 4usize);
        let row = w * 2 * 2 + pad as u32;
        let mut chunks = vec![
            ("ImageAttributesLV!".to_string(), attributes(w, h, row, 2, 16, 6, compression)),
            ("ImageCalibrationLV|0!".to_string(), lv_level("SLxCalibration", &[lv_f64("dCalibration", 0.25), lv_f64("dAspect", 1.0), lv_bool("bValid", true)])),
            ("ImageMetadataLV!".to_string(), experiment()),
            ("ImageMetadataSeqLV|0!".to_string(), metadata_seq(vec![plane(0, "DAPI", 0xFF0000, 461.0), plane(1, "FITC", 0x00FF00, 520.0)])),
        ];
        // Z positions per frame (µm), bottom to top within each time point
        let zs: Vec<u8> = (0..6).flat_map(|i| (10.0 + (i % 3) as f64 * 0.5).to_le_bytes()).collect();
        chunks.push(("CustomData|Z!".to_string(), zs));
        for i in 0..6u16 {
            // frame i is time i/3, z i%3: the top plane (z 2) is dimmest
            let px = frame_pixels(w, h, if compression == 0 { 0 } else { pad }, 1 + i % 3);
            let body = if compression == 0 {
                use std::io::Write;
                let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
                e.write_all(&px).unwrap();
                e.finish().unwrap()
            } else {
                px
            };
            let mut data = (i as f64 * 10.0).to_le_bytes().to_vec();
            data.extend(body);
            chunks.push((format!("ImageDataSeq|{i}!"), data));
        }
        nd2_file(&chunks)
    }

    fn write_temp(name: &str, bytes: &[u8]) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("sv-nd2-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{name}.nd2"));
        std::fs::write(&p, bytes).unwrap();
        (dir, p.to_string_lossy().to_string())
    }

    // ------------------------------------------------ tests

    #[test]
    fn lv_parse() {
        let b = lv_level(
            "SLxImageAttributes",
            &[lv_u32("uiWidth", 164), lv_i32("eCompression", -1), lv_f64("dCalibration", 0.158), lv_str("sObjective", "Plan Apo 100x"), lv_bool("bValid", true), lv_bytes("pItemValid", &[1, 0, 1])],
        );
        let v = parse_lv(&b);
        let a = v.get("SLxImageAttributes").unwrap();
        assert_eq!(a.get("uiWidth"), Some(&Var::Int(164)));
        assert_eq!(a.get("eCompression"), Some(&Var::Int(-1)));
        assert_eq!(v.num_at("dCalibration"), Some(0.158));
        assert_eq!(v.find("sObjective").and_then(Var::text), Some("Plan Apo 100x"));
        assert_eq!(v.find("bValid"), Some(&Var::Bool(true)));
        assert_eq!(v.find("pItemValid"), Some(&Var::Bytes(vec![1, 0, 1])));
        // nested levels and the offset tables after them
        let nested = lv_level("A", &[lv_level("B", &[lv_u32("x", 1)]), lv_u32("y", 2)]);
        let v = parse_lv(&nested);
        assert_eq!(v.num_at("x"), Some(1.0));
        assert_eq!(v.find("A").unwrap().num_at("y"), Some(2.0));
        // truncated: keeps what it read
        let v = parse_lv(&b[..b.len() - 20]);
        assert!(v.find("SLxImageAttributes").is_none() || v.num_at("uiWidth") == Some(164.0));
        assert!(parse_lv(&[]).children().is_empty());
        assert!(parse_lv(&[11, 200, 1]).children().is_empty());
    }

    #[test]
    fn lv_compressed() {
        use std::io::Write;
        let inner = lv_level("L", &[lv_u32("uiCount", 9)]);
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(&inner).unwrap();
        let mut b = vec![76, 0];
        b.extend([0; 10]);
        b.extend(e.finish().unwrap());
        assert_eq!(parse_lv(&b).num_at("uiCount"), Some(9.0));
    }

    #[test]
    fn xml_parse() {
        let x = br#"<?xml version="1.0" encoding="UTF-8"?><variant version="1.0"><no_name runtype="CLxListVariant"><uiWidth runtype="lx_uint32" value="696"/><dCalibration runtype="double" value="0.1286"/><bValid runtype="bool" value="true"/><sDescription runtype="CLxStringW" value="405 &amp; GFP&#x000d;"/><sPlane runtype="CLxListVariant"><a0 runtype="X"><uiColor runtype="lx_uint32" value="65280"/></a0></sPlane></no_name></variant>"#;
        let v = parse_meta(x);
        assert_eq!(v.num_at("uiWidth"), Some(696.0));
        assert_eq!(v.num_at("dCalibration"), Some(0.1286));
        assert_eq!(v.find("bValid"), Some(&Var::Bool(true)));
        assert_eq!(v.find("sDescription").and_then(Var::text), Some("405 & GFP\r"));
        // no_name → ""
        assert!(v.find("variant").unwrap().get("").is_some());
        assert_eq!(v.find("sPlane").unwrap().get("a0").unwrap().num_at("uiColor"), Some(65280.0));
        // legacy boxes: a comment, then the document
        let legacy = b"<!--Laboratory Imaging generated xml-->\r\n<CalibrationSeq _SEQUENCE_INDEX=\"0\"><variant version=\"1.0\"><no_name runtype=\"CLxListVariant\"><dCalibration runtype=\"double\" value=\"0.5\"/></no_name></variant></CalibrationSeq>";
        assert_eq!(parse_meta(legacy).num_at("dCalibration"), Some(0.5));
        // unclosed elements don't lose what was read
        assert_eq!(parse_xml(b"<a><b runtype=\"lx_int32\" value=\"-3\"/>").num_at("b"), Some(-3.0));
    }

    #[test]
    fn chunk_map_parse() {
        let mut d = Vec::new();
        for (n, p, s) in [("ImageAttributesLV!", 100u64, 600u64), ("ImageDataSeq|0!", 4096, 1000)] {
            d.extend(n.as_bytes());
            d.extend(p.to_le_bytes());
            d.extend(s.to_le_bytes());
        }
        d.extend(MAP_SIGNATURE);
        d.extend(5000u64.to_le_bytes());
        d.extend(0u64.to_le_bytes());
        let m = parse_chunk_map(&d);
        assert_eq!(m, vec![("ImageAttributesLV!".to_string(), 100, 600), ("ImageDataSeq|0!".to_string(), 4096, 1000)]);
        assert_eq!(parse_chunk_map(&d[..40]).len(), 1, "a truncated map keeps the whole entries");
    }

    #[test]
    fn frame_decoding() {
        let v = parse_lv(&attributes(3, 2, 3 * 2 * 2 + 2, 2, 16, 1, 2));
        let a = attrs_from(&v).unwrap();
        assert_eq!((a.width, a.height, a.comps, a.row_bytes, a.tight_row()), (3, 2, 2, 14, 12));
        // two rows of (c0, c1) u16 pairs, each row padded by 2 bytes
        let mut b = Vec::new();
        for r in 0..2u16 {
            for x in 0..3u16 {
                b.extend((r * 10 + x).to_le_bytes());
                b.extend((1000 + r * 10 + x).to_le_bytes());
            }
            b.extend([0xFF, 0xFF]);
        }
        let ch = decode_rows(&b, &a, 2, 14).unwrap();
        assert_eq!(ch[0], vec![0.0, 1.0, 2.0, 10.0, 11.0, 12.0]);
        assert_eq!(ch[1], vec![1000.0, 1001.0, 1002.0, 1010.0, 1011.0, 1012.0]);
        assert!(decode_rows(&b[..20], &a, 2, 14).is_err());
        // 8-bit, three components
        let a8 = attrs_from(&parse_lv(&attributes(2, 1, 6, 3, 8, 1, 2))).unwrap();
        let ch = decode_rows(&[1, 2, 3, 4, 5, 6], &a8, 1, 6).unwrap();
        assert_eq!(ch, vec![vec![1.0, 4.0], vec![2.0, 5.0], vec![3.0, 6.0]]);
        // a row length smaller than the samples is ignored
        assert_eq!(attrs_from(&parse_lv(&attributes(2, 1, 1, 3, 8, 1, 2))).unwrap().row_bytes, 6);
        assert!(attrs_from(&parse_lv(&attributes(2, 1, 6, 3, 12, 1, 2))).is_err());
        assert!(attrs_from(&parse_lv(&attributes(0, 1, 6, 3, 8, 1, 2))).is_err());
    }

    #[test]
    fn loops_and_z() {
        let v = parse_lv(&experiment());
        let l = loops_from(&v);
        assert_eq!(l.iter().map(|l| (l.kind, l.count)).collect::<Vec<_>>(), vec![(LOOP_TIME, 2), (LOOP_Z, 3)]);
        assert_eq!(l[1].step_um, Some(0.5));
        let z = z_layout(&l, 6);
        assert_eq!((z.count, z.stride), (3, 1));
        // Z outside a 4-point XY loop
        let l2 = vec![Loop { kind: LOOP_Z, count: 5, step_um: Some(1.0), inverted: true, ..Default::default() }, lp(LOOP_XY, 4)];
        let z = z_layout(&l2, 20);
        assert_eq!((z.count, z.stride), (5, 4));
        // an interrupted acquisition: only the planes that exist
        assert_eq!(z_layout(&l2, 9).count, 2);
        assert_eq!(z_layout(&l2, 4).count, 1);
        assert_eq!(z_layout(&[], 7).count, 1);
        // positions per frame win over the step; the step's sign follows bZInverted
        let frame_z: Vec<f64> = (0..20).map(|i| 50.0 - (i / 4) as f64 * 2.0).collect();
        assert_eq!(plane_z(&z, &frame_z), vec![Some(50.0), Some(48.0), Some(46.0), Some(44.0), Some(42.0)]);
        assert_eq!(plane_z(&z, &[]), vec![Some(0.0), Some(-1.0), Some(-2.0), Some(-3.0), Some(-4.0)]);
        // XY validity flags
        let xy = lv_level("SLxExperiment", &[lv_u32("eType", 2), lv_level("uLoopPars", &[lv_u32("uiCount", 4)]), lv_bytes("pItemValid", &[1, 0, 0, 1])]);
        assert_eq!(loops_from(&parse_lv(&xy))[0].count, 2);
        // legacy: loops side by side
        let legacy = br#"<Metadata><variant><no_name><LoopNo00 runtype="RLxExperiment"><eType value="8"/><uLoopPars><no_name><uiCount value="7"/><x><uiCount value="99"/></x></no_name></uLoopPars></LoopNo00><LoopNo01 runtype="RLxExperiment"><eType value="4"/><uLoopPars><no_name><uiCount value="3"/><dZStep runtype="double" value="0.2"/></no_name></uLoopPars></LoopNo01></no_name></variant></Metadata>"#;
        let l = loops_from(&parse_xml(legacy));
        assert_eq!(l.iter().map(|l| (l.kind, l.count)).collect::<Vec<_>>(), vec![(LOOP_NE_TIME, 7), (LOOP_Z, 3)]);
    }

    fn lp(kind: i64, count: usize) -> Loop {
        Loop { kind, count, ..Default::default() }
    }

    /// An experiment loop: `eType`, `uLoopPars` (uiCount first, then `pars`), `extra` items,
    /// and the next level inside `ppNextLevelEx`.
    fn exp_loop(name: &str, kind: u32, count: u32, pars: Vec<Vec<u8>>, extra: Vec<Vec<u8>>, inner: Option<Vec<u8>>) -> Vec<u8> {
        let mut p = vec![lv_u32("uiCount", count)];
        p.extend(pars);
        let mut items = vec![lv_u32("eType", kind), lv_level("uLoopPars", &p)];
        items.extend(extra);
        if let Some(i) = inner {
            items.push(lv_level("ppNextLevelEx", &[i]));
        }
        lv_level(name, &items)
    }

    fn xy_points(names: &[&str]) -> Vec<u8> {
        let pts: Vec<Vec<u8>> = names.iter().map(|n| lv_level("", &[lv_f64("dPosX", 1.0), lv_f64("dPosY", 2.0), lv_str("dPosName", n)])).collect();
        lv_level("Points", &pts)
    }

    #[test]
    fn loop_nest_frames() {
        // time 3 > XY 2 > Z 4 (channels are components of a frame, not frames)
        let n = LoopNest::new(&[lp(LOOP_TIME, 3), lp(LOOP_XY, 2), lp(LOOP_Z, 4)], 24);
        assert_eq!(n.strides, vec![8, 4, 1]);
        assert_eq!((n.count(Axis::Time), n.count(Axis::Xy), n.count(Axis::Z)), (3, 2, 4));
        assert_eq!(n.frame(0, 0, 0), 0);
        assert_eq!(n.frame(1, 0, 0), 4);
        assert_eq!(n.frame(0, 1, 0), 8);
        assert_eq!(n.frame(1, 2, 3), 23);
        // XY 2 > time 3 > Z 4: a position's time points are contiguous
        let n = LoopNest::new(&[lp(LOOP_XY, 2), lp(LOOP_TIME, 3), lp(LOOP_Z, 4)], 24);
        assert_eq!((n.frame(1, 0, 0), n.frame(0, 1, 0), n.frame(1, 2, 3)), (12, 4, 23));
        // Z outside time (Z 3 > NE time 5), and no XY loop
        let n = LoopNest::new(&[lp(LOOP_Z, 3), lp(LOOP_NE_TIME, 5)], 15);
        assert_eq!((n.count(Axis::Xy), n.frame(0, 4, 0), n.frame(0, 0, 2), n.frame(0, 4, 2)), (1, 4, 10, 14));
        assert_eq!(z_layout(&[lp(LOOP_Z, 3), lp(LOOP_NE_TIME, 5)], 15).stride, 5);
        // time innermost: T 6 inside XY 3
        let n = LoopNest::new(&[lp(LOOP_XY, 3), lp(LOOP_TIME, 6)], 18);
        assert_eq!((n.frame(2, 0, 0), n.frame(2, 5, 0)), (12, 17));
        // an interrupted time series keeps only whole time points
        let n = LoopNest::new(&[lp(LOOP_TIME, 10), lp(LOOP_XY, 2), lp(LOOP_Z, 3)], 20);
        assert_eq!((n.count(Axis::Time), n.count(Axis::Xy), n.count(Axis::Z)), (3, 2, 3));
        // nothing at all: one of everything
        let n = LoopNest::new(&[], 1);
        assert_eq!((n.count(Axis::Time), n.count(Axis::Xy), n.count(Axis::Z), n.frame(0, 0, 0)), (1, 1, 1, 0));
        // a loop we don't know stays at its first item but still spaces the frames
        let n = LoopNest::new(&[lp(LOOP_TIME, 2), lp(7, 3)], 6);
        assert_eq!(n.frame(0, 1, 0), 3);
    }

    #[test]
    fn loops_from_metadata() {
        // time (period 2 s, measured 2.1 s) > XY (3 named points, the middle one skipped) > Z 2 > channels
        let spect = exp_loop("", 6, 2, vec![], vec![], None);
        let z = exp_loop("", 4, 2, vec![lv_f64("dZStep", 1.5)], vec![], Some(spect));
        let xy = exp_loop("", 2, 3, vec![xy_points(&["left", "mid", "right"])], vec![lv_bytes("pItemValid", &[1, 0, 1])], Some(z));
        let t = exp_loop("SLxExperiment", 1, 4, vec![lv_f64("dPeriod", 2000.0), lv_f64("dAvgPeriodDiff", 2100.0)], vec![], Some(xy));
        let l = loops_from(&parse_lv(&t));
        assert_eq!(l.iter().map(|l| (l.kind, l.count)).collect::<Vec<_>>(), vec![(LOOP_TIME, 4), (LOOP_XY, 2), (LOOP_Z, 2)]);
        assert_eq!(l[0].periods, vec![(4, 2100.0)]);
        assert_eq!(l[1].names, vec!["left".to_string(), "right".to_string()]);
        let n = LoopNest::new(&l, 16);
        assert_eq!((n.frame(1, 0, 0), n.frame(0, 1, 0), n.frame(1, 3, 1)), (2, 4, 15));
        // names that don't match the count are dropped
        let xy = exp_loop("SLxExperiment", 2, 3, vec![xy_points(&["only one"])], vec![], None);
        assert!(loops_from(&parse_lv(&xy))[0].names.is_empty());
        // NE time: the valid phases' intervals
        let ph = |n: u32, p: f64| lv_level("", &[lv_u32("uiCount", n), lv_f64("dStart", 0.0), lv_f64("dPeriod", p)]);
        let ne = exp_loop("SLxExperiment", 8, 9, vec![lv_level("pPeriod", &[ph(3, 1000.0), ph(6, 60000.0), ph(2, 5.0)]), lv_bytes("pPeriodValid", &[1, 1, 0])], vec![], None);
        assert_eq!(loops_from(&parse_lv(&ne))[0].periods, vec![(3, 1000.0), (6, 60000.0)]);
        // legacy XML: NE time > XY with a list of position names and boolean validity
        let legacy = br##"<Metadata><variant><no_name><LoopNo00 runtype="RLxExperiment"><eType value="8"/><uLoopPars><no_name><uiCount value="2"/><pPeriod><_00><uiCount runtype="lx_uint32" value="2"/><dPeriod runtype="double" value="30000.0"/></_00></pPeriod><pPeriodValid><_00 runtype="bool" value="true"/></pPeriodValid></no_name></uLoopPars></LoopNo00><LoopNo01 runtype="RLxExperiment"><eType value="2"/><uLoopPars><no_name><uiCount value="3"/><pPosName><_00 runtype="CLxStringW" value="#1"/><_01 runtype="CLxStringW" value="#2"/><_02 runtype="CLxStringW" value="#3"/></pPosName></no_name></uLoopPars><pItemValid><_00 runtype="bool" value="true"/><_01 runtype="bool" value="true"/><_02 runtype="bool" value="false"/></pItemValid></LoopNo01></no_name></variant></Metadata>"##;
        let l = loops_from(&parse_xml(legacy));
        assert_eq!(l.iter().map(|l| (l.kind, l.count)).collect::<Vec<_>>(), vec![(LOOP_NE_TIME, 2), (LOOP_XY, 2)]);
        assert_eq!(l[0].periods, vec![(2, 30000.0)]);
        assert_eq!(l[1].names, vec!["#1".to_string(), "#2".to_string()]);
    }

    #[test]
    fn times() {
        // frame timestamps (ms) win when they rise
        let s = time_seconds(&[Some(500.0), Some(2500.0), Some(4600.0)], None, 3);
        assert_eq!(s, vec![Some(0.0), Some(2.0), Some(4.1)]);
        // otherwise the loop's intervals: one phase, then two phases
        let one = Loop { periods: vec![(3, 10_000.0)], ..lp(LOOP_TIME, 3) };
        assert_eq!(time_seconds(&[Some(0.0), Some(0.0), Some(0.0)], Some(&one), 3), vec![Some(0.0), Some(10.0), Some(20.0)]);
        let two = Loop { periods: vec![(2, 1000.0), (3, 60_000.0)], ..lp(LOOP_NE_TIME, 5) };
        assert_eq!(time_seconds(&[], Some(&two), 5), vec![Some(0.0), Some(1.0), Some(61.0), Some(121.0), Some(181.0)]);
        // timestamps going backwards or missing, no interval: unknown
        assert_eq!(time_seconds(&[Some(5.0), Some(1.0)], Some(&lp(LOOP_TIME, 2)), 2), vec![None, None]);
        assert_eq!(time_seconds(&[None, Some(1.0)], None, 2), vec![None, None]);
        assert_eq!(time_seconds(&[Some(f64::NAN), Some(1.0)], None, 2), vec![None, None]);
    }

    /// XY 2 ("A", "B") > time 3 (5 s apart), no Z, two 16-bit channels; frame i's signal is
    /// divided by i + 1, so every (position, time) looks different.
    fn multipoint() -> Vec<u8> {
        let (w, h) = (40u32, 30u32);
        let t = exp_loop("", 1, 3, vec![lv_f64("dPeriod", 5000.0)], vec![], None);
        let xy = exp_loop("SLxExperiment", 2, 2, vec![xy_points(&["A", "B"])], vec![lv_bytes("pItemValid", &[1, 1])], Some(t));
        let mut chunks = vec![
            ("ImageAttributesLV!".to_string(), attributes(w, h, w * 4, 2, 16, 6, 2)),
            ("ImageMetadataLV!".to_string(), xy),
            ("ImageMetadataSeqLV|0!".to_string(), metadata_seq(vec![plane(0, "DAPI", 0xFF0000, 461.0), plane(1, "FITC", 0x00FF00, 520.0)])),
        ];
        for i in 0..6u16 {
            let mut data = (1000.0 + (i % 3) as f64 * 5000.0 + (i / 3) as f64 * 100.0).to_le_bytes().to_vec();
            data.extend(frame_pixels(w, h, 0, 1 + i));
            chunks.push((format!("ImageDataSeq|{i}!"), data));
        }
        nd2_file(&chunks)
    }

    #[test]
    fn multipoint_time_series_opens() {
        let (dir, p) = write_temp("multipoint", &multipoint());
        let max = dz_max_level(40, 30);
        let blue = |s: &Nd2Source, z: u32| s.tile(max, 0, 0, z).unwrap().get_pixel(2, 2).0[2];
        let a = Nd2Source::open(&p).unwrap();
        let i = a.info();
        assert_eq!((i.series.clone(), i.series_index, i.series_kind.as_str()), (vec!["A".to_string(), "B".to_string()], 0, "Position"));
        assert_eq!(i.time_points.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), vec!["0 s", "5 s", "10 s"]);
        assert_eq!(i.z_planes.len(), 1);
        let b = Nd2Source::open_series(&p, 1).unwrap();
        assert_eq!((b.info().series_index, b.info().time_points.len()), (1, 3));
        // frames 0..2 are A's time points, 3..5 B's: each one dimmer than the last
        let (a0, a2) = (blue(&a, 0), blue(&a, 2 * super::super::T_STRIDE));
        let (b0, b2) = (blue(&b, 0), blue(&b, 2 * super::super::T_STRIDE));
        assert!(a0 > a2 && b0 > b2, "time: {a0} {a2} {b0} {b2}");
        // each position is stretched on its own first frame: B fades from 1/4 to 1/6 (two thirds), A from 1 to 1/3
        assert!(b2 > a2, "positions differ: {a2} {b2}");
        assert_ne!(a.overview(20, super::super::T_STRIDE).unwrap(), a.overview(20, 0).unwrap());
        assert!(a.tile(max, 0, 0, 3 * super::super::T_STRIDE).is_err(), "no fourth time point");
        assert!(Nd2Source::open_series(&p, 2).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn background() {
        // mostly background at 100, a few bright cells at 3000
        let mut v = vec![100.0f32; 900];
        v.extend((0..100).map(|i| 2000.0 + i as f32 * 10.0));
        let bg = background_level(&v, 90.0, 3000.0).unwrap();
        assert!((bg - 100.0).abs() < 12.0, "{bg}");
        // a bright background (transmitted light) is left alone
        let mut b = vec![3000.0f32; 900];
        b.extend(vec![200.0; 100]);
        assert_eq!(background_level(&b, 200.0, 3000.0), None);
        assert_eq!(background_level(&[], 0.0, 1.0), None);
    }

    #[test]
    fn channel_metadata() {
        let v = parse_lv(&metadata_seq(vec![plane(0, "DAPI", 0xFF0000, 461.0), plane(1, "Cy5", 0x0000FF, 0.0)]));
        let c = channels_from(&v);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].name.as_str(), c[0].emission_nm, c[0].color), ("DAPI", Some(461.0), Some([0, 0, 255])));
        assert_eq!((c[1].emission_nm, c[1].color), (None, Some([255, 0, 0])));
        // colours: wavelength first, then the saved colour; one channel is grey
        assert_eq!(channel_color(Some(&c[0]), 0, 2), wavelength_rgb(461.0));
        assert_eq!(channel_color(Some(&c[1]), 1, 2), [1.0, 0.0, 0.0]);
        assert_eq!(channel_color(Some(&c[0]), 0, 1), [1.0; 3]);
        assert_eq!(channel_color(None, 1, 3), PALETTE[1]);
        // transmitted light is grey, whatever filter it went through
        let phase = ChanMeta { name: "phase 40x".into(), color: None, emission_nm: Some(525.0), transmitted: true, comps: 1 };
        assert_eq!(channel_color(Some(&phase), 0, 2), [1.0; 3]);
        assert!(is_transmitted_name("Jonas_DIC") && is_transmitted_name("Brightfield") && is_transmitted_name("TL-BF"));
        assert!(!is_transmitted_name("PSM_GFP") && !is_transmitted_name("DAPI") && !is_transmitted_name("Cy5"));
        let white = parse_lv(&metadata_seq(vec![plane(0, "C1", 0xFF_FFFF, 0.0)]));
        assert!(channels_from(&white)[0].transmitted);
        assert!(!c[0].transmitted);
        assert!(channels_from(&Var::Level(vec![])).is_empty());
    }

    /// A two-channel, three-plane 16-bit file end to end (raw and zlib frames).
    #[test]
    fn synthetic_file_opens() {
        for compression in [2, 0] {
            let (dir, p) = write_temp(&format!("c{compression}"), &synthetic(compression));
            let s = Nd2Source::open(&p).unwrap();
            let i = s.info();
            assert_eq!((i.width, i.height, i.calibrated, i.mpp_x), (40, 30, true, 0.25));
            assert_eq!(i.z_planes.iter().map(|z| (z.index, z.offset_nm)).collect::<Vec<_>>(), vec![(1, Some(-500.0)), (0, Some(0.0)), (2, Some(500.0))]);
            assert_eq!(s.z_count(), 3);
            assert_eq!(s.channel_summary()[0].0, "DAPI");
            let max = dz_max_level(40, 30);
            let t = s.tile(max, 0, 0, 0).unwrap();
            assert_eq!(t.dimensions(), (40, 30));
            let left = t.get_pixel(2, 2).0;
            let right = t.get_pixel(38, 2).0;
            assert!(left[2] > 200 && left[1] < 200, "DAPI half is blue: {left:?}");
            assert!(right[1] > 200 && right[2] < 100 && right[0] < 200, "FITC half is green: {right:?}");
            // the top plane (index 2) is dimmer with the same stretch
            let top = s.tile(max, 0, 0, 2).unwrap().get_pixel(2, 2).0;
            assert!(top[2] < left[2], "{top:?} vs {left:?}");
            assert_eq!(s.overview(20, 0).unwrap().dimensions(), (20, 15));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn rejects_other_files() {
        let (dir, p) = write_temp("bad", b"not an nd2 file at all, just text");
        assert!(Nd2Source::open(&p).is_err());
        // a modern file cut short loses its chunk map
        let f = synthetic(2);
        std::fs::write(&p, &f[..f.len() - 100]).unwrap();
        assert!(Nd2Source::open(&p).err().unwrap().contains("chunk map"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// a sample as `tools/fetch-format-samples.py` stores it (test-data/formats/ND2/<name>)
    fn sample(name: &str) -> Option<String> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats/ND2").join(name);
        p.exists().then(|| p.to_string_lossy().to_string())
    }

    /// Real files from the OME sample server (see tools/fetch-format-samples.py; not committed).
    /// `ND2_PNG_DIR=/tmp/x` saves each overview and the ends of each z-stack.
    #[test]
    #[ignore]
    fn real_nd2_samples() {
        // name, size, planes, components, mpp, time points, stage positions
        let want: [(&str, (i64, i64), usize, usize, f64, usize, usize); 6] = [
            ("BF007.nd2", (164, 156), 1, 1, 0.158389678930686, 0, 0),
            ("HE_002.nd2", (2880, 2048), 1, 3, 0.6, 0, 0),
            ("Experiment_0001.nd2", (1750, 1664), 17, 1, 0.05714285714285715, 0, 0),
            ("header_test1.nd2", (696, 520), 3, 2, 0.12863494437945, 7, 0),
            ("b16_14_12.nd2", (1280, 1024), 1, 2, 0.154799, 50, 0),
            ("N1_file_bugged_reconstructed-version.nd2", (2048, 2048), 1, 1, 0.032350865657703, 0, 5),
        ];
        for (name, (w, h), planes, comps, mpp, times, positions) in want {
            let Some(p) = sample(name) else {
                eprintln!("skip {name}: not downloaded");
                continue;
            };
            let s = Nd2Source::open(&p).unwrap();
            let i = s.info();
            eprintln!("{name}: {:?}, z {:?}", s.channel_summary(), i.z_planes.iter().map(|z| &z.label).collect::<Vec<_>>());
            eprintln!("  t {:?}, positions {:?}", i.time_points.iter().map(|t| &t.label).collect::<Vec<_>>(), i.series);
            assert_eq!((i.width, i.height, i.z_planes.len(), s.comps), (w, h, planes, comps), "{name}");
            assert!(i.calibrated && (i.mpp_x - mpp).abs() < 1e-9, "{name}: mpp {}", i.mpp_x);
            assert_eq!((i.time_points.len(), i.series.len()), (times, positions), "{name}");
            // times rise from 0 and the last time point looks different from the first
            if times > 1 {
                assert_eq!(i.time_points[0].seconds, Some(0.0), "{name}");
                assert!(i.time_points.windows(2).all(|w| w[1].seconds > w[0].seconds), "{name}: {:?}", i.time_points);
                let last = (times as u32 - 1) * super::super::T_STRIDE;
                assert_ne!(s.overview(256, 0).unwrap(), s.overview(256, last).unwrap(), "{name}: time points look the same");
                assert!(s.overview(256, times as u32 * super::super::T_STRIDE).is_err());
            }
            // every position opens, and they differ
            if positions > 1 {
                let first = s.overview(256, 0).unwrap();
                for k in 1..positions {
                    let other = Nd2Source::open_series(&p, k as u32).unwrap();
                    assert_eq!(other.info().series_index, k as u32);
                    assert_ne!(first, other.overview(256, 0).unwrap(), "{name}: position {k} looks like position 0");
                }
                assert!(Nd2Source::open_series(&p, positions as u32).is_err());
            }
            let o = s.overview(1024, 0).unwrap();
            let mean: f64 = o.as_raw().iter().map(|&v| v as f64).sum::<f64>() / o.as_raw().len() as f64;
            assert!(mean > 5.0 && mean < 250.0, "{name}: mean {mean}");
            if let Ok(d) = std::env::var("ND2_PNG_DIR") {
                o.save(Path::new(&d).join(format!("{name}.png"))).unwrap();
                if planes > 1 {
                    for z in [&i.z_planes[0], &i.z_planes[planes - 1]] {
                        s.overview(1024, z.index).unwrap().save(Path::new(&d).join(format!("{name}.z{}.png", z.index))).unwrap();
                    }
                }
            }
        }
    }
}
