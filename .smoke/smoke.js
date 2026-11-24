'use strict';
/* XC Wiki v1.1.0 smoke test.
   Boots SCRATCH COPIES of the app (never the real workspace data/) and
   exercises the whole v1.1.0 batch over HTTP:
     - migration boot on an old-shape DB (backfill + new columns)
     - multi-group + multi-service customers, service→group auto-membership
     - invites (create → copyable link → accept → status + Discord stub hit)
     - hex colors
     - BookStack users phase via fixtures + welcome emails
     - CSV template + Services column import
     - category GROUP restrictions (v1.1.3: groups only — service
       restrictions removed; legacy category_services rows unenforced)
     - clean-URL routing: deep-link shell, legacy-hash shim present (item 8)
     - homepage: no "Browse by Service" (item 10), bigger tiles CSS (item 9)
     - Your Services (1.1.5): own services only, display-only cards,
       "View All My Services" link gone, admin self-attach via user_services
     - theme mode (1.2.1): site-wide dark/light/system setting — dark by
       default on fresh installs AND on settings DBs predating the key,
       admin round-trip, invalid values normalize to dark
     - media performance (1.2.2): category cover/banner uploads are
       downscaled to web size as JPEG, other uploads stored untouched,
       corrupt category uploads fall back to the original, /media
       serves a 30-day immutable private cache header
     - category reorder (1.2.3): sort_order backfill preserves the
       current homepage order while making values distinct, the
       staff-only order endpoint reorders + persists across restart,
       invalid payloads are rejected without corrupting the order,
       new categories append at the end
     - homepage (1.2.4): the "Your Services" section is gone (and
       /api/home no longer carries a services list; the /services
       page and Admin attachments are unchanged), and Recommended is
       personalized — a viewer with attached services gets their
       services' unread articles first, in-progress next, finished
       excluded, featured filling the rest; viewers without attached
       services get the featured list exactly as before, and one
       viewer's services/progress never leak into another's list
     - staff + ordering + editor (1.2.5): Admin "Users" becomes a
       grouped "Staff" page; articles reorder within their category
       (endpoint validation, append/move semantics, restart
       persistence, collision backfill preserving the visible order);
       staff sessions survive public-app boot calls and logout still
       signs out; multi-service articles via the article_services
       join (both listings, chips, any-match recommendations, legacy
       service_id migration); blockquote style classes survive the
       sanitizer, heading anchors auto-slug + dedupe + custom ids;
       responsive image CSS guards; /services boxes display-only;
       attach-service pickers are name-labeled boxes
     - Your Services page (1.2.7): /api/my-services returns only the
       viewer's admin-set services (direct attachments + services
       mapped to the customer's groups), never the whole catalog;
       staff read user_services; signed-out is 401; the nav's Your
       Services link points at /my-services while All Services keeps
       the full catalog
   Prints PASS/FAIL per check; exit code 1 when anything fails. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join('/tmp', 'xcwiki-smoke-'));
const ENC = 'a'.repeat(64);
const results = [];
function check(area, name, cond, extra = '') {
  results.push({ area, name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} [${area}] ${name}${extra ? ' — ' + extra : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeCopy(name, { withData = null } = {}) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const item of ['server.js', 'package.json', 'lib', 'public']) {
    fs.cpSync(path.join(SRC, item), path.join(dir, item), { recursive: true });
  }
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  if (withData) {
    for (const f of fs.readdirSync(withData)) {
      if (f.startsWith('xcwiki.db')) fs.copyFileSync(path.join(withData, f), path.join(dir, 'data', f));
    }
  }
  return dir;
}

const children = [];
function boot(dir, port) {
  const child = spawn('node', ['server.js'], {
    cwd: dir, env: { ...process.env, PORT: String(port), ENCRYPTION_KEY: ENC },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(`[srv:${port}] ${d}`));
  children.push(child);
  return (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/setup-needed`);
        if (r.ok) return child;
      } catch {}
      await sleep(250);
    }
    throw new Error(`server on ${port} did not come up`);
  })();
}

async function req(port, method, p, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const tokenFromLink = link => new URL(link).searchParams.get('token');

(async () => {
/* ---------------- Discord webhook stub ---------------- */
const hookHits = [];
const stub = http.createServer((rq, rs) => {
  let data = '';
  rq.on('data', c => data += c);
  rq.on('end', () => { hookHits.push({ method: rq.method, url: rq.url, body: data }); rs.end('{}'); });
});
await new Promise(r => stub.listen(4199, '127.0.0.1', r));

/* ================= A. OLD-SHAPE DB MIGRATION ================= */
const oldDir = makeCopy('old');
// Build a pre-1.1.0-shaped database: no membership/services join tables,
// services has no group_id, password_tokens has no purpose/token_encrypted.
execFileSync('node', ['-e', `
  const Database = require(${JSON.stringify(path.join(SRC, 'node_modules', 'better-sqlite3'))});
  const { hashPassword } = require(${JSON.stringify(path.join(SRC, 'lib', 'auth'))});
  const db = new Database(${JSON.stringify(path.join(WORK, 'old', 'data', 'xcwiki.db'))});
  db.exec(\`
    CREATE TABLE customer_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#8B5CF6', description TEXT DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, company TEXT DEFAULT '', phone TEXT DEFAULT '', notes TEXT DEFAULT '', group_id INTEGER REFERENCES customer_groups(id) ON DELETE SET NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT DEFAULT '');
    CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', icon TEXT DEFAULT '🖥️', color TEXT DEFAULT '#8B5CF6', sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE password_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
  \`);
  db.prepare('INSERT INTO customer_groups (name, slug, color, description, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('Legacy Group', 'legacy-group', '#123456', '', new Date().toISOString());
  db.prepare('INSERT INTO customers (name, email, password_hash, group_id, created_at) VALUES (?, ?, ?, 1, ?)')
    .run('Old Timer', 'old@x.com', hashPassword('oldpass123'), new Date().toISOString());
  db.close();
  console.log('preseeded');
`], { stdio: 'inherit' });

await boot(oldDir, 4121);
{
  const Database = require(path.join(SRC, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(oldDir, 'data', 'xcwiki.db'), { readonly: true });
  const member = db.prepare('SELECT * FROM customer_group_members WHERE customer_id = 1 AND group_id = 1').get();
  check('migration', 'membership backfilled from legacy group_id', !!member);
  const svcCols = db.prepare("PRAGMA table_info(services)").all().map(c => c.name);
  check('migration', 'services.group_id column added', svcCols.includes('group_id'));
  const tokCols = db.prepare("PRAGMA table_info(password_tokens)").all().map(c => c.name);
  check('migration', 'password_tokens.purpose + token_encrypted added', tokCols.includes('purpose') && tokCols.includes('token_encrypted'));
  const tbls = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  check('migration', 'join tables created', ['customer_group_members', 'customer_services', 'category_services', 'category_groups'].every(t => tbls.includes(t)));
  db.close();
  const login = await req(4121, 'POST', '/api/customer/login', { body: { email: 'old@x.com', password: 'oldpass123' } });
  check('migration', 'legacy customer can still log in', login.status === 200 && !!login.json.token);
  const me = await req(4121, 'GET', '/api/me', { token: login.json.token });
  check('migration', '/api/me reports membership groups', (me.json.user.groups || []).some(g => g.name === 'Legacy Group'));
}

/* ================= B. MAIN FLOW ================= */
const mainDir = makeCopy('main');

/* BookStack users phase, driven with fixture rows through the factored
   import function — in-process, before the server boots (the module's
   getDb() creates the schema on this scratch copy). */
const fixtureOut = execFileSync('node', ['-e', `
  const { getDb } = require('./lib/db');
  const bs = require('./lib/bookstack');
  const db = getDb();
  db.prepare("INSERT INTO customers (name, email, password_hash, created_at) VALUES ('Existing', 'exists@bs.com', 'x', ?)")
    .run(new Date().toISOString());
  const rows = [
    { id: 11, name: 'Bs One', email: 'one@bs.com', slug: 'bs-one', created_at: '2024-01-02T00:00:00Z', is_admin: true },
    { id: 12, name: '', email: 'two@bs.com' },
    { id: 13, name: 'Dup', email: 'exists@bs.com' },
    { id: 14, name: 'No Email' },
  ];
  const S1 = { failures: [] };
  bs.importUsers(db, { log: [] }, rows, S1);
  const S2 = { failures: [] };
  bs.importUsers(db, { log: [] }, rows, S2);
  const one = db.prepare("SELECT id, password_hash FROM customers WHERE email = 'one@bs.com'").get();
  console.log(JSON.stringify({ first: S1, second: S2, oneId: one && one.id, onePw: one && one.password_hash }));
`], { cwd: mainDir, env: { ...process.env, ENCRYPTION_KEY: ENC }, encoding: 'utf8' });
{
  const fx = JSON.parse(fixtureOut.trim().split('\n').pop());
  check('bookstack-users', 'fixtures: 2 imported, 2 skipped (dup email + no email)', fx.first.users_imported === 2 && fx.first.users_skipped === 2, JSON.stringify(fx.first));
  check('bookstack-users', 're-run is idempotent: 0 imported, 4 skipped', fx.second.users_imported === 0 && fx.second.users_skipped === 4);
  check('bookstack-users', 'imported customer is pending (empty password_hash)', fx.onePw === '');
  globalThis.__bsOneId = fx.oneId;
}

await boot(mainDir, 4122);
const P = 4122;
const setup = await req(P, 'POST', '/api/setup', { body: { email: 'admin@x.com', password: 'adminpass123', display_name: 'Admin' } });
const A = setup.json.token;
check('setup', 'first-run setup creates admin', setup.status === 200 && !!A);

/* ---- groups, services, hex ---- */
const g1 = await req(P, 'POST', '/api/admin/groups', { token: A, body: { name: 'Alpha', color: 'rgb(16, 185, 129)' } });
const g2 = await req(P, 'POST', '/api/admin/groups', { token: A, body: { name: 'Beta', color: '#3B82F6' } });
const G1 = g1.json.id, G2 = g2.json.id;
const groups = await req(P, 'GET', '/api/admin/groups', { token: A });
const alphaRow = groups.json.find(g => g.id === G1);
const betaRow = groups.json.find(g => g.id === G2);
check('hex', 'rgb() group color reads back as #hex', alphaRow && alphaRow.color === '#10b981', alphaRow && alphaRow.color);
check('hex', '#RRGGBB normalizes to lowercase', betaRow && betaRow.color === '#3b82f6', betaRow && betaRow.color);

const s1 = await req(P, 'POST', '/api/admin/services', { token: A, body: { name: 'StreamSvc', color: 'rgb(139, 92, 246)', group_id: G1 } });
const S1 = s1.json.id;
const svcList = await req(P, 'GET', '/api/admin/services', { token: A });
const svcRow = svcList.json.find(s => s.id === S1);
check('hex', 'service color stored as hex', svcRow && svcRow.color === '#8b5cf6', svcRow && svcRow.color);
check('services', 'service carries its mapped group_id', svcRow && svcRow.group_id === G1);

const setPut = await req(P, 'PUT', '/api/admin/settings', { token: A, body: { primary_color: 'rgb(46, 124, 246)' } });
const pubSettings = await req(P, 'GET', '/api/settings/public');
check('hex', 'branding color saved from rgb() renders as hex', pubSettings.json.primary_color === '#2e7cf6', pubSettings.json.primary_color);

/* ---- multi-group / multi-service customers + auto-membership ---- */
const carol = await req(P, 'POST', '/api/admin/customers', { token: A, body: { name: 'Carol', email: 'carol@x.com', password: 'carolpass123', service_ids: [S1] } });
const CAROL = carol.json.id;
let custList = await req(P, 'GET', '/api/admin/customers', { token: A });
let carolRow = custList.json.find(c => c.id === CAROL);
check('services', 'customer holds the assigned service', (carolRow.services || []).some(s => s.id === S1));
check('auto-membership', 'service→group membership auto-added', (carolRow.groups || []).some(g => g.id === G1));

const mkArticle = async (title, extra) => (await req(P, 'POST', '/api/admin/articles', { token: A, body: { title, content_html: `<p>${title} body</p>`, status: 'published', visibility: 'all', ...extra } })).json;
const a1 = await mkArticle('Alpha Guide', { visibility: 'groups', group_ids: [G1] });
const a2 = await mkArticle('Beta Guide', { visibility: 'groups', group_ids: [G2] });
const carolLogin = await req(P, 'POST', '/api/customer/login', { body: { email: 'carol@x.com', password: 'carolpass123' } });
const CT = carolLogin.json.token;
check('visibility', 'member sees own group article', (await req(P, 'GET', '/api/articles/' + a1.slug, { token: CT })).status === 200);
check('visibility', 'non-member cannot see other group article', (await req(P, 'GET', '/api/articles/' + a2.slug, { token: CT })).status === 404);
await req(P, 'PUT', '/api/admin/customers/' + CAROL, { token: A, body: { group_ids: [G1, G2] } });
check('visibility', 'after adding 2nd group, both articles visible', (await req(P, 'GET', '/api/articles/' + a2.slug, { token: CT })).status === 200);
custList = await req(P, 'GET', '/api/admin/customers', { token: A });
carolRow = custList.json.find(c => c.id === CAROL);
check('multi-group', 'customer list shows both groups', (carolRow.groups || []).length === 2);

/* service group change applies to all current holders */
const g3 = await req(P, 'POST', '/api/admin/groups', { token: A, body: { name: 'Gamma' } });
const G3 = g3.json.id;
await req(P, 'PUT', '/api/admin/services/' + S1, { token: A, body: { group_id: G3 } });
custList = await req(P, 'GET', '/api/admin/customers', { token: A });
carolRow = custList.json.find(c => c.id === CAROL);
check('auto-membership', 'changing a service group grants it to existing holders', (carolRow.groups || []).some(g => g.id === G3));
await req(P, 'PUT', '/api/admin/services/' + S1, { token: A, body: { group_id: G1 } }); // restore for later checks

/* ---- invites + acceptance notification ---- */
await req(P, 'PUT', '/api/admin/email-settings', { token: A, body: { notify_invite_accepted: true, discord_webhook_url: 'http://127.0.0.1:4199/hook' } });
const dave = await req(P, 'POST', '/api/admin/invites', { token: A, body: { name: 'Dave', email: 'dave@x.com', service_ids: [S1] } });
check('invites', 'invite created and returns a link (SMTP off → link still issued)', dave.status === 200 && dave.json.invite && dave.json.invite.link.includes('/set-password?token='), JSON.stringify(dave.json).slice(0, 160));
check('invites', 'invite email flagged not-sent without SMTP, acceptance path unaffected', dave.json.invite.emailed === false);
const invList1 = await req(P, 'GET', '/api/admin/invites', { token: A });
const daveInv = invList1.json.find(i => i.email === 'dave@x.com');
check('invites', 'invites list shows pending + copyable link + services', !!daveInv && daveInv.status === 'pending' && daveInv.link === dave.json.invite.link && (daveInv.services || []).some(s => s.id === S1));
const daveToken = tokenFromLink(dave.json.invite.link);
const info = await req(P, 'GET', '/api/customer/set-password-info?token=' + encodeURIComponent(daveToken));
check('invites', 'set-password-info validates the invite token', info.status === 200 && info.json.valid === true);
const hitsBefore = hookHits.length;
const accept = await req(P, 'POST', '/api/customer/set-password', { body: { token: daveToken, password: 'davepass123' } });
check('invites', 'acceptance succeeds with SMTP unconfigured', accept.status === 200 && accept.json.ok === true);
for (let i = 0; i < 12 && hookHits.length === hitsBefore; i++) await sleep(250);
check('invites', 'Discord webhook received the acceptance POST', hookHits.length > hitsBefore && hookHits[hookHits.length - 1].body.includes('Invite accepted'), hookHits.length ? hookHits[hookHits.length - 1].body.slice(0, 120) : 'no hits');
const invList2 = await req(P, 'GET', '/api/admin/invites', { token: A });
check('invites', 'status flips to accepted', (invList2.json.find(i => i.email === 'dave@x.com') || {}).status === 'accepted');
custList = await req(P, 'GET', '/api/admin/customers', { token: A });
const daveRow = custList.json.find(c => c.email === 'dave@x.com');
check('invites', 'invited customer gained the service group automatically', !!daveRow && (daveRow.groups || []).some(g => g.id === G1));

/* ---- welcome emails for pending (BookStack-imported) customers ---- */
const BS_ONE = globalThis.__bsOneId;
const welcome = await req(P, 'POST', `/api/admin/customers/${BS_ONE}/welcome`, { token: A, body: {} });
check('welcome', 'welcome action returns a setup link', welcome.status === 200 && !!welcome.json.link);
const wToken = tokenFromLink(welcome.json.link);
const wAccept = await req(P, 'POST', '/api/customer/set-password', { body: { token: wToken, password: 'onepass12345' } });
check('welcome', 'welcome token sets a password (purpose flow works)', wAccept.status === 200);
custList = await req(P, 'GET', '/api/admin/customers', { token: A });
const twoRow = custList.json.find(c => c.email === 'two@bs.com');
check('welcome', 'pending customer reports has_password=false', !!twoRow && twoRow.has_password === false);
const bulkW = await req(P, 'POST', '/api/admin/customers/bulk-action', { token: A, body: { ids: [CAROL, twoRow.id], action: 'welcome' } });
const bwById = Object.fromEntries((bulkW.json.results || []).map(r => [r.id, r]));
check('welcome', 'bulk welcome skips customers who already have a password', bwById[CAROL] && bwById[CAROL].ok === false && bwById[twoRow.id] && bwById[twoRow.id].ok === true, JSON.stringify(bulkW.json.results));

/* ---- CSV template + Services column ---- */
const tpl = await req(P, 'GET', '/api/admin/customers/import/template', { token: A });
check('csv', 'template endpoint returns attachment with exact headers',
  tpl.status === 200 && (tpl.headers.get('content-disposition') || '').includes('xc-wiki-customers-template.csv')
  && tpl.text.split(/\r?\n/)[0] === 'Name,Email,Company,Phone,Notes,Group,Services', tpl.text.split(/\r?\n/)[0]);
const csvText = [
  'Name,Email,Company,Phone,Notes,Group,Services',
  'Erin,erin@x.com,,,,Beta,StreamSvc',
  'Bad,badsvc@x.com,,,,,NoSuchSvc',
].join('\n');
const imp = await req(P, 'POST', '/api/admin/customers/import', { token: A, body: { csv: csvText, mapping: { name: 0, email: 1, company: 2, phone: 3, notes: 4, group: 5, services: 6 } } });
check('csv', 'import with Services column: 1 imported, 1 row error (unknown service)',
  imp.json.imported === 1 && (imp.json.errors || []).length === 1 && /Unknown service/.test(imp.json.errors[0].error), JSON.stringify(imp.json.errors));
custList = await req(P, 'GET', '/api/admin/customers', { token: A });
const erinRow = custList.json.find(c => c.email === 'erin@x.com');
check('csv', 'imported customer holds the service + column group + service-derived group',
  !!erinRow && (erinRow.services || []).some(s => s.id === S1)
  && (erinRow.groups || []).some(g => g.id === G2) && (erinRow.groups || []).some(g => g.id === G1),
  erinRow ? JSON.stringify(erinRow.groups) : 'missing');

/* ---- category restrictions are GROUP-based only (v1.1.3) ---- */
const catSvc = await req(P, 'POST', '/api/admin/categories', { token: A, body: { name: 'StreamCat', visibility: 'all', restrict_service_ids: [S1] } });
const C1 = catSvc.json.id;
const catGrp = await req(P, 'POST', '/api/admin/categories', { token: A, body: { name: 'BetaCat', visibility: 'all', restrict_group_ids: [G2] } });
const C2 = catGrp.json.id;
const catBoth = await req(P, 'POST', '/api/admin/categories', { token: A, body: { name: 'BothCat', visibility: 'all', restrict_service_ids: [S1], restrict_group_ids: [G2] } });
const C3 = catBoth.json.id;
/* Simulate a pre-1.1.3 install: a stored category_services row for
   StreamCat must be left in place (non-destructive) but never enforced. */
{
  const Database = require(path.join(SRC, 'node_modules', 'better-sqlite3'));
  const legacyDb = new Database(path.join(mainDir, 'data', 'xcwiki.db'));
  legacyDb.pragma('busy_timeout = 5000');
  legacyDb.prepare('INSERT OR IGNORE INTO category_services (category_id, service_id) VALUES (?, ?)').run(C1, S1);
  const legacyRows = legacyDb.prepare('SELECT COUNT(*) AS n FROM category_services WHERE category_id = ?').get(C1).n;
  check('cat-restrict', 'legacy category_services row stays stored (table + rows retained)', legacyRows === 1);
  legacyDb.close();
}
const adminCats = await req(P, 'GET', '/api/admin/categories', { token: A });
const c1Row = adminCats.json.find(c => c.id === C1);
const c2Row = adminCats.json.find(c => c.id === C2);
check('cat-restrict', 'service restriction payload ignored: not saved, not exposed on the category', !!c1Row && c1Row.restrict_service_ids === undefined && !(c1Row.restrict_group_ids || []).length);
check('cat-restrict', 'group restriction persists from the category payload', !!c2Row && JSON.stringify(c2Row.restrict_group_ids) === JSON.stringify([G2]));
const a4 = await mkArticle('StreamCat Guide', { category_id: C1 });
const a5 = await mkArticle('BetaCat Guide', { category_id: C2 });
const a6 = await mkArticle('BothCat Guide', { category_id: C3 });

const frank = await req(P, 'POST', '/api/admin/customers', { token: A, body: { name: 'Frank', email: 'frank@x.com', password: 'frankpass123' } });
const FT = (await req(P, 'POST', '/api/customer/login', { body: { email: 'frank@x.com', password: 'frankpass123' } })).json.token;
check('cat-restrict', 'stored service restriction NOT enforced: customer without the service CAN fetch the article', (await req(P, 'GET', '/api/articles/' + a4.slug, { token: FT })).status === 200);
check('cat-restrict', 'customer outside the group cannot fetch article in group-restricted category', (await req(P, 'GET', '/api/articles/' + a5.slug, { token: FT })).status === 404);
const frankCats = await req(P, 'GET', '/api/categories', { token: FT });
check('cat-restrict', 'group-restricted categories hidden from category list; legacy-service one is listed', !frankCats.json.some(c => c.id === C2 || c.id === C3) && frankCats.json.some(c => c.id === C1));
check('cat-restrict', 'group-restricted category page 404s directly', (await req(P, 'GET', '/api/categories/betacat', { token: FT })).status === 404);
const frankSearch = await req(P, 'GET', '/api/search?q=' + encodeURIComponent('BetaCat Guide'), { token: FT });
check('cat-restrict', 'group-restricted article absent from search', !(frankSearch.json.results || []).some(r => r.slug === a5.slug));
const gina = await req(P, 'POST', '/api/admin/customers', { token: A, body: { name: 'Gina', email: 'gina@x.com', password: 'ginapass123', group_ids: [G2] } });
const GT = (await req(P, 'POST', '/api/customer/login', { body: { email: 'gina@x.com', password: 'ginapass123' } })).json.token;
check('cat-restrict', 'customer in the group but WITHOUT the service CAN fetch the article', (await req(P, 'GET', '/api/articles/' + a5.slug, { token: GT })).status === 200);
check('cat-restrict', 'both-payload category: group member passes on group alone (service ignored)', (await req(P, 'GET', '/api/articles/' + a6.slug, { token: GT })).status === 200);
const DT = (await req(P, 'POST', '/api/customer/login', { body: { email: 'dave@x.com', password: 'davepass123' } })).json.token;
check('cat-restrict', 'fixture: Dave holds the service but is NOT in the restricted group', !!DT);
check('cat-restrict', 'service assignment alone does NOT grant visibility (service holder blocked)', (await req(P, 'GET', '/api/articles/' + a5.slug, { token: DT })).status === 404);
check('cat-restrict', 'service holder blocked from both-payload category too', (await req(P, 'GET', '/api/articles/' + a6.slug, { token: DT })).status === 404);
check('cat-restrict', 'group member CAN fetch group-category article', (await req(P, 'GET', '/api/articles/' + a5.slug, { token: CT })).status === 200);
check('cat-restrict', 'staff bypass group restrictions entirely', (await req(P, 'GET', '/api/articles/' + a5.slug, { token: A })).status === 200);
const prevFrank = await req(P, 'GET', `/api/admin/visibility-preview?viewer=customer:${frank.json.id}`, { token: A });
check('cat-restrict', 'View-As preview hides group-restricted category for unauthorized customer', !(prevFrank.json.categories || []).some(c => c.slug === 'betacat'));
check('cat-restrict', 'View-As preview shows the legacy-service category (unenforced = visible)', (prevFrank.json.categories || []).some(c => c.slug === 'streamcat'));
const prevCarol = await req(P, 'GET', `/api/admin/visibility-preview?viewer=customer:${CAROL}`, { token: A });
check('cat-restrict', 'View-As preview shows group-restricted category to a group member', (prevCarol.json.categories || []).some(c => c.slug === 'betacat'));
const delGrp = await req(P, 'DELETE', '/api/admin/groups/' + G2, { token: A });
check('cat-restrict', 'group delete guard counts category restrictions/memberships', delGrp.status === 400, delGrp.json && delGrp.json.error);
const delSvc = await req(P, 'DELETE', '/api/admin/services/' + S1, { token: A });
check('cat-restrict', 'service delete no longer blocked by legacy category restriction rows', delSvc.status === 200, delSvc.json && delSvc.json.error);

/* ---- clean-URL routing (item 8) + homepage (items 9–10) ---- */
const deep = await fetch(`http://127.0.0.1:${P}/article/${a1.slug}`);
check('routing', 'deep link GET /article/<slug> serves the app shell (200)', deep.status === 200 && (await deep.text()).includes('id="app"'));
const deepAdmin = await fetch(`http://127.0.0.1:${P}/admin/customers`);
check('routing', 'deep link GET /admin/customers serves the shell', deepAdmin.status === 200);
const apiMiss = await fetch(`http://127.0.0.1:${P}/api/definitely-not-a-route`);
check('routing', 'unknown /api path still 404s (fallback does not swallow API)', apiMiss.status === 404);
const appJs = await (await fetch(`http://127.0.0.1:${P}/js/app.js`)).text();
check('routing', 'client router reads location.pathname + pushState/popstate', appJs.includes('location.pathname') && appJs.includes('pushState') && appJs.includes('popstate'));
check('routing', 'legacy #/ hash shim present in served JS', appJs.includes('shimLegacyHash') && appJs.includes("startsWith('#/')"));
check('routing', 'no hash-route links generated by the reader app', !appJs.includes('href="#/'));
check('homepage', '"Browse by Service" section removed from home view', !appJs.includes('Browse by Service'));
const css = await (await fetch(`http://127.0.0.1:${P}/css/styles.css`)).text();
check('homepage', 'category tiles substantially larger (minmax ≥ 230px, min-height ≥ 140px)',
  /minmax\((2[3-9]\d|\d{3,})px/.test(css) && /min-height:\s*(1[4-9]\d|[2-9]\d\d)px/.test(css));
const chipRule = (css.match(/\.chip-pick\s*\{[^}]*\}/) || [''])[0];
check('chips', 'chip-pick labels never shrink or wrap (nowrap + flex 0 0 auto)',
  chipRule.includes('white-space: nowrap') && /flex:\s*0 0 auto/.test(chipRule));
const svcStrong = (css.match(/\.svc-card strong\s*\{[^}]*\}/) || [''])[0];
check('svc-layout', 'homepage service card names stay on one line (nowrap + ellipsis)',
  svcStrong.includes('white-space: nowrap') && svcStrong.includes('text-overflow: ellipsis'));
check('svc-layout', 'service card text column CSS keeps min-width: 0 (rule retained with the shared card styles)',
  /\.svc-card \.svc-txt\s*\{[^}]*min-width:\s*0/.test(css));
const catStrong = (css.match(/\.cat-card strong\s*\{[^}]*\}/) || [''])[0];
check('svc-layout', 'card titles (services list / category tiles) stay on one line',
  catStrong.includes('white-space: nowrap') && catStrong.includes('text-overflow: ellipsis'));
check('svc-layout', 'article meta chips never wrap mid-name',
  /\.article-meta > span\s*\{[^}]*white-space:\s*nowrap/.test(css));
check('svc-layout', 'taxonomy list no longer force-squeezes cards into 3 fixed columns',
  !appJs.includes('grid-template-columns:repeat(3,1fr)'));
const adminJs = await (await fetch(`http://127.0.0.1:${P}/js/admin.js`)).text();
check('homepage', 'admin JS also generates clean links (no href="#/)', !adminJs.includes('href="#/'));
check('cat-restrict', 'admin category form has no service-restriction picker (groups only)',
  !adminJs.includes('tx-rsvc') && !adminJs.includes('Restrict to services') && adminJs.includes('Restrict to groups'));

/* ---- Your Services: own services only, display-only (v1.1.5) ---- */
const hs1 = await req(P, 'POST', '/api/admin/services', { token: A, body: { name: 'HomeSvcOne', description: 'First home service' } });
const hs2 = await req(P, 'POST', '/api/admin/services', { token: A, body: { name: 'HomeSvcTwo' } });
const hs3 = await req(P, 'POST', '/api/admin/services', { token: A, body: { name: 'HomeSvcThree' } });
const HS1 = hs1.json.id, HS2 = hs2.json.id, HS3 = hs3.json.id;
const svcIdSet = rows => [...new Set((rows || []).map(s => s.id))].sort((x, y) => x - y);
const sortedIds = ids => [...ids].sort((x, y) => x - y);
const hank = await req(P, 'POST', '/api/admin/customers', { token: A, body: { name: 'Hank', email: 'hank@x.com', password: 'hankpass123', service_ids: [HS1, HS2] } });
const HT = (await req(P, 'POST', '/api/customer/login', { body: { email: 'hank@x.com', password: 'hankpass123' } })).json.token;
const hankHome = await req(P, 'GET', '/api/home', { token: HT });
check('your-services', 'home payload no longer carries a services list (homepage section removed in 1.2.4; attachments live in Admin + Recommended)',
  hankHome.status === 200 && hankHome.json.services === undefined, JSON.stringify(Object.keys(hankHome.json || {})));
await req(P, 'PUT', '/api/admin/customers/' + hank.json.id, { token: A, body: { service_ids: [HS1, HS2, HS3] } });
custList = await req(P, 'GET', '/api/admin/customers', { token: A });
const hankRow3 = custList.json.find(c => c.id === hank.json.id);
check('your-services', 'attaching a 3rd service still works (admin customer row shows all 3)',
  JSON.stringify(svcIdSet(hankRow3 && hankRow3.services)) === JSON.stringify(sortedIds([HS1, HS2, HS3])), JSON.stringify(svcIdSet(hankRow3 && hankRow3.services)));
const ivan = await req(P, 'POST', '/api/admin/customers', { token: A, body: { name: 'Ivan', email: 'ivan@x.com', password: 'ivanpass123' } });
const IT = (await req(P, 'POST', '/api/customer/login', { body: { email: 'ivan@x.com', password: 'ivanpass123' } })).json.token;
const ivanHome = await req(P, 'GET', '/api/home', { token: IT });
check('your-services', 'customer with no services attached still gets a full home payload (minus the removed services list)',
  ivanHome.status === 200 && ivanHome.json.services === undefined && Array.isArray(ivanHome.json.categories) && Array.isArray(ivanHome.json.recommended));
const homeStart = appJs.indexOf('async function viewHome');
const homeEnd = appJs.indexOf('\nasync function ', homeStart + 10);
const homeSrc = appJs.slice(homeStart, homeEnd > homeStart ? homeEnd : homeStart + 8000);
check('your-services', 'home view no longer renders a "Your Services" section (or reads a services list)',
  !appJs.includes('<h2>Your Services</h2>') && homeStart > -1 && !homeSrc.includes('.services'));
check('your-services', '"View All My Services" link removed from the home view',
  !appJs.includes('View All My Services'));
check('your-services', 'the /services page still serves its shell (All Services untouched)',
  (await fetch(`http://127.0.0.1:${P}/services`)).status === 200);
/* staff: an admin attaches services to their OWN account */
const users0 = await req(P, 'GET', '/api/admin/users', { token: A });
const adminRow0 = users0.json.find(u => u.email === 'admin@x.com');
const ADMIN_ID = adminRow0 && adminRow0.id;
check('your-services', 'admin user row carries a services list (empty before any attachment)',
  !!adminRow0 && Array.isArray(adminRow0.services) && adminRow0.services.length === 0);
const adminHome0 = await req(P, 'GET', '/api/home', { token: A });
check('your-services', 'staff home payload also carries no services list',
  adminHome0.status === 200 && adminHome0.json.services === undefined);
const selfPut = await req(P, 'PUT', '/api/admin/users/' + ADMIN_ID, { token: A, body: { service_ids: [HS2, HS3] } });
check('your-services', 'admin CAN update their own account with services only (no "Nothing to update")',
  selfPut.status === 200, JSON.stringify(selfPut.json));
const users1 = await req(P, 'GET', '/api/admin/users', { token: A });
const adminRow1 = users1.json.find(u => u.id === ADMIN_ID);
check('your-services', 'admin user row now shows the attached services',
  !!adminRow1 && JSON.stringify(svcIdSet(adminRow1.services)) === JSON.stringify(sortedIds([HS2, HS3])), JSON.stringify(adminRow1 && adminRow1.services));
const adminHome1 = await req(P, 'GET', '/api/home', { token: A });
check('your-services', 'staff attachments stay out of the home payload too (they act through Recommended instead)',
  adminHome1.status === 200 && adminHome1.json.services === undefined);
const allSvcAdmin = await req(P, 'GET', '/api/admin/services', { token: A });
check('your-services', 'admin management list still shows ALL services',
  [HS1, HS2, HS3].every(id => (allSvcAdmin.json || []).some(s => s.id === id)));
const readerSvc = await req(P, 'GET', '/api/services', { token: HT });
check('your-services', 'reader /api/services (All Services page data) unchanged — still the full catalog',
  [HS1, HS2, HS3].every(id => (readerSvc.json || []).some(s => s.id === id)));
const disSelf = await req(P, 'PUT', '/api/admin/users/' + ADMIN_ID, { token: A, body: { disabled: true } });
check('your-services', 'self-protection intact: admin still cannot disable their own account',
  disSelf.status === 400 && /cannot disable your own/.test((disSelf.json || {}).error || ''), JSON.stringify(disSelf.json));
const delSelf = await req(P, 'DELETE', '/api/admin/users/' + ADMIN_ID, { token: A });
check('your-services', 'self-protection intact: admin still cannot delete their own account',
  delSelf.status === 400, JSON.stringify(delSelf.json));
check('your-services', 'admin user form has the services multi-select (same chip picker as customers)',
  adminJs.includes('u-svc') && adminJs.includes('service_ids'));

/* ---- cloud providers (items 13–14) ---- */
const cloudSrc = fs.readFileSync(path.join(SRC, 'lib', 'cloud.js'), 'utf8');
{
  // static regression assertions — the class of bug that broke OneDrive
  const odSection = cloudSrc.slice(cloudSrc.indexOf('OneDrive / Microsoft Graph'));
  check('cloud', 'OneDrive section references zero Google hosts', !/googleapis|accounts\.google|google\.com/.test(odSection));
  check('cloud', 'OneDrive URLs built via single-colon path helper (old root:${p} helper gone)', cloudSrc.includes('/me/drive/root:/${relPath}:') && !cloudSrc.includes('root:${p}'));
  check('cloud', 'upload session created on the item path (not after :/content)', cloudSrc.includes("itemPath + '/createUploadSession'") && !cloudSrc.includes("url + ':/createUploadSession'"));
}
check('cloud', 'wizard markup: 3 steps + copyable redirect URI per provider',
  adminJs.includes('Step 1 — Create the app') && adminJs.includes('Step 2 — Paste the keys') && adminJs.includes('Step 3 — Connect')
  && adminJs.includes('/api/admin/cloud/callback/') && adminJs.includes('data-cccopy'));
check('cloud', 'wizard: honest self-hosted copy + provider console deep links',
  adminJs.includes('no central XC Wiki app') && adminJs.includes('console.cloud.google.com/apis/credentials') && adminJs.includes('portal.azure.com'));
check('cloud', 'wizard: connected state shows Test connection + Run test backup', adminJs.includes('data-cctest') && adminJs.includes('Run test backup'));

// provider behaviour against local stubs, via the env endpoint overrides
const stubScript = `
  const http = require('http');
  const hits = { msToken: 0, gToken: 0, graphMe: 0, about: 0 };
  let failMsSecret = false;
  const server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', c => body += c);
    rq.on('end', () => {
      const send = (code, obj, type) => { rs.writeHead(code, { 'Content-Type': type || 'application/json' }); rs.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
      if (rq.url === '/ms/token') {
        hits.msToken++;
        if (failMsSecret) return send(400, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        return send(200, { access_token: 'ms-at', refresh_token: 'ms-rt', expires_in: 3600 });
      }
      if (rq.url === '/g/token') { hits.gToken++; return send(200, { access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3600 }); }
      if (rq.url === '/graph/me') { hits.graphMe++; return send(200, { displayName: 'Stub User', mail: 'stub@ms.example', userPrincipalName: 'stub@ms.example' }); }
      if (rq.url === '/graph/me/drive/root/children' && rq.method === 'POST') return send(201, { id: 'folder-ms' });
      if (rq.url.startsWith('/graph/me/drive/root:/') && rq.url.includes('/children')) return send(200, { value: [] });
      if (rq.url === '/g/drive/v3/about?fields=user') { hits.about++; return send(200, { user: { displayName: 'G User', emailAddress: 'g@g.example' } }); }
      if (rq.url.startsWith('/g/drive/v3/files') && rq.url.includes('mimeType')) return send(200, { files: [{ id: 'folder-g' }] });
      if (rq.url.startsWith('/g/drive/v3/files')) return send(200, { files: [] });
      return send(404, { error: 'stub-unhandled ' + rq.method + ' ' + rq.url });
    });
  });
  server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    process.env.XCWIKI_MS_TOKEN_URL = \`http://127.0.0.1:\${port}/ms/token\`;
    process.env.XCWIKI_MS_GRAPH_BASE = \`http://127.0.0.1:\${port}/graph\`;
    process.env.XCWIKI_GOOGLE_TOKEN_URL = \`http://127.0.0.1:\${port}/g/token\`;
    process.env.XCWIKI_GOOGLE_API_BASE = \`http://127.0.0.1:\${port}/g\`;
    try {
      const { getDb } = require('./lib/db');
      const cloud = require('./lib/cloud');
      const db = getDb();
      cloud.saveClientCreds(db, 'onedrive', 'ms-client-id', 'ms-secret');
      const tok = await cloud.exchangeCode(db, 'onedrive', 'code123', 'http://x/api/admin/cloud/callback/onedrive');
      cloud.storeTokens(db, 'onedrive', tok);
      const test = await cloud.testConnection(db, 'onedrive');
      cloud.saveClientCreds(db, 'google', 'g-client-id', 'g-secret');
      const gtok = await cloud.exchangeCode(db, 'google', 'code123', 'http://x/api/admin/cloud/callback/google');
      cloud.storeTokens(db, 'google', gtok);
      const gtest = await cloud.testConnection(db, 'google');
      failMsSecret = true;
      let failMsg = '';
      try { await cloud.exchangeCode(db, 'onedrive', 'code123', 'http://x/api/admin/cloud/callback/onedrive'); }
      catch (e) { failMsg = e.message; }
      console.log(JSON.stringify({ msTest: test, gTest: gtest, failMsg, hits }));
    } catch (e) {
      console.log(JSON.stringify({ fatal: String(e && e.message || e) }));
    } finally { server.close(); }
  });
`;
const cloudOut = execFileSync('node', ['-e', stubScript], { cwd: mainDir, env: { ...process.env, ENCRYPTION_KEY: ENC }, encoding: 'utf8' });
{
  const co = JSON.parse(cloudOut.trim().split('\n').pop());
  check('cloud', 'OneDrive: token exchange + Graph /me + folder + list all hit the Microsoft stub', !!co.msTest && co.msTest.ok === true && co.hits.msToken >= 1 && co.hits.graphMe === 1, JSON.stringify(co).slice(0, 200));
  check('cloud', 'OneDrive: account identity captured from /me', !!co.msTest && co.msTest.account_email === 'stub@ms.example');
  check('cloud', 'Google: token exchange + about + folder + list hit the Google stub', !!co.gTest && co.gTest.ok === true && co.gTest.account_email === 'g@g.example');
  check('cloud', 'invalid client secret surfaces a plain-language secret error (not raw payload)', /client secret/i.test(co.failMsg || '') && /VALUE/.test(co.failMsg || ''), co.failMsg);
}

/* ---- v1.1.4: category cover upload path + upload error clarity ----
   Regression coverage for the "Upload button does nothing" report:
   the happy path (upload-multi PNG → category cover persists and is
   served to readers), the HEIC/oversize failure paths (clear human
   errors, not multer's raw text), and source guards for the de-nested
   <label> markup + inline cover status element. */
{
  const upPost = async (files) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', new Blob([f.buf], { type: f.type }), f.name);
    const res = await fetch(`http://127.0.0.1:${P}/api/admin/upload-multi`, { method: 'POST', headers: { Authorization: 'Bearer ' + A }, body: fd });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const heicBuf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64, 7)]);

  const up1 = await upPost([{ buf: pngBuf, type: 'image/png', name: 'cover.png' }]);
  const coverUrl = up1.json && up1.json.files && up1.json.files[0] && up1.json.files[0].url;
  check('cover-upload', 'upload-multi accepts a PNG and returns files[0].url', up1.status === 200 && /^\/media\/[a-f0-9]{32}\.png$/.test(coverUrl || ''), JSON.stringify(up1.json).slice(0, 120));
  check('cover-upload', 'uploaded file has image kind', !!(up1.json && up1.json.files && up1.json.files[0] && up1.json.files[0].kind === 'image'));

  if (coverUrl) {
    const mediaRes = await fetch(`http://127.0.0.1:${P}${coverUrl}`, { headers: { Authorization: 'Bearer ' + A } });
    check('cover-upload', 'uploaded media is served back to staff', mediaRes.status === 200 && (mediaRes.headers.get('content-type') || '').includes('image/png'), String(mediaRes.status));

    const cc = await req(P, 'POST', '/api/admin/categories', { token: A, body: { name: 'CoverCat', visibility: 'all', cover_image: coverUrl } });
    check('cover-upload', 'category saves with cover_image', cc.status === 200);
    const adminCats2 = await req(P, 'GET', '/api/admin/categories', { token: A });
    const coverRow = (adminCats2.json || []).find(c => c.name === 'CoverCat');
    check('cover-upload', 'cover_image persists on the category (admin list)', !!coverRow && coverRow.cover_image === coverUrl, coverRow && coverRow.cover_image);
    const readerCats = await req(P, 'GET', '/api/categories', { token: FT });
    const readerRow = (readerCats.json || []).find(c => c.name === 'CoverCat');
    check('cover-upload', 'reader category payload carries the cover_image', !!readerRow && readerRow.cover_image === coverUrl);
  }

  const upHeic = await upPost([{ buf: heicBuf, type: 'image/heic', name: 'IMG_4021.HEIC' }]);
  check('cover-upload', 'HEIC upload is rejected', upHeic.status === 400, String(upHeic.status));
  check('cover-upload', 'HEIC rejection explains the format and the fix (JPG/PNG)', /HEIC/.test((upHeic.json || {}).error || '') && /JPG or PNG/.test((upHeic.json || {}).error || ''), (upHeic.json || {}).error || upHeic.text.slice(0, 120));
  const upHeic2 = await upPost([{ buf: heicBuf, type: '', name: 'photo.heic' }]);
  check('cover-upload', 'HEIC rejected by extension even with empty mimetype', upHeic2.status === 400 && /HEIC/.test((upHeic2.json || {}).error || ''));

  const bigBuf = Buffer.alloc(16 * 1024 * 1024, 1); pngBuf.copy(bigBuf, 0);
  const upBig = await upPost([{ buf: bigBuf, type: 'image/png', name: 'huge.png' }]);
  check('cover-upload', 'oversize upload is rejected', upBig.status === 400, String(upBig.status));
  check('cover-upload', 'oversize rejection states the 15 MB limit', /15 MB/.test((upBig.json || {}).error || ''), (upBig.json || {}).error || '');

  const upExe = await upPost([{ buf: Buffer.from('MZ'), type: 'application/octet-stream', name: 'tool.exe' }]);
  check('cover-upload', 'unsupported type rejected with a plain-language message', upExe.status === 400 && /isn't supported/.test((upExe.json || {}).error || ''), (upExe.json || {}).error || '');

  const adminSrc = fs.readFileSync(path.join(SRC, 'public', 'js', 'admin.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(SRC, 'public', 'css', 'styles.css'), 'utf8');
  check('cover-upload', 'cover field is a div.fld (no <label> nested in <label>) with an inline status element',
    adminSrc.includes('<div class="fld"><span>Cover image') && adminSrc.includes('id="tx-covermsg"') && !adminSrc.includes('<label class="fld"><span>Cover image'));
  check('cover-upload', 'branding upload fields de-nested too (logo / favicon / hero)',
    adminSrc.includes('<div class="fld"><span>Logo image URL') && adminSrc.includes('<div class="fld"><span>Favicon') && adminSrc.includes('<div class="fld"><span>Background banner image')
    && !adminSrc.includes('<label class="fld"><span>Logo image URL') && !adminSrc.includes('<label class="fld"><span>Background banner image'));
  check('cover-upload', 'chip-picker fields de-nested (restrict / invites / customer form)',
    adminSrc.includes('<div class="fld"><span>Restrict to groups') && adminSrc.includes('<div class="fld"><span>Services</span>') && adminSrc.includes('<div class="fld"><span>Groups <small'));
  const coverHandlerAt = adminSrc.indexOf("tx-coverfile').onchange");
  check('cover-upload', 'cover handler resets the file input (same-file retry fires change again)',
    coverHandlerAt >= 0 && adminSrc.slice(coverHandlerAt, coverHandlerAt + 700).includes("e.target.value = '';"));
  check('cover-upload', 'client pre-check + server filter both carry the HEIC message',
    adminSrc.includes('HEIC format') && serverSrc.includes('HEIC format') && serverSrc.includes('LIMIT_FILE_SIZE'));
  check('cover-upload', 'fld styles generalized to .fld (div wrappers render like label wrappers)',
    cssSrc.includes('.fld { display: block') && !cssSrc.includes('label.fld {'));
}

/* ---- v1.2.0: category page banner (banner_image), separate from the
   homepage cover_image. Migration on an existing DB, independent
   persistence of the two images, reader payloads for both surfaces,
   the cover fallback when no banner is set, and source guards for the
   admin field + public page render choice. */
{
  /* Migration: a DB whose categories table predates banner_image. */
  const legacyDir = makeCopy('legacy-cat');
  execFileSync('node', ['-e', `
    const Database = require(${JSON.stringify(path.join(SRC, 'node_modules', 'better-sqlite3'))});
    const db = new Database(${JSON.stringify(path.join(WORK, 'legacy-cat', 'data', 'xcwiki.db'))});
    db.exec(\`
      CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', icon TEXT DEFAULT '📄', icon_image TEXT DEFAULT '', cover_image TEXT DEFAULT '', color TEXT DEFAULT '#3B82F6', parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'all');
    \`);
    db.prepare('INSERT INTO categories (name, slug, cover_image) VALUES (?, ?, ?)')
      .run('Legacy Cat', 'legacy-cat', '/media/legacy-cover.png');
    db.close();
    console.log('preseeded');
  `], { stdio: 'inherit' });
  await boot(legacyDir, 4124);
  const Database = require(path.join(SRC, 'node_modules', 'better-sqlite3'));
  const ldb = new Database(path.join(legacyDir, 'data', 'xcwiki.db'), { readonly: true });
  const catCols = ldb.prepare('PRAGMA table_info(categories)').all().map(c => c.name);
  check('cat-banner', 'migration adds banner_image to an existing categories table', catCols.includes('banner_image'));
  const legacyRow = ldb.prepare('SELECT cover_image, banner_image FROM categories WHERE slug = ?').get('legacy-cat');
  check('cat-banner', 'existing row keeps its cover and defaults banner_image to empty', !!legacyRow && legacyRow.cover_image === '/media/legacy-cover.png' && legacyRow.banner_image === '', JSON.stringify(legacyRow));
  ldb.close();

  /* Main flow: the two images persist independently. */
  const bc = await req(P, 'POST', '/api/admin/categories', { token: A, body: { name: 'BannerCat', visibility: 'all', cover_image: '/media/cover-b.png', banner_image: '/media/banner-b.png' } });
  check('cat-banner', 'category creates with distinct cover_image + banner_image', bc.status === 200, JSON.stringify(bc.json));
  const adminCatsB = await req(P, 'GET', '/api/admin/categories', { token: A });
  const brow = (adminCatsB.json || []).find(c => c.name === 'BannerCat');
  check('cat-banner', 'admin categories payload includes banner_image', !!brow && 'banner_image' in brow);
  check('cat-banner', 'cover_image and banner_image persist independently', !!brow && brow.cover_image === '/media/cover-b.png' && brow.banner_image === '/media/banner-b.png', brow && `${brow.cover_image} | ${brow.banner_image}`);

  if (brow) {
    /* Reader detail (the category page's data): both images, banner distinct. */
    const det = await req(P, 'GET', '/api/categories/' + brow.slug, { token: FT });
    check('cat-banner', 'category page payload carries banner_image when set', det.status === 200 && det.json.category.banner_image === '/media/banner-b.png', det.json && det.json.category && det.json.category.banner_image);
    check('cat-banner', 'category page payload still carries the cover_image for cards', det.status === 200 && det.json.category.cover_image === '/media/cover-b.png');
    /* Reader list (the homepage-card surface): cover unchanged + present. */
    const listRow = ((await req(P, 'GET', '/api/categories', { token: FT })).json || []).find(c => c.name === 'BannerCat');
    check('cat-banner', 'homepage list payload keeps cover_image as the card image', !!listRow && listRow.cover_image === '/media/cover-b.png');

    /* Update the banner alone: cover must not move. */
    const upd = await req(P, 'PUT', '/api/admin/categories/' + brow.id, { token: A, body: { banner_image: '/media/banner-b2.png' } });
    const afterUpd = ((await req(P, 'GET', '/api/admin/categories', { token: A })).json || []).find(c => c.id === brow.id);
    check('cat-banner', 'banner-only update persists and leaves cover_image untouched', upd.status === 200 && !!afterUpd && afterUpd.banner_image === '/media/banner-b2.png' && afterUpd.cover_image === '/media/cover-b.png', afterUpd && `${afterUpd.cover_image} | ${afterUpd.banner_image}`);

    /* Clear the banner: payload falls back to cover-only (page uses cover). */
    const clr = await req(P, 'PUT', '/api/admin/categories/' + brow.id, { token: A, body: { banner_image: '' } });
    const det2 = await req(P, 'GET', '/api/categories/' + brow.slug, { token: FT });
    check('cat-banner', 'cleared banner persists as empty with cover_image intact (cover fallback)', clr.status === 200 && det2.status === 200 && det2.json.category.banner_image === '' && det2.json.category.cover_image === '/media/cover-b.png', det2.json && det2.json.category && `${det2.json.category.cover_image} | "${det2.json.category.banner_image}"`);
  }

  /* Source guards: admin field + payload, and the public page's
     banner-first/cover-fallback choice in viewTaxonomyDetail. */
  const adminSrcB = fs.readFileSync(path.join(SRC, 'public', 'js', 'admin.js'), 'utf8');
  const appSrcB = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  check('cat-banner', 'admin category form has a Page banner field with upload/preview/status elements',
    adminSrcB.includes('<div class="fld"><span>Page banner — category page top') && adminSrcB.includes('id="tx-bannerimg"') && adminSrcB.includes('id="tx-bannerprev"') && adminSrcB.includes('id="tx-bannermsg"') && adminSrcB.includes('id="tx-bannerfile"'));
  check('cat-banner', 'admin save payload sends banner_image', adminSrcB.includes('payload.banner_image'));
  check('cat-banner', 'cover field is labeled as the homepage card image', adminSrcB.includes('<div class="fld"><span>Cover image — homepage card'));
  check('cat-banner', 'category page render picks banner_image first, cover_image as fallback',
    appSrcB.includes('obj.banner_image || obj.cover_image') && appSrcB.includes('class="cat-banner" src="${esc(bannerImage)}"'));
  check('cat-banner', 'homepage cards still render cover_image only', appSrcB.includes('if (c && c.cover_image) return `<img class="ci-cover" src="${esc(c.cover_image)}" alt="">`;'));
}

/* ---- v1.2.1: site-wide theme mode (theme_mode). 'dark' forces the
   dark theme for every visitor, 'light' forces light, 'system' hands
   the choice to each visitor's device/toggle. Dark is the default on
   a fresh install AND on an existing settings DB that predates the
   key; invalid values saved through the admin API normalize to dark. */
{
  /* Fresh install (the main flow's scratch install): dark by default,
     in both the public payload and the admin settings view. */
  const pubT = await req(P, 'GET', '/api/settings/public');
  check('theme-mode', 'public settings payload includes theme_mode', pubT.status === 200 && 'theme_mode' in pubT.json);
  check('theme-mode', 'fresh install defaults theme_mode to dark', pubT.json.theme_mode === 'dark', pubT.json.theme_mode);
  const admT = await req(P, 'GET', '/api/admin/settings', { token: A });
  check('theme-mode', 'admin settings carry theme_mode dark by default', !!admT.json && admT.json.theme_mode === 'dark', admT.json && admT.json.theme_mode);

  /* Admin round-trip: light, then system — both reach the public payload. */
  const putLight = await req(P, 'PUT', '/api/admin/settings', { token: A, body: { theme_mode: 'light' } });
  const pubLight = await req(P, 'GET', '/api/settings/public');
  check('theme-mode', 'admin save round-trips theme_mode=light to the public payload',
    putLight.status === 200 && putLight.json.theme_mode === 'light' && pubLight.json.theme_mode === 'light', pubLight.json.theme_mode);
  const putSys = await req(P, 'PUT', '/api/admin/settings', { token: A, body: { theme_mode: 'system' } });
  const pubSys = await req(P, 'GET', '/api/settings/public');
  check('theme-mode', 'admin save round-trips theme_mode=system to the public payload',
    putSys.status === 200 && putSys.json.theme_mode === 'system' && pubSys.json.theme_mode === 'system', pubSys.json.theme_mode);

  /* Invalid values normalize to dark (this also restores dark on main). */
  const putBad = await req(P, 'PUT', '/api/admin/settings', { token: A, body: { theme_mode: 'banana' } });
  const admBad = await req(P, 'GET', '/api/admin/settings', { token: A });
  check('theme-mode', 'invalid theme_mode value normalizes to dark',
    putBad.status === 200 && putBad.json.theme_mode === 'dark' && admBad.json.theme_mode === 'dark', putBad.json && putBad.json.theme_mode);

  /* Existing install: a settings DB written before theme_mode existed
     (rows present, no theme_mode row — and a light default_theme, which
     must NOT leak into the mode) still reports dark. */
  const legacySetDir = makeCopy('legacy-settings');
  execFileSync('node', ['-e', `
    const Database = require(${JSON.stringify(path.join(SRC, 'node_modules', 'better-sqlite3'))});
    const db = new Database(${JSON.stringify(path.join(WORK, 'legacy-settings', 'data', 'xcwiki.db'))});
    db.exec(\`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');\`);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('site_title', 'Legacy Title');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('default_theme', 'light');
    db.close();
    console.log('preseeded');
  `], { stdio: 'inherit' });
  await boot(legacySetDir, 4125);
  const pubLegacy = await req(4125, 'GET', '/api/settings/public');
  check('theme-mode', 'existing settings DB without theme_mode defaults to dark',
    pubLegacy.status === 200 && pubLegacy.json.theme_mode === 'dark', pubLegacy.json && pubLegacy.json.theme_mode);
  check('theme-mode', 'existing settings rows survive alongside the new default',
    pubLegacy.json.site_title === 'Legacy Title', pubLegacy.json.site_title);

  /* Source guards: default, payload key, save normalization, and the
     public + admin application of the mode. */
  const dbSrcT = fs.readFileSync(path.join(SRC, 'lib', 'db.js'), 'utf8');
  const serverSrcT = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const appSrcT = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  const adminSrcT = fs.readFileSync(path.join(SRC, 'public', 'js', 'admin.js'), 'utf8');
  check('theme-mode', 'setting default is dark in SETTING_DEFAULTS', dbSrcT.includes("theme_mode: 'dark'"));
  check('theme-mode', 'public payload key list carries theme_mode', serverSrcT.includes("'default_theme', 'theme_mode'"));
  check('theme-mode', 'settings save normalizes theme_mode against the enum',
    serverSrcT.includes("body.theme_mode = ['dark', 'light', 'system'].includes(body.theme_mode) ? body.theme_mode : 'dark'"));
  check('theme-mode', 'public app resolves the site mode from the public settings payload',
    appSrcT.includes('App.settings.theme_mode') && appSrcT.includes('function siteThemeMode()'));
  check('theme-mode', 'forced mode hides the visitor toggle; system mode stays visitor-driven',
    appSrcT.includes("classList.toggle('hidden', siteThemeMode() !== 'system')") && appSrcT.includes("pref = store.get('xcwiki_theme') || 'system'"));
  check('theme-mode', 'admin branding form carries the Theme mode control with the three labels',
    adminSrcT.includes('id="b-thememode"') && adminSrcT.includes('Dark only (default)') && adminSrcT.includes('Light only') && adminSrcT.includes("Match visitor's device"));
  check('theme-mode', 'admin save payload sends theme_mode', adminSrcT.includes("theme_mode: v('b-thememode')"));
}

/* ---- v1.2.2: media performance — category cover/banner uploads are
   stored at web size (JPEG) instead of byte-identical originals, other
   uploads are untouched, a corrupt file on the category path still
   uploads (original stored), and /media serves a long-lived immutable
   private cache header (stored names change per upload). */
{
  const { Jimp } = require(path.join(SRC, 'node_modules', 'jimp'));
  const upPost2 = async (file, purpose) => {
    const fd = new FormData();
    fd.append('files', new Blob([file.buf], { type: file.type }), file.name);
    if (purpose) fd.append('purpose', purpose);
    const res = await fetch(`http://127.0.0.1:${P}/api/admin/upload-multi`, { method: 'POST', headers: { Authorization: 'Bearer ' + A }, body: fd });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const fetchMedia = async (url) => {
    const res = await fetch(`http://127.0.0.1:${P}${url}`, { headers: { Authorization: 'Bearer ' + A } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  };
  const attRow = async (url) => {
    const list = await req(P, 'GET', '/api/admin/attachments', { token: A });
    return (list.json || []).find(r => r.url === url);
  };

  /* Photo-like fixture: a gradient + per-pixel pattern, so the PNG does
     not compress to nothing the way a flat color does (real cover PNGs
     run hundreds of KB; a flat PNG would make the JPEG look bigger). */
  const bigImg = new Jimp({ width: 3200, height: 1800, color: 0x000000ff });
  bigImg.scan((x, y, idx) => {
    bigImg.bitmap.data[idx] = Math.floor((x / 3200) * 255);
    bigImg.bitmap.data[idx + 1] = Math.floor((y / 1800) * 255);
    bigImg.bitmap.data[idx + 2] = (x ^ y) % 256;
  });
  const bigPng = await bigImg.getBuffer('image/png');

  /* Oversized category cover: stored within the 1600×900 cap, as JPEG. */
  const upCover = await upPost2({ buf: bigPng, type: 'image/png', name: 'big-cover.png' }, 'category_cover');
  const coverUrl2 = upCover.json && upCover.json.files && upCover.json.files[0] && upCover.json.files[0].url;
  check('media-perf', 'oversized category cover upload succeeds and returns a .jpg url',
    upCover.status === 200 && /\.jpg$/.test(coverUrl2 || ''), JSON.stringify(upCover.json).slice(0, 120));
  if (coverUrl2) {
    const row = await attRow(coverUrl2);
    check('media-perf', 'stored cover attachment records image/jpeg mime', !!row && row.mime_type === 'image/jpeg', row && row.mime_type);
    const served = await fetchMedia(coverUrl2);
    const dims = await Jimp.read(served.buf).then(im => im.bitmap).catch(() => null);
    check('media-perf', 'served cover is within the caps (1600×900 from 3200×1800)',
      served.status === 200 && !!dims && dims.width === 1600 && dims.height === 900, dims && `${dims.width}x${dims.height}`);
    check('media-perf', 'served cover content-type is image/jpeg',
      (served.headers.get('content-type') || '').includes('image/jpeg'), served.headers.get('content-type'));
    check('media-perf', '/media serves the 30-day immutable private cache header',
      served.headers.get('cache-control') === 'private, max-age=2592000, immutable', served.headers.get('cache-control'));
    check('media-perf', 'stored cover is far smaller than the original upload',
      !!row && row.size_bytes < bigPng.length, row && `${row.size_bytes} vs ${bigPng.length}`);
  }

  /* Oversized category banner: width capped at 2560, aspect kept. */
  const bigBannerPng = await new Jimp({ width: 3200, height: 800, color: 0xcc6633ff }).getBuffer('image/png');
  const upBanner = await upPost2({ buf: bigBannerPng, type: 'image/png', name: 'big-banner.png' }, 'category_banner');
  const bannerUrl2 = upBanner.json && upBanner.json.files && upBanner.json.files[0] && upBanner.json.files[0].url;
  check('media-perf', 'oversized category banner upload returns a .jpg url', upBanner.status === 200 && /\.jpg$/.test(bannerUrl2 || ''), bannerUrl2);
  if (bannerUrl2) {
    const served = await fetchMedia(bannerUrl2);
    const dims = await Jimp.read(served.buf).then(im => im.bitmap).catch(() => null);
    check('media-perf', 'served banner is capped at 2560 wide with aspect kept (2560×640)',
      !!dims && dims.width === 2560 && dims.height === 640, dims && `${dims.width}x${dims.height}`);
  }

  /* Same oversized file WITHOUT the category marker: stored untouched. */
  const upPlain = await upPost2({ buf: bigPng, type: 'image/png', name: 'plain-big.png' }, null);
  const plainUrl = upPlain.json && upPlain.json.files && upPlain.json.files[0] && upPlain.json.files[0].url;
  check('media-perf', 'oversized non-category upload keeps its .png url', upPlain.status === 200 && /\.png$/.test(plainUrl || ''), plainUrl);
  if (plainUrl) {
    const row = await attRow(plainUrl);
    check('media-perf', 'non-category upload stored byte-identical (size + png mime)',
      !!row && row.mime_type === 'image/png' && row.size_bytes === bigPng.length, row && `${row.size_bytes} vs ${bigPng.length}`);
    const served = await fetchMedia(plainUrl);
    const dims = await Jimp.read(served.buf).then(im => im.bitmap).catch(() => null);
    check('media-perf', 'non-category upload keeps full 3200×1800 dimensions', !!dims && dims.width === 3200 && dims.height === 1800, dims && `${dims.width}x${dims.height}`);
  }

  /* Small category cover (within caps): also untouched — no re-encode. */
  const smallPng = await new Jimp({ width: 800, height: 450, color: 0x33cc66ff }).getBuffer('image/png');
  const upSmall = await upPost2({ buf: smallPng, type: 'image/png', name: 'small-cover.png' }, 'category_cover');
  const smallUrl = upSmall.json && upSmall.json.files && upSmall.json.files[0] && upSmall.json.files[0].url;
  check('media-perf', 'within-caps category cover is stored untouched (.png, same size)',
    upSmall.status === 200 && /\.png$/.test(smallUrl || ''), smallUrl);
  if (smallUrl) {
    const row = await attRow(smallUrl);
    check('media-perf', 'within-caps cover keeps png mime and original size',
      !!row && row.mime_type === 'image/png' && row.size_bytes === smallPng.length, row && `${row.size_bytes} vs ${smallPng.length}`);
  }

  /* Corrupt file on the category path: upload still succeeds, the
     original bytes are stored (downscale falls back, never fails). */
  const junk = Buffer.from('this is not really a png, just bytes with a png name');
  const upJunk = await upPost2({ buf: junk, type: 'image/png', name: 'broken.png' }, 'category_cover');
  const junkUrl = upJunk.json && upJunk.json.files && upJunk.json.files[0] && upJunk.json.files[0].url;
  check('media-perf', 'corrupt category upload still succeeds (200) with a .png url',
    upJunk.status === 200 && /\.png$/.test(junkUrl || ''), JSON.stringify(upJunk.json).slice(0, 120));
  if (junkUrl) {
    const row = await attRow(junkUrl);
    const served = await fetchMedia(junkUrl);
    check('media-perf', 'corrupt upload stored byte-identical (original preserved)',
      !!row && row.size_bytes === junk.length && served.buf.length === junk.length, row && `${row.size_bytes} vs ${junk.length}`);
  }

  /* Source guards. */
  const serverSrcP = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const adminSrcP = fs.readFileSync(path.join(SRC, 'public', 'js', 'admin.js'), 'utf8');
  check('media-perf', 'server carries the immutable cache header and the category caps',
    serverSrcP.includes("'private, max-age=2592000, immutable'") && serverSrcP.includes('maxW: 1600, maxH: 900') && serverSrcP.includes('maxW: 2560'));
  check('media-perf', 'admin upload helper forwards the purpose marker',
    adminSrcP.includes("fd.append('purpose', purpose)") && adminSrcP.includes("uploadFiles([f], null, 'category_cover')") && adminSrcP.includes("uploadFiles([f], null, 'category_banner')"));
}

/* ---- v1.2.3: category reordering — the homepage category order is
   a stored, staff-editable order. A boot-time backfill makes existing
   installs' sort_order values distinct WITHOUT changing the order the
   homepage shows; PUT /api/admin/categories/order saves a new order;
   categories created without a sort_order append at the end. */
{
  const roDir = makeCopy('reorder');
  /* Pre-existing install: categories whose sort_order values collide
     (the pre-1.2.3 norm). Today's homepage order for these rows is
     (sort_order, name): Alpha, Mike, Zeta, Beta, Delta. */
  execFileSync('node', ['-e', `
    const Database = require(${JSON.stringify(path.join(SRC, 'node_modules', 'better-sqlite3'))});
    const db = new Database(${JSON.stringify(path.join(WORK, 'reorder', 'data', 'xcwiki.db'))});
    db.exec(\`
      CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', icon TEXT DEFAULT '📄', icon_image TEXT DEFAULT '', cover_image TEXT DEFAULT '', color TEXT DEFAULT '#3B82F6', parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, sort_order INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'all');
    \`);
    const ins = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
    ins.run('Zeta', 'zeta', 0); ins.run('Alpha', 'alpha', 0); ins.run('Mike', 'mike', 0);
    ins.run('Beta', 'beta', 5); ins.run('Delta', 'delta', 5);
    db.close();
    console.log('preseeded');
  `], { stdio: 'inherit' });
  const roChild = await boot(roDir, 4126);
  const Database = require(path.join(SRC, 'node_modules', 'better-sqlite3'));
  const readCats = () => {
    const db = new Database(path.join(roDir, 'data', 'xcwiki.db'), { readonly: true });
    const rows = db.prepare('SELECT id, name, sort_order FROM categories ORDER BY sort_order, name').all();
    db.close(); return rows;
  };
  const FIX = ['Alpha', 'Mike', 'Zeta', 'Beta', 'Delta'];
  const onlyFix = names => names.filter(n => FIX.includes(n) || n === 'Omega' || n === 'Aardvark');

  /* Backfill: same visible order, distinct values. (Booting also seeds
     the staff-only Internal Ops category at the end — it takes part in
     the order like any category.) */
  const afterBoot = readCats();
  check('cat-order', 'backfill preserves the current homepage order exactly',
    JSON.stringify(afterBoot.map(r => r.name).filter(n => FIX.includes(n))) === JSON.stringify(FIX), afterBoot.map(r => `${r.name}:${r.sort_order}`).join(', '));
  check('cat-order', 'backfill makes every sort_order value distinct',
    new Set(afterBoot.map(r => r.sort_order)).size === afterBoot.length, afterBoot.map(r => r.sort_order).join(','));

  const roSetup = await req(4126, 'POST', '/api/setup', { body: { email: 'ro@x.com', password: 'ropass12345', display_name: 'RO' } });
  const RA = roSetup.json && roSetup.json.token;
  check('cat-order', 'first-run setup works on the preseeded install', roSetup.status === 200 && !!RA);
  const homeNames = async (port, token) => ((await req(port, 'GET', '/api/home', { token })).json.categories || []).map(c => c.name);
  check('cat-order', 'homepage API returns the backfilled order',
    JSON.stringify(onlyFix(await homeNames(4126, RA))) === JSON.stringify(FIX), (await homeNames(4126, RA)).join(', '));

  /* Reorder: staff saves a new full order; homepage + storage follow. */
  const adminCats = (await req(4126, 'GET', '/api/admin/categories', { token: RA })).json || [];
  const idOf = n => (adminCats.find(c => c.name === n) || {}).id;
  const others = adminCats.map(c => c.name).filter(n => !FIX.includes(n)).map(idOf);
  const wanted = ['Delta', 'Alpha', 'Zeta', 'Mike', 'Beta'].map(idOf);
  const put = await req(4126, 'PUT', '/api/admin/categories/order', { token: RA, body: { ids: [...wanted, ...others] } });
  check('cat-order', 'order endpoint accepts the full ordered id list', put.status === 200 && !!put.json && put.json.ok === true, JSON.stringify(put.json).slice(0, 120));
  check('cat-order', 'homepage API follows the saved order',
    JSON.stringify(onlyFix(await homeNames(4126, RA))) === JSON.stringify(['Delta', 'Alpha', 'Zeta', 'Mike', 'Beta']), (await homeNames(4126, RA)).join(', '));
  const stored = readCats();
  check('cat-order', 'stored order renumbered 10, 20, 30… in the saved sequence',
    stored.every((r, i) => r.sort_order === (i + 1) * 10) && stored[0].name === 'Delta' && stored[4].name === 'Beta',
    stored.map(r => `${r.name}:${r.sort_order}`).join(', '));

  /* Invalid payloads: rejected, and the order is untouched. */
  const badUnknown = await req(4126, 'PUT', '/api/admin/categories/order', { token: RA, body: { ids: [...wanted, 999999] } });
  check('cat-order', 'unknown category id is rejected (400)', badUnknown.status === 400, 'status ' + badUnknown.status);
  const badDup = await req(4126, 'PUT', '/api/admin/categories/order', { token: RA, body: { ids: [wanted[0], wanted[0], wanted[1]] } });
  check('cat-order', 'duplicate ids are rejected (400)', badDup.status === 400, 'status ' + badDup.status);
  const badEmpty = await req(4126, 'PUT', '/api/admin/categories/order', { token: RA, body: { ids: [] } });
  check('cat-order', 'an empty id list is rejected (400)', badEmpty.status === 400, 'status ' + badEmpty.status);
  const badAnon = await req(4126, 'PUT', '/api/admin/categories/order', { body: { ids: wanted } });
  check('cat-order', 'a signed-out caller is rejected (401)', badAnon.status === 401, 'status ' + badAnon.status);
  const custLogin = await req(4126, 'POST', '/api/customer/login', { body: { email: 'priya@example.com', password: 'customer123' } });
  const badCust = await req(4126, 'PUT', '/api/admin/categories/order', { token: custLogin.json && custLogin.json.token, body: { ids: wanted } });
  check('cat-order', 'a signed-in customer (non-staff) is rejected (401)', badCust.status === 401, 'status ' + badCust.status);
  check('cat-order', 'the order is unchanged after the invalid payloads',
    JSON.stringify(onlyFix(await homeNames(4126, RA))) === JSON.stringify(['Delta', 'Alpha', 'Zeta', 'Mike', 'Beta']));

  /* Creation: no sort_order appends at the end; an explicit one wins. */
  const nc = await req(4126, 'POST', '/api/admin/categories', { token: RA, body: { name: 'Omega' } });
  const listAfterCreate = (await req(4126, 'GET', '/api/admin/categories', { token: RA })).json || [];
  const omega = listAfterCreate[listAfterCreate.length - 1];
  check('cat-order', 'a category created without sort_order appends at the very end',
    nc.status === 200 && !!omega && omega.name === 'Omega', omega && `${omega.name}:${omega.sort_order}`);
  const nc2 = await req(4126, 'POST', '/api/admin/categories', { token: RA, body: { name: 'Aardvark', sort_order: 5 } });
  const homeAfterCreate = await homeNames(4126, RA);
  check('cat-order', 'an explicit sort_order on create is respected (goes first)',
    nc2.status === 200 && homeAfterCreate[0] === 'Aardvark', homeAfterCreate.join(', '));

  /* Deletion: the remaining relative order survives. */
  const zetaRow = ((await req(4126, 'GET', '/api/admin/categories', { token: RA })).json || []).find(c => c.name === 'Zeta');
  await req(4126, 'DELETE', '/api/admin/categories/' + zetaRow.id, { token: RA });
  check('cat-order', 'deleting a category keeps the remaining relative order',
    JSON.stringify(onlyFix(await homeNames(4126, RA))) === JSON.stringify(['Aardvark', 'Delta', 'Alpha', 'Mike', 'Beta', 'Omega']),
    (await homeNames(4126, RA)).join(', '));

  /* Persistence: restart on the same data dir — the order survives. */
  try { roChild.kill('SIGKILL'); } catch {}
  await sleep(500);
  await boot(roDir, 4127);
  const roLogin = await req(4127, 'POST', '/api/auth/login', { body: { email: 'ro@x.com', password: 'ropass12345' } });
  check('cat-order', 'the saved order persists across a restart',
    roLogin.status === 200 && JSON.stringify(onlyFix(await homeNames(4127, roLogin.json.token))) === JSON.stringify(['Aardvark', 'Delta', 'Alpha', 'Mike', 'Beta', 'Omega']),
    (await homeNames(4127, roLogin.json && roLogin.json.token)).join(', '));

  /* Source guards: endpoint registered before the :id CRUD route,
     append-at-end hook, admin controls, homepage staff drag. */
  const serverSrcO = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const adminSrcO = fs.readFileSync(path.join(SRC, 'public', 'js', 'admin.js'), 'utf8');
  const appSrcO = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  const dbSrcO = fs.readFileSync(path.join(SRC, 'lib', 'db.js'), 'utf8');
  const orderIdx = serverSrcO.indexOf("app.put('/api/admin/categories/order', requireAuth");
  check('cat-order', 'order endpoint exists and is registered before the categories CRUD routes',
    orderIdx > -1 && orderIdx < serverSrcO.indexOf("crudRoutes('categories'"));
  check('cat-order', 'create hook appends at the end when sort_order is absent',
    serverSrcO.includes('beforeCreate(db, b)') && serverSrcO.includes('b.sort_order = (Number.isFinite(max) ? max : 0) + 10'));
  check('cat-order', 'backfill renumbers only when sort_order values collide',
    dbSrcO.includes('COUNT(DISTINCT sort_order)'));
  check('cat-order', 'admin Categories table carries drag handle + up/down controls saving via the endpoint',
    adminSrcO.includes('data-drag=') && adminSrcO.includes('data-move-up=') && adminSrcO.includes('data-move-down=') && adminSrcO.includes("api('/api/admin/categories/order'"));
  check('cat-order', 'homepage carries the staff-only drag handle wired to the same endpoint',
    appSrcO.includes('data-drag-cat=') && appSrcO.includes('function wireHomeCatDrag') && appSrcO.includes("api('/api/admin/categories/order'"));
}

/* ---- v1.2.4: homepage "Your Services" section removed; Recommended
   personalized. A viewer with attached services gets their services'
   articles first (unread, then in-progress; finished excluded),
   filled from the featured list; a viewer without services gets the
   featured list exactly as before; reading state comes from
   reading_progress keyed by the caller's own anon_key. ---- */
{
  const recoDir = makeCopy('reco');
  await boot(recoDir, 4128);
  const RP = 4128;
  const rSetup = await req(RP, 'POST', '/api/setup', { body: { email: 'reco@x.com', password: 'recopass123', display_name: 'Reco' } });
  const RA = rSetup.json && rSetup.json.token;
  check('recommended', 'first-run setup works', rSetup.status === 200 && !!RA);

  const rSvcA = (await req(RP, 'POST', '/api/admin/services', { token: RA, body: { name: 'RecSvcA' } })).json.id;
  const rSvcB = (await req(RP, 'POST', '/api/admin/services', { token: RA, body: { name: 'RecSvcB' } })).json.id;
  const rGrp = (await req(RP, 'POST', '/api/admin/groups', { token: RA, body: { name: 'RecGroup' } })).json.id;
  const mkR = async (title, extra) => (await req(RP, 'POST', '/api/admin/articles', { token: RA, body: { title, content_html: `<p>${title} body</p>`, status: 'published', visibility: 'all', ...extra } })).json;
  const artProg = await mkR('Rec In Progress', { service_id: rSvcA });
  const artOld = await mkR('Rec Unread Older', { service_id: rSvcA });
  const artNew = await mkR('Rec Unread Newer', { service_id: rSvcA });
  const artFin = await mkR('Rec Finished', { service_id: rSvcA, featured: 1 });
  const artB = await mkR('Rec Other Service', { service_id: rSvcB });
  const artGrp = await mkR('Rec Group Locked', { service_id: rSvcA, visibility: 'groups', group_ids: [rGrp] });
  const artFeat = await mkR('Rec Featured Fallback', { featured: 1 });
  check('recommended', 'fixtures created (2 services, group, 7 articles)',
    [rSvcA, rSvcB, rGrp].every(Boolean) && [artProg, artOld, artNew, artFin, artB, artGrp, artFeat].every(a => a && a.id));

  const mkCust = async (name, email, service_ids) => {
    await req(RP, 'POST', '/api/admin/customers', { token: RA, body: { name, email, password: 'recpass1234', service_ids } });
    const login = await req(RP, 'POST', '/api/customer/login', { body: { email, password: 'recpass1234' } });
    return login.json && login.json.token;
  };
  const RT = await mkCust('Rec User', 'recuser@x.com', [rSvcA]);
  const OT = await mkCust('Other User', 'otheruser@x.com', [rSvcA, rSvcB]);
  const PT = await mkCust('Plain User', 'plainuser@x.com', []);
  check('recommended', 'fixture customers signed in', !!RT && !!OT && !!PT);

  /* Rec User's own reading state, under their own browser key:
     one article in progress, one finished. */
  await req(RP, 'POST', '/api/progress', { token: RT, body: { article_id: artProg.id, progress: 0.5, anon_key: 'reco-a' } });
  await req(RP, 'POST', '/api/progress', { token: RT, body: { article_id: artFin.id, progress: 1, anon_key: 'reco-a' } });

  const slugs = list => (list || []).map(a => a.slug);
  const recoHome = await req(RP, 'GET', '/api/home?anon_key=reco-a', { token: RT });
  const rec = recoHome.json.recommended || [];
  check('recommended', 'home payload carries recommended and no services list',
    recoHome.status === 200 && Array.isArray(recoHome.json.recommended) && recoHome.json.services === undefined);
  check('recommended', 'unread attached-service articles lead, newest first',
    JSON.stringify(slugs(rec).slice(0, 2)) === JSON.stringify([artNew.slug, artOld.slug]), slugs(rec).join(', '));
  check('recommended', 'in-progress attached-service article follows the unread ones',
    rec.length > 2 && rec[2].slug === artProg.slug, slugs(rec).join(', '));
  check('recommended', 'anything past the personalized picks is featured-list fill',
    rec.slice(3).every(a => (recoHome.json.featured || []).some(f => f.id === a.id)), slugs(rec).join(', '));
  check('recommended', 'finished article excluded (and not re-added by the featured fill)',
    !slugs(rec).includes(artFin.slug), slugs(rec).join(', '));
  check('recommended', 'unattached-service article never recommended',
    !slugs(rec).includes(artB.slug));
  check('recommended', 'group-restricted article never recommended to a non-member',
    !slugs(rec).includes(artGrp.slug));
  check('recommended', 'list respects the home cap of 6', rec.length <= 6, String(rec.length));

  const otherHome = await req(RP, 'GET', '/api/home?anon_key=reco-b', { token: OT });
  const orec = otherHome.json.recommended || [];
  check('recommended', "second viewer: both services' unread articles lead in recency order",
    JSON.stringify(slugs(orec).slice(0, 5)) === JSON.stringify([artB.slug, artFin.slug, artNew.slug, artOld.slug, artProg.slug]), slugs(orec).join(', '));
  check('recommended', "isolation: the first viewer's finished state does not hide the article from the second viewer",
    slugs(orec).includes(artFin.slug));
  check('recommended', 'isolation: group-restricted article hidden from the second viewer too',
    !slugs(orec).includes(artGrp.slug));

  const noKeyHome = await req(RP, 'GET', '/api/home', { token: RT });
  check('recommended', 'without the browser key, no reading state applies (finished article reads as unread)',
    !!noKeyHome.json.recommended && !!noKeyHome.json.recommended[0] && noKeyHome.json.recommended[0].slug === artFin.slug,
    slugs(noKeyHome.json.recommended).join(', '));

  const plainHome = await req(RP, 'GET', '/api/home', { token: PT });
  check('recommended', 'viewer with NO attached services gets exactly the featured list (previous behavior)',
    JSON.stringify((plainHome.json.recommended || []).map(a => a.id)) === JSON.stringify((plainHome.json.featured || []).map(a => a.id)),
    slugs(plainHome.json.recommended).join(', ') + ' vs ' + slugs(plainHome.json.featured).join(', '));

  const anonHome = await req(RP, 'GET', '/api/home');
  check('recommended', 'signed-out home request still 401s (previous behavior)', anonHome.status === 401, 'status ' + anonHome.status);

  const recoSvc = await req(RP, 'GET', '/api/services', { token: RT });
  check('recommended', '/api/services catalog unchanged (both fixture services listed)',
    [rSvcA, rSvcB].every(id => (recoSvc.json || []).some(s => s.id === id)));

  /* Source guards: the section markup is gone, the home view renders
     the new list, and the server builds it from attached services +
     reading_progress. */
  const appSrcR = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  const serverSrcR = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  check('recommended', 'home view renders the recommended list and asks with the anon key',
    appSrcR.includes('(d.recommended || d.featured)') && appSrcR.includes("/api/home?anon_key="));
  check('recommended', 'server computes recommendations from attached services + reading_progress',
    serverSrcR.includes('function recommendedArticles') && serverSrcR.includes('reading_progress') && serverSrcR.includes('FROM article_services'));
}

/* ---- v1.2.5: Admin "Users" → grouped "Staff" page; per-category article
   ordering; responsive article images; staff session persistence (the
   sign-in page bounces a live staff session to /admin, staff logins get
   the 30-day session); multi-service articles via article_services;
   editor blockquote style chooser (insert = plain quote + chooser, never
   a hardcoded style) + heading anchors; /services boxes display-only;
   attach-service pickers as name-labeled boxes. ---- */
{
  const vDir = makeCopy('v125');
  const vChild = await boot(vDir, 4129);
  const V = 4129;
  const vSetup = await req(V, 'POST', '/api/setup', { body: { email: 'v125@x.com', password: 'v125pass123', display_name: 'V Admin' } });
  let VA = vSetup.json && vSetup.json.token;
  check('v125', 'first-run setup works', vSetup.status === 200 && !!VA);

  const adminSrc5 = fs.readFileSync(path.join(SRC, 'public', 'js', 'admin.js'), 'utf8');
  const appSrc5 = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  const wysiSrc5 = fs.readFileSync(path.join(SRC, 'public', 'js', 'wysiwyg.js'), 'utf8');
  const cssSrc5 = fs.readFileSync(path.join(SRC, 'public', 'css', 'styles.css'), 'utf8');
  const serverSrc5 = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');

  /* fixtures */
  const edUser = await req(V, 'POST', '/api/admin/users', { token: VA, body: { email: 'ed125@x.com', password: 'edpass12345', display_name: 'Ed Editor', role: 'editor' } });
  const S1 = (await req(V, 'POST', '/api/admin/services', { token: VA, body: { name: 'V125 Svc One' } })).json.id;
  const S2 = (await req(V, 'POST', '/api/admin/services', { token: VA, body: { name: 'V125 Svc Two' } })).json.id;
  const svcRows = (await req(V, 'GET', '/api/services', { token: VA })).json || [];
  const s1slug = (svcRows.find(s => s.id === S1) || {}).slug;
  const s2slug = (svcRows.find(s => s.id === S2) || {}).slug;
  const CAT = (await req(V, 'POST', '/api/admin/categories', { token: VA, body: { name: 'V125 Cat' } })).json.id;
  const catSlug = (((await req(V, 'GET', '/api/categories', { token: VA })).json || []).find(c => c.id === CAT) || {}).slug;
  const mkA = async (title, extra = {}) => (await req(V, 'POST', '/api/admin/articles', { token: VA, body: { title, content_html: `<p>${title} body</p>`, status: 'published', visibility: 'all', category_id: CAT, ...extra } })).json;
  const A1 = await mkA('Order One'); const A2 = await mkA('Order Two'); const A3 = await mkA('Order Three');
  const catTitles = async () => (((await req(V, 'GET', '/api/categories/' + catSlug, { token: VA })).json || {}).articles || []).map(a => a.title);
  check('v125', 'fixtures created (editor, 2 services, category, 3 articles)',
    !!(edUser.json && edUser.json.id && S1 && S2 && CAT && A1.id && A2.id && A3.id));

  /* 1 — Staff page grouping */
  check('staff-page', 'nav label + page heading read "Staff" (route key unchanged)',
    adminSrc5.includes("['users', '👥 Staff']") && adminSrc5.includes('>Staff</h2>'));
  check('staff-page', 'rows grouped Admins first then Staff, each with a count; editor renamed too',
    adminSrc5.includes("sectionHtml('Admins'") && adminSrc5.includes("sectionHtml('Staff'") && adminSrc5.includes('art-group-count') && adminSrc5.includes('Edit staff member'));
  const usersPay = await req(V, 'GET', '/api/admin/users', { token: VA });
  check('staff-page', 'users payload still carries every role for the grouping',
    usersPay.status === 200 && usersPay.json.some(u => u.role === 'admin') && usersPay.json.some(u => u.role === 'editor'));
  const tmpU = await req(V, 'POST', '/api/admin/users', { token: VA, body: { email: 'tmp125@x.com', password: 'tmppass12345', display_name: 'Tmp', role: 'viewer' } });
  const roleCh = await req(V, 'PUT', '/api/admin/users/' + tmpU.json.id, { token: VA, body: { role: 'editor' } });
  const usersAfter = await req(V, 'GET', '/api/admin/users', { token: VA });
  const adminSelf = usersAfter.json.find(u => u.email === 'v125@x.com');
  const delSelf = await req(V, 'DELETE', '/api/admin/users/' + adminSelf.id, { token: VA });
  const delTmp = await req(V, 'DELETE', '/api/admin/users/' + tmpU.json.id, { token: VA });
  check('staff-page', 'row actions intact: create + role change apply, self-delete guard holds, delete works',
    tmpU.status === 200 && roleCh.status === 200
    && (usersAfter.json.find(u => u.id === tmpU.json.id) || {}).role === 'editor'
    && delSelf.status === 400 && delTmp.status === 200);

  /* 2 — article ordering within categories */
  const startOrder = await catTitles();
  check('article-order', 'category page starts in creation order',
    JSON.stringify(startOrder) === JSON.stringify(['Order One', 'Order Two', 'Order Three']), startOrder.join(', '));
  const putOrder = (category_id, ids, token = VA) => req(V, 'PUT', '/api/admin/articles/order', { token, body: { category_id, ids } });
  const ro1 = await putOrder(CAT, [A3.id, A1.id, A2.id]);
  check('article-order', 'order endpoint saves and the category page follows it',
    ro1.status === 200 && JSON.stringify(await catTitles()) === JSON.stringify(['Order Three', 'Order One', 'Order Two']));
  const outsider = await mkA('Order Outsider', { category_id: null });
  const ordCust = await req(V, 'POST', '/api/admin/customers', { token: VA, body: { name: 'Ord Cust', email: 'ordc@x.com', password: 'ordcpass123' } });
  const CT = (await req(V, 'POST', '/api/customer/login', { body: { email: 'ordc@x.com', password: 'ordcpass123' } })).json.token;
  const badForeign = await putOrder(CAT, [outsider.id]);
  const badDupes = await putOrder(CAT, [A1.id, A1.id]);
  const badEmpty = await putOrder(CAT, []);
  const badCat = await putOrder(999999, [A1.id]);
  const custTry = await putOrder(CAT, [A1.id], CT);
  check('article-order', 'validation: foreign id, duplicates, empty list, unknown category rejected; customers cannot reorder',
    badForeign.status === 400 && badDupes.status === 400 && badEmpty.status === 400 && badCat.status === 400 && custTry.status === 401,
    [badForeign.status, badDupes.status, badEmpty.status, badCat.status, custTry.status].join('/'));
  check('article-order', 'rejected payloads leave the saved order untouched',
    JSON.stringify(await catTitles()) === JSON.stringify(['Order Three', 'Order One', 'Order Two']));
  const A4 = await mkA('Order Four');
  check('article-order', 'a new article appends at the end of its category',
    (await catTitles()).at(-1) === 'Order Four');
  const CAT2 = (await req(V, 'POST', '/api/admin/categories', { token: VA, body: { name: 'V125 Cat Two' } })).json.id;
  const cat2Slug = (((await req(V, 'GET', '/api/categories', { token: VA })).json || []).find(c => c.id === CAT2) || {}).slug;
  const B1 = await mkA('Second Cat First', { category_id: CAT2 });
  await req(V, 'PUT', '/api/admin/articles/' + A1.id, { token: VA, body: { category_id: CAT2 } });
  const cat2Titles = (((await req(V, 'GET', '/api/categories/' + cat2Slug, { token: VA })).json || {}).articles || []).map(a => a.title);
  check('article-order', 'an article moved to another category appends at the end there',
    JSON.stringify(cat2Titles) === JSON.stringify(['Second Cat First', 'Order One']), cat2Titles.join(', '));
  const ordIdx = serverSrc5.indexOf("app.put('/api/admin/articles/order', requireAuth");
  check('article-order', 'order endpoint exists, registered before the article :id update route',
    ordIdx > -1 && ordIdx < serverSrc5.indexOf("app.put('/api/admin/articles/:id'"));
  check('article-order', 'admin Articles groups carry drag + up/down controls saving via the endpoint',
    adminSrc5.includes('data-adrag') && adminSrc5.includes('data-aup') && adminSrc5.includes('data-adown')
    && adminSrc5.includes("api('/api/admin/articles/order'") && adminSrc5.includes('Order saved'));

  /* 4 — session persistence (behavior first, then the source guards) */
  const sLogin = await req(V, 'POST', '/api/auth/login', { body: { email: 'v125@x.com', password: 'v125pass123' } });
  const LT = sLogin.json && sLogin.json.token;
  const pubMe = await req(V, 'GET', '/api/me', { token: LT });
  const pubHome = await req(V, 'GET', '/api/home?anon_key=sesskey', { token: LT });
  const pubProg = await req(V, 'GET', '/api/progress?anon_key=sesskey', { token: LT });
  const admStats = await req(V, 'GET', '/api/admin/stats', { token: LT });
  check('session', 'staff token survives the public app boot calls and still authorizes admin',
    sLogin.status === 200 && pubMe.status === 200 && pubHome.status === 200 && pubProg.status === 200 && admStats.status === 200,
    [pubMe.status, pubHome.status, pubProg.status, admStats.status].join('/'));
  const lo = await req(V, 'POST', '/api/auth/logout', { token: LT });
  const afterLo = await req(V, 'GET', '/api/me', { token: LT });
  const admAfter = await req(V, 'GET', '/api/admin/stats', { token: LT });
  check('session', 'explicit logout still signs out everywhere',
    lo.status === 200 && afterLo.status === 401 && admAfter.status === 401);
  check('session', 'root-cause guards: sign-in page bounces a live staff session to /admin; staff logins issue the long session',
    appSrc5.includes("App.user.kind === 'staff'") && appSrc5.includes("navigate('/admin', { replace: true })") && serverSrc5.includes('expiryFor(true)'));

  /* 5 — multi-service articles */
  const svcArts = async (slug) => (((await req(V, 'GET', '/api/services/' + slug, { token: VA })).json || {}).articles || []).map(a => a.id);
  const M1 = (await req(V, 'POST', '/api/admin/articles', { token: VA, body: { title: 'Multi One', content_html: '<p>multi</p>', status: 'published', visibility: 'all', category_id: CAT, service_ids: [S1, S2] } })).json;
  check('multi-service', 'article created with two services is listed under both',
    !!(M1 && M1.id) && (await svcArts(s1slug)).includes(M1.id) && (await svcArts(s2slug)).includes(M1.id));
  const m1Detail = await req(V, 'GET', '/api/articles/' + M1.slug, { token: VA });
  check('multi-service', 'article payload carries ALL its services (one chip each)',
    (m1Detail.json.services || []).length === 2 && m1Detail.json.services.every(s => [S1, S2].includes(s.id)));
  const m1Admin = await req(V, 'GET', '/api/admin/articles/' + M1.id, { token: VA });
  check('multi-service', 'admin article payload exposes service_ids from the join',
    JSON.stringify([...(m1Admin.json.service_ids || [])].sort((x, y) => x - y)) === JSON.stringify([S1, S2].sort((x, y) => x - y)),
    JSON.stringify(m1Admin.json.service_ids));
  const cust2 = await req(V, 'POST', '/api/admin/customers', { token: VA, body: { name: 'S2 Only', email: 's2only@x.com', password: 's2onlypass1', service_ids: [S2] } });
  const CT2 = (await req(V, 'POST', '/api/customer/login', { body: { email: 's2only@x.com', password: 's2onlypass1' } })).json.token;
  const home2 = await req(V, 'GET', '/api/home?anon_key=s2k', { token: CT2 });
  check('multi-service', 'recommended matches via the SECOND service alone (any-match)',
    (home2.json.recommended || []).some(a => a.id === M1.id));
  const cust2Row = (((await req(V, 'GET', '/api/admin/customers', { token: VA })).json || []).find(c => c.id === cust2.json.id) || {});
  check('svc-pick', 'attaching services persists on the customer (name-box picker round trip)',
    cust2.status === 200 && (cust2Row.services || []).some(s => s.id === S2));
  const M2 = (await req(V, 'POST', '/api/admin/articles', { token: VA, body: { title: 'Multi Legacy', content_html: '<p>legacy</p>', status: 'published', visibility: 'all', service_id: S1 } })).json;
  const m2Admin = await req(V, 'GET', '/api/admin/articles/' + M2.id, { token: VA });
  check('multi-service', 'legacy single service_id create lands in the join (migration-safe)',
    JSON.stringify(m2Admin.json.service_ids || []) === JSON.stringify([S1]), JSON.stringify(m2Admin.json.service_ids));
  await req(V, 'PUT', '/api/admin/articles/' + M1.id, { token: VA, body: { service_ids: [S2] } });
  check('multi-service', 'removing a service in the editor drops only that listing',
    !(await svcArts(s1slug)).includes(M1.id) && (await svcArts(s2slug)).includes(M1.id));
  await req(V, 'DELETE', '/api/admin/services/' + S2, { token: VA });
  const m1After = await req(V, 'GET', '/api/articles/' + M1.slug, { token: VA });
  check('multi-service', 'deleting a service removes its join rows only — the article survives',
    m1After.status === 200 && (m1After.json.services || []).length === 0);

  /* 6 + refinements — editor chooser, anchors (behavior via preview + save) */
  const pv = await req(V, 'POST', '/api/admin/preview', { token: VA, body: { html: '<blockquote class="bq-warning"><p>Careful now</p></blockquote><h2 id="my-anchor">Head One</h2><h2>Same Head</h2><h2>Same Head</h2><p id="para-anchor">Anchored paragraph</p><p><a href="#my-anchor">jump</a></p>' } });
  const pvh = (pv.json && pv.json.html) || '';
  check('editor', 'sanitizer + preview keep blockquote style classes intact',
    pv.status === 200 && pvh.includes('class="bq-warning"'));
  check('anchors', 'preview keeps custom heading + paragraph ids, auto-slugs the rest, dedupes repeats, keeps #anchor links',
    pvh.includes('id="my-anchor"') && pvh.includes('id="para-anchor"') && pvh.includes('id="same-head"') && pvh.includes('id="same-head-2"') && pvh.includes('href="#my-anchor"'), pvh.slice(0, 200));
  const bqArt = (await req(V, 'POST', '/api/admin/articles', { token: VA, body: { title: 'BQ Saved', content_html: '<blockquote class="bq-danger"><p>Stop</p></blockquote><h2>Section Alpha</h2><h2>Section Alpha</h2>', status: 'published', visibility: 'all' } })).json;
  const bqGet = await req(V, 'GET', '/api/articles/' + bqArt.slug, { token: VA });
  check('editor', 'a styled blockquote survives save and renders on the public article',
    (bqGet.json.content_html || '').includes('class="bq-danger"'));
  check('anchors', 'rendered article headings carry stable ids; duplicates are distinct',
    (bqGet.json.content_html || '').includes('id="section-alpha"') && (bqGet.json.content_html || '').includes('id="section-alpha-2"'));
  check('editor', 'chooser offers all five styles; insert opens the chooser and never hardcodes a style',
    ['bq-default', 'bq-info', 'bq-success', 'bq-warning', 'bq-danger'].every(c => wysiSrc5.includes(`data-bq="${c}"`))
    && wysiSrc5.includes('data-act="quote"') && !wysiSrc5.includes('data-block="blockquote"')
    && wysiSrc5.includes('showBqBar(caretBlockquote())') && wysiSrc5.includes('bqTarget.classList.add(cls)') && !wysiSrc5.includes("classList.add('bq-"));
  check('editor', 'toolbar audit: justify + anchor added, everyday basics all present, nothing removed',
    wysiSrc5.includes('justifyFull') && wysiSrc5.includes('data-act="anchor"') && wysiSrc5.includes('justifyLeft')
    && wysiSrc5.includes('removeFormat') && wysiSrc5.includes('insertHorizontalRule') && wysiSrc5.includes('strikeThrough') && wysiSrc5.includes('data-cmd="underline"'));
  check('anchors', 'article page scrolls to the URL hash on load; headings offset for the sticky header',
    appSrc5.includes('location.hash') && appSrc5.includes('decodeURIComponent(location.hash.slice(1))') && cssSrc5.includes('scroll-margin-top: 130px'));

  /* 3 — responsive image CSS guards */
  check('img-css', 'article images scale with aspect preserved, overriding stored pixel sizes (reader + editor)',
    cssSrc5.includes('.md img, .wysi-preview img, .wysi-edit img { max-width: 100%; height: auto !important;')
    && cssSrc5.includes('.md figure, .wysi-preview figure { margin: 1em 0; text-align: center; max-width: 100%; }'));
  check('img-css', 'floated/aligned images stack full-width at the mobile breakpoint',
    cssSrc5.includes('.md img[style*="float"]') && cssSrc5.includes('float: none !important'));

  /* header logo: no tile at all; one oversized unclipped elliptical glow
     whose falloff reaches true zero at 62% of its extent (fade5 spec, tightened in v1.2.5.1 to hug the mark) */
  const brandBlock = (cssSrc5.match(/\.brand-mark \{[^}]*\}/) || [''])[0];
  check('logo-glow', 'logo wrapper carries no tile (no gradient/box-shadow); the green glow is an unclipped radial ellipse hugging the mark, fading to transparent at 62%',
    !cssSrc5.includes('linear-gradient(135deg, #2E7CF6, #7C5CFF)')
    && !brandBlock.includes('linear-gradient') && !brandBlock.includes('box-shadow')
    && cssSrc5.includes('.brand-mark::before')
    && cssSrc5.includes('radial-gradient(ellipse at center') && cssSrc5.includes('transparent 62%)'));

  /* refinement — /services boxes display-only */
  const taxStart = appSrc5.indexOf('viewTaxonomyList');
  const taxSlice = appSrc5.slice(taxStart, taxStart + 3200);
  check('svc-display', '/services renders service boxes display-only (no per-service links)',
    taxSlice.includes('<div class="cat-card svc-box"') && !taxSlice.includes('/service/${') && !taxSlice.includes('href="/service'));
  check('svc-display', 'admin taxonomy keeps its service edit controls',
    adminSrc5.includes("this.taxManager(main, 'services')") && adminSrc5.includes('data-edit='));

  /* refinement — attach pickers are name-labeled boxes */
  check('svc-pick', 'customer, staff, invite and article-editor pickers render name-labeled selectable boxes',
    (adminSrc5.match(/class="svc-pick"/g) || []).length >= 4
    && adminSrc5.includes('class="cf-svc"') && adminSrc5.includes('class="u-svc"') && adminSrc5.includes('class="iv-svc"') && adminSrc5.includes('class="ed-svc"')
    && cssSrc5.includes('.svc-pick:has(input:checked)'));

  /* article order persistence across a restart */
  try { vChild.kill('SIGKILL'); } catch {}
  await sleep(500);
  await boot(vDir, 4129);
  const reLogin = await req(V, 'POST', '/api/auth/login', { body: { email: 'v125@x.com', password: 'v125pass123' } });
  VA = reLogin.json && reLogin.json.token;
  check('article-order', 'the saved category order persists across a restart',
    !!VA && JSON.stringify(await catTitles()) === JSON.stringify(['Order Three', 'Order Two', 'Order Four', 'Multi One']),
    (await catTitles()).join(', '));
}

/* v1.2.5 backfill: a pre-upgrade database (every sort_order colliding)
   keeps its visible order — pinned first, then updated_at DESC. */
{
  const bfDir = makeCopy('v125bf');
  const bfChild = await boot(bfDir, 4130);
  const BF = 4130;
  const bfSetup = await req(BF, 'POST', '/api/setup', { body: { email: 'bf@x.com', password: 'bfpass12345', display_name: 'BF' } });
  const BA = bfSetup.json && bfSetup.json.token;
  const BC = (await req(BF, 'POST', '/api/admin/categories', { token: BA, body: { name: 'BF Cat' } })).json.id;
  const bcSlug = (((await req(BF, 'GET', '/api/categories', { token: BA })).json || []).find(c => c.id === BC) || {}).slug;
  const mkB = async (t) => (await req(BF, 'POST', '/api/admin/articles', { token: BA, body: { title: t, content_html: '<p>x</p>', status: 'published', visibility: 'all', category_id: BC } })).json;
  const b1 = await mkB('BF First'); const b2 = await mkB('BF Second'); const b3 = await mkB('BF Third');
  try { bfChild.kill('SIGKILL'); } catch {}
  await sleep(500);
  execFileSync('node', ['-e', `
    const Database = require(${JSON.stringify(path.join(SRC, 'node_modules', 'better-sqlite3'))});
    const db = new Database(${JSON.stringify(path.join(bfDir, 'data', 'xcwiki.db'))});
    db.prepare('UPDATE articles SET sort_order = 0').run();
    db.prepare("UPDATE articles SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(${b1.id});
    db.prepare("UPDATE articles SET updated_at = '2026-03-01T00:00:00.000Z' WHERE id = ?").run(${b2.id});
    db.prepare("UPDATE articles SET updated_at = '2026-02-01T00:00:00.000Z' WHERE id = ?").run(${b3.id});
    db.close();
  `]);
  await boot(bfDir, 4130);
  const bfLogin = await req(BF, 'POST', '/api/auth/login', { body: { email: 'bf@x.com', password: 'bfpass12345' } });
  const bfTitles = (((await req(BF, 'GET', '/api/categories/' + bcSlug, { token: bfLogin.json && bfLogin.json.token })).json || {}).articles || []).map(a => a.title);
  check('article-order', 'backfill preserves the pre-upgrade visible order (pinned, then updated_at DESC)',
    JSON.stringify(bfTitles) === JSON.stringify(['BF Second', 'BF Third', 'BF First']), bfTitles.join(', '));
}

/* ---- production-shaped data dir boot check ---- */
const prodDb = path.join(SRC, 'data');
if (fs.existsSync(path.join(prodDb, 'xcwiki.db'))) {
  const prodDir = makeCopy('prod', { withData: prodDb });
  await boot(prodDir, 4123);
  const sn = await req(4123, 'GET', '/api/setup-needed');
  const sp = await req(4123, 'GET', '/api/settings/public');
  check('prod-boot', 'app boots on a COPY of the production-shaped DB', sn.status === 200 && sp.status === 200);
  check('prod-boot', 'public settings still serve hex colors from prod data', /^#[0-9a-f]{6}$/.test(sp.json.primary_color || ''), sp.json.primary_color);
} else {
  check('prod-boot', 'no production-shaped data dir present — skipped', true, 'data/xcwiki.db not found');
}

/* ---- v1.2.7: Your Services page ---- */
{
  const dir = makeCopy('myservices');
  await boot(dir, 4131);
  const MP = 4131;
  const msetup = await req(MP, 'POST', '/api/setup', { body: { email: 'admin@x.com', password: 'adminpass123', display_name: 'Admin' } });
  const MA = msetup.json.token;
  check('v127-my-services', 'setup for Your Services checks', msetup.status === 200 && !!MA);
  const mg = await req(MP, 'POST', '/api/admin/groups', { token: MA, body: { name: 'StreamGroup' } });
  const MG = mg.json.id;
  const msDirect = await req(MP, 'POST', '/api/admin/services', { token: MA, body: { name: 'DirectSvc' } });
  const msGrouped = await req(MP, 'POST', '/api/admin/services', { token: MA, body: { name: 'GroupedSvc', group_id: MG } });
  const msOther = await req(MP, 'POST', '/api/admin/services', { token: MA, body: { name: 'OtherSvc' } });
  const mcust = await req(MP, 'POST', '/api/admin/customers', { token: MA, body: { name: 'Molly', email: 'molly@x.com', password: 'mollypass123', service_ids: [msDirect.json.id], group_ids: [MG] } });
  check('v127-my-services', 'customer created with a direct service + a group', mcust.status === 200 && !!mcust.json.id);
  const mLogin = await req(MP, 'POST', '/api/customer/login', { body: { email: 'molly@x.com', password: 'mollypass123' } });
  const MT = mLogin.json.token;
  const mine = await req(MP, 'GET', '/api/my-services', { token: MT });
  const names = (mine.json || []).map(s => s.name);
  check('v127-my-services', 'customer sees the directly attached service', names.includes('DirectSvc'), names.join(','));
  check('v127-my-services', 'customer sees the service mapped to their group', names.includes('GroupedSvc'), names.join(','));
  check('v127-my-services', 'customer does NOT see an unrelated service', !names.includes('OtherSvc'), names.join(','));
  check('v127-my-services', 'rows carry display fields (icon/color/description)', (mine.json || []).length > 0 && (mine.json || []).every(s => 'icon' in s && 'color' in s && 'description' in s));
  const anon = await req(MP, 'GET', '/api/my-services');
  check('v127-my-services', 'signed-out request is 401', anon.status === 401);
  const catalog = await req(MP, 'GET', '/api/services', { token: MT });
  const catalogNames = (catalog.json || []).map(s => s.name);
  check('v127-my-services', 'All Services catalog still returns everything (incl. unrelated)', ['DirectSvc', 'GroupedSvc', 'OtherSvc'].every(n => catalogNames.includes(n)), catalogNames.join(','));
  const meAdmin = await req(MP, 'GET', '/api/me', { token: MA });
  await req(MP, 'PUT', `/api/admin/users/${meAdmin.json.user.id}`, { token: MA, body: { service_ids: [msOther.json.id] } });
  const staffMine = await req(MP, 'GET', '/api/my-services', { token: MA });
  const staffNames = (staffMine.json || []).map(s => s.name);
  check('v127-my-services', 'staff sees only their user_services attachments', staffNames.length === 1 && staffNames[0] === 'OtherSvc', staffNames.join(','));
  const idxHtml = fs.readFileSync(path.join(SRC, 'public', 'index.html'), 'utf8');
  check('v127-my-services', 'nav Your Services points at /my-services', idxHtml.includes('href="/my-services" data-nav="services"'));
  const appSrcM = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  check('v127-my-services', 'app.js routes /my-services to the personal view', appSrcM.includes("parts[0] === 'my-services'") && appSrcM.includes('viewMyServices'));
}

/* ---- v1.2.6 static guards: article image lightbox ---- */
{
  const appSrcL = fs.readFileSync(path.join(SRC, 'public', 'js', 'app.js'), 'utf8');
  const cssSrcL = fs.readFileSync(path.join(SRC, 'public', 'css', 'styles.css'), 'utf8');
  check('v126-lightbox', 'app.js builds the lightbox overlay with a close button', appSrcL.includes("lightbox.className = 'lightbox'") && appSrcL.includes('lightbox-close'));
  check('v126-lightbox', 'article + attachment images are lightboxed via delegation', appSrcL.includes("closest('#md-body img, .attach-item img')"));
  check('v126-lightbox', 'lightbox handler stops SPA nav fallthrough', appSrcL.includes('stopImmediatePropagation'));
  check('v126-lightbox', 'Esc closes the lightbox', appSrcL.includes("e.key === 'Escape'"));
  check('v126-lightbox', 'lightbox CSS exists: overlay opens as flex, close button pinned top-right of the stage', cssSrcL.includes('.lightbox.open { display: flex; }') && cssSrcL.includes('.lightbox-close { position: absolute; top: 8px; right: 8px;'));
  check('v126-lightbox', 'article images advertise zoom affordance', cssSrcL.includes('#md-body img, .attach-item img { cursor: zoom-in; }'));
}

/* ---- summary ---- */
for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
stub.close();
const failed = results.filter(r => !r.pass);
console.log(`\n==== SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed ====`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: [${f.area}] ${f.name}`);
  process.exit(1);
}
})().catch(e => { console.error('SMOKE CRASHED:', e); for (const c of children) { try { c.kill('SIGKILL'); } catch {} } process.exit(2); });
