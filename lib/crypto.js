'use strict';
/* AES-256-GCM encryption for cloud-backup credentials stored in SQLite.
   Key comes from the ENCRYPTION_KEY environment variable. Accepts a
   64-char hex string, a base64 string decoding to 32 bytes, or any
   other string (hashed with SHA-256 to 32 bytes). */

const crypto = require('crypto');

let _warned = false;

function getKey() {
  const raw = (process.env.ENCRYPTION_KEY || '').trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    try {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) return b;
    } catch { /* fall through to hashing */ }
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
  }
  if (!_warned) {
    _warned = true;
    console.warn(
      '\n⚠️  SECURITY WARNING: ENCRYPTION_KEY is not set. Cloud backup credentials will be\n' +
      '   encrypted with an insecure built-in dev key — anyone with the source code can\n' +
      '   decrypt them. Set a strong ENCRYPTION_KEY environment variable in production.\n'
    );
  }
  return crypto.createHash('sha256').update('xc-wiki-dev-fallback-key-DO-NOT-USE-IN-PROD', 'utf8').digest();
}

/** Encrypt a credentials object → opaque JSON string for the DB. */
function encryptJSON(obj) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

/** Decrypt a blob produced by encryptJSON. Throws on tamper / wrong key. */
function decryptJSON(blob) {
  const key = getKey();
  const o = JSON.parse(blob);
  if (!o || o.v !== 1 || !o.iv || !o.tag || !o.data) throw new Error('Unrecognized credential blob');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(o.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(o.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { getKey, encryptJSON, decryptJSON };
