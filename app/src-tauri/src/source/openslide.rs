//! OpenSlide backend: .ndpi .svs .tif/.tiff (tiled) .scn .mrxs .vms .vmu .bif .svslide, DICOM.
//! Owner: formats builder. Wraps the FFI in `crate::slide`.
//!
//! NDPI z-stacks: OpenSlide serves the plane at 0 µm; the other focal planes are read directly
//! from the file by `ndpi.rs`. Plane index 0 is always the nominal (0 µm) plane.
//!
//! Scanned area: some formats (Leica `.scn`, MIRAX) put level 0 in the coordinates of the whole
//! glass slide, and only part of it was scanned (`openslide.bounds-*`). Leica-1.scn is 53130 ×
//! 153470 px of which the tissue region is 36832 × 38432. Showing all of it opened the slide as a
//! speck in a mostly blank strip (and the browser thumbnail likewise), so the image is cropped to
//! the bounds (`Crop`). To keep annotation positions where they were before the crop (nm from the
//! centre of the full level 0), the crop's shift goes into `x_offset_nm`/`y_offset_nm`.

use image::{imageops::FilterType, RgbImage};

use super::ndpi::NdpiZStack;
use super::plain::MAX_PLAUSIBLE_MPP;
use super::{dz_tile_rect, make_planes, single_plane, LevelInfo, SlideSource, SourceInfo};
use crate::slide::Slide;

pub struct OpenSlideSource {
    slide: Slide,
    info: SourceInfo,
    /// extra NDPI focal planes, and for each `ZPlane::index` its position in `zstack.offsets_nm()`
    zstack: Option<(NdpiZStack, Vec<usize>)>,
    /// level-0 position of this image's (0, 0): the top-left of `openslide.bounds-*`, else (0, 0)
    origin: (i64, i64),
}

/// The part of level 0 the app shows: (x, y, w, h) in level-0 pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Crop {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

impl Crop {
    /// The scanned area from OpenSlide's `bounds-{x,y,width,height}` properties, clamped to
    /// level 0. The whole of level 0 when there are no bounds or they don't make sense.
    pub fn from_bounds(width: i64, height: i64, bounds: [Option<f64>; 4]) -> Crop {
        let full = Crop { x: 0, y: 0, w: width, h: height };
        let [Some(bx), Some(by), Some(bw), Some(bh)] = bounds else { return full };
        let (x0, y0) = ((bx.round() as i64).clamp(0, width), (by.round() as i64).clamp(0, height));
        let (x1, y1) = (((bx + bw).round() as i64).min(width), ((by + bh).round() as i64).min(height));
        if x1 - x0 < 1 || y1 - y0 < 1 {
            return full;
        }
        Crop { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    /// nm to add to the image's offsets so NDPA positions (nm from the image centre + offset)
    /// stay relative to the centre of the full level 0: (x + w/2 − width/2) · mpp · 1000.
    pub fn centre_shift_nm(&self, width: i64, height: i64, mpp_x: f64, mpp_y: f64) -> (f64, f64) {
        (
            (self.x as f64 + self.w as f64 / 2.0 - width as f64 / 2.0) * mpp_x * 1000.0,
            (self.y as f64 + self.h as f64 / 2.0 - height as f64 / 2.0) * mpp_y * 1000.0,
        )
    }
}

impl OpenSlideSource {
    pub fn open(path: &str) -> Result<OpenSlideSource, String> {
        let slide = Slide::open(path)?;
        let (full_w, full_h) = (slide.levels[0].0, slide.levels[0].1);
        let crop = Crop::from_bounds(
            full_w,
            full_h,
            ["openslide.bounds-x", "openslide.bounds-y", "openslide.bounds-width", "openslide.bounds-height"].map(|k| slide.property_f64(k)),
        );
        let (width, height) = (crop.w, crop.h);
        // generic TIFFs report their dpi as mpp: 72 dpi (352 µm/px) is not a calibration
        let mx = slide.property_f64("openslide.mpp-x").filter(|v| *v > 0.0 && *v <= MAX_PLAUSIBLE_MPP);
        let my = slide.property_f64("openslide.mpp-y").filter(|v| *v > 0.0 && *v <= MAX_PLAUSIBLE_MPP);
        let calibrated = mx.is_some() || my.is_some();
        let (mpp_x, mpp_y) = match (mx, my) {
            (Some(x), Some(y)) => (x, y),
            (Some(x), None) => (x, x),
            (None, Some(y)) => (y, y),
            (None, None) => (1.0, 1.0),
        };
        let vendor = slide.property("openslide.vendor");
        let mut zstack = None;
        let mut z_planes = vec![single_plane()];
        if vendor.as_deref() == Some("hamamatsu") && path.to_lowercase().ends_with(".ndpi") {
            // a z-stack reader failure never blocks opening the slide: it just stays one plane
            if let Ok(Some(z)) = NdpiZStack::open(path, width, height) {
                let offs = z.offsets_nm();
                if let Some(nominal) = offs.iter().position(|o| *o == 0.0) {
                    let (planes, pos) = make_planes(&offs.iter().map(|o| Some(*o)).collect::<Vec<_>>(), nominal);
                    z_planes = planes;
                    zstack = Some((z, pos));
                }
            }
        }
        let (shift_x, shift_y) = crop.centre_shift_nm(full_w, full_h, mpp_x, mpp_y);
        let cropped = (crop.w, crop.h) != (full_w, full_h);
        let info = SourceInfo {
            format: "openslide".into(),
            vendor,
            width,
            height,
            mpp_x,
            mpp_y,
            calibrated,
            x_offset_nm: slide.property_f64("hamamatsu.XOffsetFromSlideCentre").unwrap_or(0.0) + shift_x,
            y_offset_nm: slide.property_f64("hamamatsu.YOffsetFromSlideCentre").unwrap_or(0.0) + shift_y,
            levels: slide
                .levels
                .iter()
                .map(|&(w, h, d)| match cropped {
                    false => LevelInfo { width: w, height: h, downsample: d },
                    true => LevelInfo { width: (crop.w as f64 / d).ceil() as i64, height: (crop.h as f64 / d).ceil() as i64, downsample: d },
                })
                .collect(),
            z_planes,
            associated: slide.associated_names(),
        };
        Ok(OpenSlideSource { slide, info, zstack, origin: (crop.x, crop.y) })
    }

    /// level-0 rect → out_w × out_h using the best native level
    fn read_scaled(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String> {
        if z != 0 {
            if let Some((zs, pos)) = &self.zstack {
                let plane = *pos.get(z as usize).ok_or("no such focal plane")?;
                return zs.region(plane, x, y, w, h, out_w, out_h);
            }
        }
        let ds = (w as f64 / out_w as f64).min(h as f64 / out_h as f64).max(1.0);
        let best = self.slide.best_level_for_downsample(ds);
        let lds = self.slide.levels[best].2;
        let rw = (w as f64 / lds).ceil().max(1.0) as i64;
        let rh = (h as f64 / lds).ceil().max(1.0) as i64;
        let img = self.slide.read_region(x + self.origin.0, y + self.origin.1, best, rw, rh)?;
        Ok(if rw as u32 != out_w || rh as u32 != out_h {
            image::imageops::resize(&img, out_w, out_h, FilterType::Triangle)
        } else {
            img
        })
    }
}

impl SlideSource for OpenSlideSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (fx, fy, fw, fh, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        self.read_scaled(fx, fy, fw, fh, tw, th, z)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        self.slide.read_associated(name)
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String> {
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        self.read_scaled(x, y, w, h, out_w, out_h, z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Leica-1.scn: level 0 is the whole glass (53130 × 153470) and the scan is one region.
    #[test]
    fn crops_to_scanned_bounds() {
        let b = [Some(10778.0), Some(35096.0), Some(36832.0), Some(38432.0)];
        assert_eq!(Crop::from_bounds(53130, 153470, b), Crop { x: 10778, y: 35096, w: 36832, h: 38432 });
        // no bounds, partial bounds, or nonsense: the whole image
        let full = Crop { x: 0, y: 0, w: 1000, h: 500 };
        assert_eq!(Crop::from_bounds(1000, 500, [None; 4]), full);
        assert_eq!(Crop::from_bounds(1000, 500, [Some(1.0), Some(2.0), None, Some(3.0)]), full);
        assert_eq!(Crop::from_bounds(1000, 500, [Some(2000.0), Some(0.0), Some(10.0), Some(10.0)]), full);
        assert_eq!(Crop::from_bounds(1000, 500, [Some(10.0), Some(20.0), Some(0.0), Some(10.0)]), full);
        // bounds running past level 0 are clamped
        assert_eq!(Crop::from_bounds(1000, 500, [Some(900.0), Some(-5.0), Some(500.0), Some(100.0)]), Crop { x: 900, y: 0, w: 100, h: 95 });
    }

    /// A point keeps its NDPA position (nm from the full level 0's centre) after the crop.
    #[test]
    fn crop_keeps_annotation_positions() {
        let (w, h, mpp) = (53130i64, 153470i64, 0.5);
        let c = Crop::from_bounds(w, h, [Some(10778.0), Some(35096.0), Some(36832.0), Some(38432.0)]);
        let (sx, sy) = c.centre_shift_nm(w, h, mpp, mpp);
        // coords.ts imageToNm on the cropped image, and the same pixel on the full level 0
        let (px, py) = (1234.0, 5678.0);
        let cropped = ((px - c.w as f64 / 2.0) * mpp * 1000.0 + sx, (py - c.h as f64 / 2.0) * mpp * 1000.0 + sy);
        let full = ((px + c.x as f64 - w as f64 / 2.0) * mpp * 1000.0, (py + c.y as f64 - h as f64 / 2.0) * mpp * 1000.0);
        assert!((cropped.0 - full.0).abs() < 1e-6 && (cropped.1 - full.1).abs() < 1e-6, "{cropped:?} {full:?}");
        assert_eq!(Crop::from_bounds(w, h, [None; 4]).centre_shift_nm(w, h, mpp, mpp), (0.0, 0.0));
    }

    /// Renders tiles from a real slide when one is present (`cargo test -- --ignored`).
    /// Uses MSG's images folder read-only.
    #[test]
    #[ignore]
    fn renders_real_slide_tile() {
        let p = "/Users/alexandergadin/vscode/micro-speed-grader/images/VMS104.ndpi";
        assert!(Path::new(p).exists(), "needs {p}");
        let s = OpenSlideSource::open(p).expect("open");
        let max = super::super::dz_max_level(s.info.width, s.info.height);
        let full = s.tile(max, 10, 10, 0).unwrap();
        assert_eq!((full.width(), full.height()), (256, 256));
        assert!(s.info.calibrated && s.info.vendor.as_deref() == Some("hamamatsu"));
        assert_eq!(s.info.z_planes.len(), 1);
        assert!(s.info.associated.iter().any(|a| a == "macro"));
        let o = s.overview(512, 0).unwrap();
        assert!(o.width() <= 512 && o.height() <= 512);
    }

    /// VMS469 is a 9-plane NDPI z-stack: all planes are listed and every plane serves tiles.
    #[test]
    #[ignore]
    fn real_ndpi_focal_planes() {
        let p = "/Users/alexandergadin/vscode/micro-speed-grader/images/VMS469.ndpi";
        if !Path::new(p).exists() {
            eprintln!("skipping: {p} not present");
            return;
        }
        let s = OpenSlideSource::open(p).expect("open");
        let zp = &s.info.z_planes;
        assert_eq!(zp.len(), 9, "{zp:?}");
        assert_eq!(zp[4].index, 0);
        assert_eq!(zp[4].offset_nm, Some(0.0));
        assert_eq!(zp[0].label, "−0.8 µm");
        let max = super::super::dz_max_level(s.info.width, s.info.height);
        let (cx, cy) = ((s.info.width / 2 / 256) as u32, (s.info.height / 2 / 256) as u32);
        let t0 = s.tile(max, cx, cy, 0).unwrap();
        for z in 1..9 {
            let t = s.tile(max, cx, cy, z).unwrap();
            assert_eq!(t.dimensions(), t0.dimensions());
        }
        assert!(s.tile(max, cx, cy, 9).is_err());
        let low = s.tile(max - 6, 0, 0, 3).unwrap();
        assert!(low.width() > 0);
    }
}
