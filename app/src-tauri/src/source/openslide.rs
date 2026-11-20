//! OpenSlide backend: .ndpi .svs .tif/.tiff (tiled) .scn .mrxs .vms .vmu .bif .svslide, DICOM.
//! Owner: formats builder. Wraps the FFI in `crate::slide`.

use image::{imageops::FilterType, RgbImage};

use super::{dz_tile_rect, single_plane, LevelInfo, SlideSource, SourceInfo};
use crate::slide::Slide;

pub struct OpenSlideSource {
    slide: Slide,
    info: SourceInfo,
}

impl OpenSlideSource {
    pub fn open(path: &str) -> Result<OpenSlideSource, String> {
        let slide = Slide::open(path)?;
        let (width, height) = (slide.levels[0].0, slide.levels[0].1);
        let mx = slide.property_f64("openslide.mpp-x").filter(|v| *v > 0.0);
        let my = slide.property_f64("openslide.mpp-y").filter(|v| *v > 0.0);
        let calibrated = mx.is_some() || my.is_some();
        let (mpp_x, mpp_y) = match (mx, my) {
            (Some(x), Some(y)) => (x, y),
            (Some(x), None) => (x, x),
            (None, Some(y)) => (y, y),
            (None, None) => (1.0, 1.0),
        };
        let info = SourceInfo {
            format: "openslide".into(),
            vendor: slide.property("openslide.vendor"),
            width,
            height,
            mpp_x,
            mpp_y,
            calibrated,
            x_offset_nm: slide.property_f64("hamamatsu.XOffsetFromSlideCentre").unwrap_or(0.0),
            y_offset_nm: slide.property_f64("hamamatsu.YOffsetFromSlideCentre").unwrap_or(0.0),
            levels: slide.levels.iter().map(|&(w, h, d)| LevelInfo { width: w, height: h, downsample: d }).collect(),
            // OpenSlide exposes one focal plane; extra NDPI planes are a formats-builder follow-up
            z_planes: vec![single_plane()],
            associated: slide.associated_names(),
        };
        Ok(OpenSlideSource { slide, info })
    }

    /// level-0 rect → out_w × out_h using the best native level
    fn read_scaled(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32) -> Result<RgbImage, String> {
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

    fn tile(&self, level: u32, x: u32, y: u32, _z: u32) -> Result<RgbImage, String> {
        let (fx, fy, fw, fh, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        self.read_scaled(fx, fy, fw, fh, tw, th)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        self.slide.read_associated(name)
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, _z: u32) -> Result<RgbImage, String> {
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        self.read_scaled(x, y, w, h, out_w, out_h)
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
        let o = s.overview(512, 0).unwrap();
        assert!(o.width() <= 512 && o.height() <= 512);
    }
}
