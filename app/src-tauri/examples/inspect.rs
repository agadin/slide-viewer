//! Look at a slide the way the app does, to check a format by eye:
//!   cargo run --release --example inspect -- <slide> <out-dir> [<x> <y> <w> <h>]
//! Writes <out-dir>/<name>-overview.png (the whole image, 1024 px), <name>-tissue.png (a
//! full-resolution 1024 px region centred on the most tissue-dense part of the overview, so it is
//! not blank background), <name>-thumb.png (what the folder browser shows) and one PNG per
//! associated image, and prints the backend's info.
use std::path::Path;

use app_lib::scan::render_thumbnail;
use app_lib::source::{encode_png, open_source};

fn save(dir: &Path, name: &str, what: &str, img: &image::RgbImage) -> Result<(), String> {
    let p = dir.join(format!("{name}-{what}.png"));
    std::fs::write(&p, encode_png(img)?).map_err(|e| e.to_string())?;
    println!("  {what}: {}x{} -> {}", img.width(), img.height(), p.display());
    Ok(())
}

fn run(path: &str, out: &Path) -> Result<(), String> {
    let src = open_source(path)?;
    let info = src.info().clone();
    println!("{path}: {}", serde_json::to_string(&info).map_err(|e| e.to_string())?);
    let name = Path::new(path).file_name().unwrap().to_string_lossy().to_string();
    let o = src.overview(1024, 0)?;
    save(out, &name, "overview", &o)?;
    // densest tissue: the darkest 16x16 block of the overview
    let (mut best, mut bx, mut by) = (u64::MAX, 0, 0);
    let b = 16u32;
    for y in (0..o.height().saturating_sub(b)).step_by(4) {
        for x in (0..o.width().saturating_sub(b)).step_by(4) {
            let mut s = 0u64;
            for yy in y..y + b {
                for xx in x..x + b {
                    let p = o.get_pixel(xx, yy);
                    s += p[0] as u64 + p[1] as u64 + p[2] as u64;
                }
            }
            if s < best {
                (best, bx, by) = (s, x, y);
            }
        }
    }
    let sx = info.width as f64 / o.width() as f64;
    let sy = info.height as f64 / o.height() as f64;
    let cx = ((bx + b / 2) as f64 * sx) as i64;
    let cy = ((by + b / 2) as f64 * sy) as i64;
    let side = 1024i64.min(info.width).min(info.height);
    let (x0, y0) = ((cx - side / 2).clamp(0, info.width - side), (cy - side / 2).clamp(0, info.height - side));
    println!("  tissue region at level-0 ({x0}, {y0}) size {side}");
    let t = src.region(x0, y0, side, side, side as u32, side as u32, 0)?;
    save(out, &name, "tissue", &t)?;
    save(out, &name, "thumb", &render_thumbnail(&*src, 256)?)?;
    for a in &info.associated {
        match src.associated(a) {
            Ok(img) => save(out, &name, a, &img)?,
            Err(e) => println!("  associated {a}: ERROR {e}"),
        }
    }
    Ok(())
}

/// `<name>-region-x-y-w-h.png`: level-0 rectangle (x, y, w, h) scaled to fit 1024 px.
fn region(path: &str, out: &Path, r: &[i64]) -> Result<(), String> {
    let src = open_source(path)?;
    let (ow, oh) = app_lib::source::fit(r[2], r[3], 1024);
    let img = src.region(r[0], r[1], r[2], r[3], ow, oh, 0)?;
    let name = Path::new(path).file_name().unwrap().to_string_lossy().to_string();
    save(out, &name, &format!("region-{}-{}-{}-{}", r[0], r[1], r[2], r[3]), &img)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 && args.len() != 6 {
        eprintln!("usage: inspect <slide> <out-dir> [<x> <y> <w> <h>]");
        std::process::exit(2);
    }
    let out = Path::new(&args[1]);
    std::fs::create_dir_all(out).expect("out dir");
    let r = if args.len() == 6 {
        let r: Vec<i64> = args[2..].iter().map(|a| a.parse().expect("x y w h are integers")).collect();
        region(&args[0], out, &r)
    } else {
        run(&args[0], out)
    };
    if let Err(e) = r {
        eprintln!("FAIL {}: {e}", args[0]);
        std::process::exit(1);
    }
}
