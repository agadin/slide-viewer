//! Hamamatsu NDPI focal planes (z-stacks), read directly from the TIFF directories.
//!
//! OpenSlide only exposes the plane at z offset 0. An NDPI z-stack stores every plane as its own
//! set of IFDs (tag 65424 = focal-plane offset in nm, 65421 = source lens). Each full-size level
//! is ONE baseline JPEG with restart markers; tag 65426 lists where every restart interval starts
//! (relative to the strip). An interval is `DRI` MCUs of one MCU row, and the rows divide into a
//! whole number of intervals, so a column of intervals stacked vertically is a valid JPEG of its
//! own: we copy the header, patch the SOF size, concatenate the intervals with renumbered RST
//! markers and decode that "block". Blocks are LRU-cached. Small levels without 65426 are
//! decoded whole.
//!
//! Limits: classic TIFF offsets only (files < 4 GiB); bigger files fall back to one plane.
//! Owner: formats builder.

use std::fs::File;
use std::sync::{Arc, Mutex};

use image::{imageops::FilterType, RgbImage};

use super::cache::Lru;

const TAG_WIDTH: u16 = 256;
const TAG_HEIGHT: u16 = 257;
const TAG_STRIP_OFFSETS: u16 = 273;
const TAG_STRIP_BYTES: u16 = 279;
const TAG_SOURCE_LENS: u16 = 65421;
const TAG_Z_OFFSET: u16 = 65424;
const TAG_MCU_STARTS: u16 = 65426;
const TAG_MCU_STARTS_HIGH: u16 = 65432;

/// MCU rows per decoded block (×8 or ×16 px).
const BLOCK_MCU_ROWS: u32 = 32;
const BLOCK_CACHE_BYTES: usize = 160 * 1024 * 1024;
/// Largest level decoded whole (levels without restart offsets).
const MAX_WHOLE_PIXELS: u64 = 64 * 1024 * 1024;

fn read_at(f: &File, buf: &mut [u8], off: u64) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        f.read_exact_at(buf, off).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = f.seek_read(&mut buf[done..], off + done as u64).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("unexpected end of file".into());
            }
            done += n;
        }
        Ok(())
    }
}

fn read_vec(f: &File, off: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut v = vec![0u8; len];
    read_at(f, &mut v, off)?;
    Ok(v)
}

// ---------------------------------------------------------------- TIFF directory parsing

/// One IFD entry: type, count, and the 4-byte value/offset field.
#[derive(Clone, Copy, Debug)]
struct Entry {
    ty: u16,
    count: u32,
    value: u32,
}

#[derive(Debug, Default)]
struct Ifd {
    entries: Vec<(u16, Entry)>,
}

impl Ifd {
    fn get(&self, tag: u16) -> Option<Entry> {
        self.entries.iter().find(|(t, _)| *t == tag).map(|(_, e)| *e)
    }
    fn u32(&self, tag: u16) -> Option<u32> {
        let e = self.get(tag)?;
        (e.count == 1).then_some(match e.ty {
            3 => e.value & 0xffff,
            _ => e.value,
        })
    }
    fn i32(&self, tag: u16) -> Option<i32> {
        self.get(tag).filter(|e| e.count == 1).map(|e| e.value as i32)
    }
    fn f32(&self, tag: u16) -> Option<f32> {
        self.get(tag).filter(|e| e.count == 1 && e.ty == 11).map(|e| f32::from_bits(e.value))
    }
}

fn parse_ifds(f: &File, file_len: u64) -> Result<Vec<Ifd>, String> {
    let head = read_vec(f, 0, 8)?;
    if &head[0..4] != b"II*\0" {
        return Err("not a little-endian classic TIFF".into());
    }
    let mut off = u32::from_le_bytes(head[4..8].try_into().unwrap()) as u64;
    let mut out = Vec::new();
    while off != 0 && off + 2 <= file_len && out.len() < 256 {
        let n = u16::from_le_bytes(read_vec(f, off, 2)?.try_into().unwrap()) as usize;
        let body = read_vec(f, off + 2, n * 12 + 4)?;
        let mut ifd = Ifd::default();
        for k in 0..n {
            let e = &body[k * 12..k * 12 + 12];
            let tag = u16::from_le_bytes([e[0], e[1]]);
            let ty = u16::from_le_bytes([e[2], e[3]]);
            let count = u32::from_le_bytes(e[4..8].try_into().unwrap());
            let value = u32::from_le_bytes(e[8..12].try_into().unwrap());
            ifd.entries.push((tag, Entry { ty, count, value }));
        }
        off = u32::from_le_bytes(body[n * 12..n * 12 + 4].try_into().unwrap()) as u64;
        out.push(ifd);
    }
    Ok(out)
}

fn read_u32_array(f: &File, e: Entry) -> Result<Vec<u32>, String> {
    if e.ty != 4 && e.ty != 13 {
        return Err("unexpected tag type".into());
    }
    if e.count == 1 {
        return Ok(vec![e.value]);
    }
    let raw = read_vec(f, e.value as u64, e.count as usize * 4)?;
    Ok(raw.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect())
}

// ---------------------------------------------------------------- JPEG header

/// The header of a level's JPEG (SOI … end of SOS) and what we need to cut it into blocks.
#[derive(Clone, Debug)]
pub struct JpegHeader {
    pub bytes: Vec<u8>,
    /// offset of the SOF height field (width follows)
    pub sof_size_pos: usize,
    pub mcu_w: u32,
    pub mcu_h: u32,
    /// restart interval in MCUs (0 = none)
    pub restart: u32,
}

/// Parse a baseline JPEG header up to (and including) the SOS segment.
pub fn parse_jpeg_header(b: &[u8]) -> Result<JpegHeader, String> {
    if !b.starts_with(&[0xFF, 0xD8]) {
        return Err("no JPEG SOI".into());
    }
    let mut i = 2;
    let (mut sof, mut mcu, mut restart) = (None, None, 0u32);
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return Err("bad JPEG marker".into());
        }
        let m = b[i + 1];
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if i + 2 + len > b.len() {
            return Err("truncated JPEG header".into());
        }
        let seg = &b[i + 4..i + 2 + len];
        match m {
            0xC0 | 0xC1 => {
                // P, Y, X, Nf, then (id, HV, Tq) × Nf
                let nf = seg[5] as usize;
                let (mut hmax, mut vmax) = (1u32, 1u32);
                for c in 0..nf {
                    let hv = seg[6 + c * 3 + 1];
                    hmax = hmax.max((hv >> 4) as u32);
                    vmax = vmax.max((hv & 15) as u32);
                }
                sof = Some(i + 5);
                mcu = Some((8 * hmax, 8 * vmax));
            }
            0xC2 | 0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return Err("not a baseline JPEG".into()),
            0xDD => restart = u16::from_be_bytes([seg[0], seg[1]]) as u32,
            0xDA => {
                let (sof_size_pos, (mcu_w, mcu_h)) = (sof.ok_or("JPEG without SOF")?, mcu.unwrap());
                return Ok(JpegHeader { bytes: b[..i + 2 + len].to_vec(), sof_size_pos, mcu_w, mcu_h, restart });
            }
            _ => {}
        }
        i += 2 + len;
    }
    Err("JPEG header without SOS".into())
}

/// Assemble a JPEG of `w` × `h` from a header and restart intervals (each without its trailing
/// RST marker). Intervals are joined with RST0…RST7 in sequence.
pub fn assemble_jpeg(h: &JpegHeader, w: u32, ht: u32, intervals: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(h.bytes.len() + intervals.iter().map(|v| v.len() + 2).sum::<usize>() + 2);
    out.extend_from_slice(&h.bytes);
    out[h.sof_size_pos..h.sof_size_pos + 2].copy_from_slice(&(ht as u16).to_be_bytes());
    out[h.sof_size_pos + 2..h.sof_size_pos + 4].copy_from_slice(&(w as u16).to_be_bytes());
    for (k, iv) in intervals.iter().enumerate() {
        if k > 0 {
            out.extend_from_slice(&[0xFF, 0xD0 + ((k - 1) % 8) as u8]);
        }
        out.extend_from_slice(iv);
    }
    out.extend_from_slice(&[0xFF, 0xD9]);
    out
}

/// Drop a trailing RSTn / EOI marker from an interval's bytes.
fn strip_marker(mut v: Vec<u8>) -> Vec<u8> {
    let n = v.len();
    if n >= 2 && v[n - 2] == 0xFF && ((0xD0..=0xD7).contains(&v[n - 1]) || v[n - 1] == 0xD9) {
        v.truncate(n - 2);
    }
    v
}

fn decode_jpeg(bytes: &[u8]) -> Result<RgbImage, String> {
    image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).map(|i| i.to_rgb8()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- planes and levels

#[derive(Debug)]
struct Restart {
    header: JpegHeader,
    starts: Vec<u32>,
    /// interval width in px, intervals per MCU row, MCU rows
    iw: u32,
    cols: u32,
    rows: u32,
}

#[derive(Debug)]
struct Level {
    width: u32,
    height: u32,
    strip_off: u64,
    strip_len: u64,
    restart: Option<Restart>,
}

#[derive(Debug)]
struct Plane {
    z_nm: f64,
    /// full resolution first
    levels: Vec<Level>,
}

/// The focal planes of an NDPI file (only built when there are at least two).
pub struct NdpiZStack {
    file: File,
    width: u32,
    height: u32,
    planes: Vec<Plane>,
    blocks: Mutex<Lru<(usize, usize, u32, u32), Arc<RgbImage>>>,
}

impl NdpiZStack {
    /// Read the plane layout. `Ok(None)` when the file has a single plane (or a layout this
    /// reader doesn't handle), so the caller keeps OpenSlide's single plane.
    pub fn open(path: &str, expect_w: i64, expect_h: i64) -> Result<Option<NdpiZStack>, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        if len > u32::MAX as u64 {
            return Ok(None); // NDPI's 64-bit offset extension is not handled here
        }
        let ifds = parse_ifds(&file, len)?;
        let mut planes: Vec<Plane> = Vec::new();
        for ifd in &ifds {
            let Some(lens) = ifd.f32(TAG_SOURCE_LENS) else { continue };
            if lens <= 0.0 || ifd.get(TAG_MCU_STARTS_HIGH).is_some() {
                continue; // macro (-1) / map (-2), or >4 GiB offsets
            }
            let z = ifd.i32(TAG_Z_OFFSET).unwrap_or(0) as f64;
            let (Some(w), Some(h), Some(so), Some(sb)) =
                (ifd.u32(TAG_WIDTH), ifd.u32(TAG_HEIGHT), ifd.u32(TAG_STRIP_OFFSETS), ifd.u32(TAG_STRIP_BYTES))
            else {
                continue;
            };
            let restart = match ifd.get(TAG_MCU_STARTS) {
                Some(e) => {
                    let starts = read_u32_array(&file, e)?;
                    let head_len = (*starts.first().unwrap_or(&0) as usize).min(sb as usize).min(1 << 20);
                    let header = parse_jpeg_header(&read_vec(&file, so as u64, head_len)?)?;
                    let mcus_per_row = w.div_ceil(header.mcu_w);
                    let rows = h.div_ceil(header.mcu_h);
                    if header.restart == 0 || mcus_per_row % header.restart != 0 {
                        return Ok(None);
                    }
                    let cols = mcus_per_row / header.restart;
                    if cols as u64 * rows as u64 != starts.len() as u64 {
                        return Ok(None);
                    }
                    Some(Restart { iw: header.restart * header.mcu_w, header, starts, cols, rows })
                }
                None => None,
            };
            let level = Level { width: w, height: h, strip_off: so as u64, strip_len: sb as u64, restart };
            match planes.iter_mut().find(|p| p.z_nm == z) {
                Some(p) => p.levels.push(level),
                None => planes.push(Plane { z_nm: z, levels: vec![level] }),
            }
        }
        if planes.len() < 2 {
            return Ok(None);
        }
        for p in planes.iter_mut() {
            p.levels.sort_by(|a, b| b.width.cmp(&a.width));
            let l0 = &p.levels[0];
            if l0.width as i64 != expect_w || l0.height as i64 != expect_h {
                return Ok(None);
            }
            // the full-resolution level must be readable in pieces
            if l0.restart.is_none() && l0.width as u64 * l0.height as u64 > MAX_WHOLE_PIXELS {
                return Ok(None);
            }
        }
        planes.sort_by(|a, b| a.z_nm.total_cmp(&b.z_nm));
        Ok(Some(NdpiZStack {
            file,
            width: expect_w as u32,
            height: expect_h as u32,
            planes,
            blocks: Mutex::new(Lru::new(BLOCK_CACHE_BYTES)),
        }))
    }

    /// Focal offsets in nm, ascending (the order `region`'s `plane` refers to).
    pub fn offsets_nm(&self) -> Vec<f64> {
        self.planes.iter().map(|p| p.z_nm).collect()
    }

    /// One block of a level: a column of restart intervals `col`, MCU rows from `rb * BLOCK_MCU_ROWS`.
    fn block(&self, plane: usize, level: usize, col: u32, rb: u32) -> Result<Arc<RgbImage>, String> {
        let key = (plane, level, col, rb);
        if let Some(b) = self.blocks.lock().unwrap().get(&key) {
            return Ok(b);
        }
        let l = &self.planes[plane].levels[level];
        let img = match &l.restart {
            Some(r) => {
                let r0 = rb * BLOCK_MCU_ROWS;
                let r1 = (r0 + BLOCK_MCU_ROWS).min(r.rows);
                let bw = r.iw.min(l.width - col * r.iw);
                let bh = ((r1 - r0) * r.header.mcu_h).min(l.height - r0 * r.header.mcu_h);
                let n = r.starts.len();
                let mut ivs = Vec::with_capacity((r1 - r0) as usize);
                for row in r0..r1 {
                    let idx = (row * r.cols + col) as usize;
                    let s = r.starts[idx] as u64;
                    let e = if idx + 1 < n { r.starts[idx + 1] as u64 } else { l.strip_len };
                    if e <= s || e > l.strip_len {
                        return Err("bad NDPI restart offsets".into());
                    }
                    ivs.push(strip_marker(read_vec(&self.file, l.strip_off + s, (e - s) as usize)?));
                }
                let jpeg = assemble_jpeg(&r.header, bw, bh, &ivs);
                let img = decode_jpeg(&jpeg)?;
                if img.dimensions() != (bw, bh) {
                    image::imageops::crop_imm(&img, 0, 0, bw.min(img.width()), bh.min(img.height())).to_image()
                } else {
                    img
                }
            }
            None => {
                let raw = read_vec(&self.file, l.strip_off, l.strip_len as usize)?;
                let mut img = decode_jpeg(&raw)?;
                if img.dimensions() != (l.width, l.height) {
                    img = image::imageops::resize(&img, l.width, l.height, FilterType::Triangle);
                }
                img
            }
        };
        let img = Arc::new(img);
        self.blocks.lock().unwrap().put(key, img.clone(), img.as_raw().len() + 64);
        Ok(img)
    }

    /// Pixels (lx, ly, lw, lh) of a level, white outside the image.
    fn read_level(&self, plane: usize, level: usize, lx: i64, ly: i64, lw: u32, lh: u32) -> Result<RgbImage, String> {
        let l = &self.planes[plane].levels[level];
        let mut out = RgbImage::from_pixel(lw.max(1), lh.max(1), image::Rgb([255, 255, 255]));
        let x0 = lx.max(0) as u32;
        let y0 = ly.max(0) as u32;
        let x1 = ((lx + lw as i64).max(0) as u32).min(l.width);
        let y1 = ((ly + lh as i64).max(0) as u32).min(l.height);
        if x1 <= x0 || y1 <= y0 {
            return Ok(out);
        }
        let (bw, bh) = match &l.restart {
            Some(r) => (r.iw, BLOCK_MCU_ROWS * r.header.mcu_h),
            None => (l.width, l.height),
        };
        for rb in y0 / bh..=(y1 - 1) / bh {
            for col in x0 / bw..=(x1 - 1) / bw {
                let b = self.block(plane, level, col, rb)?;
                image::imageops::overlay(&mut out, &*b, (col * bw) as i64 - lx, (rb * bh) as i64 - ly);
            }
        }
        Ok(out)
    }

    /// The level-0 rectangle (x, y, w, h) of `plane` (index into `offsets_nm`) scaled to out_w × out_h.
    pub fn region(&self, plane: usize, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32) -> Result<RgbImage, String> {
        let p = self.planes.get(plane).ok_or("no such focal plane")?;
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        let need = (w as f64 / out_w as f64).min(h as f64 / out_h as f64).max(1.0);
        // coarsest level that is still at least as fine as needed
        let mut best = 0;
        for (i, l) in p.levels.iter().enumerate() {
            let ds = self.width as f64 / l.width as f64;
            if ds <= need * 1.0001 {
                best = i;
            }
        }
        let l = &p.levels[best];
        let (dsx, dsy) = (self.width as f64 / l.width as f64, self.height as f64 / l.height as f64);
        let lx = (x as f64 / dsx).floor() as i64;
        let ly = (y as f64 / dsy).floor() as i64;
        let lw = (((x + w) as f64 / dsx).ceil() as i64 - lx).max(1) as u32;
        let lh = (((y + h) as f64 / dsy).ceil() as i64 - ly).max(1) as u32;
        if lw as u64 * lh as u64 > super::MAX_STITCH_PIXELS {
            return Err("region too large".into());
        }
        let img = self.read_level(plane, best, lx, ly, lw, lh)?;
        Ok(if img.dimensions() != (out_w, out_h) { image::imageops::resize(&img, out_w, out_h, FilterType::Triangle) } else { img })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Header parsing + reassembly round-trips a real baseline JPEG (one interval). Multi-interval
    /// files are covered by the real-slide test, which compares against OpenSlide.
    #[test]
    fn restart_blocks_reassemble() {
        let img = RgbImage::from_fn(64, 32, |x, y| image::Rgb([(x * 4) as u8, (y * 8) as u8, 100]));
        let mut jpg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 95)
            .encode(img.as_raw(), 64, 32, image::ExtendedColorType::Rgb8)
            .unwrap();
        let h = parse_jpeg_header(&jpg).unwrap();
        assert!(h.mcu_w == 8 || h.mcu_w == 16);
        assert_eq!(&h.bytes[h.sof_size_pos..h.sof_size_pos + 4], &[0, 32, 0, 64]);
        // the single "interval" is everything after the header minus EOI
        let body = strip_marker(jpg[h.bytes.len()..].to_vec());
        let again = assemble_jpeg(&h, 64, 32, &[body]);
        assert_eq!(decode_jpeg(&again).unwrap(), decode_jpeg(&jpg).unwrap());
    }

    #[test]
    fn marker_stripping() {
        assert_eq!(strip_marker(vec![1, 2, 0xFF, 0xD3]), vec![1, 2]);
        assert_eq!(strip_marker(vec![1, 2, 0xFF, 0xD9]), vec![1, 2]);
        assert_eq!(strip_marker(vec![1, 0xFF, 0x00]), vec![1, 0xFF, 0x00]);
        let h = JpegHeader { bytes: vec![0xFF, 0xD8, 0, 0, 0, 0, 0], sof_size_pos: 3, mcu_w: 8, mcu_h: 8, restart: 1 };
        let j = assemble_jpeg(&h, 16, 8, &[vec![1], vec![2], vec![3]]);
        assert_eq!(&j[3..7], &[0, 8, 0, 16]);
        assert_eq!(&j[7..], &[1, 0xFF, 0xD0, 2, 0xFF, 0xD1, 3, 0xFF, 0xD9]);
    }

    /// A real NDPI z-stack (VMS469: 9 planes, -0.8…+0.8 µm), read-only. The 0 µm plane read
    /// here must match what OpenSlide returns for the same rectangle.
    #[test]
    #[ignore]
    fn real_ndpi_z_stack() {
        let p = std::env::var("NDPI_ZSTACK").unwrap_or("/Users/alexandergadin/vscode/micro-speed-grader/images/VMS469.ndpi".into());
        let p = p.as_str();
        if !std::path::Path::new(p).exists() {
            eprintln!("skipping: {p} not present");
            return;
        }
        let os = crate::slide::Slide::open(p).unwrap();
        let (w, h) = (os.levels[0].0, os.levels[0].1);
        let z = NdpiZStack::open(p, w, h).unwrap().expect("z-stack");
        let offs = z.offsets_nm();
        assert!(offs.len() >= 2, "{offs:?}");
        let zero = offs.iter().position(|o| *o == 0.0).expect("plane at 0");
        // full resolution, a rectangle crossing interval and block borders
        let (x, y) = (w / 2 - 300, h / 2 - 140);
        let mine = z.region(zero, x, y, 600, 280, 600, 280).unwrap();
        let theirs = os.read_region(x, y, 0, 600, 280).unwrap();
        let mut diff = 0u64;
        for (a, b) in mine.as_raw().iter().zip(theirs.as_raw()) {
            diff += (*a as i32 - *b as i32).unsigned_abs() as u64;
        }
        let mean = diff as f64 / mine.as_raw().len() as f64;
        eprintln!("{p}: planes {offs:?}, mean abs diff vs OpenSlide at 0 µm: {mean:.3}");
        assert!(mean < 3.0, "mean abs diff {mean}");
        if let Ok(dir) = std::env::var("NDPI_DUMP") {
            mine.save(format!("{dir}/z_mine.png")).unwrap();
            theirs.save(format!("{dir}/z_openslide.png")).unwrap();
            z.region(0, x, y, 600, 280, 600, 280).unwrap().save(format!("{dir}/z_bottom.png")).unwrap();
        }
        // another plane differs, but not wildly
        let other = z.region(0, x, y, 600, 280, 600, 280).unwrap();
        assert_ne!(other, mine);
        // a zoomed-out read uses a lower level
        let small = z.region(zero, 0, 0, w, h, 256, 256).unwrap();
        assert_eq!(small.dimensions(), (256, 256));
    }
}
