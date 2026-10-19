'use strict';
/* Cloud Backup & Restore for XC Wiki: Google Drive + OneDrive via OAuth 2.0.
   All provider API calls use plain fetch (no SDKs). Credentials and
   tokens are AES-256-GCM encrypted via lib/crypto.js and never leave
   the server unmasked. Adapted from the shared cloud-backup pattern. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');
const Database = require('better-sqlite3');
const { encryptJSON, decryptJSON } = require('./crypto');
const { DB_PATH } = require('./db');

const DB_FILENAME = 'xcwiki.db';
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const SAFETY_DIR = path.join(__dirname, '..', 'data', 'safety-backups');
const FOLDER_NAME = 'XC Wiki Backups';
const APP_NAME = 'XC Wiki';
const PROVIDERS = ['google', 'onedrive'];

/* ---------- small helpers ---------- */

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function hhmm(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function getState(db, key) {
  try { return db.prepare('SELECT value FROM scheduler_state WHERE key = ?').get(key)?.value ?? ''; }
  catch { return ''; }
}
function setState(db, key, value) {
  db.prepare(`INSERT INTO scheduler_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}
function fmtBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
async function streamToFile(webStream, destPath) {
  const out = fs.createWriteStream(destPath);
  const nodeStream = Readable.fromWeb(webStream);
  await new Promise((resolve, reject) => {
    nodeStream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    nodeStream.pipe(out);
  });
}
async function apiError(res, label) {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try { detail = JSON.stringify(JSON.parse(text)).slice(0, 300); } catch {}
  throw new Error(`${label} failed (HTTP ${res.status}): ${detail || res.statusText}`);
}

/* fetch with a hard timeout so a hung provider endpoint can't stall the app. */
async function timedFetch(url, opts = {}, ms = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(ms / 1000)}s: ${String(url).slice(0, 80)}`);
    throw e;
  } finally { clearTimeout(t); }
}

/* ---------- connection storage ---------- */

function getConnection(db, provider) {
  return db.prepare('SELECT * FROM cloud_connections WHERE provider = ?').get(provider) || null;
}

function connectedProviders(db) {
  return db.prepare(`SELECT provider FROM cloud_connections WHERE status = 'connected'`)
    .all().map(r => r.provider).filter(p => PROVIDERS.includes(p));
}

/** Masked, UI-safe view of a connection. Secrets/tokens never included. */
function publicConnection(db, provider) {
  const row = getConnection(db, provider);
  let hasSecret = false, hasTokens = false;
  if (row && row.credentials_encrypted) {
    try {
      const blob = decryptJSON(row.credentials_encrypted);
      hasSecret = !!blob.client_secret;
      hasTokens = !!(blob.access_token && blob.refresh_token);
    } catch { /* undecryptable */ }
  }
  return {
    provider,
    configured: !!row,
    connected: row?.status === 'connected' && hasTokens,
    client_id: row?.client_id || '',
    has_client_secret: hasSecret,
    folder_name: row?.folder_name || FOLDER_NAME,
    status: row?.status || 'disconnected',
    connected_at: row?.connected_at || '',
    last_error: row?.last_error || '',
  };
}

function saveClientCreds(db, provider, clientId, clientSecret) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider');
  clientId = String(clientId || '').trim();
  clientSecret = String(clientSecret || '').trim();
  if (!clientId) throw new Error('Client ID is required');
  if (!clientSecret) throw new Error('Client secret is required');
  const row = getConnection(db, provider);
  let blob = {};
  if (row?.credentials_encrypted) { try { blob = decryptJSON(row.credentials_encrypted); } catch {} }
  blob.client_secret = clientSecret;
  db.prepare(`INSERT INTO cloud_connections (provider, client_id, credentials_encrypted, folder_name, status)
    VALUES (?, ?, ?, ?, 'disconnected')
    ON CONFLICT(provider) DO UPDATE SET client_id = excluded.client_id,
      credentials_encrypted = excluded.credentials_encrypted`).run(
    provider, clientId, encryptJSON(blob), FOLDER_NAME);
  return publicConnection(db, provider);
}

function disconnect(db, provider) {
  db.prepare('DELETE FROM cloud_connections WHERE provider = ?').run(provider);
}

function storeTokens(db, provider, tokens) {
  const row = getConnection(db, provider);
  if (!row) throw new Error('Save the Client ID and secret first');
  let blob = {};
  if (row.credentials_encrypted) { try { blob = decryptJSON(row.credentials_encrypted); } catch {} }
  blob.access_token = tokens.access_token;
  if (tokens.refresh_token) blob.refresh_token = tokens.refresh_token;
  blob.expires_at = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
  db.prepare(`UPDATE cloud_connections SET credentials_encrypted = ?, status = 'connected',
    connected_at = ?, last_error = '', folder_name = ? WHERE provider = ?`)
    .run(encryptJSON(blob), new Date().toISOString(), FOLDER_NAME, provider);
}

function markError(db, provider, message) {
  try {
    db.prepare('UPDATE cloud_connections SET last_error = ?, status = ? WHERE provider = ?')
      .run(String(message || '').slice(0, 500), 'error', provider);
  } catch {}
}

/* ---------- OAuth ---------- */

// in-memory CSRF states: state -> { provider, createdAt }
const oauthStates = new Map();
function newOAuthState(provider) {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider, createdAt: Date.now() });
  for (const [k, v] of oauthStates) if (Date.now() - v.createdAt > 10 * 60 * 1000) oauthStates.delete(k);
  return state;
}
function consumeOAuthState(state, provider) {
  const v = oauthStates.get(state);
  oauthStates.delete(state);
  return !!(v && v.provider === provider && Date.now() - v.createdAt < 10 * 60 * 1000);
}

function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim() || 'http';
  return `${proto}://${req.get('host')}`;
}
function redirectUriFor(req, provider) {
  return `${baseUrl(req)}/api/admin/cloud/callback/${provider}`;
}

function authUrl(db, req, provider) {
  const row = getConnection(db, provider);
  if (!row?.client_id) throw new Error('Save the Client ID and secret first');
  const state = newOAuthState(provider);
  const redirectUri = redirectUriFor(req, provider);
  if (provider === 'google') {
    const p = new URLSearchParams({
      client_id: row.client_id, redirect_uri: redirectUri, response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive.file',
      access_type: 'offline', prompt: 'consent', state,
    });
    return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString(), redirectUri };
  }
  const p = new URLSearchParams({
    client_id: row.client_id, redirect_uri: redirectUri, response_type: 'code',
    scope: 'Files.ReadWrite offline_access', response_mode: 'query', state,
  });
  return { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + p.toString(), redirectUri };
}

async function exchangeCode(db, provider, code, redirectUri) {
  const row = getConnection(db, provider);
  if (!row) throw new Error('Provider not configured');
  let blob = {};
  try { blob = decryptJSON(row.credentials_encrypted); } catch {}
  if (!blob.client_secret) throw new Error('Client secret missing — re-enter it');
  const params = new URLSearchParams({
    code, client_id: row.client_id, client_secret: blob.client_secret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  const url = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const res = await timedFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
  });
  if (!res.ok) await apiError(res, 'Token exchange');
  const data = await res.json();
  if (!data.access_token) throw new Error('Token exchange returned no access token');
  return data;
}

async function refreshAccessToken(db, provider) {
  const row = getConnection(db, provider);
  if (!row) throw new Error('Provider not configured');
  let blob = {};
  try { blob = decryptJSON(row.credentials_encrypted); } catch {}
  if (!blob.refresh_token) throw new Error('No refresh token stored — please reconnect');
  const params = new URLSearchParams({
    refresh_token: blob.refresh_token, client_id: row.client_id,
    client_secret: blob.client_secret || '', grant_type: 'refresh_token',
  });
  const url = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const res = await timedFetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params,
  });
  if (!res.ok) await apiError(res, 'Token refresh');
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh returned no access token');
  blob.access_token = data.access_token;
  if (data.refresh_token) blob.refresh_token = data.refresh_token;
  blob.expires_at = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  db.prepare('UPDATE cloud_connections SET credentials_encrypted = ?, last_error = ? WHERE provider = ?')
    .run(encryptJSON(blob), '', provider);
  return blob.access_token;
}

/** Valid access token, refreshing automatically when expired. */
async function getAccessToken(db, provider) {
  const row = getConnection(db, provider);
  if (!row || row.status !== 'connected') throw new Error(`${provider} is not connected`);
  let blob = {};
  try { blob = decryptJSON(row.credentials_encrypted); } catch { throw new Error('Stored credentials are undecryptable — reconnect'); }
  if (blob.access_token && blob.expires_at && Date.now() < blob.expires_at - 60000) {
    return blob.access_token;
  }
  return refreshAccessToken(db, provider);
}

/* ---------- Google Drive API ---------- */

const gAuth = (t) => ({ Authorization: 'Bearer ' + t });

async function gEnsureFolder(token) {
  const q = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  let res = await timedFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`, { headers: gAuth(token) });
  if (!res.ok) await apiError(res, 'Drive folder search');
  const found = (await res.json()).files || [];
  if (found.length) return found[0].id;
  res = await timedFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST', headers: { ...gAuth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) await apiError(res, 'Drive folder create');
  return (await res.json()).id;
}

/* Multipart upload streaming the zip from disk (never fully buffered). */
async function gUpload(token, folderId, zipPath, filename, size) {
  const boundary = 'xcwiki' + crypto.randomBytes(8).toString('hex');
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: filename, parents: [folderId], mimeType: 'application/zip' }) +
    `\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--`);
  async function* parts() {
    yield pre;
    const rs = fs.createReadStream(zipPath);
    for await (const chunk of rs) yield chunk;
    yield post;
  }
  const res = await timedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size', {
    method: 'POST',
    headers: {
      ...gAuth(token),
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(pre.length + size + post.length),
    },
    body: Readable.from(parts()),
    duplex: 'half',
  }, 600000);
  if (!res.ok) await apiError(res, 'Drive upload');
  return res.json();
}

async function gList(token, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await timedFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,size,createdTime)`,
    { headers: gAuth(token) });
  if (!res.ok) await apiError(res, 'Drive list');
  return ((await res.json()).files || []).map(f => ({
    id: f.id, name: f.name, size: Number(f.size || 0), created_at: f.createdTime || '',
  }));
}

async function gDelete(token, fileId) {
  const res = await timedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE', headers: gAuth(token),
  });
  if (!res.ok && res.status !== 404) await apiError(res, 'Drive delete');
}

async function gDownload(token, fileId, destPath) {
  const res = await timedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: gAuth(token),
  }, 600000);
  if (!res.ok || !res.body) await apiError(res, 'Drive download');
  await streamToFile(res.body, destPath);
}

/* ---------- OneDrive / Microsoft Graph ---------- */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const odPath = (p) => `${GRAPH}/me/drive/root:${p}`;
const odJson = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });

async function odEnsureFolder(token) {
  const res = await timedFetch(`${GRAPH}/me/drive/root/children`, {
    method: 'POST', headers: odJson(token),
    body: JSON.stringify({ name: FOLDER_NAME, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
  if (res.ok) return (await res.json()).id;
  if (res.status === 409) {
    const g = await timedFetch(odPath(`:/${encodeURIComponent(FOLDER_NAME)}`), { headers: { Authorization: 'Bearer ' + token } });
    if (!g.ok) await apiError(g, 'OneDrive folder fetch');
    return (await g.json()).id;
  }
  await apiError(res, 'OneDrive folder create');
}

async function odPutSimple(token, url, zipPath, size) {
  const res = await timedFetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/zip', 'Content-Length': String(size) },
    body: fs.createReadStream(zipPath),
    duplex: 'half',
  }, 600000);
  if (!res.ok) await apiError(res, 'OneDrive upload');
  return res.json();
}

/* Chunked upload session for files > 4MB (fragments must be multiples of 320 KiB). */
async function odPutSession(token, url, zipPath, size) {
  const sess = await timedFetch(url + ':/createUploadSession', {
    method: 'POST', headers: odJson(token),
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: path.basename(url) } }),
  });
  if (!sess.ok) await apiError(sess, 'OneDrive upload session');
  const uploadUrl = (await sess.json()).uploadUrl;
  if (!uploadUrl) throw new Error('OneDrive did not return an upload URL');
  const CHUNK = 5 * 1024 * 1024;
  const fd = fs.openSync(zipPath, 'r');
  try {
    let offset = 0, last = null;
    while (offset < size) {
      const end = Math.min(offset + CHUNK, size) - 1;
      const len = end - offset + 1;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const r = await timedFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${end}/${size}` },
        body: buf,
      }, 120000);
      if (!r.ok && r.status !== 202) await apiError(r, 'OneDrive chunk upload');
      last = await r.json().catch(() => null);
      offset = end + 1;
    }
    return last || {};
  } finally { fs.closeSync(fd); }
}

async function odUpload(token, folderId, zipPath, filename, size) {
  const encFile = encodeURIComponent(filename);
  const url = odPath(`:/${encodeURIComponent(FOLDER_NAME)}/${encFile}:/content`);
  if (size <= 4 * 1024 * 1024) return odPutSimple(token, url, zipPath, size);
  return odPutSession(token, url, zipPath, size);
}

async function odList(token) {
  const res = await timedFetch(
    odPath(`:/${encodeURIComponent(FOLDER_NAME)}:/children`) +
    '?$orderby=createdDateTime desc&$top=100&$select=id,name,size,createdDateTime',
    { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404) return [];
  if (!res.ok) await apiError(res, 'OneDrive list');
  return ((await res.json()).value || [])
    .filter(f => /\.zip$/i.test(f.name || ''))
    .map(f => ({ id: f.id, name: f.name, size: Number(f.size || 0), created_at: f.createdDateTime || '' }));
}

async function odDelete(token, itemId) {
  const res = await timedFetch(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok && res.status !== 404) await apiError(res, 'OneDrive delete');
}

async function odDownload(token, itemId, destPath) {
  const res = await timedFetch(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`, {
    headers: { Authorization: 'Bearer ' + token }, redirect: 'follow',
  }, 600000);
  if (!res.ok || !res.body) await apiError(res, 'OneDrive download');
  await streamToFile(res.body, destPath);
}

const PROVIDER_OPS = {
  google: { ensureFolder: gEnsureFolder, upload: gUpload, list: gList, del: gDelete, download: gDownload },
  onedrive: { ensureFolder: odEnsureFolder, upload: odUpload, list: odList, del: odDelete, download: odDownload },
};

async function ensureFolder(db, provider) {
  const token = await getAccessToken(db, provider);
  const folderId = await PROVIDER_OPS[provider].ensureFolder(token);
  db.prepare('UPDATE cloud_connections SET folder_id = ? WHERE provider = ?').run(folderId || '', provider);
  return folderId;
}

/* ---------- backup engine ---------- */

async function buildBackupZip(db) {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcwiki-backup-'));
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10) + '-' +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0');
  const filename = `xcwiki-backup-${stamp}.zip`;
  const zipPath = path.join(tmpDir, filename);

  let integrity = 'unknown';
  try {
    const rows = db.pragma('integrity_check');
    integrity = (rows.length === 1 && rows[0].integrity_check === 'ok') ? 'ok' : JSON.stringify(rows).slice(0, 200);
  } catch (e) { integrity = 'error: ' + e.message; }

  const dbSize = fs.statSync(DB_PATH).size;
  let uploadsCount = 0, uploadsBytes = 0;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      if (st.isFile()) { uploadsCount++; uploadsBytes += st.size; }
    }
  } catch {}
  let version = '';
  try { version = require('../package.json').version || ''; } catch {}

  const counts = {};
  for (const t of ['articles', 'customers', 'customer_groups', 'article_versions', 'attachments']) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { counts[t] = 0; }
  }

  const manifest = {
    app: APP_NAME, version, created_at: new Date().toISOString(),
    db_integrity: integrity, db_size: dbSize,
    uploads_count: uploadsCount, uploads_bytes: uploadsBytes,
    counts,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  manifest.checksums = {
    'manifest.json': 'self',
    [DB_FILENAME]: 'sha256:' + sha256File(DB_PATH),
  };
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('error', reject);
    archive.pipe(out);
    archive.file(DB_PATH, { name: DB_FILENAME });
    if (fs.existsSync(UPLOAD_DIR)) archive.directory(UPLOAD_DIR, 'uploads');
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    archive.finalize();
  });
  return { tmpDir, zipPath, filename, size: fs.statSync(zipPath).size, manifest };
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function retentionLimit(db) {
  const n = parseInt(getState(db, 'cloud:retention') || '10', 10);
  return Math.min(100, Math.max(1, Number.isFinite(n) ? n : 10));
}

async function pruneRetention(db, provider) {
  const keep = retentionLimit(db);
  const rows = db.prepare('SELECT id, drive_file_id FROM backup_records WHERE provider = ? ORDER BY created_at DESC').all(provider);
  const extra = rows.slice(keep);
  let deleted = 0;
  for (const r of extra) {
    try {
      const token = await getAccessToken(db, provider);
      await PROVIDER_OPS[provider].del(token, r.drive_file_id);
    } catch (e) { console.error(`retention delete failed for ${r.drive_file_id}:`, e.message); }
    db.prepare('DELETE FROM backup_records WHERE id = ?').run(r.id);
    deleted++;
  }
  return deleted;
}

async function runBackup(db, provider, opts = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown provider');
  const tmp = await buildBackupZip(db);
  try {
    const token = await getAccessToken(db, provider);
    const ops = PROVIDER_OPS[provider];
    const folderId = await ops.ensureFolder(token);
    db.prepare('UPDATE cloud_connections SET folder_id = ? WHERE provider = ?').run(folderId || '', provider);
    const up = await ops.upload(token, folderId, tmp.zipPath, tmp.filename, tmp.size);
    const summary = {
      db_size: tmp.manifest.db_size, uploads_count: tmp.manifest.uploads_count,
      uploads_bytes: tmp.manifest.uploads_bytes, db_integrity: tmp.manifest.db_integrity,
      counts: tmp.manifest.counts,
    };
    const rec = db.prepare(`INSERT INTO backup_records
      (filename, provider, drive_file_id, size_bytes, created_at, summary_json, status, is_safety)
      VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)`)
      .run(tmp.filename, provider, String(up.id || ''), tmp.size, new Date().toISOString(),
        JSON.stringify(summary), opts.isSafety ? 1 : 0);
    db.prepare('UPDATE cloud_connections SET last_error = ? WHERE provider = ?').run('', provider);
    const pruned = await pruneRetention(db, provider);
    return { ok: true, record_id: rec.lastInsertRowid, filename: tmp.filename, size: tmp.size, pruned };
  } catch (e) {
    markError(db, provider, e.message);
    throw e;
  } finally {
    fs.rmSync(tmp.tmpDir, { recursive: true, force: true });
  }
}

function listBackups(db) {
  const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  return db.prepare(`SELECT id, filename, provider, drive_file_id, size_bytes, created_at, summary_json, status, is_safety
    FROM backup_records ORDER BY created_at DESC LIMIT 200`).all()
    .map(r => ({ ...r, summary: safeJson(r.summary_json) }));
}

async function downloadBackup(db, recordId) {
  const rec = db.prepare('SELECT * FROM backup_records WHERE id = ?').get(recordId);
  if (!rec) throw new Error('Backup not found');
  const token = await getAccessToken(db, rec.provider);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcwiki-dl-'));
  const zipPath = path.join(tmpDir, rec.filename);
  try {
    await PROVIDER_OPS[rec.provider].download(token, rec.drive_file_id, zipPath);
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
  return { tmpDir, zipPath, filename: rec.filename, record: rec };
}

/* ---------- restore ---------- */

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

async function extractEntryToFile(entry, destPath) {
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    out.on('finish', resolve);
    out.on('error', reject);
    entry.stream().on('error', reject).pipe(out);
  });
}

/**
 * Validate a backup zip and swap it into place: replaces data/xcwiki.db and
 * data/uploads/, reopens the DB connection (no restart), verifies integrity.
 * Returns { restored: {...}, db } where db is the fresh handle.
 */
async function restoreFromZip(liveDb, zipPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcwiki-restore-'));
  try {
    const dir = await unzipper.Open.file(zipPath);
    const manifestEntry = dir.files.find(f => f.path === 'manifest.json');
    if (!manifestEntry) throw new Error('Invalid backup: manifest.json is missing');
    let manifest;
    try { manifest = JSON.parse((await manifestEntry.buffer()).toString('utf8')); }
    catch { throw new Error('Invalid backup: manifest.json is corrupt'); }
    if (manifest.app !== APP_NAME || !manifest.created_at) {
      throw new Error('Invalid backup: not an XC Wiki backup file');
    }
    const dbEntry = dir.files.find(f => f.path === DB_FILENAME);
    if (!dbEntry) throw new Error(`Invalid backup: ${DB_FILENAME} is missing`);

    // zip-slip protection before extracting anything
    const stageDir = path.resolve(path.join(tmpDir, 'stage'));
    for (const f of dir.files) {
      const resolved = path.resolve(stageDir, f.path);
      if (resolved !== stageDir && !resolved.startsWith(stageDir + path.sep)) {
        throw new Error('Invalid backup: unsafe path in zip');
      }
    }

    fs.mkdirSync(stageDir, { recursive: true });
    const stagedDb = path.join(stageDir, DB_FILENAME);
    await extractEntryToFile(dbEntry, stagedDb);

    const stagedUploads = path.join(stageDir, 'uploads');
    for (const f of dir.files) {
      if (f.path.startsWith('uploads/') && !f.path.endsWith('/')) {
        const dest = path.join(stageDir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await extractEntryToFile(f, dest);
      }
    }

    // checksum check when the manifest carries one
    if (manifest.checksums && manifest.checksums[DB_FILENAME]) {
      const expected = String(manifest.checksums[DB_FILENAME]).replace(/^sha256:/, '');
      if (expected && expected.length === 64) {
        const actual = sha256File(stagedDb);
        if (actual !== expected) throw new Error('Invalid backup: database checksum mismatch');
      }
    }

    // integrity check on the staged DB before touching the live one
    const check = new Database(stagedDb, { readonly: true });
    let integ;
    try {
      const rows = check.pragma('integrity_check');
      integ = rows.length === 1 ? rows[0].integrity_check : 'corrupt';
    } finally { check.close(); }
    if (integ !== 'ok') throw new Error('Backup database failed integrity check: ' + integ);

    // swap: close live connection, replace files, reopen
    const dbm = require('./db');
    dbm.closeDb();
    fs.copyFileSync(stagedDb, DB_PATH);
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    if (fs.existsSync(stagedUploads)) copyDirSync(stagedUploads, UPLOAD_DIR);

    const newDb = dbm.reopenDb();
    const live = newDb.pragma('integrity_check');
    if (!(live.length === 1 && live[0].integrity_check === 'ok')) {
      throw new Error('Restored database failed integrity check after reopen');
    }
    const countOf = (t) => { try { return newDb.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return 0; } };
    const restored = {
      created_at: manifest.created_at,
      version: manifest.version || '',
      articles: countOf('articles'),
      customers: countOf('customers'),
      uploads_count: manifest.uploads_count || 0,
    };
    return { restored, db: newDb };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Full restore flow for a stored backup record:
 *  1. safety backup of current state (uploaded when providers are connected;
 *     always kept as a local fallback copy),
 *  2. download the chosen zip,
 *  3. validate + swap via restoreFromZip,
 *  4. log activity.
 */
async function restoreBackup(db, recordId) {
  const rec = db.prepare('SELECT * FROM backup_records WHERE id = ?').get(recordId);
  if (!rec) throw new Error('Backup not found');

  // 1. safety backup of the CURRENT state before touching anything
  const safety = [];
  const tmp = await buildBackupZip(db);
  try {
    const providers = connectedProviders(db);
    for (const p of providers) {
      try { safety.push({ provider: p, ...(await runBackup(db, p, { isSafety: true })) }); }
      catch (e) { safety.push({ provider: p, ok: false, error: e.message }); }
    }
    if (!providers.length) {
      fs.mkdirSync(SAFETY_DIR, { recursive: true });
      const dest = path.join(SAFETY_DIR, 'safety-' + tmp.filename);
      fs.copyFileSync(tmp.zipPath, dest);
      const olds = fs.readdirSync(SAFETY_DIR).filter(f => f.startsWith('safety-')).sort();
      while (olds.length > 3) { try { fs.unlinkSync(path.join(SAFETY_DIR, olds.shift())); } catch {} }
      safety.push({ provider: 'local', ok: true, filename: path.basename(dest), note: 'kept on server (no cloud connected)' });
    }
  } finally {
    fs.rmSync(tmp.tmpDir, { recursive: true, force: true });
  }

  // 2. download the chosen backup
  const dl = await downloadBackup(db, recordId);
  try {
    // 3. validate + swap
    const { restored, db: newDb } = await restoreFromZip(db, dl.zipPath);
    // 4. log
    try {
      newDb.prepare(`INSERT INTO activity_log (user_id, action, details, created_at) VALUES (NULL, ?, ?, ?)`)
        .run('backup_restored', `Restored ${rec.filename} (${rec.provider}); safety: ${safety.map(s => s.provider + ':' + (s.ok ? 'ok' : 'FAILED')).join(', ')}`, new Date().toISOString());
    } catch {}
    return { restored, safety, record: { id: rec.id, filename: rec.filename, provider: rec.provider } };
  } finally {
    fs.rmSync(dl.tmpDir, { recursive: true, force: true });
  }
}

/* ---------- schedule settings ---------- */

const DEFAULT_SETTINGS = { freq: 'off', time: '03:00', providers: [], retention: 10 };

function getBackupSettings(db) {
  const s = { ...DEFAULT_SETTINGS };
  const freq = getState(db, 'cloud:freq');
  if (['off', 'daily', 'weekly'].includes(freq)) s.freq = freq;
  const time = getState(db, 'cloud:time');
  if (/^\d{2}:\d{2}$/.test(time)) s.time = time;
  try {
    const p = JSON.parse(getState(db, 'cloud:providers') || '[]');
    s.providers = Array.isArray(p) ? p.filter(x => PROVIDERS.includes(x)) : [];
  } catch {}
  s.retention = retentionLimit(db);
  return s;
}

function saveBackupSettings(db, body) {
  const { freq, time, providers, retention } = body || {};
  if (freq !== undefined && !['off', 'daily', 'weekly'].includes(freq)) throw new Error('Invalid frequency');
  if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) throw new Error('Invalid time (HH:MM)');
  if (retention !== undefined) {
    const n = parseInt(retention, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('Retention must be 1–100');
  }
  if (freq !== undefined) setState(db, 'cloud:freq', freq);
  if (time !== undefined) setState(db, 'cloud:time', time);
  if (providers !== undefined) {
    if (!Array.isArray(providers)) throw new Error('providers must be an array');
    setState(db, 'cloud:providers', JSON.stringify(providers.filter(p => PROVIDERS.includes(p))));
  }
  if (retention !== undefined) setState(db, 'cloud:retention', String(parseInt(retention, 10)));
  return getBackupSettings(db);
}

/* ---------- automatic backups (called from the 60s scheduler tick) ---------- */

async function checkAutoBackup(db) {
  const s = getBackupSettings(db);
  if (s.freq === 'off') return { ran: false };
  const now = new Date();
  if (hhmm(now) < s.time) return { ran: false };
  const today = isoDay(now);
  let key, due = false;
  if (s.freq === 'daily') {
    key = `cloud:auto:daily:${today}`;
    due = getState(db, key) !== 'done';
  } else {
    key = 'cloud:auto:weekly';
    const last = Number(getState(db, key) || 0);
    due = !last || (Date.now() - last) > 7 * 24 * 3600 * 1000;
  }
  if (!due) return { ran: false };
  const targets = connectedProviders(db).filter(p => !s.providers.length || s.providers.includes(p));
  const results = [];
  for (const p of targets) {
    try { results.push({ provider: p, ...(await runBackup(db, p)) }); }
    catch (e) { results.push({ provider: p, ok: false, error: e.message }); }
  }
  setState(db, key, s.freq === 'daily' ? 'done' : String(Date.now()));
  return { ran: true, results };
}

async function deleteRemoteFile(db, provider, fileId) {
  const token = await getAccessToken(db, provider);
  await PROVIDER_OPS[provider].del(token, fileId);
}

module.exports = {
  PROVIDERS, FOLDER_NAME, APP_NAME, fmtBytes,
  getConnection, connectedProviders, publicConnection,
  saveClientCreds, disconnect, storeTokens, markError,
  newOAuthState, consumeOAuthState, redirectUriFor, authUrl, exchangeCode, refreshAccessToken,
  getAccessToken, ensureFolder,
  buildBackupZip, runBackup, pruneRetention, listBackups, downloadBackup, deleteRemoteFile,
  restoreFromZip, restoreBackup,
  getBackupSettings, saveBackupSettings, checkAutoBackup,
};
