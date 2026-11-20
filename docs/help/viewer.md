---
title: Viewing slides
blurb: Zoom, pan, rotate, the overview map, scale bar, magnification presets, focal planes and snapshots.
order: 2
---

# Viewing slides

Pick a slide in the browser on the left and it opens in the middle of the window. Scroll to zoom,
drag to pan. Double-click zooms in (turn that off in [Preferences ▸ Viewing](preferences.md)).

## The toolbar

The pill at the bottom of the slide holds the tools and view controls.

| Button | Key | What it does |
|---|---|---|
| Pan | **V** | Drag to move around. Clicking an annotation selects it. |
| Pin | **P** | Click to drop a named pin. |
| Ruler | **R** | Drag to measure. |
| Freehand | **F** | Draw an outline. |
| Circle | **C** | Drag out a circle. |
| Rectangle | **B** | Drag out a rectangle. |
| Undo / Redo | **⌘Z** / **⌘⇧Z** | Undo or redo the last annotation change. |
| Rotate | **,** / **.** | Turn the view 90° left or right. |
| Zoom | **−** / **0** / **+** | Zoom out, fit the whole slide, zoom in. |
| Camera | **⇧S** | Save the view as a PNG (see below). |

**Esc** returns to Pan; press it again to clear the selection. **Delete** removes the selected annotations.

## Rotation

Rotating only turns your view. The slide and your annotations keep their coordinates, so pins saved while
rotated still open in the right place in NDP.view2 and Micro Speed Grader.

- **,** and **.** turn 90° (the toolbar's arrow buttons do the same).
- **⇧,** and **⇧.**, or **Shift-click** the arrow buttons, turn by a small step (15° by default; change it in
  Preferences ▸ Viewing).
- Click the **angle** between the arrows for a slider that turns the view freely, and **Reset** to go back to 0°.

## Overview map

The card in the top-left corner shows the whole slide, turned the same way as your view. The orange box
is what you can see. **Click** or **drag** on the map to move there; **scroll** on it to zoom. Annotation
pins show as small dots. Hide it in Preferences ▸ Viewing.

## Magnification and zoom presets

The card in the top-right shows the current magnification and buttons for **Fit, 1.25×, 2.5×, 5×, 10×, 20×
and 40×**. Magnification here means what a microscope objective would show: 10× is 1 µm per screen pixel,
40× is 0.25 µm.

A slide scanned with a 20× objective has no more detail than 20×. Presets above the scan's own
magnification are shown dimmer: they enlarge the pixels (digital zoom). Presets the slide can't reach
are hidden. Hover the readout to see the scan's magnification and pixel size.

Images without a pixel size (plain JPEG or PNG files, some TIFFs) are marked **uncalibrated** in the
title bar. For those, the presets are percentages of the image's own pixels (100% = one image pixel per
screen pixel) and lengths are in pixels.

## Scale bar

The bar in the bottom-left corner shows a round length (1, 2 or 5 × 10ⁿ µm or mm) at the current zoom. It
follows zoom live. For uncalibrated images it shows pixels.

## Keyboard

| Key | Action |
|---|---|
| **[** / **]** or **←** / **→** | Previous / next slide in the folder |
| **⇧←** **⇧→** **⇧↑** **⇧↓** | Pan a quarter screen |
| **+** / **−** | Zoom in / out |
| **0**, **H** or **⌘0** | Fit the whole slide |
| **,** / **.** | Rotate 90° left / right |
| **⇧,** / **⇧.** | Rotate by the free step |
| **Page Up** / **Page Down** | Focal plane up / down (z-stacks) |
| **⇧S** or **⌘⇧S** | Save a snapshot |

## Focal planes (z-stacks)

Some slides are scanned at several focus depths. For those, a slider appears on the right edge of the
slide. Drag it, click ▲ / ▼, or press **Page Up** / **Page Down** to focus up and down. The new plane fades
in over the old one, so the view never goes blank. Slides with a single plane don't show the slider.

## Snapshots

Press **⌘⇧S** or **⇧S** (or the camera button, or **File ▸ Save Snapshot (PNG)…**) to save what you see as a PNG.

- **Resolution**: 1×, 2× or 4× the size of the view on screen. The picture is rendered fresh from the slide,
  so 2× and 4× are sharper, not just bigger.
- **Annotations**: draw your pins and shapes on the picture.
- **Scale bar**: burn a scale bar into the bottom-left corner.
- **Title**: a title in the top-left corner (the slide name by default), with the magnification.

The picture uses your current adjustments (gamma, colour, stain) and rotation. Choose where to save it in
the dialog that follows.
