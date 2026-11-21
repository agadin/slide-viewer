//! Olympus / Evident FluoView `.oir` (FV1000-successor confocals: FV3000, FV4000). Owner: formats
//! builder.
//!
//! Layout (reverse-engineered; no public specification exists). Independent implementation; the
//! layout was learned from Christoph Gohlke's `oirfile` (BSD-3) and checked against sample files.
//! - 96-byte header: `OLYMPUSRAWFORMAT`, then at byte 32 the declared file size (u64) and the
//!   offset of the block index (u64).
//! - The block index: `u32 0xFFFFFFFF`, then u64 block offsets (0 or past the end stops it).
//! - Each block: `u32 payload length, u32 type`, then the payload. Types: 0 metadata (several XML
//!   documents: file info, `lsmimage:imageProperties`, LUTs, …), 1 frame properties (one XML per
//!   acquired frame), 2 a BMP thumbnail, 3 a UID, 4 pixels, 5 empty.
//! - A UID block (`u32 byte offset in the plane, u32 length, u32 UID length, UID`) names the PIXEL
//!   block that follows it: `z003t001_0_1_<channel guid>_<chunk>` (axis letters t/l/z with 1-based
//!   indices, then the channel's GUID and the chunk number). A plane is its chunks in chunk order:
//!   raw little-endian samples (1 or 2 bytes), row-major. `REF_…` UIDs are the reference
//!   (overview) image, not used.
//! - Big acquisitions continue in companion files `<name>_00001`, `_00002`, … (same format, pixel
//!   blocks only); the main file holds the metadata.
//!
//! Display: each focal plane becomes a Deep-Zoom pyramid (`pyramid.rs`) built on first use, in
//! memory or (big stitched images) on disk in the app cache. Channels are stretched (0.1 % →
//! 99.9 % percentiles of the nominal plane of the first time point, the same stretch for every
//! plane and time point) and added in their colour: the LUT colour FluoView saved, else the
//! emission wavelength, else a palette. Spectral (lambda) scans show each wavelength band in its
//! own colour.
//!
//! Time series (the `t` in the UIDs): every time point is shown (`SourceInfo::time_points`, tile
//! `z` = plane + t × `T_STRIDE`). A time point's time is its first frame's TIMELAPSE position
//! (ms, in the frame properties), else the TIMELAPSE axis definition (start + k × step, seconds).
//! A pyramid is built only when a (time point, plane) is first shown. Split series work the same
//! way: chunks are found by UID, whichever file holds them.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use image::{imageops::FilterType, RgbImage};

use super::cache::{cache_dir, file_key};
use super::plain::{MAX_PIXELS, MAX_PLAUSIBLE_MPP, MEM_PIXELS};
use super::pyramid::{Canvas, Pyramid};
use super::vsi::{composite, wavelength_rgb, ChanLook};
use super::zvi::{background_peak, percentile_range};
use super::{dz_max_level, dz_tile_rect, fit, make_planes, make_time_points, split_z, LevelInfo, SlideSource, SourceInfo, TILE_SIZE};

pub const MAGIC: &[u8; 16] = b"OLYMPUSRAWFORMAT";
pub const HEADER_LEN: usize = 96;
pub const BLOCK_METADATA: u32 = 0;
pub const BLOCK_FRAME: u32 = 1;
pub const BLOCK_UID: u32 = 3;
pub const BLOCK_PIXEL: u32 = 4;
/// Marker at the start of the block index.
const INDEX_MARKER: u32 = 0xFFFF_FFFF;

/// Planes whose pyramids stay in memory, by total bytes (older planes are dropped and rebuilt).
const MEM_PLANE_BUDGET: u64 = 384 << 20;
/// Bump when the rendering changes, so cached disk pyramids are rebuilt.
const RENDER_VERSION: u32 = 1;
/// Disk pyramids kept in the cache (oldest are removed).
const KEEP_DISK: usize = 6;
const STRETCH_LO: f64 = 0.001;
const STRETCH_HI: f64 = 0.999;
/// Pixels per band when compositing a plane.
const BAND_PIXELS: u64 = 4 << 20;

/// Colours for channels without a LUT colour or wavelength: blue, green, red, magenta, cyan, yellow.
const PALETTE: [[f32; 3]; 6] = [[0.0, 0.3, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 0.0]];

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], p: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(p..p + 8)?.try_into().ok()?))
}

fn read_at(f: &File, buf: &mut [u8], off: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        f.read_exact_at(buf, off)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = f.seek_read(&mut buf[done..], off + done as u64)?;
            if n == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            done += n;
        }
        Ok(())
    }
}

fn read_vec(f: &File, off: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut v = vec![0u8; len];
    read_at(f, &mut v, off).map_err(|e| format!("read {len} bytes at {off}: {e}"))?;
    Ok(v)
}

// ---------------------------------------------------------------- header, index, UIDs (pure)

/// The file header: declared size and where the block index starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub size: u64,
    pub index_pos: u64,
}

pub fn parse_header(b: &[u8]) -> Result<Header, String> {
    if b.len() < 48 || &b[..16] != MAGIC {
        return Err("not an Olympus OIR file".into());
    }
    let size = u64_at(b, 32).unwrap();
    let index_pos = u64_at(b, 40).unwrap();
    if index_pos < HEADER_LEN as u64 || index_pos >= size {
        return Err(format!("OIR header: bad block index offset {index_pos} (size {size})"));
    }
    Ok(Header { size, index_pos })
}

/// Block offsets from the index (the bytes from `index_pos` to the declared end). None when the
/// marker is missing (the caller then walks the block chain).
pub fn parse_index(b: &[u8], size: u64) -> Option<Vec<u64>> {
    if u32_at(b, 0)? != INDEX_MARKER {
        return None;
    }
    let mut out = Vec::new();
    let mut p = 4;
    while let Some(o) = u64_at(b, p) {
        if o == 0 || o > size {
            break;
        }
        out.push(o);
        p += 8;
    }
    Some(out)
}

/// Block offsets by walking the chain from the header (`u32 length, u32 type, payload`).
pub fn walk_blocks(read8: &dyn Fn(u64) -> Option<[u8; 8]>, start: u64, end: u64) -> Vec<u64> {
    let mut out = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        let Some(h) = read8(pos) else { break };
        let len = u32::from_le_bytes(h[..4].try_into().unwrap()) as u64;
        let typ = u32::from_le_bytes(h[4..].try_into().unwrap());
        if typ > 5 {
            break;
        }
        out.push(pos);
        pos += 8 + len;
    }
    out
}

/// What a pixel block's UID says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uid {
    /// 1-based axis indices (0 when the axis isn't in the UID)
    pub t: u32,
    pub l: u32,
    pub z: u32,
    pub guid: String,
    pub chunk: u32,
}

/// The axis indices at the start of a UID or frame id (`l002z013t001_0_1…`): (t, l, z).
pub fn parse_axes(prefix: &str) -> (u32, u32, u32) {
    let head = prefix.split('_').next().unwrap_or("");
    let (mut t, mut l, mut z) = (0, 0, 0);
    let b = head.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let letter = b[i];
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let v: u32 = head[i + 1..j].parse().unwrap_or(0);
        match letter {
            b't' => t = v,
            b'l' => l = v,
            b'z' => z = v,
            _ => {}
        }
        i = j.max(i + 1);
    }
    (t, l, z)
}

/// Parse an image UID. None for reference-image UIDs and anything unrecognised.
pub fn parse_uid(s: &str) -> Option<Uid> {
    if s.starts_with("REF_") {
        return None;
    }
    let (rest, chunk) = s.rsplit_once('_')?;
    let chunk = chunk.parse().ok()?;
    let (prefix, guid) = rest.rsplit_once('_').unwrap_or(("", rest));
    if guid.len() < 8 || !guid.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return None;
    }
    let (t, l, z) = parse_axes(prefix);
    Some(Uid { t, l, z, guid: guid.to_string(), chunk })
}

// ---------------------------------------------------------------- minimal XML (pure)

/// One element: local name (namespace prefix dropped), attributes, its first text, and the
/// index range of its descendants (`idx + 1 .. end`).
#[derive(Debug, Clone)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub text: String,
    pub end: usize,
}

impl Node {
    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
}

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// The elements of an XML document in document order.
pub fn parse_xml(s: &str) -> Vec<Node> {
    let mut out: Vec<Node> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut i = 0;
    while let Some(p) = s[i..].find('<') {
        // text before this tag belongs to the innermost open element (first text only)
        if let Some(&top) = stack.last() {
            let t = s[i..i + p].trim();
            if !t.is_empty() && out[top].text.is_empty() {
                out[top].text = unescape(t);
            }
        }
        let start = i + p + 1;
        if s[start..].starts_with("!--") {
            i = s[start..].find("-->").map(|q| start + q + 3).unwrap_or(s.len());
            continue;
        }
        let Some(q) = s[start..].find('>') else { break };
        let tag = &s[start..start + q];
        i = start + q + 1;
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            let name = local(name.trim());
            if let Some(k) = stack.iter().rposition(|&e| out[e].name == name) {
                for &e in &stack[k..] {
                    out[e].end = out.len();
                }
                stack.truncate(k);
            }
            continue;
        }
        let self_closing = tag.ends_with('/');
        let body = tag.trim_end_matches('/');
        let name_end = body.find(|c: char| c.is_whitespace()).unwrap_or(body.len());
        let name = local(&body[..name_end]).to_string();
        let mut attrs = Vec::new();
        let mut rest = &body[name_end..];
        while let Some(eq) = rest.find('=') {
            let key = local(rest[..eq].trim()).to_string();
            let after = rest[eq + 1..].trim_start();
            let Some(qc) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
            let Some(close) = after[1..].find(qc) else { break };
            attrs.push((key, unescape(&after[1..1 + close])));
            rest = &after[close + 2..];
        }
        out.push(Node { name, attrs, text: String::new(), end: 0 });
        let idx = out.len() - 1;
        if self_closing {
            out[idx].end = idx + 1;
        } else {
            stack.push(idx);
        }
    }
    for &e in &stack {
        out[e].end = out.len();
    }
    out
}

/// First element named `name` among the descendants of `i` (or the whole document for None).
fn find(nodes: &[Node], i: Option<usize>, name: &str) -> Option<usize> {
    let (a, b) = match i {
        Some(i) => (i + 1, nodes[i].end),
        None => (0, nodes.len()),
    };
    (a..b.min(nodes.len())).find(|&k| nodes[k].name == name)
}

fn find_text<'a>(nodes: &'a [Node], i: Option<usize>, name: &str) -> Option<&'a str> {
    find(nodes, i, name).map(|k| nodes[k].text.as_str()).filter(|t| !t.is_empty())
}

fn find_num(nodes: &[Node], i: Option<usize>, name: &str) -> Option<f64> {
    find_text(nodes, i, name).and_then(|t| t.trim().parse().ok())
}

// ---------------------------------------------------------------- metadata (pure)

/// One channel from `lsmimage:imageProperties`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelMeta {
    pub id: String,
    pub name: String,
    pub order: i64,
    /// emission range (nm)
    pub wavelength: Option<(f64, f64)>,
}

/// One frame's `lsmframe:frameProperties`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FrameMeta {
    /// (t, l, z) from the frame id
    pub tlz: (u32, u32, u32),
    pub width: u32,
    pub height: u32,
    /// bytes per sample
    pub depth: u32,
    pub color_type: String,
    /// (axis type, position): ZSTACK µm, LAMBDA nm, TIMELAPSE ms
    pub axes: Vec<(String, f64)>,
}

impl FrameMeta {
    pub fn axis(&self, name: &str) -> Option<f64> {
        self.axes.iter().find(|(a, _)| a == name).map(|(_, v)| *v)
    }
}

/// What the metadata says about the image.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImageMeta {
    pub channels: Vec<ChannelMeta>,
    /// µm per pixel (x, y) and the Z step (µm)
    pub pixel_um: Option<(f64, f64)>,
    pub z_step_um: Option<f64>,
    /// image size from `imageInfo`
    pub size: Option<(u32, u32)>,
    /// LAMBDA axis start and step (nm), when enabled
    pub lambda: Option<(f64, f64)>,
    /// TIMELAPSE axis start and step (s), when enabled
    pub timelapse: Option<(f64, f64)>,
}

/// Parse an `lsmimage:imageProperties` document.
pub fn parse_image_props(xml: &str) -> ImageMeta {
    let n = parse_xml(xml);
    let mut m = ImageMeta::default();
    for (k, node) in n.iter().enumerate() {
        if node.name != "channel" {
            continue;
        }
        let Some(id) = node.attr("id") else { continue };
        if m.channels.iter().any(|c| c.id == id) {
            continue;
        }
        let wl = find_num(&n, Some(k), "startWavelength").zip(find_num(&n, Some(k), "endWavelength"));
        m.channels.push(ChannelMeta {
            id: id.to_string(),
            name: find_text(&n, Some(k), "name").unwrap_or("").to_string(),
            order: node.attr("order").and_then(|o| o.parse().ok()).unwrap_or(0),
            wavelength: wl,
        });
    }
    if let Some(len) = find(&n, None, "length") {
        let scale = match find(&n, None, "pixelUnit").and_then(|u| find_text(&n, Some(u), "x")) {
            Some(u) if u.contains("NANO") => 1e-3,
            Some(u) if u.contains("MILLI") => 1e3,
            _ => 1.0,
        };
        let x = find_num(&n, Some(len), "x").map(|v| v * scale);
        let y = find_num(&n, Some(len), "y").map(|v| v * scale).or(x);
        m.pixel_um = x.zip(y);
        m.z_step_um = find_num(&n, Some(len), "z").filter(|z| z.is_finite() && *z > 0.0);
    }
    if let Some(info) = find(&n, None, "imageInfo") {
        // the image's own width/height are its last children (after the channel groups)
        let w = (info + 1..n[info].end).rev().find(|&k| n[k].name == "width").and_then(|k| n[k].text.parse().ok());
        let h = (info + 1..n[info].end).rev().find(|&k| n[k].name == "height").and_then(|k| n[k].text.parse().ok());
        m.size = w.zip(h);
    }
    // axis definitions: <axis enable="true"><axis>LAMBDA</axis><startPosition>…<step>…
    for (k, node) in n.iter().enumerate() {
        if node.name != "axis" || node.attr("enable") != Some("true") {
            continue;
        }
        let start_step = find_num(&n, Some(k), "startPosition").zip(find_num(&n, Some(k), "step"));
        match find_text(&n, Some(k), "axis") {
            Some("LAMBDA") => m.lambda = start_step.or(m.lambda),
            Some("TIMELAPSE") => m.timelapse = start_step.filter(|(s, st)| s.is_finite() && st.is_finite() && *st > 0.0).or(m.timelapse),
            _ => {}
        }
    }
    m
}

/// Parse an `lsmframe:frameProperties` document.
pub fn parse_frame(xml: &str) -> FrameMeta {
    let n = parse_xml(xml);
    let mut f = FrameMeta::default();
    if let Some(root) = n.first() {
        f.tlz = parse_axes(root.attr("id").unwrap_or(""));
    }
    let num = |name: &str| find_num(&n, None, name).map(|v| v as u32).unwrap_or(0);
    f.width = num("width");
    f.height = num("height");
    f.depth = num("depth");
    f.color_type = find_text(&n, None, "colorType").unwrap_or("").to_string();
    for (k, node) in n.iter().enumerate() {
        if node.name == "axisValue" {
            if let (Some(a), Some(p)) = (find_text(&n, Some(k), "axisType"), find_num(&n, Some(k), "position")) {
                f.axes.push((a.to_string(), p));
            }
        }
    }
    f
}

/// A LUT document's display colour (each of red/green/blue on when its `contrast` is non-zero),
/// None for grey (all three on) or none.
pub fn parse_lut_color(xml: &str) -> Option<[f32; 3]> {
    // the LUT's table (<lut:data>, ~0.5 MB of hex) isn't needed
    let head = xml.find("<lut:data").map(|p| &xml[..p]).unwrap_or(xml);
    let n = parse_xml(head);
    let on = |c: &str| find(&n, None, c).and_then(|k| find_num(&n, Some(k), "contrast")).map(|v| v > 0.0);
    let rgb = [on("red")?, on("green")?, on("blue")?];
    match rgb {
        [true, true, true] | [false, false, false] => None,
        _ => Some(rgb.map(|b| if b { 1.0 } else { 0.0 })),
    }
}

/// The XML documents in a metadata or frame block payload, each with the channel GUID written
/// just before it (`u32 36, guid, u32 xml length, <?xml…`), when there is one.
pub fn split_xml_docs(b: &[u8]) -> Vec<(Option<String>, String)> {
    let starts: Vec<usize> = b.windows(5).enumerate().filter(|(_, w)| *w == b"<?xml").map(|(i, _)| i).collect();
    let mut out = Vec::new();
    for (k, &s) in starts.iter().enumerate() {
        let e = starts.get(k + 1).copied().unwrap_or(b.len());
        let doc = &b[s..e];
        let Some(last) = doc.iter().rposition(|&c| c == b'>') else { continue };
        let guid = (s >= 44 && u32_at(b, s - 44) == Some(36))
            .then(|| &b[s - 40..s - 4])
            .filter(|g| g.iter().all(|c| c.is_ascii_hexdigit() || *c == b'-'))
            .map(|g| String::from_utf8_lossy(g).to_string());
        out.push((guid, String::from_utf8_lossy(&doc[..=last]).to_string()));
    }
    out
}

/// Local name of a document's root element.
fn root_name(xml: &str) -> &str {
    let mut s = xml;
    while let Some(p) = s.find('<') {
        s = &s[p + 1..];
        if s.starts_with('?') || s.starts_with('!') {
            continue;
        }
        let end = s.find(|c: char| c.is_whitespace() || c == '>' || c == '/').unwrap_or(s.len());
        return local(&s[..end]);
    }
    ""
}

/// Seconds since the start for each time index in `ts` (UID `t` values, sorted): the earliest
/// TIMELAPSE position (ms) among that time point's frames, else `start + k × step` from the
/// TIMELAPSE axis definition (s), else None.
pub fn time_seconds(ts: &[u32], frames: &[FrameMeta], axis: Option<(f64, f64)>) -> Vec<Option<f64>> {
    ts.iter()
        .enumerate()
        .map(|(k, &t)| {
            let from_frames = frames
                .iter()
                .filter(|f| f.tlz.0 == t)
                .filter_map(|f| f.axis("TIMELAPSE"))
                .filter(|v| v.is_finite() && *v >= 0.0)
                .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.min(v))));
            from_frames.map(|ms| ms / 1000.0).or_else(|| axis.map(|(s, st)| s + k as f64 * st))
        })
        .collect()
}

// ---------------------------------------------------------------- reading a file's blocks

/// A pixel block: which file (0 = main, k = companion k), where its bytes are, how many.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chunk {
    pub file: usize,
    pub offset: u64,
    pub len: u64,
}

/// Everything found in one file's block index.
#[derive(Default)]
pub struct Blocks {
    pub pixels: Vec<(Uid, Chunk)>,
    pub frames: Vec<FrameMeta>,
    /// (preceding channel GUID, XML) of every metadata document
    pub docs: Vec<(Option<String>, String)>,
}

/// Read the blocks of one OIR file (`file_index` tags its chunks).
pub fn read_blocks(f: &File, file_index: usize, with_meta: bool) -> Result<Blocks, String> {
    let flen = f.metadata().map_err(|e| e.to_string())?.len();
    let head = read_vec(f, 0, HEADER_LEN.min(flen as usize))?;
    let h = parse_header(&head)?;
    let end = h.size.min(flen);
    let index = if h.index_pos < end { read_vec(f, h.index_pos, (end - h.index_pos) as usize)? } else { vec![] };
    let offsets = match parse_index(&index, h.size) {
        Some(o) if !o.is_empty() => o,
        _ => {
            let read8 = |p: u64| -> Option<[u8; 8]> {
                let mut b = [0u8; 8];
                read_at(f, &mut b, p).ok().map(|_| b)
            };
            walk_blocks(&read8, HEADER_LEN as u64, h.index_pos.min(end))
        }
    };
    let mut out = Blocks::default();
    let mut i = 0;
    while i < offsets.len() {
        let off = offsets[i];
        i += 1;
        if off + 8 > end {
            continue;
        }
        let bh = read_vec(f, off, 8)?;
        let (len, typ) = (u32_at(&bh, 0).unwrap() as u64, u32_at(&bh, 4).unwrap());
        match typ {
            BLOCK_UID => {
                let m = read_vec(f, off + 8, 12.min(len as usize))?;
                let Some(ulen) = u32_at(&m, 8) else { continue };
                if ulen as u64 + 12 > len {
                    continue;
                }
                let uid = String::from_utf8_lossy(&read_vec(f, off + 20, ulen as usize)?).to_string();
                // the paired pixel block is next in the index
                let Some(&poff) = offsets.get(i) else { continue };
                if poff + 8 > end {
                    continue;
                }
                let ph = read_vec(f, poff, 8)?;
                if u32_at(&ph, 4) != Some(BLOCK_PIXEL) {
                    continue;
                }
                i += 1;
                let plen = (u32_at(&ph, 0).unwrap() as u64).min(end.saturating_sub(poff + 8));
                if let Some(u) = parse_uid(&uid) {
                    out.pixels.push((u, Chunk { file: file_index, offset: poff + 8, len: plen }));
                }
            }
            BLOCK_FRAME => {
                let len = len.min(end - off - 8) as usize;
                let b = read_vec(f, off + 8, len)?;
                for (_, x) in split_xml_docs(&b) {
                    out.frames.push(parse_frame(&x));
                }
            }
            BLOCK_METADATA if with_meta => {
                let len = len.min(end - off - 8) as usize;
                let b = read_vec(f, off + 8, len)?;
                out.docs.extend(split_xml_docs(&b));
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Companion files of a series: `<stem>_00001`, `_00002`, … (FluoView writes them without an
/// extension; `.oir` is accepted too), in order, stopping at the first missing number.
pub fn companions(path: &Path) -> Vec<PathBuf> {
    let stem = path.with_extension("");
    let mut out = Vec::new();
    for k in 1..10_000 {
        let base = format!("{}_{k:05}", stem.to_string_lossy());
        let found = [PathBuf::from(&base), PathBuf::from(format!("{base}.oir"))].into_iter().find(|p| p.is_file());
        match found {
            Some(p) => out.push(p),
            None => break,
        }
    }
    out
}

/// For `name_00003.oir`, the series' main file `name.oir` when it exists.
fn series_main(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let (base, num) = stem.rsplit_once('_')?;
    if num.len() != 5 || !num.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let main = path.with_file_name(format!("{base}.oir"));
    main.is_file().then_some(main)
}

// ---------------------------------------------------------------- the source

/// One displayed channel: a channel GUID at one lambda index.
#[derive(Debug, Clone)]
struct DispChan {
    guid: String,
    l: u32,
    name: String,
    color: [f32; 3],
}

/// A plane's chunks in order, with each chunk's starting byte within the plane.
type PlaneChunks = Vec<(u64, Chunk)>;

pub struct OirSource {
    path: String,
    info: SourceInfo,
    files: Vec<File>,
    width: u32,
    height: u32,
    /// bytes per sample (1 or 2)
    depth: u32,
    chans: Vec<DispChan>,
    /// (time position, z position, display channel) → chunks
    planes_map: HashMap<(usize, usize, usize), PlaneChunks>,
    zs: Vec<u32>,
    /// the UIDs' distinct `t` values, sorted (a time point's index is its position here)
    ts: Vec<u32>,
    plane_pos: Vec<usize>,
    nominal: usize,
    looks: OnceLock<Vec<ChanLook>>,
    planes: Mutex<PlaneCache>,
    build: Mutex<()>,
}

#[derive(Default)]
struct PlaneCache {
    /// (time position, z position) → (pyramid, bytes in memory, last use)
    map: HashMap<(usize, usize), (Arc<Pyramid>, u64, u64)>,
    clock: u64,
}

impl OirSource {
    pub fn open(path: &str) -> Result<OirSource, String> {
        let p = Path::new(path);
        let main = File::open(p).map_err(|e| format!("{path}: {e}"))?;
        let blocks = read_blocks(&main, 0, true).map_err(|e| format!("{path}: {e}"))?;
        let props = blocks.docs.iter().find(|(_, x)| root_name(x) == "imageProperties");
        let Some((_, props)) = props else {
            if let Some(m) = series_main(p) {
                return Err(format!("{path}: this is part of a FluoView series; open {} instead", m.display()));
            }
            return Err(format!("{path}: no image metadata in this OIR file"));
        };
        let meta = parse_image_props(props);
        let mut luts: HashMap<String, [f32; 3]> = HashMap::new();
        for (g, x) in &blocks.docs {
            if let Some(g) = g {
                if root_name(x) == "LUT" && !luts.contains_key(g) {
                    if let Some(c) = parse_lut_color(x) {
                        luts.insert(g.clone(), c);
                    }
                }
            }
        }

        let mut files = vec![main];
        let mut pixels = blocks.pixels;
        let mut frames = blocks.frames;
        for (k, c) in companions(p).into_iter().enumerate() {
            let f = File::open(&c).map_err(|e| format!("{}: {e}", c.display()))?;
            let b = read_blocks(&f, k + 1, false).map_err(|e| format!("{}: {e}", c.display()))?;
            pixels.extend(b.pixels);
            frames.extend(b.frames);
            files.push(f);
        }
        if pixels.is_empty() {
            return Err(format!("{path}: no image planes in this OIR file"));
        }

        // frame geometry
        let frame = frames.iter().find(|f| f.width > 0 && f.height > 0).cloned().unwrap_or_default();
        let (width, height) = if frame.width > 0 { (frame.width, frame.height) } else { meta.size.ok_or_else(|| format!("{path}: no image size"))? };
        let depth = if frame.depth > 0 { frame.depth } else { 2 };
        if depth != 1 && depth != 2 {
            return Err(format!("{path}: {}-byte OIR samples are not supported", depth));
        }
        if frame.color_type.eq_ignore_ascii_case("RGB") {
            return Err(format!("{path}: colour (RGB) OIR snapshots are not supported"));
        }
        if width as u64 * height as u64 > MAX_PIXELS {
            return Err(format!("{path}: image too large ({width} × {height})"));
        }

        // time points: the distinct t values (all 0 without a time axis)
        let mut ts: Vec<u32> = pixels.iter().map(|(u, _)| u.t).collect();
        ts.sort();
        ts.dedup();
        let t0 = ts[0];
        let mut zs: Vec<u32> = pixels.iter().map(|(u, _)| u.z).collect();
        zs.sort();
        zs.dedup();
        let mut ls: Vec<u32> = pixels.iter().map(|(u, _)| u.l).collect();
        ls.sort();
        ls.dedup();
        // channels with data, in the metadata's order
        let mut guids: Vec<String> = Vec::new();
        let mut ordered: Vec<&ChannelMeta> = meta.channels.iter().collect();
        ordered.sort_by_key(|c| c.order);
        for c in ordered {
            if pixels.iter().any(|(u, _)| u.guid == c.id) && !guids.contains(&c.id) {
                guids.push(c.id.clone());
            }
        }
        let mut rest: Vec<String> = pixels.iter().map(|(u, _)| u.guid.clone()).filter(|g| !guids.contains(g)).collect();
        rest.sort();
        rest.dedup();
        guids.extend(rest);

        // lambda positions (nm) by l index: frame positions, else the axis definition
        let lambda_nm = |l: u32| -> Option<f64> {
            frames.iter().find(|f| f.tlz.1 == l).and_then(|f| f.axis("LAMBDA")).or_else(|| meta.lambda.map(|(s, st)| s + (l.max(1) - 1) as f64 * st))
        };
        let spectral = ls.len() > 1;
        let mut chans = Vec::new();
        for g in &guids {
            let cm = meta.channels.iter().find(|c| &c.id == g);
            let cname = cm.map(|c| c.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("C{}", chans.len() + 1));
            for &l in &ls {
                if !pixels.iter().any(|(u, _)| &u.guid == g && u.l == l) {
                    continue;
                }
                let (name, wl) = if spectral {
                    let nm = lambda_nm(l);
                    (nm.map(|v| format!("{cname} {v:.0} nm")).unwrap_or_else(|| format!("{cname} λ{l}")), nm)
                } else {
                    (cname.clone(), cm.and_then(|c| c.wavelength).map(|(a, b)| (a + b) / 2.0))
                };
                chans.push(DispChan { guid: g.clone(), l, name, color: [1.0; 3] });
                let k = chans.len() - 1;
                chans[k].color = match (spectral, wl, luts.get(g)) {
                    (true, Some(nm), _) => wavelength_rgb(nm),
                    (false, _, Some(c)) => *c,
                    (false, Some(nm), None) => wavelength_rgb(nm),
                    _ => [1.0; 3],
                };
            }
        }
        if chans.len() > 1 {
            // channels left grey get palette colours
            for (k, c) in chans.iter_mut().enumerate() {
                if c.color == [1.0; 3] {
                    c.color = PALETTE[k % PALETTE.len()];
                }
            }
        }

        // planes: chunks in chunk order, each with its byte offset in the plane
        let zpos = |z: u32| zs.binary_search(&z).unwrap();
        let tpos = |t: u32| ts.binary_search(&t).unwrap();
        let mut grouped: HashMap<(usize, usize, usize), Vec<(u32, Chunk)>> = HashMap::new();
        for (u, c) in &pixels {
            let Some(ci) = chans.iter().position(|d| d.guid == u.guid && d.l == u.l) else { continue };
            grouped.entry((tpos(u.t), zpos(u.z), ci)).or_default().push((u.chunk, *c));
        }
        let planes_map: HashMap<(usize, usize, usize), PlaneChunks> = grouped
            .into_iter()
            .map(|(k, mut v)| {
                v.sort_by_key(|(n, _)| *n);
                v.dedup_by_key(|(n, _)| *n);
                let mut at = 0;
                let chunks = v
                    .into_iter()
                    .map(|(_, c)| {
                        let s = at;
                        at += c.len;
                        (s, c)
                    })
                    .collect();
                (k, chunks)
            })
            .collect();

        // focal planes: the Z step, else the frames' Z positions
        let nominal = (zs.len() - 1) / 2;
        let zpos_um: Vec<Option<f64>> = zs.iter().map(|&z| frames.iter().find(|f| f.tlz.2 == z && f.tlz.0 == t0).and_then(|f| f.axis("ZSTACK"))).collect();
        let offsets: Vec<Option<f64>> = if zs.len() <= 1 {
            vec![]
        } else if let Some(dz) = meta.z_step_um {
            zs.iter().map(|&z| Some(((z as f64 - zs[nominal] as f64) * dz * 1000.0).round())).collect()
        } else if zpos_um.iter().all(Option::is_some) {
            let z0 = zpos_um[nominal].unwrap();
            zpos_um.iter().map(|p| Some(((p.unwrap() - z0) * 1000.0).round())).collect()
        } else {
            vec![None; zs.len()]
        };
        let (z_planes, plane_pos) = make_planes(&offsets, nominal);

        let mut info = SourceInfo::basic("oir", width as i64, height as i64);
        info.vendor = Some("olympus".into());
        if let Some((x, y)) = meta.pixel_um.filter(|(x, y)| [*x, *y].iter().all(|m| m.is_finite() && *m > 0.001 && *m <= MAX_PLAUSIBLE_MPP)) {
            info.mpp_x = x;
            info.mpp_y = y;
            info.calibrated = true;
        }
        info.z_planes = z_planes;
        info.time_points = make_time_points(&time_seconds(&ts, &frames, meta.timelapse));
        info.levels = super::pyramid::level_sizes(width, height)
            .iter()
            .enumerate()
            .filter(|(k, l)| *k == 0 || l.0.max(l.1) >= TILE_SIZE)
            .map(|(k, l)| LevelInfo { width: l.0 as i64, height: l.1 as i64, downsample: (1u64 << k) as f64 })
            .collect();
        info.associated = vec!["thumbnail".into()];
        Ok(OirSource {
            path: path.to_string(),
            info,
            files,
            width,
            height,
            depth,
            chans,
            planes_map,
            zs,
            ts,
            plane_pos,
            nominal,
            looks: OnceLock::new(),
            planes: Mutex::new(PlaneCache::default()),
            build: Mutex::new(()),
        })
    }

    /// Channel names and colours (for tests and logs).
    pub fn channel_summary(&self) -> Vec<(String, [u8; 3])> {
        self.chans.iter().map(|c| (c.name.clone(), c.color.map(|v| (v * 255.0).round() as u8))).collect()
    }

    /// Number of time points (1 without a time axis).
    pub fn t_count(&self) -> usize {
        self.ts.len()
    }

    /// Number of distinct Z planes.
    pub fn z_count(&self) -> usize {
        self.zs.len()
    }

    /// Number of companion files read besides the main one.
    pub fn companion_count(&self) -> usize {
        self.files.len() - 1
    }

    /// Rows y0..y1 of one plane's samples (missing bytes read as 0).
    fn read_rows(&self, chunks: &PlaneChunks, y0: u32, y1: u32) -> Result<Vec<u16>, String> {
        let row = self.width as u64 * self.depth as u64;
        let (a, b) = (y0 as u64 * row, y1 as u64 * row);
        let mut buf = vec![0u8; (b - a) as usize];
        for (start, c) in chunks {
            let (s, e) = (*start, start + c.len);
            if e <= a || s >= b {
                continue;
            }
            let (lo, hi) = (s.max(a), e.min(b));
            let dst = &mut buf[(lo - a) as usize..(hi - a) as usize];
            read_at(&self.files[c.file], dst, c.offset + (lo - s)).map_err(|e| format!("{}: {e}", self.path))?;
        }
        Ok(match self.depth {
            1 => buf.into_iter().map(u16::from).collect(),
            _ => buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(),
        })
    }

    /// Each channel's colour and stretch, from the nominal plane of the first time point.
    fn looks(&self) -> Result<&Vec<ChanLook>, String> {
        if let Some(l) = self.looks.get() {
            return Ok(l);
        }
        let n = if self.depth == 1 { 256 } else { 65536 };
        let step = (self.height / 512).max(1);
        let mut out = Vec::new();
        for (ci, ch) in self.chans.iter().enumerate() {
            let mut hist = vec![0u64; n];
            if let Some(chunks) = self.planes_map.get(&(0, self.nominal, ci)) {
                let xstep = (self.width as usize / 2048).max(1);
                for y in (0..self.height).step_by(step as usize) {
                    for &v in self.read_rows(chunks, y, y + 1)?.iter().step_by(xstep) {
                        hist[(v as usize).min(n - 1)] += 1;
                    }
                }
            }
            let (mut lo, hi) = percentile_range(&hist, STRETCH_LO, STRETCH_HI);
            // fluorescence: the dark background is black, not dim colour
            if let Some(bg) = background_peak(&hist, lo, hi) {
                lo = lo.max(bg).min(hi - 1);
            }
            out.push(ChanLook { pos: ci as u32, color: ch.color, lo: lo as f32, hi: hi as f32 });
        }
        let _ = self.looks.set(out);
        Ok(self.looks.get().unwrap())
    }

    /// Composite time position `tp`, z position `zp` onto the canvas, a band of rows at a time.
    fn paint(&self, tp: usize, zp: usize, c: &mut Canvas) -> Result<(), String> {
        let looks = self.looks()?;
        let band = ((BAND_PIXELS / self.width as u64).max(1) as u32).min(self.height);
        let mut y0 = 0;
        while y0 < self.height {
            let y1 = (y0 + band).min(self.height);
            let mut data = Vec::new();
            for (ci, look) in looks.iter().enumerate() {
                if let Some(chunks) = self.planes_map.get(&(tp, zp, ci)) {
                    let v: Vec<f32> = self.read_rows(chunks, y0, y1)?.into_iter().map(|s| s as f32).collect();
                    data.push((look, v));
                }
            }
            let layers: Vec<(&ChanLook, &[f32])> = data.iter().map(|(l, v)| (*l, v.as_slice())).collect();
            if let Some(img) = composite(self.width, y1 - y0, &layers) {
                c.write_rect(0, y0, self.width, y1 - y0, img.as_raw())?;
            }
            y0 = y1;
        }
        Ok(())
    }

    /// Build (or fetch) the pyramid of time position `tp`, z position `zp`.
    fn plane(&self, tp: usize, zp: usize) -> Result<Arc<Pyramid>, String> {
        let key = (tp, zp);
        if let Some(p) = self.cached_plane(key) {
            return Ok(p);
        }
        let _g = self.build.lock().unwrap();
        if let Some(p) = self.cached_plane(key) {
            return Ok(p);
        }
        let (w, h) = (self.width, self.height);
        let big = w as u64 * h as u64 > MEM_PIXELS;
        let pyr = if big {
            let root = cache_dir("oir");
            // the first time point keeps the plain `z<n>` name (folders cached before time series)
            let sub = if tp == 0 { format!("z{zp}") } else { format!("t{tp}z{zp}") };
            let dir = root.join(cache_key(&self.path)).join(sub);
            if let Some(p) = open_cached(&dir, w, h) {
                p
            } else {
                prune(&root, &self.path);
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(dir.join("complete"));
                let mut c = Canvas::disk(&dir.join("L0.rgb"), w, h)?;
                self.paint(tp, zp, &mut c)?;
                let p = Pyramid::on_disk(c, &dir, MEM_PIXELS / 4)?;
                std::fs::write(dir.join("complete"), format!("{w} {h}")).map_err(|e| e.to_string())?;
                p
            }
        } else {
            let mut c = Canvas::Mem(RgbImage::new(w, h));
            self.paint(tp, zp, &mut c)?;
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

    /// (time position, z position) of a tile `z` (plane + t × `T_STRIDE`).
    fn pos(&self, z: u32) -> Result<(usize, usize), String> {
        let (plane, t) = split_z(z);
        if t as usize >= self.ts.len() {
            return Err(format!("{}: no time point {t} ({} time points)", self.path, self.ts.len()));
        }
        Ok((t as usize, self.plane_pos.get(plane as usize).copied().unwrap_or(self.nominal)))
    }

    fn fitted(&self, max_px: u32, z: u32) -> Result<RgbImage, String> {
        let (tp, zp) = self.pos(z)?;
        let pyr = self.plane(tp, zp)?;
        let k = pyr.level_at_least(max_px);
        let (w, h) = pyr.levels[k].size();
        let img = pyr.crop(k, 0, 0, w, h)?;
        let (ow, oh) = fit(self.info.width, self.info.height, max_px);
        Ok(if (ow, oh) != (w, h) { image::imageops::resize(&img, ow, oh, FilterType::Triangle) } else { img })
    }
}

impl SlideSource for OirSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (_, _, _, _, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        let native = (dz_max_level(self.info.width, self.info.height) - level) as usize;
        let (tp, zp) = self.pos(z)?;
        self.plane(tp, zp)?.crop(native, x * TILE_SIZE, y * TILE_SIZE, tw, th)
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
pub(crate) mod tests {
    use super::*;
    use crate::source::T_STRIDE;

    const G1: &str = "11111111-aaaa-4bbb-8ccc-000000000001";
    const G2: &str = "22222222-aaaa-4bbb-8ccc-000000000002";

    /// Builds an OIR file the way FluoView lays it out.
    pub struct Writer {
        pub buf: Vec<u8>,
        pub offsets: Vec<u64>,
    }

    impl Writer {
        pub fn new() -> Writer {
            let mut buf = MAGIC.to_vec();
            for v in [12u32, 0, 1, 2] {
                buf.extend(v.to_le_bytes());
            }
            buf.resize(HEADER_LEN, 0);
            buf[72..80].copy_from_slice(b"FLUOVIEW");
            Writer { buf, offsets: vec![] }
        }
        fn block(&mut self, typ: u32, payload: &[u8]) {
            self.offsets.push(self.buf.len() as u64);
            self.buf.extend((payload.len() as u32).to_le_bytes());
            self.buf.extend(typ.to_le_bytes());
            self.buf.extend_from_slice(payload);
        }
        /// a metadata block: the XML documents, each after `u32 36, guid, u32 len` when given a guid
        pub fn metadata(&mut self, docs: &[(Option<&str>, String)]) {
            let mut p = vec![1u8; 40];
            for (g, x) in docs {
                if let Some(g) = g {
                    p.extend(36u32.to_le_bytes());
                    p.extend(g.as_bytes());
                }
                p.extend((x.len() as u32).to_le_bytes());
                p.extend(x.as_bytes());
            }
            self.block(BLOCK_METADATA, &p);
        }
        pub fn frame(&mut self, xml: &str) {
            let mut p = vec![2u8; 40];
            p.extend(xml.as_bytes());
            self.block(BLOCK_FRAME, &p);
        }
        /// a plane split into `chunk`-byte pixel blocks, each after its UID block
        pub fn plane(&mut self, prefix: &str, guid: &str, bytes: &[u8], chunk: usize) {
            for (k, c) in bytes.chunks(chunk).enumerate() {
                let uid = format!("{prefix}_0_1_{guid}_{k}");
                let mut p = ((k * chunk) as u32).to_le_bytes().to_vec();
                p.extend((c.len() as u32).to_le_bytes());
                p.extend((uid.len() as u32).to_le_bytes());
                p.extend(uid.as_bytes());
                self.block(BLOCK_UID, &p);
                self.block(BLOCK_PIXEL, c);
            }
        }
        pub fn finish(mut self) -> Vec<u8> {
            self.block(5, &[]);
            let index_pos = self.buf.len() as u64;
            self.buf.extend(INDEX_MARKER.to_le_bytes());
            for o in &self.offsets.clone() {
                self.buf.extend(o.to_le_bytes());
            }
            self.buf.extend([0u8; 16]);
            let size = self.buf.len() as u64;
            self.buf[32..40].copy_from_slice(&size.to_le_bytes());
            self.buf[40..48].copy_from_slice(&index_pos.to_le_bytes());
            self.buf
        }
    }

    pub fn image_props(chans: &[(&str, &str, Option<(u32, u32)>)], w: u32, h: u32, mpp: f64, dz: f64) -> String {
        let mut s = String::from(r#"<?xml version="1.0" encoding="ASCII"?><lsmimage:imageProperties xmlns:lsmimage="x" xmlns:commonimage="y" xmlns:commonphase="z" xmlns:commonparam="w"><commonimage:imageInfo><commonimage:phase id="p">"#);
        for (k, (id, name, wl)) in chans.iter().enumerate() {
            s += &format!(r#"<commonphase:group id="g{k}"><commonphase:channel id="{id}" order="{}">"#, k + 1);
            if let Some((a, b)) = wl {
                s += &format!("<x:wavelengthRange><o:startWavelength>{a}</o:startWavelength><o:endWavelength>{b}</o:endWavelength></x:wavelengthRange>");
            }
            s += &format!("<commonphase:name>{name}</commonphase:name><commonphase:length><commonparam:x>{mpp}</commonparam:x><commonparam:y>{mpp}</commonparam:y><commonparam:z>{dz}</commonparam:z></commonphase:length><commonphase:pixelUnit><commonphase:x>MICRO_METER</commonphase:x></commonphase:pixelUnit><commonphase:imageDefinition><commonphase:width>99</commonphase:width></commonphase:imageDefinition></commonphase:channel></commonphase:group>");
        }
        s += &format!("</commonimage:phase><commonimage:width>{w}</commonimage:width><commonimage:height>{h}</commonimage:height></commonimage:imageInfo>");
        s += r#"<commonparam:axis enable="true"><commonparam:axis>ZSTACK</commonparam:axis><commonparam:startPosition>0</commonparam:startPosition><commonparam:step>1.0</commonparam:step></commonparam:axis>"#;
        s += r#"<commonparam:axis enable="true" lockStep="false"><commonparam:axis>TIMELAPSE</commonparam:axis><commonparam:startPosition>0.0</commonparam:startPosition><commonparam:endPosition>150.0</commonparam:endPosition><commonparam:step>30.0</commonparam:step><commonparam:maxSize>5</commonparam:maxSize></commonparam:axis>"#;
        s += r#"<commonparam:axis enable="false"><commonparam:axis>LAMBDA</commonparam:axis><commonparam:startPosition>400.0</commonparam:startPosition><commonparam:step>10.0</commonparam:step></commonparam:axis>"#;
        s += "</lsmimage:imageProperties>";
        s
    }

    pub fn frame_props(id: &str, w: u32, h: u32, z_um: f64) -> String {
        frame_props_t(id, w, h, z_um, None)
    }

    /// A frame with a TIMELAPSE position (ms) too.
    pub fn frame_props_t(id: &str, w: u32, h: u32, z_um: f64, t_ms: Option<f64>) -> String {
        let t = t_ms
            .map(|ms| format!("<commonframe:axisValue><commonframe:axisType>TIMELAPSE</commonframe:axisType><commonframe:position>{ms}</commonframe:position></commonframe:axisValue>"))
            .unwrap_or_default();
        format!(
            r#"<?xml version="1.0" encoding="ASCII"?><lsmframe:frameProperties xmlns:lsmframe="a" xmlns:base="b" xmlns:commonframe="c" id="{id}"><lsmframe:imageDefinition><base:colorType>GlayScale</base:colorType><base:width>{w}</base:width><base:height>{h}</base:height><base:depth>2</base:depth><base:bitCounts>12</base:bitCounts></lsmframe:imageDefinition><commonframe:axisValue><commonframe:axisType>ZSTACK</commonframe:axisType><commonframe:position>{z_um}</commonframe:position></commonframe:axisValue>{t}</lsmframe:frameProperties>"#
        )
    }

    pub fn lut(name: &str, rgb: [u8; 3]) -> String {
        let comp = |c: &str, on: u8| format!("<lut:{c}><lut:intensity>0.0</lut:intensity><lut:contrast>{on}.0</lut:contrast><lut:highlight>65535</lut:highlight></lut:{c}>");
        format!(
            r#"<?xml version="1.0" encoding="ASCII"?><lut:LUT xmlns:lut="l"><lut:name>{name}</lut:name><lut:all><lut:highlight>4095</lut:highlight></lut:all>{}{}{}<lut:data>00000000ffff</lut:data></lut:LUT>"#,
            comp("red", rgb[0]),
            comp("green", rgb[1]),
            comp("blue", rgb[2])
        )
    }

    #[test]
    fn header_and_index() {
        let mut w = Writer::new();
        w.frame("<?xml?><a/>");
        w.frame("<?xml?><b/>");
        let off = w.offsets.clone();
        let b = w.finish();
        let h = parse_header(&b).unwrap();
        assert_eq!(h.size, b.len() as u64);
        let idx = parse_index(&b[h.index_pos as usize..], h.size).unwrap();
        assert_eq!(&idx[..2], &off[..]);
        assert!(parse_header(b"OLYMPUSRAWFORMA_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").is_err());
        assert!(parse_index(&[0, 0, 0, 0, 1], 100).is_none(), "no index marker");
        // the chain walk finds the same blocks
        let read8 = |p: u64| -> Option<[u8; 8]> { b.get(p as usize..p as usize + 8).map(|s| s.try_into().unwrap()) };
        assert_eq!(walk_blocks(&read8, HEADER_LEN as u64, h.index_pos), idx);
    }

    #[test]
    fn uids() {
        let u = parse_uid("z003t001_0_1_8bf167bc-288a-4fa1-8817-0814f5e321ed_12").unwrap();
        assert_eq!((u.t, u.l, u.z, u.chunk), (1, 0, 3, 12));
        assert_eq!(u.guid, "8bf167bc-288a-4fa1-8817-0814f5e321ed");
        let u = parse_uid("l002z001_0_1_93e4632f-0342-4d98-bdc1-4ce305b92525_37").unwrap();
        assert_eq!((u.t, u.l, u.z, u.chunk), (0, 2, 1, 37));
        let u = parse_uid("t032_0_1_11a00d5c-257b-4e56-a6c5-657a43b32ebc_2").unwrap();
        assert_eq!((u.t, u.l, u.z), (32, 0, 0));
        assert!(parse_uid("REF_LSM0_2344d1b7-79e9-408e-9bc6-6fca2463e871_0").is_none(), "reference image");
        assert!(parse_uid("garbage").is_none());
        assert_eq!(parse_axes("l001z013t002_0_1"), (2, 1, 13));
    }

    #[test]
    fn metadata() {
        let x = image_props(&[(G1, "CH1", Some((430, 470))), (G2, "CH2", None)], 64, 48, 0.4143, 0.5);
        let m = parse_image_props(&x);
        assert_eq!(m.channels.len(), 2);
        assert_eq!(m.channels[0], ChannelMeta { id: G1.into(), name: "CH1".into(), order: 1, wavelength: Some((430.0, 470.0)) });
        assert_eq!(m.channels[1].wavelength, None);
        assert_eq!(m.pixel_um, Some((0.4143, 0.4143)));
        assert_eq!(m.z_step_um, Some(0.5));
        assert_eq!(m.size, Some((64, 48)), "the image's width, not a channel's");
        assert_eq!(m.timelapse, Some((0.0, 30.0)));
        assert_eq!(m.lambda, None, "a disabled axis is ignored");
        let f = parse_frame(&frame_props("z002t001_0_1", 64, 48, 4151.7));
        assert_eq!((f.tlz, f.width, f.height, f.depth), ((1, 0, 2), 64, 48, 2));
        assert_eq!(f.axis("ZSTACK"), Some(4151.7));
        let f = parse_frame(&frame_props_t("z008t005_0_1", 64, 48, 4903.91, Some(135743.168)));
        assert_eq!((f.tlz, f.axis("TIMELAPSE")), ((5, 0, 8), Some(135743.168)));
        assert_eq!(parse_lut_color(&lut("Cyan", [0, 1, 1])), Some([0.0, 1.0, 1.0]));
        assert_eq!(parse_lut_color(&lut("Gray", [1, 1, 1])), None);
        // documents and the GUID before each
        let mut p = vec![0u8; 40];
        p.extend((5u32).to_le_bytes());
        p.extend(b"<?xml?><a/>\x07\x00");
        p.extend(36u32.to_le_bytes());
        p.extend(G2.as_bytes());
        p.extend(9u32.to_le_bytes());
        p.extend(b"<?xml?><lut:LUT/>");
        let d = split_xml_docs(&p);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], (None, "<?xml?><a/>".to_string()));
        assert_eq!(d[1].0.as_deref(), Some(G2));
        assert_eq!(root_name(&d[1].1), "LUT");
        // XML text, attributes, nesting
        let n = parse_xml(r#"<a:r id="x &amp; y"><b>1.5</b><c><b>2</b></c><d/></a:r>"#);
        assert_eq!(n[0].attr("id"), Some("x & y"));
        assert_eq!(find_num(&n, Some(2), "b"), Some(2.0));
        assert_eq!(find_num(&n, None, "b"), Some(1.5));
        assert_eq!(n[0].end, 5);
    }

    #[test]
    fn time_points() {
        let fr = |t: u32, z: u32, ms: Option<f64>| parse_frame(&frame_props_t(&format!("z{z:03}t{t:03}_0_1"), 8, 8, 0.0, ms));
        // the earliest frame of each time point (later Z planes are acquired later)
        let frames = vec![fr(1, 1, Some(0.0)), fr(1, 2, Some(2249.0)), fr(2, 2, Some(32249.0)), fr(2, 1, Some(30000.0)), fr(3, 1, Some(60000.0))];
        assert_eq!(time_seconds(&[1, 2, 3], &frames, Some((0.0, 30.0))), vec![Some(0.0), Some(30.0), Some(60.0)]);
        // frames without a time: the axis definition; neither: None
        let bare = vec![fr(1, 1, None), fr(2, 1, None)];
        assert_eq!(time_seconds(&[1, 2], &bare, Some((0.0, 2.5))), vec![Some(0.0), Some(2.5)]);
        assert_eq!(time_seconds(&[1, 2], &bare, None), vec![None, None]);
        // no time axis at all (t = 0 in the UIDs): one time point, so no time slider
        assert!(make_time_points(&time_seconds(&[0], &bare, None)).is_empty());
        let tp = make_time_points(&time_seconds(&[1, 2, 3], &frames, None));
        assert_eq!(tp.iter().map(|t| t.label.as_str()).collect::<Vec<_>>(), ["0 s", "30 s", "1 min 0 s"]);
    }

    /// A two-channel, three-plane 16-bit stack: channel 1 bright on the left, channel 2 on the
    /// right, the planes dimmer away from the middle, at two time points (2.5 s apart). The second
    /// has only channel 1, saturated, and only in the middle plane. With `split`, the last plane's
    /// chunks and the second time point are in a companion file.
    fn synthetic(dir: &Path, split: bool) -> PathBuf {
        let (w, h) = (40u32, 30u32);
        let mut wr = Writer::new();
        let props = image_props(&[(G1, "CH1", Some((430, 470))), (G2, "CH2", Some((570, 620)))], w, h, 0.25, 0.5);
        wr.metadata(&[(None, props), (Some(G1), lut("Cyan", [0, 1, 1])), (Some(G2), lut("Gray", [1, 1, 1]))]);
        let mut comp = Writer::new();
        for z in 1..=3u32 {
            let id = format!("z{z:03}t001");
            wr.frame(&frame_props_t(&format!("{id}_0_1"), w, h, 100.0 + z as f64 * 0.5, Some(z as f64 * 100.0)));
            for (gi, g) in [G1, G2].iter().enumerate() {
                let px: Vec<u8> = (0..w * h)
                    .flat_map(|i| {
                        let x = i % w;
                        let on = (x < w / 2) == (gi == 0);
                        let v: u16 = if on { if z == 2 { 4000 } else { 1000 } } else { 100 + (i % 7) as u16 };
                        v.to_le_bytes()
                    })
                    .collect();
                // 7 rows of 40 px per chunk: chunks don't end on row boundaries in general
                let target = if split && z == 3 { &mut comp } else { &mut wr };
                target.plane(&id, g, &px, 7 * 40 * 2 + 6);
            }
        }
        // the second time point
        wr.frame(&frame_props_t("z002t002_0_1", w, h, 101.0, Some(2600.0)));
        wr.frame(&frame_props_t("z001t002_0_1", w, h, 100.5, Some(2500.0)));
        let target = if split { &mut comp } else { &mut wr };
        target.plane("z002t002", G1, &vec![0xFF; (w * h * 2) as usize], 1000);
        let p = dir.join("stack.oir");
        std::fs::write(&p, wr.finish()).unwrap();
        if split {
            std::fs::write(dir.join("stack_00001"), comp.finish()).unwrap();
        }
        p
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sv-oir-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn synthetic_file_opens() {
        for split in [false, true] {
            let dir = tmp(if split { "split" } else { "one" });
            let p = synthetic(&dir, split);
            let s = OirSource::open(p.to_str().unwrap()).unwrap();
            assert_eq!(s.companion_count(), split as usize);
            let i = s.info();
            assert_eq!((i.width, i.height, i.calibrated, i.mpp_x, i.format.as_str()), (40, 30, true, 0.25, "oir"));
            assert_eq!(s.z_count(), 3);
            assert_eq!(i.z_planes.iter().map(|z| (z.index, z.offset_nm)).collect::<Vec<_>>(), vec![(1, Some(-500.0)), (0, Some(0.0)), (2, Some(500.0))]);
            // stored LUT colour (cyan); grey LUT → emission wavelength (595 nm, orange)
            let cs = s.channel_summary();
            assert_eq!(cs[0], ("CH1".to_string(), [0, 255, 255]));
            assert_eq!(cs[1].1[0], 255);
            assert!(cs[1].1[1] > 50 && cs[1].1[1] < 200 && cs[1].1[2] == 0, "{:?}", cs[1]);
            let max = dz_max_level(40, 30);
            let t = s.tile(max, 0, 0, 0).unwrap();
            assert_eq!(t.dimensions(), (40, 30));
            assert_eq!(t.get_pixel(2, 2).0, [0, 255, 255], "CH1 half is cyan");
            let r = t.get_pixel(38, 29).0;
            assert!(r[0] == 255 && r[2] == 0, "CH2 half is orange: {r:?}");
            // every row decoded in place (chunks straddle rows)
            for y in 0..30 {
                assert_eq!(t.get_pixel(5, y).0, [0, 255, 255], "row {y}");
            }
            // the top plane is dimmer with the same stretch, and comes from the companion when split
            let top = s.tile(max, 0, 0, 2).unwrap();
            assert!(top.get_pixel(2, 2).0[1] > 0 && top.get_pixel(2, 2).0[1] < 128, "{:?}", top.get_pixel(2, 2));
            assert_eq!(s.overview(20, 0).unwrap().dimensions(), (20, 15));
            // the second time point: 2.5 s (its earliest frame), saturated channel 1 only
            assert_eq!(s.t_count(), 2);
            let tp: Vec<_> = i.time_points.iter().map(|t| (t.index, t.seconds, t.label.as_str())).collect();
            assert_eq!(tp, vec![(0, Some(0.1), "0.1 s"), (1, Some(2.5), "2.5 s")]);
            let t1 = s.tile(max, 0, 0, T_STRIDE).unwrap();
            assert_eq!(t1.get_pixel(38, 29).0, [0, 255, 255], "t 1: channel 1 everywhere");
            assert_eq!(s.tile(max, 0, 0, 0).unwrap().get_pixel(38, 29).0, r, "t 0 unchanged");
            // a plane missing at t 1 is black; a time point past the end is an error
            assert_eq!(s.tile(max, 0, 0, 2 + T_STRIDE).unwrap().get_pixel(2, 2).0, [0, 0, 0]);
            assert!(s.tile(max, 0, 0, 2 * T_STRIDE).is_err());
            assert_eq!(s.overview(20, T_STRIDE).unwrap().get_pixel(19, 14).0, [0, 255, 255]);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn companion_alone_points_at_main() {
        let dir = tmp("comp");
        let p = synthetic(&dir, true);
        let c = dir.join("stack_00001.oir");
        std::fs::rename(dir.join("stack_00001"), &c).unwrap();
        assert_eq!(companions(&p), vec![c.clone()]);
        let e = OirSource::open(c.to_str().unwrap()).err().unwrap();
        assert!(e.contains("open") && e.contains("stack.oir"), "{e}");
        assert!(OirSource::open(dir.join("missing.oir").to_str().unwrap()).is_err());
        std::fs::write(dir.join("junk.oir"), b"not an oir").unwrap();
        let e = OirSource::open(dir.join("junk.oir").to_str().unwrap()).err().unwrap();
        assert!(e.contains("not an Olympus OIR"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A 1.9 GB stitched FluoView series split over `Stitch_A01_G001.oir` and `Stitch_A01_G001_00001`
    /// (zenodo.org/records/13680725, CC BY 4.0; too big for the fetch script, download it by hand
    /// to test-data/formats/Olympus-OIR-split). Planes 31–53 live in the companion file.
    #[test]
    #[ignore]
    fn real_oir_split_series() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats/Olympus-OIR-split/Stitch_A01_G001.oir");
        if !p.exists() {
            eprintln!("skip: not downloaded");
            return;
        }
        let s = OirSource::open(p.to_str().unwrap()).unwrap();
        let i = s.info();
        assert_eq!((i.width, i.height, s.z_count(), s.companion_count(), s.chans.len()), (3554, 2540, 53, 1, 2));
        assert!(i.time_points.is_empty() && s.t_count() == 1, "no time axis");
        // z position, per channel: (sum, pixel (2000, 1000)) as `oirfile` reads them
        for (zp, want) in [(26usize, [(2484246997u64, 436u16), (724690405, 176)]), (45, [(734637004, 59), (46013509, 0)])] {
            for (ci, (sum, px)) in want.into_iter().enumerate() {
                let v = s.read_rows(&s.planes_map[&(0, zp, ci)], 0, s.height).unwrap();
                assert_eq!(v.iter().map(|&x| x as u64).sum::<u64>(), sum, "z {zp} channel {ci}");
                assert_eq!(v[1000 * 3554 + 2000], px, "z {zp} channel {ci}");
            }
        }
        let top = i.z_planes.iter().find(|z| z.offset_nm == Some(9500.0)).unwrap();
        let o = s.overview(512, top.index).unwrap();
        if let Ok(d) = std::env::var("OIR_PNG_DIR") {
            o.save(Path::new(&d).join("Stitch_A01_G001.z+9.5.png")).unwrap();
        }
    }

    fn sample(name: &str) -> Option<String> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats/Olympus-OIR").join(name);
        p.exists().then(|| p.to_string_lossy().to_string())
    }

    /// Real FluoView files from the OME sample server (see tools/fetch-format-samples.py; not
    /// committed). The sample sums and the pixel at (100, 200) of each channel of the nominal plane
    /// (first time point) are what Gohlke's `oirfile` reads. `OIR_PNG_DIR=/tmp/x` saves each overview.
    #[test]
    #[ignore]
    fn real_oir_samples() {
        // name, size, z planes, µm/px, per channel: (sum, pixel (100, 200))
        let want: &[(&str, i64, usize, f64, &[(u64, u16)])] = &[
            ("tiling-sample-brain-section_A01_G001_0001.oir", 512, 53, 0.4143, &[(122061526, 618), (34988877, 203)]),
            ("1202-interval_30sec_sequence_frame_z stack.oir", 512, 8, 2.4859, &[(183008807, 1275), (146700485, 231)]),
            (
                "DAPI_mCherry_4Z_5Lambda-420-630-w10nm-s50nm.oir",
                512,
                4,
                0.3107,
                &[(93353714, 1074), (213899784, 1728), (289390088, 2732), (57550141, 480), (36184494, 180)],
            ),
        ];
        for &(name, size, nz, mpp, sums) in want {
            let Some(p) = sample(name) else {
                eprintln!("skip {name}: not downloaded");
                continue;
            };
            let s = OirSource::open(&p).unwrap();
            let i = s.info();
            eprintln!("{name}: {:?} z {:?}", s.channel_summary(), i.z_planes.iter().map(|z| &z.label).collect::<Vec<_>>());
            let tn = if name.starts_with("1202-interval") { 5 } else { 0 };
            assert_eq!(i.time_points.len(), tn, "{name}");
            assert_eq!((i.width, i.height, s.z_count(), s.chans.len()), (size, size, nz, sums.len()), "{name}");
            assert!(i.calibrated && (i.mpp_x - mpp).abs() < 1e-4, "{name}: {}", i.mpp_x);
            for (ci, &(sum, px)) in sums.iter().enumerate() {
                let v = s.read_rows(&s.planes_map[&(0, s.nominal, ci)], 0, s.height).unwrap();
                assert_eq!(v.iter().map(|&x| x as u64).sum::<u64>(), sum, "{name} channel {ci}");
                assert_eq!(v[200 * 512 + 100], px, "{name} channel {ci}");
            }
            let o = s.overview(512, 0).unwrap();
            if let Ok(d) = std::env::var("OIR_PNG_DIR") {
                o.save(Path::new(&d).join(format!("{name}.png"))).unwrap();
                for z in [&i.z_planes[0], &i.z_planes[nz - 1]] {
                    s.overview(512, z.index).unwrap().save(Path::new(&d).join(format!("{name}.z{}.png", z.index))).unwrap();
                }
            }
            // fluorescence: a mostly dark background with some signal
            let mean: f64 = o.as_raw().iter().map(|&v| v as f64).sum::<f64>() / o.as_raw().len() as f64;
            assert!(mean > 3.0 && mean < 160.0, "{name}: mean {mean}");
        }
    }

    /// The 30 s interval series (5 time points × 8 planes × 2 channels): every time point's
    /// nominal plane against `oirfile`, and the time labels from the frames' TIMELAPSE positions.
    #[test]
    #[ignore]
    fn real_oir_time_series() {
        let name = "1202-interval_30sec_sequence_frame_z stack.oir";
        let Some(p) = sample(name) else {
            eprintln!("skip {name}: not downloaded");
            return;
        };
        let s = OirSource::open(&p).unwrap();
        let i = s.info();
        let tp: Vec<_> = i.time_points.iter().map(|t| (t.index, t.seconds, t.label.as_str())).collect();
        assert_eq!(
            tp,
            vec![(0, Some(0.0), "0 s"), (1, Some(30.0), "30 s"), (2, Some(60.0), "1 min 0 s"), (3, Some(90.0), "1 min 30 s"), (4, Some(120.0), "2 min 0 s")]
        );
        // time point → per channel (sum, pixel (100, 200)) of z position 3, as `oirfile` reads them
        let want: [[(u64, u16); 2]; 5] = [
            [(183008807, 1275), (146700485, 231)],
            [(184364366, 1472), (146018634, 252)],
            [(180277436, 858), (143238147, 314)],
            [(178079175, 1118), (141942082, 291)],
            [(180650287, 1107), (142254938, 527)],
        ];
        assert_eq!(s.nominal, 3);
        for (t, chans) in want.iter().enumerate() {
            for (ci, &(sum, px)) in chans.iter().enumerate() {
                let v = s.read_rows(&s.planes_map[&(t, 3, ci)], 0, s.height).unwrap();
                assert_eq!(v.iter().map(|&x| x as u64).sum::<u64>(), sum, "t {t} channel {ci}");
                assert_eq!(v[200 * 512 + 100], px, "t {t} channel {ci}");
            }
        }
        // the rendered time points differ (same stretch), and each is built only when asked for
        assert!(s.planes.lock().unwrap().map.is_empty());
        let o0 = s.overview(512, 0).unwrap();
        let o4 = s.overview(512, 4 * T_STRIDE).unwrap();
        assert_eq!(s.planes.lock().unwrap().map.len(), 2);
        let diff = o0.as_raw().iter().zip(o4.as_raw()).filter(|(a, b)| a != b).count();
        assert!(diff > o0.as_raw().len() / 20, "time points 0 and 4 look the same ({diff} bytes differ)");
        if let Ok(d) = std::env::var("OIR_PNG_DIR") {
            for t in 0..5u32 {
                s.overview(512, t * T_STRIDE).unwrap().save(Path::new(&d).join(format!("{name}.t{t}.png"))).unwrap();
            }
        }
    }
}
