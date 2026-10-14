# PaperReads

A Goodreads-style tracker for research papers, with Zotero-style cataloguing. It's an
installable web app (PWA) for Android that runs fully offline. All data stays on your phone.

## Features

- **Shelves:** Want to read, Reading, Read, or Catalogued (in your library but not on a reading shelf).
- **Share to the app:** share a link (arXiv, DOI, publisher page) or a PDF file from any app's share sheet.
- **Metadata lookup:** a DOI, an arXiv ID/link, or a title fills in title, authors, year, venue and abstract.
  Lookup uses doi.org and Crossref, and only needs internet when you add a paper.
- **Offline PDFs:** arXiv PDFs download automatically, or you can attach any PDF. The page count is read from the PDF.
- **EPUBs, with a PDF / EPUB switch per paper:** the app makes an EPUB on the phone, using a port of
  `epubify.py` (same generated covers, same PDF layout analysis). Sources, best first:
  arXiv's HTML version, Europe PMC full text (open-access PubMed Central papers; text and captions, no
  figure images), then the stored PDF. You can also import or share in an `.epub` made elsewhere.
- **Built-in EPUB reader:** paginated, with contents, text size, and a position slider. It resumes where you left
  off, and reading moves the paper's progress forward automatically.
- **Reading progress:** tracked per paper by page (or percent if the page count is unknown), with a dated
  reading log. Reaching the last page marks the paper as read.
- **Catalogue:** collections, tags (rename or merge), search across title, authors, notes and abstract, plus filters and sorting.
- **Notes & review, 1–5 star rating, and highlights** (quote + page + comment).
- **Related papers:** link papers as *related to*, *cites* or *builds on*. Each paper shows its links in both directions.
- **Queue:** drag to prioritise your want-to-read list. The top items show as "Next up" on the home screen.
- **Stats:** yearly goal with on-pace indicator, papers per month, pages read, day streaks, average rating, top tags.

## Install on your phone

A service worker and share target need HTTPS, so host the files anywhere static. GitHub Pages is free:

1. Merge this branch into `main`.
2. In the repository, go to **Settings → Pages**, set *Source* to **Deploy from a branch**, and pick `main` / `/ (root)`.
3. On your Android phone, open `https://<your-username>.github.io/PaperReads/` in Chrome.
4. Open the menu (⋮) and tap **Add to Home screen**, then **Install**.

After it's installed, **PaperReads** appears in the Android share sheet.

> Your data lives in the app's browser storage on the phone. It is **not** backed up.
> Clearing Chrome's site data for the app, or uninstalling it, deletes your library.

### What the EPUB port doesn't do

`epubify.py` can also fetch publisher pages, ar5iv and JavaScript-rendered sites through a headless
browser. A web app on a phone can't fetch those sites, so for them, run the script on a computer and
share the `.epub` into the app. As the script itself warns, two-column PDFs can come out with
scrambled reading order. That's why the HTML sources are tried first.

## Develop

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

After changing any file, bump `CACHE` in `sw.js` so installed copies pick up the update.

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `js/app.js` | Views, routing, all UI logic |
| `js/db.js` | IndexedDB wrapper (shared with the service worker) |
| `js/lookup.js` | DOI / arXiv / title lookup, PDF download, page counting |
| `js/epubify.js` | Browser port of epubify.py: covers, PDF → HTML, HTML clean-up, EPUB packaging |
| `vendor/` | pdf.js 5.4.296, epub.js 0.3.93, JSZip 3.10.1 (bundled so everything works offline) |
| `sw.js` | Offline cache and share-target handler |
| `manifest.webmanifest` | Install metadata and share target |
