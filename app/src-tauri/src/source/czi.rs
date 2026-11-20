//! Zeiss .czi via ZEISS libCZI's C API (`libCZIAPI`), loaded at runtime like OpenSlide.
//! Owner: formats builder (also owns build.rs, tools/fetch-libczi.sh and Cargo.toml deps).
//!
//! Library: `tools/fetch-libczi.sh mac|windows` builds a pinned, checksummed libCZI commit into
//! `frameworks/libCZIAPI.dylib` / `lib/libCZIAPI.dll`. libCZI is LGPL-3.0-or-later (its C API
//! layer is MIT), so it stays a separate, replaceable shared library. Without it, .czi files fail
//! to open with a clear message and nothing else is affected.
//!
//! - Pyramid: libCZI's single-channel *scaling* tile accessor picks the right sub-block pyramid
//!   layer for the requested zoom (and downsamples on the fly when a file has no pyramid).
//! - Pixels: brightfield (Bgr24/Bgr48) is shown as is; fluorescence/gray channels are composed
//!   with the file's display settings (channel colours, black/white points) by libCZI's compositor.
//! - Geometry: the layer-0 bounding box of all scenes is the image; gaps between scenes are
//!   background (white for brightfield, black for fluorescence).
//! - mpp from the scaling metadata; z planes from the Z dimension (offsets from the Z scaling;
//!   the middle plane is index 0); associated images from the Label / SlidePreview / Thumbnail
//!   attachments (embedded CZI or JPG/PNG).

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use image::{imageops::FilterType, RgbImage};
use libloading::Library;

use super::cache::{cache_dir, file_key};
use super::{dz_tile_rect, fit, make_planes, LevelInfo, SlideSource, SourceInfo, MAX_STITCH_PIXELS};

type Handle = isize;
type Err = i32;

// ---------------------------------------------------------------- interop structs (#pragma pack(4))

const MAX_DIMS: usize = 9;
const DIM_Z: u32 = 1;
const DIM_C: u32 = 2;
const DIM_T: u32 = 3;

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct IntRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct DimBounds {
    valid: u32,
    start: [i32; MAX_DIMS],
    size: [i32; MAX_DIMS],
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct Coordinate {
    valid: u32,
    value: [i32; MAX_DIMS],
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct Statistics {
    sub_block_count: i32,
    min_m: i32,
    max_m: i32,
    bounding_box: IntRect,
    bounding_box_layer0: IntRect,
    dim_bounds: DimBounds,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct IntSize {
    w: i32,
    h: i32,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct SubBlockInfo {
    compression: i32,
    pixel_type: i32,
    coordinate: Coordinate,
    logical_rect: IntRect,
    physical_size: IntSize,
    m_index: i32,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
struct AccessorOptions {
    bg_r: f32,
    bg_g: f32,
    bg_b: f32,
    sort_by_m: bool,
    use_visibility_check_optimization: bool,
    additional_parameters: *const c_char,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct BitmapInfo {
    width: u32,
    height: u32,
    pixel_type: i32,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
struct BitmapLockInfo {
    ptr_data: *mut c_void,
    ptr_data_roi: *mut c_void,
    stride: u32,
    size: u64,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy, Default)]
struct ScalingInfo {
    scale_x: f64,
    scale_y: f64,
    scale_z: f64,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
struct AttachmentInfo {
    guid: [u8; 16],
    content_file_type: [u8; 9],
    name: [u8; 255],
    name_overflow: bool,
    name_in_case_of_overflow: *mut c_void,
}

#[repr(C, packed(4))]
#[derive(Clone, Copy)]
struct CompositionChannelInfo {
    weight: f32,
    enable_tinting: u8,
    tint_r: u8,
    tint_g: u8,
    tint_b: u8,
    black_point: f32,
    white_point: f32,
    lut_count: i32,
    lut: *const u8,
}

// libCZI pixel types
const PT_GRAY8: i32 = 0;
const PT_GRAY16: i32 = 1;
const PT_BGR24: i32 = 3;
const PT_BGR48: i32 = 4;

// ---------------------------------------------------------------- library loading

struct Api {
    _lib: Library,
    free: unsafe extern "C" fn(*mut c_void),
    create_reader: unsafe extern "C" fn(*mut Handle) -> Err,
    reader_open: unsafe extern "C" fn(Handle, *const Handle) -> Err,
    reader_stats: unsafe extern "C" fn(Handle, *mut Statistics) -> Err,
    reader_metadata: unsafe extern "C" fn(Handle, *mut Handle) -> Err,
    reader_attachment_count: unsafe extern "C" fn(Handle, *mut i32) -> Err,
    reader_attachment_info: unsafe extern "C" fn(Handle, i32, *mut AttachmentInfo) -> Err,
    reader_read_attachment: unsafe extern "C" fn(Handle, i32, *mut Handle) -> Err,
    release_reader: unsafe extern "C" fn(Handle) -> Err,
    subblock_info: unsafe extern "C" fn(Handle, i32, *mut SubBlockInfo) -> Err,
    #[cfg(not(windows))]
    stream_from_file: unsafe extern "C" fn(*const c_char, *mut Handle) -> Err,
    #[cfg(windows)]
    stream_from_file: unsafe extern "C" fn(*const u16, *mut Handle) -> Err,
    release_stream: unsafe extern "C" fn(Handle) -> Err,
    attachment_raw: unsafe extern "C" fn(Handle, *mut u64, *mut c_void) -> Err,
    release_attachment: unsafe extern "C" fn(Handle) -> Err,
    bitmap_info: unsafe extern "C" fn(Handle, *mut BitmapInfo) -> Err,
    bitmap_lock: unsafe extern "C" fn(Handle, *mut BitmapLockInfo) -> Err,
    bitmap_unlock: unsafe extern "C" fn(Handle) -> Err,
    release_bitmap: unsafe extern "C" fn(Handle) -> Err,
    metadata_doc_info: unsafe extern "C" fn(Handle, *mut Handle) -> Err,
    release_metadata: unsafe extern "C" fn(Handle) -> Err,
    doc_scaling: unsafe extern "C" fn(Handle, *mut ScalingInfo) -> Err,
    doc_display_settings: unsafe extern "C" fn(Handle, *mut Handle) -> Err,
    release_doc_info: unsafe extern "C" fn(Handle) -> Err,
    release_display_settings: unsafe extern "C" fn(Handle) -> Err,
    create_accessor: unsafe extern "C" fn(Handle, *mut Handle) -> Err,
    accessor_get: unsafe extern "C" fn(Handle, *const Coordinate, *const IntRect, f32, *const AccessorOptions, *mut Handle) -> Err,
    release_accessor: unsafe extern "C" fn(Handle) -> Err,
    fill_composition: unsafe extern "C" fn(Handle, i32, bool, *mut CompositionChannelInfo) -> Err,
    compose: unsafe extern "C" fn(i32, *const Handle, *const CompositionChannelInfo, *mut Handle) -> Err,
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn lib_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["libCZIAPI.dll"]
    } else if cfg!(target_os = "macos") {
        &["libCZIAPI.dylib", "liblibCZIAPI.dylib"]
    } else {
        &["libCZIAPI.so", "liblibCZIAPI.so"]
    }
}

fn candidate_lib_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("LIBCZI_LIB") {
        v.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in lib_names() {
                v.push(dir.join(n));
                v.push(dir.join("../Frameworks").join(n));
                v.push(dir.join("../Resources/lib").join(n));
                v.push(dir.join("lib").join(n));
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"));
    for n in lib_names() {
        v.push(dev.join("frameworks").join(n));
        v.push(dev.join("lib").join(n));
    }
    for n in lib_names() {
        v.push(PathBuf::from(n));
    }
    v
}

unsafe fn load_api(lib: Library) -> Result<Api, String> {
    macro_rules! sym {
        ($n:literal) => {
            unsafe { *lib.get(concat!($n, "\0").as_bytes()).map_err(|e| format!("{}: {e}", $n))? }
        };
    }
    Ok(Api {
        free: sym!("libCZI_Free"),
        create_reader: sym!("libCZI_CreateReader"),
        reader_open: sym!("libCZI_ReaderOpen"),
        reader_stats: sym!("libCZI_ReaderGetStatisticsSimple"),
        reader_metadata: sym!("libCZI_ReaderGetMetadataSegment"),
        reader_attachment_count: sym!("libCZI_ReaderGetAttachmentCount"),
        reader_attachment_info: sym!("libCZI_ReaderGetAttachmentInfoFromDirectory"),
        reader_read_attachment: sym!("libCZI_ReaderReadAttachment"),
        release_reader: sym!("libCZI_ReleaseReader"),
        subblock_info: sym!("libCZI_TryGetSubBlockInfoForIndex"),
        #[cfg(not(windows))]
        stream_from_file: sym!("libCZI_CreateInputStreamFromFileUTF8"),
        #[cfg(windows)]
        stream_from_file: sym!("libCZI_CreateInputStreamFromFileWide"),
        release_stream: sym!("libCZI_ReleaseInputStream"),
        attachment_raw: sym!("libCZI_AttachmentGetRawData"),
        release_attachment: sym!("libCZI_ReleaseAttachment"),
        bitmap_info: sym!("libCZI_BitmapGetInfo"),
        bitmap_lock: sym!("libCZI_BitmapLock"),
        bitmap_unlock: sym!("libCZI_BitmapUnlock"),
        release_bitmap: sym!("libCZI_ReleaseBitmap"),
        metadata_doc_info: sym!("libCZI_MetadataSegmentGetCziDocumentInfo"),
        release_metadata: sym!("libCZI_ReleaseMetadataSegment"),
        doc_scaling: sym!("libCZI_CziDocumentInfoGetScalingInfo"),
        doc_display_settings: sym!("libCZI_CziDocumentInfoGetDisplaySettings"),
        release_doc_info: sym!("libCZI_ReleaseCziDocumentInfo"),
        release_display_settings: sym!("libCZI_ReleaseDisplaySettings"),
        create_accessor: sym!("libCZI_CreateSingleChannelTileAccessor"),
        accessor_get: sym!("libCZI_SingleChannelTileAccessorGet"),
        release_accessor: sym!("libCZI_ReleaseCreateSingleChannelTileAccessor"),
        fill_composition: sym!("libCZI_CompositorFillOutCompositionChannelInfoInterop"),
        compose: sym!("libCZI_CompositorDoMultiChannelComposition"),
        _lib: lib,
    })
}

fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        let mut last_err = String::from("no candidates");
        for p in candidate_lib_paths() {
            let lib = match unsafe { Library::new(&p) } {
                Ok(l) => l,
                Err(e) => {
                    last_err = format!("{}: {e}", p.display());
                    continue;
                }
            };
            match unsafe { load_api(lib) } {
                Ok(a) => return Ok(a),
                Err(e) => last_err = e,
            }
        }
        Err(format!("CZI support is not installed (libCZIAPI not found: {last_err}). Run tools/fetch-libczi.sh."))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// Whether the libCZI library could be loaded (tests skip CZI work without it).
pub fn available() -> bool {
    api().is_ok()
}

fn check(code: Err, what: &str) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("libCZI {what} failed (error {code})"))
    }
}

// ---------------------------------------------------------------- RAII handles

/// An owned libCZI object released with `release` on drop.
struct Owned {
    h: Handle,
    release: unsafe extern "C" fn(Handle) -> Err,
}

impl Drop for Owned {
    fn drop(&mut self) {
        if self.h != 0 {
            unsafe { (self.release)(self.h) };
        }
    }
}

unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

/// Lock a bitmap, convert it to RGB (sources: Gray8/16, Bgr24/48), unlock.
fn bitmap_to_rgb(a: &Api, bm: Handle) -> Result<RgbImage, String> {
    let mut info = BitmapInfo::default();
    check(unsafe { (a.bitmap_info)(bm, &mut info) }, "bitmap info")?;
    let mut lock = BitmapLockInfo { ptr_data: std::ptr::null_mut(), ptr_data_roi: std::ptr::null_mut(), stride: 0, size: 0 };
    check(unsafe { (a.bitmap_lock)(bm, &mut lock) }, "bitmap lock")?;
    let (w, h, pt) = (info.width, info.height, info.pixel_type);
    let stride = lock.stride as usize;
    let size = lock.size as usize;
    let data = lock.ptr_data_roi as *const u8;
    let result = (|| {
        if data.is_null() || w == 0 || h == 0 {
            return Err("empty bitmap".to_string());
        }
        let bpp = match pt {
            PT_GRAY8 => 1,
            PT_GRAY16 => 2,
            PT_BGR24 => 3,
            PT_BGR48 => 6,
            _ => return Err(format!("unsupported CZI pixel type {pt}")),
        };
        if stride < w as usize * bpp || size < stride * (h as usize - 1) + w as usize * bpp {
            return Err("bad bitmap stride".to_string());
        }
        let buf = unsafe { std::slice::from_raw_parts(data, size) };
        let mut out = RgbImage::new(w, h);
        let o = out.as_mut();
        for y in 0..h as usize {
            let row = &buf[y * stride..y * stride + w as usize * bpp];
            let dst = &mut o[y * w as usize * 3..(y + 1) * w as usize * 3];
            for x in 0..w as usize {
                let d = &mut dst[x * 3..x * 3 + 3];
                match pt {
                    PT_GRAY8 => d.fill(row[x]),
                    PT_GRAY16 => d.fill(row[x * 2 + 1]), // little-endian high byte
                    PT_BGR24 => {
                        d[0] = row[x * 3 + 2];
                        d[1] = row[x * 3 + 1];
                        d[2] = row[x * 3];
                    }
                    _ => {
                        d[0] = row[x * 6 + 5];
                        d[1] = row[x * 6 + 3];
                        d[2] = row[x * 6 + 1];
                    }
                }
            }
        }
        Ok(out)
    })();
    unsafe { (a.bitmap_unlock)(bm) };
    result
}

// ---------------------------------------------------------------- source

#[derive(Clone, Copy, Debug, Default)]
struct Dim {
    present: bool,
    start: i32,
    size: i32,
}

/// Composition info for one channel (its LUT is owned by libCZI and freed on drop).
struct Channel {
    comp: Option<CompositionChannelInfo>,
}

pub struct CziSource {
    // field order = drop order: the reader goes before the stream
    reader: Owned,
    _stream: Owned,
    info: SourceInfo,
    /// layer-0 bounding box (CZI pixel coordinates; x/y may be non-zero)
    bbox: (i32, i32, i32, i32),
    c: Dim,
    z: Dim,
    t: Dim,
    /// file Z index for each `ZPlane::index`
    z_pos: Vec<usize>,
    channels: Vec<Channel>,
    brightfield: bool,
    /// (associated name, attachment index, content type)
    attachments: Vec<(String, i32, String)>,
}

unsafe impl Send for CziSource {}
unsafe impl Sync for CziSource {}

impl Drop for CziSource {
    fn drop(&mut self) {
        if let Ok(a) = api() {
            for ch in &self.channels {
                if let Some(c) = ch.comp {
                    if !c.lut.is_null() {
                        unsafe { (a.free)(c.lut as *mut c_void) };
                    }
                }
            }
        }
    }
}

fn cstr_bytes(b: &[u8]) -> String {
    let n = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..n]).into_owned()
}

/// libCZI attachment name → our associated-image name.
pub fn associated_name(czi_name: &str) -> Option<&'static str> {
    match czi_name {
        "Label" => Some("label"),
        "SlidePreview" => Some("macro"),
        "Thumbnail" => Some("thumbnail"),
        _ => None,
    }
}

/// Z offsets (nm) for `n` planes `step_m` metres apart, centred on the middle plane.
pub fn z_offsets(n: usize, step_m: f64) -> Vec<Option<f64>> {
    let mid = (n as f64 - 1.0) / 2.0;
    (0..n).map(|i| (step_m.is_finite() && step_m > 0.0).then(|| (i as f64 - mid) * step_m * 1e9)).collect()
}

impl CziSource {
    pub fn open(path: &str) -> Result<CziSource, String> {
        Self::open_inner(path, true).map_err(|e| format!("{path}: {e}"))
    }

    fn open_inner(path: &str, with_attachments: bool) -> Result<CziSource, String> {
        let a = api()?;
        let mut sh: Handle = 0;
        #[cfg(not(windows))]
        {
            let c = CString::new(path).map_err(|e| e.to_string())?;
            check(unsafe { (a.stream_from_file)(c.as_ptr(), &mut sh) }, "open file")?;
        }
        #[cfg(windows)]
        {
            let w: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
            check(unsafe { (a.stream_from_file)(w.as_ptr(), &mut sh) }, "open file")?;
        }
        let stream = Owned { h: sh, release: a.release_stream };
        let mut rh: Handle = 0;
        check(unsafe { (a.create_reader)(&mut rh) }, "create reader")?;
        let reader = Owned { h: rh, release: a.release_reader };
        check(unsafe { (a.reader_open)(reader.h, &stream.h) }, "read the file (not a CZI?)")?;

        let mut st = Statistics::default();
        check(unsafe { (a.reader_stats)(reader.h, &mut st) }, "statistics")?;
        let bb = st.bounding_box_layer0;
        let (bx, by, bw, bh) = (bb.x, bb.y, bb.w, bb.h);
        if bw <= 0 || bh <= 0 {
            return Err("CZI has no image data".into());
        }
        let db = st.dim_bounds;
        let (mut c, mut z, mut t) = (Dim::default(), Dim::default(), Dim::default());
        let mut k = 0;
        for bit in 0..MAX_DIMS as u32 {
            if db.valid & (1 << bit) == 0 {
                continue;
            }
            let d = Dim { present: true, start: db.start[k], size: db.size[k] };
            match bit + 1 {
                DIM_C => c = d,
                DIM_Z => z = d,
                DIM_T => t = d,
                _ => {}
            }
            k += 1;
        }

        // pixel type of the first sub-block decides brightfield vs. composed channels
        let mut sb = SubBlockInfo::default();
        let pixel_type = if unsafe { (a.subblock_info)(reader.h, 0, &mut sb) } == 0 { sb.pixel_type } else { PT_BGR24 };
        let n_channels = if c.present { c.size.max(1) } else { 1 };
        let brightfield = matches!(pixel_type, PT_BGR24 | PT_BGR48) && n_channels == 1;

        // metadata: scaling + display settings
        let mut scaling = ScalingInfo { scale_x: f64::NAN, scale_y: f64::NAN, scale_z: f64::NAN };
        let mut channels: Vec<Channel> = (0..n_channels).map(|_| Channel { comp: None }).collect();
        let mut mh: Handle = 0;
        if unsafe { (a.reader_metadata)(reader.h, &mut mh) } == 0 {
            let meta = Owned { h: mh, release: a.release_metadata };
            let mut dh: Handle = 0;
            if unsafe { (a.metadata_doc_info)(meta.h, &mut dh) } == 0 {
                let doc = Owned { h: dh, release: a.release_doc_info };
                let _ = unsafe { (a.doc_scaling)(doc.h, &mut scaling) };
                let mut dsh: Handle = 0;
                if !brightfield && unsafe { (a.doc_display_settings)(doc.h, &mut dsh) } == 0 {
                    let ds = Owned { h: dsh, release: a.release_display_settings };
                    let sixteen = pixel_type == PT_GRAY16 || pixel_type == PT_BGR48;
                    for (i, ch) in channels.iter_mut().enumerate() {
                        let mut ci = CompositionChannelInfo {
                            weight: 1.0,
                            enable_tinting: 0,
                            tint_r: 0,
                            tint_g: 0,
                            tint_b: 0,
                            black_point: 0.0,
                            white_point: 1.0,
                            lut_count: 0,
                            lut: std::ptr::null(),
                        };
                        if unsafe { (a.fill_composition)(ds.h, c.start + i as i32, sixteen, &mut ci) } == 0 {
                            ch.comp = Some(ci);
                        }
                    }
                }
            }
        }
        let (sx, sy) = (scaling.scale_x * 1e6, scaling.scale_y * 1e6);
        let ok = |v: f64| v.is_finite() && v > 0.0 && v < 1000.0;

        let width = bw as i64;
        let height = bh as i64;
        let mut info = SourceInfo::basic("czi", width, height);
        info.vendor = Some("zeiss".into());
        if ok(sx) || ok(sy) {
            info.mpp_x = if ok(sx) { sx } else { sy };
            info.mpp_y = if ok(sy) { sy } else { sx };
            info.calibrated = true;
        }
        info.levels = vec![LevelInfo { width, height, downsample: 1.0 }];
        let mut z_pos = vec![0usize];
        if z.present && z.size > 1 {
            let n = z.size as usize;
            let (planes, pos) = make_planes(&z_offsets(n, scaling.scale_z), n / 2);
            info.z_planes = planes;
            z_pos = pos;
        }

        let mut attachments = Vec::new();
        if with_attachments {
            let mut n = 0i32;
            if unsafe { (a.reader_attachment_count)(reader.h, &mut n) } == 0 {
                for i in 0..n {
                    let mut ai: AttachmentInfo = unsafe { std::mem::zeroed() };
                    if unsafe { (a.reader_attachment_info)(reader.h, i, &mut ai) } != 0 {
                        continue;
                    }
                    if ai.name_overflow && !ai.name_in_case_of_overflow.is_null() {
                        unsafe { (a.free)(ai.name_in_case_of_overflow) };
                        continue;
                    }
                    let name = cstr_bytes(&ai.name);
                    let ty = cstr_bytes(&ai.content_file_type);
                    if let Some(ours) = associated_name(&name) {
                        if !attachments.iter().any(|(n, _, _): &(String, i32, String)| n == ours) {
                            attachments.push((ours.to_string(), i, ty));
                        }
                    }
                }
            }
        }
        info.associated = attachments.iter().map(|(n, _, _)| n.clone()).collect();

        Ok(CziSource { reader, _stream: stream, info, bbox: (bx, by, bw, bh), c, z, t, z_pos, channels, brightfield, attachments })
    }

    /// The level-0 rectangle (image coordinates) of focal plane `zi` scaled to about out_w × out_h.
    fn render(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, zi: u32) -> Result<RgbImage, String> {
        let a = api()?;
        if w <= 0 || h <= 0 || out_w == 0 || out_h == 0 {
            return Err("empty region".into());
        }
        let file_z = *self.z_pos.get(zi as usize).ok_or("no such focal plane")?;
        let roi = IntRect { x: self.bbox.0 + x as i32, y: self.bbox.1 + y as i32, w: w as i32, h: h as i32 };
        let zoom = (out_w as f64 / w as f64).max(out_h as f64 / h as f64).min(1.0) as f32;
        let bg = if self.brightfield { 1.0 } else { 0.0 };
        let opts = AccessorOptions {
            bg_r: bg,
            bg_g: bg,
            bg_b: bg,
            sort_by_m: true,
            use_visibility_check_optimization: true,
            additional_parameters: std::ptr::null(),
        };
        let mut ah: Handle = 0;
        check(unsafe { (a.create_accessor)(self.reader.h, &mut ah) }, "create accessor")?;
        let acc = Owned { h: ah, release: a.release_accessor };

        let mut bitmaps: Vec<Owned> = Vec::new();
        for ch in 0..self.channels.len() {
            let mut coord = Coordinate::default();
            let mut k = 0;
            for (dim, d, v) in [(DIM_Z, self.z, self.z.start + file_z as i32), (DIM_C, self.c, self.c.start + ch as i32), (DIM_T, self.t, self.t.start)] {
                if d.present {
                    coord.valid |= 1 << (dim - 1);
                    coord.value[k] = v;
                    k += 1;
                }
            }
            // values must follow bit order (Z=bit0, C=bit1, T=bit2): the loop above is in that order
            let mut bh: Handle = 0;
            check(unsafe { (a.accessor_get)(acc.h, &coord, &roi, zoom, &opts, &mut bh) }, "read tile")?;
            bitmaps.push(Owned { h: bh, release: a.release_bitmap });
        }

        let composed: Option<Owned> = if self.brightfield || self.channels.iter().any(|c| c.comp.is_none()) {
            None
        } else {
            let handles: Vec<Handle> = bitmaps.iter().map(|b| b.h).collect();
            let infos: Vec<CompositionChannelInfo> = self.channels.iter().map(|c| c.comp.unwrap()).collect();
            let mut out: Handle = 0;
            check(unsafe { (a.compose)(handles.len() as i32, handles.as_ptr(), infos.as_ptr(), &mut out) }, "compose channels")?;
            Some(Owned { h: out, release: a.release_bitmap })
        };
        let img = match &composed {
            Some(c) => bitmap_to_rgb(a, c.h)?,
            None if bitmaps.len() == 1 => bitmap_to_rgb(a, bitmaps[0].h)?,
            None => {
                // no display settings: gray channels as R, G, B (first three)
                let mut acc_img: Option<RgbImage> = None;
                for (i, b) in bitmaps.iter().take(3).enumerate() {
                    let g = bitmap_to_rgb(a, b.h)?;
                    let dst = acc_img.get_or_insert_with(|| RgbImage::new(g.width(), g.height()));
                    for (d, s) in dst.pixels_mut().zip(g.pixels()) {
                        d[i] = s[0];
                    }
                }
                acc_img.ok_or("no channels")?
            }
        };
        drop(composed);
        drop(bitmaps);
        drop(acc);
        Ok(if img.dimensions() != (out_w, out_h) { image::imageops::resize(&img, out_w, out_h, FilterType::Triangle) } else { img })
    }

    fn read_attachment(&self, idx: i32) -> Result<Vec<u8>, String> {
        let a = api()?;
        let mut h: Handle = 0;
        check(unsafe { (a.reader_read_attachment)(self.reader.h, idx, &mut h) }, "read attachment")?;
        let att = Owned { h, release: a.release_attachment };
        let mut size = 0u64;
        check(unsafe { (a.attachment_raw)(att.h, &mut size, std::ptr::null_mut()) }, "attachment size")?;
        if size == 0 || size > 512 << 20 {
            return Err("attachment empty or too large".into());
        }
        let mut buf = vec![0u8; size as usize];
        let mut got = size;
        check(unsafe { (a.attachment_raw)(att.h, &mut got, buf.as_mut_ptr() as *mut c_void) }, "attachment data")?;
        buf.truncate(got.min(size) as usize);
        Ok(buf)
    }
}

impl SlideSource for CziSource {
    fn info(&self) -> &SourceInfo {
        &self.info
    }

    fn tile(&self, level: u32, x: u32, y: u32, z: u32) -> Result<RgbImage, String> {
        let (fx, fy, fw, fh, tw, th) = dz_tile_rect(self.info.width, self.info.height, level, x, y)?;
        self.render(fx, fy, fw, fh, tw, th, z)
    }

    fn region(&self, x: i64, y: i64, w: i64, h: i64, out_w: u32, out_h: u32, z: u32) -> Result<RgbImage, String> {
        if out_w as u64 * out_h as u64 > MAX_STITCH_PIXELS {
            return Err("region too large".into());
        }
        self.render(x, y, w, h, out_w, out_h, z)
    }

    fn associated(&self, name: &str) -> Result<RgbImage, String> {
        let (_, idx, ty) = self.attachments.iter().find(|(n, _, _)| n == name).ok_or_else(|| format!("no associated image named {name:?}"))?;
        let bytes = self.read_attachment(*idx)?;
        if ty.eq_ignore_ascii_case("CZI") {
            // an embedded CZI document: write it out once and render it whole
            let dir = cache_dir("czi-attachments");
            let p = dir.join(format!("{}-{name}.czi", file_key(&format!("{:?}{}", self.bbox, bytes.len()))));
            if !p.exists() {
                let tmp = p.with_extension("part");
                std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
            }
            let inner = CziSource::open_inner(p.to_str().ok_or("bad cache path")?, false)?;
            let (w, h) = fit(inner.info.width, inner.info.height, 4096);
            inner.render(0, 0, inner.info.width, inner.info.height, w, h, 0)
        } else {
            image::load_from_memory(&bytes).map(|i| i.to_rgb8()).map_err(|e| format!("{name}: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::dz_max_level;

    #[test]
    fn struct_layouts_match_libczi() {
        // #pragma pack(4) sizes from libCZIAPI's headers
        assert_eq!(std::mem::size_of::<IntRect>(), 16);
        assert_eq!(std::mem::size_of::<DimBounds>(), 4 + 9 * 4 * 2);
        assert_eq!(std::mem::size_of::<Coordinate>(), 40);
        assert_eq!(std::mem::size_of::<Statistics>(), 12 + 32 + 76);
        assert_eq!(std::mem::size_of::<BitmapLockInfo>(), 28);
        assert_eq!(std::mem::size_of::<AttachmentInfo>(), 16 + 9 + 255 + 1 + 3 + 8);
        assert_eq!(std::mem::size_of::<CompositionChannelInfo>(), 28);
        assert_eq!(std::mem::size_of::<ScalingInfo>(), 24);
        assert_eq!(std::mem::size_of::<SubBlockInfo>(), 8 + 40 + 16 + 8 + 4);
    }

    #[test]
    fn names_and_offsets() {
        assert_eq!(associated_name("SlidePreview"), Some("macro"));
        assert_eq!(associated_name("Label"), Some("label"));
        assert_eq!(associated_name("Other"), None);
        assert_eq!(z_offsets(3, 0.5e-6), vec![Some(-500.0), Some(0.0), Some(500.0)]);
        assert_eq!(z_offsets(2, f64::NAN), vec![None, None]);
    }

    #[test]
    fn missing_file_is_an_error() {
        assert!(CziSource::open("/nonexistent/x.czi").is_err());
    }

    fn sample(name: &str) -> Option<String> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-data").join(name);
        (p.exists() && available()).then(|| p.to_string_lossy().into_owned())
    }

    /// Public OpenSlide test file (CC0): `curl -o test-data/Zeiss-5-JXR.czi
    /// https://openslide.cs.cmu.edu/download/openslide-testdata/Zeiss/Zeiss-5-JXR.czi`.
    /// Skips when the file or libCZIAPI is missing.
    #[test]
    fn real_czi_sample() {
        let Some(p) = sample("Zeiss-5-JXR.czi") else {
            eprintln!("skipping: test-data/Zeiss-5-JXR.czi or libCZIAPI missing");
            return;
        };
        let s = CziSource::open(&p).unwrap();
        let i = &s.info.clone();
        eprintln!("CZI {}×{} mpp {} {} assoc {:?} brightfield {}", i.width, i.height, i.mpp_x, i.calibrated, i.associated, s.brightfield);
        assert!(i.calibrated && i.mpp_x > 0.1 && i.mpp_x < 2.0);
        assert!(s.brightfield);
        assert_eq!(i.z_planes.len(), 1);
        let max = dz_max_level(i.width, i.height);
        let t = s.tile(max, 0, 0, 0).unwrap();
        assert_eq!(t.dimensions(), (256, 256));
        let low = s.tile(max - 8, 0, 0, 0).unwrap();
        assert!(low.width() <= 256 && low.height() <= 256);
        // tiles are rendered on a thread pool: concurrent reads must work
        let s = std::sync::Arc::new(s);
        let handles: Vec<_> = (0..8u32)
            .map(|k| {
                let s = s.clone();
                std::thread::spawn(move || {
                    for j in 0..6u32 {
                        let t = s.tile(max - 2, k * 3 + j % 3, j % 2, 0).unwrap();
                        assert!(t.width() > 0);
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let o = s.overview(1024, 0).unwrap();
        assert!(o.width() == 1024 || o.height() == 1024);
        // not all background: some tissue somewhere
        assert!(o.pixels().any(|p| p[0] < 200 || p[1] < 200));
        if let Ok(dir) = std::env::var("CZI_DUMP") {
            o.save(format!("{dir}/czi_overview.png")).unwrap();
        }
        for a in &i.associated {
            let img = s.associated(a).unwrap_or_else(|e| panic!("{a}: {e}"));
            assert!(img.width() > 0, "{a}");
            if let Ok(dir) = std::env::var("CZI_DUMP") {
                img.save(format!("{dir}/czi_{a}.png")).unwrap();
            }
        }
    }

    /// A 48-bpp single-image CZI (the SlidePreview of the same scan).
    #[test]
    fn real_czi_48bpp() {
        let Some(p) = sample("Zeiss-5-SlidePreview-Zstd0.czi") else {
            eprintln!("skipping: test-data/Zeiss-5-SlidePreview-Zstd0.czi or libCZIAPI missing");
            return;
        };
        let s = CziSource::open(&p).unwrap();
        let o = s.overview(512, 0).unwrap();
        assert!(o.width() == 512 || o.height() == 512);
        assert!(o.pixels().any(|p| p[0] != o.get_pixel(0, 0)[0]));
    }
}
