//! OpenSlide backend: .ndpi .svs .tif/.tiff (tiled) .scn .mrxs .vms .vmu .bif .svslide, DICOM.
//! Owner: formats builder. Wraps the FFI in `crate::slide`.
//!
//! NDPI z-stacks: OpenSlide serves the plane at 0 µm; the other focal planes are read directly
//! from the file by `ndpi.rs`. Plane index 0 is always the nominal (0 µm) plane.

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
}

impl OpenSlideSource {
    pub fn open(path: &str) -> Result<OpenSlideSource, String> {
        let slide = Slide::open(path)?;
        let (width, height) = (slide.levels[0].0, slide.levels[0].1);
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
        let info = SourceInfo {
            format: "openslide".into(),
            vendor,
            width,
            height,
            mpp_x,
            mpp_y,
            calibrated,
            x_offset_nm: slide.property_f64("hamamatsu.XOffsetFromSlideCentre").unwrap_or(0.0),
            y_offset_nm: slide.property_f64("hamamatsu.YOffsetFromSlideCentre").unwrap_or(0.0),
            levels: slide.levels.iter().map(|&(w, h, d)| LevelInfo { width: w, height: h, downsample: d }).collect(),
            z_planes,
            associated: slide.associated_names(),
        };
        Ok(OpenSlideSource { slide, info, zstack })
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
        let img = self.slide.read_region(x, y, best, rw, rh)?;
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
