---
title: Slide formats
blurb: Which files open, how the scale is known, and focal planes.
order: 8
---

# Slide formats

Slide Viewer opens whole-slide scans and ordinary pictures. Every file is shown the same way: zoom and pan, pins and rulers, filters. Annotations are saved in NDP.view's `.ndpa` format whatever the slide type.

| Files | Notes |
|---|---|
| **.ndpi** (Hamamatsu) | Label and macro images. Z-stacks show every focal plane. |
| **.svs .scn .mrxs .vms .vmu .bif .svslide**, tiled **.tif/.tiff**, DICOM | Read with OpenSlide, with label, macro and thumbnail images where the scanner saved them. |
| **.czi** (Zeiss) | Brightfield and fluorescence. Fluorescence channels are coloured with the settings saved in the file. Z-stacks show every plane. Label, slide preview and thumbnail images are included. |
| **.jpg .jpeg .png .bmp .webp**, flat **.tif/.tiff** | Pictures and stitched images. Very large flat TIFFs are prepared once and kept in the app's cache, so the next time they open at once. |

`.vsi` (Olympus) files don't open yet.

## Scale and measurements

The ruler and scale bar need to know how big a pixel is.

- Slide scanner files (NDPI, SVS, CZI, …) always say, so measurements are in µm and mm.
- Pictures and TIFFs often don't. When the file stores a real microscope pixel size (TIFF resolution, ImageJ's *unit=micron*, a camera's EXIF or PNG density), it's used. Ordinary picture defaults such as 72 or 300 dpi are ignored.
- If the size isn't known, the slide is shown as **uncalibrated**: measurements are in pixels instead of µm.

## Focal planes

Some slides are scanned at several focus depths (a *z-stack*). For those slides a focus slider appears in the viewer. The slide opens at the in-focus plane (0 µm). Move the slider to focus up or down through the tissue, as you would with the fine-focus knob. Annotations belong to the slide, not to a plane, so your pins stay where they are when you change focus.

## If a slide won't open

- **"CZI support is not installed"**: this copy of the app was built without the Zeiss reader. Other formats still work.
- **"Not a supported slide file"**: the file is damaged, still copying, or a format the viewer doesn't read. Open it in the scanner's own viewer to check it.
