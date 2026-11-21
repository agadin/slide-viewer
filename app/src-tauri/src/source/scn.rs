//! Leica `.scn` slides OpenSlide refuses: fluorescence scans (Leica SCN400F). OpenSlide reads only
//! brightfield images ("Can't find main image"), so `.scn` tries OpenSlide first and falls back here.
//!
//! An SCN file is a BigTIFF whose first ImageDescription is XML describing a collection of images.
//! Each `<image>` has `<pixels>` with one `<dimension sizeX sizeY r [c] ifd>` per pyramid level `r`
//! (and per channel `c` for fluorescence: each channel is its own 8-bit grey IFD), a `<view>` giving
//! its place on the slide in nm, and for fluorescence `<channel index rgb name>` entries with the
//! display colour. The main image is the finest one; the brightfield image of the whole glass is
//! the macro. Channels are stretched (measured from the coarsest level) and added in their colours.
//! Owner: formats.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use image::{imageops::FilterType, RgbImage};

use super::bif::{merge_jpeg_tables, parse_xml, read_vec, Tiff};
use super::cache::Lru;
use super::vsi::{auto_range, composite, ChanLook};
use super::{dz_tile_rect, LevelInfo, SlideSource, SourceInfo};

const TAG_DESCRIPTION: u16 = 270;
const TAG_TILE_WIDTH: u16 = 322;
const TAG_TILE_LENGTH: u16 = 323;
const TAG_TILE_OFFSETS: u16 = 324;
const TAG_TILE_COUNTS: u16 = 325;
const TAG_JPEG_TABLES: u16 = 347;
const TAG_COMPRESSION: u16 = 259;

/// Decoded (composited) source tiles kept per slide.
const TILE_CACHE_BYTES: usize = 192 * 1024 * 1024;
/// Largest associated image served.
const ASSOC_MAX_PX: u32 = 2048;

// ---------------------------------------------------------------- the XML

/// One pyramid level of an image: its size and the IFD of each channel (one IFD for colour).
#[derive(Clone, Debug, PartialEq)]
pub struct ScnLevel {
    pub r: u32,
    pub w: u64,
    pub h: u64,
    /// (channel index, IFD), sorted by channel; channel 0 only for colour images
    pub ifds: Vec<(u32, usize)>,
}

/// One fluorescence channel: its index, display colour and name.
#[derive(Clone, Debug, PartialEq)]
pub struct ScnChannel {
    pub index: u32,
    pub color: [f32; 3],
    pub name: String,
}

/// One `<image>` of the collection.
#[derive(Clone, Debug, PartialEq)]
pub struct ScnImage {
    pub w: u64,
    pub h: u64,
    /// nm per pixel at full resolution (from `<view sizeX>` over `<pixels sizeX>`)
    pub nm_per_px: Option<f64>,
    /// levels, full resolution first
    pub levels: Vec<ScnLevel>,
    /// fluorescence channels; empty for a colour (brightfield) image
    pub channels: Vec<ScnChannel>,
    /// its `<view>` on the slide: (width, height) in nm
    pub view: Option<(f64, f64)>,
}

impl ScnImage {
    pub fn fluorescence(&self) -> bool {
        !self.channels.is_empty() || self.levels.first().is_some_and(|l| l.ifds.len() > 1)
    }
}

/// "#00ff00" → [0, 1, 0]
pub fn parse_rgb(s: &str) -> Option<[f32; 3]> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let v = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|x| x as f32 / 255.0);
    Some([v(0)?, v(2)?, v(4)?])
}

/// The images an SCN XML describes, in document order.
pub fn parse_scn_xml(xml: &str) -> Result<Vec<ScnImage>, String> {
    let els = parse_xml(xml);
    if !els.iter().any(|e| e.name == "scn" || e.name.ends_with(":scn")) {
        return Err("not a Leica SCN description".into());
    }
    // each element's nearest <image> ancestor (or itself)
    let image_of = |mut i: usize| -> Option<usize> {
        loop {
            if els[i].name == "image" {
                return Some(i);
            }
            i = els[i].parent?;
        }
    };
    let mut out: Vec<(usize, ScnImage)> = Vec::new();
    let get = |img: usize, out: &mut Vec<(usize, ScnImage)>| -> usize {
        match out.iter().position(|(k, _)| *k == img) {
            Some(p) => p,
            None => {
                out.push((img, ScnImage { w: 0, h: 0, nm_per_px: None, levels: vec![], channels: vec![], view: None }));
                out.len() - 1
            }
        }
    };
    let mut view_w: HashMap<usize, f64> = HashMap::new();
    for (i, e) in els.iter().enumerate() {
        let Some(img) = image_of(i) else { continue };
        match e.name.as_str() {
            "image" => {
                get(img, &mut out);
            }
            "pixels" => {
                let p = get(img, &mut out);
                out[p].1.w = e.num("sizeX")? as u64;
                out[p].1.h = e.num("sizeY")? as u64;
            }
            "dimension" => {
                let p = get(img, &mut out);
                let r = e.num("r").unwrap_or(0.0) as u32;
                let c = e.num("c").unwrap_or(0.0) as u32;
                let ifd = e.num("ifd")? as usize;
                let (w, h) = (e.num("sizeX")? as u64, e.num("sizeY")? as u64);
                let levels = &mut out[p].1.levels;
                match levels.iter_mut().find(|l| l.r == r) {
                    Some(l) => l.ifds.push((c, ifd)),
                    None => levels.push(ScnLevel { r, w, h, ifds: vec![(c, ifd)] }),
                }
            }
            "view" => {
                if let Ok(w) = e.num("sizeX") {
                    view_w.insert(img, w);
                    let p = get(img, &mut out);
                    out[p].1.view = e.num("sizeY").ok().map(|h| (w, h));
                }
            }
            "channel" => {
                let p = get(img, &mut out);
                let index = e.num("index").unwrap_or(out[p].1.channels.len() as f64) as u32;
                let color = e.attr("rgb").and_then(parse_rgb).unwrap_or([1.0; 3]);
                let name = e.attr("name").unwrap_or("").split('|').next().unwrap_or("").to_string();
                out[p].1.channels.push(ScnChannel { index, color, name });
            }
            _ => {}
        }
    }
    let mut images: Vec<ScnImage> = Vec::new();
    for (k, mut im) in out {
        if im.w == 0 || im.h == 0 || im.levels.is_empty() {
            continue;
        }
        im.levels.sort_by_key(|l| l.r);
        for l in &mut im.levels {
            l.ifds.sort();
        }
        im.channels.sort_by_key(|c| c.index);
        im.nm_per_px = view_w.get(&k).map(|v| v / im.w as f64).filter(|v| v.is_finite() && *v > 0.0);
        images.push(im);
    }
    if images.is_empty() {
        return Err("SCN description has no images".into());
    }
    Ok(images)
}

/// Images that show part of the glass (scan areas), not a picture of the whole slide: their view is
/// clearly smaller than the largest view in the file.
pub fn scan_areas(images: &[ScnImage]) -> Vec<usize> {
    let biggest = images.iter().filter_map(|i| i.view).fold((0.0f64, 0.0f64), |a, v| (a.0.max(v.0), a.1.max(v.1)));
    (0..images.len())
        .filter(|k| match images[*k].view {
            Some((w, h)) => w < 0.9 * biggest.0 || h < 0.9 * biggest.1,
            None => true,
        })
        .collect()
}

/// The main image (the finest; the most pixels on a tie) and the macro (the coarsest colour image
/// of the whole glass), as indices.
pub fn pick_images(images: &[ScnImage]) -> (usize, Option<usize>) {
    let px = |i: &ScnImage| i.w * i.h;
    let main = (0..images.len())
        .min_by(|a, b| {
            let (ia, ib) = (&images[*a], &images[*b]);
            let (ra, rb) = (ia.nm_per_px.unwrap_or(f64::MAX), ib.nm_per_px.unwrap_or(f64::MAX));
            ra.partial_cmp(&rb).unwrap().then(px(ib).cmp(&px(ia)))
        })
        .unwrap();
    let macro_ = (0..images.len()).filter(|i| *i != main && !images[*i].fluorescence()).max_by(|a, b| {
        let (ra, rb) = (images[*a].nm_per_px.unwrap_or(0.0), images[*b].nm_per_px.unwrap_or(0.0));
        ra.partial_cmp(&rb).unwrap()
    });
    (main, macro_)
}

// ---------------------------------------------------------------- pixels

/// One level of one image, ready to read: its tile grid per channel.
struct Level {
    w: u32,
    h: u32,
    tw: u32,
    th: u32,
    /// per channel position: tile offsets, byte counts, and JPEG tables if shared
    chans: Vec<(Vec<u64>, Vec<u64>, Option<Vec<u8>>)>,
}

/// An image's pyramid: colour tiles shown as they are, or fluorescence channels composited.
struct Reader {
    tiff: Arc<Tiff>,
    levels: Vec<Level>,
    /// None: colour; Some: the channels' looks (stretch and colour), by channel position
    looks: Option<Vec<ChanLook>>,
    background: [u8; 3],
    cache: Mutex<Lru<(usize, u32, u32), Arc<RgbImage>>>,
}

impl Reader {
    fn new(tiff: Arc<Tiff>, img: &ScnImage, cache_bytes: usize) -> Result<Reader, String> {
        let mut levels = Vec::new();
        for l in &img.levels {
            let first = l.ifds[0].1;
            let tw = tiff.uint(first, TAG_TILE_WIDTH).ok_or("SCN image is not tiled")? as u32;
            let th = tiff.uint(first, TAG_TILE_LENGTH).ok_or("SCN image is not tiled")? as u32;
            if tw == 0 || th == 0 || tw > 1 << 14 || th > 1 << 14 {
                return Err("SCN tile size out of range".into());
            }
            if let Some(c) = tiff.uint(first, TAG_COMPRESSION) {
                if c != 7 && c != 6 {
                    return Err(format!("unsupported: SCN tiles with TIFF compression {c}"));
                }
            }
            let mut chans = Vec::new();
            for (_, ifd) in &l.ifds {
                let offs = tiff.uints(*ifd, TAG_TILE_OFFSETS).ok_or("SCN image without tile offsets")?;
                let counts = tiff.uints(*ifd, TAG_TILE_COUNTS).ok_or("SCN image without tile byte counts")?;
                chans.push((offs, counts, tiff.bytes(*ifd, TAG_JPEG_TABLES)));
            }
            levels.push(Level { w: l.w as u32, h: l.h as u32, tw, th, chans });
        }
        let fluo = img.fluorescence();
        let looks = fluo.then(|| {
            let n = levels[0].chans.len();
            (0..n)
                .map(|p| {
                    let idx = img.levels[0].ifds[p].0;
                    let color = img.channels.iter().find(|c| c.index == idx).map(|c| c.color).unwrap_or([1.0; 3]);
                    ChanLook { pos: p as u32, color, lo: f32::NAN, hi: f32::NAN }
                })
                .collect()
        });
        let background = if fluo { [0; 3] } else { [255; 3] };
        let mut r = Reader { tiff, levels, looks, background, cache: Mutex::new(Lru::new(cache_bytes)) };
        r.measure_ranges();
        Ok(r)
    }

    /// Stretch each channel to its 0.5–99.8 percentile on the coarsest level.
    fn measure_ranges(&mut self) {
        let Some(n) = self.looks.as_ref().map(|l| l.len()) else { return };
        let top = self.levels.len() - 1;
        let tiles = self.levels[top].chans.first().map(|c| c.0.len()).unwrap_or(0);
        let mut ranges = Vec::new();
        for p in 0..n {
            let mut vals = Vec::new();
            for t in 0..tiles.min(64) {
                if let Ok(img) = self.decode(top, p, t) {
                    vals.extend(img.to_luma8().into_raw().into_iter().map(|v| v as f32));
                }
            }
            ranges.push(auto_range(&vals).unwrap_or((0.0, 255.0)));
        }
        if let Some(looks) = &mut self.looks {
            for (l, (lo, hi)) in looks.iter_mut().zip(ranges) {
                l.lo = lo;
                l.hi = hi;
            }
        }
    }

    fn decode(&self, li: usize, chan: usize, t: usize) -> Result<image::DynamicImage, String> {
        let (offs, counts, tables) = &self.levels[li].chans[chan];
        let (off, len) = (*offs.get(t).ok_or("no such tile")?, *counts.get(t).ok_or("no such tile")?);
        if len == 0 || len > 64 << 20 {
            return Err("empty or oversized SCN tile".into());
        }
        let raw = read_vec(&self.tiff.file, off, len as usize)?;
        let data = match tables {
            Some(tb) => merge_jpeg_tables(tb, &raw),
            None => raw,
        };
        image::load_from_memory_with_format(&data, image::ImageFormat::Jpeg).map_err(|e| format!("SCN tile: {e}"))
    }

    /// One source tile at (col, row) of level `li`, as RGB (colour, or composited channels).
    fn tile(&self, li: usize, col: u32, row: u32) -> Result<Arc<RgbImage>, String> {
        let key = (li, col, row);
        if let Some(t) = self.cache.lock().unwrap().get(&key) {
            return Ok(t);
        }
        let lv = &self.levels[li];
        let across = lv.w.div_ceil(lv.tw);
        let t = (row * across + col) as usize;
        let img = match &self.looks {
            None => self.decode(li, 0, t)?.to_rgb8(),
            Some(looks) => {
                let mut layers = Vec::new();
                for l in looks {
                    let g = self.decode(li, l.pos as usize, t)?.to_luma8();
                    layers.push((l, g.width(), g.height(), g.into_raw().into_iter().map(|v| v as f32).collect::<Vec<f32>>()));
                }
                let (w, h) = (layers[0].1, layers[0].2);
                let refs: Vec<(&ChanLook, &[f32])> = layers.iter().filter(|x| (x.1, x.2) == (w, h)).map(|x| (x.0, x.3.as_slice())).collect();
                composite(w, h, &refs).ok_or("bad SCN composite")?
            }
        };
        let a = Arc::new(img);
        self.cache.lock().unwrap().put(key, a.clone(), a.as_raw().len() + 64);
        Ok(a)
    }

    /// Pixels (lx, ly, w, h) of level `li`; outside the image is background.
    fn read_level(&self, li: usize, lx: i64, ly: i64, w: u32, h: u32) -> Result<RgbImage, String> {
        let lv = &self.levels[li];
        let mut out = RgbImage::from_pixel(w.max(1), h.max(1), image::Rgb(self.background));
        let (x0, y0) = (lx.max(0), ly.max(0));
        let (x1, y1) = ((lx + w as i64).min(lv.w as i64), (ly + h as i64).min(lv.h as i64));
        if x1 <= x0 || y1 <= y0 {
            return Ok(out);
        }
        let (tw, th) = (lv.tw as i64, lv.th as i64);
        for row in y0 / th..=(y1 - 1) / th {
            for col in x0 / tw..=(x1 - 1) / tw {
                let t = self.tile(li, col as u32, row as u32)?;
                image::imageops::overlay(&mut out, &*t, col * tw - lx, row * th - ly);
            }
        }
        // tiles are padded past the image edge: background there
        let (ex, ey) = ((lv.w as i64 - lx).max(0), (lv.h as i64 - ly).max(0));
        if ex < w as i64 || ey < h as i64 {
            for (x, y, p) in out.enumerate_pixels_mut() {
                if x as i64 >= ex || y as i64 >= ey {
                    *p = image::Rgb(self.background);
                }
            }
        }
        Ok(out)
    }

    /// The level-0 rectangle (x, y, w, h) scaled to out_w × out_h, from the coarsest level that is
    /// still at least as fine as needed.
    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32) -> Result<RgbImage, String> {
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        let w0 = self.levels[0].w as f64;
        let need = (w as f64 / out_w as f64).min(h as f64 / out_h as f64).max(1.0);
        let li = (0..self.levels.len()).rev().find(|k| w0 / self.levels[*k].w as f64 <= need * 1.0001).unwrap_or(0);
        let s = w0 / self.levels[li].w as f64;
        let (lx, ly) = ((x as f64 / s).floor() as i64, (y as f64 / s).floor() as i64);
        let lw = (((x + w) as f64 / s).ceil() as i64 - lx).max(1);
        let lh = (((y + h) as f64 / s).ceil() as i64 - ly).max(1);
        if lw as u64 * lh as u64 > super::MAX_STITCH_PIXELS {
            return Err("region too large".into());
        }
        let img = self.read_level(li, lx, ly, lw as u32, lh as u32)?;
        Ok(if img.dimensions() != (out_w, out_h) { image::imageops::resize(&img, out_w, out_h, FilterType::Triangle) } else { img })
    }
}

// ---------------------------------------------------------------- the slide

pub struct ScnSource {
    info: SourceInfo,
    main: Reader,
    macro_: Option<Reader>,
}

impl ScnSource {
    pub fn open(path: &str) -> Result<ScnSource, String> {
        let tiff = Arc::new(Tiff::open(path)?);
        let xml = tiff.text(0, TAG_DESCRIPTION).ok_or("not a Leica SCN file (no description)")?;
        let images = parse_scn_xml(&xml)?;
        // several scan areas (OpenSlide refuses these when their magnifications differ): showing one
        // of them would quietly hide the others, so say so instead
        let areas = scan_areas(&images);
        if areas.len() > 1 {
            return Err(format!("unsupported: this Leica slide has {} scan areas at different magnifications, which can't be shown together yet", areas.len()));
        }
        let (mi, macro_i) = pick_images(&images);
        let im = &images[mi];
        let main = Reader::new(tiff.clone(), im, TILE_CACHE_BYTES)?;
        let macro_ = macro_i.and_then(|k| Reader::new(tiff.clone(), &images[k], 32 << 20).ok());
        let mut info = SourceInfo::basic("scn", im.w as i64, im.h as i64);
        info.vendor = Some("leica".into());
        if let Some(nm) = im.nm_per_px.filter(|v| *v < 1e6) {
            info.mpp_x = nm / 1000.0;
            info.mpp_y = nm / 1000.0;
            info.calibrated = true;
        }
        let w0 = im.w as f64;
        info.levels = main.levels.iter().map(|l| LevelInfo { width: l.w as i64, height: l.h as i64, downsample: w0 / l.w as f64 }).collect();
        if macro_.is_some() {
            info.associated = vec!["macro".to_string()];
        }
        Ok(ScnSource { info, main, macro_ })
    }
}

impl SlideSource for ScnSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, _z: u32) -> Result<RgbImage, String> {
        let (w, h) = (self.info.width, self.info.height);
        let (fx, fy, fw, fh, tw, th) = dz_tile_rect(w, h, level, x, y)?;
        self.main.region(fx, fy, fw, fh, tw, th)
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, _z: u32) -> Result<RgbImage, String> {
        self.main.region(x, y, w, h, out_w, out_h)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        let m = self.macro_.as_ref().filter(|_| name == "macro").ok_or_else(|| format!("no associated image named {name:?}"))?;
        let (w, h) = (m.levels[0].w as i64, m.levels[0].h as i64);
        let (ow, oh) = super::fit(w, h, ASSOC_MAX_PX);
        m.region(0, 0, w, h, ow, oh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The structure of Leica-Fluorescence-1.scn (SCN400F): a brightfield macro, a fluorescence macro,
    /// and the 3-channel main image.
    const XML: &str = r##"<?xml version="1.0"?>
<scn xmlns="http://www.leica-microsystems.com/scn/2010/10/01">
 <collection name="x" sizeX="26564529" sizeY="76734666">
  <image name="m1"><pixels sizeX="1616" sizeY="4668">
    <dimension sizeX="1616" sizeY="4668" r="0" ifd="0"/><dimension sizeX="404" sizeY="1167" r="1" ifd="1"/></pixels>
   <view sizeX="26564529" sizeY="76734666" offsetX="0" offsetY="0"/></image>
  <image name="m2"><pixels sizeX="1616" sizeY="4668">
    <dimension sizeX="1616" sizeY="4668" r="0" ifd="3"/></pixels>
   <view sizeX="26564529" sizeY="76734666" offsetX="0" offsetY="0"/>
   <scanSettings><channelSettings><channel index="0" name="405|Empty" rgb="#0000ff"/></channelSettings></scanSettings></image>
  <image name="main"><pixels sizeX="4737" sizeY="6338">
    <dimension sizeX="4737" sizeY="6338" r="0" c="0" ifd="6"/><dimension sizeX="4737" sizeY="6338" r="0" c="1" ifd="7"/>
    <dimension sizeX="1184" sizeY="1584" r="1" c="1" ifd="10"/><dimension sizeX="1184" sizeY="1584" r="1" c="0" ifd="9"/></pixels>
   <view sizeX="2368500" sizeY="3169000" offsetX="8153037" offsetY="20180503"/>
   <scanSettings><channelSettings><channel index="1" name="L5|Empty" rgb="#00ff00"/><channel index="0" name="405|Empty" rgb="#0000ff"/></channelSettings></scanSettings></image>
 </collection></scn>"##;

    #[test]
    fn parses_the_collection() {
        let imgs = parse_scn_xml(XML).unwrap();
        assert_eq!(imgs.len(), 3);
        let m = &imgs[2];
        assert_eq!((m.w, m.h), (4737, 6338));
        assert!((m.nm_per_px.unwrap() - 500.0).abs() < 1e-6, "{:?}", m.nm_per_px);
        assert_eq!(m.levels.len(), 2);
        assert_eq!(m.levels[0].ifds, vec![(0, 6), (1, 7)]);
        assert_eq!(m.levels[1].ifds, vec![(0, 9), (1, 10)], "sorted by channel");
        assert_eq!(m.channels.iter().map(|c| (c.index, c.name.as_str())).collect::<Vec<_>>(), vec![(0, "405"), (1, "L5")]);
        assert_eq!(m.channels[0].color, [0.0, 0.0, 1.0]);
        assert!(m.fluorescence() && !imgs[0].fluorescence() && imgs[1].fluorescence());
        // main: the finest; macro: the brightfield picture of the glass (not the fluorescence one)
        assert_eq!(pick_images(&imgs), (2, Some(0)));
        assert_eq!(scan_areas(&imgs), vec![2], "one scan area; the other two show the whole glass");
        // several areas at different magnifications are refused, not shown one at a time
        let mut two = imgs.clone();
        let mut extra = imgs[2].clone();
        extra.nm_per_px = Some(2000.0);
        two.push(extra);
        assert_eq!(scan_areas(&two).len(), 2);
        assert!(parse_scn_xml("<other/>").is_err());
        assert!(parse_scn_xml(r#"<scn><collection/></scn>"#).is_err());
    }

    #[test]
    fn colours() {
        assert_eq!(parse_rgb("#ff0000"), Some([1.0, 0.0, 0.0]));
        assert_eq!(parse_rgb(" #00FF00 "), Some([0.0, 1.0, 0.0]));
        assert_eq!(parse_rgb("red"), None);
        assert_eq!(parse_rgb("#fff"), None);
    }

    /// A classic little-endian TIFF: one IFD per (width, height, jpeg tile) plus the description on
    /// the first. Every IFD is one 8×8 tile.
    fn tiff(desc: &str, tiles: &[(u32, u32, Vec<u8>)]) -> Vec<u8> {
        let mut f = b"II*\0\0\0\0\0".to_vec();
        let mut desc_b = desc.as_bytes().to_vec();
        desc_b.push(0);
        let desc_off = f.len() as u32;
        f.extend(&desc_b);
        let mut data_offs = Vec::new();
        for (_, _, jpg) in tiles {
            data_offs.push(f.len() as u32);
            f.extend(jpg);
        }
        let mut prev_next: Option<usize> = None;
        for (k, (w, h, jpg)) in tiles.iter().enumerate() {
            while f.len() % 2 != 0 {
                f.push(0);
            }
            let at = f.len() as u32;
            match prev_next {
                Some(p) => f[p..p + 4].copy_from_slice(&at.to_le_bytes()),
                None => f[4..8].copy_from_slice(&at.to_le_bytes()),
            }
            let mut e: Vec<(u16, u16, u32, u32)> = vec![(256, 4, 1, *w), (257, 4, 1, *h), (259, 3, 1, 7), (322, 4, 1, 8), (323, 4, 1, 8), (324, 4, 1, data_offs[k]), (325, 4, 1, jpg.len() as u32)];
            if k == 0 {
                e.push((270, 2, desc_b.len() as u32, desc_off));
            }
            e.sort();
            f.extend((e.len() as u16).to_le_bytes());
            for (tag, ty, n, v) in e {
                f.extend(tag.to_le_bytes());
                f.extend(ty.to_le_bytes());
                f.extend(n.to_le_bytes());
                f.extend(v.to_le_bytes());
            }
            prev_next = Some(f.len());
            f.extend(0u32.to_le_bytes());
        }
        f
    }

    fn grey_jpeg(v: impl Fn(u32, u32) -> u8) -> Vec<u8> {
        let img = image::GrayImage::from_fn(8, 8, |x, y| image::Luma([v(x, y)]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 100).encode(img.as_raw(), 8, 8, image::ExtendedColorType::L8).unwrap();
        out
    }

    #[test]
    fn composites_fluorescence_channels() {
        // a 6×5 image (inside one 8×8 tile), two channels: blue (left half bright), red (top half bright)
        let xml = r##"<scn><collection><image><pixels sizeX="6" sizeY="5">
            <dimension sizeX="6" sizeY="5" r="0" c="0" ifd="0"/><dimension sizeX="6" sizeY="5" r="0" c="1" ifd="1"/></pixels>
            <view sizeX="3000" sizeY="2500"/>
            <channelSettings><channel index="0" rgb="#0000ff"/><channel index="1" rgb="#ff0000"/></channelSettings></image></collection></scn>"##;
        let f = tiff(xml, &[(6, 5, grey_jpeg(|x, _| if x < 3 { 250 } else { 5 })), (6, 5, grey_jpeg(|_, y| if y < 2 { 250 } else { 5 }))]);
        let p = std::env::temp_dir().join(format!("sv-scn-{}.scn", std::process::id()));
        std::fs::write(&p, &f).unwrap();
        let s = ScnSource::open(&p.to_string_lossy()).unwrap();
        assert_eq!((s.info().width, s.info().height), (6, 5));
        assert!((s.info().mpp_x - 0.5).abs() < 1e-9, "500 nm per pixel");
        let img = s.region(0, 0, 6, 5, 6, 5, 0).unwrap();
        let px = |x, y| img.get_pixel(x, y).0;
        assert!(px(0, 0)[0] > 200 && px(0, 0)[2] > 200, "both channels: magenta {:?}", px(0, 0));
        assert!(px(0, 4)[2] > 200 && px(0, 4)[0] < 40, "blue only {:?}", px(0, 4));
        assert!(px(5, 0)[0] > 200 && px(5, 0)[2] < 40, "red only {:?}", px(5, 0));
        assert!(px(5, 4).iter().all(|c| *c < 40), "neither: black {:?}", px(5, 4));
        // outside the image: black background (fluorescence)
        assert_eq!(s.region(4, 3, 4, 4, 4, 4, 0).unwrap().get_pixel(3, 3).0, [0, 0, 0]);
        let _ = std::fs::remove_file(&p);
    }

    /// Leica-Fluorescence-1.scn from the OpenSlide test data, when present.
    #[test]
    #[ignore]
    fn real_fluorescence_scn() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data/formats/Leica__Leica-Fluorescence-1.scn");
        if !p.exists() {
            eprintln!("skipping: {} not present", p.display());
            return;
        }
        let s = ScnSource::open(&p.to_string_lossy()).unwrap();
        let i = s.info();
        assert_eq!((i.width, i.height), (4737, 6338));
        assert!(i.calibrated && (i.mpp_x - 0.5).abs() < 1e-9, "{}", i.mpp_x);
        assert_eq!(i.levels.len(), 4);
        assert_eq!(i.associated, vec!["macro".to_string()]);
        let o = s.overview(512, 0).unwrap();
        let lit = o.pixels().filter(|p| p.0.iter().any(|c| *c > 60)).count() as f64 / (o.width() * o.height()) as f64;
        assert!(lit > 0.05, "overview nearly black ({:.1}% lit)", lit * 100.0);
        let m = s.associated("macro").unwrap();
        assert!(m.height() > m.width(), "the glass slide is portrait");
        if let Ok(d) = std::env::var("SCN_DUMP") {
            o.save(format!("{d}/scn_fl_overview.png")).unwrap();
            m.save(format!("{d}/scn_fl_macro.png")).unwrap();
        }
    }
}
