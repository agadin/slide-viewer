//! A Deep-Zoom-aligned image pyramid for non-pyramidal images (plain backend).
//!
//! Level k is level k-1 halved (ceil), down to 1×1, so native level k is exactly Deep-Zoom
//! level `max - k` and a tile is a plain crop. Levels live in memory, or as raw RGB files on
//! disk for images too large to hold (see `plain.rs`).
//! Owner: formats builder.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use image::RgbImage;

/// Where a level's pixels live.
pub enum Canvas {
    Mem(RgbImage),
    /// raw, row-major RGB8 (`w * h * 3` bytes)
    Disk { file: File, w: u32, h: u32 },
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

fn write_at(f: &File, buf: &[u8], off: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        f.write_all_at(buf, off)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = f.seek_write(&buf[done..], off + done as u64)?;
            done += n;
        }
        Ok(())
    }
}

impl Canvas {
    pub fn mem(w: u32, h: u32) -> Canvas {
        Canvas::Mem(RgbImage::from_pixel(w.max(1), h.max(1), image::Rgb([255, 255, 255])))
    }

    /// A new raw file of w × h (sparse until written).
    pub fn disk(path: &Path, w: u32, h: u32) -> Result<Canvas, String> {
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        file.set_len(w as u64 * h as u64 * 3).map_err(|e| e.to_string())?;
        Ok(Canvas::Disk { file, w, h })
    }

    /// Re-open a finished raw level.
    pub fn open_disk(path: &Path, w: u32, h: u32) -> Result<Canvas, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        if len != w as u64 * h as u64 * 3 {
            return Err(format!("{}: wrong size", path.display()));
        }
        Ok(Canvas::Disk { file, w, h })
    }

    pub fn size(&self) -> (u32, u32) {
        match self {
            Canvas::Mem(i) => i.dimensions(),
            Canvas::Disk { w, h, .. } => (*w, *h),
        }
    }

    /// Write `rgb` (rw × rh, tightly packed) with its top-left at (x, y); clipped to the canvas.
    pub fn write_rect(&mut self, x: u32, y: u32, rw: u32, rh: u32, rgb: &[u8]) -> Result<(), String> {
        let (w, h) = self.size();
        if x >= w || y >= h {
            return Ok(());
        }
        let cw = rw.min(w - x) as usize;
        let ch = rh.min(h - y);
        for r in 0..ch {
            let src = &rgb[(r * rw) as usize * 3..][..cw * 3];
            match self {
                Canvas::Mem(img) => {
                    let off = (((y + r) * w + x) * 3) as usize;
                    img.as_mut()[off..off + cw * 3].copy_from_slice(src);
                }
                Canvas::Disk { file, .. } => {
                    let off = ((y + r) as u64 * w as u64 + x as u64) * 3;
                    write_at(file, src, off).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    /// Read one full row into `buf` (w * 3 bytes).
    pub fn read_row(&self, y: u32, buf: &mut [u8]) -> Result<(), String> {
        let (w, _) = self.size();
        match self {
            Canvas::Mem(img) => {
                let off = (y * w * 3) as usize;
                buf.copy_from_slice(&img.as_raw()[off..off + (w * 3) as usize]);
                Ok(())
            }
            Canvas::Disk { file, .. } => read_at(file, buf, y as u64 * w as u64 * 3).map_err(|e| e.to_string()),
        }
    }

    /// Crop (x, y, cw, ch); the rectangle must lie inside the canvas.
    pub fn crop(&self, x: u32, y: u32, cw: u32, ch: u32) -> Result<RgbImage, String> {
        let (w, h) = self.size();
        if x + cw > w || y + ch > h || cw == 0 || ch == 0 {
            return Err("crop outside the image".into());
        }
        match self {
            Canvas::Mem(img) => Ok(image::imageops::crop_imm(img, x, y, cw, ch).to_image()),
            Canvas::Disk { file, .. } => {
                let mut out = vec![0u8; (cw * ch * 3) as usize];
                for r in 0..ch {
                    let off = ((y + r) as u64 * w as u64 + x as u64) * 3;
                    read_at(file, &mut out[(r * cw * 3) as usize..][..(cw * 3) as usize], off).map_err(|e| e.to_string())?;
                }
                RgbImage::from_raw(cw, ch, out).ok_or_else(|| "bad crop".into())
            }
        }
    }
}

/// Halve one pair of rows (2×2 box filter; the last odd row/column is averaged with itself).
pub fn halve_rows(r0: &[u8], r1: &[u8], w: u32, out: &mut [u8]) {
    let ow = w.div_ceil(2);
    for ox in 0..ow {
        let x0 = (ox * 2) as usize;
        let x1 = ((ox * 2 + 1).min(w - 1)) as usize;
        for c in 0..3 {
            let s = r0[x0 * 3 + c] as u32 + r0[x1 * 3 + c] as u32 + r1[x0 * 3 + c] as u32 + r1[x1 * 3 + c] as u32;
            out[ox as usize * 3 + c] = ((s + 2) / 4) as u8;
        }
    }
}

/// Build the next level from `src`. `disk` gives a path for a disk level, None for memory.
pub fn halve(src: &Canvas, disk: Option<&Path>) -> Result<Canvas, String> {
    let (w, h) = src.size();
    let (ow, oh) = (w.div_ceil(2), h.div_ceil(2));
    let mut a = vec![0u8; (w * 3) as usize];
    let mut b = vec![0u8; (w * 3) as usize];
    let mut row = vec![0u8; (ow * 3) as usize];
    match disk {
        None => {
            let mut out = RgbImage::new(ow, oh);
            for oy in 0..oh {
                src.read_row(oy * 2, &mut a)?;
                src.read_row((oy * 2 + 1).min(h - 1), &mut b)?;
                halve_rows(&a, &b, w, &mut row);
                let off = (oy * ow * 3) as usize;
                out.as_mut()[off..off + row.len()].copy_from_slice(&row);
            }
            Ok(Canvas::Mem(out))
        }
        Some(p) => {
            {
                let f = File::create(p).map_err(|e| format!("{}: {e}", p.display()))?;
                let mut wr = BufWriter::with_capacity(4 << 20, f);
                for oy in 0..oh {
                    src.read_row(oy * 2, &mut a)?;
                    src.read_row((oy * 2 + 1).min(h - 1), &mut b)?;
                    halve_rows(&a, &b, w, &mut row);
                    wr.write_all(&row).map_err(|e| e.to_string())?;
                }
                wr.flush().map_err(|e| e.to_string())?;
            }
            Canvas::open_disk(p, ow, oh)
        }
    }
}

/// Every level from full resolution down to 1×1.
pub struct Pyramid {
    pub levels: Vec<Canvas>,
}

/// Level sizes of a pyramid built from w × h (level 0 first, down to 1×1).
pub fn level_sizes(w: u32, h: u32) -> Vec<(u32, u32)> {
    let mut v = vec![(w.max(1), h.max(1))];
    while let Some(&(lw, lh)) = v.last() {
        if lw == 1 && lh == 1 {
            break;
        }
        v.push((lw.div_ceil(2), lh.div_ceil(2)));
    }
    v
}

impl Pyramid {
    /// Build all lower levels in memory from a level-0 image.
    pub fn in_memory(level0: RgbImage) -> Result<Pyramid, String> {
        let mut levels = vec![Canvas::Mem(level0)];
        loop {
            let (w, h) = levels.last().unwrap().size();
            if w == 1 && h == 1 {
                break;
            }
            let next = halve(levels.last().unwrap(), None)?;
            levels.push(next);
        }
        Ok(Pyramid { levels })
    }

    /// Build the lower levels next to a finished disk level 0 (`dir/L0.rgb`). Levels smaller
    /// than `mem_below` pixels are kept in memory.
    pub fn on_disk(level0: Canvas, dir: &Path, mem_below: u64) -> Result<Pyramid, String> {
        let mut levels = vec![level0];
        let mut k = 1;
        loop {
            let (w, h) = levels.last().unwrap().size();
            if w == 1 && h == 1 {
                break;
            }
            let (ow, oh) = (w.div_ceil(2), h.div_ceil(2));
            let path: PathBuf = dir.join(format!("L{k}.rgb"));
            let next = if (ow as u64 * oh as u64) < mem_below {
                halve(levels.last().unwrap(), None)?
            } else if let Ok(c) = Canvas::open_disk(&path, ow, oh) {
                c // finished by an earlier run
            } else {
                halve(levels.last().unwrap(), Some(&path))?
            };
            levels.push(next);
            k += 1;
        }
        Ok(Pyramid { levels })
    }

    /// A Deep-Zoom tile: native level `max - level`, crop (x0, y0, w, h) in that level's pixels.
    pub fn crop(&self, native: usize, x: u32, y: u32, w: u32, h: u32) -> Result<RgbImage, String> {
        let c = self.levels.get(native).ok_or("bad level")?;
        c.crop(x, y, w, h)
    }

    /// The smallest level whose long side is at least `px` (or level 0).
    pub fn level_at_least(&self, px: u32) -> usize {
        let mut best = 0;
        for (i, l) in self.levels.iter().enumerate() {
            let (w, h) = l.size();
            if w.max(h) >= px {
                best = i;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_follow_deep_zoom() {
        let s = level_sizes(1000, 600);
        assert_eq!(s[0], (1000, 600));
        assert_eq!(s[1], (500, 300));
        assert_eq!(s[3], (125, 75));
        assert_eq!(s[4], (63, 38));
        assert_eq!(*s.last().unwrap(), (1, 1));
        // native level k == Deep-Zoom level max-k
        let max = crate::source::dz_max_level(1000, 600);
        assert_eq!(s.len() as u32, max + 1);
        for (k, &(w, h)) in s.iter().enumerate() {
            let (dw, dh, _) = crate::source::dz_level_size(1000, 600, max - k as u32);
            assert_eq!((w, h), (dw, dh), "level {k}");
        }
    }

    #[test]
    fn halving_averages() {
        let r0 = [0u8, 0, 0, 100, 100, 100, 50, 50, 50];
        let r1 = [200u8, 200, 200, 100, 100, 100, 50, 50, 50];
        let mut out = [0u8; 6];
        halve_rows(&r0, &r1, 3, &mut out);
        assert_eq!(out, [100, 100, 100, 50, 50, 50]);
    }

    #[test]
    fn disk_and_memory_agree() {
        let dir = std::env::temp_dir().join(format!("sv-pyr-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = RgbImage::from_fn(301, 177, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]));
        let mem = Pyramid::in_memory(img.clone()).unwrap();
        let mut c0 = Canvas::disk(&dir.join("L0.rgb"), 301, 177).unwrap();
        // write in two out-of-order halves like TIFF tiles would
        let bottom = image::imageops::crop_imm(&img, 0, 100, 301, 77).to_image();
        let top = image::imageops::crop_imm(&img, 0, 0, 301, 100).to_image();
        c0.write_rect(0, 100, 301, 77, bottom.as_raw()).unwrap();
        c0.write_rect(0, 0, 301, 100, top.as_raw()).unwrap();
        let disk = Pyramid::on_disk(c0, &dir, 1000).unwrap();
        assert_eq!(mem.levels.len(), disk.levels.len());
        for k in 0..mem.levels.len() {
            let (w, h) = mem.levels[k].size();
            assert_eq!(disk.levels[k].size(), (w, h));
            assert_eq!(mem.crop(k, 0, 0, w, h).unwrap(), disk.crop(k, 0, 0, w, h).unwrap(), "level {k}");
        }
        assert_eq!(mem.level_at_least(100), 1); // 151×89 is the smallest with a side ≥ 100
        let _ = std::fs::remove_dir_all(&dir);
    }
}
