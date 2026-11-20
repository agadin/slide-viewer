---
title: Pins and shapes
blurb: Place named pins, draw shapes, edit them, and hand in exam answers.
order: 3
---

# Pins and shapes

Annotations are pins and shapes you place on a slide, each with a title you choose. They're saved automatically in an `.ndpa` file next to the slide, the same file NDP.view2 writes. Use them for exam answers and for your own study notes.

## The tools

Choose a tool from the toolbar at the bottom of the slide, or press its key:

| Tool | Key | How to use it |
| --- | --- | --- |
| **Pan** | V | Drag to move around. Click a pin or shape to select it. |
| **Pin** | P | Click to place a pin, then type its title. |
| **Ruler** | R | Drag from one end to the other. See [Measuring](measuring.md#the-ruler). |
| **Freehand** | F | Drag to draw around a structure; let go to close the outline. |
| **Circle** | C | Drag from the centre outwards. |
| **Rectangle** | B | Drag from one corner to the opposite corner. |

**Esc** cancels a shape you're drawing and goes back to **Pan**.

## Place a pin

1. Press **P** (or click the pin tool).
2. Click exactly on the structure. The pin's point is its tip.
3. Type a title and press **↵**. The title can be anything: *Q3*, *eccrine sweat gland*, *ask about this*.

Titles show next to the pins on the slide; turn them off in **Preferences ▸ Annotations** if they get in the way.

## Edit, rename and delete

- **Select**: click a pin or shape with the Pan tool, or click its row in the **Annotations** tab of the right panel. Clicking a row also moves the view to it.
- **Rename**: double-click the pin, or its row in the list, or select it and press **↵**. Type the new title and press **↵** (**Esc** keeps the old one).
- **Notes**: the list has a details field for each annotation if you want to write more than a title. NDP.view2 shows it as the annotation's details.
- **Colour**: choose a colour for the selection from its menu (right-click it). New pins use the colour in **Preferences ▸ Annotations**, green by default. NDP.view2 has a fixed set of pin colours, so a pin's colour is matched to the nearest one of those.
- **Delete**: select it and press **Delete** (or **⌫**), or right-click it and choose **Delete**.
- **Undo** with **⌘Z** and **redo** with **⇧⌘Z** (Ctrl+Z and Ctrl+Y on Windows). Undo works for placing, moving, renaming and deleting.

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
- An `.ndpa` file you were given (by your instructor, or saved from NDP.view2) opens with the slide automatically when it has the matching name. Everything in it is shown, and anything Slide Viewer doesn't understand is kept unchanged when it saves.

## Working with NDP.view2

Files go both ways. NDP.view2 opens annotations made here, and Slide Viewer opens annotations made in NDP.view2: pins, rulers, freehand outlines, circles and rectangles. Positions are stored in nanometres from the centre of the glass slide, as NDP.view2 does, so a pin lands on the same cell in both programs.
