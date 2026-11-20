---
title: Adjustments and stains
blurb: Gamma, brightness, contrast, colour filters, stain separation and the one-click Auto buttons.
order: 5
---

# Adjustments and stains

Slides scanned on different days, or stained in different labs, can look very different: too pale, too dark, too pink, too blue. The **Adjust** tab in the right panel changes how the slide looks on screen so the structures are easier to see. Adjustments never change the slide file or your annotations, and they don't affect what the grader sees.

The adjustments apply to the whole slide as you pan and zoom, and to [snapshots](viewing.md#snapshot). They're reset when you open another slide (unless an Auto step is set to run on open; see [Run automatically](#run-automatically)).

## The sliders

| Slider | What it does |
| --- | --- |
| **Gamma** | Brightens or darkens the mid-tones while leaving black and white alone. Raise it to see into dark, dense tissue; lower it to bring out a pale stain. |
| **Brightness** | Makes everything lighter or darker. |
| **Contrast** | Spreads the tones apart (more contrast) or pulls them together. |
| **Saturation** | Makes colours stronger or greyer. |
| **Hue** | Shifts every colour around the colour wheel. Useful when a slide is noticeably too pink or too purple. |
| **Sharpen** | Makes fine edges crisper (an unsharp mask). A little goes a long way; too much makes noise and halos. |

The checkboxes turn the image **grayscale** or **invert** it (a dark background with light tissue, which some people find easier for spotting small dark nuclei).

Double-click a slider to put it back to its neutral value. **Reset** puts everything back. The switch at the top of the tab turns all adjustments off and on, so you can compare with the original.

## Stain separation

Histology stains are mixtures of dyes. Stain separation splits the colours back into the dyes that made them and shows one at a time:

- **H&E**: **Hematoxylin** (nuclei, blue-purple) or **Eosin** (cytoplasm, collagen and muscle, pink).
- **H-DAB** (immunohistochemistry): **Hematoxylin** (the blue counterstain) or **DAB** (the brown that marks where the antibody bound).

Showing only hematoxylin, for example, makes nuclei stand out clearly even in a heavily eosin-stained section. Choose **Original** to see all the colours again.

## The Auto buttons

Each Auto button looks at the whole slide (only at the tissue, ignoring the empty glass around it) and sets things up for you in one click. You can still adjust the sliders afterwards.

- **Auto levels** sets brightness, contrast and gamma so the tissue uses the full range from dark to light. Use it on a slide that looks washed out, too dark, or flat.
- **Auto stain** works out which stain the slide uses and picks a matching preset: H&E, H-DAB (brown immunohistochemistry), or a special stain such as PAS (magenta), trichrome (blue-green collagen) or silver (black fibres). It also measures this slide's own dye colours (the *stain vectors*; the method is Macenko's), so stain separation works even when the slide is unusually pink or blue. The tab shows what it detected; if it guessed wrong, choose the stain yourself.
- **Normalize colours** makes an H&E slide look like a standard, well-stained reference H&E slide: it measures how much of each dye the slide has and redraws it with the reference colours. Use it to compare slides from different batches side by side, or to rescue a faded or over-stained slide. It's meant for H&E; on other stains the result may look odd.

Auto works on a small overview of the slide, so it takes a second or two at most, and it never changes the slide file.

## Run automatically

In **Preferences ▸ Adjust**, choose which Auto steps run by themselves each time you open a slide (for example Auto levels on every slide). They're off by default.
