'use strict';
/* BookStack import.
   Connects to a BookStack instance over its REST API (Token auth) and
   imports Books as categories and Pages as articles. Media referenced by
   the imported pages (gallery images in the HTML, plus page attachments)
   is downloaded into the local media library and every reference in the
   imported HTML is rewritten to the new hosted path; links between
   imported pages are rewritten to the new articles.
   The admin may SAVE the connection (base URL + Token ID + Token Secret)
   for later imports: the secret is stored only as an AES-256-GCM
   encrypted blob (lib/crypto.js, same pattern as the cloud-backup
   tokens) and is never returned by any API. Freshly typed credentials
   take precedence for a run; with none typed, the saved connection is
   used. Credentials are never logged.
   Re-runs are idempotent via the import_map table (books/pages) and the
   attachments.external_key dedupe (media).
   Every run records a timestamped log (info / warn / error) as it works;
   the admin tab streams it live through the status poll (publicJob takes
   a `since` line index), and each finished run — log included — is saved
   to bookstack_import_runs, keeping only the last 3 runs. Log lines
   never contain credentials. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeArticleHtml } = require('./html');
const { encryptJSON, decryptJSON } = require('./crypto');
const { slugify, uniqueSlug, readingTimeMin, makeExcerpt, logActivity } = require('./db');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const SOURCE = 'bookstack';

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  zip: 'application/zip', json: 'application/json', csv: 'text/csv', log: 'text/plain',
};

function kindFor(mime, name) {
  const m = String(mime || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  return 'file';
}

function plainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeBase(raw) {
  const base = String(raw || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(base)) throw new Error('Enter a valid BookStack base URL (http:// or https://…)');
  return base;
}

function credsOf(input) {
  const base = normalizeBase(input && input.base_url);
  const id = String((input && input.token_id) || '').trim();
  const secret = String((input && input.token_secret) || '').trim();
  if (!id || !secret) throw new Error('API Token ID and Token Secret are both required');
  return { base, id, secret };
}

/* ---------------- saved connection ----------------
   Singleton row in bookstack_connection. Only the secret is encrypted;
   it is decrypted server-side when a run needs it and never sent back to
   the client (the public view carries a mask, not the value). */

function getConnectionRow(db) {
  return db.prepare('SELECT * FROM bookstack_connection WHERE id = 1').get() || null;
}

function savedSecret(row) {
  if (!row || !row.credentials_encrypted) return '';
  const blob = decryptJSON(row.credentials_encrypted); // throws on tamper / wrong key
  return String(blob.token_secret || '');
}

function savedCreds(db) {
  const row = getConnectionRow(db);
  if (!row || !row.credentials_encrypted) return null;
  let secret;
  try { secret = savedSecret(row); }
  catch { throw new Error('The saved BookStack connection could not be decrypted (ENCRYPTION_KEY changed?) — remove it and save the connection again'); }
  if (!secret) return null;
  return credsOf({ base_url: row.base_url, token_id: row.token_id, token_secret: secret });
}

/** Masked, API-safe view of the saved connection. Secret value never included. */
function publicConnection(db) {
  const row = getConnectionRow(db);
  if (!row) return { saved: false };
  let secret_masked = '', readable = false, last4 = '';
  try {
    const s = savedSecret(row);
    if (s) { readable = true; last4 = s.slice(-4); secret_masked = '••••' + last4; }
  } catch { /* undecryptable — report the fact, never the value */ }
  return {
    saved: true,
    base_url: row.base_url || '',
    token_id: row.token_id || '',
    secret_masked,
    has_secret: !!row.credentials_encrypted,
    readable,
    saved_at: row.saved_at || '',
  };
}

/** Save (or update) the connection. A blank Token Secret field keeps the
    previously saved secret ("leave unchanged"); URL/ID fall back the same way. */
function saveConnection(db, input) {
  const existing = getConnectionRow(db);
  const base = normalizeBase(String((input && input.base_url) || '').trim() || (existing && existing.base_url) || '');
  const id = String((input && input.token_id) || '').trim() || (existing && existing.token_id) || '';
  if (!id) throw new Error('API Token ID is required');
  let secret = String((input && input.token_secret) || '').trim();
  if (!secret && existing) {
    try { secret = savedSecret(existing); } catch { secret = ''; }
  }
  if (!secret) throw new Error('API Token Secret is required');
  db.prepare(`INSERT INTO bookstack_connection (id, base_url, token_id, credentials_encrypted, saved_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, token_id = excluded.token_id,
      credentials_encrypted = excluded.credentials_encrypted, saved_at = excluded.saved_at`)
    .run(base, id, encryptJSON({ token_secret: secret }), new Date().toISOString());
  return publicConnection(db);
}

/** Remove the saved connection completely. */
function removeConnection(db) {
  db.prepare('DELETE FROM bookstack_connection WHERE id = 1').run();
  return publicConnection(db);
}

/** Credentials for a run: freshly typed values win; otherwise the saved
    connection. Typed URL/ID may be omitted and fall back to the saved ones. */
function resolveCreds(db, input) {
  input = input || {};
  const typedSecret = String(input.token_secret || '').trim();
  if (typedSecret) {
    const row = getConnectionRow(db);
    return credsOf({
      base_url: String(input.base_url || '').trim() || (row && row.base_url) || '',
      token_id: String(input.token_id || '').trim() || (row && row.token_id) || '',
      token_secret: typedSecret,
    });
  }
  const saved = savedCreds(db);
  if (saved) return saved;
  throw new Error('No saved BookStack connection — enter the API Token ID and Secret (tick "Save connection" to reuse them next time)');
}

async function bsFetch(creds, apiPath, { binary = false } = {}) {
  const url = creds.base + apiPath;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Authorization': `Token ${creds.id}:${creds.secret}`, 'Accept': 'application/json' },
      redirect: 'follow',
    });
  } catch (e) {
    throw new Error(`Could not reach BookStack at ${creds.base} (${e.cause?.code || e.message})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('BookStack rejected the API token (check the Token ID and Secret)');
  }
  if (!res.ok) throw new Error(`BookStack request failed (${res.status}) for ${apiPath}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** Fetch every page of a BookStack list endpoint ({data, total}). */
async function listAll(creds, apiPath) {
  const out = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const d = await bsFetch(creds, `${apiPath}${sep}count=${pageSize}&offset=${offset}`);
    const rows = Array.isArray(d.data) ? d.data : [];
    out.push(...rows);
    const total = Number(d.total ?? out.length);
    if (!rows.length || out.length >= total) break;
  }
  return out;
}

async function testConnection(db, input) {
  const creds = resolveCreds(db, input);
  maybeSave(db, input, creds);
  const books = await bsFetch(creds, '/api/books?count=1');
  const pages = await bsFetch(creds, '/api/pages?count=1');
  return {
    ok: true,
    base_url: creds.base,
    books: Number(books.total ?? (books.data || []).length),
    pages: Number(pages.total ?? (pages.data || []).length),
  };
}

/* ---------------- media library writes (shared shape with server.js) ---------------- */

function saveMediaBuffer(db, buffer, originalName, mimeType, userId, externalKey) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const extRaw = path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
  const ext = extRaw || '.bin';
  const stored = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
  const mime = mimeType || MIME_BY_EXT[ext.slice(1)] || 'application/octet-stream';
  const id = db.prepare(`INSERT INTO attachments
    (article_id, original_name, stored_name, mime_type, size_bytes, uploaded_by, uploaded_at, title, kind, external_key)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(String(originalName || stored).slice(0, 200), stored, mime, buffer.length,
      userId || null, new Date().toISOString(), String(originalName || '').slice(0, 200),
      kindFor(mime, originalName), externalKey || '').lastInsertRowid;
  return { id, url: `/media/${stored}`, stored_name: stored };
}

function findMediaByKey(db, key) {
  return db.prepare('SELECT id, stored_name FROM attachments WHERE external_key = ?').get(key);
}

/* ---------------- import job ---------------- */

const jobs = new Map();
let jobSeq = 0;

function getImportJob(id) {
  if (id) return jobs.get(String(id)) || null;
  let last = null;
  for (const j of jobs.values()) last = j;
  return last;
}

/** Public view of a job. `since` is a log-line index: only log lines
    after it are included (plus `log_total`), so the admin tab can append
    new lines as they arrive instead of re-downloading the whole log. */
function publicJob(job, since = 0) {
  if (!job) return null;
  const { creds, log, persisted, ...rest } = job;
  const lines = Array.isArray(log) ? log : [];
  const from = Math.max(0, Math.min(Number(since) || 0, lines.length));
  return { ...rest, log: lines.slice(from), log_total: lines.length };
}

/** Append one timestamped line to the running job's log. Messages must
    never include credentials — only item names, counts and errors. */
function jobLog(job, level, message) {
  job.log.push({ t: new Date().toISOString(), level, message: String(message || '') });
}

function safeParse(json, fallback) {
  try { const v = JSON.parse(json || ''); return v == null ? fallback : v; }
  catch { return fallback; }
}

/** Save a finished run (summary + full log) and prune to the last 3 runs. */
function persistRun(db, job) {
  if (job.persisted) return;
  job.persisted = true;
  try {
    db.prepare(`INSERT INTO bookstack_import_runs (started_at, finished_at, status, base_url, error, summary_json, log_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(job.started_at || '', job.finished_at || '', job.status === 'done' ? 'done' : 'failed',
        job.base_url || '', job.error || '', JSON.stringify(job.summary || {}), JSON.stringify(job.log || []));
    db.prepare(`DELETE FROM bookstack_import_runs WHERE id NOT IN
      (SELECT id FROM bookstack_import_runs ORDER BY id DESC LIMIT 3)`).run();
  } catch { /* recording the run must never break the import itself */ }
}

/** The last 3 recorded runs, newest first, each with its full saved log. */
function listImportRuns(db) {
  return db.prepare('SELECT * FROM bookstack_import_runs ORDER BY id DESC LIMIT 3').all().map(r => ({
    id: r.id,
    started_at: r.started_at || '',
    finished_at: r.finished_at || '',
    status: r.status || 'done',
    base_url: r.base_url || '',
    error: r.error || '',
    summary: safeParse(r.summary_json, {}),
    log: safeParse(r.log_json, []),
  }));
}

/** When a run carries freshly typed credentials plus save_connection,
    persist the effective credentials as the saved connection. */
function maybeSave(db, input, creds) {
  if (!input || !input.save_connection) return;
  if (!String(input.token_secret || '').trim()) return; // nothing new typed
  saveConnection(db, { base_url: creds.base, token_id: creds.id, token_secret: creds.secret });
}

function startImport(db, input, userId) {
  const creds = resolveCreds(db, input); // throws on bad input — caller returns 400
  maybeSave(db, input, creds);
  const opts = {
    status: input.status === 'draft' ? 'draft' : 'published',
    visibility: input.visibility === 'staff' ? 'staff' : 'all',
    updateExisting: !!input.update_existing,
  };
  const id = String(++jobSeq);
  const job = {
    id, status: 'running', started_at: new Date().toISOString(), finished_at: '',
    base_url: creds.base,
    progress: { phase: 'starting', pages_total: 0, pages_done: 0, current: '' },
    summary: null, error: '', log: [],
    creds, // in-memory only, never persisted, never returned (see publicJob)
  };
  jobs.set(id, job);
  runImport(db, job, opts, userId).catch(e => {
    job.status = 'failed';
    job.error = e.message || String(e);
    job.finished_at = new Date().toISOString();
    jobLog(job, 'error', `Import failed: ${job.error}`);
    persistRun(db, job);
  });
  return publicJob(job);
}

function mapGet(db, kind, sourceId) {
  const r = db.prepare('SELECT local_id FROM import_map WHERE source = ? AND kind = ? AND source_id = ?')
    .get(SOURCE, kind, String(sourceId));
  return r ? r.local_id : null;
}
function mapSet(db, kind, sourceId, localId) {
  db.prepare(`INSERT INTO import_map (source, kind, source_id, local_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(source, kind, source_id) DO UPDATE SET local_id = excluded.local_id`)
    .run(SOURCE, kind, String(sourceId), localId);
}

function syncTags(db, articleId, tagNames) {
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId);
  const ins = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  const seen = new Set();
  for (const raw of tagNames || []) {
    const name = String(raw || '').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const slug = slugify(name);
    let tag = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug);
    if (!tag) tag = { id: db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(name, slug).lastInsertRowid };
    ins.run(articleId, tag.id);
  }
}

async function runImport(db, job, opts, userId) {
  const creds = job.creds;
  const S = {
    categories_created: 0, categories_reused: 0,
    articles_created: 0, articles_updated: 0, articles_skipped: 0,
    media_imported: 0, media_reused: 0, media_failed: 0,
    links_rewritten: 0, covers_set: 0, failures: [],
  };
  const fail = (type, name, err) => {
    const entry = { type, name: String(name || ''), error: String(err.message || err) };
    S.failures.push(entry);
    jobLog(job, 'error', `${entry.type} "${entry.name}" failed: ${entry.error}`);
  };

  jobLog(job, 'info', `Connecting to ${creds.base} …`);
  job.progress.phase = 'fetching books & pages';
  const [books, chapters, pageList, attachmentList] = await Promise.all([
    listAll(creds, '/api/books'),
    listAll(creds, '/api/chapters').catch(() => []),
    listAll(creds, '/api/pages'),
    listAll(creds, '/api/attachments').catch(() => []),
  ]);
  jobLog(job, 'info', `Found ${books.length} book(s), ${pageList.length} page(s), ${attachmentList.length} attachment(s)`);
  const chapterName = new Map(chapters.map(c => [Number(c.id), c.name]));
  const attachmentsByPage = new Map();
  for (const a of attachmentList) {
    const pid = Number(a.uploaded_to);
    if (!attachmentsByPage.has(pid)) attachmentsByPage.set(pid, []);
    attachmentsByPage.get(pid).push(a);
  }

  /* --- media helpers (defined before the book loop: book covers use them) --- */
  const mediaBySourceUrl = new Map(); // source url string -> local /media path
  async function importMediaUrl(rawUrl) {
    const url = String(rawUrl || '');
    if (mediaBySourceUrl.has(url)) return mediaBySourceUrl.get(url);
    const absolute = url.startsWith('http') ? url : creds.base + (url.startsWith('/') ? url : '/' + url);
    const name = decodeURIComponent(absolute.split('/').pop().split('?')[0]) || 'bookstack-file';
    const key = 'bs:' + crypto.createHash('sha1').update(absolute).digest('hex');
    const existing = findMediaByKey(db, key);
    if (existing) {
      const local = `/media/${existing.stored_name}`;
      mediaBySourceUrl.set(url, local);
      S.media_reused++;
      jobLog(job, 'info', `Media reused: ${name}`);
      return local;
    }
    const buf = await bsFetch(creds, absolute.slice(creds.base.length) || '/', { binary: true });
    const saved = saveMediaBuffer(db, buf, name, '', userId, key);
    mediaBySourceUrl.set(url, saved.url);
    S.media_imported++;
    jobLog(job, 'info', `Media imported: ${name}`);
    return saved.url;
  }
  async function importAttachment(att) {
    const key = 'bs-att:' + String(att.id);
    const existing = findMediaByKey(db, key);
    if (existing) { S.media_reused++; jobLog(job, 'info', `Attachment reused: ${att.name || att.id}`); return { url: `/media/${existing.stored_name}`, name: att.name }; }
    const detail = await bsFetch(creds, `/api/attachments/${att.id}`);
    if (!detail || !detail.content) throw new Error('Attachment content was empty in the BookStack response');
    const buf = Buffer.from(String(detail.content), 'base64');
    const saved = saveMediaBuffer(db, buf, att.name || `attachment-${att.id}`, '', userId, key);
    S.media_imported++;
    jobLog(job, 'info', `Attachment imported: ${att.name || saved.url}`);
    return { url: saved.url, name: att.name || saved.url };
  }

  /* A book's cover: API payloads expose it as cover.url / cover_url, or via
     image_id into the image gallery. Returns a source URL or ''. */
  async function bookCoverSourceUrl(book) {
    if (book.cover && typeof book.cover === 'object' && book.cover.url) return String(book.cover.url);
    if (typeof book.cover === 'string' && book.cover) return book.cover;
    if (book.cover_url) return String(book.cover_url);
    if (book.image_id) {
      try {
        const gallery = await listAll(creds, '/api/image-gallery');
        const img = gallery.find(g => Number(g.id) === Number(book.image_id));
        if (img && img.url) return String(img.url);
      } catch { /* gallery unavailable — cover is best-effort */ }
    }
    return '';
  }

  /* --- books -> categories (BookStack book cover -> category cover) --- */
  job.progress.phase = 'importing categories';
  const bookCategory = new Map(); // book id -> category id
  for (const book of books) {
    try {
      let cid = null;
      const mapped = mapGet(db, 'book', book.id);
      const existing = mapped && db.prepare('SELECT id FROM categories WHERE id = ?').get(mapped);
      if (existing) { cid = existing.id; S.categories_reused++; jobLog(job, 'info', `Book "${book.name}" → category reused (already imported)`); }
      else {
        const bySlug = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slugify(book.slug || book.name));
        if (bySlug) { cid = bySlug.id; mapSet(db, 'book', book.id, cid); S.categories_reused++; jobLog(job, 'info', `Book "${book.name}" → category reused (already imported)`); }
        else {
          const slug = uniqueSlug(db, book.slug || book.name, 'categories');
          cid = db.prepare(`INSERT INTO categories (name, slug, description, icon, color, sort_order, visibility)
            VALUES (?, ?, ?, '📘', '#3B82F6', 0, 'all')`)
            .run(String(book.name || 'Untitled book').slice(0, 200), slug, String(book.description || '').slice(0, 1000)).lastInsertRowid;
          mapSet(db, 'book', book.id, cid);
          S.categories_created++;
          jobLog(job, 'info', `Book "${book.name}" → category created`);
        }
      }
      bookCategory.set(Number(book.id), cid);
      const coverUrl = await bookCoverSourceUrl(book);
      if (coverUrl) {
        try {
          const local = await importMediaUrl(coverUrl);
          const cur = db.prepare('SELECT cover_image FROM categories WHERE id = ?').get(cid);
          if (cur && cur.cover_image !== local) {
            db.prepare('UPDATE categories SET cover_image = ? WHERE id = ?').run(local, cid);
            S.covers_set++;
            jobLog(job, 'info', `Book cover set for "${book.name}"`);
          }
        } catch (e) { S.media_failed++; fail('cover', book.name, e); }
      }
    } catch (e) { fail('book', book.name, e); }
  }

  /* --- pass 1: decide local slugs for all pages --- */
  const localSlugFor = new Map(); // page id -> local slug
  const usedSlugs = new Set(db.prepare('SELECT slug FROM articles').all().map(r => r.slug));
  for (const p of pageList) {
    const mapped = mapGet(db, 'page', p.id);
    const existing = mapped && db.prepare('SELECT slug FROM articles WHERE id = ?').get(mapped);
    if (existing) { localSlugFor.set(Number(p.id), existing.slug); usedSlugs.add(existing.slug); continue; }
    let slug = slugify(p.slug || p.name);
    let base = slug, n = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
    usedSlugs.add(slug);
    localSlugFor.set(Number(p.id), slug);
  }
  const pageSlugByBsSlug = new Map(); // bookstack page slug -> local slug
  for (const p of pageList) {
    if (p.slug) pageSlugByBsSlug.set(String(p.slug), localSlugFor.get(Number(p.id)));
  }

  /* --- pass 2: pages -> articles --- */
  job.progress.phase = 'importing pages';
  job.progress.pages_total = pageList.length;
  const now = () => new Date().toISOString();

  for (const p of pageList) {
    job.progress.current = p.name || '';
    try {
      const detail = await bsFetch(creds, `/api/pages/${p.id}`);
      const html0 = String(detail.html || '');
      const mappedId = mapGet(db, 'page', p.id);
      const existingArticle = mappedId ? db.prepare('SELECT * FROM articles WHERE id = ?').get(mappedId) : null;
      if (existingArticle && !opts.updateExisting) { S.articles_skipped++; jobLog(job, 'info', `Page skipped (already imported): "${p.name}"`); job.progress.pages_done++; continue; }

      /* media referenced in the HTML */
      const refs = new Set();
      const refRe = /(?:src|href)\s*=\s*"([^"]+)"/gi;
      let m;
      while ((m = refRe.exec(html0))) {
        const u = m[1];
        if (u.includes('/uploads/')) refs.add(u);
      }
      let html = html0;
      for (const u of refs) {
        try {
          const local = await importMediaUrl(u);
          html = html.split(u).join(local);
        } catch (e) { S.media_failed++; fail('media', u, e); }
      }

      /* page attachments not already embedded: append as hosted links */
      const pageAtts = attachmentsByPage.get(Number(p.id)) || [];
      const appended = [];
      for (const att of pageAtts) {
        try {
          const got = await importAttachment(att);
          if (!html.includes(got.url)) appended.push(`<li><a href="${got.url}">${String(got.name || 'Attachment').replace(/</g, '&lt;')}</a></li>`);
        } catch (e) { S.media_failed++; fail('attachment', att.name, e); }
      }
      if (appended.length) html += `<h3>Attachments</h3><ul>${appended.join('')}</ul>`;

      /* internal page links -> new articles */
      const linksBefore = S.links_rewritten;
      html = html.replace(/href\s*=\s*"([^"]+)"/gi, (whole, href) => {
        const mm = String(href).match(/\/page\/([a-z0-9-]+)/i);
        if (mm && pageSlugByBsSlug.has(mm[1])) {
          S.links_rewritten++;
          return `href="#/article/${pageSlugByBsSlug.get(mm[1])}"`;
        }
        return whole;
      });
      if (S.links_rewritten > linksBefore) jobLog(job, 'info', `Rewrote ${S.links_rewritten - linksBefore} internal link(s) in "${p.name}"`);

      const content = sanitizeArticleHtml(html);
      const tags = (Array.isArray(detail.tags) ? detail.tags.map(t => t.name) : []).filter(Boolean);
      if (p.chapter_id && chapterName.get(Number(p.chapter_id))) tags.push(chapterName.get(Number(p.chapter_id)));
      const authorName = String(detail.created_by?.name || detail.owned_by?.name || '').slice(0, 120);
      const isDraft = !!detail.draft || !!p.draft;
      const status = isDraft ? 'draft' : opts.status;
      const categoryId = bookCategory.get(Number(p.book_id)) || null;
      const ts = now();

      if (existingArticle) {
        db.prepare(`UPDATE articles SET title = ?, content_html = ?, content_text = ?, excerpt = ?,
          category_id = ?, status = ?, visibility = ?, author_name = ?, reading_time_min = ?,
          published_at = CASE WHEN ? = 'published' AND published_at = '' THEN ? ELSE published_at END,
          updated_at = ? WHERE id = ?`)
          .run(String(detail.name || p.name || 'Untitled').slice(0, 300), content, plainText(content), makeExcerpt(content),
            categoryId, status, opts.visibility, authorName || existingArticle.author_name || '',
            readingTimeMin(content), status, ts, ts, existingArticle.id);
        syncTags(db, existingArticle.id, tags);
        const max = db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM article_versions WHERE article_id = ?').get(existingArticle.id).m;
        db.prepare(`INSERT INTO article_versions (article_id, version_number, title, content_html, author_id, note, created_at)
          VALUES (?, ?, ?, ?, ?, 'BookStack re-import', ?)`)
          .run(existingArticle.id, max + 1, String(detail.name || p.name || 'Untitled'), content, userId || null, ts);
        S.articles_updated++;
        jobLog(job, 'info', `Article updated: "${detail.name || p.name}"`);
      } else {
        const slug = localSlugFor.get(Number(p.id));
        const id = db.prepare(`INSERT INTO articles
          (title, slug, content_html, content_text, excerpt, category_id, service_id, status, featured, pinned, visibility,
           author_id, author_name, reading_time_min, published_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`)
          .run(String(detail.name || p.name || 'Untitled').slice(0, 300), slug, content, plainText(content), makeExcerpt(content),
            categoryId, status, opts.visibility, userId || null, authorName,
            readingTimeMin(content), status === 'published' ? ts : '', ts, ts).lastInsertRowid;
        syncTags(db, id, tags);
        db.prepare(`INSERT INTO article_versions (article_id, version_number, title, content_html, author_id, note, created_at)
          VALUES (?, 1, ?, ?, ?, 'Imported from BookStack', ?)`)
          .run(id, String(detail.name || p.name || 'Untitled'), content, userId || null, ts);
        mapSet(db, 'page', p.id, id);
        S.articles_created++;
        jobLog(job, 'info', `Article created: "${detail.name || p.name}"${status === 'draft' ? ' (draft)' : ''}`);
      }
    } catch (e) { fail('page', p.name, e); }
    job.progress.pages_done++;
  }

  job.summary = S;
  job.status = 'done';
  job.progress.phase = 'done';
  job.progress.current = '';
  job.finished_at = now();
  jobLog(job, 'info', `Import finished — ${S.articles_created} article(s) created, ${S.articles_updated} updated, ${S.articles_skipped} skipped, ${S.media_imported} media imported, ${S.failures.length} failure(s)`);
  persistRun(db, job);
  logActivity(db, userId, 'bookstack_import',
    `BookStack import: ${S.articles_created} created, ${S.articles_updated} updated, ${S.articles_skipped} skipped, ${S.media_imported} media imported (${S.failures.length} failure(s))`);
}

module.exports = {
  testConnection, startImport, getImportJob, publicJob, listImportRuns,
  publicConnection, saveConnection, removeConnection,
};
