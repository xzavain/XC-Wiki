'use strict';
/* XC Wiki email: SMTP delivery (nodemailer) for customer password-setup
   invites / resets and admin alerts. All configuration lives in the
   settings table (Admin → Settings → Email); the SMTP password is stored
   AES-256-GCM encrypted via lib/crypto and never leaves the server. */

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getSettings } = require('./db');
const { encryptJSON, decryptJSON } = require('./crypto');

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // password-setup links live 72 hours

function smtpPassword(settings) {
  if (!settings.smtp_pass_enc) return '';
  try {
    const v = decryptJSON(settings.smtp_pass_enc);
    return (v && typeof v.p === 'string') ? v.p : '';
  } catch { return ''; }
}

function setSmtpPassword(settings, plain) {
  return plain ? encryptJSON({ p: String(plain) }) : '';
}

function smtpConfigured(settings) {
  return !!(settings.smtp_host && (settings.smtp_from_email || settings.smtp_user));
}

function transport(settings) {
  const mode = settings.smtp_secure || 'starttls';
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 587,
    secure: mode === 'tls',
    requireTLS: mode === 'starttls',
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: smtpPassword(settings) } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

function fromAddress(settings) {
  const email = settings.smtp_from_email || settings.smtp_user;
  const name = settings.smtp_from_name || settings.site_title || 'XC Wiki';
  return { name, address: email };
}

async function sendMail(settings, { to, subject, text, html }) {
  const tx = transport(settings);
  await tx.sendMail({ from: fromAddress(settings), to, subject, text, html: html || undefined });
}

/** Absolute base URL for links in emails: the configured site URL when the
    admin set one, otherwise the origin of the current request. */
function publicBase(settings, req) {
  const configured = String(settings.site_url || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (!req) return '';
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}`;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Create a fresh password-setup token for a customer (any earlier unused
    tokens for that customer are invalidated). Returns the RAW token — only
    its hash is used for verification. An encrypted copy of the raw token is
    also stored so an admin can copy the setup link later (e.g. from the
    Invites list); it is never used to verify anything.
    `purpose` distinguishes 'invite' | 'reset' | 'welcome' tokens. */
function createPasswordToken(db, customerId, purpose = 'reset') {
  const raw = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const p = ['invite', 'reset', 'welcome'].includes(purpose) ? purpose : 'reset';
  let enc = '';
  try { enc = encryptJSON({ t: raw }); } catch { enc = ''; }
  db.prepare('DELETE FROM password_tokens WHERE customer_id = ? AND used_at IS NULL').run(customerId);
  db.prepare('INSERT INTO password_tokens (customer_id, token_hash, expires_at, created_at, purpose, token_encrypted) VALUES (?, ?, ?, ?, ?, ?)')
    .run(customerId, hashToken(raw), now + TOKEN_TTL_MS, now, p, enc);
  return raw;
}

/** Recover the raw token from a stored row's encrypted copy (admin display
    only). Returns '' for legacy rows that predate the stored copy. */
function rawTokenFromRow(row) {
  if (!row || !row.token_encrypted) return '';
  try {
    const obj = decryptJSON(row.token_encrypted);
    return obj && obj.t ? String(obj.t) : '';
  } catch { return ''; }
}

function findPasswordToken(db, raw) {
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM password_tokens WHERE token_hash = ?').get(hashToken(raw));
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  return row;
}

function setupLink(settings, req, raw) {
  /* clean path URL (the SPA moved off hash routing in v1.1.0; links sent
     before the upgrade still work — the client shims #/ URLs once) */
  return `${publicBase(settings, req)}/set-password?token=${raw}`;
}

/** Send (or, without SMTP, just prepare) a password-setup email for a
    customer. Always returns the link so the admin can hand it over
    manually when email is not configured or delivery fails. */
async function sendCustomerInvite(db, req, customer, { reset = false } = {}) {
  const settings = getSettings(db);
  const raw = createPasswordToken(db, customer.id, reset ? 'reset' : 'invite');
  const link = setupLink(settings, req, raw);
  if (!smtpConfigured(settings)) return { link, emailed: false, reason: 'smtp-not-configured' };
  const site = settings.site_title || 'XC Wiki';
  const subject = reset ? `Reset your password — ${site}` : `Set up your password — ${site}`;
  const intro = reset
    ? `A password reset was requested for your ${site} account. Use the link below within 72 hours to choose a new password.`
    : `You've been given access to ${site}. Use the link below within 72 hours to set your password and sign in.`;
  const text = `${intro}\n\nSet your password: ${link}\n\nIf you weren't expecting this, you can ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${site}</h2>
    <p>${intro}</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#2E7CF6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Set your password</a></p>
    <p style="color:#666;font-size:.85rem">Or paste this link into your browser:<br>${link}</p>
    <p style="color:#666;font-size:.85rem">If you weren't expecting this, you can ignore this email.</p>
  </div>`;
  try {
    await sendMail(settings, { to: customer.email, subject, text, html });
    return { link, emailed: true };
  } catch (e) {
    return { link, emailed: false, reason: 'send-failed', error: String(e && e.message || e) };
  }
}

/** Send a welcome/onboarding email to a customer who has no password yet
    (e.g. imported from BookStack). Issues a 'welcome'-purpose token and
    always returns the link so the admin can hand it over manually. */
async function sendCustomerWelcome(db, req, customer) {
  const settings = getSettings(db);
  const raw = createPasswordToken(db, customer.id, 'welcome');
  const link = setupLink(settings, req, raw);
  if (!smtpConfigured(settings)) return { link, emailed: false, reason: 'smtp-not-configured' };
  const site = settings.site_title || 'XC Wiki';
  const subject = `Welcome to ${site} — set up your account`;
  const intro = `Welcome to ${site}! Your account is ready — all that's left is to choose a password so you can sign in and start using the guides and resources we've prepared for you.`;
  const text = `${intro}\n\nSet your password: ${link}\n\nThis link is valid for 72 hours. If it expires, just ask us for a fresh one.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">Welcome to ${site} 👋</h2>
    <p>${intro}</p>
    <p style="margin:24px 0"><a href="${link}" style="background:#2E7CF6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Set your password &amp; get started</a></p>
    <p style="color:#666;font-size:.85rem">Or paste this link into your browser:<br>${link}</p>
    <p style="color:#666;font-size:.85rem">This link is valid for 72 hours. If it expires, just ask us for a fresh one.</p>
  </div>`;
  try {
    await sendMail(settings, { to: customer.email, subject, text, html });
    return { link, emailed: true };
  } catch (e) {
    return { link, emailed: false, reason: 'send-failed', error: String(e && e.message || e) };
  }
}

/** Notify the admin that a customer accepted an invite (set their password
    through an invite token). Fire-and-forget: email to the staff accounts
    and/or a POST to the configured Discord webhook. Never throws — a
    notification failure must never fail the password setup itself. */
async function notifyInviteAccepted(db, customer) {
  try {
    const settings = getSettings(db);
    if (settings.notify_invite_accepted !== '1') return;
    const site = settings.site_title || 'XC Wiki';
    const who = `${customer.name || ''} <${customer.email || ''}>`.trim();
    // (a) email the staff admin accounts (no-op when SMTP is unconfigured)
    sendAdminAlert(db, 'notify_invite_accepted', `Invite accepted — ${site}`,
      `${who} just accepted their invite to ${site} and set their password.`).catch(() => {});
    // (b) Discord webhook
    const url = String(settings.discord_webhook_url || '').trim();
    if (url) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `🎉 **Invite accepted** — ${who} just set their password on **${site}**.` }),
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[mailer] invite-accepted notification failed:', e && e.message || e);
  }
}

/** Email every staff user (admin alerts). No-op unless alerts are enabled
    for the given settings flag and SMTP is configured. */
async function sendAdminAlert(db, flagKey, subject, text) {
  const settings = getSettings(db);
  if (settings[flagKey] !== '1' || !smtpConfigured(settings)) return { sent: false };
  const admins = db.prepare("SELECT email FROM users WHERE disabled IS NULL OR disabled = 0").all().map(r => r.email).filter(Boolean);
  if (!admins.length) return { sent: false };
  try {
    await sendMail(settings, { to: admins.join(','), subject, text });
    return { sent: true };
  } catch { return { sent: false }; }
}

async function sendTestEmail(db, to) {
  const settings = getSettings(db);
  if (!smtpConfigured(settings)) throw new Error('SMTP is not configured yet — fill in the host and a From address first.');
  const site = settings.site_title || 'XC Wiki';
  await sendMail(settings, {
    to,
    subject: `Test email — ${site}`,
    text: `This is a test email from ${site}. If you received it, your SMTP settings are working.`,
  });
}

/** Masked, admin-safe view of the email settings. */
function emailSettingsView(db) {
  const s = getSettings(db);
  const pass = smtpPassword(s);
  return {
    site_url: s.site_url || '',
    smtp_host: s.smtp_host || '',
    smtp_port: s.smtp_port || '587',
    smtp_secure: s.smtp_secure || 'starttls',
    smtp_user: s.smtp_user || '',
    smtp_pass_set: !!pass,
    smtp_pass_masked: pass ? `••••${pass.slice(-4)}` : '',
    smtp_from_name: s.smtp_from_name || '',
    smtp_from_email: s.smtp_from_email || '',
    email_alerts_feedback: s.email_alerts_feedback === '1',
    notify_invite_accepted: s.notify_invite_accepted === '1',
    discord_webhook_url: s.discord_webhook_url || '',
    configured: smtpConfigured(s),
  };
}

module.exports = {
  smtpConfigured, smtpPassword, setSmtpPassword, emailSettingsView,
  publicBase, createPasswordToken, findPasswordToken, setupLink, rawTokenFromRow,
  sendCustomerInvite, sendCustomerWelcome, notifyInviteAccepted,
  sendAdminAlert, sendTestEmail,
};
