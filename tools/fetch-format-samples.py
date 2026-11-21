"""Download one small OpenSlide test file per format the app claims, verifying the sha256 the index lists."""
import hashlib, json, os, sys, urllib.request, zipfile
BASE = "https://openslide.cs.cmu.edu/download/openslide-testdata/"
OUT = sys.argv[1]
WANT = [
    "Aperio/CMU-1-Small-Region.svs",       # .svs (JPEG)
    "Aperio/JP2K-33003-1.svs",             # .svs (JPEG 2000)
    "Generic-TIFF/CMU-1.tiff",             # tiled TIFF
    "Huron/Huron-1.tif",                   # .tif
    "Leica/Leica-Fluorescence-1.scn",      # .scn (fluorescence)
    "Leica/Leica-1.scn",                   # .scn brightfield, one ROI (292 MB)
    "Leica/Leica-2.scn",                   # .scn brightfield, several ROIs in one bounding box (2.3 GB)
    "Mirax/CMU-1-Saved-1_16.zip",          # .mrxs (zip: .mrxs + data folder)
    "Philips-TIFF/Philips-4.tiff",         # Philips .tiff
    "Ventana/Ventana-1.bif",               # .bif (DP 200)
    "Ventana/OS-2.bif",                    # .bif from an older iScan, joint direction RIGHT (2.7 GB)
    "DICOM/JP2K-33003-1.zip",              # .dcm (zip of DICOM files)
    "Hamamatsu-vms/CMU-1.zip",             # .vms (zip)
    "Zeiss/Zeiss-5-SlidePreview-JXR.czi",  # .czi
    "Zeiss/Zeiss-5-Flat.czi",              # .czi mosaic
    "Olympus/OS-1.zip",                    # .vsi, H&E (JPEG 2000 tiles in the _OS-1_ folder)
    "Olympus/OS-2.zip",                    # .vsi, Ki-67
    "Olympus/OS-3.zip",                    # .vsi, PTEN
    "Zeiss/Zeiss-1-Merged.zvi",            # .zvi, 3 fluorescence channels
    "Zeiss/Zeiss-2-Merged.zvi",            # .zvi
    "Zeiss/Zeiss-1-Stacked.zvi",           # .zvi z-stack, 13 planes (113 MB)
    "Zeiss/Zeiss-4-Mosaic.zvi",            # .zvi mosaic, 126 tiles (1.1 GB)
]
idx = json.load(urllib.request.urlopen(BASE + "index.json"))
os.makedirs(OUT, exist_ok=True)
for key in WANT:
    meta = idx[key]
    dest = os.path.join(OUT, key.replace("/", "__"))
    if dest.endswith(".zip") and os.path.isdir(dest[:-4]):
        print(f"ok {key} (already unpacked)", flush=True); continue
    if not (os.path.exists(dest) and os.path.getsize(dest) == meta["size"]):
        print(f"downloading {key} ({meta['size']/1e6:.0f} MB)", flush=True)
        urllib.request.urlretrieve(BASE + key, dest + ".part")
        os.replace(dest + ".part", dest)
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != meta["sha256"]:
        print(f"CHECKSUM MISMATCH {key}", flush=True); os.remove(dest); continue
    if dest.endswith(".zip"):
        d = dest[:-4]
        if not os.path.isdir(d):
            zipfile.ZipFile(dest).extractall(d)
        os.remove(dest)
    print(f"ok {key}", flush=True)
print("DONE", flush=True)
