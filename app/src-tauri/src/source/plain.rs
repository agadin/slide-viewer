//! Plain raster images (.jpg .jpeg .png .bmp .webp, flat TIFF).
//! Owner: formats builder.
//! TODO(formats): decode with the `image`/`tiff` crates, build a downsampled pyramid in memory
//! (or an on-disk cache for huge flat TIFFs) and serve Deep-Zoom tiles. Until then: "unsupported".

use image::RgbImage;

use super::{unsupported, SlideSource, SourceInfo};

#[allow(dead_code)] // constructed once the backend is implemented
pub struct PlainSource {
    info: SourceInfo,
}

impl PlainSource {
    pub fn open(path: &str) -> Result<PlainSource, String> {
        Err(format!("{path}: {}", unsupported("plain image backend")))
    }
}

impl SlideSource for PlainSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, _level: u32, _x: u32, _y: u32, _z: u32) -> Result<RgbImage, String> {
        Err(unsupported("plain image tiles"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stub_reports_unsupported() {
        let e = super::PlainSource::open("x.png").err().unwrap();
        assert!(e.contains("unsupported"));
    }
}
