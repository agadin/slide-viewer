//! Leica `.lif` (LAS AF / LAS X project files). Owner: formats builder.
//!
//! A LIF file is a container: a header block holding an XML description of every image in the
//! project, then one memory block of raw pixels per image. Each block starts with the test value
//! `0x70` (u32 LE), a u32 length and the byte `0x2A`. The header block then has a u32 count of
//! UTF-16 code units and the XML (UTF-16LE). A memory block has its data size (u64 in version 2
//! files, u32 in version 1), `0x2A`, a u32 count of UTF-16 code units and the block id
//! (`MemBlock_233`), then the data. Layout as documented by Christoph Gohlke's `liffile` (BSD-3)
//! and Bio-Formats' `LIFReader` (both read for reference; this is an independent implementation).
//!
//! The XML: `<Element Name="…"><Data><Image><ImageDescription>` holds `<Channels>` (one
//! `<ChannelDescription Resolution LUTName BytesInc>` per channel) and `<Dimensions>` (one
//! `<DimensionDescription DimID NumberOfElements Length Unit BytesInc>` per axis: 1 X, 2 Y, 3 Z,
//! 4 T, 10 mosaic tile). The element's `<Memory MemoryBlockID>` names its pixels. A sample's byte
//! offset in the block is the sum of each index × its axis's `BytesInc`, plus the channel's
//! `BytesInc`. Mosaics (TileScan) list `<Tile FieldX FieldY PosX PosY>` (stage position, metres)
//! in an `<Attachment Name="TileScanInfo">`. An image's `<TimeStampList>` holds one FILETIME
//! (hex, 100 ns ticks) per frame (channel × every non-XY axis) in storage order.
//!
//! Display (as `zvi.rs`):
//! - series: every image the reader can show (pixels in the file, a layout that fits its block,
//!   not too large), each opened on its own (`open_series`) without reading the others' pixels.
//!   Series 0 is the main image: the largest displayed XY area (a mosaic counts its placed
//!   extent), the first one in the XML on a tie; the rest follow in file order. Each is named
//!   by its element name, or by its path in the project ("Position 1/Cell 1") when the name
//!   repeats;
//! - pixel size: X/Y `Length` / (`NumberOfElements` − 1) (Length runs from the first to the last
//!   pixel centre), converted to µm;
//! - Z: focal planes with µm offsets from the Z length, the middle plane nominal;
//! - T: every time point (tile z = plane + t × `T_STRIDE`), timed from the TimeStampList (a time
//!   point starts at its earliest frame), else evenly over the T `Length`, else unlabelled;
//!   other axes: their first index;
//! - channels: each stretched (0.1 % → 99.9 % percentiles of the nominal plane, black point at a
//!   dark background) and summed in its `LUTName` colour; three 8-bit Red/Green/Blue channels are
//!   a colour (brightfield) image and shown as is;
//! - mosaics: tiles placed by stage position / pixel size, else by FieldX/FieldY × tile size;
//!   without either only the first tile is shown;
//! - every focal plane becomes a Deep-Zoom pyramid (`pyramid.rs`), on disk for big mosaics.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use image::{imageops::FilterType, RgbImage};

use super::bif::parse_xml;
use super::cache::{cache_dir, file_key};
use super::plain::{MAX_PIXELS, MAX_PLAUSIBLE_MPP, MEM_PIXELS};
use super::pyramid::{Canvas, Pyramid};
use super::zvi::{background_peak, percentile_range, stretch_lut};
use super::{dz_max_level, dz_tile_rect, fit, make_planes, make_time_points, split_z, LevelInfo, SlideSource, SourceInfo, TILE_SIZE};

/// Planes whose pyramids stay in memory, by total bytes (older planes are dropped and rebuilt).
const MEM_PLANE_BUDGET: u64 = 384 << 20;
/// Bump when the rendering (stretch, colours, layout) changes, so cached mosaics are rebuilt.
const RENDER_VERSION: u32 = 1;
/// Disk pyramids kept in the cache (oldest are removed).
const KEEP_DISK: usize = 6;
const STRETCH_LO: f64 = 0.001;
const STRETCH_HI: f64 = 0.999;
/// Largest XML header we accept (UTF-16 code units).
const MAX_XML_UNITS: u32 = 256 << 20;

const DIM_X: u32 = 1;
const DIM_Y: u32 = 2;
const DIM_Z: u32 = 3;
const DIM_T: u32 = 4;
const DIM_TILE: u32 = 10;

// ---------------------------------------------------------------- container (pure)

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], p: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(p..p + 8)?.try_into().ok()?))
}

fn utf16(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units)
}

/// The first 13 bytes of the file → the XML length in UTF-16 code units.
pub fn parse_lead(b: &[u8]) -> Result<u32, String> {
    if u32_at(b, 0) != Some(0x70) || b.get(8) != Some(&0x2A) {
        return Err("not a Leica LIF file".into());
    }
    let n = u32_at(b, 9).ok_or("not a Leica LIF file (truncated)")?;
    if n == 0 || n > MAX_XML_UNITS {
        return Err(format!("LIF header: implausible XML length {n}"));
    }
    Ok(n)
}

/// A memory block's header at the start of `b` (at least 17 bytes, more for the id):
/// (block id, data size, header length). `wide`: u64 size (version 2) instead of u32.
pub fn parse_block_header(b: &[u8], wide: bool) -> Option<(String, u64, usize)> {
    if u32_at(b, 0)? != 0x70 || *b.get(8)? != 0x2A {
        return None;
    }
    let (size, p) = if wide { (u64_at(b, 9)?, 17) } else { (u32_at(b, 9)? as u64, 13) };
    if *b.get(p)? != 0x2A {
        return None;
    }
    let n = u32_at(b, p + 1)? as usize;
    let id = utf16(b.get(p + 5..p + 5 + 2 * n)?);
    Some((id, size, p + 5 + 2 * n))
}

/// Where a memory block's data is in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    pub offset: u64,
    pub size: u64,
}

/// Read the XML and index the memory blocks (by id) after it.
fn read_container(f: &mut File) -> Result<(String, HashMap<String, Block>), String> {
    let file_len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut lead = [0u8; 13];
    f.read_exact(&mut lead).map_err(|_| "not a Leica LIF file (too short)")?;
    let n = parse_lead(&lead)?;
    if 13 + 2 * n as u64 > file_len {
        return Err("LIF header: truncated XML".into());
    }
    let mut x = vec![0u8; 2 * n as usize];
    f.read_exact(&mut x).map_err(|e| e.to_string())?;
    let xml = utf16(&x);
    let mut pos = 13 + 2 * n as u64;
    // the size field's width comes from the XML's version, checked against the next 0x2A
    let cut = xml.char_indices().nth(4096).map(|(i, _)| i).unwrap_or(xml.len());
    let version = parse_xml(&xml[..cut])
        .into_iter()
        .find(|e| e.name == "LMSDataContainerHeader")
        .and_then(|e| e.attr("Version").and_then(|v| v.trim().parse::<u32>().ok()))
        .unwrap_or(2);
    let mut wide: Option<bool> = None;
    let mut blocks = HashMap::new();
    let mut head = vec![0u8; 512];
    while pos + 13 <= file_len {
        f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        let got = read_up_to(f, &mut head)?;
        let b = &head[..got];
        let parsed = match wide {
            Some(w) => parse_block_header(b, w),
            None => {
                let first = version >= 2;
                let r = parse_block_header(b, first).map(|r| (r, first)).or_else(|| parse_block_header(b, !first).map(|r| (r, !first)));
                r.map(|(r, w)| {
                    wide = Some(w);
                    r
                })
            }
        };
        // a truncated or damaged tail: keep the blocks read so far
        let Some((id, size, hl)) = parsed else { break };
        let offset = pos + hl as u64;
        if offset + size > file_len {
            break;
        }
        blocks.insert(id, Block { offset, size });
        pos = offset + size;
    }
    Ok((xml, blocks))
}

fn read_up_to(f: &mut File, buf: &mut [u8]) -> Result<usize, String> {
    let mut got = 0;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(got)
}

// ---------------------------------------------------------------- XML (pure)

#[derive(Debug, Clone, PartialEq)]
pub struct Dim {
    pub id: u32,
    pub n: u64,
    pub length: f64,
    pub unit: String,
    pub inc: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Chan {
    pub lut: String,
    /// bits per sample
    pub resolution: u32,
    pub inc: u64,
}

/// One `<Tile>` of a TileScanInfo.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TileInfo {
    pub field: Option<(i64, i64)>,
    /// stage position, metres
    pub pos: Option<(f64, f64)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct LifImage {
    pub name: String,
    /// the element's place in the project: enclosing folder elements' names and its own, joined
    /// by "/" (the project element itself left out)
    pub path: String,
    pub dims: Vec<Dim>,
    pub channels: Vec<Chan>,
    pub memory_id: String,
    pub memory_size: u64,
    pub tiles: Vec<TileInfo>,
    pub flip_x: bool,
    pub flip_y: bool,
    pub swap_xy: bool,
    /// `<TimeStampList>`: one FILETIME (100 ns ticks) per frame, in storage order
    pub stamps: Vec<u64>,
}

/// The text of every `<TimeStampList>` element, in document order (empty for `<TimeStampList/>`).
fn timestamp_texts(xml: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = xml[i..].find('<') {
        let at = i + p;
        let rest = &xml[at..];
        if rest.starts_with("<!--") {
            i = rest.find("-->").map(|q| at + q + 3).unwrap_or(xml.len());
            continue;
        }
        i = at + 1;
        let Some(after) = rest.strip_prefix("<TimeStampList") else { continue };
        if !after.starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/') {
            continue;
        }
        let Some(gt) = after.find('>') else { break };
        if after[..gt].trim_end().ends_with('/') {
            out.push("");
            continue;
        }
        let body = &after[gt + 1..];
        let end = body.find("</TimeStampList").unwrap_or(body.len());
        out.push(&body[..end]);
    }
    out
}

/// LAS X 2+ writes a `<TimeStampList>` as space-separated hex FILETIMEs.
pub fn parse_stamps(text: &str) -> Vec<u64> {
    text.split_whitespace().map_while(|t| u64::from_str_radix(t, 16).ok()).collect()
}

/// Every image the XML describes, in document order.
pub fn parse_images(xml: &str) -> Vec<LifImage> {
    let els = parse_xml(xml);
    let name_is = |i: Option<usize>, n: &str| i.map(|i| els[i].name == n).unwrap_or(false);
    let parent = |i: usize| els[i].parent;
    // owner: the nearest enclosing <Element>
    let owner = |mut i: usize| -> Option<usize> {
        while let Some(p) = els[i].parent {
            if els[p].name == "Element" {
                return Some(p);
            }
            i = p;
        }
        None
    };
    let mut by_owner: HashMap<usize, LifImage> = HashMap::new();
    let mut has_desc: Vec<usize> = Vec::new();
    let texts = timestamp_texts(xml);
    let mut n_lists = 0;
    for (i, e) in els.iter().enumerate() {
        let num = |k: &str| e.attr(k).and_then(|v| v.trim().parse::<f64>().ok());
        let int = |k: &str| e.attr(k).and_then(|v| v.trim().parse::<i64>().ok());
        let flag = |k: &str| e.attr(k).map(|v| v.trim() == "1").unwrap_or(false);
        match e.name.as_str() {
            "ImageDescription" if name_is(parent(i), "Image") => {
                if let Some(o) = owner(i) {
                    has_desc.push(o);
                }
            }
            "ChannelDescription" if name_is(parent(i).and_then(parent), "ImageDescription") => {
                let Some(o) = owner(i) else { continue };
                by_owner.entry(o).or_default().channels.push(Chan {
                    lut: e.attr("LUTName").unwrap_or("").trim().to_string(),
                    resolution: int("Resolution").unwrap_or(8).clamp(1, 64) as u32,
                    inc: int("BytesInc").unwrap_or(0).max(0) as u64,
                });
            }
            "DimensionDescription" if name_is(parent(i).and_then(parent), "ImageDescription") => {
                let Some(o) = owner(i) else { continue };
                by_owner.entry(o).or_default().dims.push(Dim {
                    id: int("DimID").unwrap_or(0).max(0) as u32,
                    n: int("NumberOfElements").unwrap_or(1).max(1) as u64,
                    length: num("Length").unwrap_or(0.0),
                    unit: e.attr("Unit").unwrap_or("").trim().to_string(),
                    inc: int("BytesInc").unwrap_or(0).max(0) as u64,
                });
            }
            "Memory" if name_is(parent(i), "Element") => {
                let img = by_owner.entry(parent(i).unwrap()).or_default();
                img.memory_id = e.attr("MemoryBlockID").unwrap_or("").trim().to_string();
                img.memory_size = int("Size").unwrap_or(0).max(0) as u64;
            }
            "Attachment" if e.attr("Name") == Some("TileScanInfo") && name_is(parent(i), "Image") => {
                let Some(o) = owner(i) else { continue };
                let img = by_owner.entry(o).or_default();
                img.flip_x = flag("FlipX");
                img.flip_y = flag("FlipY");
                img.swap_xy = flag("SwapXY");
            }
            "TimeStampList" => {
                let text = texts.get(n_lists).copied().unwrap_or("");
                n_lists += 1;
                if !name_is(parent(i), "Image") {
                    continue;
                }
                let Some(o) = owner(i) else { continue };
                by_owner.entry(o).or_default().stamps = parse_stamps(text);
            }
            // LAS AF 1.x: <TimeStampList><TimeStamp HighInteger LowInteger/>…
            "TimeStamp" if name_is(parent(i), "TimeStampList") && name_is(parent(i).and_then(parent), "Image") => {
                let Some(o) = owner(i) else { continue };
                if let (Some(hi), Some(lo)) = (int("HighInteger"), int("LowInteger")) {
                    by_owner.entry(o).or_default().stamps.push(((hi as u64) << 32) | (lo as u64 & 0xFFFF_FFFF));
                }
            }
            "Tile" if name_is(parent(i), "Attachment") && els[parent(i).unwrap()].attr("Name") == Some("TileScanInfo") => {
                let Some(o) = owner(i) else { continue };
                let field = int("FieldX").zip(int("FieldY"));
                let pos = num("PosX").zip(num("PosY")).filter(|(x, y)| x.is_finite() && y.is_finite());
                by_owner.entry(o).or_default().tiles.push(TileInfo { field, pos });
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for o in has_desc {
        let Some(mut img) = by_owner.remove(&o) else { continue };
        img.name = els[o].attr("Name").unwrap_or("").to_string();
        // enclosing elements, outermost first; the outermost one is the project itself
        let mut chain = vec![img.name.clone()];
        let mut a = owner(o);
        while let Some(p) = a {
            chain.push(els[p].attr("Name").unwrap_or("").to_string());
            a = owner(p);
        }
        if chain.len() > 1 {
            chain.pop();
        }
        chain.reverse();
        img.path = chain.join("/");
        out.push(img);
    }
    out
}

/// A length in µm, from a value and its unit (Leica writes metres).
pub fn to_um(v: f64, unit: &str) -> f64 {
    v * match unit {
        "mm" => 1e3,
        "um" | "µm" | "\u{3bc}m" => 1.0,
        "nm" => 1e-3,
        _ => 1e6,
    }
}

/// Bits → bytes per sample.
fn sample_bytes(resolution: u32) -> u64 {
    if resolution <= 8 { 1 } else { 2 }
}

impl LifImage {
    pub fn dim(&self, id: u32) -> Option<&Dim> {
        self.dims.iter().find(|d| d.id == id)
    }
    pub fn size(&self, id: u32) -> u64 {
        self.dim(id).map(|d| d.n).unwrap_or(1)
    }
    pub fn width(&self) -> u64 {
        self.size(DIM_X)
    }
    pub fn height(&self) -> u64 {
        self.size(DIM_Y)
    }
    /// Distance between neighbouring samples along an axis, µm (signed; None without a length).
    pub fn step_um(&self, id: u32) -> Option<f64> {
        let d = self.dim(id)?;
        if d.n < 2 || d.length == 0.0 || !d.length.is_finite() {
            return None;
        }
        Some(to_um(d.length, &d.unit) / (d.n - 1) as f64)
    }
    pub fn mpp(&self) -> Option<(f64, f64)> {
        let x = self.step_um(DIM_X)?.abs();
        let y = self.step_um(DIM_Y).map(f64::abs).unwrap_or(x);
        let ok = |m: f64| m.is_finite() && m > 0.001 && m <= MAX_PLAUSIBLE_MPP;
        (ok(x) && ok(y)).then_some((x, y))
    }
    /// Bytes per sample (all channels must agree).
    pub fn bytes_per_sample(&self) -> Result<u64, String> {
        let b = self.channels.first().map(|c| sample_bytes(c.resolution)).ok_or("no channels")?;
        if self.channels.iter().any(|c| sample_bytes(c.resolution) != b) {
            return Err("channels of different bit depths".into());
        }
        Ok(b)
    }
    /// Byte offset of sample (0, 0) of channel `c`, focal plane `z`, mosaic tile `m` and time
    /// point `t` (first index of every other axis).
    pub fn plane_offset(&self, c: usize, z: u64, m: u64, t: u64) -> u64 {
        let inc = |id: u32| self.dim(id).map(|d| d.inc).unwrap_or(0);
        self.channels[c].inc + z * inc(DIM_Z) + m * inc(DIM_TILE) + t * inc(DIM_T)
    }
    /// Seconds since the first time point, per time point: from the `<TimeStampList>` (one stamp
    /// per frame in storage order; a time point starts at its earliest frame), else from the T
    /// axis' `Length` (evenly spaced), else None.
    pub fn time_seconds(&self) -> Vec<Option<f64>> {
        let nt = self.size(DIM_T);
        if nt <= 1 {
            return vec![None; nt as usize];
        }
        if let Some(s) = self.stamp_times(nt) {
            return s.into_iter().map(Some).collect();
        }
        let d = self.dim(DIM_T).unwrap();
        let scale = match d.unit.as_str() {
            "s" | "" => 1.0,
            "ms" => 1e-3,
            "min" => 60.0,
            "h" => 3600.0,
            _ => f64::NAN,
        };
        let step = d.length * scale / (nt - 1) as f64;
        if step.is_finite() && step > 0.0 {
            (0..nt).map(|t| Some(t as f64 * step)).collect()
        } else {
            vec![None; nt as usize]
        }
    }
    fn stamp_times(&self, nt: u64) -> Option<Vec<f64>> {
        let st = &self.stamps;
        if st.is_empty() || self.channels.is_empty() {
            return None;
        }
        // the t of each stamp: one stamp per time point, or one per frame (channel × every
        // non-XY axis), frames in storage (byte offset) order
        let ts: Vec<u64> = if st.len() as u64 == nt {
            (0..nt).collect()
        } else {
            let axes: Vec<&Dim> = self.dims.iter().filter(|d| d.id != DIM_X && d.id != DIM_Y).collect();
            let frames = axes.iter().try_fold(self.channels.len() as u64, |a, d| a.checked_mul(d.n))?;
            if frames != st.len() as u64 {
                return None;
            }
            let mut f: Vec<(u64, u64)> = Vec::with_capacity(frames as usize);
            for k in 0..frames {
                let (mut r, mut off, mut t) = (k, 0u64, 0u64);
                for d in &axes {
                    let i = r % d.n;
                    r /= d.n;
                    off += i * d.inc;
                    if d.id == DIM_T {
                        t = i;
                    }
                }
                f.push((off + self.channels[r as usize].inc, t));
            }
            f.sort_by_key(|x| x.0);
            f.into_iter().map(|x| x.1).collect()
        };
        let mut first = vec![u64::MAX; nt as usize];
        for (&s, &t) in st.iter().zip(&ts) {
            first[t as usize] = first[t as usize].min(s);
        }
        let t0 = first[0];
        if first.iter().any(|&s| s == u64::MAX || s < t0) || first.iter().all(|&s| s == t0) {
            return None;
        }
        Some(first.iter().map(|&s| (s - t0) as f64 * 1e-7).collect())
    }
    /// Bytes one XY plane spans from its first sample.
    pub fn plane_span(&self) -> Result<u64, String> {
        let bps = self.bytes_per_sample()?;
        let (xi, yi) = (self.dim(DIM_X).map(|d| d.inc).unwrap_or(0), self.dim(DIM_Y).map(|d| d.inc).unwrap_or(0));
        Ok((self.width() - 1) * xi + (self.height() - 1) * yi + bps)
    }
    /// Check the layout: strides, sizes and that the last sample read lies inside the block.
    pub fn validate(&self, block_size: u64) -> Result<(), String> {
        let bps = self.bytes_per_sample()?;
        let (Some(x), Some(_)) = (self.dim(DIM_X), self.dim(DIM_Y)) else {
            return Err("no X/Y dimensions".into());
        };
        if x.inc < bps {
            return Err(format!("X stride {} is smaller than a sample", x.inc));
        }
        if self.width() > u32::MAX as u64 || self.height() > u32::MAX as u64 {
            return Err("image too large".into());
        }
        let last = (0..self.channels.len())
            .map(|c| self.plane_offset(c, self.size(DIM_Z) - 1, self.size(DIM_TILE) - 1, self.size(DIM_T) - 1))
            .max()
            .unwrap_or(0);
        if last + self.plane_span()? > block_size {
            return Err(format!("pixel block too small ({block_size} bytes)"));
        }
        Ok(())
    }
    /// Three 8-bit channels coloured Red, Green and Blue: an RGB (brightfield) image.
    pub fn is_rgb(&self) -> bool {
        let mut l: Vec<String> = self.channels.iter().map(|c| c.lut.to_ascii_lowercase()).collect();
        l.sort();
        self.channels.len() == 3 && self.channels.iter().all(|c| c.resolution <= 8) && l == ["blue", "green", "red"]
    }
}

/// A channel colour from its LUT name.
pub fn lut_color(name: &str) -> Option<[u8; 3]> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "red" => [255, 0, 0],
        "green" => [0, 255, 0],
        "blue" => [0, 0, 255],
        "gray" | "grey" => [255, 255, 255],
        "cyan" => [0, 255, 255],
        "magenta" => [255, 0, 255],
        "yellow" => [255, 255, 0],
        _ => return None,
    })
}

/// Colours for channels whose LUT isn't a plain colour: green, red, blue, then the mixes.
const DEFAULT_COLORS: [[u8; 3]; 6] = [[0, 255, 0], [255, 0, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 0]];

/// Where each mosaic tile's top-left goes (level-0 px): stage positions / pixel size, else the
/// field grid × tile size, else only the first tile at (0, 0). Returns (tile index, x, y).
pub fn layout_tiles(img: &LifImage, mpp: Option<(f64, f64)>) -> Vec<(u64, u32, u32)> {
    let m = img.size(DIM_TILE);
    let (w, h) = (img.width() as f64, img.height() as f64);
    if m <= 1 {
        return vec![(0, 0, 0)];
    }
    let tiles = &img.tiles;
    let pts: Option<Vec<(f64, f64)>> = if tiles.len() as u64 != m {
        None
    } else if let (Some((mx, my)), true) = (mpp, tiles.iter().all(|t| t.pos.is_some())) {
        Some(
            tiles
                .iter()
                .map(|t| {
                    let (mut x, mut y) = t.pos.unwrap();
                    if img.swap_xy {
                        (x, y) = (y, x);
                    }
                    (if img.flip_x { -x } else { x } * 1e6 / mx, if img.flip_y { -y } else { y } * 1e6 / my)
                })
                .collect(),
        )
    } else if tiles.iter().all(|t| t.field.is_some()) {
        Some(tiles.iter().map(|t| (t.field.unwrap().0 as f64 * w, t.field.unwrap().1 as f64 * h)).collect())
    } else {
        None
    };
    let Some(pts) = pts else { return vec![(0, 0, 0)] };
    let x0 = pts.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let y0 = pts.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    pts.iter().enumerate().map(|(k, p)| (k as u64, (p.0 - x0).round() as u32, (p.1 - y0).round() as u32)).collect()
}

/// One XY plane's samples from `bytes` (starting at the plane's first sample) as u16.
pub fn decode_plane(bytes: &[u8], w: u32, h: u32, x_inc: u64, y_inc: u64, bps: u64) -> Vec<u16> {
    let mut out = Vec::with_capacity(w as usize * h as usize);
    for y in 0..h as u64 {
        for x in 0..w as u64 {
            let p = (y * y_inc + x * x_inc) as usize;
            out.push(if bps == 1 { bytes[p] as u16 } else { u16::from_le_bytes([bytes[p], bytes[p + 1]]) });
        }
    }
    out
}

// ---------------------------------------------------------------- the source

struct Channel {
    k: usize,
    color: [u8; 3],
}

pub struct LifSource {
    path: String,
    info: SourceInfo,
    file: Mutex<File>,
    img: LifImage,
    block: Block,
    name: String,
    channels: Vec<Channel>,
    rgb: bool,
    /// (tile index, x, y)
    tiles: Vec<(u64, u32, u32)>,
    /// file z index of each z position (slider order)
    zs: Vec<u64>,
    plane_pos: Vec<usize>,
    nominal: usize,
    luts: OnceLock<Vec<Vec<u8>>>,
    /// time points (1 without a T axis)
    nt: u64,
    planes: Mutex<PlaneCache>,
    build: Mutex<()>,
}

/// A rendered plane: (z position, time point).
type PlaneKey = (usize, u64);

#[derive(Default)]
struct PlaneCache {
    map: HashMap<PlaneKey, (Arc<Pyramid>, u64, u64)>,
    clock: u64,
}

/// The main image: largest displayed area, first on a tie. Index into `imgs`.
pub fn pick_main(imgs: &[LifImage], extent: &dyn Fn(&LifImage) -> (u64, u64)) -> Option<usize> {
    let mut best: Option<(u64, usize)> = None;
    for (k, im) in imgs.iter().enumerate() {
        let (w, h) = extent(im);
        let a = w * h;
        if best.map(|b| a > b.0).unwrap_or(true) {
            best = Some((a, k));
        }
    }
    best.map(|b| b.1)
}

/// The placed extent of an image's mosaic (or the image itself).
fn extent(im: &LifImage) -> (u64, u64) {
    let t = layout_tiles(im, im.mpp());
    let w = t.iter().map(|p| p.1 as u64 + im.width()).max().unwrap_or(1);
    let h = t.iter().map(|p| p.2 as u64 + im.height()).max().unwrap_or(1);
    (w, h)
}

/// Images the reader can show: pixels present, a layout that fits the block, not too large.
/// Returns them with their blocks, in file order, plus why the others were left out.
fn usable_images(all: Vec<LifImage>, blocks: &HashMap<String, Block>) -> (Vec<(LifImage, Block)>, Vec<String>) {
    let mut why = Vec::new();
    let usable = all
        .into_iter()
        .filter_map(|im| {
            let b = blocks.get(&im.memory_id).copied().filter(|b| b.size > 0);
            let Some(b) = b else {
                why.push(format!("{}: pixels not in the file", im.name));
                return None;
            };
            if let Err(e) = im.validate(b.size) {
                why.push(format!("{}: {e}", im.name));
                return None;
            }
            let (w, h) = extent(&im);
            if w * h > MAX_PIXELS || w > u32::MAX as u64 || h > u32::MAX as u64 {
                why.push(format!("{}: image too large ({w} × {h})", im.name));
                return None;
            }
            Some((im, b))
        })
        .collect();
    (usable, why)
}

/// Series order: the main image (`pick_main`) first, then the others in file order. Indices into
/// `imgs`.
pub fn series_order(imgs: &[LifImage]) -> Vec<usize> {
    let Some(main) = pick_main(imgs, &extent) else { return vec![] };
    std::iter::once(main).chain((0..imgs.len()).filter(|&k| k != main)).collect()
}

/// What each image is called in the image list: its name when no other image has it, else its
/// path in the project ("Position 1/Cell 1"), numbered if even that repeats.
pub fn series_names(imgs: &[&LifImage]) -> Vec<String> {
    let count = |f: &dyn Fn(&LifImage) -> &str, v: &str| imgs.iter().filter(|i| f(i) == v).count();
    let mut out: Vec<String> = imgs
        .iter()
        .map(|i| {
            if count(&|j| &j.name, &i.name) == 1 || i.path.is_empty() {
                i.name.clone()
            } else {
                i.path.clone()
            }
        })
        .collect();
    let names = out.clone();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (k, n) in names.iter().enumerate() {
        if names.iter().filter(|m| *m == n).count() > 1 {
            let c = seen.entry(n.clone()).or_insert(0);
            *c += 1;
            out[k] = format!("{n} ({c})");
        }
    }
    out
}

impl LifSource {
    /// Image number `series` of the file (`SourceInfo::series`, ordered by `series_order`).
    pub fn open_series(path: &str, series: u32) -> Result<LifSource, String> {
        Self::open_where(path, |_, _| Some(series as usize))
    }

    pub fn open(path: &str) -> Result<LifSource, String> {
        Self::open_series(path, 0)
    }

    /// Open the image named `name` (its LIF element name), or the main image when None.
    pub fn open_image(path: &str, name: Option<&str>) -> Result<LifSource, String> {
        match name {
            None => Self::open_series(path, 0),
            Some(n) => Self::open_where(path, |imgs, order| order.iter().position(|&k| imgs[k].name == n)),
        }
    }

    /// Open the series `pick` chooses (given the usable images and the series order).
    fn open_where(path: &str, pick: impl Fn(&[LifImage], &[usize]) -> Option<usize>) -> Result<LifSource, String> {
        let mut f = File::open(path).map_err(|e| format!("{path}: {e}"))?;
        let (xml, blocks) = read_container(&mut f).map_err(|e| format!("{path}: {e}"))?;
        let all = parse_images(&xml);
        drop(xml);
        if all.is_empty() {
            return Err(format!("{path}: no images in this LIF file"));
        }
        let (usable, why) = usable_images(all, &blocks);
        if usable.is_empty() {
            return Err(format!("{path}: no readable image in this LIF file ({})", why.join("; ")));
        }
        let imgs: Vec<LifImage> = usable.iter().map(|u| u.0.clone()).collect();
        let order = series_order(&imgs);
        let series = pick(&imgs, &order).filter(|&s| s < order.len()).ok_or_else(|| format!("{path}: image not found"))?;
        let names = if order.len() > 1 { series_names(&order.iter().map(|&k| &imgs[k]).collect::<Vec<_>>()) } else { vec![] };
        let (img, block) = usable.into_iter().nth(order[series]).unwrap();

        let mpp = img.mpp();
        let tiles = layout_tiles(&img, mpp);
        let (width, height) = extent(&img);

        // Z: slider order is ascending offset
        let nz = img.size(DIM_Z);
        let dz = img.step_um(DIM_Z);
        let mut zs: Vec<u64> = (0..nz).collect();
        if dz.map(|d| d < 0.0).unwrap_or(false) {
            zs.reverse();
        }
        let nominal = (zs.len() - 1) / 2;
        let offsets: Vec<Option<f64>> = if nz <= 1 {
            vec![]
        } else {
            zs.iter()
                .map(|&z| dz.map(|d| ((z as f64 - zs[nominal] as f64) * d * 1000.0).round()))
                .collect()
        };
        let (z_planes, plane_pos) = make_planes(&offsets, nominal);

        let rgb = img.is_rgb();
        let single = img.channels.len() == 1;
        let mut k_default = 0;
        let channels = img
            .channels
            .iter()
            .enumerate()
            .map(|(k, c)| {
                let color = match (single, lut_color(&c.lut)) {
                    (true, _) => [255, 255, 255],
                    (_, Some(col)) => col,
                    (_, None) => {
                        k_default += 1;
                        DEFAULT_COLORS[(k_default - 1) % DEFAULT_COLORS.len()]
                    }
                };
                Channel { k, color }
            })
            .collect();

        let mut info = SourceInfo::basic("lif", width as i64, height as i64);
        info.vendor = Some("leica".into());
        if let Some((x, y)) = mpp {
            info.mpp_x = x;
            info.mpp_y = y;
            info.calibrated = true;
        }
        info.z_planes = z_planes;
        info.time_points = make_time_points(&img.time_seconds());
        info.series = names;
        info.series_index = series as u32;
        info.series_kind = "Image".into();
        let lsizes = super::pyramid::level_sizes(width as u32, height as u32);
        info.levels = lsizes
            .iter()
            .enumerate()
            .filter(|(k, l)| *k == 0 || l.0.max(l.1) >= TILE_SIZE)
            .map(|(k, l)| LevelInfo { width: l.0 as i64, height: l.1 as i64, downsample: (1u64 << k) as f64 })
            .collect();
        info.associated = vec!["thumbnail".into()];
        let img_nt = img.size(DIM_T);
        Ok(LifSource {
            path: path.to_string(),
            info,
            file: Mutex::new(f),
            name: img.name.clone(),
            img,
            block,
            channels,
            rgb,
            tiles,
            zs,
            plane_pos,
            nominal,
            nt: img_nt,
            luts: OnceLock::new(),
            planes: Mutex::new(PlaneCache::default()),
            build: Mutex::new(()),
        })
    }

    /// The main image's name and its channels' colours (for logs and tests).
    pub fn summary(&self) -> (String, Vec<[u8; 3]>) {
        (self.name.clone(), self.channels.iter().map(|c| c.color).collect())
    }

    /// Mosaic tiles placed.
    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    /// One XY plane of channel `c`, file z `z`, tile `m`, time point `t`, as u16 samples.
    fn read_plane(&self, c: usize, z: u64, m: u64, t: u64) -> Result<Vec<u16>, String> {
        let img = &self.img;
        let bps = img.bytes_per_sample()?;
        let span = img.plane_span()?;
        let off = self.block.offset + img.plane_offset(c, z, m, t);
        let mut buf = vec![0u8; span as usize];
        {
            let mut f = self.file.lock().unwrap();
            f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
            f.read_exact(&mut buf).map_err(|e| format!("{}: {e}", self.path))?;
        }
        let xi = img.dim(DIM_X).map(|d| d.inc).unwrap_or(bps);
        let yi = img.dim(DIM_Y).map(|d| d.inc).unwrap_or(0);
        Ok(decode_plane(&buf, img.width() as u32, img.height() as u32, xi, yi, bps))
    }

    fn luts(&self) -> Result<&Vec<Vec<u8>>, String> {
        if let Some(l) = self.luts.get() {
            return Ok(l);
        }
        let n = if self.img.bytes_per_sample()? == 2 { 65536 } else { 256 };
        let mut out = Vec::new();
        for ch in &self.channels {
            if self.rgb {
                out.push((0..256).map(|v| v as u8).collect());
                continue;
            }
            let mut hist = vec![0u64; n];
            let step = self.tiles.len().div_ceil(16).max(1);
            // the first time point's nominal plane: one stretch for every plane and time point
            for t in self.tiles.iter().step_by(step) {
                let s = self.read_plane(ch.k, self.zs[self.nominal], t.0, 0)?;
                let stride = (s.len() / 2_000_000).max(1);
                for &v in s.iter().step_by(stride) {
                    hist[(v as usize).min(n - 1)] += 1;
                }
            }
            let (mut lo, hi) = percentile_range(&hist, STRETCH_LO, STRETCH_HI);
            if let Some(bg) = background_peak(&hist, lo, hi) {
                lo = lo.max(bg).min(hi - 1);
            }
            out.push(stretch_lut(lo, hi, n));
        }
        let _ = self.luts.set(out);
        Ok(self.luts.get().unwrap())
    }

    /// One mosaic tile of z position `zp` at time point `t` as RGB8.
    fn render_tile(&self, (zp, t): PlaneKey, m: u64) -> Result<Vec<u8>, String> {
        let luts = self.luts()?;
        let (w, h) = (self.img.width() as usize, self.img.height() as usize);
        let mut acc = vec![0u32; w * h * 3];
        for (ch, lut) in self.channels.iter().zip(luts) {
            let s = self.read_plane(ch.k, self.zs[zp], m, t)?;
            let col = ch.color.map(|c| c as u32);
            for (o, &v) in acc.chunks_exact_mut(3).zip(&s) {
                let l = lut[(v as usize).min(lut.len() - 1)] as u32;
                o[0] += l * col[0];
                o[1] += l * col[1];
                o[2] += l * col[2];
            }
        }
        Ok(acc.into_iter().map(|v| (v / 255).min(255) as u8).collect())
    }

    fn plane(&self, key: PlaneKey) -> Result<Arc<Pyramid>, String> {
        if let Some(p) = self.cached_plane(key) {
            return Ok(p);
        }
        let _g = self.build.lock().unwrap();
        if let Some(p) = self.cached_plane(key) {
            return Ok(p);
        }
        let (w, h) = (self.info.width as u32, self.info.height as u32);
        let big = w as u64 * h as u64 > MEM_PIXELS;
        let bg = if self.rgb { 255 } else { 0 };
        let pyr = if big {
            let root = cache_dir("lif");
            let dir = root.join(cache_key(&self.path)).join(format!("{}-z{}-t{}", self.img.memory_id, key.0, key.1));
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
                self.paint(key, &mut c)?;
                let p = Pyramid::on_disk(c, &dir, MEM_PIXELS / 4)?;
                std::fs::write(dir.join("complete"), format!("{w} {h}")).map_err(|e| e.to_string())?;
                p
            }
        } else {
            let mut c = Canvas::Mem(RgbImage::from_pixel(w, h, image::Rgb([bg, bg, bg])));
            self.paint(key, &mut c)?;
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

    fn cached_plane(&self, key: PlaneKey) -> Option<Arc<Pyramid>> {
        let mut pc = self.planes.lock().unwrap();
        pc.clock += 1;
        let now = pc.clock;
        pc.map.get_mut(&key).map(|e| {
            e.2 = now;
            e.0.clone()
        })
    }

    fn paint(&self, key: PlaneKey, c: &mut Canvas) -> Result<(), String> {
        let (tw, th) = (self.img.width() as u32, self.img.height() as u32);
        for &(m, x, y) in &self.tiles {
            let rgb = self.render_tile(key, m)?;
            c.write_rect(x, y, tw, th, &rgb)?;
        }
        Ok(())
    }

    /// A tile z (plane + time point, `split_z`) → (z position, time point).
    fn zpos(&self, z: u32) -> PlaneKey {
        let (plane, t) = split_z(z);
        (self.plane_pos.get(plane as usize).copied().unwrap_or(self.nominal), (t as u64).min(self.nt - 1))
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

impl SlideSource for LifSource {
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

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
    }

    /// A LIF file: the XML block, then the memory blocks (version 2: u64 sizes).
    pub fn build_lif(xml: &str, blocks: &[(&str, &[u8])]) -> Vec<u8> {
        let mut b = Vec::new();
        let x = utf16le(xml);
        b.extend(0x70u32.to_le_bytes());
        b.extend(((x.len() + 5) as u32).to_le_bytes());
        b.push(0x2A);
        b.extend(((x.len() / 2) as u32).to_le_bytes());
        b.extend(&x);
        for (id, data) in blocks {
            let idb = utf16le(id);
            b.extend(0x70u32.to_le_bytes());
            b.extend(0u32.to_le_bytes());
            b.push(0x2A);
            b.extend((data.len() as u64).to_le_bytes());
            b.push(0x2A);
            b.extend(((idb.len() / 2) as u32).to_le_bytes());
            b.extend(&idb);
            b.extend_from_slice(data);
        }
        b
    }

    /// An image element: (DimID, n, length m, BytesInc) per axis, (LUT, bits, BytesInc) per channel.
    fn element(name: &str, mem: &str, size: usize, dims: &[(u32, u64, f64, u64)], chans: &[(&str, u32, u64)], tiles: &str) -> String {
        let c: String = chans
            .iter()
            .map(|(l, r, i)| format!(r#"<ChannelDescription DataType="0" ChannelTag="0" Resolution="{r}" NameOfMeasuredQuantity="" Min="0" Max="255" Unit="" LUTName="{l}" IsLUTInverted="0" BytesInc="{i}" BitInc="0"/>"#))
            .collect();
        let d: String = dims
            .iter()
            .map(|(id, n, len, inc)| format!(r#"<DimensionDescription DimID="{id}" NumberOfElements="{n}" Origin="0" Length="{len:e}" Unit="{}" BitInc="0" BytesInc="{inc}"/>"#, if *id == 4 { "s" } else { "m" }))
            .collect();
        format!(
            r#"<Element Name="{name}" Visibility="1" CopyOption="1" UniqueID="x"><Data><Image TextDescription=""><ImageDescription><Channels>{c}</Channels><Dimensions>{d}</Dimensions></ImageDescription><Attachment Name="ATLConfocalSettingDefinition"><ChannelDescription LUTName="Bogus"/></Attachment>{tiles}</Image></Data><Memory Size="{size}" MemoryBlockID="{mem}"/><Children/></Element>"#
        )
    }

    fn wrap(children: &str) -> String {
        format!(r#"<LMSDataContainerHeader Version="2"><Element Name="proj" Visibility="1"><Data><Experiment Path="x"/></Data><Memory Size="0" MemoryBlockID="MemBlock_1"/><Children>{children}</Children></Element></LMSDataContainerHeader>"#)
    }

    #[test]
    fn container_parse() {
        let lif = build_lif("<a/>", &[("MemBlock_1", &[]), ("MemBlock_2", &[1, 2, 3])]);
        assert_eq!(parse_lead(&lif).unwrap(), 4);
        assert!(parse_lead(b"\x71\0\0\0\0\0\0\0\x2a\x04\0\0\0").is_err());
        let p = 13 + 8;
        let (id, size, hl) = parse_block_header(&lif[p..], true).unwrap();
        assert_eq!((id.as_str(), size, hl), ("MemBlock_1", 0, 17 + 5 + 20));
        assert!(parse_block_header(&lif[p..], false).is_none(), "u32 size misreads a v2 block");
        // version 1: u32 sizes
        let mut v1 = 0x70u32.to_le_bytes().to_vec();
        v1.extend([0, 0, 0, 0, 0x2A]);
        v1.extend(7u32.to_le_bytes());
        v1.push(0x2A);
        v1.extend(1u32.to_le_bytes());
        v1.extend(utf16le("M"));
        assert_eq!(parse_block_header(&v1, false), Some(("M".into(), 7, 20)));
    }

    #[test]
    fn xml_parse_and_dimension_maths() {
        let a = element("small", "MemBlock_2", 100, &[(1, 10, 1e-6, 1), (2, 10, 1e-6, 10)], &[("Gray", 8, 0)], "");
        let tiles = r#"<Attachment Name="TileScanInfo" Application="LAS AF" FlipX="0" FlipY="1" SwapXY="0"><Tile FieldX="0" FieldY="0" PosX="0.001" PosY="0.002"/><Tile FieldX="1" FieldY="0" PosX="0.0010009" PosY="0.002"/></Attachment>"#;
        let b = element(
            "mosaic",
            "MemBlock_3",
            0,
            &[(1, 512, 2.555e-4, 2), (2, 256, 1.275e-4, 1024), (3, 5, -4e-6, 524288), (10, 2, 0.0, 2621440), (4, 3, 9.0, 5242880)],
            &[("Red", 12, 0), ("Cyan", 12, 262144)],
            tiles,
        );
        let imgs = parse_images(&wrap(&(a + &b)));
        assert_eq!(imgs.len(), 2, "the project element (no ImageDescription) is not an image");
        let (s, m) = (&imgs[0], &imgs[1]);
        assert_eq!((s.name.as_str(), s.memory_id.as_str(), s.memory_size), ("small", "MemBlock_2", 100));
        assert_eq!(s.channels.len(), 1, "attachment ChannelDescriptions are not channels");
        assert_eq!((m.width(), m.height(), m.size(DIM_Z), m.size(DIM_TILE), m.size(DIM_T)), (512, 256, 5, 2, 3));
        assert_eq!(m.channels[1], Chan { lut: "Cyan".into(), resolution: 12, inc: 262144 });
        assert!(m.flip_y && !m.flip_x);
        assert_eq!(m.tiles.len(), 2);
        // Length / (n − 1), metres → µm
        let (mx, my) = m.mpp().unwrap();
        assert!((mx - 0.5).abs() < 1e-9 && (my - 0.5).abs() < 1e-9, "{mx} {my}");
        assert!((m.step_um(DIM_Z).unwrap() + 1.0).abs() < 1e-9);
        assert_eq!(m.bytes_per_sample().unwrap(), 2);
        assert_eq!(m.plane_offset(1, 2, 1, 0), 262144 + 2 * 524288 + 2621440);
        assert_eq!(m.plane_offset(1, 2, 1, 2), 262144 + 2 * 524288 + 2621440 + 2 * 5242880);
        assert_eq!(m.plane_span().unwrap(), 511 * 2 + 255 * 1024 + 2);
        // the last time point must fit too
        assert!(m.validate(3 * 5242880).is_ok());
        assert!(m.validate(3 * 5242880 - 1).is_err());
        // no TimeStampList: evenly over the T length (9 s)
        assert_eq!(m.time_seconds(), vec![Some(0.0), Some(4.5), Some(9.0)]);
        assert_eq!(s.time_seconds(), vec![None]);
        assert_eq!(to_um(2.0, "mm"), 2000.0);
        assert_eq!(to_um(2.0, "nm"), 0.002);
        // stage positions: 0.9 µm apart at 0.5 µm/px → 2 px; FlipY doesn't move equal ys
        let t = layout_tiles(m, Some((0.5, 0.5)));
        assert_eq!(t, vec![(0, 0, 0), (1, 2, 0)]);
        // without a pixel size: the field grid
        assert_eq!(layout_tiles(m, None), vec![(0, 0, 0), (1, 512, 0)]);
        assert_eq!(lut_color("Yellow"), Some([255, 255, 0]));
        assert_eq!(lut_color("P.Color 4"), None);
        // main image: biggest placed area
        assert_eq!(pick_main(&imgs, &extent), Some(1));
    }

    #[test]
    fn plane_decoding() {
        // 3 × 2, interleaved RGB (x stride 3), padded rows (y stride 10)
        let mut b = vec![0u8; 20];
        for y in 0..2 {
            for x in 0..3 {
                b[y * 10 + x * 3 + 1] = (10 * y + x) as u8;
            }
        }
        assert_eq!(decode_plane(&b[1..], 3, 2, 3, 10, 1), vec![0, 1, 2, 10, 11, 12]);
        assert_eq!(decode_plane(&[0x34, 0x12, 0xFF, 0x0F], 2, 1, 2, 4, 2), vec![0x1234, 0x0FFF]);
    }

    fn folder(name: &str, children: &str) -> String {
        format!(r#"<Element Name="{name}" Visibility="1"><Data><Experiment Path="x"/></Data><Memory Size="0" MemoryBlockID="MemBlock_99"/><Children>{children}</Children></Element>"#)
    }

    #[test]
    fn timestamps_paths_and_names() {
        // T outermost: storage order c0 t0, c1 t0, c0 t1, c1 t1
        let ts = r#"<TimeStampList NumberOfTimeStamps="4">0 989680 17d7840 18cba80 </TimeStampList><Attachment Name="x"><TimeStampList>ff</TimeStampList></Attachment>"#;
        let a = element("t-outer", "MemBlock_2", 64, &[(1, 4, 0.0, 1), (2, 4, 0.0, 4), (4, 2, 99.0, 32)], &[("Red", 8, 0), ("Green", 8, 16)], ts);
        // channel outermost: c0 t0, c0 t1, c1 t0, c1 t1
        let ts = r#"<TimeStampList NumberOfTimeStamps="4">0 1c9c380 4c4b40 2160ec0</TimeStampList>"#;
        let b = element("Cell 1", "MemBlock_3", 64, &[(1, 4, 0.0, 1), (2, 4, 0.0, 4), (4, 2, 0.0, 16)], &[("Red", 8, 0), ("Green", 8, 32)], ts);
        // LAS AF 1.x stamps, one per time point; and an empty list
        let ts = r#"<TimeStampList><TimeStamp HighInteger="1" LowInteger="0"/><TimeStamp HighInteger="1" LowInteger="20000000"/><TimeStamp HighInteger="1" LowInteger="70000000"/></TimeStampList>"#;
        let c = element("Cell 1", "MemBlock_4", 48, &[(1, 4, 0.0, 1), (2, 4, 0.0, 4), (4, 3, 0.0, 16)], &[("Gray", 8, 0)], ts);
        let d = element("still", "MemBlock_5", 16, &[(1, 4, 0.0, 1), (2, 4, 0.0, 4)], &[("Gray", 8, 0)], "<TimeStampList/>");
        let xml = wrap(&(a + &folder("Position 1", &b) + &folder("Position 2", &(c + &d))));
        assert_eq!(timestamp_texts(&xml).len(), 5);
        let imgs = parse_images(&xml);
        let paths: Vec<&str> = imgs.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths, ["t-outer", "Position 1/Cell 1", "Position 2/Cell 1", "Position 2/still"]);
        assert_eq!(imgs[0].stamps, vec![0, 10_000_000, 25_000_000, 26_000_000], "the attachment's list is not the image's");
        assert_eq!(imgs[0].time_seconds(), vec![Some(0.0), Some(2.5)], "stamps beat the T length");
        assert_eq!(imgs[1].time_seconds(), vec![Some(0.0), Some(3.0)], "frames matched in storage order");
        assert_eq!(imgs[2].time_seconds(), vec![Some(0.0), Some(2.0), Some(7.0)]);
        assert!(imgs[3].stamps.is_empty());
        // equal stamps say nothing: fall back to the length, here none → no times
        let mut e = imgs[1].clone();
        e.stamps = vec![5; 4];
        assert_eq!(e.time_seconds(), vec![None, None]);
        // names: unique names as is, repeated ones by their path
        let refs: Vec<&LifImage> = imgs.iter().collect();
        assert_eq!(series_names(&refs), ["t-outer", "Position 1/Cell 1", "Position 2/Cell 1", "still"]);
        let same = [&imgs[1], &imgs[1]];
        assert_eq!(series_names(&same), ["Position 1/Cell 1 (1)", "Position 1/Cell 1 (2)"]);
        assert_eq!(parse_stamps("1d27ace506a6f90 zz 1"), vec![0x1d27ace506a6f90]);
    }

    /// Several images and a time series in one file: series order, names and time points.
    #[test]
    fn synthetic_series_and_time() {
        let dir = std::env::temp_dir().join(format!("sv-lif-series-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // "small" 8 × 8 first in the file; "movie" 16 × 16 × 3 time points (dimmer with t) is the
        // main image; "empty" has no pixels; "other" 8 × 8 in a folder
        let small = vec![10u8; 64];
        let mut movie = vec![0u8; 16 * 16 * 3];
        for t in 0..3 {
            for p in 0..256 {
                movie[t * 256 + p] = if p % 16 < 8 { 200 - 80 * t as u8 } else { 0 };
            }
        }
        let other = vec![200u8; 64];
        let ts = r#"<TimeStampList NumberOfTimeStamps="3">0 5f5e100 bebc200</TimeStampList>"#;
        let xml = wrap(
            &(element("small", "MemBlock_2", 64, &[(1, 8, 0.0, 1), (2, 8, 0.0, 8)], &[("Gray", 8, 0)], "")
                + &element("movie", "MemBlock_3", movie.len(), &[(1, 16, 0.0, 1), (2, 16, 0.0, 16), (4, 3, 20.0, 256)], &[("Gray", 8, 0)], ts)
                + &element("empty", "MemBlock_4", 0, &[(1, 8, 0.0, 1), (2, 8, 0.0, 8)], &[("Gray", 8, 0)], "")
                + &folder("F", &element("other", "MemBlock_5", 64, &[(1, 8, 0.0, 1), (2, 8, 0.0, 8)], &[("Gray", 8, 0)], ""))),
        );
        let lif = build_lif(&xml, &[("MemBlock_2", &small), ("MemBlock_3", &movie), ("MemBlock_4", &[]), ("MemBlock_5", &other)]);
        let p = dir.join("s.lif");
        std::fs::write(&p, &lif).unwrap();
        let p = p.to_str().unwrap();

        let s = LifSource::open_series(p, 0).unwrap();
        let i = s.info();
        assert_eq!(i.series, ["movie", "small", "other"], "main first, then file order; no pixels → not listed");
        assert_eq!((i.series_index, i.series_kind.as_str(), i.width), (0, "Image", 16));
        let secs: Vec<Option<f64>> = i.time_points.iter().map(|t| t.seconds).collect();
        assert_eq!(secs, [Some(0.0), Some(10.0), Some(20.0)]);
        assert_eq!(i.time_points[2].index, 2);
        let max = dz_max_level(16, 16);
        let px = |t: u32| s.tile(max, 0, 0, t * crate::source::T_STRIDE).unwrap().get_pixel(2, 2).0[0];
        let (a, b, c) = (px(0), px(1), px(2));
        assert!(a > b && b > c && c > 0, "dimmer with time, same stretch: {a} {b} {c}");
        assert_eq!(s.tile(max, 0, 0, 0).unwrap().get_pixel(12, 2).0[0], 0);
        assert_eq!(s.overview(16, 2 * crate::source::T_STRIDE).unwrap().get_pixel(2, 2).0[0], c, "overview follows t");
        assert_eq!(px(9), c, "a t past the end shows the last time point");

        let o = LifSource::open_series(p, 2).unwrap();
        assert_eq!((o.summary().0.as_str(), o.info().series_index, o.info().width), ("other", 2, 8));
        assert_eq!(o.info().series, i.series);
        assert!(o.info().time_points.is_empty());
        assert_eq!(o.tile(dz_max_level(8, 8), 0, 0, 0).unwrap().dimensions(), (8, 8));
        assert!(LifSource::open_series(p, 3).is_err());
        assert_eq!(LifSource::open_image(p, Some("small")).unwrap().info().series_index, 1);

        // one readable image: no series list
        let lif = build_lif(&wrap(&element("small", "MemBlock_2", 64, &[(1, 8, 0.0, 1), (2, 8, 0.0, 8)], &[("Gray", 8, 0)], "")), &[("MemBlock_2", &small)]);
        let p2 = dir.join("one.lif");
        std::fs::write(&p2, &lif).unwrap();
        assert!(LifSource::open(p2.to_str().unwrap()).unwrap().info().series.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two-channel, 3-plane z-stack plus a 2-tile mosaic in one file, opened end to end.
    #[test]
    fn synthetic_file_opens() {
        let dir = std::env::temp_dir().join(format!("sv-lif-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // image A: 40 × 30, 3 z, 2 channels (planar), 16-bit; channel 0 bright on the left,
        // channel 1 on the right, planes dimmer with z
        let (w, h, nz) = (40u64, 30u64, 3u64);
        let plane = w * h * 2;
        let mut a = vec![0u8; (plane * 2 * nz) as usize];
        for z in 0..nz {
            for c in 0..2u64 {
                for y in 0..h {
                    for x in 0..w {
                        let on = (x < w / 2) == (c == 0);
                        let v: u16 = if on { (4000 / (z + 1)) as u16 } else { 100 };
                        let o = (c * plane + z * plane * 2 + (y * w + x) * 2) as usize;
                        a[o..o + 2].copy_from_slice(&v.to_le_bytes());
                    }
                }
            }
        }
        let ea = element(
            "stack",
            "MemBlock_10",
            a.len(),
            &[(1, w, 39.0 * 0.25e-6, 2), (2, h, 29.0 * 0.25e-6, w * 2), (3, nz, 2.0 * 0.5e-6, plane * 2)],
            &[("Blue", 16, 0), ("Green", 16, plane)],
            "",
        );
        // image B: 8 × 8 single-channel, 2 tiles side by side by grid only (smaller than A)
        let bdata: Vec<u8> = (0..128).map(|i| if i < 64 { 50 } else { 200 }).collect();
        let tiles = r#"<Attachment Name="TileScanInfo"><Tile FieldX="0" FieldY="0"/><Tile FieldX="1" FieldY="0"/></Attachment>"#;
        let eb = element("tiles", "MemBlock_11", 128, &[(1, 8, 0.0, 1), (2, 8, 0.0, 8), (10, 2, 0.0, 64)], &[("Gray", 8, 0)], tiles);
        // image C: pixels missing from the file
        let ec = element("gone", "MemBlock_12", 999999, &[(1, 4000, 1e-3, 1), (2, 4000, 1e-3, 4000)], &[("Gray", 8, 0)], "");
        let lif = build_lif(&wrap(&(ea + &eb + &ec)), &[("MemBlock_1", &[]), ("MemBlock_10", &a), ("MemBlock_11", &bdata)]);
        let p = dir.join("a.lif");
        std::fs::write(&p, &lif).unwrap();

        let s = LifSource::open(p.to_str().unwrap()).unwrap();
        let i = s.info();
        assert_eq!((i.format.as_str(), i.width, i.height, i.calibrated), ("lif", 40, 30, true));
        assert!((i.mpp_x - 0.25).abs() < 1e-9);
        assert_eq!(i.z_planes.len(), 3);
        assert_eq!(i.z_planes[1].index, 0, "the middle plane is nominal");
        assert_eq!(i.z_planes[2].offset_nm, Some(500.0));
        assert_eq!(s.summary(), ("stack".to_string(), vec![[0, 0, 255], [0, 255, 0]]));
        let max = dz_max_level(40, 30);
        let t = s.tile(max, 0, 0, 0).unwrap();
        assert_eq!(t.dimensions(), (40, 30));
        assert_eq!(t.get_pixel(2, 2).0, [0, 0, 255], "channel 0 half is blue");
        assert_eq!(t.get_pixel(38, 2).0, [0, 255, 0], "channel 1 half is green");
        let bottom = s.tile(max, 0, 0, i.z_planes[0].index).unwrap();
        assert_eq!(bottom.get_pixel(2, 2).0, [0, 0, 255], "plane z 0 is the brightest: saturated");
        let top = s.tile(max, 0, 0, i.z_planes[2].index).unwrap();
        assert!(top.get_pixel(2, 2).0[2] < 200, "the top plane is dimmer with the same stretch");
        assert_eq!(s.overview(20, 0).unwrap().dimensions(), (20, 15));

        // the mosaic alone: tiles side by side by FieldX
        let lif = build_lif(&wrap(&element("tiles", "MemBlock_11", 128, &[(1, 8, 0.0, 1), (2, 8, 0.0, 8), (10, 2, 0.0, 64)], &[("Gray", 8, 0)], tiles)), &[("MemBlock_11", &bdata)]);
        let p2 = dir.join("b.lif");
        std::fs::write(&p2, &lif).unwrap();
        let s = LifSource::open(p2.to_str().unwrap()).unwrap();
        assert_eq!((s.info().width, s.info().height, s.info().calibrated, s.tile_count()), (16, 8, false, 2));
        let t = s.tile(dz_max_level(16, 8), 0, 0, 0).unwrap();
        assert!(t.get_pixel(2, 2).0[0] < t.get_pixel(12, 2).0[0], "tile 1 (brighter) is on the right");
        assert_eq!(t.get_pixel(2, 2).0[0], t.get_pixel(2, 2).0[1], "a single channel is grey");

        // not a LIF / nothing readable
        std::fs::write(&p2, b"hello world, not a lif").unwrap();
        assert!(LifSource::open(p2.to_str().unwrap()).is_err());
        std::fs::write(&p2, build_lif(&wrap(&element("gone", "MemBlock_12", 9, &[(1, 3, 0.0, 1), (2, 3, 0.0, 3)], &[("Gray", 8, 0)], "")), &[])).unwrap();
        let e = LifSource::open(p2.to_str().unwrap()).err().unwrap();
        assert!(e.contains("pixels not in the file"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn sample(name: &str) -> Option<String> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats/Leica-LIF").join(name);
        p.exists().then(|| p.to_string_lossy().to_string())
    }

    /// The OME sample files (tools/fetch-format-samples.py; not committed). `LIF_PNG_DIR=/tmp/x`
    /// saves each overview.
    #[test]
    #[ignore]
    fn real_lif_samples() {
        // (file, main image, w, h, z planes, channels, tiles, mpp)
        let want = [
            ("Project007.lif", "Cell 1 Merged", 981, 975, 12, 4, 1, 0.4815),
            ("20191025 Test FRET 585. 423, 426.lif", "423_001", 1024, 1024, 1, 2, 1, 0.0902),
            ("PR2729_frameOrderCombinedScanTypes.lif", "TileScan_001", 97, 97, 3, 2, 4, 3.968),
        ];
        for (name, main, w, h, nz, nc, nt, mpp) in want {
            let Some(p) = sample(name) else {
                eprintln!("skip {name}: not downloaded");
                continue;
            };
            let s = LifSource::open(&p).unwrap();
            let i = s.info();
            eprintln!("{name}: {:?} {} × {} mpp {:.4} z {:?}", s.summary(), i.width, i.height, i.mpp_x, i.z_planes.iter().map(|z| &z.label).collect::<Vec<_>>());
            eprintln!("  series {:?}; times {:?}", i.series, i.time_points.iter().map(|t| &t.label).collect::<Vec<_>>());
            let want_series: &[&str] = match name {
                "Project007.lif" => &["Cell 1 Merged", "Cell 1 Dendrites zoom 1.5", "Cell 1 Dendrites zoom 2", "Cell 1"],
                "20191025 Test FRET 585. 423, 426.lif" => {
                    &["423_001", "423_002", "DonAcc_PreBleach", "Bleach003", "DonAcc_PostBleach", "FRET-Efficiency", "Series005", "Series006"]
                }
                _ => &[],
            };
            assert_eq!(i.series, want_series, "{name}");
            assert_eq!(i.series_index, 0);
            // every other image opens (as itself) and renders
            for k in 1..i.series.len() as u32 {
                let o = LifSource::open_series(&p, k).unwrap();
                let oi = o.info();
                eprintln!("  [{k}] {} {} × {} z {} c {} tiles {} t {:?}", o.summary().0, oi.width, oi.height, oi.z_planes.len(), o.channels.len(), o.tile_count(), oi.time_points.iter().map(|t| &t.label).collect::<Vec<_>>());
                assert_eq!((o.summary().0.as_str(), oi.series_index), (i.series[k as usize].as_str(), k));
                assert_eq!(oi.series, i.series);
                let ov = o.overview(256, 0).unwrap();
                let mean: f64 = ov.as_raw().iter().map(|&v| v as f64).sum::<f64>() / ov.as_raw().len() as f64;
                assert!(mean > 1.0 && mean < 220.0, "{name} [{k}]: mean {mean}");
            }
            assert!(LifSource::open_series(&p, i.series.len().max(1) as u32).is_err());
            assert_eq!(s.summary().0, main, "{name}");
            assert_eq!((i.width, i.height, i.z_planes.len(), s.channels.len(), s.tile_count()), (w, h, nz, nc, nt), "{name}");
            assert!(i.calibrated && (i.mpp_x - mpp).abs() < 1e-3, "{name}: mpp {}", i.mpp_x);
            let o = s.overview(1024, 0).unwrap();
            if let Ok(d) = std::env::var("LIF_PNG_DIR") {
                o.save(Path::new(&d).join(format!("{name}.png"))).unwrap();
            }
            let mean: f64 = o.as_raw().iter().map(|&v| v as f64).sum::<f64>() / o.as_raw().len() as f64;
            assert!(mean > 3.0 && mean < 200.0, "{name}: mean {mean}");
        }
        // PR2729: a 2 × 2 TileScan z-stack with 2 time points, 8.271 s apart by its TimeStampList
        // (the T Length agrees). Both time points hold the same bytes in this test file, so they
        // render alike; t = 1 reads the second half of the block (offset T BytesInc 98304).
        if let Some(p) = sample("PR2729_frameOrderCombinedScanTypes.lif") {
            let s = LifSource::open(&p).unwrap();
            let t = &s.info().time_points;
            assert_eq!(t.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), ["0 s", "8.27 s"]);
            assert!((t[1].seconds.unwrap() - 8.271).abs() < 1e-6);
            assert_eq!(s.img.plane_offset(0, 0, 0, 1), 98304);
            let max = dz_max_level(97, 97);
            for z in s.info().z_planes.iter().map(|z| z.index) {
                let a = s.tile(max, 0, 0, z).unwrap();
                let b = s.tile(max, 0, 0, z + crate::source::T_STRIDE).unwrap();
                assert_eq!(a, b, "identical data at both time points");
            }
            if let Ok(d) = std::env::var("LIF_PNG_DIR") {
                s.overview(1024, crate::source::T_STRIDE).unwrap().save(Path::new(&d).join("PR2729.t1.png")).unwrap();
            }
        }
        // the 2 × 2 TileScan the "Cell 1 Merged" image was stitched from, placed by stage position:
        // the same neuron, about the same size (LAS X's stitching overlaps differ a few pixels)
        if let Some(p) = sample("Project007.lif") {
            let s = LifSource::open_image(&p, Some("Cell 1")).unwrap();
            let i = s.info();
            eprintln!("Cell 1 mosaic: {} × {}, {} tiles", i.width, i.height, s.tile_count());
            assert_eq!(s.tile_count(), 4);
            assert!((i.width - 981).abs() < 24 && (i.height - 975).abs() < 24, "{} × {}", i.width, i.height);
            if let Ok(d) = std::env::var("LIF_PNG_DIR") {
                s.overview(1024, 0).unwrap().save(Path::new(&d).join("Project007.cell1-mosaic.png")).unwrap();
            }
        }
    }
}
