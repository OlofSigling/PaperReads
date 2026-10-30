# PaperReads

A Goodreads-style tracker for research papers, with Zotero-style cataloguing. It's an
installable web app (PWA) for Android that runs fully offline. All data stays on your phone.

## Start here

1. On your phone, open **https://olofsigling.github.io/PaperReads/** in Chrome.
2. Tap ⋮ → **Add to Home screen** → **Install**.

That's it. To add a paper, share its link or PDF to PaperReads from any app, or tap ＋.
Want sync between your phone and laptop? Ask Olof for an invite link, open it, and tap **Connect**.
Want to see what friends are reading? Open a friend's add-me link and sign in with Google.
Everything below is optional.

## Features

- **Shelves:** Want to read, Reading, Read, or Catalogued (in your library but not on a reading shelf).
- **Add a list:** paste a list of papers (PubMed, DOI, arXiv or journal links, DOIs, arXiv IDs, PMIDs; one per line,
  other text is fine) on the Add screen, or tap **Paste a list…**. All are looked up at once, duplicates are flagged,
  and they're added in order to a shelf of your choice, with PDFs (arXiv or free copies) and EPUBs fetched after.
- **Share to the app:** share a link (arXiv, DOI, publisher page) or a PDF or EPUB file from any app's share sheet.
- **Metadata lookup:** a DOI, an arXiv ID/link, or a title fills in title, authors, year, venue and abstract.
  Lookup uses doi.org and Crossref, and only needs internet when you add a paper.
- **Offline PDFs:** arXiv PDFs download automatically, or you can attach any PDF. The page count is read from the PDF.
  For other papers the app looks for a free, legal copy (open access, preprints, author manuscripts in university
  repositories, via OpenAlex) and downloads it when the site allows. Most sites don't let apps download, so then the
  paper page links straight to the free PDF: download it in your browser and share it to PaperReads, and it goes
  onto the paper by itself. On a laptop, the **PaperReads helper** browser extension (⚙ Settings → Laptop helper) downloads
  those for you, through your browser and with your own access, including paywalled papers when your network or
  login has a licence.
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
- **Read aloud** (🔊 in the reader): reads from where you are, sentence by sentence, with the sentence highlighted and
  pages turning as it goes. It skips citation markers, figures and the reference list. Speed and voice are adjustable
  (the voices are your phone's own text-to-speech), and **🔊 From here** on a selection starts there.
- **Define:** select a word in the reader and tap **Define** for its dictionary entry (Wiktionary), or a Wikipedia
  summary for terms and names. **Highlight with definition** keeps it as a highlight with the definition as its note.
- **Reading progress:** tracked per paper by page (or percent if the page count is unknown), with a dated
  reading log. Reaching the end offers a **Mark as read** button; a paper is only finished when you say so.
- **Catalogue:** collections, tags (rename or merge), search across title, authors, notes and abstract, plus filters and sorting.
- **Notes & review, 1–5 star rating, and highlights** (quote + page + comment). Highlights come in colours that mean
  something: **Key point** (yellow), **Spin** (pink), **Delve into** (blue), and **Concern** (red, which also goes on the
  paper's concern list). Tap a highlight to change its type, add a note, or turn it into a concern; the paper page
  filters highlights by type.
- **Concerns:** a per-paper checklist of doubts and things to verify, on the paper page and in the reader
  (⚠ in the top bar). Select text in the reader and tap **Concern** to attach the passage; tick items off
  as resolved.
- **Discovery trails:** record which paper led you to which. In the reader, tap a citation and **＋ Add to library**
  to snowball: the cited paper is looked up from the reference and joins the trail (and you're back where you were
  reading). On a paper page, **＋ Add a paper found here** does the same; any paper's "found via" can be changed later.
  Each paper shows where it was found and what it led to; 🌳 Discovery trails (under 📁) shows the whole trees.
- **Bundles:** group papers under a name, flat (no trail needed): **Select** in the Queue or the Library, tick papers,
  tap **📦 Bundle**. A bundle shows as one collapsible block that moves as a whole in the queue; ⋯ renames or
  unbundles it. A paper's bundle can also be set on its page.
- **Related papers:** link papers as *related to*, *cites* or *builds on*. Each paper shows its links in both directions.
- **Queue:** drag to prioritise your want-to-read list; swipe a paper right to archive it (kept as Catalogued) or left to delete it, with Undo. Deleted papers wait 30 days in 🗑 Recently deleted (bottom of the Library), and with sync on it can also find papers in Google Drive’s history of the sync file. Papers found through another one are grouped (collapsed)
  under the paper their trail started from, so a whole trail moves as one; open a group to order the papers in it.
  The top items show as "Next up" on the home screen.
- **Ask Claude** (optional): ask about a paper on its page or in the reader (💬), or select a passage and tap
  **Ask**. Answers can go to your notes or concerns. Uses your own Anthropic API key (⚙ Settings), pay-as-you-go:
  a question costs a few cents. The paper's text is sent to Anthropic with your question; the key stays on the device.
- **Sync between devices** (optional): through a hidden app folder in your own Google Drive, so phone and laptop
  stay in step. Syncs on opening the app and shortly after changes; field by field, the newer edit wins. Free, but
  needs a one-time Google client ID and secret (steps in ⚙ Settings); with the secret, each device signs in once and
  stays signed in (the secret and sign-in stay on the device, never synced or backed up).
- **Friends** (optional, 👥): add friends and see each other's shelves (Reading, Read with stars, Want to read)
  and a feed of what they've shelved lately; one tap adds a friend's paper to your library. Only the papers on your
  shelves are shared (title, authors, ids, status, stars, dates). Notes, concerns, highlights, files and papers you
  mark **Keep private** never leave your device. Friend requests must be accepted, and Firestore security rules let
  only accepted friends read a shelf. Runs on a free Firebase project set up once by one person.
- **Stats:** yearly goal with on-pace indicator, papers per month, pages read, day streaks, average rating, top tags.

## Get started

PaperReads is a website you install like an app: **https://olofsigling.github.io/PaperReads/**.
Each person's library stays in their own browser. Nobody else can see it, including whoever runs the site.

### 1. Install (2 minutes)

- **Android:** open the link in **Chrome**, tap ⋮ → **Add to Home screen** → **Install**. PaperReads then also
  appears in Android's **share sheet**.
- **Laptop:** open the link in Chrome or Edge (optionally use the install icon in the address bar for its own window).

### 2. Add papers

- **Share to it:** from any app or browser, share a paper's link (DOI, arXiv, journal page) or a PDF and pick
  PaperReads. It looks up the title, authors and so on, saves the PDF when it can, and makes an EPUB for reading
  on the phone. If a site won't let it download the PDF, download it in your browser and share the file instead.
- **Or tap ＋ Add** and paste a DOI, an arXiv link or a title.
- **Web articles:** share the link. If the site blocks apps, save the page in Chrome (⋮ → ⬇ Download) and share
  the saved file.

### 3. Read

- Shelves: Want to read, Reading, Read. **Read** is your call: reaching the last page only offers it.
- In the reader, tap the edges or swipe to turn pages. Select text to highlight it, add a note, or add a
  **concern**. Tap a citation to see the reference, then **＋ Add to library** to save a paper you found through it.
- **Want to read** is your queue: drag ☰ to order it.

### 4. Back up, or sync

The library lives only in this browser: uninstalling the app or clearing Chrome's data for it deletes it.
Either tap **💾** now and then and keep the .zip somewhere safe, or set up sync below, which keeps a copy in
your own Google Drive.

### Optional: sync between your devices

Free, through a hidden folder in **your own** Google Drive. The app can see only that folder.

1. Ask the person who runs the site (Olof) for an **invite link** (⚙ Settings → Sync → **Invite someone**),
   and open it. Sync is then filled in for you; tap **Connect and sync**.
   (Without a link: ⚙ **Settings** → **Sync with Google Drive**, paste the client ID and secret you were given.)
3. On Google's sign-in page you may see "Google hasn't verified this app" (it's a personal app). Choose
   **Advanced → Go to PaperReads** and allow access.
4. Repeat on your other devices. Each signs in once and then stays signed in.

### Optional: Ask Claude about a paper

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys) and add a few
   dollars of credit. It's pay-as-you-go and separate from a Claude subscription.
2. ⚙ **Settings** → **Ask Claude**: paste the key, tap **Test key**.
3. Ask on a paper's page or in the reader (💬), or select a passage and tap **Ask**. A question costs a few cents.

### Optional: friends

1. Get an add-me link from a friend (they make it under 👥 → **Invite a friend**) and open it.
2. Tap **Sign in with Google**. They get a friend request; once they accept, you see each other's shelves under 👥.
3. To hide a paper, tick **Keep private** under its rating.

### For the site's owner: turning on friends

Friends need a free Firebase project (once, about 10 minutes): ⚙ Settings → **Friends** → *Set up Firebase* lists the
steps and has the security rules to paste. The Firebase config isn't a secret (the rules protect the data), but it's
kept out of this repository anyway so forks don't share one project; add-me links and sync invite links carry it.

### For the site's owner: letting others sync

Everyone can share one Google client ID and secret. Each person still signs in with their own Google account
and syncs to their own Drive.
- With the Google project **published** (Google Auth Platform → Audience → *In production*), anyone can sign in.
  In *Testing* mode, add each person's Gmail under Audience → **Test users** (up to 100); they'll be signed out every 7 days.
- The easy way to share them: ⚙ Settings → Sync → **Invite someone** makes a link that fills them in.
- Send the link (or the ID and secret) privately. **Don't commit the secret to this repository:** it's public, and Google
  disables client secrets it finds published on GitHub.

### Host your own copy

A service worker and share target need HTTPS, so host the files anywhere static. GitHub Pages is free: fork the
repository, go to **Settings → Pages**, set *Source* to **Deploy from a branch** and pick `main` / `/ (root)`.
The app is then at `https://<your-username>.github.io/PaperReads/`. For sync on your copy, set up your own
Google client: the steps are in the app under ⚙ Settings → Sync → *Get a client ID*.

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
| `oauth.html` | Where Google's sign-in returns to (hands the code back to the app) |
| `js/ask.js` | Ask Claude about a paper (Anthropic API, user's own key) |
| `js/epubify.js` | Browser port of epubify.py: covers, PDF → HTML, HTML clean-up, EPUB packaging |
| `vendor/` | pdf.js 5.4.296 (with its JPEG 2000 and colour-profile decoders in `vendor/wasm/`), epub.js 0.3.93, JSZip 3.10.1, Anthropic TypeScript SDK 0.131.0 (bundled with esbuild) |
| `sw.js` | Offline cache and share-target handler |
| `manifest.webmanifest` | Install metadata and share target |
