'use strict';
// Customer API — authorised only by the table-session QR token. Every call re-validates the session on the server.
const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { err, tr } = require('../lib/util');
const { rateLimit } = require('../lib/ratelimit');
const sessions = require('../services/sessions');
const orders = require('../services/orders');
const calls = require('../services/calls');
const menu = require('../services/menu');
const members = require('../services/members');
const theme = require('../services/theme');
const { branchSettings } = require('../services/settings');

const r = express.Router();
const tokenKey = (req) => `${req.ip}|${req.params.token}`;
r.use('/:token', rateLimit({ windowMs: 60000, max: 240, key: tokenKey }));

// Resolve the session for each request (410 when the table was closed)
function load(req, res, next) {
  try { req.session_ = sessions.resolveCustomerToken(req.params.token); next(); } catch (e) { next(e); }
}
const memberToken = (sessionId, memberId) => crypto.createHmac('sha256', config.secret).update(`member:${sessionId}:${memberId}`).digest('hex').slice(0, 40);

r.get('/:token', load, (req, res) => {
  const s = req.session_;
  const d = db.get();
  const settings = branchSettings(s.branch_id);
  const detail = sessions.sessionDetail(s.id);
  const b = d.prepare('SELECT b.*, r.name r_name, r.logo_asset_id r_logo, r.contact FROM branches b JOIN restaurants r ON r.id=b.restaurant_id WHERE b.id=?').get(s.branch_id);
  const pkgs = d.prepare(`SELECT DISTINCT p.id, p.code, p.name, p.description, p.color, p.cover_asset_id, p.max_per_round, p.round_per_guest, p.round_interval_min, p.leftover_policy FROM session_guests g JOIN buffet_packages p ON p.id=g.package_id WHERE g.session_id=? AND g.active=1`).all(s.id)
    .map((p) => ({ id: p.id, code: p.code, name: db.J(p.name, {}), description: db.J(p.description, {}), color: p.color, cover: p.cover_asset_id ? `/media/${p.cover_asset_id}` : null, max_per_round: p.max_per_round, round_per_guest: !!p.round_per_guest, round_interval_min: p.round_interval_min, leftover: db.J(p.leftover_policy, {}) }));
  const member = s.member_id ? members.memberOut(d.prepare('SELECT * FROM members WHERE id=?').get(s.member_id)) : null;
  res.json({
    session: { public_code: s.public_code, status: s.status, table_code: detail.table.code, start_at: s.start_at, end_at: s.end_at, order_end_at: s.order_end_at, duration_min: s.duration_min, last_order_at: s.last_order_at,
      guests: detail.guests.map((g) => ({ label: g.label, display_name: g.display_name, package_id: g.package_id })), guests_count: detail.guests_count },
    packages: pkgs,
    restaurant: { name: db.J(b.r_name, {}), branch_name: db.J(b.name, {}), logo: (b.logo_asset_id || b.r_logo) ? `/media/${b.logo_asset_id || b.r_logo}` : null,
      banner: b.banner_asset_id ? `/media/${b.banner_asset_id}` : null, banner_mobile: b.banner_mobile_asset_id ? `/media/${b.banner_mobile_asset_id}` : null, contact: db.J(b.contact, {}), phone: b.phone },
    terms: settings.terms, languages: settings.languages, default_language: settings.default_language,
    alerts_min: settings.time_alerts_min, lock_after_time_up: settings.lock_orders_after_time_up,
    call_types: calls.callTypes(s.branch_id), member, theme: theme.activeTheme(s.branch_id).settings.colors,
    server_time: Date.now(),
  });
});

r.get('/:token/menu', load, (req, res) => {
  const s = req.session_;
  const guests = db.get().prepare('SELECT label, package_id FROM session_guests WHERE session_id=? AND active=1').all(s.id);
  const g = req.query.guest ? guests.find((x) => x.label === req.query.guest) : null;
  const pkgIds = g ? [g.package_id] : [...new Set(guests.map((x) => x.package_id))];
  res.json(menu.customerMenu(s.branch_id, pkgIds));
});

r.post('/:token/orders', rateLimit({ windowMs: 10000, max: 12, key: tokenKey }), load, (req, res) => {
  const out = orders.placeOrder(req.session_.id, req.body || {}, { source: 'customer' });
  res.status(out.duplicate ? 200 : 201).json({ order: orders.customerOrder(out), duplicate: out.duplicate });
});

r.get('/:token/orders', load, (req, res) => {
  res.json({ orders: orders.sessionOrders(req.session_.id).map(orders.customerOrder) });
});

r.post('/:token/guest-name', load, (req, res) => {
  sessions.setGuestName(req.session_.id, String(req.body.label || ''), req.body.name);
  sessions.notifySession(req.session_.id);
  res.json({ ok: true });
});

r.get('/:token/calls', load, (req, res) => res.json({ calls: calls.sessionCalls(req.session_.id) }));
r.post('/:token/calls', rateLimit({ windowMs: 60000, max: 10, key: tokenKey }), load, (req, res) => {
  res.status(201).json({ call: calls.createCall(req.session_, req.body || {}) });
});

r.get('/:token/qr.png', load, async (req, res) => {
  const url = sessions.orderUrl(req.params.token, req);
  res.type('png').set('Cache-Control', 'no-store').send(await QRCode.toBuffer(url, { width: 480, margin: 1 }));
});

r.get('/:token/bill', load, (req, res) => {
  const b = require('../services/pricing').computeBill(req.session_.id, { lang: req.query.lang || 'th' });
  res.json({ bill: { lines: b.lines.map((l) => ({ kind: l.kind, name: l.name, qty: l.qty, amount: l.amount })), discounts: b.discounts.filter((x) => x.amount > 0), subtotal: b.subtotal, service_rate: b.service_rate, service_charge: b.service_charge, vat_rate: b.vat_rate, vat: b.vat, total: b.total } });
});

// ---- membership during the meal ----
r.post('/:token/member/otp', rateLimit({ windowMs: 600000, max: 5, key: tokenKey }), load, async (req, res) => {
  res.json(await members.requestOtp(req.body.phone, 'register'));
});
// Verify OTP; registers a new member (when profile data is supplied) or signs in an existing one, then links to this table.
r.post('/:token/member/verify', rateLimit({ windowMs: 600000, max: 10, key: tokenKey }), load, (req, res) => {
  const s = req.session_;
  const d = db.get();
  const phone = members.verifyOtp(req.body.phone, req.body.code, 'register');
  let m = d.prepare('SELECT * FROM members WHERE phone=?').get(phone);
  if (!m) {
    if (!req.body.first_name) return res.json({ needs_profile: true, phone, signup_token: crypto.createHmac('sha256', config.secret).update(`signup:${s.id}:${phone}`).digest('hex').slice(0, 40) });
    m = members.register({ ...req.body, phone }, { branchId: s.branch_id, sessionId: s.id, verified: true });
  } else {
    members.linkToSession(s.id, m.id);
  }
  sessions.notifySession(s.id);
  res.json({ member: members.memberOut(m), member_token: memberToken(s.id, m.id) });
});
// Complete profile after OTP was verified (signup_token proves the phone was verified for this table)
r.post('/:token/member/register', rateLimit({ windowMs: 600000, max: 10, key: tokenKey }), load, (req, res) => {
  const s = req.session_;
  const phone = members.normPhone(req.body.phone);
  const expect = crypto.createHmac('sha256', config.secret).update(`signup:${s.id}:${phone}`).digest('hex').slice(0, 40);
  if (!req.body.signup_token || !crypto.timingSafeEqual(Buffer.from(String(req.body.signup_token).padEnd(40).slice(0, 40)), Buffer.from(expect))) throw err(403, 'not_verified', 'กรุณายืนยันเบอร์โทรศัพท์ก่อน');
  const m = members.register({ ...req.body, phone }, { branchId: s.branch_id, sessionId: s.id, verified: true });
  sessions.notifySession(s.id);
  res.status(201).json({ member: members.memberOut(m), member_token: memberToken(s.id, m.id) });
});

function memberAuth(req) {
  const s = req.session_;
  if (!s.member_id) throw err(403, 'no_member', 'ยังไม่ได้เชื่อมสมาชิก');
  const t = String(req.get('x-member-token') || '');
  if (t !== memberToken(s.id, s.member_id)) throw err(403, 'member_auth', 'กรุณายืนยันตัวตนสมาชิก');
  return db.get().prepare('SELECT * FROM members WHERE id=?').get(s.member_id);
}

r.get('/:token/member', load, (req, res) => {
  const m = memberAuth(req);
  const redemptions = db.get().prepare(`SELECT r.id, r.code, r.status, r.points_spent, r.expires_at, p.name FROM redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE r.member_id=? AND r.status IN ('issued','applied') ORDER BY r.id DESC`).all(m.id).map((x) => ({ ...x, name: db.J(x.name, {}) }));
  res.json({ member: members.memberOut(m), promotions: members.availablePromotions(m, req.session_.branch_id).map((p) => ({ id: p.id, name: p.name, description: p.description, image: p.image, type: p.type, value: p.value, points_cost: p.points_cost, ineligible: p.ineligible })), redemptions, history: members.pointHistory(m.id).slice(0, 30) });
});
r.post('/:token/member/redeem', rateLimit({ windowMs: 60000, max: 10, key: tokenKey }), load, (req, res) => {
  const m = memberAuth(req);
  const red = members.redeem(m.id, Number(req.body.promotion_id), req.session_.branch_id, { sessionId: req.session_.id });
  require('../realtime').toStaff(req.session_.branch_id, 'tables:changed', { session_id: req.session_.id });
  res.status(201).json({ redemption: { id: red.id, code: red.code, status: red.status }, member: members.memberOut(db.get().prepare('SELECT * FROM members WHERE id=?').get(m.id)) });
});

module.exports = r;
