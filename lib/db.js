'use strict';
/* SQLite schema, settings access, migrations and seed data for XC Wiki. */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');
const { sanitizeArticleHtml } = require('./html');
const { hashPassword } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'xcwiki.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fresh = !fs.existsSync(DB_PATH);
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  createSchema(_db);
  runMigrations(_db);
  if (fresh) seed(_db);
  return _db;
}

function closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

function reopenDb() {
  closeDb();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  createSchema(_db);
  runMigrations(_db);
  return _db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT '📄',
      icon_image TEXT DEFAULT '',
      cover_image TEXT DEFAULT '',
      color TEXT DEFAULT '#3B82F6',
      parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'all'
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT '🖥️',
      color TEXT DEFAULT '#8B5CF6',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      content_html TEXT NOT NULL DEFAULT '',
      excerpt TEXT DEFAULT '',
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      featured INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'all',
      content_text TEXT NOT NULL DEFAULT '',
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author_name TEXT DEFAULT '',
      views INTEGER NOT NULL DEFAULT 0,
      helpful_yes INTEGER NOT NULL DEFAULT 0,
      helpful_no INTEGER NOT NULL DEFAULT 0,
      reading_time_min INTEGER NOT NULL DEFAULT 1,
      published_at TEXT DEFAULT '',
      scheduled_at TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
    CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category_id);
    CREATE INDEX IF NOT EXISTS idx_articles_service ON articles(service_id);
    CREATE TABLE IF NOT EXISTS article_groups (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (article_id, group_id)
    );
    CREATE TABLE IF NOT EXISTS article_tags (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (article_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS article_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      content_html TEXT NOT NULL DEFAULT '',
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_versions_article ON article_versions(article_id);
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER REFERENCES articles(id) ON DELETE SET NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at TEXT NOT NULL,
      title TEXT DEFAULT '',
      alt_text TEXT DEFAULT '',
      caption TEXT DEFAULT '',
      kind TEXT DEFAULT 'file',
      external_key TEXT DEFAULT ''
    );
    /* Registry of seeded demo rows, used by the Demo Content manager so
       remove/restore only ever touches seeded content. */
    CREATE TABLE IF NOT EXISTS demo_rows (
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      PRIMARY KEY (table_name, row_id)
    );
    /* Generic source->local id map for importers (BookStack etc.). */
    CREATE TABLE IF NOT EXISTS import_map (
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      local_id INTEGER,
      PRIMARY KEY (source, kind, source_id)
    );
    /* Saved BookStack connection (singleton row, id = 1). The API Token
       Secret lives only inside credentials_encrypted (AES-256-GCM via
       lib/crypto.js, same pattern as cloud_connections). */
    CREATE TABLE IF NOT EXISTS bookstack_connection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_url TEXT DEFAULT '',
      token_id TEXT DEFAULT '',
      credentials_encrypted TEXT DEFAULT '',
      saved_at TEXT DEFAULT ''
    );
    /* Completed BookStack import runs with their full timestamped logs.
       Only the last 3 runs are kept; older rows are pruned when a new
       run is recorded (see lib/bookstack.js persistRun). Log lines never
       contain credentials. */
    CREATE TABLE IF NOT EXISTS bookstack_import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      base_url TEXT DEFAULT '',
      error TEXT DEFAULT '',
      summary_json TEXT DEFAULT '{}',
      log_json TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS redirects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_slug TEXT NOT NULL UNIQUE,
      to_slug TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      helpful INTEGER NOT NULL,
      ip TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_article ON feedback(article_id);
    CREATE TABLE IF NOT EXISTS search_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      results_count INTEGER NOT NULL DEFAULT 0,
      ip TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_created ON search_analytics(created_at);
    CREATE TABLE IF NOT EXISTS reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      anon_key TEXT DEFAULT '',
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      progress REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE (article_id, user_id, anon_key)
    );
    CREATE TABLE IF NOT EXISTS views_log (
      article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      ip TEXT NOT NULL DEFAULT '',
      day TEXT NOT NULL,
      PRIMARY KEY (article_id, ip, day)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

    /* ---- customers & groups ---- */
    CREATE TABLE IF NOT EXISTS customer_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#8B5CF6',
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      company TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      group_id INTEGER REFERENCES customer_groups(id) ON DELETE SET NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_login_at TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS customer_tokens (
      token TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_tokens_hash ON password_tokens(token_hash);

    /* ---- cloud backup ---- */
    CREATE TABLE IF NOT EXISTS cloud_connections (
      provider TEXT PRIMARY KEY,
      client_id TEXT DEFAULT '',
      credentials_encrypted TEXT DEFAULT '',
      folder_id TEXT DEFAULT '',
      folder_name TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'disconnected',
      connected_at TEXT DEFAULT '',
      last_error TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS backup_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      provider TEXT NOT NULL,
      drive_file_id TEXT DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      summary_json TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ok',
      is_safety INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS scheduler_state (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT ''
    );
  `);
}

/* Lightweight migrations for databases created before a column/table existed. */
function runMigrations(db) {
  const addCols = [
    ['articles', 'scheduled_at', `TEXT DEFAULT ''`],
    ['articles', 'content_html', `TEXT NOT NULL DEFAULT ''`],
    ['articles', 'content_text', `TEXT NOT NULL DEFAULT ''`],
    ['articles', 'visibility', `TEXT NOT NULL DEFAULT 'all'`],
    ['articles', 'author_name', `TEXT DEFAULT ''`],
    ['article_versions', 'content_html', `TEXT NOT NULL DEFAULT ''`],
    ['categories', 'visibility', `TEXT NOT NULL DEFAULT 'all'`],
    ['categories', 'icon_image', `TEXT DEFAULT ''`],
    ['categories', 'cover_image', `TEXT DEFAULT ''`],
    ['customers', 'last_login_at', `TEXT DEFAULT ''`],
    ['attachments', 'title', `TEXT DEFAULT ''`],
    ['attachments', 'alt_text', `TEXT DEFAULT ''`],
    ['attachments', 'caption', `TEXT DEFAULT ''`],
    ['attachments', 'kind', `TEXT DEFAULT 'file'`],
    ['attachments', 'external_key', `TEXT DEFAULT ''`],
  ];
  for (const [table, col, def] of addCols) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* already applied */ }
  }
  // dedupe index for importer-managed media — after the column exists (above)
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_external_key ON attachments(external_key) WHERE external_key != ''`); } catch {}
  // category covers supersede the short-lived icon_image: carry values over
  try { db.exec(`UPDATE categories SET cover_image = icon_image WHERE (cover_image IS NULL OR cover_image = '') AND icon_image != ''`); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_articles_visibility ON articles(visibility)'); } catch {}
  migrateMarkdownToHtml(db);
  seedDemoCustomers(db);
  try { require('./demo').ensureRegistry(db); } catch {}
}

/* One-time conversion: render every Markdown article/version to sanitized HTML,
   then drop the old content_md columns. */
function migrateMarkdownToHtml(db) {
  const hasHtml = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('articles') WHERE name = 'content_html'`).get().n;
  if (!hasHtml) return;
  const hasMd = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('articles') WHERE name = 'content_md'`).get().n;
  if (!hasMd) return; // already migrated
  marked.setOptions({ breaks: true, gfm: true });
  const convert = (md) => sanitizeArticleHtml(marked.parse(String(md || '')));
  const plain = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const updArt = db.prepare('UPDATE articles SET content_html = ?, content_text = ? WHERE id = ?');
  const updVer = db.prepare('UPDATE article_versions SET content_html = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of db.prepare('SELECT id, content_md FROM articles WHERE content_html = ?').all('')) {
      const html = convert(r.content_md);
      updArt.run(html, plain(html), r.id);
    }
    for (const r of db.prepare('SELECT id, content_md FROM article_versions WHERE content_html = ?').all('')) {
      updVer.run(convert(r.content_md), r.id);
    }
    // backfill content_text for rows that already had content_html
    const updText = db.prepare('UPDATE articles SET content_text = ? WHERE id = ?');
    for (const r of db.prepare(`SELECT id, content_html FROM articles WHERE (content_text = '' OR content_text IS NULL) AND content_html != ''`).all()) {
      updText.run(plain(r.content_html), r.id);
    }
  });
  tx();
  for (const table of ['articles', 'article_versions']) {
    try { db.exec(`ALTER TABLE ${table} DROP COLUMN content_md`); } catch { /* keep column if drop unsupported */ }
  }
  try {
    db.prepare(`INSERT INTO activity_log (user_id, action, details, created_at) VALUES (NULL, ?, ?, ?)`)
      .run('markdown_migration', 'Converted all articles and revisions from Markdown to HTML', new Date().toISOString());
  } catch {}
}

/* Seed demo customer groups + customers once (fresh installs and first upgrade).
   Skipped entirely once the admin removes demo content (demo_removed setting),
   so removed demo rows never resurrect on restart. */
function seedDemoCustomers(db) {
  try {
    const removed = db.prepare(`SELECT value FROM settings WHERE key = 'demo_removed'`).get();
    if (removed && removed.value === '1') return;
    const n = db.prepare('SELECT COUNT(*) AS n FROM customer_groups').get().n;
    if (n === 0) {
      const now = new Date().toISOString();
      const insG = db.prepare('INSERT INTO customer_groups (name, slug, color, description, created_at) VALUES (?, ?, ?, ?, ?)');
      const premiumId = insG.run('Premium', 'premium', '#10B981', 'Paying customers with access to premium guides.', now).lastInsertRowid;
      const resellerId = insG.run('Reseller', 'reseller', '#F59E0B', 'Resellers with access to reseller-only resources.', now).lastInsertRowid;
      const insC = db.prepare(`INSERT INTO customers (name, email, password_hash, company, phone, notes, group_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const pw = hashPassword('customer123');
      insC.run('Priya Sharma', 'priya@example.com', pw, 'Sharma Media Co.', '', 'Demo customer — Premium group', premiumId, now);
      insC.run('Tom Becker', 'tom@example.com', pw, 'Becker Hosting', '', 'Demo customer — Premium group', premiumId, now);
      insC.run('Rita Alvarez', 'rita@example.com', pw, 'Alvarez Resale', '', 'Demo customer — Reseller group', resellerId, now);
      try {
        db.prepare(`INSERT INTO activity_log (user_id, action, details, created_at) VALUES (NULL, ?, ?, ?)`)
          .run('seed_customers', 'Seeded demo customer groups and customers', now);
      } catch {}
    }
  } catch { return; }
  seedRestrictedArticles(db);
}

/* Seed demo restricted articles (idempotent — skips slugs that already exist). */
function seedRestrictedArticles(db) {
  const now = new Date().toISOString();
  const has = (slug) => { try { return !!db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug); } catch { return true; } };
  // Backfill: this seeder also runs from runMigrations, i.e. before the demo
  // categories exist on a fresh install, so the two group articles can be
  // seeded with no category. File them under Getting Started once it exists.
  try {
    const gs = db.prepare('SELECT id FROM categories WHERE slug = ?').get('getting-started')?.id;
    if (gs) db.prepare("UPDATE articles SET category_id = ? WHERE slug IN ('premium-priority-support', 'reseller-white-label-setup') AND (category_id IS NULL OR category_id = '')").run(gs);
  } catch { /* categories table not ready yet */ }
  if (has('premium-priority-support') && has('reseller-white-label-setup') && has('internal-incident-response')) return;
  const premiumId = db.prepare('SELECT id FROM customer_groups WHERE slug = ?').get('premium')?.id;
  const resellerId = db.prepare('SELECT id FROM customer_groups WHERE slug = ?').get('reseller')?.id;
  if (!premiumId || !resellerId) return;
  const catId = (() => {
    const existing = db.prepare('SELECT id FROM categories WHERE slug = ?').get('internal-ops')?.id;
    if (existing) return existing;
    return db.prepare(`INSERT INTO categories (name, slug, description, icon, color, sort_order, visibility)
      VALUES (?, ?, ?, ?, ?, ?, 'staff')`)
      .run('Internal Ops', 'internal-ops', 'Staff-only operational guides.', '🔒', '#EF4444', 90).lastInsertRowid;
  })();
  const pubCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('getting-started')?.id || null;
  const insA = db.prepare(`INSERT INTO articles
    (title, slug, content_html, content_text, excerpt, category_id, status, visibility, views, reading_time_min, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'published', ?, 12, 2, ?, ?, ?)`);
  const insLink = db.prepare('INSERT OR IGNORE INTO article_groups (article_id, group_id) VALUES (?, ?)');
  if (!has('premium-priority-support')) {
    const id = insA.run(
      'Premium: Priority Support Channels', 'premium-priority-support',
      sanitizeArticleHtml('<h2>Priority support for Premium customers</h2><p>As a Premium customer you get a private support channel with a 4-hour response SLA. Open a ticket from your dashboard and choose <strong>Priority</strong>.</p><table><thead><tr><th>Channel</th><th>Response time</th></tr></thead><tbody><tr><td>Priority ticket</td><td>4 hours</td></tr><tr><td>Community forum</td><td>Best effort</td></tr></tbody></table>'),
      'Priority support for Premium customers. As a Premium customer you get a private support channel with a 4-hour response SLA.',
      'Premium-only guide to priority support channels.', pubCat, 'groups', now, now, now
    ).lastInsertRowid;
    insLink.run(id, premiumId);
  }
  if (!has('reseller-white-label-setup')) {
    const id = insA.run(
      'Reseller: White-Label Setup Guide', 'reseller-white-label-setup',
      sanitizeArticleHtml('<h2>White-label setup for resellers</h2><p>Resellers can rebrand the customer portal: upload your logo, set your brand colors, and point your domain at the portal. Changes apply instantly.</p><ol><li>Upload your logo in <strong>Settings → Branding</strong>.</li><li>Set primary and accent colors.</li><li>Add a CNAME record for your domain.</li></ol>'),
      'White-label setup for resellers. Resellers can rebrand the customer portal: upload your logo, set your brand colors, and point your domain at the portal.',
      'Reseller-only white-label setup guide.', pubCat, 'groups', now, now, now
    ).lastInsertRowid;
    insLink.run(id, resellerId);
  }
  if (!has('internal-incident-response')) {
    insA.run(
      'Internal: Incident Response Checklist', 'internal-incident-response',
      sanitizeArticleHtml('<h2>Incident response checklist (staff only)</h2><ol><li>Acknowledge the incident in the status channel.</li><li>Identify impacted services.</li><li>Post updates every 30 minutes until resolved.</li><li>Write a post-mortem within 48 hours.</li></ol>'),
      'Incident response checklist staff only. Acknowledge the incident, identify impacted services, post updates, write a post-mortem.',
      'Staff-only incident response checklist.', catId, 'staff', now, now, now
    );
  }
  try {
    db.prepare(`INSERT INTO activity_log (user_id, action, details, created_at) VALUES (NULL, ?, ?, ?)`)
      .run('seed_restricted', 'Seeded demo restricted articles', now);
  } catch {}
}

const SETTING_DEFAULTS = {
  site_title: 'XC Wiki',
  site_tagline: 'Knowledge Base',
  logo_text: 'XC Wiki',
  logo_url: '',
  logo_height: '48',
  favicon_url: '',
  hero_title: 'XC Wiki Knowledge Base',
  hero_description: 'Everything you need to manage and use your XC services. Find setup guides, troubleshooting steps, FAQs and more — all in one place.',
  hero_image_url: '',
  hero_image_fit: 'cover',
  hero_image_position: 'center',
  hero_overlay: '55',
  hero_show_cards: '1',
  popular_searches: JSON.stringify(['XC login', 'Media setup', 'Backup guide', "Server won't start", 'Watch history', 'Port forward', 'Billing']),
  footer_text: '© 2026 XC Wiki. All rights reserved.',
  copyright_line: '',
  powered_by: '1',
  default_theme: 'dark',
  announcements_text: '',
  /* branding colors */
  primary_color: '#2E7CF6',
  accent_color: '#7C5CFF',
  dark_bg: '#0B0E14',
  dark_surface: '#131826',
  dark_text: '#FFFFFF',
  light_bg: '#F4F6FB',
  light_surface: '#FFFFFF',
  light_text: '#0F172A',
  custom_css: '',
  /* email (SMTP) — configured in Admin → Settings → Email. smtp_pass_enc
     holds an AES-256-GCM encrypted JSON blob, never the raw password. */
  site_url: '',
  smtp_host: '',
  smtp_port: '587',
  smtp_secure: 'starttls',
  smtp_user: '',
  smtp_pass_enc: '',
  smtp_from_name: '',
  smtp_from_email: '',
  email_alerts_feedback: '0',
};

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSettings(db, obj) {
  const allowed = Object.keys(SETTING_DEFAULTS);
  const keys = Object.keys(obj || {}).filter(k => allowed.includes(k));
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of keys) up.run(k, String(obj[k] ?? ''));
  return getSettings(db);
}

function ensureSettingsSeed(db) {
  const have = new Set(db.prepare('SELECT key FROM settings').all().map(r => r.key));
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
    if (!have.has(k)) ins.run(k, v);
  }
}

function logActivity(db, userId, action, details) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, details, created_at) VALUES (?, ?, ?, ?)')
      .run(userId ?? null, action, details || '', new Date().toISOString());
  } catch {}
}

function readingTimeMin(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function makeExcerpt(html, maxLen = 160) {
  const text = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen - 1).trimEnd() + '…' : text;
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'article';
}

function uniqueSlug(db, base, table, excludeId) {
  let slug = slugify(base);
  let n = 2;
  while (true) {
    const row = excludeId
      ? db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).get(slug, excludeId)
      : db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(slug);
    if (!row) return slug;
    slug = `${slugify(base)}-${n++}`;
  }
}

module.exports = {
  getDb, closeDb, reopenDb, getSettings, setSettings, ensureSettingsSeed, logActivity,
  readingTimeMin, makeExcerpt, slugify, uniqueSlug, DB_PATH, SETTING_DEFAULTS,
};

/* ---------------- Seed (fresh installs only) ---------------- */

function seed(db) {
  ensureSettingsSeed(db);
  const { seedArticles, seedMeta } = require('./seed-data');
  const meta = seedMeta();
  const now = new Date();

  const insCat = db.prepare('INSERT INTO categories (name, slug, description, icon, color, sort_order, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const catIds = {};
  for (const c of meta.categories) catIds[c.slug] = insCat.run(c.name, c.slug, c.description, c.icon, c.color, c.sort_order, 'all').lastInsertRowid;

  const insSvc = db.prepare('INSERT INTO services (name, slug, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const svcIds = {};
  for (const s of meta.services) svcIds[s.slug] = insSvc.run(s.name, s.slug, s.description, s.icon, s.color, s.sort_order).lastInsertRowid;

  const tagIds = {};
  const getTagId = (name) => {
    const slug = slugify(name);
    if (tagIds[slug]) return tagIds[slug];
    const id = db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(name, slug).lastInsertRowid;
    tagIds[slug] = id;
    return id;
  };

  marked.setOptions({ breaks: true, gfm: true });
  const toHtml = (md) => sanitizeArticleHtml(marked.parse(String(md || '')));
  const toText = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const insArt = db.prepare(`INSERT INTO articles
    (title, slug, content_html, content_text, excerpt, category_id, service_id, status, featured, pinned, visibility,
     author_id, views, helpful_yes, helpful_no, reading_time_min, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, 'all', NULL, ?, ?, ?, ?, ?, ?, ?)`);
  const insArtTag = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
  const insVer = db.prepare(`INSERT INTO article_versions
    (article_id, version_number, title, content_html, author_id, note, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)`);

  const articles = seedArticles();
  articles.forEach((a, i) => {
    const daysAgo = (articles.length - i) * 2 + (i % 3);
    const d = new Date(now.getTime() - daysAgo * 86400000);
    const iso = d.toISOString();
    const views = 40 + ((i * 137) % 900);
    const yes = 5 + ((i * 53) % 40);
    const no = (i * 7) % 6;
    const html = toHtml(a.content_md);
    const id = insArt.run(
      a.title, a.slug, html, toText(html), makeExcerpt(html),
      catIds[slugify(a.category)] || null,
      a.service ? (svcIds[slugify(a.service)] || null) : null,
      a.featured ? 1 : 0, a.pinned ? 1 : 0,
      views, yes, no, readingTimeMin(html), iso, iso, iso
    ).lastInsertRowid;
    for (const t of a.tags || []) insArtTag.run(id, getTagId(t));
    // version history: v1 original, v2 current (with a small edit note for a few)
    insVer.run(id, 1, a.title, html, 'Initial version', new Date(d.getTime() - 86400000).toISOString());
    if (i % 4 === 0) {
      insVer.run(id, 2, a.title, html + sanitizeArticleHtml('<blockquote><p><strong>Update:</strong> Verified against the latest release.</p></blockquote>'), 'Refresh pass', iso);
    } else {
      insVer.run(id, 2, a.title, html, 'Minor copy edit', iso);
    }
    // feedback votes
    const insFb = db.prepare('INSERT INTO feedback (article_id, helpful, ip, created_at) VALUES (?, ?, ?, ?)');
    for (let v = 0; v < yes; v++) insFb.run(id, 1, `10.0.${i}.${v}`, iso);
    for (let v = 0; v < no; v++) insFb.run(id, 0, `10.1.${i}.${v}`, iso);
  });

  // example redirect: old slug -> current slug
  db.prepare('INSERT INTO redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?)')
    .run('plex-invite', 'accept-media-share-invite', now.toISOString());

  // search analytics seed
  const queries = [
    ['XC login', 3], ['Media setup', 2], ['Backup guide', 2], ["Server won't start", 4],
    ['Watch history', 1], ['Port forward', 2], ['Billing', 3], ['invite expired', 0],
    ['asdlfkj nonsense', 0], ['reset password', 5],
  ];
  const insQ = db.prepare('INSERT INTO search_analytics (query, results_count, ip, created_at) VALUES (?, ?, ?, ?)');
  queries.forEach(([q, n], i) => {
    insQ.run(q, n, `10.2.0.${i}`, new Date(now.getTime() - i * 3600000 * 5).toISOString());
  });

  // demo customers, groups, restricted articles (skips if already present)
  seedDemoCustomers(db);

  // record exactly which rows are seeded demo content (Demo Content manager)
  try { require('./demo').ensureRegistry(db); } catch {}

  logActivity(db, null, 'seed', 'Seeded demo knowledge base content');
}

module.exports.seed = seed;
