'use strict';
/* XC Wiki — Express API + static frontend.
   Articles store sanitized HTML. Visibility (all / groups / staff) is
   enforced server-side on every read path. */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { marked } = require('marked');
const { sanitizeArticleHtml, sanitizeCustomCss } = require('./lib/html');
const {
  getDb, getSettings, setSettings, ensureSettingsSeed, logActivity,
  readingTimeMin, makeExcerpt, slugify, uniqueSlug,
} = require('./lib/db');
const { hashPassword, verifyPassword, newToken, expiryFor } = require('./lib/auth');
const cloud = require('./lib/cloud');
const demoLib = require('./lib/demo');
const bookstack = require('./lib/bookstack');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

marked.setOptions({ breaks: true, gfm: true });

function plainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Add id anchors to headings for the table of contents. */
function addHeadingIds(html) {
  const used = new Set();
  return html.replace(/<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    if (/id=/.test(attrs)) return m;
    const text = inner.replace(/<[^>]+>/g, '');
    let id = slugify(text) || 'section';
    let n = 2;
    while (used.has(id)) id = `${slugify(text)}-${n++}`;
    used.add(id);
    return `<${tag}${attrs} id="${id}">${inner}</${tag}>`;
  });
}

function extractToc(html) {
  const toc = [];
  const re = /<(h[1-6])[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    toc.push({ level: Number(m[1][1]), id: m[2], text: m[3].replace(/<[^>]+>/g, '') });
  }
  return toc;
}

/* ---------------- Uploads (attachments, public serve, safe) ---------------- */

const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const STORED_NAME_RE = /^[a-f0-9]{32}\.[a-z0-9]+$/;

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8) || '.bin';
    cb(null, require('crypto').randomBytes(16).toString('hex') + ext);
  },
});
function kindForFile(mime, name) {
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

const UPLOAD_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a',
  'pdf', 'txt', 'md', 'log', 'zip', 'json', 'csv']);
const UPLOAD_MIMES = /^(image\/(png|jpe?g|gif|webp|svg\+xml|bmp|x-icon)|video\/|audio\/|application\/pdf|text\/(plain|markdown|csv)|application\/(zip|x-zip-compressed|json))$/;

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    const ok = UPLOAD_MIMES.test(file.mimetype) || UPLOAD_EXTS.has(ext);
    cb(ok ? null : new Error('File type not allowed'), ok);
  },
});

function insertAttachment(db, file, userId, articleId) {
  const id = db.prepare(`INSERT INTO attachments
    (article_id, original_name, stored_name, mime_type, size_bytes, uploaded_by, uploaded_at, title, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(articleId || null, file.originalname.slice(0, 200), file.filename,
      file.mimetype, file.size, userId, new Date().toISOString(),
      file.originalname.slice(0, 200), kindForFile(file.mimetype, file.originalname)).lastInsertRowid;
  return { id, url: `/media/${file.filename}`, name: file.originalname, kind: kindForFile(file.mimetype, file.originalname) };
}

app.get('/media/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!STORED_NAME_RE.test(name)) return res.status(404).json({ error: 'Not found' });
  const db = getDb();
  const row = db.prepare('SELECT stored_name, mime_type FROM attachments WHERE stored_name = ?').get(name);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOAD_DIR, row.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.set({
    'Content-Type': row.mime_type || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=86400',
  });
  res.sendFile(filePath);
});
app.get('/media/*', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- Auth & viewer resolution ---------------- */

function cleanExpiredTokens(db) {
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(Date.now());
  try { db.prepare('DELETE FROM customer_tokens WHERE expires_at < ?').run(Date.now()); } catch {}
}

/** Resolve the bearer token to a viewer: staff | customer | null (anonymous).
    Never throws; never reveals whether the token was staff or customer. */
function resolveViewer(db, token) {
  if (!token) return null;
  cleanExpiredTokens(db);
  const staff = db.prepare(`SELECT t.*, u.id AS uid, u.email, u.display_name, u.role, u.disabled
    FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?`).get(token);
  if (staff) {
    if (staff.expires_at >= Date.now() && !staff.disabled) {
      return { type: 'staff', id: staff.uid, email: staff.email, display_name: staff.display_name, role: staff.role, token };
    }
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return null;
  }
  let cust = null;
  try {
    cust = db.prepare(`SELECT t.*, c.id AS cid, c.name, c.email, c.company, c.disabled, c.group_id, g.name AS group_name
      FROM customer_tokens t JOIN customers c ON c.id = t.customer_id
      LEFT JOIN customer_groups g ON g.id = c.group_id WHERE t.token = ?`).get(token);
  } catch {}
  if (cust) {
    if (cust.expires_at >= Date.now() && !cust.disabled) {
      return { type: 'customer', id: cust.cid, name: cust.name, email: cust.email, company: cust.company || '', group_id: cust.group_id, group_name: cust.group_name || '', token };
    }
    try { db.prepare('DELETE FROM customer_tokens WHERE token = ?').run(token); } catch {}
  }
  return null;
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Optional auth: populates req.viewer (staff | customer | null). Never 401s. */
function attachViewer(req, res, next) {
  req.viewer = resolveViewer(getDb(), bearerToken(req));
  next();
}

/** Staff only. Sets req.user (legacy shape) and req.viewer. */
function requireAuth(req, res, next) {
  const v = resolveViewer(getDb(), bearerToken(req));
  if (!v || v.type !== 'staff') return res.status(401).json({ error: 'Not authenticated' });
  req.viewer = v;
  req.user = { id: v.id, email: v.email, display_name: v.display_name, role: v.role };
  req.token = v.token;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.viewer || req.viewer.type !== 'staff' || !roles.includes(req.viewer.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

/** Any signed-in principal: staff or customer. Sets req.viewer. */
function requireSignedIn(req, res, next) {
  const v = resolveViewer(getDb(), bearerToken(req));
  if (!v) return res.status(401).json({ error: 'Not authenticated' });
  req.viewer = v;
  req.token = v.token;
  next();
}

/* ---------------- Visibility enforcement ---------------- */

/**
 * SQL fragment + params restricting article rows (alias `a`, with categories
 * joined as `c` via ARTICLE_JOIN) to what `viewer` may see.
 * - staff: everything (published filter applied separately)
 * - anonymous: visibility='all' and category not staff-only
 * - customer: 'all', plus 'groups' articles linked to their group; never staff-only categories
 */
function visibilityClause(viewer) {
  const catOk = `(a.category_id IS NULL OR c.visibility = 'all')`;
  if (viewer && viewer.type === 'staff') return { clause: '1=1', params: [] };
  if (viewer && viewer.type === 'customer' && viewer.group_id) {
    return {
      clause: `(a.visibility = 'all' OR (a.visibility = 'groups' AND EXISTS (SELECT 1 FROM article_groups ag WHERE ag.article_id = a.id AND ag.group_id = ?))) AND ${catOk}`,
      params: [viewer.group_id],
    };
  }
  return { clause: `(a.visibility = 'all' AND ${catOk})`, params: [] };
}

/** Extra WHERE for category listings: hide staff-only categories from non-staff. */
function categoryVisibilityWhere(viewer) {
  if (viewer && viewer.type === 'staff') return { clause: '1=1', params: [] };
  return { clause: `c.visibility = 'all'`, params: [] };
}

app.get('/api/setup-needed', (req, res) => {
  const n = getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ needed: n === 0 });
});

app.post('/api/setup', (req, res) => {
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  const { email, password, display_name } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  }
  const now = new Date().toISOString();
  const id = db.prepare('INSERT INTO users (email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(email).trim().toLowerCase(), hashPassword(password), String(display_name || 'Admin').slice(0, 80), 'admin', now).lastInsertRowid;
  const token = newToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, id, Date.now(), expiryFor(false));
  logActivity(db, id, 'setup', 'First admin account created');
  res.json({ token, user: { id, email: String(email).trim().toLowerCase(), display_name: String(display_name || 'Admin'), role: 'admin', kind: 'staff' } });
});

app.post('/api/auth/login', (req, res) => {
  const db = getDb();
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user || user.disabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  cleanExpiredTokens(db);
  const token = newToken();
  db.prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, user.id, Date.now(), expiryFor(false));
  logActivity(db, user.id, 'login', `${user.email} signed in`);
  res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role, kind: 'staff' } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  getDb().prepare('DELETE FROM auth_tokens WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

/* Works for staff and customers. */
app.get('/api/me', attachViewer, (req, res) => {
  const v = req.viewer;
  if (!v) return res.status(401).json({ error: 'Not authenticated' });
  if (v.type === 'staff') {
    return res.json({ user: { id: v.id, email: v.email, display_name: v.display_name, role: v.role, kind: 'staff' } });
  }
  res.json({ user: { id: v.id, email: v.email, name: v.name, company: v.company, group_id: v.group_id, group_name: v.group_name, kind: 'customer' } });
});

/* ---------------- Customer auth ---------------- */

app.post('/api/customer/login', (req, res) => {
  const db = getDb();
  const { email, password } = req.body || {};
  const cust = db.prepare('SELECT * FROM customers WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!cust || cust.disabled || !verifyPassword(password, cust.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  cleanExpiredTokens(db);
  const token = newToken();
  db.prepare('INSERT INTO customer_tokens (token, customer_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, cust.id, Date.now(), expiryFor(false));
  db.prepare('UPDATE customers SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), cust.id);
  const g = cust.group_id ? db.prepare('SELECT name FROM customer_groups WHERE id = ?').get(cust.group_id) : null;
  res.json({ token, user: { id: cust.id, email: cust.email, name: cust.name, company: cust.company, group_id: cust.group_id, group_name: g?.name || '', kind: 'customer' } });
});

app.post('/api/customer/logout', requireSignedIn, (req, res) => {
  const db = getDb();
  try { db.prepare('DELETE FROM customer_tokens WHERE token = ?').run(req.token); } catch {}
  try { db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(req.token); } catch {}
  res.json({ ok: true });
});

/** Customer changes their own password. */
app.put('/api/customer/password', requireSignedIn, (req, res) => {
  const v = req.viewer;
  if (v.type !== 'customer') return res.status(403).json({ error: 'Customers only' });
  const db = getDb();
  const { current, password } = req.body || {};
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(v.id);
  if (!cust || !verifyPassword(current, cust.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  db.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(hashPassword(password), v.id);
  res.json({ ok: true });
});

/* ---------------- Public: settings & home ---------------- */

const PUBLIC_BRANDING_KEYS = [
  'site_title', 'site_tagline', 'logo_text', 'logo_url', 'logo_height', 'favicon_url',
  'hero_title', 'hero_description', 'hero_image_url', 'hero_image_fit', 'hero_image_position',
  'hero_overlay', 'hero_show_cards', 'popular_searches',
  'footer_text', 'copyright_line', 'powered_by', 'default_theme',
  'primary_color', 'accent_color',
  'dark_bg', 'dark_surface', 'dark_text',
  'light_bg', 'light_surface', 'light_text',
  'custom_css',
];

app.get('/api/settings/public', (req, res) => {
  const s = getSettings(getDb());
  const out = {};
  for (const k of PUBLIC_BRANDING_KEYS) out[k] = s[k] ?? '';
  try { out.popular_searches = JSON.parse(s.popular_searches || '[]'); }
  catch { out.popular_searches = []; }
  out.custom_css = sanitizeCustomCss(out.custom_css);
  res.json(out);
});

function articleCard(row) {
  return {
    id: row.id, title: row.title, slug: row.slug, excerpt: row.excerpt,
    category: row.category_name ? { name: row.category_name, slug: row.category_slug, icon: row.category_icon, icon_image: row.category_icon_image || '', cover_image: row.category_cover_image || '', color: row.category_color } : null,
    service: row.service_name ? { name: row.service_name, slug: row.service_slug, icon: row.service_icon } : null,
    views: row.views, helpful_yes: row.helpful_yes, helpful_no: row.helpful_no,
    reading_time_min: row.reading_time_min, featured: !!row.featured, pinned: !!row.pinned,
    visibility: row.visibility || 'all',
    restricted: (row.visibility || 'all') !== 'all',
    published_at: row.published_at, updated_at: row.updated_at,
  };
}

const ARTICLE_JOIN = `
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN services s ON s.id = a.service_id`;
const ARTICLE_COLS = `a.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon, c.icon_image AS category_icon_image, c.cover_image AS category_cover_image, c.color AS category_color,
  s.name AS service_name, s.slug AS service_slug, s.icon AS service_icon`;

app.get('/api/home', attachViewer, (req, res) => {
  const db = getDb();
  const pub = `a.status = 'published'`;
  const vis = visibilityClause(req.viewer);
  const catVis = categoryVisibilityWhere(req.viewer);
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND ${pub} AND ${vis.clause}) AS article_count
    FROM categories c WHERE ${catVis.clause} ORDER BY c.sort_order, c.name`).all(...vis.params);
  const services = db.prepare('SELECT * FROM services ORDER BY sort_order, name').all();
  const featured = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN} WHERE ${pub} AND ${vis.clause} AND a.featured = 1 ORDER BY a.pinned DESC, a.updated_at DESC LIMIT 6`).all(...vis.params).map(articleCard);
  const recent = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN} WHERE ${pub} AND ${vis.clause} ORDER BY a.updated_at DESC LIMIT 6`).all(...vis.params).map(articleCard);
  const popular = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN} WHERE ${pub} AND ${vis.clause} ORDER BY a.views DESC LIMIT 6`).all(...vis.params).map(articleCard);
  res.json({ categories, services, featured, recent, popular });
});

/* ---------------- Public: articles ---------------- */

function getVisibleArticle(db, slug, viewer) {
  // follow redirects (with loop protection); report the final slug so the client URL updates
  const seen = new Set();
  let current = slug;
  let followed = false;
  const vis = visibilityClause(viewer);
  for (let i = 0; i < 5; i++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const art = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN}
      WHERE a.slug = ? AND a.status = 'published' AND ${vis.clause}`).get(current, ...vis.params);
    if (art) return followed ? { redirect: current } : { article: art };
    const redir = db.prepare('SELECT to_slug FROM redirects WHERE from_slug = ?').get(current);
    if (!redir) return null;
    current = redir.to_slug;
    followed = true;
  }
  return null;
}

app.get('/api/articles/:slug', attachViewer, (req, res) => {
  const db = getDb();
  const found = getVisibleArticle(db, req.params.slug, req.viewer);
  // 404 either way: a forbidden article is indistinguishable from a missing one (no title leak)
  if (!found) return res.status(404).json({ error: 'Article not found' });
  if (found.redirect) return res.json({ redirect: found.redirect });
  const a = found.article;
  // view counting: once per IP per day
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 80);
  const day = new Date().toISOString().slice(0, 10);
  try {
    db.prepare('INSERT INTO views_log (article_id, ip, day) VALUES (?, ?, ?)').run(a.id, ip, day);
    db.prepare('UPDATE articles SET views = views + 1 WHERE id = ?').run(a.id);
    a.views += 1;
  } catch {}
  const vis = visibilityClause(req.viewer);
  const html = addHeadingIds(sanitizeArticleHtml(a.content_html));
  const tags = db.prepare('SELECT t.name, t.slug FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ? ORDER BY t.name').all(a.id);
  const related = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN}
    WHERE a.status = 'published' AND ${vis.clause} AND a.id != ?
      AND (a.category_id = ? OR a.service_id = ? OR a.id IN (SELECT article_id FROM article_tags WHERE tag_id IN (SELECT tag_id FROM article_tags WHERE article_id = ?)))
    ORDER BY a.views DESC LIMIT 4`).all(...vis.params, a.id, a.category_id, a.service_id, a.id).map(articleCard);
  const prev = db.prepare(`SELECT a.id, a.title, a.slug FROM articles a ${ARTICLE_JOIN}
    WHERE a.status = 'published' AND ${vis.clause} AND a.published_at < ? ORDER BY a.published_at DESC LIMIT 1`).get(...vis.params, a.published_at);
  const next = db.prepare(`SELECT a.id, a.title, a.slug FROM articles a ${ARTICLE_JOIN}
    WHERE a.status = 'published' AND ${vis.clause} AND a.published_at > ? ORDER BY a.published_at ASC LIMIT 1`).get(...vis.params, a.published_at);
  const groups = a.visibility === 'groups'
    ? db.prepare('SELECT g.id, g.name, g.color FROM customer_groups g JOIN article_groups ag ON ag.group_id = g.id WHERE ag.article_id = ?').all(a.id)
    : [];
  const attachments = db.prepare(`SELECT id, original_name, stored_name, mime_type, size_bytes, kind, title, alt_text, caption
    FROM attachments WHERE article_id = ? ORDER BY uploaded_at`).all(a.id)
    .map(r => ({ ...r, url: `/media/${r.stored_name}` }));
  res.json({
    ...articleCard(a),
    content_html: html,
    toc: extractToc(html),
    tags,
    related,
    groups,
    attachments,
    author_name: a.author_name || '',
    prev: prev || null,
    next: next || null,
  });
});

app.post('/api/articles/:id/feedback', attachViewer, (req, res) => {
  const db = getDb();
  const vis = visibilityClause(req.viewer);
  const art = db.prepare(`SELECT a.id FROM articles a ${ARTICLE_JOIN} WHERE a.id = ? AND a.status = 'published' AND ${vis.clause}`)
    .get(req.params.id, ...vis.params);
  if (!art) return res.status(404).json({ error: 'Article not found' });
  const helpful = req.body && req.body.helpful ? 1 : 0;
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 80);
  db.prepare('INSERT INTO feedback (article_id, helpful, ip, created_at) VALUES (?, ?, ?, ?)')
    .run(art.id, helpful, ip, new Date().toISOString());
  db.prepare(`UPDATE articles SET ${helpful ? 'helpful_yes' : 'helpful_no'} = ${helpful ? 'helpful_yes' : 'helpful_no'} + 1 WHERE id = ?`).run(art.id);
  res.json({ ok: true });
});

/* ---------------- Public: search ---------------- */

function searchArticles(db, q, viewer, limit = 20) {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const like = terms.map(t => `%${t.replace(/[%_\\]/g, '\\$&')}%`);
  const conds = terms.map(() => `(a.title LIKE ? ESCAPE '\\' OR a.excerpt LIKE ? ESCAPE '\\' OR a.content_text LIKE ? ESCAPE '\\')`).join(' AND ');
  const params = [];
  like.forEach(l => params.push(l, l, l));
  const vis = visibilityClause(viewer);
  const rows = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN}
    WHERE a.status = 'published' AND ${vis.clause} AND (${conds}) LIMIT ${Number(limit) * 3}`).all(...vis.params, ...params);
  const ql = String(q).toLowerCase();
  const scored = rows.map(r => {
    const tl = r.title.toLowerCase();
    let score = 0;
    if (tl === ql) score += 100;
    if (tl.startsWith(ql)) score += 40;
    if (tl.includes(ql)) score += 25;
    if ((r.excerpt || '').toLowerCase().includes(ql)) score += 10;
    score += (r.featured ? 5 : 0) + Math.min(5, Math.log10(r.views + 1) * 2);
    return { r, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map(({ r, score }) => ({ ...articleCard(r), _score: Math.round(score) }));
}

app.get('/api/search', attachViewer, (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (!q) return res.json({ query: q, results: [] });
  const results = searchArticles(db, q, req.viewer);
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 80);
    db.prepare('INSERT INTO search_analytics (query, results_count, ip, created_at) VALUES (?, ?, ?, ?)')
      .run(q, results.length, ip, new Date().toISOString());
  } catch {}
  res.json({ query: q, results });
});

/* ---------------- Public: taxonomies ---------------- */

app.get('/api/categories', attachViewer, (req, res) => {
  const db = getDb();
  const vis = visibilityClause(req.viewer);
  const catVis = categoryVisibilityWhere(req.viewer);
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND a.status = 'published' AND ${vis.clause}) AS article_count
    FROM categories c WHERE ${catVis.clause} ORDER BY c.sort_order, c.name`).all(...vis.params));
});

app.get('/api/categories/:slug', attachViewer, (req, res) => {
  const db = getDb();
  const catVis = categoryVisibilityWhere(req.viewer);
  const cat = db.prepare(`SELECT * FROM categories c WHERE c.slug = ? AND ${catVis.clause}`).get(req.params.slug);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  const vis = visibilityClause(req.viewer);
  const articles = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN}
    WHERE a.status = 'published' AND ${vis.clause} AND a.category_id = ? ORDER BY a.pinned DESC, a.updated_at DESC`).all(...vis.params, cat.id).map(articleCard);
  res.json({ category: cat, articles });
});

app.get('/api/services', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM services ORDER BY sort_order, name').all());
});

app.get('/api/services/:slug', attachViewer, (req, res) => {
  const db = getDb();
  const svc = db.prepare('SELECT * FROM services WHERE slug = ?').get(req.params.slug);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  const vis = visibilityClause(req.viewer);
  const articles = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN}
    WHERE a.status = 'published' AND ${vis.clause} AND a.service_id = ? ORDER BY a.pinned DESC, a.updated_at DESC`).all(...vis.params, svc.id).map(articleCard);
  res.json({ service: svc, articles });
});

app.get('/api/tags', attachViewer, (req, res) => {
  const db = getDb();
  const vis = visibilityClause(req.viewer);
  res.json(db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM article_tags at JOIN articles a ON a.id = at.article_id ${ARTICLE_JOIN} WHERE at.tag_id = t.id AND a.status = 'published' AND ${vis.clause}) AS article_count
    FROM tags t ORDER BY t.name`).all(...vis.params));
});

app.get('/api/tags/:slug', attachViewer, (req, res) => {
  const db = getDb();
  const tag = db.prepare('SELECT * FROM tags WHERE slug = ?').get(req.params.slug);
  if (!tag) return res.status(404).json({ error: 'Not found' });
  const vis = visibilityClause(req.viewer);
  const articles = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN}
    JOIN article_tags at ON at.article_id = a.id
    WHERE a.status = 'published' AND ${vis.clause} AND at.tag_id = ? ORDER BY a.updated_at DESC`).all(...vis.params, tag.id).map(articleCard);
  res.json({ tag, articles });
});

/* ---------------- Public: reading progress ---------------- */

app.get('/api/progress', (req, res) => {
  const db = getDb();
  const anon = String(req.query.anon_key || '').slice(0, 64);
  const rows = anon
    ? db.prepare('SELECT article_id, progress FROM reading_progress WHERE anon_key = ? AND (user_id IS NULL)').all(anon)
    : [];
  const map = {};
  for (const r of rows) map[r.article_id] = r.progress;
  res.json({ progress: map });
});

app.post('/api/progress', (req, res) => {
  const db = getDb();
  const { article_id, progress, anon_key } = req.body || {};
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  if (!article_id) return res.status(400).json({ error: 'article_id required' });
  db.prepare(`INSERT INTO reading_progress (user_id, anon_key, article_id, progress, updated_at)
    VALUES (NULL, ?, ?, ?, ?) ON CONFLICT(article_id, user_id, anon_key) DO UPDATE SET progress = excluded.progress, updated_at = excluded.updated_at`)
    .run(String(anon_key || '').slice(0, 64), Number(article_id), p, new Date().toISOString());
  res.json({ ok: true });
});

/* ================= ADMIN ================= */

function saveArticleVersion(db, articleId, title, contentHtml, authorId, note) {
  const max = db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM article_versions WHERE article_id = ?').get(articleId).m;
  db.prepare(`INSERT INTO article_versions (article_id, version_number, title, content_html, author_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(articleId, max + 1, title, contentHtml, authorId ?? null, note || '', new Date().toISOString());
}

function syncArticleTags(db, articleId, tagNames) {
  db.prepare('DELETE FROM article_tags WHERE article_id = ?').run(articleId);
  const ins = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  for (const raw of tagNames || []) {
    const name = String(raw).trim().slice(0, 60);
    if (!name) continue;
    const slug = slugify(name);
    let tag = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug);
    if (!tag) tag = { id: db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(name, slug).lastInsertRowid };
    ins.run(articleId, tag.id);
  }
}

function syncArticleGroups(db, articleId, groupIds) {
  db.prepare('DELETE FROM article_groups WHERE article_id = ?').run(articleId);
  const ins = db.prepare('INSERT OR IGNORE INTO article_groups (article_id, group_id) VALUES (?, ?)');
  const valid = new Set(db.prepare('SELECT id FROM customer_groups').all().map(g => g.id));
  for (const gid of groupIds || []) {
    const n = Number(gid);
    if (valid.has(n)) ins.run(articleId, n);
  }
}

function sanitizeVisibility(v) {
  return ['all', 'groups', 'staff'].includes(v) ? v : 'all';
}

/** Publishing a "Customer groups" article with no group selected would hide
    it from everyone — refuse, so the mistake can never happen silently. */
function groupPublishError(visibility, status, groupIds) {
  if (visibility === 'groups' && status === 'published' && (!groupIds || !groupIds.length)) {
    return 'Choose at least one customer group before publishing a group-restricted article.';
  }
  return null;
}

app.get('/api/admin/stats', requireAuth, (req, res) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS n FROM articles").get().n;
  const published = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE status = 'published'").get().n;
  const drafts = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE status IN ('draft','scheduled')").get().n;
  const views = db.prepare('SELECT COALESCE(SUM(views),0) AS s FROM articles').get().s;
  const customers = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  const groups = db.prepare('SELECT COUNT(*) AS n FROM customer_groups').get().n;
  const fb = db.prepare('SELECT COALESCE(SUM(helpful),0) AS yes, COUNT(*) AS n FROM feedback').get();
  const activity = db.prepare(`SELECT al.*, u.display_name FROM activity_log al LEFT JOIN users u ON u.id = al.user_id ORDER BY al.created_at DESC LIMIT 15`).all();
  res.json({
    articles: total, published, drafts, views, customers, groups,
    feedback_score: fb.n ? Math.round((fb.yes / fb.n) * 100) : null,
    feedback_votes: fb.n, activity,
  });
});

/* ---- Articles ---- */

app.get('/api/admin/articles', requireAuth, (req, res) => {
  const db = getDb();
  const { status, category_id, service_id, q, visibility } = req.query;
  const conds = [];
  const params = [];
  if (status) { conds.push('a.status = ?'); params.push(status); }
  if (category_id) { conds.push('a.category_id = ?'); params.push(Number(category_id)); }
  if (service_id) { conds.push('a.service_id = ?'); params.push(Number(service_id)); }
  if (visibility) { conds.push('a.visibility = ?'); params.push(visibility); }
  if (q) { conds.push('(a.title LIKE ? OR a.slug LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN} ${where} ORDER BY a.updated_at DESC LIMIT 500`).all(...params);
  const groupMap = {};
  for (const r of db.prepare(`SELECT ag.article_id, g.id, g.name, g.color FROM article_groups ag
    JOIN customer_groups g ON g.id = ag.group_id ORDER BY g.name`).all()) {
    (groupMap[r.article_id] = groupMap[r.article_id] || []).push({ id: r.id, name: r.name, color: r.color });
  }
  res.json(rows.map(r => ({ ...articleCard(r), status: r.status, groups: groupMap[r.id] || [] })));
});

app.get('/api/admin/articles/:id', requireAuth, (req, res) => {
  const db = getDb();
  const a = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a ${ARTICLE_JOIN} WHERE a.id = ?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const tags = db.prepare('SELECT t.name FROM tags t JOIN article_tags at ON at.tag_id = t.id WHERE at.article_id = ?').all(a.id).map(t => t.name);
  const group_ids = db.prepare('SELECT group_id FROM article_groups WHERE article_id = ?').all(a.id).map(r => r.group_id);
  res.json({ ...a, tags, group_ids });
});

app.post('/api/admin/articles', requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Title is required' });
  const now = new Date().toISOString();
  // accept new content_html; fall back to legacy content_md (converted) for old imports
  let raw = b.content_html !== undefined ? String(b.content_html) : '';
  if (!raw && b.content_md !== undefined) {
    try { raw = marked.parse(String(b.content_md)); } catch { raw = ''; }
  }
  const content = sanitizeArticleHtml(raw);
  const slug = uniqueSlug(db, b.slug || b.title, 'articles');
  const status = ['draft', 'published', 'archived', 'scheduled'].includes(b.status) ? b.status : 'draft';
  const visibility = sanitizeVisibility(b.visibility);
  const gErr = groupPublishError(visibility, status, visibility === 'groups' ? (b.group_ids || []) : []);
  if (gErr) return res.status(400).json({ error: gErr });
  const id = db.prepare(`INSERT INTO articles
    (title, slug, content_html, content_text, excerpt, category_id, service_id, status, featured, pinned, visibility, author_id,
     reading_time_min, published_at, scheduled_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      String(b.title).trim(), slug, content, plainText(content), makeExcerpt(content),
      b.category_id || null, b.service_id || null, status,
      b.featured ? 1 : 0, b.pinned ? 1 : 0, visibility, req.user.id,
      readingTimeMin(content),
      status === 'published' ? now : '',
      status === 'scheduled' ? String(b.scheduled_at || '') : '',
      now, now
    ).lastInsertRowid;
  syncArticleTags(db, id, b.tags);
  syncArticleGroups(db, id, visibility === 'groups' ? b.group_ids : []);
  saveArticleVersion(db, id, String(b.title).trim(), content, req.user.id, 'Created');
  logActivity(db, req.user.id, 'article_create', `Created "${String(b.title).trim()}"`);
  res.json({ id, slug });
});

app.put('/api/admin/articles/:id', requireAuth, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const now = new Date().toISOString();
  const title = b.title !== undefined ? String(b.title).trim() : cur.title;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  let content;
  if (b.content_html !== undefined) content = sanitizeArticleHtml(String(b.content_html));
  else if (b.content_md !== undefined) { try { content = sanitizeArticleHtml(marked.parse(String(b.content_md))); } catch { content = cur.content_html; } }
  else content = cur.content_html;
  let slug = cur.slug;
  if (b.slug !== undefined && slugify(b.slug) && slugify(b.slug) !== cur.slug) {
    const newSlug = uniqueSlug(db, b.slug, 'articles', cur.id);
    // keep old slug working
    db.prepare('INSERT OR IGNORE INTO redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?)')
      .run(cur.slug, newSlug, now);
    slug = newSlug;
  }
  const status = ['draft', 'published', 'archived', 'scheduled'].includes(b.status) ? b.status : cur.status;
  const visibility = b.visibility !== undefined ? sanitizeVisibility(b.visibility) : cur.visibility;
  const existingGroupIds = db.prepare('SELECT group_id FROM article_groups WHERE article_id = ?').all(cur.id).map(r => r.group_id);
  const finalGroupIds = b.group_ids !== undefined ? b.group_ids : existingGroupIds;
  const gErr = groupPublishError(visibility, status, visibility === 'groups' ? finalGroupIds : []);
  if (gErr) return res.status(400).json({ error: gErr });
  const published_at = (status === 'published' && !cur.published_at) ? now : cur.published_at;
  db.prepare(`UPDATE articles SET title = ?, slug = ?, content_html = ?, content_text = ?, excerpt = ?, category_id = ?, service_id = ?,
    status = ?, featured = ?, pinned = ?, visibility = ?, reading_time_min = ?, published_at = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`)
    .run(
      title, slug, content, plainText(content), makeExcerpt(content),
      b.category_id !== undefined ? (b.category_id || null) : cur.category_id,
      b.service_id !== undefined ? (b.service_id || null) : cur.service_id,
      status,
      b.featured !== undefined ? (b.featured ? 1 : 0) : cur.featured,
      b.pinned !== undefined ? (b.pinned ? 1 : 0) : cur.pinned,
      visibility,
      readingTimeMin(content),
      published_at,
      status === 'scheduled' ? String(b.scheduled_at || cur.scheduled_at || '') : '',
      now, cur.id
    );
  if (b.tags !== undefined) syncArticleTags(db, cur.id, b.tags);
  if (b.group_ids !== undefined || b.visibility !== undefined) {
    syncArticleGroups(db, cur.id, visibility === 'groups' ? finalGroupIds : []);
  }
  if (content !== cur.content_html || title !== cur.title) {
    saveArticleVersion(db, cur.id, title, content, req.user.id, String(b.version_note || 'Edited'));
  }
  logActivity(db, req.user.id, 'article_update', `Updated "${title}"`);
  res.json({ id: cur.id, slug });
});

app.delete('/api/admin/articles/:id', requireAuth, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT title FROM articles WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  logActivity(db, req.user.id, 'article_delete', `Deleted "${cur.title}"`);
  res.json({ ok: true });
});

app.post('/api/admin/articles/bulk', requireAuth, (req, res) => {
  const db = getDb();
  const { ids, action, visibility, group_ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No articles selected' });
  if (action === 'publish') {
    const blocked = ids.map(Number).filter(Boolean).filter(id => {
      const a = db.prepare('SELECT visibility FROM articles WHERE id = ?').get(id);
      if (!a || a.visibility !== 'groups') return false;
      return db.prepare('SELECT COUNT(*) AS n FROM article_groups WHERE article_id = ?').get(id).n === 0;
    });
    if (blocked.length) {
      return res.status(400).json({ error: `${blocked.length} group-restricted article(s) have no customer group selected — assign a group before publishing.` });
    }
  }
  if (action === 'set-visibility' && sanitizeVisibility(visibility) === 'groups' && (!Array.isArray(group_ids) || !group_ids.length)) {
    return res.status(400).json({ error: 'Choose at least one customer group for group-restricted visibility.' });
  }
  const now = new Date().toISOString();
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids.map(Number).filter(Boolean)) {
      if (action === 'delete') {
        const r = db.prepare('DELETE FROM articles WHERE id = ?').run(id);
        n += r.changes;
      } else if (['publish', 'unpublish', 'archive'].includes(action)) {
        const status = action === 'publish' ? 'published' : action === 'unpublish' ? 'draft' : 'archived';
        const r = db.prepare(`UPDATE articles SET status = ?, updated_at = ?,
          published_at = CASE WHEN ? = 'published' AND published_at = '' THEN ? ELSE published_at END
          WHERE id = ?`).run(status, now, status, now, id);
        n += r.changes;
      } else if (action === 'set-visibility') {
        const vis = sanitizeVisibility(visibility);
        const r = db.prepare('UPDATE articles SET visibility = ?, updated_at = ? WHERE id = ?').run(vis, now, id);
        syncArticleGroups(db, id, vis === 'groups' ? group_ids : []);
        n += r.changes;
      }
    }
  });
  tx();
  logActivity(db, req.user.id, 'article_bulk', `${action} on ${n} article(s)`);
  res.json({ ok: true, affected: n });
});

/* ---- Versions ---- */

app.get('/api/admin/articles/:id/versions', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT v.*, u.display_name AS author_name FROM article_versions v
    LEFT JOIN users u ON u.id = v.author_id WHERE v.article_id = ? ORDER BY v.version_number DESC`).all(req.params.id);
  res.json(rows);
});

app.post('/api/admin/articles/:id/rollback/:versionId', requireAuth, (req, res) => {
  const db = getDb();
  const ver = db.prepare('SELECT * FROM article_versions WHERE id = ? AND article_id = ?').get(req.params.versionId, req.params.id);
  if (!ver) return res.status(404).json({ error: 'Version not found' });
  const now = new Date().toISOString();
  db.prepare('UPDATE articles SET title = ?, content_html = ?, content_text = ?, excerpt = ?, reading_time_min = ?, updated_at = ? WHERE id = ?')
    .run(ver.title, ver.content_html, plainText(ver.content_html), makeExcerpt(ver.content_html), readingTimeMin(ver.content_html), now, req.params.id);
  saveArticleVersion(db, req.params.id, ver.title, ver.content_html, req.user.id, `Rolled back to v${ver.version_number}`);
  logActivity(db, req.user.id, 'article_rollback', `Rolled back article #${req.params.id} to v${ver.version_number}`);
  res.json({ ok: true });
});

/* ---- Visibility "View as" tester (admin only — no leaking to non-staff) ---- */

app.get('/api/admin/visibility-preview', requireAuth, (req, res) => {
  const db = getDb();
  const mode = String(req.query.viewer || 'anon');
  let viewer = null;
  if (mode === 'staff') viewer = { type: 'staff' };
  else if (mode.startsWith('customer:')) {
    const cid = Number(mode.split(':')[1]);
    const cust = db.prepare('SELECT id, name, email, group_id FROM customers WHERE id = ? AND disabled = 0').get(cid);
    if (!cust) return res.status(400).json({ error: 'Customer not found' });
    viewer = { type: 'customer', id: cust.id, name: cust.name, email: cust.email, group_id: cust.group_id };
  } else if (mode !== 'anon') return res.status(400).json({ error: 'viewer must be anon, staff, or customer:<id>' });
  const vis = visibilityClause(viewer);
  const home = {
    featured: db.prepare(`SELECT a.title, a.slug FROM articles a ${ARTICLE_JOIN} WHERE a.status='published' AND ${vis.clause} AND a.featured=1 LIMIT 10`).all(...vis.params),
    recent: db.prepare(`SELECT a.title, a.slug FROM articles a ${ARTICLE_JOIN} WHERE a.status='published' AND ${vis.clause} ORDER BY a.updated_at DESC LIMIT 10`).all(...vis.params),
  };
  const catVis = categoryVisibilityWhere(viewer);
  const categories = db.prepare(`SELECT c.name, c.slug, c.visibility FROM categories c WHERE ${catVis.clause} ORDER BY c.sort_order`).all();
  const search = searchArticles(db, 'guide', viewer, 10).map(r => ({ title: r.title, slug: r.slug }));
  res.json({ viewer: mode, home, categories, search_sample: search });
});

/* ---- Taxonomy CRUD ---- */

function crudRoutes(base, table, fields) {
  app.get(`/api/admin/${base}`, requireAuth, (req, res) => {
    res.json(getDb().prepare(`SELECT * FROM ${table} ORDER BY sort_order, name`).all());
  });
  app.post(`/api/admin/${base}`, requireAuth, (req, res) => {
    const db = getDb();
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });
    const slug = uniqueSlug(db, b.slug || b.name, table);
    const cols = ['name', 'slug', ...fields];
    const vals = [String(b.name).trim(), slug, ...fields.map(f => b[f] ?? '')];
    const id = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid;
    logActivity(db, req.user.id, `${base}_create`, `Created ${table} "${String(b.name).trim()}"`);
    res.json({ id, slug });
  });
  app.put(`/api/admin/${base}/:id`, requireAuth, (req, res) => {
    const db = getDb();
    const b = req.body || {};
    const sets = [];
    const vals = [];
    for (const f of ['name', ...fields]) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'name' ? String(b[f]).trim() : b[f]); }
    }
    if (b.slug !== undefined && slugify(b.slug)) { sets.push('slug = ?'); vals.push(uniqueSlug(db, b.slug, table, Number(req.params.id))); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    logActivity(db, req.user.id, `${base}_update`, `Updated ${table} #${req.params.id}`);
    res.json({ ok: true });
  });
  app.delete(`/api/admin/${base}/:id`, requireAuth, (req, res) => {
    const db = getDb();
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    logActivity(db, req.user.id, `${base}_delete`, `Deleted ${table} #${req.params.id}`);
    res.json({ ok: true });
  });
}

crudRoutes('categories', 'categories', ['description', 'icon', 'icon_image', 'cover_image', 'color', 'parent_id', 'sort_order', 'visibility']);
crudRoutes('services', 'services', ['description', 'icon', 'color', 'sort_order']);

app.get('/api/admin/tags', requireAuth, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM tags ORDER BY name').all());
});
app.delete('/api/admin/tags/:id', requireAuth, (req, res) => {
  getDb().prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---- Redirects ---- */

app.get('/api/admin/redirects', requireAuth, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM redirects ORDER BY created_at DESC').all());
});
app.post('/api/admin/redirects', requireAuth, (req, res) => {
  const db = getDb();
  const { from_slug, to_slug } = req.body || {};
  if (!from_slug || !to_slug) return res.status(400).json({ error: 'Both slugs are required' });
  try {
    const id = db.prepare('INSERT INTO redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?)')
      .run(slugify(from_slug), slugify(to_slug), new Date().toISOString()).lastInsertRowid;
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'That source slug already has a redirect' });
  }
});
app.delete('/api/admin/redirects/:id', requireAuth, (req, res) => {
  getDb().prepare('DELETE FROM redirects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---- Users (admin only) ---- */

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  res.json(getDb().prepare('SELECT id, email, display_name, role, disabled, created_at FROM users ORDER BY created_at').all());
});
app.post('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDb();
  const { email, password, display_name, role } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email and a password of 8+ characters are required' });
  try {
    const id = db.prepare('INSERT INTO users (email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(email).trim().toLowerCase(), hashPassword(password), String(display_name || email).slice(0, 80),
        ['admin', 'editor', 'viewer'].includes(role) ? role : 'editor', new Date().toISOString()).lastInsertRowid;
    logActivity(db, req.user.id, 'user_create', `Invited ${email}`);
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'That email is already registered' });
  }
});
app.put('/api/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.display_name !== undefined) { sets.push('display_name = ?'); vals.push(String(b.display_name).slice(0, 80)); }
  if (b.role !== undefined && ['admin', 'editor', 'viewer'].includes(b.role)) { sets.push('role = ?'); vals.push(b.role); }
  if (b.disabled !== undefined) { sets.push('disabled = ?'); vals.push(b.disabled ? 1 : 0); }
  if (b.password) { sets.push('password_hash = ?'); vals.push(hashPassword(b.password)); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  if (Number(req.params.id) === req.user.id && b.disabled) return res.status(400).json({ error: 'You cannot disable your own account' });
  vals.push(req.params.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logActivity(db, req.user.id, 'user_update', `Updated user #${req.params.id}`);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  getDb().prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logActivity(db, req.user.id, 'user_delete', `Deleted user #${req.params.id}`);
  res.json({ ok: true });
});

/* ---- Customer groups (admin) ---- */

app.get('/api/admin/groups', requireAuth, (req, res) => {
  const db = getDb();
  res.json(db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM customers c WHERE c.group_id = g.id) AS customer_count
    FROM customer_groups g ORDER BY g.name`).all());
});
app.post('/api/admin/groups', requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });
  const slug = uniqueSlug(db, b.slug || b.name, 'customer_groups');
  const id = db.prepare('INSERT INTO customer_groups (name, slug, color, description, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(String(b.name).trim(), slug, String(b.color || '#8B5CF6').slice(0, 20), String(b.description || '').slice(0, 500), new Date().toISOString()).lastInsertRowid;
  logActivity(db, req.user.id, 'group_create', `Created group "${String(b.name).trim()}"`);
  res.json({ id, slug });
});
app.put('/api/admin/groups/:id', requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.name !== undefined && String(b.name).trim()) { sets.push('name = ?'); vals.push(String(b.name).trim()); }
  if (b.slug !== undefined && slugify(b.slug)) { sets.push('slug = ?'); vals.push(uniqueSlug(db, b.slug, 'customer_groups', Number(req.params.id))); }
  if (b.color !== undefined) { sets.push('color = ?'); vals.push(String(b.color).slice(0, 20)); }
  if (b.description !== undefined) { sets.push('description = ?'); vals.push(String(b.description).slice(0, 500)); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE customer_groups SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logActivity(db, req.user.id, 'group_update', `Updated group #${req.params.id}`);
  res.json({ ok: true });
});
app.delete('/api/admin/groups/:id', requireAuth, (req, res) => {
  const db = getDb();
  const linked = db.prepare('SELECT COUNT(*) AS n FROM article_groups WHERE group_id = ?').get(req.params.id).n;
  if (linked > 0) return res.status(400).json({ error: `This group is used by ${linked} article restriction(s). Remove those first.` });
  db.prepare('DELETE FROM customer_groups WHERE id = ?').run(req.params.id);
  logActivity(db, req.user.id, 'group_delete', `Deleted group #${req.params.id}`);
  res.json({ ok: true });
});

/* ---- Customers (admin) ---- */

function randomPassword(len = 12) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  let out = '';
  const buf = require('crypto').randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

app.get('/api/admin/customers', requireAuth, (req, res) => {
  const db = getDb();
  const { q, group_id, disabled } = req.query;
  const conds = [];
  const params = [];
  if (q) { conds.push('(c.name LIKE ? OR c.email LIKE ? OR c.company LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (group_id) { conds.push('c.group_id = ?'); params.push(Number(group_id)); }
  if (disabled !== undefined && disabled !== '') { conds.push('c.disabled = ?'); params.push(disabled === '1' ? 1 : 0); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  res.json(db.prepare(`SELECT c.id, c.name, c.email, c.company, c.phone, c.notes, c.group_id,
      g.name AS group_name, g.color AS group_color, c.disabled, c.created_at, c.last_login_at
    FROM customers c LEFT JOIN customer_groups g ON g.id = c.group_id ${where}
    ORDER BY c.name LIMIT 500`).all(...params));
});

app.post('/api/admin/customers', requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  const tempPassword = b.password && String(b.password).length >= 8 ? String(b.password) : randomPassword();
  try {
    const id = db.prepare(`INSERT INTO customers (name, email, password_hash, company, phone, notes, group_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(b.name).trim(), email, hashPassword(tempPassword),
        String(b.company || '').slice(0, 200), String(b.phone || '').slice(0, 60),
        String(b.notes || '').slice(0, 2000), b.group_id || null, new Date().toISOString()).lastInsertRowid;
    logActivity(db, req.user.id, 'customer_create', `Added customer ${email}`);
    res.json({ id, temp_password: tempPassword });
  } catch {
    res.status(400).json({ error: 'That email is already registered' });
  }
});

app.put('/api/admin/customers/:id', requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.name !== undefined) { sets.push('name = ?'); vals.push(String(b.name).trim().slice(0, 200)); }
  if (b.email !== undefined) {
    const email = String(b.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    sets.push('email = ?'); vals.push(email);
  }
  if (b.company !== undefined) { sets.push('company = ?'); vals.push(String(b.company).slice(0, 200)); }
  if (b.phone !== undefined) { sets.push('phone = ?'); vals.push(String(b.phone).slice(0, 60)); }
  if (b.notes !== undefined) { sets.push('notes = ?'); vals.push(String(b.notes).slice(0, 2000)); }
  if (b.group_id !== undefined) { sets.push('group_id = ?'); vals.push(b.group_id ? Number(b.group_id) : null); }
  if (b.disabled !== undefined) { sets.push('disabled = ?'); vals.push(b.disabled ? 1 : 0); }
  let newPassword = '';
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    sets.push('password_hash = ?'); vals.push(hashPassword(b.password));
    newPassword = String(b.password);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    vals.push(req.params.id);
    db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  } catch {
    return res.status(400).json({ error: 'That email is already registered' });
  }
  logActivity(db, req.user.id, 'customer_update', `Updated customer #${req.params.id}`);
  res.json({ ok: true, ...(newPassword ? { temp_password: newPassword } : {}) });
});

app.delete('/api/admin/customers/:id', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  logActivity(db, req.user.id, 'customer_delete', `Deleted customer #${req.params.id}`);
  res.json({ ok: true });
});

app.post('/api/admin/customers/bulk-assign', requireAuth, (req, res) => {
  const db = getDb();
  const { ids, group_id } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No customers selected' });
  const gid = group_id ? Number(group_id) : null;
  if (gid && !db.prepare('SELECT id FROM customer_groups WHERE id = ?').get(gid)) {
    return res.status(400).json({ error: 'Group not found' });
  }
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids.map(Number).filter(Boolean)) {
      n += db.prepare('UPDATE customers SET group_id = ? WHERE id = ?').run(gid, id).changes;
    }
  });
  tx();
  logActivity(db, req.user.id, 'customer_bulk_assign', `Assigned ${n} customer(s) to group ${gid || 'none'}`);
  res.json({ ok: true, affected: n });
});

/* Minimal CSV parser: handles quoted fields, commas and newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

/** CSV import with column mapping. Body: { csv, mapping: {name, email, company, phone, notes}, group_id, default_password?, skip_header? } */
app.post('/api/admin/customers/import', requireAuth, (req, res) => {
  const db = getDb();
  const { csv, mapping, group_id, default_password, skip_header } = req.body || {};
  const map = mapping || {};
  const rows = parseCsv(csv);
  if (!rows.length) return res.status(400).json({ error: 'No rows found in the CSV' });
  const dataRows = skip_header === false ? rows : rows.slice(1);
  const col = (r, key) => {
    const idx = Number(map[key]);
    return Number.isFinite(idx) && idx >= 0 && idx < r.length ? r[idx].trim() : '';
  };
  const gid = group_id ? Number(group_id) : null;
  if (gid && !db.prepare('SELECT id FROM customer_groups WHERE id = ?').get(gid)) {
    return res.status(400).json({ error: 'Group not found' });
  }
  const defPw = default_password && String(default_password).length >= 8 ? String(default_password) : randomPassword();
  const imported = [];
  const errors = [];
  const tx = db.transaction(() => {
    dataRows.forEach((r, i) => {
      const lineNo = i + (skip_header === false ? 1 : 2);
      const name = col(r, 'name');
      const email = col(r, 'email').toLowerCase();
      if (!name) { errors.push({ row: lineNo, error: 'Missing name' }); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errors.push({ row: lineNo, error: `Invalid email "${col(r, 'email')}"` }); return; }
      try {
        const id = db.prepare(`INSERT INTO customers (name, email, password_hash, company, phone, notes, group_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(name.slice(0, 200), email, hashPassword(defPw),
            col(r, 'company').slice(0, 200), col(r, 'phone').slice(0, 60), col(r, 'notes').slice(0, 2000),
            gid, new Date().toISOString()).lastInsertRowid;
        imported.push({ id, name, email });
      } catch {
        errors.push({ row: lineNo, error: `Duplicate email "${email}"` });
      }
    });
  });
  tx();
  logActivity(db, req.user.id, 'customer_import', `Imported ${imported.length} customer(s), ${errors.length} error(s)`);
  res.json({ ok: true, imported: imported.length, customers: imported, errors, default_password: defPw });
});

/* ---- Attachments / media library ---- */

app.post('/api/admin/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const db = getDb();
    const out = insertAttachment(db, req.file, req.user.id, req.body.article_id || null);
    logActivity(db, req.user.id, 'upload', `Uploaded ${req.file.originalname}`);
    res.json(out);
  });
});

app.post('/api/admin/upload-multi', requireAuth, (req, res) => {
  upload.array('files', 40)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });
    const db = getDb();
    const out = req.files.map(f => insertAttachment(db, f, req.user.id, req.body.article_id || null));
    logActivity(db, req.user.id, 'upload', `Uploaded ${req.files.length} file(s)`);
    res.json({ files: out });
  });
});

app.get('/api/admin/attachments', requireAuth, (req, res) => {
  const db = getDb();
  const { q, kind, sort } = req.query;
  const conds = [];
  const params = [];
  if (q) { conds.push('(a.original_name LIKE ? OR a.title LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (kind && ['image', 'video', 'audio', 'file'].includes(kind)) { conds.push('a.kind = ?'); params.push(kind); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const order = sort === 'oldest' ? 'a.uploaded_at ASC'
    : sort === 'name' ? 'a.original_name COLLATE NOCASE ASC'
    : sort === 'size' ? 'a.size_bytes DESC' : 'a.uploaded_at DESC';
  res.json(db.prepare(`SELECT a.*, u.display_name AS uploaded_by_name, ar.title AS article_title
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by LEFT JOIN articles ar ON ar.id = a.article_id
    ${where} ORDER BY ${order} LIMIT 1000`).all(...params)
    .map(r => ({ ...r, url: `/media/${r.stored_name}` })));
});

app.put('/api/admin/attachments/:id', requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const sets = [];
  const vals = [];
  if (b.title !== undefined) { sets.push('title = ?'); vals.push(String(b.title).slice(0, 200)); }
  if (b.alt_text !== undefined) { sets.push('alt_text = ?'); vals.push(String(b.alt_text).slice(0, 500)); }
  if (b.caption !== undefined) { sets.push('caption = ?'); vals.push(String(b.caption).slice(0, 500)); }
  if (b.article_id !== undefined) { sets.push('article_id = ?'); vals.push(b.article_id ? Number(b.article_id) : null); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  const r = db.prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/admin/attachments/bulk-delete', requireAuth, (req, res) => {
  const db = getDb();
  const ids = (req.body && Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'No files selected' });
  let n = 0;
  for (const id of ids) {
    const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(id);
    if (!row) continue;
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, row.stored_name)); } catch {}
    n++;
  }
  logActivity(db, req.user.id, 'upload_delete', `Deleted ${n} media file(s)`);
  res.json({ ok: true, deleted: n });
});

app.delete('/api/admin/attachments/:id', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, row.stored_name)); } catch {}
  res.json({ ok: true });
});

/* ---- Settings (includes Site & Branding) ---- */

app.get('/api/admin/settings', requireAuth, (req, res) => {
  res.json(getSettings(getDb()));
});
app.put('/api/admin/settings', requireAuth, (req, res) => {
  const db = getDb();
  const body = { ...(req.body || {}) };
  if (body.custom_css !== undefined) body.custom_css = sanitizeCustomCss(body.custom_css);
  const s = setSettings(db, body);
  logActivity(db, req.user.id, 'settings', 'Updated site settings');
  res.json(s);
});

/* ---- Feedback inbox & search analytics ---- */

app.get('/api/admin/feedback', requireAuth, (req, res) => {
  const db = getDb();
  res.json(db.prepare(`SELECT a.id, a.title, a.slug, a.helpful_yes, a.helpful_no,
      (SELECT COUNT(*) FROM feedback f WHERE f.article_id = a.id AND f.helpful = 0) AS recent_no
    FROM articles a WHERE a.helpful_yes + a.helpful_no > 0 ORDER BY (a.helpful_no * 1.0 / (a.helpful_yes + a.helpful_no)) DESC`).all());
});

app.get('/api/admin/search-analytics', requireAuth, (req, res) => {
  const db = getDb();
  const top = db.prepare(`SELECT query, COUNT(*) AS searches, AVG(results_count) AS avg_results,
      MAX(created_at) AS last_searched FROM search_analytics
    WHERE created_at > datetime('now', '-30 days')
    GROUP BY query ORDER BY searches DESC LIMIT 50`).all();
  const noResult = db.prepare(`SELECT query, COUNT(*) AS searches, MAX(created_at) AS last_searched
    FROM search_analytics WHERE results_count = 0 AND created_at > datetime('now', '-30 days')
    GROUP BY query ORDER BY searches DESC LIMIT 50`).all();
  res.json({ top, no_result: noResult });
});

app.get('/api/admin/activity', requireAuth, (req, res) => {
  res.json(getDb().prepare(`SELECT al.*, u.display_name FROM activity_log al
    LEFT JOIN users u ON u.id = al.user_id ORDER BY al.created_at DESC LIMIT 100`).all());
});

/* ---- Import / export ---- */

app.get('/api/admin/export', requireAuth, (req, res) => {
  const db = getDb();
  const data = {
    exported_at: new Date().toISOString(),
    format: 'xc-wiki-v2',
    settings: getSettings(db),
    categories: db.prepare('SELECT * FROM categories').all(),
    services: db.prepare('SELECT * FROM services').all(),
    tags: db.prepare('SELECT * FROM tags').all(),
    articles: db.prepare('SELECT * FROM articles').all(),
    article_tags: db.prepare('SELECT * FROM article_tags').all(),
    article_groups: (() => { try { return db.prepare('SELECT * FROM article_groups').all(); } catch { return []; } })(),
    article_versions: db.prepare('SELECT * FROM article_versions').all(),
    redirects: db.prepare('SELECT * FROM redirects').all(),
    customer_groups: db.prepare('SELECT id, name, slug, color, description, created_at FROM customer_groups').all(),
  };
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="xc-wiki-export.json"' });
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/admin/import', requireAuth, (req, res) => {
  const db = getDb();
  const data = req.body || {};
  if (!data.articles || !Array.isArray(data.articles)) return res.status(400).json({ error: 'Invalid export file' });
  let imported = 0;
  const tx = db.transaction(() => {
    for (const a of data.articles) {
      if (!a.title) continue;
      const slug = uniqueSlug(db, a.slug || a.title, 'articles');
      const now = new Date().toISOString();
      let html = '';
      if (a.content_html) html = sanitizeArticleHtml(a.content_html);
      else if (a.content_md) { try { html = sanitizeArticleHtml(marked.parse(String(a.content_md))); } catch {} }
      const id = db.prepare(`INSERT INTO articles
        (title, slug, content_html, content_text, excerpt, category_id, service_id, status, featured, pinned, visibility, author_id, reading_time_min, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, 'draft', 0, 0, 'all', ?, ?, '', ?, ?)`)
        .run(a.title, slug, html, plainText(html), makeExcerpt(html), req.user.id, readingTimeMin(html), now, now);
      saveArticleVersion(db, id, a.title, html, req.user.id, 'Imported');
      imported++;
    }
  });
  tx();
  logActivity(db, req.user.id, 'import', `Imported ${imported} article(s) as drafts`);
  res.json({ ok: true, imported });
});

/* ================= DEMO CONTENT MANAGER (admin) ================= */

app.get('/api/admin/demo', requireAuth, (req, res) => {
  res.json(demoLib.demoCounts(getDb()));
});

app.post('/api/admin/demo/remove', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const r = demoLib.removeDemo(db);
    logActivity(db, req.user.id, 'demo_remove',
      `Removed demo content: ${r.removed.articles} articles, ${r.removed.categories} categories, ${r.removed.services} services, ${r.removed.customers} customers, ${r.removed.groups} groups`);
    res.json({ ok: true, ...r, counts: demoLib.demoCounts(db) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/demo/restore', requireAuth, (req, res) => {
  const db = getDb();
  try {
    const r = demoLib.restoreDemo(db);
    logActivity(db, req.user.id, 'demo_restore',
      `Restored demo content: ${r.articles} articles, ${r.categories} categories, ${r.services} services, ${r.customers} customers, ${r.groups} groups`);
    res.json({ ok: true, restored: r, counts: demoLib.demoCounts(db) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ================= BOOKSTACK IMPORT (admin) =================
   The admin may save the connection (URL + Token ID + Secret) for later
   imports; the secret is stored encrypted (see lib/bookstack.js) and no
   endpoint ever returns it. Runs use freshly typed credentials when
   provided, otherwise the saved connection. */

app.get('/api/admin/bookstack/connection', requireAuth, (req, res) => {
  res.json(bookstack.publicConnection(getDb()));
});

app.put('/api/admin/bookstack/connection', requireAuth, (req, res) => {
  try {
    const view = bookstack.saveConnection(getDb(), req.body || {});
    logActivity(getDb(), req.user.id, 'bookstack_connection', 'Saved the BookStack API connection');
    res.json(view);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/bookstack/connection', requireAuth, (req, res) => {
  const view = bookstack.removeConnection(getDb());
  logActivity(getDb(), req.user.id, 'bookstack_connection', 'Removed the saved BookStack API connection');
  res.json(view);
});

app.post('/api/admin/bookstack/test', requireAuth, async (req, res) => {
  try {
    res.json(await bookstack.testConnection(getDb(), req.body || {}));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/bookstack/import', requireAuth, (req, res) => {
  try {
    const job = bookstack.startImport(getDb(), req.body || {}, req.user.id);
    res.json({ ok: true, job });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/bookstack/import/status', requireAuth, (req, res) => {
  const job = bookstack.getImportJob(req.query.id ? String(req.query.id) : null);
  res.json({ job: job ? bookstack.publicJob(job) : null });
});

/* ================= CLOUD BACKUP (admin) ================= */

app.get('/api/admin/cloud/connections', requireAuth, (req, res) => {
  const db = getDb();
  res.json({
    google: cloud.publicConnection(db, 'google'),
    onedrive: cloud.publicConnection(db, 'onedrive'),
  });
});

app.post('/api/admin/cloud/credentials', requireAuth, (req, res) => {
  const db = getDb();
  const { provider, client_id, client_secret } = req.body || {};
  try {
    const conn = cloud.saveClientCreds(db, provider, client_id, client_secret);
    logActivity(db, req.user.id, 'cloud_credentials', `Saved ${provider} OAuth client credentials`);
    res.json(conn);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/cloud/auth-url/:provider', requireAuth, (req, res) => {
  const db = getDb();
  try {
    res.json(cloud.authUrl(db, req, req.params.provider));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* OAuth callback (provider redirects here). Not Bearer-authed by design —
   the CSRF `state` parameter is the authorization. */
app.get('/api/admin/cloud/callback/:provider', async (req, res) => {
  const db = getDb();
  const provider = req.params.provider;
  const { code, state, error, error_description } = req.query;
  const done = (ok, msg) => res.send(
    `<html><body style="font-family:sans-serif;padding:40px"><h2>${ok ? '✅ Connected' : '❌ Connection failed'}</h2>` +
    `<p>${ok ? `Your ${provider === 'google' ? 'Google Drive' : 'OneDrive'} account is connected. You can close this tab and return to XC Wiki.` : `Error: ${msg || 'unknown'}`}</p>` +
    `<script>setTimeout(()=>window.close(), 4000)</script></body></html>`);
  if (error) return done(false, String(error_description || error));
  if (!code || !cloud.consumeOAuthState(String(state || ''), provider)) {
    return done(false, 'Invalid or expired login session — please try again from XC Wiki.');
  }
  try {
    const tokens = await cloud.exchangeCode(db, provider, String(code), cloud.redirectUriFor(req, provider));
    cloud.storeTokens(db, provider, tokens);
    logActivity(db, null, 'cloud_connected', `${provider} connected for backups`);
    done(true);
  } catch (e) {
    cloud.markError(db, provider, e.message);
    done(false, e.message);
  }
});

app.delete('/api/admin/cloud/connections/:provider', requireAuth, (req, res) => {
  const db = getDb();
  cloud.disconnect(db, req.params.provider);
  logActivity(db, req.user.id, 'cloud_disconnect', `Disconnected ${req.params.provider}`);
  res.json({ ok: true });
});

app.post('/api/admin/cloud/backup/:provider', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const r = await cloud.runBackup(db, req.params.provider);
    logActivity(db, req.user.id, 'cloud_backup', `Manual backup to ${req.params.provider}: ${r.filename}`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/cloud/backups', requireAuth, (req, res) => {
  res.json(cloud.listBackups(getDb()));
});

app.get('/api/admin/cloud/backups/:id/download', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const dl = await cloud.downloadBackup(db, req.params.id);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${dl.filename}"` });
    const stream = fs.createReadStream(dl.zipPath);
    stream.on('close', () => fs.rmSync(dl.tmpDir, { recursive: true, force: true }));
    stream.pipe(res);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/admin/cloud/backups/:id', requireAuth, async (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT * FROM backup_records WHERE id = ?').get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Backup not found' });
  // best-effort remote delete; the local record is removed regardless
  try { await cloud.deleteRemoteFile(db, rec.provider, rec.drive_file_id); } catch (e) { /* keep going */ }
  db.prepare('DELETE FROM backup_records WHERE id = ?').run(req.params.id);
  logActivity(db, req.user.id, 'cloud_backup_delete', `Deleted backup ${rec.filename}`);
  res.json({ ok: true });
});

app.post('/api/admin/cloud/restore/:id', requireAuth, async (req, res) => {
  const db = getDb();
  try {
    const r = await cloud.restoreBackup(db, req.params.id);
    logActivity(getDb(), req.user.id, 'cloud_restore', `Restored backup ${r.record.filename}`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/cloud/settings', requireAuth, (req, res) => {
  res.json(cloud.getBackupSettings(getDb()));
});

app.put('/api/admin/cloud/settings', requireAuth, (req, res) => {
  try {
    const s = cloud.saveBackupSettings(getDb(), req.body || {});
    logActivity(getDb(), req.user.id, 'cloud_settings', 'Updated backup schedule settings');
    res.json(s);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---- Scheduled publishing + auto-backup tick ---- */

setInterval(() => {
  try {
    const db = getDb();
    const due = db.prepare(`SELECT id, title FROM articles WHERE status = 'scheduled' AND scheduled_at != '' AND scheduled_at <= ?`).all(new Date().toISOString());
    for (const a of due) {
      db.prepare(`UPDATE articles SET status = 'published', published_at = ?, scheduled_at = '', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), new Date().toISOString(), a.id);
      logActivity(db, null, 'schedule_publish', `Auto-published "${a.title}"`);
    }
    cloud.checkAutoBackup(db).catch(e => console.error('auto-backup:', e.message));
  } catch {}
}, 60000);

/* ---------------- SPA fallback ---------------- */

/* Sanitize + return article HTML for the editor preview pane. */
app.post('/api/admin/preview', requireAuth, (req, res) => {
  res.json({ html: addHeadingIds(sanitizeArticleHtml(String((req.body || {}).html || (req.body || {}).md || ''))) });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  ensureSettingsSeed(getDb());
  console.log(`XC Wiki listening on port ${PORT}`);
});
