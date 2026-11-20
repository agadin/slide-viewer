//! Plain raster images (.jpg .jpeg .png .bmp .webp, flat/stripped TIFF that OpenSlide declines).
//! Owner: formats builder.
//!
//! The image is decoded once and turned into a Deep-Zoom-aligned pyramid (`pyramid.rs`):
//! in memory up to `MEM_PIXELS`, otherwise as raw RGB levels in the app cache dir
//! (`<cache>/plain/<key>/L*.rgb`, reused on the next open while the file is unchanged).
//! TIFFs are decoded strip by strip / tile by tile, so a huge flat TIFF never has to fit in RAM.
//!
//! Calibration: TIFF X/YResolution + ResolutionUnit (also ImageJ `unit=micron` and Aperio-style
//! `MPP = …` descriptions), JPEG EXIF/JFIF density, PNG pHYs, BMP pixels-per-metre. A value only
//! counts when it is plausible for a micrograph (≤ 50 µm/px), so 72/96/300-dpi screen and print
//! defaults stay "uncalibrated" (mpp 1.0, calibrated = false).

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::Mutex;

use image::{imageops::FilterType, DynamicImage, ImageDecoder, ImageReader, RgbImage};
use tiff::decoder::{Decoder, DecodingResult, Limits};
use tiff::tags::Tag;
use tiff::ColorType;

use super::cache::{cache_dir, file_key};
use super::pyramid::{Canvas, Pyramid};
use super::{dz_max_level, dz_tile_rect, fit, LevelInfo, SlideSource, SourceInfo, TILE_SIZE};

/// Images up to this many pixels keep their pyramid in memory (≈ 200 MB of RGB at level 0).
pub const MEM_PIXELS: u64 = 64 * 1024 * 1024;
/// Hard ceiling for any plain image (the disk pyramid would be ~4 TB beyond this).
pub const MAX_PIXELS: u64 = 1 << 36;
/// Disk pyramids kept in the cache (oldest are removed).
const KEEP_DISK_PYRAMIDS: usize = 6;
/// Largest plausible µm/px for a micrograph; coarser calibrations are ignored.
pub const MAX_PLAUSIBLE_MPP: f64 = 50.0;

static DISK_BUILD: Mutex<()> = Mutex::new(());

pub struct PlainSource {
    info: SourceInfo,
    pyr: Pyramid,
}

impl PlainSource {
    pub fn open(path: &str) -> Result<PlainSource, String> {
        let lower = path.to_lowercase();
        let (pyr, mpp) = if lower.ends_with(".tif") || lower.ends_with(".tiff") {
            match open_tiff(path) {
                Ok(v) => v,
                // unusual layouts (planar, float, YCbCr without JPEG, …): let `image` try
                Err(e) => open_raster(path).map_err(|e2| format!("{path}: {e}; {e2}"))?,
            }
        } else {
            open_raster(path).map_err(|e| format!("{path}: {e}"))?
        };
        let (w, h) = pyr.levels[0].size();
        let mut info = SourceInfo::basic("plain", w as i64, h as i64);
        if let Some((mx, my)) = mpp {
            info.mpp_x = mx;
            info.mpp_y = my;
            info.calibrated = true;
        }
        info.levels = pyr
            .levels
            .iter()
            .enumerate()
            .filter(|(k, l)| *k == 0 || l.size().0.max(l.size().1) >= TILE_SIZE)
            .map(|(k, l)| LevelInfo { width: l.size().0 as i64, height: l.size().1 as i64, downsample: (1u64 << k) as f64 })
            .collect();
        info.associated = vec!["thumbnail".into()];
        Ok(PlainSource { info, pyr })
    }

    fn fitted(&self, max_px: u32) -> Result<RgbImage, String> {
        let k = self.pyr.level_at_least(max_px);
        let (w, h) = self.pyr.levels[k].size();
        let img = self.pyr.crop(k, 0, 0, w, h)?;
        let (ow, oh) = fit(self.info.width, self.info.height, max_px);
        Ok(if (ow, oh) != (w, h) { image::imageops::resize(&img, ow, oh, FilterType::Triangle) } else { img })
    }
}

impl SlideSource for PlainSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, _z: u32) -> Result<RgbImage, String> {
        let (_, _, _, _, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        let native = (dz_max_level(self.info.width, self.info.height) - level) as usize;
        self.pyr.crop(native, x * TILE_SIZE, y * TILE_SIZE, tw, th)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        match name {
            "thumbnail" => self.fitted(512),
            _ => Err(format!("no associated image named {name:?}")),
        }
    }

    fn overview(&self, max_px: u32, _z: u32) -> Result<RgbImage, String> {
        self.fitted(max_px)
    }
}

// ---------------------------------------------------------------- level-0 sinks

/// Decides memory vs disk for a w × h image and returns the level-0 canvas, plus the disk dir
/// when it is a disk pyramid. `Ok(Err(pyr))` = a finished disk pyramid from an earlier run.
fn level0_canvas(path: &str, w: u32, h: u32) -> Result<(Canvas, Option<std::path::PathBuf>), String> {
    let px = w as u64 * h as u64;
    if px > MAX_PIXELS {
        return Err(format!("image too large ({w} × {h})"));
    }
    if px <= MEM_PIXELS {
        return Ok((Canvas::mem(w, h), None));
    }
    let root = cache_dir("plain");
    prune_disk_cache(&root);
    let dir = root.join(file_key(path));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(dir.join("complete"));
    Ok((Canvas::disk(&dir.join("L0.rgb"), w, h)?, Some(dir)))
}

/// A disk pyramid finished by an earlier run (file unchanged).
fn cached_disk_pyramid(path: &str) -> Option<Pyramid> {
    let dir = cache_dir("plain").join(file_key(path));
    let meta = std::fs::read_to_string(dir.join("complete")).ok()?;
    let mut it = meta.split_whitespace().map(|s| s.parse::<u32>().ok());
    let (w, h) = (it.next()??, it.next()??);
    let l0 = Canvas::open_disk(&dir.join("L0.rgb"), w, h).ok()?;
    touch(&dir);
    Pyramid::on_disk(l0, &dir, MEM_PIXELS / 4).ok()
}

fn finish(canvas: Canvas, dir: Option<std::path::PathBuf>) -> Result<Pyramid, String> {
    match canvas {
        Canvas::Mem(img) => Pyramid::in_memory(img),
        disk => {
            let dir = dir.ok_or("missing cache dir")?;
            let (w, h) = disk.size();
            let p = Pyramid::on_disk(disk, &dir, MEM_PIXELS / 4)?;
            std::fs::write(dir.join("complete"), format!("{w} {h}")).map_err(|e| e.to_string())?;
            Ok(p)
        }
    }
}

fn touch(dir: &Path) {
    let _ = std::fs::write(dir.join("used"), b"");
}

/// Keep the most recently used disk pyramids, delete the rest.
fn prune_disk_cache(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut dirs: Vec<(std::time::SystemTime, std::path::PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let p = e.path();
            let t = std::fs::metadata(p.join("used")).or_else(|_| e.metadata()).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            (t, p)
        })
        .collect();
    if dirs.len() < KEEP_DISK_PYRAMIDS {
        return;
    }
    dirs.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in dirs.into_iter().skip(KEEP_DISK_PYRAMIDS - 1) {
        let _ = std::fs::remove_dir_all(p);
    }
}

// ---------------------------------------------------------------- generic raster (image crate)

fn open_raster(path: &str) -> Result<(Pyramid, Option<(f64, f64)>), String> {
    let mpp = read_head(path, 1 << 20).ok().and_then(|head| mpp_from_header(&head));
    let _guard = DISK_BUILD.lock().unwrap();
    if let Some(p) = cached_disk_pyramid(path) {
        return Ok((p, mpp));
    }
    let mut reader = ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    reader.no_limits();
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().ok();
    let (w, h) = decoder.dimensions();
    if w as u64 * h as u64 > MAX_PIXELS {
        return Err(format!("image too large ({w} × {h})"));
    }
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    let rgb = flatten_alpha(img);
    let (w, h) = rgb.dimensions();
    let (mut canvas, dir) = level0_canvas(path, w, h)?;
    match &mut canvas {
        Canvas::Mem(c) => *c = rgb,
        disk => {
            disk.write_rect(0, 0, w, h, rgb.as_raw())?;
            drop(rgb);
        }
    }
    Ok((finish(canvas, dir)?, mpp))
}

/// RGB over white (transparent PNG/WebP areas become white, not black).
fn flatten_alpha(img: DynamicImage) -> RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = RgbImage::new(w, h);
    for (o, p) in out.as_mut().chunks_exact_mut(3).zip(rgba.as_raw().chunks_exact(4)) {
        let a = p[3] as u32;
        for c in 0..3 {
            o[c] = ((p[c] as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
        }
    }
    out
}

fn read_head(path: &str, n: usize) -> std::io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let mut buf = Vec::with_capacity(n);
    (&mut f).take(n as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

// ---------------------------------------------------------------- TIFF (tiff crate, chunked)

fn open_tiff(path: &str) -> Result<(Pyramid, Option<(f64, f64)>), String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mut d = Decoder::new(BufReader::new(f)).map_err(|e| e.to_string())?.with_limits(Limits::unlimited());
    let (w, h) = d.dimensions().map_err(|e| e.to_string())?;
    let ct = d.colortype().map_err(|e| e.to_string())?;
    let mpp = tiff_mpp(&mut d);
    if let Ok(Some(pc)) = d.find_tag_unsigned::<u16>(Tag::PlanarConfiguration) {
        if pc == 2 {
            return Err("planar TIFF".into());
        }
    }
    let colormap = if matches!(ct, ColorType::Palette(_)) { d.get_tag_u16_vec(Tag::ColorMap).ok() } else { None };
    let white_is_zero = d.find_tag_unsigned::<u16>(Tag::PhotometricInterpretation).ok().flatten() == Some(0);

    let _guard = DISK_BUILD.lock().unwrap();
    if let Some(p) = cached_disk_pyramid(path) {
        return Ok((p, mpp));
    }
    let (mut canvas, dir) = level0_canvas(path, w, h)?;
    let (cw, ch) = d.chunk_dimensions();
    let tiled = matches!(d.get_chunk_type(), tiff::decoder::ChunkType::Tile);
    let n = if tiled { d.tile_count() } else { d.strip_count() }.map_err(|e| e.to_string())?;
    let across = if tiled { w.div_ceil(cw.max(1)) } else { 1 };
    for i in 0..n {
        let (dw, dh) = d.chunk_data_dimensions(i);
        let data = d.read_chunk(i).map_err(|e| e.to_string())?;
        let rgb = samples_to_rgb(data, ct, (dw * dh) as usize, colormap.as_deref(), white_is_zero)?;
        let (x, y) = if tiled { ((i % across) * cw, (i / across) * ch) } else { (0, i * ch) };
        canvas.write_rect(x, y, dw, dh, &rgb)?;
    }
    Ok((finish(canvas, dir)?, mpp))
}

/// Decoded TIFF samples → packed RGB8 (n pixels).
pub fn samples_to_rgb(data: DecodingResult, ct: ColorType, n: usize, colormap: Option<&[u16]>, white_is_zero: bool) -> Result<Vec<u8>, String> {
    let (samples, bits): (Vec<u16>, u8) = match data {
        DecodingResult::U8(v) => (v.into_iter().map(|s| s as u16).collect(), 8),
        DecodingResult::U16(v) => (v, 16),
        _ => return Err("unsupported TIFF sample format".into()),
    };
    let to8 = |s: u16| if bits == 16 { (s >> 8) as u8 } else { s as u8 };
    let spp = match ct {
        ColorType::Gray(_) | ColorType::Palette(_) => 1,
        ColorType::GrayA(_) => 2,
        ColorType::RGB(_) => 3,
        ColorType::RGBA(_) | ColorType::CMYK(_) => 4,
        ColorType::CMYKA(_) => 5,
        ColorType::Multiband { num_samples, .. } if num_samples >= 3 => num_samples as usize,
        _ => return Err(format!("unsupported TIFF colour type {ct:?}")),
    };
    if samples.len() < n * spp {
        return Err("short TIFF chunk".into());
    }
    let mut out = Vec::with_capacity(n * 3);
    for p in samples.chunks_exact(spp).take(n) {
        match ct {
            ColorType::Gray(_) | ColorType::GrayA(_) => {
                let g = if white_is_zero { 255 - to8(p[0]) } else { to8(p[0]) };
                out.extend_from_slice(&[g, g, g]);
            }
            ColorType::Palette(_) => {
                let cm = colormap.ok_or("palette TIFF without a colour map")?;
                let k = cm.len() / 3;
                let i = (p[0] as usize).min(k.saturating_sub(1));
                out.extend_from_slice(&[(cm[i] >> 8) as u8, (cm[k + i] >> 8) as u8, (cm[2 * k + i] >> 8) as u8]);
            }
            ColorType::RGBA(_) => {
                let a = to8(p[3]) as u32;
                for c in 0..3 {
                    out.push(((to8(p[c]) as u32 * a + 255 * (255 - a) + 127) / 255) as u8);
                }
            }
            ColorType::CMYK(_) | ColorType::CMYKA(_) => {
                let k = 255 - to8(p[3]) as u32;
                for c in 0..3 {
                    out.push(((255 - to8(p[c]) as u32) * k / 255) as u8);
                }
            }
            _ => out.extend_from_slice(&[to8(p[0]), to8(p[1]), to8(p[2])]),
        }
    }
    Ok(out)
}

fn tag_f64<R: std::io::Read + std::io::Seek>(d: &mut Decoder<R>, t: Tag) -> Option<f64> {
    match d.find_tag(t).ok()?? {
        tiff::decoder::ifd::Value::Rational(n, dd) if dd != 0 => Some(n as f64 / dd as f64),
        v => v.into_f64().ok(),
    }
}

fn tiff_mpp<R: std::io::Read + std::io::Seek>(d: &mut Decoder<R>) -> Option<(f64, f64)> {
    let desc = d.get_tag_ascii_string(Tag::ImageDescription).unwrap_or_default();
    let xr = tag_f64(d, Tag::XResolution);
    let yr = tag_f64(d, Tag::YResolution);
    let unit = d.find_tag_unsigned::<u16>(Tag::ResolutionUnit).ok().flatten();
    mpp_from_resolution(xr, yr, unit, &desc)
}

// ---------------------------------------------------------------- calibration (pure, tested)

fn plausible(m: f64) -> bool {
    m.is_finite() && m > 0.001 && m <= MAX_PLAUSIBLE_MPP
}

fn pair(mx: f64, my: f64) -> Option<(f64, f64)> {
    let (mx, my) = (if plausible(mx) { mx } else { my }, if plausible(my) { my } else { mx });
    (plausible(mx) && plausible(my)).then_some((mx, my))
}

/// µm/px from TIFF/EXIF resolution tags. `unit`: 1 none, 2 inch (default), 3 cm.
/// `desc` (ImageDescription) may carry ImageJ `unit=micron` or Aperio `MPP = 0.25`.
pub fn mpp_from_resolution(xres: Option<f64>, yres: Option<f64>, unit: Option<u16>, desc: &str) -> Option<(f64, f64)> {
    // Aperio-style descriptions state it directly
    if let Some(m) = desc_number(desc, "MPP") {
        if let Some(p) = pair(m, m) {
            return Some(p);
        }
    }
    let xr = xres.filter(|v| v.is_finite() && *v > 0.0)?;
    let yr = yres.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(xr);
    let per_unit_um = match unit.unwrap_or(2) {
        2 => 25_400.0,
        3 => 10_000.0,
        _ => {
            // ImageJ: ResolutionUnit none + "unit=micron" → pixels per µm
            let u = desc.lines().find_map(|l| l.trim().strip_prefix("unit=")).map(|s| s.trim().to_lowercase())?;
            match u.as_str() {
                "micron" | "microns" | "um" | "µm" | "\u{3bc}m" | "\\u00b5m" => 1.0,
                "mm" => 1000.0,
                "nm" => 0.001,
                "cm" => 10_000.0,
                _ => return None,
            }
        }
    };
    pair(per_unit_um / xr, per_unit_um / yr)
}

/// `KEY = 0.25` / `KEY=0.25` inside a `|`- or newline-separated description.
fn desc_number(desc: &str, key: &str) -> Option<f64> {
    desc.split(['|', '\n', '\r']).find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim().eq_ignore_ascii_case(key)).then(|| v.trim().parse::<f64>().ok()).flatten()
    })
}

/// µm/px from the first bytes of a JPEG (EXIF, then JFIF), PNG (pHYs) or BMP header.
pub fn mpp_from_header(b: &[u8]) -> Option<(f64, f64)> {
    if b.starts_with(&[0xFF, 0xD8]) {
        jpeg_mpp(b)
    } else if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        png_mpp(b)
    } else if b.starts_with(b"BM") && b.len() >= 46 {
        let xm = i32::from_le_bytes(b[38..42].try_into().ok()?);
        let ym = i32::from_le_bytes(b[42..46].try_into().ok()?);
        (xm > 0).then(|| pair(1e6 / xm as f64, 1e6 / ym.max(1) as f64)).flatten()
    } else {
        None
    }
}

fn png_mpp(b: &[u8]) -> Option<(f64, f64)> {
    let mut i = 8;
    while i + 12 <= b.len() {
        let len = u32::from_be_bytes(b[i..i + 4].try_into().ok()?) as usize;
        let ty = &b[i + 4..i + 8];
        if ty == b"pHYs" && i + 8 + 9 <= b.len() {
            let d = &b[i + 8..i + 17];
            let px = u32::from_be_bytes(d[0..4].try_into().ok()?) as f64;
            let py = u32::from_be_bytes(d[4..8].try_into().ok()?) as f64;
            return (d[8] == 1 && px > 0.0).then(|| pair(1e6 / px, 1e6 / py.max(1.0))).flatten();
        }
        if ty == b"IDAT" || ty == b"IEND" {
            return None;
        }
        i += 12 + len;
    }
    None
}

fn jpeg_mpp(b: &[u8]) -> Option<(f64, f64)> {
    let mut i = 2;
    let mut jfif = None;
    while i + 4 <= b.len() && b[i] == 0xFF {
        let m = b[i + 1];
        if m == 0xDA || m == 0xD9 {
            break;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        let seg = b.get(i + 4..i + 2 + len)?;
        if m == 0xE1 && seg.starts_with(b"Exif\0\0") {
            if let Some(tags) = parse_tiff_ifd0(&seg[6..]) {
                let r = mpp_from_resolution(
                    tags.get(&282).copied(),
                    tags.get(&283).copied(),
                    tags.get(&296).map(|v| *v as u16),
                    "",
                );
                if r.is_some() {
                    return r;
                }
            }
        } else if m == 0xE0 && seg.starts_with(b"JFIF\0") && seg.len() >= 12 {
            let unit = seg[7];
            let xd = u16::from_be_bytes([seg[8], seg[9]]) as f64;
            let yd = u16::from_be_bytes([seg[10], seg[11]]) as f64;
            jfif = match unit {
                1 => mpp_from_resolution(Some(xd), Some(yd), Some(2), ""),
                2 => mpp_from_resolution(Some(xd), Some(yd), Some(3), ""),
                _ => None,
            };
        }
        i += 2 + len;
    }
    jfif
}

/// Numeric tags of IFD0 in a TIFF/EXIF block (SHORT, LONG and RATIONAL values only).
pub fn parse_tiff_ifd0(t: &[u8]) -> Option<HashMap<u16, f64>> {
    let le = match t.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |o: usize| -> Option<u16> {
        let s: [u8; 2] = t.get(o..o + 2)?.try_into().ok()?;
        Some(if le { u16::from_le_bytes(s) } else { u16::from_be_bytes(s) })
    };
    let u32_at = |o: usize| -> Option<u32> {
        let s: [u8; 4] = t.get(o..o + 4)?.try_into().ok()?;
        Some(if le { u32::from_le_bytes(s) } else { u32::from_be_bytes(s) })
    };
    let ifd = u32_at(4)? as usize;
    let n = u16_at(ifd)? as usize;
    let mut out = HashMap::new();
    for k in 0..n {
        let e = ifd + 2 + k * 12;
        let (tag, ty, count) = (u16_at(e)?, u16_at(e + 2)?, u32_at(e + 4)?);
        if count != 1 {
            continue;
        }
        let v = match ty {
            3 => u16_at(e + 8)? as f64,
            4 => u32_at(e + 8)? as f64,
            5 => {
                let off = u32_at(e + 8)? as usize;
                let (num, den) = (u32_at(off)?, u32_at(off + 4)?);
                if den == 0 {
                    continue;
                }
                num as f64 / den as f64
            }
            _ => continue,
        };
        out.insert(tag, v);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{dz_max_level, SlideSource};

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sv-plain-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    fn pattern(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 7 % 256) as u8, (y * 3 % 256) as u8, 128]))
    }

    #[test]
    fn resolution_rules() {
        // 72 dpi and 300 dpi defaults are not calibrations
        assert_eq!(mpp_from_resolution(Some(72.0), Some(72.0), Some(2), ""), None);
        assert_eq!(mpp_from_resolution(Some(300.0), None, None, ""), None);
        // 40 000 px/cm = 0.25 µm/px
        assert_eq!(mpp_from_resolution(Some(40_000.0), Some(40_000.0), Some(3), ""), Some((0.25, 0.25)));
        // 101 600 dpi = 0.25 µm/px
        let (mx, _) = mpp_from_resolution(Some(101_600.0), Some(101_600.0), Some(2), "").unwrap();
        assert!((mx - 0.25).abs() < 1e-9);
        // ImageJ: unit none + pixels per micron
        let ij = "ImageJ=1.53\nunit=micron\n";
        assert_eq!(mpp_from_resolution(Some(2.0), Some(2.0), Some(1), ij), Some((0.5, 0.5)));
        assert_eq!(mpp_from_resolution(Some(2.0), Some(2.0), Some(1), "no unit"), None);
        // Aperio-style description wins
        assert_eq!(mpp_from_resolution(None, None, None, "Aperio Image|AppMag = 20|MPP = 0.4990"), Some((0.499, 0.499)));
    }

    #[test]
    fn header_calibration() {
        // PNG with pHYs 4 000 000 px/m = 0.25 µm/px
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&[0u8; 3], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        // insert a pHYs chunk after IHDR (8 + 25 bytes)
        let mut phys = Vec::new();
        phys.extend_from_slice(&9u32.to_be_bytes());
        phys.extend_from_slice(b"pHYs");
        phys.extend_from_slice(&4_000_000u32.to_be_bytes());
        phys.extend_from_slice(&4_000_000u32.to_be_bytes());
        phys.push(1);
        phys.extend_from_slice(&[0, 0, 0, 0]); // CRC (not checked here)
        let mut with = png[..33].to_vec();
        with.extend_from_slice(&phys);
        with.extend_from_slice(&png[33..]);
        assert_eq!(mpp_from_header(&with), Some((0.25, 0.25)));
        assert_eq!(mpp_from_header(&png), None);

        // JPEG with JFIF 72 dpi: uncalibrated
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpg).encode(&[0u8; 3], 1, 1, image::ExtendedColorType::Rgb8).unwrap();
        assert_eq!(mpp_from_header(&jpg), None);

        // JPEG with an EXIF block: 40 000 px/cm
        let mut exif = b"II*\0".to_vec();
        exif.extend_from_slice(&8u32.to_le_bytes());
        exif.extend_from_slice(&3u16.to_le_bytes());
        let data_off = 8 + 2 + 3 * 12 + 4;
        for (tag, ty, val) in [(282u16, 5u16, data_off as u32), (283, 5, data_off as u32 + 8), (296, 3, 3)] {
            exif.extend_from_slice(&tag.to_le_bytes());
            exif.extend_from_slice(&ty.to_le_bytes());
            exif.extend_from_slice(&1u32.to_le_bytes());
            exif.extend_from_slice(&val.to_le_bytes());
        }
        exif.extend_from_slice(&0u32.to_le_bytes());
        for _ in 0..2 {
            exif.extend_from_slice(&40_000u32.to_le_bytes());
            exif.extend_from_slice(&1u32.to_le_bytes());
        }
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((exif.len() + 8) as u16).to_be_bytes());
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&exif);
        let mut j2 = jpg[..2].to_vec();
        j2.extend_from_slice(&app1);
        j2.extend_from_slice(&jpg[2..]);
        assert_eq!(mpp_from_header(&j2), Some((0.25, 0.25)));
    }

    use image::ImageEncoder;

    #[test]
    fn png_tiles_match_source() {
        let img = pattern(700, 300);
        let p = tmp("a.png");
        img.save(&p).unwrap();
        let s = PlainSource::open(p.to_str().unwrap()).unwrap();
        assert_eq!((s.info.width, s.info.height), (700, 300));
        assert!(!s.info.calibrated && s.info.mpp_x == 1.0);
        let max = dz_max_level(700, 300);
        let t = s.tile(max, 1, 0, 0).unwrap();
        assert_eq!(t.dimensions(), (256, 256));
        assert_eq!(t.get_pixel(0, 0), img.get_pixel(256, 0));
        let edge = s.tile(max, 2, 1, 0).unwrap();
        assert_eq!(edge.dimensions(), (700 - 512, 300 - 256));
        assert_eq!(s.tile(0, 0, 0, 0).unwrap().dimensions(), (1, 1));
        assert!(s.tile(max, 3, 0, 0).is_err());
        let o = s.overview(100, 0).unwrap();
        assert_eq!(o.dimensions(), (100, 43));
        assert!(s.associated("thumbnail").is_ok());
        assert!(s.associated("label").is_err());
        let r = s.region(100, 50, 400, 200, 200, 100, 0).unwrap();
        assert_eq!(r.dimensions(), (200, 100));
    }

    #[test]
    fn other_raster_formats_open() {
        let img = pattern(90, 60);
        for ext in ["jpg", "bmp", "webp"] {
            let p = tmp(&format!("b.{ext}"));
            img.save(&p).unwrap();
            let s = PlainSource::open(p.to_str().unwrap()).unwrap_or_else(|e| panic!("{ext}: {e}"));
            assert_eq!((s.info.width, s.info.height), (90, 60), "{ext}");
        }
        // transparent PNG flattens over white
        let rgba = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 0, 0]));
        let p = tmp("t.png");
        rgba.save(&p).unwrap();
        let s = PlainSource::open(p.to_str().unwrap()).unwrap();
        assert_eq!(s.tile(dz_max_level(4, 4), 0, 0, 0).unwrap().get_pixel(1, 1), &image::Rgb([255, 255, 255]));
    }

    fn write_tiff(p: &Path, img: &RgbImage, res_cm: Option<u32>) {
        use tiff::encoder::{colortype, Rational, TiffEncoder};
        let f = File::create(p).unwrap();
        let mut enc = TiffEncoder::new(f).unwrap();
        let mut im = enc.new_image::<colortype::RGB8>(img.width(), img.height()).unwrap();
        im.rows_per_strip(7).unwrap();
        if let Some(r) = res_cm {
            im.resolution(tiff::tags::ResolutionUnit::Centimeter, Rational { n: r, d: 1 });
        }
        im.write_data(img.as_raw()).unwrap();
    }

    #[test]
    fn stripped_tiff_with_resolution() {
        let img = pattern(300, 200);
        let p = tmp("c.tif");
        write_tiff(&p, &img, Some(40_000));
        let s = PlainSource::open(p.to_str().unwrap()).unwrap();
        assert!(s.info.calibrated);
        assert!((s.info.mpp_x - 0.25).abs() < 1e-9);
        let max = dz_max_level(300, 200);
        let t = s.tile(max, 0, 0, 0).unwrap();
        assert_eq!(t.get_pixel(255, 199), img.get_pixel(255, 199));
        let q = tmp("d.tiff");
        write_tiff(&q, &img, None);
        assert!(!PlainSource::open(q.to_str().unwrap()).unwrap().info.calibrated);
    }

    #[test]
    fn samples_conversion() {
        let g = samples_to_rgb(DecodingResult::U16(vec![0xFF00, 0x0100]), ColorType::Gray(16), 2, None, false).unwrap();
        assert_eq!(g, vec![255, 255, 255, 1, 1, 1]);
        let wz = samples_to_rgb(DecodingResult::U8(vec![0]), ColorType::Gray(8), 1, None, true).unwrap();
        assert_eq!(wz, vec![255, 255, 255]);
        let rgba = samples_to_rgb(DecodingResult::U8(vec![0, 0, 0, 0]), ColorType::RGBA(8), 1, None, false).unwrap();
        assert_eq!(rgba, vec![255, 255, 255]);
        let cm: Vec<u16> = vec![0, 0xFFFF, 0, 0x8000, 0, 0];
        let pal = samples_to_rgb(DecodingResult::U8(vec![1]), ColorType::Palette(8), 1, Some(&cm), false).unwrap();
        assert_eq!(pal, vec![255, 128, 0]);
    }

    /// A flat TIFF above MEM_PIXELS goes through the disk pyramid and is reused on reopen.
    /// Writes ~200 MB to the temp dir: `cargo test --release -- --ignored large_tiff`.
    #[test]
    #[ignore]
    fn large_tiff_uses_disk() {
        let (w, h) = (8300u32, 8200u32);
        let img = RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x ^ y) % 256) as u8]));
        let p = tmp("big.tif");
        write_tiff(&p, &img, Some(40_000));
        drop(img);
        let path = p.to_str().unwrap();
        let t0 = std::time::Instant::now();
        let s = PlainSource::open(path).unwrap();
        let first = t0.elapsed();
        assert!(matches!(s.pyr.levels[0], Canvas::Disk { .. }));
        let max = dz_max_level(w as i64, h as i64);
        let t = s.tile(max, 20, 17, 0).unwrap();
        assert_eq!(t.get_pixel(3, 4), &image::Rgb([((20 * 256 + 3) % 251) as u8, ((17 * 256 + 4) % 241) as u8, (((20 * 256 + 3) ^ (17 * 256 + 4)) % 256) as u8]));
        drop(s);
        let t1 = std::time::Instant::now();
        let again = PlainSource::open(path).unwrap();
        let second = t1.elapsed();
        eprintln!("first open {first:?}, reopen {second:?}");
        assert!(second < first);
        assert_eq!(again.tile(max, 20, 17, 0).unwrap(), t);
        let _ = std::fs::remove_dir_all(cache_dir("plain").join(file_key(path)));
        let _ = std::fs::remove_file(&p);
    }

    /// The disk path: force it with a small image by building through `Canvas::disk` directly
    /// is covered in pyramid.rs; here, check the cache key reuse logic end to end.
    #[test]
    fn disk_cache_marker_round_trip() {
        let p = tmp("e.png");
        pattern(10, 10).save(&p).unwrap();
        let path = p.to_str().unwrap();
        assert!(cached_disk_pyramid(path).is_none());
        let dir = cache_dir("plain").join(file_key(path));
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = Canvas::disk(&dir.join("L0.rgb"), 10, 10).unwrap();
        c.write_rect(0, 0, 10, 10, pattern(10, 10).as_raw()).unwrap();
        finish(c, Some(dir.clone())).unwrap();
        let again = cached_disk_pyramid(path).expect("reused");
        assert_eq!(again.levels[0].size(), (10, 10));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
