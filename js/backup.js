// Backup: the whole library as one .zip you can keep anywhere.
//   data.json        every record (papers, progress log, highlights, links, …)
//   files/…          stored PDFs, EPUBs and EPUB covers (optional)
const Backup = (() => {
  const FORMAT = 'paperreads-backup';
  const VERSION = 1;
  const DATA_STORES = ['papers', 'progress', 'highlights', 'links', 'collections', 'settings'];
  // How duplicates are recognised when merging auto-numbered records.
  const NATURAL_KEY = {
    progress: (r) => `${r.paperId}|${r.ts}`,
    highlights: (r) => `${r.paperId}|${r.createdAt}|${r.quote}`,
    links: (r) => `${r.fromId}|${r.toId}|${r.type}`,
  };

  async function exportZip({ includeFiles = true, onProgress = () => {} } = {}) {
    const JSZip = await Epubify.jszip();
    const zip = new JSZip();
    const stores = {};
    for (const s of DATA_STORES) stores[s] = await DB.all(s);
    // device-only settings stay out: the API key above all
    stores.settings = stores.settings.filter((r) => !['lastBackup', 'anthropicKey', 'tombstones', 'syncLast', 'syncConnected', 'googleClientId'].includes(r.key));
    const files = { pdfs: [], epubs: [] };
    if (includeFiles) {
      const pdfs = await DB.all('pdfs');
      const epubs = await DB.all('epubs');
      let n = 0;
      const total = pdfs.length + epubs.length;
      for (const r of pdfs) {
        const path = `files/pdfs/${r.paperId}.pdf`;
        zip.file(path, r.blob, { compression: 'STORE' }); // already compressed
        files.pdfs.push({ paperId: r.paperId, name: r.name, size: r.size, addedAt: r.addedAt, path });
        onProgress(++n, total);
      }
      for (const r of epubs) {
        const path = `files/epubs/${r.paperId}.epub`;
        const coverPath = r.cover ? `files/epubs/${r.paperId}-cover.png` : null;
        zip.file(path, r.blob, { compression: 'STORE' });
        if (coverPath) zip.file(coverPath, r.cover, { compression: 'STORE' });
        files.epubs.push({ paperId: r.paperId, name: r.name, size: r.size, source: r.source, addedAt: r.addedAt, path, coverPath });
        onProgress(++n, total);
      }
    }
    const data = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), includesFiles: includeFiles, stores, files };
    zip.file('data.json', JSON.stringify(data, null, 1));
    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' });
    const day = new Date().toISOString().slice(0, 10);
    await DB.setSetting('lastBackup', Date.now());
    return new File([blob], `paperreads-backup-${day}${includeFiles ? '' : '-data-only'}.zip`, { type: 'application/zip' });
  }

  async function read(file) {
    const JSZip = await Epubify.jszip();
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch {
      throw new Error('That file is not a PaperReads backup (not a zip).');
    }
    const entry = zip.file('data.json');
    if (!entry) throw new Error('That zip is not a PaperReads backup (no data.json).');
    const data = JSON.parse(await entry.async('string'));
    if (data.format !== FORMAT) throw new Error('That zip is not a PaperReads backup.');
    if (data.version > VERSION) throw new Error('This backup was made by a newer version of PaperReads. Update the app first.');
    return { zip, data };
  }

  // Summary for the confirmation step, before anything is written.
  async function inspect(file) {
    const { data } = await read(file);
    return {
      exportedAt: data.exportedAt,
      papers: data.stores.papers.length,
      pdfs: data.files.pdfs.length,
      epubs: data.files.epubs.length,
      includesFiles: data.includesFiles,
    };
  }

  /**
   * mode 'replace': wipe the library, then restore the backup exactly.
   * mode 'merge':   keep what's here; add what's missing; for papers in
   *                 both, the more recently edited copy wins.
   */
  async function restore(file, mode, onProgress = () => {}) {
    const { zip, data } = await read(file);
    const S = data.stores;
    const counts = { papers: 0, files: 0 };

    if (mode === 'replace') {
      for (const s of [...DATA_STORES, 'pdfs', 'epubs']) await DB.clear(s);
      for (const s of DATA_STORES) await DB.putMany(s, S[s] || []);
      // this library now matches a backup that exists, as of when it was made
      await DB.setSetting('lastBackup', Date.parse(data.exportedAt) || Date.now());
      counts.papers = S.papers.length;
    } else {
      const existing = Object.fromEntries((await DB.all('papers')).map((p) => [p.id, p]));
      const papers = S.papers.filter((p) => !existing[p.id] || (p.updatedAt || 0) > (existing[p.id].updatedAt || 0));
      await DB.putMany('papers', papers);
      counts.papers = papers.length;
      const cols = new Set((await DB.all('collections')).map((c) => c.id));
      await DB.putMany('collections', (S.collections || []).filter((c) => !cols.has(c.id)));
      const settings = new Set((await DB.all('settings')).map((r) => r.key));
      await DB.putMany('settings', (S.settings || []).filter((r) => !settings.has(r.key)));
      for (const s of Object.keys(NATURAL_KEY)) {
        const have = new Set((await DB.all(s)).map(NATURAL_KEY[s]));
        // drop the old auto-numbered id so it can't collide with local rows
        const fresh = (S[s] || []).filter((r) => !have.has(NATURAL_KEY[s](r))).map(({ id, ...rest }) => rest);
        await DB.putMany(s, fresh);
      }
    }

    const keepLocal = mode === 'merge' ? new Set([...(await DB.all('pdfs')).map((r) => 'pdf:' + r.paperId), ...(await DB.all('epubs')).map((r) => 'epub:' + r.paperId)]) : new Set();
    const total = data.files.pdfs.length + data.files.epubs.length;
    let n = 0;
    for (const f of data.files.pdfs) {
      onProgress(++n, total);
      const entry = zip.file(f.path);
      if (!entry || keepLocal.has('pdf:' + f.paperId)) continue;
      const blob = await entry.async('blob');
      await DB.put('pdfs', { paperId: f.paperId, blob: new File([blob], f.name, { type: 'application/pdf' }), name: f.name, size: blob.size, addedAt: f.addedAt });
      counts.files++;
    }
    for (const f of data.files.epubs) {
      onProgress(++n, total);
      const entry = zip.file(f.path);
      if (!entry || keepLocal.has('epub:' + f.paperId)) continue;
      const blob = await entry.async('blob');
      const coverEntry = f.coverPath && zip.file(f.coverPath);
      const cover = coverEntry ? new Blob([await coverEntry.async('blob')], { type: 'image/png' }) : null;
      await DB.put('epubs', { paperId: f.paperId, blob: new File([blob], f.name, { type: 'application/epub+zip' }), name: f.name, size: blob.size, cover, source: f.source, addedAt: f.addedAt });
      counts.files++;
    }

    // Keep the hasPdf/hasEpub flags honest with what is actually stored now.
    const pdfIds = new Set((await DB.all('pdfs')).map((r) => r.paperId));
    const epubIds = new Set((await DB.all('epubs')).map((r) => r.paperId));
    const fixed = (await DB.all('papers')).filter((p) => !!p.hasPdf !== pdfIds.has(p.id) || !!p.hasEpub !== epubIds.has(p.id));
    fixed.forEach((p) => {
      p.hasPdf = pdfIds.has(p.id);
      p.hasEpub = epubIds.has(p.id);
    });
    await DB.putMany('papers', fixed);
    return counts;
  }

  return { exportZip, inspect, restore };
})();
