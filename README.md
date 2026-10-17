# PaperReads

A Goodreads-style tracker for research papers, with Zotero-style cataloguing. It's an
installable web app (PWA) for Android that runs fully offline. All data stays on your phone.

## Features

- **Shelves:** Want to read, Reading, Read, or Catalogued (in your library but not on a reading shelf).
- **Share to the app:** share a link (arXiv, DOI, publisher page) or a PDF or EPUB file from any app's share sheet.
- **Metadata lookup:** a DOI, an arXiv ID/link, or a title fills in title, authors, year, venue and abstract.
  Lookup uses doi.org and Crossref, and only needs internet when you add a paper.
- **Offline PDFs:** arXiv PDFs download automatically, or you can attach any PDF. The page count is read from the PDF.
- **EPUBs, with a PDF / EPUB switch per paper:** the app makes an EPUB on the phone, using a port of
  `epubify.py` (same generated covers, same PDF layout analysis). Sources, best first:
  arXiv's HTML version, Europe PMC full text (open-access PubMed Central papers; text and captions, no
  figure images), then the stored PDF. You can also import or share in an `.epub` made elsewhere.
- **Web pages → EPUB:** share a link to an article or blog post and the app keeps the article text and
  images (no menus, comments or share buttons) as an EPUB. Most sites don't let apps read their pages, so
  for those, save the page in Chrome (⋮ → ⬇ Download) and share the downloaded `.mhtml` to PaperReads, or
  pick it with **Open a file…** on the Add screen. Saved pages also work for paywalled articles you're logged into.
- **Built-in EPUB reader:** paginated, with contents, text size, and a position slider. It resumes where you left
  off, and reading moves the paper's progress forward automatically. Citations, figures, tables and sections are
  links: a citation shows its reference in a pop-up, other links jump there with a **↩ Back** button.
- **Reading progress:** tracked per paper by page (or percent if the page count is unknown), with a dated
  reading log. Reaching the end offers a **Mark as read** button; a paper is only finished when you say so.
- **Catalogue:** collections, tags (rename or merge), search across title, authors, notes and abstract, plus filters and sorting.
- **Notes & review, 1–5 star rating, and highlights** (quote + page + comment).
- **Concerns:** a per-paper checklist of doubts and things to verify, on the paper page and in the reader
  (⚠ in the top bar). Select text in the reader and tap **Concern** to attach the passage; tick items off
  as resolved.
- **Related papers:** link papers as *related to*, *cites* or *builds on*. Each paper shows its links in both directions.
- **Queue:** drag to prioritise your want-to-read list. The top items show as "Next up" on the home screen.
- **Ask Claude** (optional): ask about a paper on its page or in the reader (💬), or select a passage and tap
  **Ask**. Answers can go to your notes or concerns. Uses your own Anthropic API key (⚙ Settings), pay-as-you-go:
  a question costs a few cents. The paper's text is sent to Anthropic with your question; the key stays on the device.
- **Sync between devices** (optional): through a hidden app folder in your own Google Drive, so phone and laptop
  stay in step. Syncs on opening the app and shortly after changes; per record, the newer edit wins. Free, but
  needs a one-time Google client ID (steps in ⚙ Settings).
- **Stats:** yearly goal with on-pace indicator, papers per month, pages read, day streaks, average rating, top tags.

## Install on your phone

A service worker and share target need HTTPS, so host the files anywhere static. GitHub Pages is free:

1. Merge this branch into `main`.
2. In the repository, go to **Settings → Pages**, set *Source* to **Deploy from a branch**, and pick `main` / `/ (root)`.
3. On your Android phone, open `https://<your-username>.github.io/PaperReads/` in Chrome.
4. Open the menu (⋮) and tap **Add to Home screen**, then **Install**.

After it's installed, **PaperReads** appears in the Android share sheet.

> Your data lives in the app's browser storage on the phone, not in the cloud. Clearing Chrome's site
> data for the app, or uninstalling it, deletes your library. Use **💾 Backup** (top right) regularly.

### Backup and restore

💾 makes one `.zip`: `data.json` holds every record, and `files/` holds the PDFs, EPUBs and covers
(or choose *data only* for a small file). Save it to Google Drive, email it, or copy it to a computer.
Restoring shows what's in the backup first, then either **merges** it (adds what's missing; for papers
in both, the more recently edited copy wins) or **replaces** the library. The home screen reminds you
when you've never backed up (5+ papers) or the last backup is over 30 days old.

### What the EPUB port doesn't do

`epubify.py` can also fetch publisher pages, ar5iv and JavaScript-rendered sites through a headless
browser. A web app on a phone can only read sites that allow it, so for the rest, save the page in
Chrome and share the saved file in (see *Web pages* above), or run the script on a computer and share
the `.epub` into the app. As the script itself warns, two-column PDFs can come out with
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
| `js/backup.js` | Backup .zip export, inspect, merge/replace restore |
| `js/sync.js` | Google Drive sync (app data folder), merge with tombstones |
| `js/ask.js` | Ask Claude about a paper (Anthropic API, user's own key) |
| `js/epubify.js` | Browser port of epubify.py: covers, PDF → HTML, HTML clean-up, EPUB packaging |
| `vendor/` | pdf.js 5.4.296, epub.js 0.3.93, JSZip 3.10.1, Anthropic TypeScript SDK 0.131.0 (bundled with esbuild) |
| `sw.js` | Offline cache and share-target handler |
| `manifest.webmanifest` | Install metadata and share target |
