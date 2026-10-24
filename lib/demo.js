'use strict';
/* Demo Content manager support.
   Seeded demo rows are tracked in the `demo_rows` registry (table_name +
   row_id) so the admin can remove or restore demo content without ever
   touching real content created through the UI or imports.
   Registry entries are (re)built by matching the known seed identifiers —
   that covers installs seeded before the registry existed. */

const { marked } = require('marked');
const { sanitizeArticleHtml } = require('./html');
const { hashPassword } = require('./auth');
const { seedArticles, seedMeta } = require('./seed-data');
const { slugify, readingTimeMin, makeExcerpt } = require('./db');

const RESTRICTED_SLUGS = ['premium-priority-support', 'reseller-white-label-setup', 'internal-incident-response'];
const DEMO_CUSTOMER_EMAILS = ['priya@example.com', 'tom@example.com', 'rita@example.com'];
const DEMO_GROUP_SLUGS = ['premium', 'reseller'];

function demoIdentifiers() {
  const meta = seedMeta();
  const arts = seedArticles();
  return {
    categories: [...meta.categories.map(c => c.slug), 'internal-ops'],
    services: meta.services.map(s => s.slug),
    articles: [...arts.map(a => a.slug), ...RESTRICTED_SLUGS],
    tags: [...new Set(arts.flatMap(a => a.tags || []).map(t => slugify(t)))],
    customer_groups: DEMO_GROUP_SLUGS,
    customers: DEMO_CUSTOMER_EMAILS,
    redirects: ['plex-invite'],
  };
}

/** Register every currently-present seeded row. Idempotent. */
function ensureRegistry(db) {
  const ids = demoIdentifiers();
  const ins = db.prepare('INSERT OR IGNORE INTO demo_rows (table_name, row_id) VALUES (?, ?)');
  const bySlug = (table, slugs) => {
    if (!slugs.length) return;
    const rows = db.prepare(`SELECT id FROM ${table} WHERE slug IN (${slugs.map(() => '?').join(',')})`).all(...slugs);
    for (const r of rows) ins.run(table, r.id);
  };
  const tx = db.transaction(() => {
    bySlug('categories', ids.categories);
    bySlug('services', ids.services);
    bySlug('articles', ids.articles);
    bySlug('tags', ids.tags);
    bySlug('customer_groups', ids.customer_groups);
    bySlug('redirects', []);
    if (ids.customers.length) {
      const rows = db.prepare(`SELECT id FROM customers WHERE email IN (${ids.customers.map(() => '?').join(',')})`).all(...ids.customers);
      for (const r of rows) ins.run('customers', r.id);
    }
    const redir = db.prepare('SELECT id FROM redirects WHERE from_slug IN (?)').get('plex-invite');
    if (redir) ins.run('redirects', redir.id);
  });
  tx();
}

function registryIds(db, table) {
  return db.prepare('SELECT row_id FROM demo_rows WHERE table_name = ?').all(table).map(r => r.row_id);
}

function existingIds(db, table, ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT id FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => r.id);
}

function demoCounts(db) {
  ensureRegistry(db);
  const counts = {};
  for (const t of ['articles', 'categories', 'services', 'tags', 'customers', 'customer_groups']) {
    counts[t] = existingIds(db, t, registryIds(db, t)).length;
  }
  counts.groups = counts.customer_groups;
  delete counts.customer_groups;
  counts.total = counts.articles + counts.categories + counts.services + counts.tags + counts.customers + counts.groups;
  counts.present = counts.total > 0;
  return counts;
}

function setDemoRemovedFlag(db, removed) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('demo_removed', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(removed ? '1' : '0');
}

/** Delete seeded rows only. Demo categories/services/groups that real
    (non-demo) articles depend on are kept and reported as skipped. */
function removeDemo(db) {
  ensureRegistry(db);
  const removed = { articles: 0, categories: 0, services: 0, tags: 0, customers: 0, groups: 0, redirects: 0 };
  const skipped = { categories: 0, services: 0, groups: 0 };
  const demoArticleIds = new Set(existingIds(db, 'articles', registryIds(db, 'articles')));
  const tx = db.transaction(() => {
    // articles first — versions/tags/groups/feedback/progress cascade away
    for (const id of demoArticleIds) {
      removed.articles += db.prepare('DELETE FROM articles WHERE id = ?').run(id).changes;
    }
    const realUses = (col, id) => db.prepare(
      `SELECT COUNT(*) AS n FROM articles WHERE ${col} = ?`).get(id).n > 0;
    for (const id of existingIds(db, 'categories', registryIds(db, 'categories'))) {
      if (realUses('category_id', id)) { skipped.categories++; continue; }
      removed.categories += db.prepare('DELETE FROM categories WHERE id = ?').run(id).changes;
      db.prepare('DELETE FROM demo_rows WHERE table_name = ? AND row_id = ?').run('categories', id);
    }
    for (const id of existingIds(db, 'services', registryIds(db, 'services'))) {
      if (realUses('service_id', id)) { skipped.services++; continue; }
      removed.services += db.prepare('DELETE FROM services WHERE id = ?').run(id).changes;
      db.prepare('DELETE FROM demo_rows WHERE table_name = ? AND row_id = ?').run('services', id);
    }
    for (const id of existingIds(db, 'customer_groups', registryIds(db, 'customer_groups'))) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM article_groups WHERE group_id = ?').get(id).n > 0;
      if (used) { skipped.groups++; continue; }
      removed.groups += db.prepare('DELETE FROM customer_groups WHERE id = ?').run(id).changes;
      db.prepare('DELETE FROM demo_rows WHERE table_name = ? AND row_id = ?').run('customer_groups', id);
    }
    for (const id of existingIds(db, 'customers', registryIds(db, 'customers'))) {
      removed.customers += db.prepare('DELETE FROM customers WHERE id = ?').run(id).changes;
      db.prepare('DELETE FROM demo_rows WHERE table_name = ? AND row_id = ?').run('customers', id);
    }
    // tags: drop demo tags no remaining article uses
    for (const id of existingIds(db, 'tags', registryIds(db, 'tags'))) {
      const used = db.prepare('SELECT COUNT(*) AS n FROM article_tags WHERE tag_id = ?').get(id).n > 0;
      if (used) continue;
      removed.tags += db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes;
      db.prepare('DELETE FROM demo_rows WHERE table_name = ? AND row_id = ?').run('tags', id);
    }
    for (const id of existingIds(db, 'redirects', registryIds(db, 'redirects'))) {
      removed.redirects += db.prepare('DELETE FROM redirects WHERE id = ?').run(id).changes;
      db.prepare('DELETE FROM demo_rows WHERE table_name = ? AND row_id = ?').run('redirects', id);
    }
    db.prepare('DELETE FROM demo_rows WHERE table_name = ?').run('articles');
  });
  tx();
  setDemoRemovedFlag(db, true);
  return { removed, skipped };
}

/* ---------------- restore (insert-if-missing, mirrors the seed) ---------------- */

function restoreDemo(db) {
  setDemoRemovedFlag(db, false);
  const now = new Date();
  const nowIso = now.toISOString();
  marked.setOptions({ breaks: true, gfm: true });
  const toHtml = (md) => sanitizeArticleHtml(marked.parse(String(md || '')));
  const toText = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const meta = seedMeta();
  const counts = { articles: 0, categories: 0, services: 0, customers: 0, groups: 0 };
  const tx = db.transaction(() => {
    const catIds = {};
    for (const c of meta.categories) {
      const ex = db.prepare('SELECT id FROM categories WHERE slug = ?').get(c.slug);
      if (ex) { catIds[c.slug] = ex.id; continue; }
      catIds[c.slug] = db.prepare('INSERT INTO categories (name, slug, description, icon, color, sort_order, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.name, c.slug, c.description, c.icon, c.color, c.sort_order, 'all').lastInsertRowid;
      counts.categories++;
    }
    const svcIds = {};
    for (const s of meta.services) {
      const ex = db.prepare('SELECT id FROM services WHERE slug = ?').get(s.slug);
      if (ex) { svcIds[s.slug] = ex.id; continue; }
      svcIds[s.slug] = db.prepare('INSERT INTO services (name, slug, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(s.name, s.slug, s.description, s.icon, s.color, s.sort_order).lastInsertRowid;
      counts.services++;
    }
    const tagId = (name) => {
      const slug = slugify(name);
      const ex = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug);
      return ex ? ex.id : db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(name, slug).lastInsertRowid;
    };
    const insArt = db.prepare(`INSERT INTO articles
      (title, slug, content_html, content_text, excerpt, category_id, service_id, status, featured, pinned, visibility,
       author_id, views, helpful_yes, helpful_no, reading_time_min, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, 'all', NULL, ?, ?, ?, ?, ?, ?, ?)`);
    const insTag = db.prepare('INSERT OR IGNORE INTO article_tags (article_id, tag_id) VALUES (?, ?)');
    const insVer = db.prepare(`INSERT INTO article_versions (article_id, version_number, title, content_html, author_id, note, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)`);
    const articles = seedArticles();
    articles.forEach((a, i) => {
      if (db.prepare('SELECT id FROM articles WHERE slug = ?').get(a.slug)) return;
      const d = new Date(now.getTime() - ((articles.length - i) * 2 + (i % 3)) * 86400000);
      const iso = d.toISOString();
      const html = toHtml(a.content_md);
      const id = insArt.run(
        a.title, a.slug, html, toText(html), makeExcerpt(html),
        catIds[slugify(a.category)] || null,
        a.service ? (svcIds[slugify(a.service)] || null) : null,
        a.featured ? 1 : 0, a.pinned ? 1 : 0,
        40 + ((i * 137) % 900), 5 + ((i * 53) % 40), (i * 7) % 6,
        readingTimeMin(html), iso, iso, iso
      ).lastInsertRowid;
      for (const t of a.tags || []) insTag.run(id, tagId(t));
      insVer.run(id, 1, a.title, html, 'Initial version', new Date(d.getTime() - 86400000).toISOString());
      insVer.run(id, 2, a.title, html, 'Minor copy edit', iso);
      counts.articles++;
    });
    try {
      db.prepare('INSERT OR IGNORE INTO redirects (from_slug, to_slug, created_at) VALUES (?, ?, ?)')
        .run('plex-invite', 'accept-media-share-invite', nowIso);
    } catch {}
    // demo groups + customers
    const groupId = (name, slug, color, desc) => {
      const ex = db.prepare('SELECT id FROM customer_groups WHERE slug = ?').get(slug);
      if (ex) return ex.id;
      counts.groups++;
      return db.prepare('INSERT INTO customer_groups (name, slug, color, description, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, slug, color, desc, nowIso).lastInsertRowid;
    };
    const premiumId = groupId('Premium', 'premium', '#10B981', 'Paying customers with access to premium guides.');
    const resellerId = groupId('Reseller', 'reseller', '#F59E0B', 'Resellers with access to reseller-only resources.');
    const pw = hashPassword('customer123');
    const insC = db.prepare(`INSERT INTO customers (name, email, password_hash, company, phone, notes, group_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [name, email, company, notes, gid] of [
      ['Priya Sharma', 'priya@example.com', 'Sharma Media Co.', 'Demo customer — Premium group', premiumId],
      ['Tom Becker', 'tom@example.com', 'Becker Hosting', 'Demo customer — Premium group', premiumId],
      ['Rita Alvarez', 'rita@example.com', 'Alvarez Resale', 'Demo customer — Reseller group', resellerId],
    ]) {
      if (db.prepare('SELECT id FROM customers WHERE email = ?').get(email)) continue;
      insC.run(name, email, pw, company, '', notes, gid, nowIso);
      counts.customers++;
    }
    // restricted demo articles + staff-only category
    let opsCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('internal-ops')?.id;
    if (!opsCat) {
      opsCat = db.prepare(`INSERT INTO categories (name, slug, description, icon, color, sort_order, visibility)
        VALUES ('Internal Ops', 'internal-ops', 'Staff-only operational guides.', '🔒', '#EF4444', 90, 'staff')`).run().lastInsertRowid;
      counts.categories++;
    }
    const pubCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('getting-started')?.id || null;
    const insR = db.prepare(`INSERT INTO articles
      (title, slug, content_html, content_text, excerpt, category_id, status, visibility, views, reading_time_min, published_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'published', ?, 12, 2, ?, ?, ?)`);
    const insLink = db.prepare('INSERT OR IGNORE INTO article_groups (article_id, group_id) VALUES (?, ?)');
    const restricted = [
      ['Premium: Priority Support Channels', 'premium-priority-support',
        '<h2>Priority support for Premium customers</h2><p>As a Premium customer you get a private support channel with a 4-hour response SLA. Open a ticket from your dashboard and choose <strong>Priority</strong>.</p><table><thead><tr><th>Channel</th><th>Response time</th></tr></thead><tbody><tr><td>Priority ticket</td><td>4 hours</td></tr><tr><td>Community forum</td><td>Best effort</td></tr></tbody></table>',
        'Premium-only guide to priority support channels.', pubCat, 'groups', premiumId],
      ['Reseller: White-Label Setup Guide', 'reseller-white-label-setup',
        '<h2>White-label setup for resellers</h2><p>Resellers can rebrand the customer portal: upload your logo, set your brand colors, and point your domain at the portal. Changes apply instantly.</p><ol><li>Upload your logo in <strong>Settings → Branding</strong>.</li><li>Set primary and accent colors.</li><li>Add a CNAME record for your domain.</li></ol>',
        'Reseller-only white-label setup guide.', pubCat, 'groups', resellerId],
      ['Internal: Incident Response Checklist', 'internal-incident-response',
        '<h2>Incident response checklist (staff only)</h2><ol><li>Acknowledge the incident in the status channel.</li><li>Identify impacted services.</li><li>Post updates every 30 minutes until resolved.</li><li>Write a post-mortem within 48 hours.</li></ol>',
        'Staff-only incident response checklist.', opsCat, 'staff', null],
    ];
    for (const [title, slug, htmlRaw, excerpt, catId, vis, gid] of restricted) {
      if (db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug)) continue;
      const html = sanitizeArticleHtml(htmlRaw);
      const id = insR.run(title, slug, html, toText(html), excerpt, catId, vis, nowIso, nowIso, nowIso).lastInsertRowid;
      if (gid) insLink.run(id, gid);
      counts.articles++;
    }
  });
  tx();
  ensureRegistry(db);
  return counts;
}

module.exports = { ensureRegistry, demoCounts, removeDemo, restoreDemo, demoIdentifiers };
