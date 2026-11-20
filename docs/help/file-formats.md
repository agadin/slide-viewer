---
title: File formats
blurb: Which slide and image files open, and the files Slide Viewer writes.
order: 6
---

# File formats

## Slides

| Format | Files | Notes |
| --- | --- | --- |
| Hamamatsu | `.ndpi`, `.vms`, `.vmu` | NDP.view2's own format. Pins line up exactly with NDP.view2. |
| Aperio | `.svs` | |
| Generic tiled TIFF | `.tif`, `.tiff` | Whole-slide TIFFs, including pyramidal and OME-TIFF files written by most scanners. |
| Leica | `.scn` | |
| 3DHISTECH MIRAX | `.mrxs` | Open the `.mrxs` file; its folder of data files must sit next to it with the same name. |
| Ventana / Roche | `.bif` | |
| Philips | `.tiff` | |
| Sakura | `.svslide` | |
| DICOM | `.dcm` (whole-slide) | Open any `.dcm` file of the series; the rest of the series must be in the same folder. |
| Zeiss | `.czi` | Including z-stacks: see [Focal planes](viewing.md#focal-planes). |
| Ordinary pictures | `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`, flat `.tif` | Photos and screenshots. Usually [uncalibrated](measuring.md#uncalibrated-slides). |

Slides are read with [OpenSlide](https://openslide.org) and, for Zeiss files, [libCZI](https://github.com/ZEISS/libczi). Both are built into the app.

**Not yet supported:** Olympus `.vsi`. Convert it to OME-TIFF (for example with QuPath or bfconvert) and open that.

## Annotation files (.ndpa)

Annotations are saved as `<slide file name>.ndpa` next to the slide, for example `VMS104.ndpi.ndpa`. This is the XML format Hamamatsu NDP.view2 uses:

- One entry per pin or shape, with its title, details, colour and position.
- Positions are in nanometres, measured from the centre of the glass slide (NDP.view2's convention), so they're the same in every program that reads the file.
- Pins, rulers, freehand outlines, circles and rectangles are read and written. Anything else in a file (other annotation types, saved views, settings written by NDP.view2) is kept exactly as it was when Slide Viewer saves.
- Each save keeps the previous version as `.ndpa.bak`.

See [Where annotations are saved](annotating.md#where-annotations-are-saved) for the read-only-folder case and **Export Annotations (.ndpa)…**.

## Other files the app makes

- **Thumbnails** for the slide browser are kept in the app's cache folder, never next to your slides. Deleting them is safe; they're made again.
- **Snapshots** are PNG pictures, saved where you choose.
