---
title: File formats
blurb: Which slide and image files open, and the files Slide Viewer writes.
order: 6
---

# File formats

## Slides

Every file is shown the same way: zoom and pan, pins and rulers, adjustments. Annotations are saved in NDP.view2's `.ndpa` format whatever the slide type.

| Format | Files | Notes |
| --- | --- | --- |
| Hamamatsu | `.ndpi`, `.vms`, `.vmu` | NDP.view2's own format. Pins line up exactly with NDP.view2. Z-stacks show every focal plane. |
| Aperio | `.svs` | |
| Generic tiled TIFF | `.tif`, `.tiff` | Whole-slide TIFFs, including pyramidal and OME-TIFF files written by most scanners. |
| Leica | `.scn` | Brightfield and fluorescence scans (Leica SCN400 and SCN400F). Fluorescence channels are combined in the colours saved in the file. The slide opens on the part of the glass that was scanned, not the whole slide. When several areas were scanned (for example four sections on one slide), they're shown together in their real places on the glass, with white where nothing was scanned. |
| 3DHISTECH MIRAX | `.mrxs` | Open the `.mrxs` file; its folder of data files must sit next to it with the same name. Like Leica files, it opens on the scanned part of the glass. |
| Ventana / Roche | `.bif` | Slides from Ventana iScan scanners and from the newer VENTANA DP 200 (which OpenSlide can't read; Slide Viewer stitches their tiles itself). When the scanner scanned more than one area of the glass, they're shown together in their real places, with white between them. |
| Philips | `.tiff` | |
| Sakura | `.svslide` | |
| Argos (PreciPoint) | `.avs` | Opens on the scanned areas, in their real places on the glass. For a z-stacked Argos file, only the middle focal plane is shown. |
| DICOM | `.dcm` (whole-slide) | Open any `.dcm` file of the series; the rest of the series must be in the same folder. |
| Zeiss | `.czi` | Brightfield and fluorescence (channels are coloured with the settings saved in the file). Z-stacks show every plane: see [Focal planes](viewing.md#focal-planes). Several scenes in one file are shown together. |
| Olympus | `.vsi` | cellSens and VS-series scanners, brightfield and fluorescence. Open the `.vsi` file; its data folder `_name_` (holding `stack…` folders) must sit next to it. Fluorescence channels are combined in the colour of their emission wavelength (DAPI blue, FITC green, Cy5 red, …), with the brightness range the scanner software saved. Z-stacks show every focal plane with its distance in µm. The low-magnification overview scan and the slide label are used where the file has them. |
| Zeiss AxioVision | `.zvi` | The older Zeiss format. Fluorescence channels are combined in the colours saved in the file, with brightness stretched so faint signals show. Z-stacks show every plane, and mosaics are assembled from their tiles. The first time a large mosaic opens it is prepared and kept in the app's cache. |
| Leica LAS X / LAS AF | `.lif` | Confocal project files, read by the app itself. A `.lif` file can hold many images; the largest one is shown (for a tile scan, the size of the whole mosaic counts). Channels are combined in the colours chosen in LAS X, each with its brightness stretched so faint signals show. Z-stacks show every plane with its distance in µm. Tile scans are assembled from their tiles at the stage positions saved in the file. For a time series, only the first time point is shown. Pictures kept outside the `.lif` file (LAS X's `.lifext` and `.lof` files) are not read. |
| Olympus FluoView | `.oir` | Confocal images from FluoView FV3000 and FV4000 microscopes. Channels are combined in the colours saved in the file (or the colour of their emission wavelength), with brightness stretched so faint signals show; a spectral (lambda) scan shows each wavelength band in its own colour. Z-stacks show every focal plane with its distance in µm. A time series shows every time point, labelled with its time since the start of the acquisition (for example `1 min 30 s`); each time point keeps the same brightness settings, so changes over time are real. A large acquisition saved in several files (`name.oir`, `name_00001`, …) opens from the `.oir` file when the other parts sit next to it. |
| Nikon NIS-Elements | `.nd2` | Microscope camera images: colour (for example H&E), brightfield, phase contrast, DIC and fluorescence, from NIS-Elements 3 and later and from older versions (JPEG 2000 files). Fluorescence channels are combined in the colour of their emission wavelength, with brightness stretched so faint signals show; brightfield, phase-contrast and DIC channels are shown in grey. Z-stacks show every focal plane with its distance in µm. For a time series or a multipoint experiment, only the first time point and the first stage position are shown. Large stitched images are prepared once and kept in the app's cache. |
| Ordinary pictures | `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`, flat `.tif` | Photos, screenshots and stitched images. Very large flat TIFFs are prepared once and kept in the app's cache, so the next time they open at once. Usually [uncalibrated](measuring.md#uncalibrated-slides). |

Slides are read with [OpenSlide](https://openslide.org) and, for Zeiss `.czi` files, [libCZI](https://github.com/ZEISS/libczi). Both are built into the app. Olympus `.vsi` and `.oir`, Leica `.lif`, Nikon `.nd2`, Zeiss `.zvi`, VENTANA DP 200 `.bif` and fluorescence Leica `.scn` slides are read by the app itself. The label, macro and thumbnail pictures a scanner saves are used where the file has them.

### Not supported

- **Leica `.scn` slides with scan areas at different magnifications** (for example a 5× and a 40× area on one slide): OpenSlide can't combine them, and Slide Viewer doesn't yet. The app says so rather than showing one area and hiding the rest.
- **Zeiss `.zvi` files with zlib-compressed planes** (rare; written by some AxioVision setups): no real file of this kind is publicly available to build and check a reader against (none in OpenSlide's test data or on the OME image server), so the app says they aren't supported. Convert them to OME-TIFF with QuPath or bfconvert.
- **Time series and multipoint experiments** (`.lif`, `.nd2`): only the first time point (and, for `.nd2`, the first stage position) is shown; there is no time slider yet. Nikon files with lossy-compressed frames (rare) don't open.
- **Other formats** (for example Bio-Formats-only ones): convert them to OME-TIFF with QuPath or bfconvert and open that.


### Scale and measurements

The ruler and scale bar need to know how big a pixel is.

- Slide scanner files (NDPI, SVS, CZI, …) always say, so measurements are in µm and mm.
- Pictures and TIFFs often don't. When the file stores a real microscope pixel size (TIFF resolution, ImageJ's *unit=micron*, a camera's EXIF or PNG density), it's used. Ordinary picture defaults such as 72 or 300 dpi are ignored.
- If the size isn't known, the slide is shown as **uncalibrated**: measurements are in pixels instead of µm.

### If a slide won't open

- **"CZI support is not installed"**: this copy of the app was built without the Zeiss reader. Other formats still work.
- **"Not a supported slide file"**: the file is damaged, still copying, or a format the viewer doesn't read. Open it in the scanner's own viewer to check it.

## Annotation files (.ndpa)

Annotations are saved as `<slide file name>.ndpa` next to the slide, for example `VMS104.ndpi.ndpa`. This is the XML format Hamamatsu NDP.view2 uses:

- One entry per pin or shape, with its title, details, colour and position.
- Positions are in nanometres, measured from the centre of the glass slide (NDP.view2's convention), so they're the same in every program that reads the file.
- Pins, rulers, freehand outlines, circles and rectangles are read and written. Anything else in a file (other annotation types, saved views, settings written by NDP.view2) is kept exactly as it was when Slide Viewer saves.
- Each save keeps the previous version as `.ndpa.bak`.

See [Where annotations are saved](annotating.md#where-annotations-are-saved) for the read-only-folder case and **Export Annotations (.ndpa)…**.

## Other files the app makes

- **Thumbnails** for the slide browser are kept in the app's cache folder, never next to your slides. Deleting them is safe; they're made again.
- **Prepared pyramids** of very large plain TIFF and picture files, Zeiss `.zvi` mosaics very large Olympus `.oir` images and large Nikon `.nd2` images are kept in the app's cache folder too (the six most recent), so they reopen instantly.
- **Snapshots** are PNG pictures, saved where you choose.
