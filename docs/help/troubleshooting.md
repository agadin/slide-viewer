---
title: Troubleshooting
blurb: Slides that won't open, annotations that won't save, and updates.
order: 11
---

# Troubleshooting

## Finding slides

**The browser says no slides were found.**
Check you chose the folder that holds the slides (or the folders they're in), not a folder above or beside it. Only the formats in [File formats](file-formats.md) are listed. If the slides came as a `.zip`, unzip it first.

**A slide I just copied in isn't listed.**
Choose **File ▸ Rescan Folder** (**⌘R**).

**Thumbnails are grey or slow.**
The first visit to a folder makes a thumbnail for every slide, which takes a moment per slide on a network or USB drive. They're remembered after that.

## Opening slides

**"Could not open slide"**
The file is damaged, it's in a format the app can't read or the drive it's on was disconnected. Copy the slide to your own disk and try again. For a `.mrxs` or `.vsi` slide, its data folder must sit next to it.

**The slide is blurry and doesn't sharpen.**
Tiles load as you move; on a slow drive they take a moment. If it never sharpens, the slide may only have been scanned at low resolution: look at the magnification shown by the zoom buttons.

**The top bar says "uncalibrated".**
The file doesn't say how big a pixel is, so lengths are in pixels. See [Uncalibrated slides](measuring.md#uncalibrated-slides).

**The colours look wrong or the slide is very dark.**
Check the **Adjust** tab: an adjustment or a stain view may be on. Turn the adjustments off with the switch at the top, or click **Reset**. See [Adjustments and stains](adjustments-and-stains.md).

## Saving annotations

**The panel says "Saved to the app's data folder".**
The slide's folder can't be written to (a read-only course drive, for example), so the annotations were saved in the app's own folder. Use **File ▸ Export Annotations (.ndpa)…** to save a copy where you can find it, or copy the slides to a folder of your own.

**"Save failed"**
Hover over it to see why. Usually the slide's drive was disconnected or the disk is full. Your annotations are still in the app: fix the problem and the next change saves again, or use **Export Annotations (.ndpa)…**.

**My pins are gone after I renamed or moved the slide.**
The annotation file is named after the slide. Rename `old-name.ndpi.ndpa` to match the new slide name (`new-name.ndpi.ndpa`) and keep it in the same folder as the slide.

**I need an earlier version of my annotations.**
Each save keeps the previous version as `<slide>.ndpa.bak`. Close the slide, then rename the `.bak` file to replace the `.ndpa` file.

**NDP.view2 doesn't show my pins.**
Open the slide itself in NDP.view2 with the `.ndpa` file next to it, named exactly `<slide file name>.ndpa`. NDP.view2 reads the annotations when it opens the slide.

## Updates

**The update message doesn't appear.** Choose **Slide Viewer ▸ Check for Updates…** (on Windows, **File ▸ Check for Updates…**). Updates come from the project's GitHub releases and need an internet connection.

**Windows says it "protected your PC" when installing.** The installer isn't code-signed yet. Click **More info**, then **Run anyway**.

## Still stuck?

Report a problem on the [project page](https://github.com/agadin/slide-viewer/issues). Don't attach slides or exam answers: describe what happened, and which kind of slide file it was, instead.
