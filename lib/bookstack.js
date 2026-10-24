'use strict';
/* BookStack import.
   Connects to a BookStack instance over its REST API (Token auth) and
   imports Books as categories and Pages as articles. Media referenced by
   the imported pages (gallery images in the HTML, plus page attachments)
   is downloaded into the local media library and every reference in the
   imported HTML is rewritten to the new hosted path; links between
   imported pages are rewritten to the new articles.
   API credentials arrive per-run from the admin form and are NEVER
   stored — they live only in the in-memory job while it runs.
   Re-runs are idempotent via the import_map table (books/pages) and the
   attachments.external_key dedupe (media). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitizeArticleHtml } = require('./html');
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

async function testConnection(input) {
  const creds = credsOf(input);
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

function publicJob(job) {
  if (!job) return null;
  const { creds, ...rest } = job;
  return rest;
}

function startImport(db, input, userId) {
  const creds = credsOf(input); // throws on bad input — caller returns 400
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
    summary: null, error: '',
    creds, // in-memory only, never persisted, never returned (see publicJob)
  };
  jobs.set(id, job);
  runImport(db, job, opts, userId).catch(e => {
    job.status = 'failed';
    job.error = e.message || String(e);
    job.finished_at = new Date().toISOString();
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
    links_rewritten: 0, failures: [],
  };
  const fail = (type, name, err) => S.failures.push({ type, name: String(name || ''), error: String(err.message || err) });

  job.progress.phase = 'fetching books & pages';
  const [books, chapters, pageList, attachmentList] = await Promise.all([
    listAll(creds, '/api/books'),
    listAll(creds, '/api/chapters').catch(() => []),
    listAll(creds, '/api/pages'),
    listAll(creds, '/api/attachments').catch(() => []),
  ]);
  const chapterName = new Map(chapters.map(c => [Number(c.id), c.name]));
  const attachmentsByPage = new Map();
  for (const a of attachmentList) {
    const pid = Number(a.uploaded_to);
    if (!attachmentsByPage.has(pid)) attachmentsByPage.set(pid, []);
    attachmentsByPage.get(pid).push(a);
  }

  /* --- books -> categories --- */
  job.progress.phase = 'importing categories';
  const bookCategory = new Map(); // book id -> category id
  for (const book of books) {
    try {
      const mapped = mapGet(db, 'book', book.id);
      const existing = mapped && db.prepare('SELECT id FROM categories WHERE id = ?').get(mapped);
      if (existing) { bookCategory.set(Number(book.id), existing.id); S.categories_reused++; continue; }
      const bySlug = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slugify(book.slug || book.name));
      if (bySlug) { bookCategory.set(Number(book.id), bySlug.id); mapSet(db, 'book', book.id, bySlug.id); S.categories_reused++; continue; }
      const slug = uniqueSlug(db, book.slug || book.name, 'categories');
      const cid = db.prepare(`INSERT INTO categories (name, slug, description, icon, color, sort_order, visibility)
        VALUES (?, ?, ?, '📘', '#3B82F6', 0, 'all')`)
        .run(String(book.name || 'Untitled book').slice(0, 200), slug, String(book.description || '').slice(0, 1000)).lastInsertRowid;
      mapSet(db, 'book', book.id, cid);
      bookCategory.set(Number(book.id), cid);
      S.categories_created++;
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

  /* --- media helpers --- */
  const mediaBySourceUrl = new Map(); // source url string -> local /media path
  async function importMediaUrl(rawUrl) {
    const url = String(rawUrl || '');
    if (mediaBySourceUrl.has(url)) return mediaBySourceUrl.get(url);
    const absolute = url.startsWith('http') ? url : creds.base + (url.startsWith('/') ? url : '/' + url);
    const key = 'bs:' + crypto.createHash('sha1').update(absolute).digest('hex');
    const existing = findMediaByKey(db, key);
    if (existing) {
      const local = `/media/${existing.stored_name}`;
      mediaBySourceUrl.set(url, local);
      S.media_reused++;
      return local;
    }
    const buf = await bsFetch(creds, absolute.slice(creds.base.length) || '/', { binary: true });
    const name = decodeURIComponent(absolute.split('/').pop().split('?')[0]) || 'bookstack-file';
    const saved = saveMediaBuffer(db, buf, name, '', userId, key);
    mediaBySourceUrl.set(url, saved.url);
    S.media_imported++;
    return saved.url;
  }
  async function importAttachment(att) {
    const key = 'bs-att:' + String(att.id);
    const existing = findMediaByKey(db, key);
    if (existing) { S.media_reused++; return { url: `/media/${existing.stored_name}`, name: att.name }; }
    const detail = await bsFetch(creds, `/api/attachments/${att.id}`);
    if (!detail || !detail.content) throw new Error('Attachment content was empty in the BookStack response');
    const buf = Buffer.from(String(detail.content), 'base64');
    const saved = saveMediaBuffer(db, buf, att.name || `attachment-${att.id}`, '', userId, key);
    S.media_imported++;
    return { url: saved.url, name: att.name || saved.url };
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
      if (existingArticle && !opts.updateExisting) { S.articles_skipped++; job.progress.pages_done++; continue; }

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
      html = html.replace(/href\s*=\s*"([^"]+)"/gi, (whole, href) => {
        const mm = String(href).match(/\/page\/([a-z0-9-]+)/i);
        if (mm && pageSlugByBsSlug.has(mm[1])) {
          S.links_rewritten++;
          return `href="#/article/${pageSlugByBsSlug.get(mm[1])}"`;
        }
        return whole;
      });

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
      }
    } catch (e) { fail('page', p.name, e); }
    job.progress.pages_done++;
  }

  job.summary = S;
  job.status = 'done';
  job.progress.phase = 'done';
  job.progress.current = '';
  job.finished_at = now();
  logActivity(db, userId, 'bookstack_import',
    `BookStack import: ${S.articles_created} created, ${S.articles_updated} updated, ${S.articles_skipped} skipped, ${S.media_imported} media imported (${S.failures.length} failure(s))`);
}

module.exports = { testConnection, startImport, getImportJob, publicJob };
