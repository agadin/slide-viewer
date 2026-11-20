//! Zeiss .czi via libCZI (FFI; fetched/vendored like OpenSlide, pinned + checksummed).
//! Owner: formats builder (also owns build.rs, tools/fetch-libczi.sh and Cargo.toml deps).
//! TODO(formats): open with libCZI, expose scenes/pyramid, focal planes as `ZPlane`s, and
//! serve Deep-Zoom tiles. Until then: "unsupported".

use image::RgbImage;

use super::{unsupported, SlideSource, SourceInfo};

#[allow(dead_code)] // constructed once the backend is implemented
pub struct CziSource {
    info: SourceInfo,
}

impl CziSource {
    pub fn open(path: &str) -> Result<CziSource, String> {
        Err(format!("{path}: {}", unsupported("CZI backend")))
    }
}

impl SlideSource for CziSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, _level: u32, _x: u32, _y: u32, _z: u32) -> Result<RgbImage, String> {
        Err(unsupported("CZI tiles"))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn stub_reports_unsupported() {
        let e = super::CziSource::open("x.czi").err().unwrap();
        assert!(e.contains("unsupported"));
    }
}
