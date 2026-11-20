---
title: Pins, rulers and shapes
blurb: Place named pins, measure, draw outlines, and how they're saved for NDP.view2 and your instructor.
order: 3
---

# Pins, rulers and shapes

Pins mark a spot and give it a name. Use them for exam answers (titles like *Q1* or *Question 3*) or for your own study notes. Rulers measure, and shapes outline an area. Everything is saved automatically, in the same `.ndpa` format that Hamamatsu NDP.view2 uses.

## Tools

Choose a tool in the toolbar at the bottom of the slide, or press its key.

| Tool | Key | How |
|---|---|---|
| Pan | **V** | Drag to move around. Click a pin or shape to select it. |
| Pin | **P** | Click to place a pin, type its title, and press **↵**. Dragging still pans. |
| Ruler | **R** | Drag from one end to the other. The length shows as you drag (µm or mm). Let go to keep it, or press **Esc** to cancel. |
| Freehand | **F** | Drag to draw an outline. Or click point by point, then double-click (or press **↵**, or click the first point) to close it. **⌫** removes the last point. |
| Circle | **C** | Drag out from the centre. |
| Rectangle | **B** | Drag from corner to corner. |

The scroll wheel zooms with every tool. **Esc** cancels a drawing; press it again to clear the selection, and once more to go back to Pan.

Shapes show their size: the length of a ruler, and the area of an outline, circle or rectangle. On a slide with no pixel size (marked *uncalibrated* in the title bar), measurements are in pixels.

## Change a pin or shape

- **Rename:** double-click it (on the slide or in the list), or select it and press **↵**.
- **Move:** drag a pin, or the outline of a shape. Once a shape is selected you can also drag it from the inside.
- **Reshape:** select it, then drag the white squares: the ends of a ruler, the corners of a rectangle, the points of an outline, or the square on a circle's edge for its size.
- **Colour:** right-click it, or click the colour dot in the list. Pins come in NDP.view's pin colours.
- **Delete:** select it and press **⌫** or **Delete**, or right-click ▸ **Delete**. ⇧-click selects several.
- **Undo / redo:** **⌘Z** and **⌘⇧Z**.

## The annotation list

The **Annotations** tab in the right-hand panel lists everything on the slide.

- Click a row to select it and go to it on the slide.
- The eye hides it from view. That isn't saved, and NDP.view still shows it.
- The selected row has a **Notes** box, saved with the annotation. NDP.view shows these as the annotation's details.
- If two annotations have the same title, a warning appears. That's fine for notes, but for an exam each question should have one pin.

## Saving

Annotations save by themselves about a second after each change. They go in a file next to the slide named after it, for example `VMS104.ndpi.ndpa`. The previous version is kept as `VMS104.ndpi.ndpa.bak`.

- If the slide's folder is read-only (a shared drive, for example), they're saved in the app's own data folder instead and the panel says so. Use **Export .ndpa…** to put a copy where you need it.
- **Export .ndpa…** (in the panel, or **⌘E**) saves a copy anywhere, for example to hand in.
- Files from NDP.view2 open here, and anything this app doesn't understand in them is kept unchanged when it saves.
- Files saved here open in NDP.view2, and Micro Speed Grader reads the pin titles and positions for grading.
- If a `.ndpa` file can't be read, the panel says so, and the app won't overwrite it.
