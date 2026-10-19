'use strict';
/* Password hashing (scrypt) + bearer-token session management. */

const crypto = require('crypto');

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_OPTS).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 3) return false;
  const [, salt, expected] = parts;
  try {
    const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_OPTS).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function expiryFor(rememberMe) {
  const hours = rememberMe ? 24 * 30 : 12;
  return Date.now() + hours * 3600 * 1000;
}

module.exports = { hashPassword, verifyPassword, newToken, expiryFor };
