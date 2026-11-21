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
# Leica .lif from the OME sample image server (no published checksums: these pin the tested files).
# Each folder's COPYING is CC BY 4.0: Project007 (c) Peter Zentis (zenodo 6606445; 4-channel z-stacks
# and a 2 x 2 TileScan), the FRET test (c) Nicolas Chiaruttini (image.sc 30856; 8 two-channel series),
# PR2729 (c) Michael Goelzer (a small 2 x 2 TileScan z-stack time series).
LIF = "https://downloads.openmicroscopy.org/images/Leica-LIF/"
LIF_FILES = [
    ("zenodo-6606445/Project007.lif", "a4bc49b2fb9f1adf3a66872d01e1450db1d898fc7f4d2386aefa28836c2ec419", 111643445),
    ("imagesc-30856/20191025 Test FRET 585. 423, 426.lif", "8d4ee62868b9616b832c2eb28e7d62ec050fb032e0bc11ea0a392f5c84390c71", 49313199),
    ("michael/PR2729_frameOrderCombinedScanTypes.lif", "17994bb1bdf93dd1a34a19ed53e5a3d7f672470a8057e2998e25d2474437a052", 227429),
]
for rel, sha, size in LIF_FILES:
    dest = os.path.join(OUT, "Leica-LIF", os.path.basename(rel))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not (os.path.exists(dest) and os.path.getsize(dest) == size):
        print(f"downloading Leica-LIF/{rel} ({size/1e6:.0f} MB)", flush=True)
        urllib.request.urlretrieve(LIF + urllib.parse.quote(rel), dest + ".part")
        os.replace(dest + ".part", dest)
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != sha:
        print(f"CHECKSUM MISMATCH Leica-LIF/{rel}", flush=True); os.remove(dest); continue
    print(f"ok Leica-LIF/{rel}", flush=True)

# Olympus/Evident FluoView .oir confocal stacks from the OME sample image server (no published
# checksums: these pin the files the reader was tested with). Licence: CC BY 4.0 (COPYING in each
# folder). gh-4205/zenodo-*: (c) Nicolas Chiaruttini (and Lucie Dixsaut), zenodo.org/records/12773657
# and /13680725; imagesc-105684: (c) Chin Hung, zenodo.org/records/14417737.
OIR = "https://downloads.openmicroscopy.org/images/Olympus-OIR/"
OIR_FILES = [
    # 2 channels (LUT colours cyan/red), 53 focal planes, brain section (63 MB)
    ("gh-4205/zenodo-13680725/tiling-sample-brain-section_A01_G001_0001.oir", "eb3ff7d8fa35daeb2b9d28c5ab84acdf2bc56f759ac6a57e90227321c9e1c63b", 62697450),
    # 2 channels, 8 focal planes, 5 time points (52 MB)
    ("imagesc-105684/1202-interval_30sec_sequence_frame_z stack.oir", "1f7e18de60233adf8e81128181cc2f4737713e052eb1b5b0573bf30c170a2d62", 51778648),
    # spectral (lambda) scan: 5 wavelength bands × 4 focal planes (15 MB)
    ("gh-4205/zenodo-12773657/DAPI_mCherry_4Z_5Lambda-420-630-w10nm-s50nm.oir", "73c4160baf79043f301fe470cfa3832aaf17d789f99ab35b9b736d4af2ace67d", 14595535),
]
for rel, sha, size in OIR_FILES:
    dest = os.path.join(OUT, "Olympus-OIR", os.path.basename(rel))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not (os.path.exists(dest) and os.path.getsize(dest) == size):
        print(f"downloading Olympus-OIR/{rel} ({size/1e6:.0f} MB)", flush=True)
        urllib.request.urlretrieve(OIR + urllib.parse.quote(rel), dest + ".part")
        os.replace(dest + ".part", dest)
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != sha:
        print(f"CHECKSUM MISMATCH Olympus-OIR/{rel}", flush=True); os.remove(dest); continue
    print(f"ok Olympus-OIR/{rel}", flush=True)

# Nikon .nd2 from the OME sample image server (no published checksums: these pin the files the
# reader was tested with). Every folder used here has a COPYING file: CC BY 4.0, by the people named.
ND2 = "https://downloads.openmicroscopy.org/images/ND2/"
ND2_FILES = [
    # (path on the server, sha256, size)
    ("maxime/BF007.nd2", "e3f449796ac2ce82d5734a607d8899a3ec5a9a575161a3eded2e22eedc1dce92", 270336),  # Maxime Woringer: brightfield cell, 16-bit, LV metadata
    ("zenodo-12734440/HE_002.nd2", "d5d9b0b742cf8802ec26f32d405074020341c2384ae43807347fc707d3d542db", 17850368),  # George Campbell: H&E, RGB camera
    ("zenodo-17186598/Experiment_0001.nd2", "cdba1aa1625a9a93cd0ee00628400ef049a7034f90cd6a33161e502846e099aa", 49790976),  # Bob Golstein (as the readme spells it): DIC z-stack, 17 planes, padded rows
    ("jonas/header_test1.nd2", "ab054970ac2872e2616f6cde753512e66fa7057501eb881405ec5727c44a7f31", 30666752),  # Jonas Dorn: GFP + DIC, 3 planes x 7 times, XML metadata
    ("aryeh/b16_14_12.nd2", "0ec63250700580fa2777d342aa85c0175259e127580ecc760c39e2fd78f0634b", 24671709),  # Aryeh Weiss: legacy JPEG 2000 ND2, phase contrast, 50 time points
    ("zenodo-15046688/N1_file_bugged_reconstructed-version.nd2", "794f8716988e77c41dc3f16a490c7af77e942c263e3531986e459a99985d7768", 84156416),  # Louis Romette: 2D-SIM neurons, 5 named stage positions
]
for rel, sha, size in ND2_FILES:
    dest = os.path.join(OUT, "ND2", os.path.basename(rel))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if not (os.path.exists(dest) and os.path.getsize(dest) == size):
        print(f"downloading ND2/{rel} ({size/1e6:.0f} MB)", flush=True)
        urllib.request.urlretrieve(ND2 + urllib.parse.quote(rel), dest + ".part")
        os.replace(dest + ".part", dest)
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != sha:
        print(f"CHECKSUM MISMATCH ND2/{rel}", flush=True); os.remove(dest); continue
    print(f"ok ND2/{rel}", flush=True)
print("DONE", flush=True)
