'use strict';
const crypto = require('crypto');
const config = require('../config');

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status; this.code = code; this.details = details;
  }
}
const err = (status, code, message, details) => new AppError(status, code, message, details);

const now = () => Date.now();

// ---- money (integer satang) ----
const toSatang = (baht) => Math.round(Number(baht || 0) * 100);
const fromSatang = (s) => (Number(s || 0) / 100);
const fmtMoney = (s) => (Number(s || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Percentage of a satang amount; rate in percent (e.g. 7 or 10). Half-up rounding to 1 satang.
const pct = (amount, rate) => Math.round((amount * rate) / 100 + 1e-9);

// ---- tokens ----
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const KEY = crypto.createHash('sha256').update(config.secret).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}
function decrypt(blob) {
  const b = Buffer.from(blob, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
const randomCode = (len = 8, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') => {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
};

// ---- i18n ----
const LANGS = ['th', 'en', 'zh'];
function tr(v, lang = 'th') {
  if (v == null) return '';
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
  if (typeof v !== 'object') return String(v);
  return v[lang] || v.th || v.en || v.zh || '';
}
function i18nInput(v) {
  // Accepts a string or {th,en,zh}; returns a normalized object
  if (v == null) return { th: '', en: '', zh: '' };
  if (typeof v === 'string') return { th: v, en: '', zh: '' };
  const o = {};
  for (const l of LANGS) o[l] = typeof v[l] === 'string' ? v[l].slice(0, 5000) : '';
  return o;
}

// ---- local time helpers (branch timezone) ----
function localParts(ts, tz = 'Asia/Bangkok') {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, hh: p.hour, mm: p.minute, weekday: wd, date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minutes: (+p.hour) * 60 + (+p.minute) };
}
const hhmm = (ts, tz) => localParts(ts, tz).time;
const ddmmyyyy = (ts, tz) => { const p = localParts(ts, tz); return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}/${p.y}`; };
const toMinutes = (s) => { if (!s) return null; const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
// Is local minute-of-day within [from,to] (supports windows crossing midnight)
function inWindow(minutes, from, to) {
  const a = toMinutes(from), b = toMinutes(to);
  if (a == null || b == null) return true;
  if (a <= b) return minutes >= a && minutes <= b;
  return minutes >= a || minutes <= b;
}
// Start of local day in epoch ms for the given timestamp in tz
function startOfLocalDay(ts, tz = 'Asia/Bangkok') {
  const p = localParts(ts, tz);
  return ts - (p.minutes * 60000) - (new Date(ts).getSeconds() * 1000) - new Date(ts).getMilliseconds();
}

const int = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const clampStr = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

module.exports = {
  AppError, err, now, toSatang, fromSatang, fmtMoney, pct, randomToken, sha256, encrypt, decrypt, randomCode,
  LANGS, tr, i18nInput, localParts, hhmm, ddmmyyyy, toMinutes, inWindow, startOfLocalDay, int, clampStr, pick,
};
