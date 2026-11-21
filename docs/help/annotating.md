---
title: Pins and shapes
blurb: Place named pins, draw shapes, edit them, and hand in exam answers.
order: 3
---

# Pins and shapes

Annotations are pins and shapes you place on a slide, each with a title you choose. They're saved automatically in an `.ndpa` file next to the slide, the same file NDP.view2 writes. Use them for exam answers and for your own study notes.

## The right-click menu

**Right-click** anywhere on the slide to place an annotation there:

- **Add pin here ▸** and **Add flag here ▸**: pick a colour and the pin (or flag) drops exactly where you right-clicked. Type its title and press **↵**.
- **Measure (ruler)**, **Draw freehand outline**, **Draw circle**, **Draw rectangle**: draw one shape, then you're back to panning. **Esc** cancels.
- **Zoom ▸**: fit the slide, zoom in or out, or jump to a magnification (1.25× … 40×).
- **Rotate ▸**, **Undo**, **Redo** and **Save view as PNG…**

Right-click a pin or shape for its own menu: **Rename**, **Style ▸** (pin or flag), **Colour ▸** and **Delete**.

Pins and flags are the two pin icons NDP.view2 uses, and both open there unchanged.

## The tools

The keys below pick a tool directly. For buttons, turn on the tool bar in **Preferences ▸ Viewing ▸ tool bar**; it then sits at the bottom of the slide.

| Tool | Key | How to use it |
| --- | --- | --- |
| **Pan** | V | Drag to move around. Click a pin or shape to select it. |
| **Pin** | P | Click to place a pin, type its title, and press **↵**. Dragging still pans. |
| **Ruler** | R | Drag from one end to the other. The length shows as you drag. Let go to keep it, or press **Esc** to cancel. See [Measuring](measuring.md#the-ruler). |
| **Freehand** | F | Drag to draw around a structure; let go to close the outline. Or click point by point, then double-click (or press **↵**, or click the first point) to close it. **⌫** removes the last point. |
| **Circle** | C | Drag from the centre outwards. |
| **Rectangle** | B | Drag from one corner to the opposite corner. |

The scroll wheel zooms with every tool. **Esc** cancels a shape you're drawing; press it again to clear the selection, and once more to go back to **Pan**.

No mouse? Press **X** for the keyboard cursor, then **P** places a pin and **Space** sets the points of a ruler or shape. See [Keyboard only](accessibility.md#keyboard-only).

## Place a pin

1. Press **P** (or click the pin tool).
2. Click exactly on the structure. The pin's point is its tip.
3. Type a title and press **↵**. The title can be anything: *Q3*, *eccrine sweat gland*, *ask about this*.

Titles show next to the pins on the slide; turn them off in **Preferences ▸ Pins & shapes** if they get in the way.

## Edit, rename and delete

- **Select**: click a pin or shape with the Pan tool, or click its row in the **Annotations** tab of the right panel. Clicking a row also moves the view to it. **⇧-click** selects several.
- **Rename**: double-click the pin, or its row in the list, or select it and press **↵**. Type the new title and press **↵** (**Esc** keeps the old one).
- **Move**: drag a pin, or the outline of a shape. Once a shape is selected you can also drag it from the inside.
- **Reshape**: select it, then drag the white squares: the ends of a ruler, the corners of a rectangle, the points of an outline, or the square on a circle's edge for its size.
- **Colour**: right-click it, or click the colour dot in the list. New pins use the colour in **Preferences ▸ Pins & shapes**, green by default. NDP.view2 has a fixed set of pin colours, so a pin's colour is matched to the nearest one of those.
- **Delete**: select it and press **Delete** (or **⌫**), or right-click it and choose **Delete**.
- **Undo** with **⌘Z** and **redo** with **⇧⌘Z** (Ctrl+Z and Ctrl+Y on Windows). Undo works for placing, moving, reshaping, renaming and deleting.

### The annotation list

The **Annotations** tab in the right-hand panel lists everything on the slide, with each ruler's length.

- Click a row to select it and go to it on the slide.
- The eye hides it from view. That isn't saved, and NDP.view2 still shows it.
- The selected row has a **Notes** box, saved with the annotation. NDP.view2 shows these as the annotation's details.
- If two annotations have the same title, a warning appears. That's fine for notes, but for an exam each question should have one pin.

## Exam answers

For a practical exam, your instructor asks you to put pins on particular structures and hand in your annotation files. Slide Viewer writes the same files as NDP.view2, and they're graded the same way.

1. **Name each pin the way your instructor asks.** Usually that's the question number: `1`, `Q1` or `Question 1`. Use exactly what the exam says. One pin per question unless you're told otherwise.
2. **Put the tip on the structure.** It's the tip that counts, not the head of the pin.
3. **Check the list.** The Annotations tab lists every pin on the slide with its title. If two pins on one slide have the same title, the list warns you: that's allowed, but usually a mistake in an exam.
4. **Hand in the `.ndpa` file** for each slide you answered on. It's next to the slide and named after it: answers on `VMS104.ndpi` are in `VMS104.ndpi.ndpa`. Upload that file as your instructor asks. Don't rename it: the name tells the grader which slide it's for.

If you can't find the file (for example because the slides folder is read-only and the app saved it elsewhere), use **File ▸ Export Annotations (.ndpa)…** (**⌘E**) and save a copy wherever you like. See [Where annotations are saved](#where-annotations-are-saved).

## Where annotations are saved

There's no Save button. A second after each change, the annotations for the slide are written to `<slide file name>.ndpa` in the same folder as the slide, for example `VMS104.ndpi.ndpa`. Switching slides or closing the app saves straight away. The panel shows **Saving…** and then **Saved**.

- Each save keeps the previous version next to it as `VMS104.ndpi.ndpa.bak`, in case you need to go back.
- If the slide's folder can't be written to (a read-only course drive, for example), the file goes to the app's own data folder instead and the panel says so. Use **Export Annotations (.ndpa)…** to get a copy.
- If an `.ndpa` file can't be read, the panel says so, and the app won't overwrite it.
- An `.ndpa` file you were given (by your instructor, or saved from NDP.view2) opens with the slide automatically when it has the matching name. Everything in it is shown, and anything Slide Viewer doesn't understand is kept unchanged when it saves.

## Working with NDP.view2

Files go both ways. NDP.view2 opens annotations made here, and Slide Viewer opens annotations made in NDP.view2: pins, rulers, freehand outlines, circles and rectangles. Open freehand lines and arrows from NDP.view2 are shown too; arrows can be renamed, recoloured and deleted but not moved. Positions are stored in nanometres from the centre of the glass slide, as NDP.view2 does, so a pin lands on the same cell in both programs.
