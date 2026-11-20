---
title: Viewing a slide
blurb: Zoom and pan, the overview map, magnification, rotation, focal planes and snapshots.
order: 2
---

# Viewing a slide

## Zoom and pan

- **Zoom**: scroll the mouse wheel, or pinch on a trackpad. Zooming centres on the pointer, so point at what you want to see more closely. Double-click also zooms in (it can be turned off in Preferences).
- **Pan**: drag the slide with the **Pan** tool (**V**). With another tool chosen, you can still pan by dragging with the right mouse button or by scrolling with two fingers on a trackpad.
- **Whole slide**: press **H** or **0**, or choose **View ▸ Zoom to Fit** (**⌘0**), to see the whole slide again.

Tiles load as you move: a blurry patch sharpens a moment later. The first view of a slide on a network drive can take a few seconds.

## The overview map

The small map in a corner shows the whole slide, with a box around the part you're looking at. Click or drag in the map to jump there. Turn it off in **Preferences ▸ Viewer** if you want the space.

## Magnification and zoom presets

The zoom buttons over the slide jump to the magnifications you know from the microscope: **1.25×, 2.5×, 5×, 10×, 20×** and **40×**. The current magnification is shown next to them.

Magnification on a screen is an approximation. Slide Viewer uses the same rule as NDP.view2: **10× means 1 µm per screen pixel**, so 40× is 0.25 µm per pixel. A slide can't be zoomed past the resolution it was scanned at by much before it turns blocky; most course slides are scanned at 20× or 40×.

## Scale bar

The scale bar in the bottom corner always shows a round length (for example **100 µm** or **1 mm**) at the current zoom. Use it to judge sizes at a glance; for an exact length use the [ruler](measuring.md#the-ruler). If the slide has no size information, the bar shows pixels instead (see [Uncalibrated slides](measuring.md#uncalibrated-slides)).

## Rotate

Sections aren't always scanned the way up you'd like. Choose **View ▸ Rotate Left** or **View ▸ Rotate Right** to turn the view by 90°. Rotation only changes how you see the slide: pins, shapes and measurements stay where they are on the tissue, and the saved `.ndpa` file is unchanged. Opening another slide resets the rotation.

## Focal planes

Some slides are scanned at several focus depths (a *z-stack*), so you can focus up and down through a thick section as you would on a microscope. When the open slide has more than one plane, a focus slider appears at the side of the slide: drag it, or click its steps, to change plane. Pins and shapes stay on every plane.

Which slides have focal planes depends on the file format: Zeiss `.czi` files with z-stacks do. For other formats, only the main plane is shown and the slider stays hidden. See [File formats](file-formats.md).

## Snapshot

To save what you see as a picture (for notes or a report), choose **File ▸ Save Snapshot (PNG)…** (**⇧⌘S**, Ctrl+Shift+S). The snapshot is the current view with your adjustments applied, and includes your pins and shapes with their titles. Choose where to save it.

## Moving between slides

**]** or **→** opens the next slide in the browser list and **[** or **←** the previous one. Your annotations on the slide you leave are saved first. The search box in the browser limits which slides you step through.
