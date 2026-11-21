---
title: Accessibility
blurb: Keyboard-only use, screen readers, larger text, high contrast and colour-blind-safe pins.
order: 9
---

# Accessibility

Slide Viewer can be used with the keyboard alone, works with VoiceOver on a Mac and NVDA on Windows, and has settings for larger text, higher contrast, less motion and colour-blind-safe pins. This page explains how. If something gets in your way, tell your instructor, especially before an exam.

## Keyboard only

Everything you can do with the mouse also works from the keyboard. **Tab** moves between the parts of the window: the top bar, the slide browser, the slide, and the panel on the right. **⇧Tab** moves back. Nothing keeps the focus: **Tab** always moves on, and **Esc** closes any menu or dialog.

**Open a folder and a slide.** Press **⌘O** (Ctrl+O on Windows), or Tab to **Choose Folder…** and press **↵**. In the slide list, **↑** and **↓** move, **→** and **←** open and close folders, and **↵** opens a slide. See [Browsing a folder of slides](browser.md#keyboard).

**Move around the slide.** Tab to the slide. Then **+** and **−** zoom, **H** fits the whole slide, **,** and **.** rotate, **Page Up** and **Page Down** change the focal plane, and **[** and **]** go to the previous or next slide.

**Use the keyboard cursor.** Press **X** (or **↵** on the slide) to show a cross-hair in the middle of the view. The arrow keys now move the slide under the cross-hair, a tenth of the view at a time (**⇧** + arrow moves a quarter). Whatever you do next happens at the cross-hair:

- **Place a pin**: press **P** (or **⇧P** for a flag), type the title and press **↵**.
- **Measure**: press **R**, then **Space** on the first end, move with the arrows, and **Space** on the second end. **C** (circle: centre, then edge) and **B** (rectangle: corner to corner) work the same way. The shape follows the cross-hair until you press **Space** the second time.
- **Outline**: press **F**, then **Space** for each point. **⇧↵**, or **Space** back on the first point, closes the outline. **⌫** removes the last point.
- **Select**: with the Pan tool (**V**), **Space** selects what's under the cross-hair and **↵** opens the right-click menu there.
- **Esc** cancels a drawing, then clears the selection, then goes back to the Pan tool, and finally hides the cross-hair.

**Work with pins and shapes.** **N** selects the next annotation and moves the view to it, and **⇧N** the previous one. **F2** renames the selection. **⌥** + arrow moves it a little (**⌥⇧** + arrow moves it further). **⇧F10**, or the Menu key on a Windows keyboard, opens its menu: style, colour, rename and delete. In the annotation list on the right, Tab to a row and press **↵** to select it or **F2** to rename it.

**Menus.** **↑** and **↓** move, **Home** and **End** jump to the ends, and typing a letter jumps to the next item that starts with it. **→** opens a submenu (pin colours, for example) and **←** closes it. **↵** or **Space** chooses.

**Adjustments.** Tab to the **Adjust** tab in the panel on the right (**←** and **→** switch tabs). Each slider moves with the arrow keys, and the number box next to it takes a typed value.

**Snapshot.** Press **⇧S**. The dialog takes the focus; Tab to **Save** and press **↵**. When a dialog or menu closes, the focus goes back to where you were.

The full list is in [Keyboard shortcuts](shortcuts.md#keyboard-cursor).

## Screen readers

The app is labelled for screen readers, and it tells you what's happening: when a slide opens (its name, number of annotations, the stain and the magnification), when you add, rename, move or delete a pin or shape, when you undo, and when you zoom, rotate or change the focal plane. Save errors are read straight away.

- The window has landmarks: the **slide browser** (a tree of folders and slides), the **slide**, and the **image panel** with its two tabs, Annotations and Adjust.
- The **annotation list** reads each pin or shape as its title, kind, measurement, colour and position in the list, for example "Q1, Pin, green, 2 of 5". This is the quickest way to review your exam answers.
- The **slide** is announced as a "slide viewer" with its name, size, calibration and current magnification. Single-letter keys go straight to the app while you are on it.

**VoiceOver (macOS).** Turn on VoiceOver with **⌘F5**. Use **VO** + arrow keys to move through the window, or Tab between controls. On the slide, turn off Quick Nav (press **←** and **→** together) so the arrow keys pan the slide instead of moving VoiceOver.

**NVDA (Windows).** NVDA switches to focus mode by itself when you Tab to the slide, so the single-letter keys reach the app. If a key seems to do nothing, press **NVDA+Space** to switch to focus mode. In the slide browser and the menus, use the arrow keys as described above.

**Preferences and Help** open in their own windows. Switch to them as you would to any window (**⌘\`** on a Mac, Alt+Tab on Windows).

## Accessibility preferences

Open **Preferences ▸ Accessibility** (**⌘,**).

| Setting | What it does |
| --- | --- |
| Text size | Makes the text in menus, panels and Preferences 115 %, 130 %, 150 %, 175 % or 200 % of normal. The slide itself isn't changed: zoom it instead. |
| High contrast | Solid panels instead of see-through glass, stronger borders, a yellow focus ring, and annotation labels on a solid background. **Follow system** uses your computer's "increase contrast" setting. |
| Reduce motion | Zoom, pan and rotation jump straight to the new view, and nothing in the interface animates. **Follow system** uses your computer's "reduce motion" setting. |
| Colour-blind-safe display | Draws a white edge round pins and outlines so they stand out on any stain, and writes the colour's name in each label (for example "245 µm · green"). |
| Pin and label size | Draws pins and labels 125 %, 150 % or 200 % of normal, and makes them easier to click. The saved file is the same. |
| Single-key shortcuts | When on, keys such as **P**, **N**, **+** and **[** only work while the slide has the focus. This stops speech input, or a stray key press in another part of the window, from changing tools or slides. Shortcuts with **⌘** or Ctrl always work. |

On Windows, the app also follows **High contrast** themes (Settings ▸ Accessibility ▸ Contrast themes).

## Colour vision

Pins have colours, but nothing in the app depends on telling colours apart:

- **Name your pins.** The title is what counts for exam answers, not the colour. Your instructor's answer key uses titles too.
- Turn on **colour-blind-safe display** (above) to see the colour's name in each label. The annotation list and screen readers always say the colour's name.
- Pick colours that are far apart for you: the menu's colour submenu lists them by name.
- To see the stain better, try the **Adjust** panel: **Grayscale** and **Contrast** make structures stand out by lightness, and [stain separation](adjustments-and-stains.md#stain-separation) shows the haematoxylin and eosin (or DAB) layers one at a time, so you don't have to tell pink from purple.

## Known limitations

We want to be clear about what the app can't do yet:

- **The slide image itself is a picture.** Tissue, cells and stains can't be described in words by the app. What is available as text is what people have added: your instructor's titled pins and shapes (the annotation list reads them all), the slide's name, and its size, magnification and stain. If you can't see the image, ask your instructor for annotated slides or another arrangement for the course.
- **Drawing needs some sight of the slide.** You can place pins and draw shapes from the keyboard, but choosing *where* to put them still means looking at the tissue.
- **Thumbnails** in the slide browser have no description; the list reads each slide's name, format, size and number of annotations instead.
- **Small windows.** The app is made for a computer screen. At large text sizes in a small window, hide the slide browser (**⌥⌘1**) or the side panel (**⌥⌘2**) to give the slide more room. It doesn't reflow to a phone-sized width.
- **Some changes need a pan or zoom to show.** When only your computer's motion or contrast setting changes, the pins redraw the next time the view moves.
- Screen-reader support has been checked with automated tools and the keyboard, not yet by screen-reader users in a course. Please report anything that's read badly or not at all.

The app has no time limits of its own. Any time limit on an exam is set by your instructor, not by Slide Viewer.
