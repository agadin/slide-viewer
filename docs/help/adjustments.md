---
title: Adjusting the image
blurb: Gamma, brightness, contrast, colour, sharpening, stain separation and the one-click Auto tools.
order: 4
---

# Adjusting the image

Open the **Adjust** tab in the right panel. Changes apply to the slide straight away, and panning and zooming stay smooth because the work happens on the graphics card. Each slide keeps its own adjustments while the app is open, so you can switch slides and come back without losing them.

- Press **\\** in the viewer, or flip the **Adjustments** switch, to compare with the original image.
- **Reset** returns the slide to its original look.
- Double-click a slider or its label to reset just that one. You can also type a value in the box beside it.
- Snapshots (PNG export) include your adjustments.

## Auto

The Auto buttons look at a small overview of the whole slide. They only use **tissue** (the glass background is ignored), so a large white area doesn't skew the result.

| Button | What it does |
|---|---|
| **Auto levels** | Sets the black and white points and a gamma from the tissue. The glass becomes white and pale slides gain contrast. |
| **Detect stain** | Recognises H&E, H-DAB (immunohistochemistry) or a special stain (trichrome, silver, PAS, a single blue dye) and applies a mild matching preset. The readout shows the result, for example **Detected: H&E (88%)**. |
| **Estimate vectors** | Measures this slide's own stain colours (Macenko method) and uses them for stain separation. |
| **Normalise** | Re-colours the slide to a standard textbook H&E, so slides from different labs look alike. |

The percentage is how sure the detection is. Below about 60% the slide is ambiguous. For example, heavily eosin-stained muscle or bone looks very much like PAS. Treat a low-confidence result as a hint.

To run these automatically every time a slide opens, turn them on in **Preferences ▸ Adjustments**. Normalisation runs automatically only on slides detected as H&E.

## Tone and colour

- **Gamma** above 1 brightens the mid-tones, and below 1 darkens them.
- **Brightness** and **Contrast** work as in any photo editor.
- **Saturation** at −100% gives grey, and positive values make the stains more vivid.
- **Hue** rotates every colour around the colour wheel.
- **Greyscale** and **Invert** are on/off switches. Inverted slides look like dark-field images.

## Sharpen

An unsharp mask. **Amount** sets the strength, and **Radius** sets the size of the detail it enhances, in screen pixels. Small radii (about 1 px) crisp up nuclei, and large ones bring out bigger structures.

## Stain separation

Colour deconvolution splits the image into its stains:

1. Choose **H&E** or **H-DAB**.
2. Choose **All** (the stains recombined), or a single stain such as **Haematoxylin**, **Eosin** or **DAB**, shown in its own colour.

Separation uses the standard (Ruifrok) stain colours unless you click **Estimate vectors** or type your own values in the table. **Reference** goes back to the standard colours. A single channel is useful for finding nuclei (haematoxylin) or for checking where an antibody (DAB) is.

## Presets

One click sets a complete look: **Crisp**, **Pale slide**, **Dark slide**, **Nuclei**, **Eosin**, **DAB**, **Grey** and **Inverted**. A preset replaces the current tone and colour settings, but keeps Auto levels and normalisation.
