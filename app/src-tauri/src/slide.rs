//! Minimal OpenSlide bindings, loaded at runtime so the same build works on macOS and Windows.
//! Owner: formats builder. `source/openslide.rs` adapts this to the `SlideSource` trait;
//! nothing else should call it directly.

use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use image::RgbImage;
use libloading::Library;

/// Largest region read in one call. Stops slides with no usable low-resolution level from
/// asking for gigabytes (or an overflowed size).
pub const MAX_REGION_PIXELS: i64 = 8192 * 8192;

type OsrPtr = *mut std::ffi::c_void;

struct Api {
    _lib: Library,
    open: unsafe extern "C" fn(*const c_char) -> OsrPtr,
    close: unsafe extern "C" fn(OsrPtr),
    get_error: unsafe extern "C" fn(OsrPtr) -> *const c_char,
    get_level_count: unsafe extern "C" fn(OsrPtr) -> i32,
    get_level_dimensions: unsafe extern "C" fn(OsrPtr, i32, *mut i64, *mut i64),
    get_level_downsample: unsafe extern "C" fn(OsrPtr, i32) -> f64,
    get_best_level_for_downsample: unsafe extern "C" fn(OsrPtr, f64) -> i32,
    read_region: unsafe extern "C" fn(OsrPtr, *mut u32, i64, i64, i32, i64, i64),
    get_property_value: unsafe extern "C" fn(OsrPtr, *const c_char) -> *const c_char,
    get_associated_image_names: unsafe extern "C" fn(OsrPtr) -> *const *const c_char,
    get_associated_image_dimensions: unsafe extern "C" fn(OsrPtr, *const c_char, *mut i64, *mut i64),
    read_associated_image: unsafe extern "C" fn(OsrPtr, *const c_char, *mut u32),
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn candidate_lib_paths() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["libopenslide-1.dll", "openslide.dll"]
    } else if cfg!(target_os = "macos") {
        &["libopenslide.1.dylib", "libopenslide.dylib"]
    } else {
        &["libopenslide.so.1", "libopenslide.so"]
    };
    // 1. next to the executable / in the app bundle's Frameworks + Resources
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in names {
                v.push(dir.join(n));
                v.push(dir.join("../Frameworks").join(n));
                v.push(dir.join("../Resources/lib").join(n));
                v.push(dir.join("lib").join(n));
            }
        }
    }
    // 2. explicit override
    if let Ok(p) = std::env::var("OPENSLIDE_LIB") {
        v.insert(0, PathBuf::from(p));
    }
    // 3. the copy tools/fetch-openslide.sh puts in the source tree (dev builds, cargo test)
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"));
    for n in names {
        v.push(dev.join("frameworks").join(n));
        v.push(dev.join("lib").join(n));
    }
    // 4. common install locations
    if cfg!(target_os = "macos") {
        for n in names {
            v.push(Path::new("/opt/homebrew/lib").join(n));
            v.push(Path::new("/usr/local/lib").join(n));
        }
    }
    // 5. let the OS loader search
    for n in names {
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
        open: sym!("openslide_open"),
        close: sym!("openslide_close"),
        get_error: sym!("openslide_get_error"),
        get_level_count: sym!("openslide_get_level_count"),
        get_level_dimensions: sym!("openslide_get_level_dimensions"),
        get_level_downsample: sym!("openslide_get_level_downsample"),
        get_best_level_for_downsample: sym!("openslide_get_best_level_for_downsample"),
        read_region: sym!("openslide_read_region"),
        get_property_value: sym!("openslide_get_property_value"),
        get_associated_image_names: sym!("openslide_get_associated_image_names"),
        get_associated_image_dimensions: sym!("openslide_get_associated_image_dimensions"),
        read_associated_image: sym!("openslide_read_associated_image"),
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
        Err(format!(
            "Could not load the OpenSlide library ({last_err}). Install it (macOS: `brew install openslide`) or place it next to the app."
        ))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// Copy a C string returned by OpenSlide into a Rust String.
/// Safety: `p` must be a valid, NUL-terminated string that outlives the call.
unsafe fn cstr(p: *const c_char) -> String {
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

/// premultiplied ARGB (OpenSlide's pixel format) → RGB over white
fn argb_to_rgb(buf: &[u32], w: u32, h: u32) -> RgbImage {
    let mut rgb = RgbImage::new(w, h);
    for (i, px) in buf.iter().enumerate() {
        let al = (px >> 24) & 0xff;
        let (r, g, b) = ((px >> 16) & 0xff, (px >> 8) & 0xff, px & 0xff);
        let inv = 255 - al;
        let p = [(r + inv).min(255) as u8, (g + inv).min(255) as u8, (b + inv).min(255) as u8];
        rgb.put_pixel(i as u32 % w, i as u32 / w, image::Rgb(p));
    }
    rgb
}

/// One open OpenSlide handle.
pub struct Slide {
    osr: OsrPtr,
    /// (width, height, downsample) of each native pyramid level, level 0 first
    pub levels: Vec<(i64, i64, f64)>,
}

unsafe impl Send for Slide {}
unsafe impl Sync for Slide {}

impl Drop for Slide {
    fn drop(&mut self) {
        if let Ok(a) = api() {
            unsafe { (a.close)(self.osr) }
        }
    }
}

impl Slide {
    pub fn open(path: &str) -> Result<Slide, String> {
        let a = api()?;
        let c = CString::new(path).map_err(|e| e.to_string())?;
        let osr = unsafe { (a.open)(c.as_ptr()) };
        if osr.is_null() {
            return Err(format!("Not a supported slide file: {path}"));
        }
        let err = unsafe { (a.get_error)(osr) };
        if !err.is_null() {
            let msg = unsafe { cstr(err) };
            unsafe { (a.close)(osr) };
            return Err(msg);
        }
        let n = unsafe { (a.get_level_count)(osr) };
        let mut levels = Vec::new();
        for i in 0..n {
            let (mut w, mut h) = (0i64, 0i64);
            unsafe { (a.get_level_dimensions)(osr, i, &mut w, &mut h) };
            let ds = unsafe { (a.get_level_downsample)(osr, i) };
            levels.push((w, h, ds));
        }
        if levels.is_empty() || levels[0].0 <= 0 || levels[0].1 <= 0 {
            unsafe { (a.close)(osr) };
            return Err(format!("{path}: slide has no image levels"));
        }
        Ok(Slide { osr, levels })
    }

    pub fn property(&self, k: &str) -> Option<String> {
        let a = api().ok()?;
        let ck = CString::new(k).ok()?;
        let v = unsafe { (a.get_property_value)(self.osr, ck.as_ptr()) };
        if v.is_null() { None } else { Some(unsafe { cstr(v) }) }
    }

    pub fn property_f64(&self, k: &str) -> Option<f64> {
        self.property(k).and_then(|s| s.trim().parse::<f64>().ok()).filter(|v| v.is_finite())
    }

    pub fn best_level_for_downsample(&self, ds: f64) -> usize {
        match api() {
            Ok(a) => (unsafe { (a.get_best_level_for_downsample)(self.osr, ds) }).max(0) as usize,
            Err(_) => 0,
        }
        .min(self.levels.len() - 1)
    }

    /// Read `w`×`h` pixels of native `level`, with the top-left at level-0 coordinates (x, y).
    pub fn read_region(&self, x: i64, y: i64, level: usize, w: i64, h: i64) -> Result<RgbImage, String> {
        let a = api()?;
        let n = match w.checked_mul(h) {
            Some(n) if w > 0 && h > 0 && n <= MAX_REGION_PIXELS => n as usize,
            _ => return Err("region too large (slide has no low-resolution levels)".into()),
        };
        let mut buf = vec![0u32; n];
        unsafe { (a.read_region)(self.osr, buf.as_mut_ptr(), x, y, level as i32, w, h) };
        let err = unsafe { (a.get_error)(self.osr) };
        if !err.is_null() {
            return Err(unsafe { cstr(err) });
        }
        Ok(argb_to_rgb(&buf, w as u32, h as u32))
    }

    /// Names of the associated images ("thumbnail", "macro", "label", …).
    pub fn associated_names(&self) -> Vec<String> {
        let Ok(a) = api() else { return vec![] };
        let mut out = Vec::new();
        let mut p = unsafe { (a.get_associated_image_names)(self.osr) };
        if p.is_null() {
            return out;
        }
        unsafe {
            while !(*p).is_null() {
                out.push(cstr(*p));
                p = p.add(1);
            }
        }
        out
    }

    pub fn read_associated(&self, name: &str) -> Result<RgbImage, String> {
        let a = api()?;
        let c = CString::new(name).map_err(|e| e.to_string())?;
        let (mut w, mut h) = (-1i64, -1i64);
        unsafe { (a.get_associated_image_dimensions)(self.osr, c.as_ptr(), &mut w, &mut h) };
        let n = match w.checked_mul(h) {
            Some(n) if w > 0 && h > 0 && n <= MAX_REGION_PIXELS => n as usize,
            _ => return Err(format!("no associated image named {name:?}")),
        };
        let mut buf = vec![0u32; n];
        unsafe { (a.read_associated_image)(self.osr, c.as_ptr(), buf.as_mut_ptr()) };
        let err = unsafe { (a.get_error)(self.osr) };
        if !err.is_null() {
            return Err(unsafe { cstr(err) });
        }
        Ok(argb_to_rgb(&buf, w as u32, h as u32))
    }
}
