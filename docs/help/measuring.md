---
title: Measuring
blurb: The ruler, the scale bar, and slides without size information.
order: 4
---

# Measuring

## The ruler

1. Press **R** (or click the ruler in the toolbar).
2. Drag from one end of what you're measuring to the other. The length shows on the line as you drag, in µm, or in mm once it's longer than 1 mm.
3. Let go. The ruler stays on the slide as an annotation, listed in the Annotations tab with its length, and it's saved in the `.ndpa` file (NDP.view2 shows it as a ruler too).

Press **Esc** while dragging to cancel. Delete a ruler you no longer want like any other annotation: select it and press **Delete**.

Measurements are as accurate as the slide's scan resolution: about 0.25 µm at 40× and 0.5 µm at 20×. Zoom in before you measure something small, so you can place both ends precisely.

## Sizes of shapes

Circles, rectangles and freehand outlines are measured too: select one to see its size (diameter or width and height) and the area it encloses in the Annotations tab.

## Scale bar

The scale bar over the slide shows a round length at the current zoom. See [Scale bar](viewing.md#scale-bar).

## Uncalibrated slides

Whole-slide scans record how big a pixel is, so lengths come out in µm. Ordinary pictures (`.jpg`, `.png` and most plain `.tif` files) usually don't. When the app can't find the pixel size, the top bar shows **uncalibrated**, and the ruler, shape sizes and scale bar show **px** (pixels) instead of µm. Lengths in pixels are still fine for comparing two things on the same image.
