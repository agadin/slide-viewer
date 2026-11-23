"""Tauri config overlay that bundles every native library the fetch scripts left in
app/src-tauri/frameworks/ (OpenSlide, libCZI) into the macOS app, and their licences.
Prints JSON for `tauri build --config`. Used by tools/release.sh and the Build workflow."""
import glob, json, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../app/src-tauri"))
libs = sorted(glob.glob("frameworks/*.dylib"))
lic = {p: "licenses/" + p.split("/")[-1] for p in sorted(glob.glob("frameworks/*LICENSE*"))}
print(json.dumps({"bundle": {"macOS": {"frameworks": libs}, "resources": lic}}))
