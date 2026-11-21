//! Release smoke test (owner: release; run by .github/workflows/build.yml):
//!   cargo run --release --example smoke -- <slide> [<slide> …]
//! Opens each file with the same backends the app uses (`source::open_source`), prints its info,
//! renders the top-left full-resolution tile, a low-resolution tile and an overview, and checks
//! they encode as JPEG. Exits non-zero on the first failure, so CI catches a library that didn't
//! bundle or load (OpenSlide, libCZI) on that platform.
use app_lib::source::{dz_max_level, encode_jpeg, open_source, T_STRIDE};

fn check(path: &str) -> Result<(), String> {
    check_series(path, 0)?;
    // multi-image files (.lif images, .nd2 positions): the last one opens too
    let n = open_source(path, 0)?.info().series.len() as u32;
    if n > 1 {
        check_series(path, n - 1)?;
    }
    Ok(())
}

fn check_series(path: &str, series: u32) -> Result<(), String> {
    let src = open_source(path, series)?;
    let info = src.info();
    println!("{path}: {}", serde_json::to_string(info).map_err(|e| e.to_string())?);
    let max = dz_max_level(info.width, info.height);
    for (level, what) in [(max, "full-resolution tile"), (max.saturating_sub(4), "low-resolution tile")] {
        let t = src.tile(level, 0, 0, 0).map_err(|e| format!("{what}: {e}"))?;
        let jpg = encode_jpeg(&t, 85)?;
        if jpg.len() < 200 || jpg[..2] != [0xff, 0xd8] {
            return Err(format!("{what}: bad JPEG ({} bytes)", jpg.len()));
        }
        println!("  {what} level {level}: {}x{} -> {} bytes", t.width(), t.height(), jpg.len());
    }
    let o = src.overview(512, 0).map_err(|e| format!("overview: {e}"))?;
    if o.width() == 0 || o.height() == 0 || o.width().max(o.height()) > 512 {
        return Err(format!("overview has size {}x{}", o.width(), o.height()));
    }
    println!("  overview: {}x{}", o.width(), o.height());
    if let Some(last) = info.time_points.last().filter(|_| info.time_points.len() > 1) {
        let t = src.tile(max.saturating_sub(4), 0, 0, last.index * T_STRIDE).map_err(|e| format!("last time point: {e}"))?;
        println!("  last time point ({}): {}x{}", last.label, t.width(), t.height());
    }
    Ok(())
}

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage: smoke <slide> [<slide> …]");
        std::process::exit(2);
    }
    for p in &paths {
        if let Err(e) = check(p) {
            eprintln!("FAIL {p}: {e}");
            std::process::exit(1);
        }
    }
    println!("ok: {} file(s)", paths.len());
}
