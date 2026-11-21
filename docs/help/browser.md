---
title: The slide browser
blurb: Choosing a folder, the slide list, searching, and moving from slide to slide.
order: 1.5
---

# Browsing a folder of slides

The **Slides** sidebar on the left lists every slide in a folder and all of its subfolders. Show or hide it with the **Slides** button in the top bar.

## Choose a folder

- Click **Choose Folder…** in the sidebar, or choose **File ▸ Open Folder…** (**⌘O**). Pick the folder that holds your course's slides. It can be a folder of folders, for example one per week or per organ system.
- To look at just one file, choose **File ▸ Open Slide…** (**⇧⌘O**), or click the folder name at the top of the browser and pick **Open a Single Slide…**. That menu also has **Choose Folder…** and **Rescan This Folder**.
- To change folders, click the folder's name at the top of the sidebar.
- To look at one slide that isn't in the folder, click **Open a Single Slide…** (shown before you choose a folder).

The app remembers the folder, and the slide you were looking at, and opens them again next time. You can turn that off in [Preferences ▸ Slide browser](#preferences).

## What's listed

Slide Viewer lists every file it can open:

- whole-slide images: `.ndpi`, `.svs`, `.tif`/`.tiff`, `.scn`, `.mrxs`, `.vms`, `.vmu`, `.bif`, `.svslide`, Argos `.avs`, DICOM (`.dcm`), `.czi`, Zeiss `.zvi`, Olympus `.vsi` and Nikon `.nd2`
- ordinary images: `.jpg`, `.jpeg`, `.png`, `.bmp` and `.webp`

Some files and folders are left out on purpose:

- hidden files and folders (names starting with a dot), and system folders such as the Recycle Bin and `__MACOSX`
- the data folder that sits next to a MIRAX `.mrxs` slide (the slide itself is listed)
- the `_name_` data folder that sits next to an Olympus `.vsi` slide (the slide itself is listed)
- the JPEG pieces next to a Hamamatsu `.vms` slide (the `.vms` is listed)
- a DICOM slide is a folder of many `.dcm` files: it's listed once
- empty files

Folders you can't read are counted at the bottom of the list as **N problems**. Hover over it to see which folders they are. A very large folder (more than 20,000 slides or 50,000 subfolders, for example your whole disk) is only partly scanned. Choose a smaller folder to see everything.

## The list

- Each folder can be opened and closed with its triangle. The number on the right is how many slides it holds. The app remembers which folders you closed.
- Each slide has a small picture of the whole slide, its name, its file type and its size. Pictures appear as you scroll. The first time, they take a moment for each slide; after that they're kept, so they show straight away.
- A green **pin badge** with a number means the slide has saved pins or shapes, and how many. It updates as soon as you add or remove one.
- The slide that's open is highlighted.
- Right-click a slide to **Show in Finder**, **Copy Path**, or **Show Annotation File**. Right-click a folder to expand or collapse it, everything inside it, or the whole list.

If you added or changed slides while the app was open, click the **↻** button (or **File ▸ Rescan Folder**, **⌘R**).

## Search

Type in **Search slides** to show only matching slides. Every word you type must appear in the slide's name or its folder's name, so `week 3 skin` finds `Week 3/Skin 2.ndpi`.

- **↓** moves from the search box into the list.
- **↵** opens the first match.
- **Esc** clears the search.

## Keyboard

Click the list (or press **↓** in the search box), then:

| Key | What it does |
| --- | --- |
| **↑** **↓** | move through the list |
| **↵** or **Space** | open the slide, or open or close the folder |
| **→** | open a folder |
| **←** | close a folder, or jump to the folder a slide is in |
| **Home** **End** **Page Up** **Page Down** | jump through the list |
| **/** or **⌘F** | search |

Anywhere in the app, **]** (or **→** when the list isn't selected) opens the next slide and **[** (or **←**) the previous one, in the order of the list. When you're searching, they only step through the matches. Folders open as needed. The app tells you when you reach the first or last slide.

## Preferences

In **Preferences ▸ Slide browser**:

- **Thumbnails**: *Off* (a compact list of names), *Small*, *Medium* or *Large*.
- **When a slide opens**: hide the slide browser automatically, separately for a slide **picked from the list** and one opened with **File ▸ Open…**. Click **Slides** in the top bar to bring it back.
- **Reopen the last folder** and **Reopen the slide I was looking at** when the app starts.
- **Forget** the last folder, or the folders you closed.
