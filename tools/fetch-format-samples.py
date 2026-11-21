"""Download one small OpenSlide test file per format the app claims, verifying the sha256 the index lists."""
import hashlib, json, os, sys, urllib.parse, urllib.request, zipfile
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
    "Argos/Argos-1.avs",                   # .avs (PreciPoint Argos), read by OpenSlide (93 MB)
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

# cellSens 4 fluorescence .vsi (2-D: 4 channels; 3-D: 5 focal planes × 4 channels) from the OME sample
# image server, which publishes no checksums: these pin the exact files the reader was tested with.
# The folder states no licence, so they're test material for this machine only (gitignored).
OME = "https://downloads.openmicroscopy.org/images/CellSens/evident/"
OME_FILES = [
    ("Image_V4.1_FL_2D.vsi", "92582ee8a636bd0e55c75820cf5ce13065b098012071bb5c5f2613d0857d0bf9", 981224),
    ("Image_V4.1_FL_3D.vsi", "e001363b18d455aeb00bb16fb524bc5d888b73538af25338b97409e8f65dc69e", 794360),
    ("_Image_V4.1_FL_2D_/stack1/frame_t.ets", "17963eb065bc820eaf1d369a71fea85ff1e03608b6e9582f2f6b3993351d8274", 32583122),
    ("_Image_V4.1_FL_2D_/stack10000/blob_21_f.meta", "81d1c52e87419bf675940c3f5594c1db631cfbffffb7e6e1ca7c0287313a9930", 11250),
    ("_Image_V4.1_FL_2D_/stack10000/blob_21_f_Frame#0.ets", "9b3b05d16b514f68a80262c6340d43f2606dffa38a94ccfb8595e3acd4a407fa", 2557600),
    ("_Image_V4.1_FL_2D_/stack10000/frame_t.ets", "70da374b968689a2c7bdacf2ec92757b4c91d23fa310a38d7d6779d1bd890149", 29477786),
    ("_Image_V4.1_FL_2D_/stack10002/frame_t_0.ets", "a8404d8b9c8408ec291eb5b32895dae2fa420b16b6240e483dad1250aa2937ed", 87799619),
    ("_Image_V4.1_FL_2D_/stack10005/frame_t_0.ets", "f35d9b7e09688ecd046795a9a673eb1e39cddad9422635463068fc8b12788262", 86776904),
    ("_Image_V4.1_FL_3D_/stack1/frame_t.ets", "c3a8481966b4b895d7dd5d38d714adc79472a8ebdfd37b7c9a0fec7b29917918", 31165718),
    ("_Image_V4.1_FL_3D_/stack10000/blob_21_f.meta", "3b362e43970d9ce64262eb968107e2fafb571dd38b6d905a0ae31952bd946ff4", 11250),
    ("_Image_V4.1_FL_3D_/stack10000/blob_21_f_Frame#0.ets", "ccbefefb4cdd853ef60e7e365cca43417f85b529964f9bd7318a9e956960af39", 2623172),
    ("_Image_V4.1_FL_3D_/stack10000/frame_t.ets", "0a5d19994265c1ac23fadb9ed522fc1a8102f08f8be4624114831654436ba6b0", 29483993),
    ("_Image_V4.1_FL_3D_/stack10002/frame_t_0.ets", "3908202e1eb15198db4a3e54487d66c51a3f01eff6bedeb275e00a78dfcdfadb", 355503856),
]
for rel, sha, size in OME_FILES:
    dest = os.path.join(OUT, "CellSens-evident", rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not (os.path.exists(dest) and os.path.getsize(dest) == size):
        print(f"downloading CellSens/evident/{rel} ({size/1e6:.0f} MB)", flush=True)
        urllib.request.urlretrieve(OME + urllib.parse.quote(rel), dest + ".part")
        os.replace(dest + ".part", dest)
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != sha:
        print(f"CHECKSUM MISMATCH CellSens/evident/{rel}", flush=True); os.remove(dest); continue
    print(f"ok CellSens/evident/{rel}", flush=True)
print("DONE", flush=True)
