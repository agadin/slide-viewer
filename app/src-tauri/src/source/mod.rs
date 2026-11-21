//! Slide sources: one trait every image backend implements, and the registry of open slides.
//!
//! Owner: formats builder (everything under `src/source/`). The trait, `SourceInfo`/`SlideInfo`
//! field names, the Deep-Zoom tile geometry and the registry's public methods are a CONTRACT
//! (see CONTRACTS.md): lib.rs, scan.rs and the frontend rely on them. Add, don't rename.

pub mod bif;
pub mod scn;
pub mod cache;
pub mod czi;
pub mod lif;
pub mod nd2;
pub mod ndpi;
pub mod oir;
pub mod openslide;
pub mod plain;
pub mod pyramid;
pub mod vsi;
pub mod zvi;

use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::{Arc, Mutex};

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageEncoder, RgbImage};
use serde::Serialize;

/// Deep-Zoom tile edge in pixels (no overlap). Every backend serves this geometry.
pub const TILE_SIZE: u32 = 256;
/// Largest image `region()` will assemble before resizing.
pub const MAX_STITCH_PIXELS: u64 = 8192 * 8192;

/// One native pyramid level (informational: tiles always use the Deep-Zoom levels).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LevelInfo {
    pub width: i64,
    pub height: i64,
    pub downsample: f64,
}

/// One focal plane. `index` is what the tile URL's z carries.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZPlane {
    pub index: u32,
    /// distance from the nominal focus, nm (None when the format doesn't say)
    pub offset_nm: Option<f64>,
    /// shown on the slider, e.g. "+1.2 µm" or "Z 3"
    pub label: String,
}

/// One time point of a time series. `index` is what the tile z's time part carries (see `split_z`).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimePoint {
    pub index: u32,
    /// time since the start of the acquisition, seconds (None when the file doesn't say)
    pub seconds: Option<f64>,
    /// shown on the slider, e.g. "12.5 s" or "T 3"
    pub label: String,
}

/// The tile `z` carries both the focal plane and the time point: `z = plane + t * T_STRIDE`.
/// Backends without a time axis never see t > 0 (the frontend only sends it when
/// `time_points` has more than one entry).
pub const T_STRIDE: u32 = 1 << 16;

/// Split a tile `z` into (focal plane index, time point index).
pub fn split_z(z: u32) -> (u32, u32) {
    (z % T_STRIDE, z / T_STRIDE)
}

/// Time points with labels from their times in seconds (None → "T n"), index = position.
pub fn make_time_points(seconds: &[Option<f64>]) -> Vec<TimePoint> {
    if seconds.len() <= 1 {
        return vec![];
    }
    seconds
        .iter()
        .enumerate()
        .map(|(i, s)| TimePoint { index: i as u32, seconds: *s, label: s.map(time_label).unwrap_or_else(|| format!("T {}", i + 1)) })
        .collect()
}

/// "0 s", "12.5 s", "2 min 5 s", "1 h 02 min". Rounds first, then splits, so 899.9 s is "15 min 0 s".
pub fn time_label(secs: f64) -> String {
    let s = secs.max(0.0);
    let short = if s < 10.0 { (s * 100.0).round() / 100.0 } else { (s * 10.0).round() / 10.0 };
    if short < 60.0 {
        return format!("{} s", trim_num(short));
    }
    let whole = s.round() as i64;
    if whole < 3600 {
        return format!("{} min {} s", whole / 60, whole % 60);
    }
    let minutes = (s / 60.0).round() as i64;
    format!("{} h {:02} min", minutes / 60, minutes % 60)
}

/// What a backend knows about its image.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// backend that opened it: "openslide" | "plain" | "czi" | "bif" | "vsi" | "zvi" | "lif" | "oir"
    pub format: String,
    /// scanner vendor when known ("hamamatsu", "aperio", "zeiss", …)
    pub vendor: Option<String>,
    /// level-0 size in pixels
    pub width: i64,
    pub height: i64,
    /// µm per pixel. When the file has no calibration this is 1.0 and `calibrated` is false.
    pub mpp_x: f64,
    pub mpp_y: f64,
    pub calibrated: bool,
    /// Hamamatsu offsets of the image centre from the slide centre (nm); 0 for other formats.
    pub x_offset_nm: f64,
    pub y_offset_nm: f64,
    /// native pyramid, level 0 first
    pub levels: Vec<LevelInfo>,
    /// focal planes; always at least one (index 0)
    pub z_planes: Vec<ZPlane>,
    /// associated image names ("thumbnail", "macro", "label", …)
    pub associated: Vec<String>,
    /// time points; empty (or one) when the file has no time series
    pub time_points: Vec<TimePoint>,
    /// the images in a file that holds several (a .lif's images, an .nd2's stage positions), by
    /// name in file order; empty when there's only one. Each is opened separately
    /// (`open_source(path, series)`); `series_index` says which one this is.
    pub series: Vec<String>,
    pub series_index: u32,
    /// what one entry of `series` is called in the UI: "Image" or "Position"
    pub series_kind: String,
}

impl SourceInfo {
    /// A single-plane, uncalibrated image of the given size (backends fill in the rest).
    pub fn basic(format: &str, width: i64, height: i64) -> SourceInfo {
        SourceInfo {
            format: format.into(),
            vendor: None,
            width,
            height,
            mpp_x: 1.0,
            mpp_y: 1.0,
            calibrated: false,
            x_offset_nm: 0.0,
            y_offset_nm: 0.0,
            levels: vec![LevelInfo { width, height, downsample: 1.0 }],
            z_planes: vec![single_plane()],
            associated: vec![],
            time_points: vec![],
            series: vec![],
            series_index: 0,
            series_kind: "Image".into(),
        }
    }
}

pub fn single_plane() -> ZPlane {
    ZPlane { index: 0, offset_nm: None, label: "Z 0".into() }
}

/// Focal planes for a z-stack whose planes are given in slider order (`offsets_nm`, usually
/// ascending, bottom to top). `nominal` is the in-focus plane: it always gets `index` 0, so
/// the default tile URL (no z, or z 0) shows it; the other planes are numbered 1, 2, … in
/// slider order. Returns the planes (in slider order) and, for each index, its position in
/// `offsets_nm` (`pos[index]`).
pub fn make_planes(offsets_nm: &[Option<f64>], nominal: usize) -> (Vec<ZPlane>, Vec<usize>) {
    if offsets_nm.is_empty() {
        return (vec![single_plane()], vec![0]);
    }
    let nominal = nominal.min(offsets_nm.len() - 1);
    let mut pos = vec![nominal];
    let mut planes = Vec::with_capacity(offsets_nm.len());
    for (i, off) in offsets_nm.iter().enumerate() {
        let index = if i == nominal {
            0
        } else {
            pos.push(i);
            (pos.len() - 1) as u32
        };
        let label = match off {
            Some(nm) if nm.abs() < 0.5 => "0 µm".to_string(),
            Some(nm) => format!("{}{} µm", if *nm > 0.0 { "+" } else { "−" }, trim_num(nm.abs() / 1000.0)),
            None => format!("Z {}", i + 1),
        };
        planes.push(ZPlane { index, offset_nm: *off, label });
    }
    (planes, pos)
}

fn trim_num(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// What `open_slide` returns to the frontend (`SlideInfo` in app/src/lib/types.ts).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SlideInfo {
    pub id: u32,
    pub path: String,
    /// Deep-Zoom tile size (TILE_SIZE)
    pub tile_size: u32,
    /// Deep-Zoom level of full resolution: ceil(log2(max(width, height)))
    pub max_level: u32,
    #[serde(flatten)]
    pub source: SourceInfo,
}

/// An image backend. Implementations must be cheap to call from many threads at once
/// (tiles are rendered on a blocking thread pool).
pub trait SlideSource: Send + Sync {
    fn info(&self) -> &SourceInfo;

    /// One Deep-Zoom tile as RGB. `level` follows OpenSeadragon: `dz_max_level(w, h)` is full
    /// resolution and each lower level halves the size. Edge tiles are smaller than TILE_SIZE.
    /// `z` is a `ZPlane::index` plus the time point times `T_STRIDE` (`split_z`); backends without
    /// focal planes treat any plane as 0, and only backends with `time_points` see a time part.
    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String>;

    /// An associated image by name (see `SourceInfo::associated`).
    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        Err(format!("no associated image named {name:?}"))
    }

    /// The level-0 rectangle (x, y, w, h) scaled to out_w × out_h. The default stitches tiles;
    /// backends with a native region reader may override it.
    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String> {
        region_from_tiles(self, x, y, w, h, out_w, out_h, z)
    }

    /// The whole image fitted into max_px × max_px (for thumbnails and stain estimation).
    fn overview(&self, max_px: u32, z: u32) -> Result<RgbImage, String> {
        let i = self.info();
        let (ow, oh) = fit(i.width, i.height, max_px);
        self.region(0, 0, i.width, i.height, ow, oh, z)
    }
}

/// Deep-Zoom level of full resolution.
pub fn dz_max_level(width: i64, height: i64) -> u32 {
    (width.max(height).max(1) as f64).log2().ceil() as u32
}

/// Size of Deep-Zoom `level` and its downsample from level 0.
pub fn dz_level_size(width: i64, height: i64, level: u32) -> (u32, u32, f64) {
    let max = dz_max_level(width, height);
    let ds = 2f64.powi(max.saturating_sub(level) as i32);
    ((width as f64 / ds).ceil() as u32, (height as f64 / ds).ceil() as u32, ds)
}

/// The level-0 rectangle a Deep-Zoom tile covers, plus its output size:
/// (x0, y0, w0, h0, tile_w, tile_h). Err when the tile is outside the image.
pub fn dz_tile_rect(width: i64, height: i64, level: u32, tx: u32, ty: u32) -> Result<(i64, i64, i64, i64, u32, u32), String> {
    if level > dz_max_level(width, height) {
        return Err("bad level".into());
    }
    let (lw, lh, ds) = dz_level_size(width, height, level);
    let (Some(x0), Some(y0)) = (tx.checked_mul(TILE_SIZE), ty.checked_mul(TILE_SIZE)) else {
        return Err("tile out of range".into());
    };
    if x0 >= lw || y0 >= lh {
        return Err("tile out of range".into());
    }
    let tw = TILE_SIZE.min(lw - x0);
    let th = TILE_SIZE.min(lh - y0);
    let fx = (x0 as f64 * ds) as i64;
    let fy = (y0 as f64 * ds) as i64;
    let fw = ((tw as f64 * ds) as i64).min(width - fx).max(1);
    let fh = ((th as f64 * ds) as i64).min(height - fy).max(1);
    Ok((fx, fy, fw, fh, tw, th))
}

/// Largest size with the image's aspect ratio that fits in max_px × max_px (never upscales).
pub fn fit(width: i64, height: i64, max_px: u32) -> (u32, u32) {
    let s = (max_px as f64 / width.max(height).max(1) as f64).min(1.0);
    (((width as f64 * s).round() as u32).max(1), ((height as f64 * s).round() as u32).max(1))
}

/// Default `region`: pick the Deep-Zoom level just finer than needed, stitch its tiles, crop, resize.
pub fn region_from_tiles<S: SlideSource + ?Sized>(
    src: &S,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    out_w: u32,
    out_h: u32,
    z: u32,
) -> Result<RgbImage, String> {
    if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
        return Err("empty region".into());
    }
    let i = src.info();
    let max = dz_max_level(i.width, i.height);
    let need = (w as f64 / out_w as f64).min(h as f64 / out_h as f64).max(1.0);
    let drop = need.log2().floor().max(0.0) as u32;
    let level = max.saturating_sub(drop);
    let (lw, lh, ds) = dz_level_size(i.width, i.height, level);
    let lx0 = ((x as f64 / ds).floor().max(0.0) as u32).min(lw);
    let ly0 = ((y as f64 / ds).floor().max(0.0) as u32).min(lh);
    let lx1 = (((x + w) as f64 / ds).ceil().max(0.0) as u32).min(lw);
    let ly1 = (((y + h) as f64 / ds).ceil().max(0.0) as u32).min(lh);
    // white canvas covering the requested rectangle at this level
    let cw = ((w as f64 / ds).ceil() as u32).max(1);
    let ch = ((h as f64 / ds).ceil() as u32).max(1);
    if cw as u64 * ch as u64 > MAX_STITCH_PIXELS {
        return Err("region too large".into());
    }
    let mut canvas = RgbImage::from_pixel(cw, ch, image::Rgb([255, 255, 255]));
    if lx1 > lx0 && ly1 > ly0 {
        let ox = (x as f64 / ds).floor() as i64; // canvas origin in level px (may be negative)
        let oy = (y as f64 / ds).floor() as i64;
        for ty in ly0 / TILE_SIZE..=(ly1 - 1) / TILE_SIZE {
            for tx in lx0 / TILE_SIZE..=(lx1 - 1) / TILE_SIZE {
                let t = src.tile(level, tx, ty, z)?;
                let px = (tx * TILE_SIZE) as i64 - ox;
                let py = (ty * TILE_SIZE) as i64 - oy;
                image::imageops::overlay(&mut canvas, &t, px, py);
            }
        }
    }
    Ok(if canvas.width() != out_w || canvas.height() != out_h {
        image::imageops::resize(&canvas, out_w, out_h, FilterType::Triangle)
    } else {
        canvas
    })
}

pub fn encode_jpeg(img: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(32 * 1024);
    JpegEncoder::new_with_quality(Cursor::new(&mut bytes), quality)
        .encode_image(img)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub fn encode_png(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(Cursor::new(&mut bytes))
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// RGB → RGBA bytes (alpha 255), ready for `new ImageData(...)` in the frontend.
pub fn to_rgba(img: &RgbImage) -> Vec<u8> {
    let mut out = Vec::with_capacity(img.as_raw().len() / 3 * 4);
    for p in img.as_raw().chunks_exact(3) {
        out.extend_from_slice(&[p[0], p[1], p[2], 255]);
    }
    out
}

// ---------------------------------------------------------------- backends by extension

/// Formats OpenSlide reads (lower-case, with the dot).
pub const OPENSLIDE_EXTS: &[&str] = &[".ndpi", ".svs", ".tif", ".tiff", ".scn", ".mrxs", ".vms", ".vmu", ".bif", ".svslide", ".dcm", ".avs"];
/// Plain raster images (flat TIFFs are tried with OpenSlide first, then here).
pub const PLAIN_EXTS: &[&str] = &[".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"];
pub const CZI_EXTS: &[&str] = &[".czi"];
/// Ventana BIF: OpenSlide first, then `bif.rs` for the DP 200 files OpenSlide rejects.
pub const BIF_EXTS: &[&str] = &[".bif"];
/// Leica SCN: OpenSlide first, then `scn.rs` for the fluorescence files OpenSlide rejects.
pub const SCN_EXTS: &[&str] = &[".scn"];
/// Olympus cellSens / VS-series (pixels in the `_<name>_` folder next to the file).
pub const VSI_EXTS: &[&str] = &[".vsi"];
pub const ZVI_EXTS: &[&str] = &[".zvi"];
/// Leica LAS AF / LAS X project files.
pub const LIF_EXTS: &[&str] = &[".lif"];
/// Olympus FluoView confocal (FV3000/FV4000); a series continues in `name_00001`, … next to it.
pub const OIR_EXTS: &[&str] = &[".oir"];
/// Nikon NIS-Elements (modern chunked and legacy JPEG 2000).
pub const ND2_EXTS: &[&str] = &[".nd2"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    OpenSlide,
    Plain,
    Czi,
    Bif,
    Scn,
    Vsi,
    Zvi,
    Lif,
    Oir,
    Nd2,
}

fn lower_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Backends to try for this path, in order. Empty = not a slide we know.
pub fn backends_for(path: &str) -> Vec<Backend> {
    let n = lower_name(path);
    let has = |exts: &[&str]| exts.iter().any(|e| n.ends_with(e));
    let mut v = Vec::new();
    if has(CZI_EXTS) {
        v.push(Backend::Czi);
    }
    if has(VSI_EXTS) {
        v.push(Backend::Vsi);
    }
    if has(ZVI_EXTS) {
        v.push(Backend::Zvi);
    }
    if has(LIF_EXTS) {
        v.push(Backend::Lif);
    }
    if has(OIR_EXTS) {
        v.push(Backend::Oir);
    }
    if has(ND2_EXTS) {
        v.push(Backend::Nd2);
    }
    if has(OPENSLIDE_EXTS) {
        v.push(Backend::OpenSlide);
    }
    if has(BIF_EXTS) {
        v.push(Backend::Bif);
    }
    if has(SCN_EXTS) {
        v.push(Backend::Scn);
    }
    if has(PLAIN_EXTS) {
        v.push(Backend::Plain);
    }
    v
}

/// Every extension the app opens (for the folder scan and file dialogs), lower-case with the dot.
pub fn supported_extensions() -> Vec<String> {
    let mut v: Vec<String> = OPENSLIDE_EXTS.iter().chain(PLAIN_EXTS).chain(CZI_EXTS).chain(VSI_EXTS).chain(ZVI_EXTS).chain(LIF_EXTS).chain(OIR_EXTS).chain(ND2_EXTS).map(|s| s.to_string()).collect();
    v.sort();
    v.dedup();
    v
}

pub fn is_supported(path: &str) -> bool {
    !backends_for(path).is_empty()
}

/// Open a file with the first backend that accepts it (not registered: see `SlideRegistry::open`).
/// `series` picks one image of a multi-image file (`SourceInfo::series`); 0 is the default image.
pub fn open_source(path: &str, series: u32) -> Result<Arc<dyn SlideSource>, String> {
    let backends = backends_for(path);
    if backends.is_empty() {
        return Err(format!("{path}: not a supported image format"));
    }
    let mut errs = Vec::new();
    for b in backends {
        let r: Result<Arc<dyn SlideSource>, String> = match b {
            Backend::OpenSlide => openslide::OpenSlideSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Plain => plain::PlainSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Czi => czi::CziSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Bif => bif::BifSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Scn => scn::ScnSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Vsi => vsi::VsiSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Zvi => zvi::ZviSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Lif => lif::LifSource::open_series(path, series).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Oir => oir::OirSource::open(path).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
            Backend::Nd2 => nd2::Nd2Source::open_series(path, series).map(|s| Arc::new(s) as Arc<dyn SlideSource>),
        };
        match r {
            // every backend gets the shared tile LRU (cache.rs)
            Ok(s) => return Ok(Arc::new(cache::CachedSource::new(s))),
            Err(e) => errs.push(e),
        }
    }
    Err(errs.join("; "))
}

/// "unsupported" error used by stub backends and stub commands.
pub fn unsupported(what: &str) -> String {
    format!("unsupported: {what} is not implemented yet")
}

// ---------------------------------------------------------------- registry

fn registry_key(path: &str, series: u32) -> String {
    if series == 0 { path.to_string() } else { format!("{path}\u{0}{series}") }
}

struct Entry {
    source: Arc<dyn SlideSource>,
    info: SlideInfo,
}

/// Open slides by id. Ids are never reused within a run, so a stale tile URL can't hit another slide.
#[derive(Default)]
pub struct SlideRegistry {
    by_path: Mutex<HashMap<String, u32>>,
    by_id: Mutex<HashMap<u32, Entry>>,
    next: Mutex<u32>,
}

impl SlideRegistry {
    /// Open (or reuse) `path`'s image number `series` (0 for single-image files).
    pub fn open(&self, path: &str, series: u32) -> Result<SlideInfo, String> {
        let key = registry_key(path, series);
        if let Some(id) = self.by_path.lock().unwrap().get(&key).copied() {
            if let Some(e) = self.by_id.lock().unwrap().get(&id) {
                return Ok(e.info.clone());
            }
        }
        let source = open_source(path, series)?;
        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };
        let si = source.info().clone();
        let info = SlideInfo { id, path: path.to_string(), tile_size: TILE_SIZE, max_level: dz_max_level(si.width, si.height), source: si };
        self.by_id.lock().unwrap().insert(id, Entry { source, info: info.clone() });
        self.by_path.lock().unwrap().insert(key, id);
        Ok(info)
    }

    pub fn get(&self, id: u32) -> Option<Arc<dyn SlideSource>> {
        self.by_id.lock().unwrap().get(&id).map(|e| e.source.clone())
    }

    pub fn info(&self, id: u32) -> Option<SlideInfo> {
        self.by_id.lock().unwrap().get(&id).map(|e| e.info.clone())
    }

    /// Forget a slide (its tiles 404 afterwards). Returns whether it was open.
    pub fn close(&self, id: u32) -> bool {
        let removed = self.by_id.lock().unwrap().remove(&id);
        if let Some(e) = &removed {
            self.by_path.lock().unwrap().remove(&registry_key(&e.info.path, e.info.source.series_index));
        }
        removed.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a synthetic source: a gradient, so tiles have content
    struct Fake(SourceInfo);
    impl SlideSource for Fake {
        fn info(&self) -> &SourceInfo {
            &self.0
        }
        fn tile(&self, level: u32, x: u32, y: u32, _z: u32) -> Result<RgbImage, String> {
            let (_, _, _, _, tw, th) = dz_tile_rect(self.0.width, self.0.height, level, x, y)?;
            Ok(RgbImage::from_pixel(tw, th, image::Rgb([level as u8, x as u8, y as u8])))
        }
    }

    #[test]
    fn dz_geometry() {
        assert_eq!(dz_max_level(1000, 500), 10);
        assert_eq!(dz_max_level(1024, 1), 10);
        assert_eq!(dz_max_level(1025, 1), 11);
        assert_eq!(dz_level_size(1000, 500, 10), (1000, 500, 1.0));
        assert_eq!(dz_level_size(1000, 500, 9), (500, 250, 2.0));
        assert_eq!(dz_tile_rect(1000, 500, 10, 3, 1).unwrap(), (768, 256, 232, 244, 232, 244));
        assert!(dz_tile_rect(1000, 500, 10, 4, 0).is_err());
        assert!(dz_tile_rect(1000, 500, 11, 0, 0).is_err());
    }

    #[test]
    fn region_stitches_and_scales() {
        let f = Fake(SourceInfo::basic("fake", 1000, 600));
        let r = f.region(100, 100, 600, 300, 300, 150, 0).unwrap();
        assert_eq!((r.width(), r.height()), (300, 150));
        let o = f.overview(200, 0).unwrap();
        assert_eq!((o.width(), o.height()), (200, 120));
    }

    /// The JSON shape the frontend's `SlideInfo` (app/src/lib/types.ts) mirrors; the same
    /// object is the fixture in app/tests/formats.test.ts.
    #[test]
    fn slide_info_json_shape() {
        let mut si = SourceInfo::basic("plain", 1000, 600);
        si.z_planes = make_planes(&[Some(-500.0), Some(0.0)], 1).0;
        si.associated = vec!["thumbnail".into()];
        let info = SlideInfo { id: 1, path: "/a/b.png".into(), tile_size: TILE_SIZE, max_level: dz_max_level(1000, 600), source: si };
        let v = serde_json::to_value(&info).unwrap();
        let want = serde_json::json!({
            "id": 1, "path": "/a/b.png", "tileSize": 256, "maxLevel": 10,
            "format": "plain", "vendor": null, "width": 1000, "height": 600,
            "mppX": 1.0, "mppY": 1.0, "calibrated": false, "xOffsetNm": 0.0, "yOffsetNm": 0.0,
            "levels": [{ "width": 1000, "height": 600, "downsample": 1.0 }],
            "zPlanes": [{ "index": 1, "offsetNm": -500.0, "label": "−0.5 µm" }, { "index": 0, "offsetNm": 0.0, "label": "0 µm" }],
            "associated": ["thumbnail"],
            "timePoints": [], "series": [], "seriesIndex": 0, "seriesKind": "Image"
        });
        assert_eq!(v, want);
    }

    #[test]
    fn time_axis() {
        assert_eq!(split_z(0), (0, 0));
        assert_eq!(split_z(3), (3, 0));
        assert_eq!(split_z(2 * T_STRIDE + 5), (5, 2));
        assert!(make_time_points(&[Some(0.0)]).is_empty());
        let t = make_time_points(&[Some(0.0), Some(2.5), Some(75.0), None, Some(3725.0)]);
        let labels: Vec<_> = t.iter().map(|p| p.label.as_str()).collect();
        assert_eq!(labels, ["0 s", "2.5 s", "1 min 15 s", "T 4", "1 h 02 min"]);
        assert_eq!(t[3].index, 3);
        assert_eq!(time_label(899.9), "15 min 0 s");
        assert_eq!(time_label(59.97), "1 min 0 s");
        assert_eq!(time_label(3599.6), "1 h 00 min");
        assert_eq!(time_label(7199.0), "2 h 00 min");
    }

    #[test]
    fn plane_numbering() {
        let (p, pos) = make_planes(&[Some(-800.0), Some(-400.0), Some(0.0), Some(400.0)], 2);
        assert_eq!(p.iter().map(|z| z.index).collect::<Vec<_>>(), vec![1, 2, 0, 3]);
        assert_eq!(pos, vec![2, 0, 1, 3]);
        assert_eq!(p[0].label, "−0.8 µm");
        assert_eq!(p[2].label, "0 µm");
        assert_eq!(p[3].label, "+0.4 µm");
        let (p, pos) = make_planes(&[None, None, None], 1);
        assert_eq!(p[0].label, "Z 1");
        assert_eq!(p[1].index, 0);
        assert_eq!(pos, vec![1, 0, 2]);
        assert_eq!(make_planes(&[], 0).0, vec![single_plane()]);
    }

    #[test]
    fn backend_choice() {
        assert_eq!(backends_for("/a/VMS104.ndpi"), vec![Backend::OpenSlide]);
        assert_eq!(backends_for("/a/x.TIFF"), vec![Backend::OpenSlide, Backend::Plain]);
        assert_eq!(backends_for("x.png"), vec![Backend::Plain]);
        assert_eq!(backends_for("x.czi"), vec![Backend::Czi]);
        assert_eq!(backends_for("/a/Ventana-1.BIF"), vec![Backend::OpenSlide, Backend::Bif]);
        // Leica: OpenSlide (brightfield), then our reader (fluorescence)
        assert_eq!(backends_for("/a/Leica-Fluorescence-1.SCN"), vec![Backend::OpenSlide, Backend::Scn]);
        assert_eq!(backends_for("/a/X.ZVI"), vec![Backend::Zvi]);
        // Argos (Precipoint): read by the bundled OpenSlide 4.0.1
        assert_eq!(backends_for("/a/Argos-1.AVS"), vec![Backend::OpenSlide]);
        assert!(supported_extensions().contains(&".avs".to_string()));
        assert!(supported_extensions().contains(&".zvi".to_string()));
        assert_eq!(backends_for("/a/Project007.LIF"), vec![Backend::Lif]);
        assert!(supported_extensions().contains(&".lif".to_string()));
        assert_eq!(backends_for("/a/Venus Stack.OIR"), vec![Backend::Oir]);
        assert!(supported_extensions().contains(&".oir".to_string()));
        assert_eq!(backends_for("/a/X.ND2"), vec![Backend::Nd2]);
        assert!(supported_extensions().contains(&".nd2".to_string()));
        assert!(backends_for("x.ndpa").is_empty());
        assert_eq!(backends_for("/a/OS-2.VSI"), vec![Backend::Vsi]);
        assert!(supported_extensions().contains(&".vsi".to_string()));
        assert!(supported_extensions().contains(&".svs".to_string()));
    }

    #[test]
    fn rgba_and_encoders() {
        let img = RgbImage::from_pixel(2, 2, image::Rgb([1, 2, 3]));
        assert_eq!(to_rgba(&img)[..4], [1, 2, 3, 255]);
        assert!(encode_jpeg(&img, 80).unwrap().starts_with(&[0xFF, 0xD8]));
        assert!(encode_png(&img).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
    }
}
