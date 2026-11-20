//! Tauri commands + app setup. SHARED FILE: every command the feature builders need is already
//! registered below as a thin wrapper that delegates into the owning module (see CONTRACTS.md).
//! Builders implement the module functions; they should not need to touch this file. If one
//! truly must, append a small clearly delimited section at the end of the command block.

pub mod files;
pub mod scan;
pub mod slide;
pub mod source;
pub mod tiles;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use source::{SlideInfo, SlideRegistry, ZPlane};
use tauri::http::{Response, StatusCode};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

type Reg<'a> = tauri::State<'a, Arc<SlideRegistry>>;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

fn is_remote_path(p: &str) -> bool {
    // never let a path reach out to a network share (on Windows a UNC path makes the OS send credentials)
    let t = p.trim_start();
    t.starts_with("\\\\") || t.starts_with("//") || t.starts_with("\\/") || t.starts_with("/\\")
}

fn app_dir(app: &tauri::AppHandle, cache: bool) -> Result<PathBuf, String> {
    let p = if cache { app.path().app_cache_dir() } else { app.path().app_data_dir() };
    p.map_err(|e| e.to_string())
}

/// Image bytes in the requested encoding: "jpeg" (default), "png" or "rgba" (raw, width*height*4).
fn encode(img: &image::RgbImage, format: Option<&str>) -> Result<tauri::ipc::Response, String> {
    let bytes = match format.unwrap_or("jpeg") {
        "png" => source::encode_png(img)?,
        "rgba" => source::to_rgba(img),
        "jpeg" | "jpg" => source::encode_jpeg(img, 90)?,
        f => return Err(format!("unknown image format {f:?}")),
    };
    Ok(tauri::ipc::Response::new(bytes))
}

// ------------------------------------------------------------------ slides (owner: formats)

#[tauri::command]
async fn open_slide(state: Reg<'_>, path: String) -> Result<SlideInfo, String> {
    if is_remote_path(&path) {
        return Err(format!("{path}: network paths are not allowed for slides"));
    }
    let reg = state.inner().clone();
    blocking(move || reg.open(&path)).await
}

#[tauri::command]
fn close_slide(state: Reg<'_>, id: u32) -> bool {
    state.close(id)
}

#[tauri::command]
fn slide_info(state: Reg<'_>, id: u32) -> Option<SlideInfo> {
    state.info(id)
}

#[tauri::command]
fn slide_z_planes(state: Reg<'_>, id: u32) -> Result<Vec<ZPlane>, String> {
    state.get(id).map(|s| s.info().z_planes.clone()).ok_or_else(|| "unknown slide".into())
}

#[tauri::command]
fn supported_extensions() -> Vec<String> {
    source::supported_extensions()
}

/// An associated image ("thumbnail", "macro", "label"), fitted into max_px when given.
#[tauri::command]
async fn slide_associated(state: Reg<'_>, id: u32, name: String, max_px: Option<u32>, format: Option<String>) -> Result<tauri::ipc::Response, String> {
    let s = state.get(id).ok_or("unknown slide")?;
    blocking(move || {
        let mut img = s.associated(&name)?;
        if let Some(m) = max_px {
            let (w, h) = source::fit(img.width() as i64, img.height() as i64, m);
            if (w, h) != img.dimensions() {
                img = image::imageops::resize(&img, w, h, image::imageops::FilterType::Triangle);
            }
        }
        encode(&img, format.as_deref())
    })
    .await
}

/// A level-0 rectangle (x, y, width, height) scaled to outWidth × outHeight, on focal plane z.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn slide_region(
    state: Reg<'_>,
    id: u32,
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    out_width: u32,
    out_height: u32,
    z: Option<u32>,
    format: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let s = state.get(id).ok_or("unknown slide")?;
    if out_width as u64 * out_height as u64 > source::MAX_STITCH_PIXELS {
        return Err("output too large".into());
    }
    blocking(move || encode(&s.region(x, y, width, height, out_width, out_height, z.unwrap_or(0))?, format.as_deref())).await
}

/// The whole slide fitted into max_px (stain estimation, auto levels, navigator).
#[tauri::command]
async fn slide_overview(state: Reg<'_>, id: u32, max_px: u32, z: Option<u32>, format: Option<String>) -> Result<tauri::ipc::Response, String> {
    let s = state.get(id).ok_or("unknown slide")?;
    blocking(move || encode(&s.overview(max_px.clamp(1, 8192), z.unwrap_or(0))?, format.as_deref())).await
}

// ------------------------------------------------------------------ folder browser (owner: browser)

/// Recursive scan of `dir`; emits "scan-progress" events (scan::ScanProgress) while it runs.
#[tauri::command]
async fn scan_folder(app: tauri::AppHandle, dir: String) -> Result<scan::ScanResult, String> {
    if is_remote_path(&dir) {
        return Err(format!("{dir}: network paths are not allowed"));
    }
    let fallback = app_dir(&app, false)?.join("annotations");
    blocking(move || scan::scan_folder(&dir, &fallback, &|p| { let _ = app.emit("scan-progress", p); })).await
}

/// JPEG thumbnail of a slide file (disk-cached by scan.rs).
#[tauri::command]
async fn slide_thumbnail(app: tauri::AppHandle, state: Reg<'_>, path: String, max_px: u32) -> Result<tauri::ipc::Response, String> {
    if is_remote_path(&path) {
        return Err(format!("{path}: network paths are not allowed"));
    }
    let reg = state.inner().clone();
    let cache = app_dir(&app, true)?.join("thumbs");
    blocking(move || scan::thumbnail(&reg, &path, max_px.clamp(16, 2048), &cache).map(tauri::ipc::Response::new)).await
}

// ------------------------------------------------------------------ annotations files (owner: annotations)

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationPaths {
    /// `<slide>.ndpa` next to the slide
    primary: String,
    primary_exists: bool,
    /// whether the slide's folder accepts new files
    primary_writable: bool,
    /// app-data copy used when the slide's folder is read-only
    fallback: String,
    fallback_exists: bool,
}

#[tauri::command]
fn annotation_paths(app: tauri::AppHandle, slide_path: String) -> Result<AnnotationPaths, String> {
    let primary = files::primary_annotation_path(&slide_path);
    let fallback = files::fallback_annotation_path(&app_dir(&app, false)?.join("annotations"), &slide_path);
    let dir = Path::new(&slide_path).parent().unwrap_or(Path::new("."));
    Ok(AnnotationPaths {
        primary_exists: Path::new(&primary).exists(),
        primary_writable: files::dir_writable(dir),
        fallback_exists: Path::new(&fallback).exists(),
        primary,
        fallback,
    })
}

// ------------------------------------------------------------------ generic files (shared)

/// Recursively list files under `dir` whose name ends with one of `suffixes`
/// (case-insensitive). Hidden files and macOS resource forks are skipped.
#[tauri::command]
fn list_files(dir: String, suffixes: Vec<String>) -> Result<Vec<String>, String> {
    fn walk(p: &Path, suffixes: &[String], out: &mut Vec<String>) -> std::io::Result<()> {
        for e in std::fs::read_dir(p)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }
            let path = e.path();
            if path.is_dir() {
                walk(&path, suffixes, out)?;
            } else {
                let lower = name.to_lowercase();
                if suffixes.is_empty() || suffixes.iter().any(|s| lower.ends_with(&s.to_lowercase())) {
                    out.push(path.to_string_lossy().to_string());
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(Path::new(&dir), &suffixes, &mut out).map_err(|e| format!("{dir}: {e}"))?;
    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    if let Some(max) = max_bytes {
        let len = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?.len();
        if len > max {
            return Err(format!("{path}: file is larger than {max} bytes"));
        }
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    // .ndpa files are UTF-8, but be forgiving about BOMs / stray bytes
    let s = String::from_utf8_lossy(&bytes);
    Ok(s.trim_start_matches('\u{feff}').to_string())
}

#[tauri::command]
fn read_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Crash-safe write (temp file + rename); keeps `<file>.bak` with `keep_backup`.
#[tauri::command]
fn write_text(path: String, contents: String, keep_backup: Option<bool>) -> Result<(), String> {
    files::write_atomic(&path, contents.as_bytes(), keep_backup.unwrap_or(false))
}

/// Raw-body write: the body is the file's bytes, header `path` its percent-encoded path.
fn raw_write(request: &tauri::ipc::Request<'_>, png_only: bool) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    let path = request.headers().get("path").and_then(|v| v.to_str().ok()).ok_or("missing path header")?;
    let path = files::percent_decode(path)?;
    if png_only && !data.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("not a PNG image".into());
    }
    files::write_atomic(&path, data, false)
}

#[tauri::command]
fn write_bytes(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    raw_write(&request, false)
}

/// Snapshot export: like write_bytes, but the body must be a PNG.
#[tauri::command]
fn save_png(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    raw_write(&request, true)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

// ------------------------------------------------------------------ windows (shared)

/// Preferences live in their own window (index.html?window=preferences); settings are
/// shared with the main window through localStorage.
#[tauri::command]
fn open_preferences<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    show_window(&app, "preferences", "index.html?window=preferences", false, |b| {
        b.title("Preferences").inner_size(820.0, 600.0).min_inner_size(680.0, 440.0)
    })
}

/// Bring a secondary window to the front, or create it. When it's already open and `reload`
/// is set, it navigates to `url` (e.g. a different help topic).
fn show_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    url: &str,
    reload: bool,
    build: impl FnOnce(tauri::WebviewWindowBuilder<'_, R, tauri::AppHandle<R>>) -> tauri::WebviewWindowBuilder<'_, R, tauri::AppHandle<R>>,
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        if reload {
            let _ = w.eval(format!("location.replace({url:?})"));
        }
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    build(tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App(url.into())))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Help viewer: its own narrow window, like macOS Help. `topic` is a help topic id ("" = topic list).
#[tauri::command]
fn open_help<R: tauri::Runtime>(app: tauri::AppHandle<R>, topic: String) -> Result<(), String> {
    // "article" or "article/section": short slugs only; anything else opens the help home page
    let ok = topic.len() <= 80 && topic.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '/');
    let topic = if ok { topic } else { String::new() };
    let url = format!("index.html?window=help&topic={topic}");
    let beside = app.get_webview_window("main").and_then(|m| {
        let (pos, size, scale) = (m.outer_position().ok()?, m.outer_size().ok()?, m.scale_factor().ok()?);
        let (p, s) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
        Some(((p.x + s.width - 400.0).max(0.0), p.y + 60.0))
    });
    show_window(&app, "help", &url, true, |b| {
        let b = b.title("Slide Viewer Help").inner_size(420.0, 680.0).min_inner_size(320.0, 360.0);
        match beside {
            Some((x, y)) => b.position(x, y),
            None => b,
        }
    })
}

// ------------------------------------------------------------------ tiles

fn tile_response(reg: &SlideRegistry, uri_path: &str) -> Response<Vec<u8>> {
    let not_found = |msg: String| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Access-Control-Allow-Origin", "*")
            .body(msg.into_bytes())
            .unwrap()
    };
    let Some(t) = tiles::parse_tile_path(uri_path) else {
        return not_found("bad tile path".into());
    };
    let Some(slide) = reg.get(t.id) else {
        return not_found("unknown slide".into());
    };
    match slide.tile(t.level, t.x, t.y, t.z).and_then(|img| source::encode_jpeg(&img, 85)) {
        Ok(bytes) => Response::builder()
            .header("Content-Type", "image/jpeg")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "max-age=31536000")
            .body(bytes)
            .unwrap(),
        Err(e) => not_found(e),
    }
}

// ------------------------------------------------------------------ menu

/// Menu item ids the frontend receives as the "menu" event payload (CONTRACTS.md).
const MENU_EVENTS: &[&str] = &[
    "open_folder",
    "rescan_folder",
    "export_ndpa",
    "snapshot",
    "check_updates",
    "undo",
    "redo",
    "toggle_browser",
    "toggle_panel",
    "rotate_left",
    "rotate_right",
    "zoom_fit",
    "prev_slide",
    "next_slide",
];

/// Native menu bar. On macOS the first submenu is the app menu; on Windows it shows as a File menu.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: Option<&str>| MenuItem::with_id(app, id, label, true, accel);
    let prefs = item("preferences", "Preferences…", Some("CmdOrCtrl+,"))?;
    let open = item("open_folder", "Open Folder…", Some("CmdOrCtrl+O"))?;
    let rescan = item("rescan_folder", "Rescan Folder", Some("CmdOrCtrl+R"))?;
    let export = item("export_ndpa", "Export Annotations (.ndpa)…", Some("CmdOrCtrl+E"))?;
    let snapshot = item("snapshot", "Save Snapshot (PNG)…", Some("CmdOrCtrl+Shift+S"))?;
    let close_w = item("close_window", "Close Window", Some("CmdOrCtrl+W"))?;
    let updates = item("check_updates", "Check for Updates…", None)?;
    let help = item("help", "Slide Viewer Help", Some("CmdOrCtrl+Shift+/"))?;
    // undo/redo carry no accelerator: ⌘Z must still reach text fields; lib/keys.ts handles it on the slide
    let undo = item("undo", "Undo", None)?;
    let redo = item("redo", "Redo", None)?;
    let tog_b = item("toggle_browser", "Show / Hide Slide Browser", Some("CmdOrCtrl+Alt+1"))?;
    let tog_p = item("toggle_panel", "Show / Hide Side Panel", Some("CmdOrCtrl+Alt+2"))?;
    let rot_l = item("rotate_left", "Rotate Left", None)?;
    let rot_r = item("rotate_right", "Rotate Right", None)?;
    let fit = item("zoom_fit", "Zoom to Fit", Some("CmdOrCtrl+0"))?;
    let prev = item("prev_slide", "Previous Slide", None)?;
    let next = item("next_slide", "Next Slide", None)?;
    let sep = || PredefinedMenuItem::separator(app);

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        app,
        "Slide Viewer",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Slide Viewer"), None)?,
            &updates,
            &sep()?,
            &prefs,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let file_menu = Submenu::with_items(app, "File", true, &[&open, &rescan, &sep()?, &export, &snapshot, &sep()?, &close_w])?;
    #[cfg(not(target_os = "macos"))]
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&open, &rescan, &sep()?, &export, &snapshot, &sep()?, &prefs, &updates, &sep()?, &close_w, &PredefinedMenuItem::quit(app, None)?],
    )?;

    // Cut/copy/paste/select-all are required on macOS for text fields.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(app, "View", true, &[&tog_b, &tog_p, &sep()?, &fit, &rot_l, &rot_r, &sep()?, &prev, &next])?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let help_menu = Submenu::with_items(app, "Help", true, &[&help])?;

    #[cfg(target_os = "macos")]
    return Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu]);
    #[cfg(not(target_os = "macos"))]
    return Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu]);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = Arc::new(SlideRegistry::default());
    let reg_for_protocol = registry.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(registry)
        .register_asynchronous_uri_scheme_protocol("slide", move |_ctx, request, responder| {
            let reg = reg_for_protocol.clone();
            let path = request.uri().path().to_string();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(tile_response(&reg, &path));
            });
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Slide Viewer");
            }
            app.set_menu(build_menu(app.handle())?)?;
            // ==== formats: backend caches (plain-image disk pyramids, CZI attachments) ====
            if let Ok(d) = app_dir(app.handle(), true) {
                source::cache::set_cache_dir(d);
            }
            // ==== end formats ====
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "close_window" {
                // ⌘W closes the focused window (Help, Preferences or the main window)
                let focused = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
                if let Some(w) = focused {
                    let _ = w.close();
                }
            } else if id == "preferences" {
                let _ = open_preferences(app.clone());
            } else if id == "help" {
                let _ = open_help(app.clone(), String::new());
            } else if MENU_EVENTS.contains(&id) {
                // only the main window acts on menu events
                let _ = app.emit_to("main", "menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            // slides (formats)
            open_slide,
            close_slide,
            slide_info,
            slide_z_planes,
            supported_extensions,
            slide_associated,
            slide_region,
            slide_overview,
            // folder browser (browser)
            scan_folder,
            slide_thumbnail,
            // annotation files (annotations)
            annotation_paths,
            // generic files
            list_files,
            read_text,
            read_bytes,
            write_text,
            write_bytes,
            save_png,
            path_exists,
            // windows
            open_preferences,
            open_help
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
