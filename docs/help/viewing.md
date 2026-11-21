---
title: Viewing a slide
blurb: Zoom and pan, the toolbar, the overview map, magnification, rotation, focal planes and snapshots.
order: 2
---

# Viewing a slide

Pick a slide in the [slide browser](browser.md) on the left and it opens in the middle of the window.

## Zoom and pan

- **Zoom**: scroll the mouse wheel, or pinch on a trackpad. Zooming centres on the pointer, so point at what you want to see more closely. Double-click also zooms in (turn that off in **Preferences ▸ Viewing**).
- **Pan**: drag the slide with the **Pan** tool (**V**). With another tool chosen, you can still pan by dragging with the right mouse button or by scrolling with two fingers on a trackpad. **⇧** with an arrow key pans a quarter of a screen.
- **Whole slide**: press **H** or **0**, or choose **View ▸ Zoom to Fit** (**⌘0**), to see the whole slide again.

Tiles load as you move: a blurry patch sharpens a moment later. The first view of a slide on a network drive can take a few seconds.

## The toolbar

The tool bar is off by default: right-click the slide instead (see [Pins and shapes](annotating.md#the-right-click-menu)). Turn it on in **Preferences ▸ Viewing ▸ tool bar** to get this pill at the bottom of the slide:

| Button | Key | What it does |
| --- | --- | --- |
| Pan | **V** | Drag to move around. Clicking an annotation selects it. |
| Pin | **P** | Click to drop a named pin. |
| Ruler | **R** | Drag to measure. |
| Freehand | **F** | Draw an outline. |
| Circle | **C** | Drag out a circle. |
| Rectangle | **B** | Drag out a rectangle. |
| Undo / Redo | **⌘Z** / **⌘⇧Z** | Undo or redo the last annotation change. |
| Rotate | **,** / **.** | Turn the view 90° left or right. |
| Zoom | **−** / **0** / **+** | Zoom out, fit the whole slide, zoom in. |
| Camera | **⇧S** | Save the view as a PNG (see [Snapshot](#snapshot)). |

**Esc** cancels a drawing, then clears the selection, then returns to Pan. **Delete** removes the selected annotations. See [Pins and shapes](annotating.md) for the drawing tools.

## The overview map

The card in the top-left corner shows the whole slide, turned the same way as your view. The blue box is what you can see. **Click** or **drag** on the map to move there; **scroll** on it to zoom. Pins show as small dots. Press **M** to hide or show it (or use **Preferences ▸ Viewing**).

**Move** the map by dragging its top edge (a grip appears when you hover), and **resize** it by dragging its bottom-right corner. Double-click either to put it back. **Preferences ▸ Viewing ▸ Overview map size** does the same with a slider, and **Reset Map** puts it back in the top-left corner.

## Magnification and zoom presets

Right-click the slide and hover **Zoom** to fit the slide, zoom in or out, or jump to **1.25×, 2.5×, 5×, 10×, 20×** or **40×**, the magnifications you know from the microscope. The current one is ticked.

To keep these as buttons in the top-right corner with a live magnification readout, turn on **Preferences ▸ Viewing ▸ zoom bar**.

Magnification on a screen is an approximation. Slide Viewer uses the same rule as NDP.view2: **10× means 1 µm per screen pixel**, so 40× is 0.25 µm per pixel.

A slide scanned with a 20× objective has no more detail than 20×. Presets above the scan's own magnification are shown dimmer: they only enlarge the pixels (digital zoom). Presets the slide can't reach are hidden. Hover the readout to see the scan's magnification and pixel size.

Images without a pixel size (plain JPEG or PNG files, some TIFFs) are marked **uncalibrated**. For those, the presets are percentages of the image's own pixels (100% = one image pixel per screen pixel). See [Uncalibrated slides](measuring.md#uncalibrated-slides).

## Scale bar

The bar in the bottom-left corner (move it to any corner in **Preferences ▸ Viewing ▸ Scale bar position**) shows a round length (1, 2 or 5 × 10ⁿ µm or mm, for example **100 µm** or **1 mm**) and follows the zoom as you move. Use it to judge sizes at a glance; for an exact length use the [ruler](measuring.md#the-ruler). On an uncalibrated image it shows pixels.

## Rotate

Sections aren't always scanned the way up you'd like. Rotating only turns your view: the slide and your annotations keep their coordinates, so pins placed while rotated open in the right place in NDP.view2 and in your instructor's grading tools.

- **,** and **.** (or the toolbar's arrow buttons, or **View ▸ Rotate Left / Right**) turn 90°.
- **⇧,** and **⇧.**, or **Shift-click** on the arrow buttons, turn by a small step (15° by default; change it in **Preferences ▸ Viewing**).
- Click the **angle** between the arrows for a slider that turns the view freely, and **Reset** to go back to 0°.

## Focal planes

Some slides are scanned at several focus depths (a *z-stack*), so you can focus up and down through a thick section as you would with the fine-focus knob. Hamamatsu `.ndpi`, Zeiss `.czi` and `.zvi`, Olympus `.vsi` and `.oir`, Leica `.lif` and Nikon `.nd2` z-stacks are supported. When the open slide has more than one plane, a slider appears on the right edge of the slide. Drag it, click ▲ / ▼, or press **Page Up** / **Page Down**. The slide opens at the in-focus plane (0 µm). The new plane fades in over the old one, so the view never goes blank. Pins and shapes belong to the slide, not to a plane, so they stay where they are.

Slides with a single plane don't show the slider.

## Time series and multi-image files

Microscope files (Leica `.lif`, Olympus `.oir`, Nikon `.nd2`) can hold more than one picture. A bar appears at the bottom of the slide when the open file needs it; ordinary slides never show it.

- **Time series** (a recording over time): drag the time slider, click ◀ / ▶▏, or press **T** for the next time point and **⇧T** for the previous one. **▶** plays the series in a loop and **❚❚** pauses it. The time since the start is shown when the file records it (otherwise *T 1*, *T 2*, …). Focus, zoom and adjustments stay as they are while you step through time.
- **Several images or positions**: a Leica `.lif` can hold several images, and a Nikon `.nd2` can be recorded at several stage positions. Pick one from the **Image** or **Position** list. The file opens at its largest image (or first position).

Pins and shapes belong to the file, not to one time point or image, so they stay where they are when you switch.

## Snapshot

To save what you see as a picture (for notes or a report), press **⇧⌘S** or **⇧S**, click the camera button, or choose **File ▸ Save Snapshot (PNG)…**.

- **Resolution**: 1×, 2× or 4× the size of the view on screen. The picture is rendered fresh from the slide, so 2× and 4× are sharper, not just bigger.
- **Annotations**: draw your pins and shapes, with their titles, on the picture.
- **Scale bar**: burn a scale bar into the bottom-left corner.
- **Title**: a title in the top-left corner (the slide name by default), with the magnification.

The picture uses your current [adjustments](adjustments-and-stains.md) and rotation. Choose where to save it in the dialog that follows.

## Moving between slides

**]** or **→** opens the next slide in the browser list and **[** or **←** the previous one (while the [keyboard cursor](accessibility.md#keyboard-only) is on, the arrows pan the slide and only **[** and **]** change slides). Your annotations on the slide you leave are saved first. When you're searching in the browser, these keys step only through the matches. The app tells you when you reach the first or last slide.

## Keyboard

| Key | Action |
| --- | --- |
| **[** / **]** or **←** / **→** | Previous / next slide (with the keyboard cursor on, the arrows pan instead) |
| **X** | Keyboard cursor on / off (see [Keyboard only](accessibility.md#keyboard-only)) |
| **⇧←** **⇧→** **⇧↑** **⇧↓** | Pan a quarter screen |
| **+** / **−** | Zoom in / out |
| **0**, **H** or **⌘0** | Fit the whole slide |
| **,** / **.** | Rotate 90° left / right |
| **⇧,** / **⇧.** | Rotate by the small step |
| **Page Up** / **Page Down** | Focal plane up / down |
| **T** / **⇧T** | Next / previous time point (time series) |
| **⇧S** or **⇧⌘S** | Save a snapshot |
