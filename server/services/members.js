'use strict';
// Members, tiers, points ledger (FIFO lots with expiry), OTP verification, promotions & redemptions.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { err, now, sha256, randomCode, localParts, inWindow, tr } = require('../lib/util');
const { branchSettings } = require('./settings');

const normPhone = (p) => String(p || '').replace(/[^\d]/g, '').replace(/^66(\d{9})$/, '0$1');
const validPhone = (p) => /^0\d{8,9}$/.test(p);

function memberOut(m, { full = false } = {}) {
  if (!m) return null;
  const tier = m.tier_id ? db.get().prepare('SELECT id, code, name, color, image_asset_id FROM tiers WHERE id=?').get(m.tier_id) : null;
  const o = { id: m.id, code: m.code, first_name: m.first_name, last_name: m.last_name, points: m.points, tier: tier ? { id: tier.id, code: tier.code, name: db.J(tier.name, {}), color: tier.color, image: tier.image_asset_id ? `/media/${tier.image_asset_id}` : null } : null };
  if (full) Object.assign(o, { phone: m.phone, birthday: m.birthday, email: m.email, extra: db.J(m.extra, {}), total_spent: m.total_spent, created_at: m.created_at, verified_at: m.verified_at, active: !!m.active });
  else o.phone = m.phone ? m.phone.replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2') : null;
  return o;
}

function findMember(q) {
  const d = db.get();
  const s = String(q || '').trim();
  if (!s) return [];
  const phone = normPhone(s);
  return d.prepare('SELECT * FROM members WHERE active=1 AND (phone=? OR code=? OR phone LIKE ? OR first_name LIKE ? OR last_name LIKE ?) ORDER BY id DESC LIMIT 20')
    .all(phone, s.toUpperCase(), phone.length >= 4 ? `%${phone}` : '__none__', `${s}%`, `${s}%`);
}

// ---- OTP ----
async function requestOtp(phone, purpose = 'register') {
  phone = normPhone(phone);
  if (!validPhone(phone)) throw err(400, 'invalid_phone', 'เบอร์โทรศัพท์ไม่ถูกต้อง');
  const d = db.get();
  const recent = d.prepare('SELECT COUNT(*) c FROM otp_codes WHERE phone=? AND created_at>?').get(phone, now() - 15 * 60000).c;
  if (recent >= 5) throw err(429, 'otp_rate_limited', 'ขอรหัสบ่อยเกินไป กรุณารอสักครู่');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  d.prepare('INSERT INTO otp_codes(phone, code_hash, purpose, expires_at, created_at) VALUES(?,?,?,?,?)').run(phone, sha256(phone + ':' + code), purpose, now() + 5 * 60000, now());
  if (config.otpMode === 'webhook') {
    if (!config.smsWebhookUrl) throw err(503, 'sms_not_configured', 'ยังไม่ได้ตั้งค่าบริการ SMS');
    const r = await fetch(config.smsWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...(config.smsWebhookToken ? { authorization: `Bearer ${config.smsWebhookToken}` } : {}) }, body: JSON.stringify({ phone, message: `รหัสยืนยัน ${code} (หมดอายุใน 5 นาที)`, code }) }).catch((e) => ({ ok: false, statusText: e.message }));
    if (!r.ok) throw err(502, 'sms_failed', 'ส่ง SMS ไม่สำเร็จ');
    return { sent: true };
  }
  // dev mode: no SMS provider — code is returned so the flow can be tested. Never use in production.
  return { sent: true, dev_code: code, notice: 'OTP_MODE=dev: แสดงรหัสบนหน้าจอเพื่อทดสอบเท่านั้น' };
}

function verifyOtp(phone, code, purpose = 'register') {
  phone = normPhone(phone);
  const d = db.get();
  const row = d.prepare('SELECT * FROM otp_codes WHERE phone=? AND purpose=? AND consumed=0 AND expires_at>? ORDER BY id DESC LIMIT 1').get(phone, purpose, now());
  if (!row) throw err(400, 'otp_expired', 'รหัสหมดอายุ กรุณาขอรหัสใหม่');
  if (row.attempts >= 5) throw err(429, 'otp_locked', 'ใส่รหัสผิดเกินกำหนด กรุณาขอรหัสใหม่');
  if (row.code_hash !== sha256(phone + ':' + String(code || '').trim())) {
    d.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    throw err(400, 'otp_invalid', 'รหัสยืนยันไม่ถูกต้อง');
  }
  d.prepare('UPDATE otp_codes SET consumed=1 WHERE id=?').run(row.id);
  return phone;
}

// ---- points ledger ----
function addLot(memberId, type, points, { expiresDays, ref_type, ref_id, reason, staff_id, approver_id } = {}) {
  const d = db.get();
  const exp = expiresDays ? now() + expiresDays * 86400e3 : null;
  d.prepare('INSERT INTO point_transactions(member_id,type,points,remaining,expires_at,ref_type,ref_id,reason,staff_id,approver_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(memberId, type, points, points, exp, ref_type || null, ref_id || null, reason || null, staff_id || null, approver_id || null, now());
  d.prepare('UPDATE members SET points=points+? WHERE id=?').run(points, memberId);
}
// Consume points FIFO from non-expired lots. Throws if insufficient.
function consume(memberId, type, points, { ref_type, ref_id, reason, staff_id, approver_id, allowPartial = false } = {}) {
  const d = db.get();
  const lots = d.prepare('SELECT id, remaining FROM point_transactions WHERE member_id=? AND remaining>0 AND (expires_at IS NULL OR expires_at>?) ORDER BY COALESCE(expires_at, 9e15), id').all(memberId, now());
  const avail = lots.reduce((a, l) => a + l.remaining, 0);
  if (avail < points && !allowPartial) throw err(409, 'insufficient_points', `คะแนนไม่พอ (มี ${avail})`);
  let left = Math.min(points, avail);
  const used = left;
  for (const l of lots) { if (!left) break; const take = Math.min(left, l.remaining); d.prepare('UPDATE point_transactions SET remaining=remaining-? WHERE id=?').run(take, l.id); left -= take; }
  d.prepare('INSERT INTO point_transactions(member_id,type,points,remaining,ref_type,ref_id,reason,staff_id,approver_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(memberId, type, -used, 0, ref_type || null, ref_id || null, reason || null, staff_id || null, approver_id || null, now());
  d.prepare('UPDATE members SET points=points-? WHERE id=?').run(used, memberId);
  return used;
}

function expirePoints() {
  const d = db.get();
  const lots = d.prepare('SELECT * FROM point_transactions WHERE remaining>0 AND expires_at IS NOT NULL AND expires_at<=?').all(now());
  d.transaction(() => {
    for (const l of lots) {
      d.prepare('UPDATE point_transactions SET remaining=0 WHERE id=?').run(l.id);
      d.prepare("INSERT INTO point_transactions(member_id,type,points,remaining,ref_type,ref_id,reason,created_at) VALUES(?,?,?,0,'lot',?,?,?)").run(l.member_id, 'expire', -l.remaining, l.id, 'คะแนนหมดอายุ', now());
      d.prepare('UPDATE members SET points=points-? WHERE id=?').run(l.remaining, l.member_id);
    }
  })();
  return lots.length;
}

function recalcTier(memberId) {
  const d = db.get();
  const m = d.prepare('SELECT * FROM members WHERE id=?').get(memberId);
  const lifetime = d.prepare("SELECT COALESCE(SUM(points),0) p FROM point_transactions WHERE member_id=? AND points>0 AND type IN ('earn','bonus_signup','bonus_birthday','adjust')").get(memberId).p;
  const tiers = d.prepare('SELECT * FROM tiers WHERE restaurant_id=? ORDER BY min_spent DESC, min_points DESC, sort DESC').all(m.restaurant_id);
  const t = tiers.find((x) => m.total_spent >= x.min_spent && lifetime >= x.min_points) || tiers[tiers.length - 1];
  if (t && t.id !== m.tier_id) d.prepare('UPDATE members SET tier_id=? WHERE id=?').run(t.id, memberId);
}

function register(input, { branchId, sessionId, verified = false, staffId = null } = {}) {
  const d = db.get();
  const phone = normPhone(input.phone);
  if (!validPhone(phone)) throw err(400, 'invalid_phone', 'เบอร์โทรศัพท์ไม่ถูกต้อง');
  if (!input.first_name || String(input.first_name).trim().length < 1) throw err(400, 'name_required', 'กรุณากรอกชื่อ');
  if (!input.consent) throw err(400, 'consent_required', 'กรุณายอมรับนโยบายความเป็นส่วนตัว');
  if (input.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(input.birthday)) throw err(400, 'invalid_birthday', 'วันเกิดไม่ถูกต้อง');
  if (input.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw err(400, 'invalid_email', 'อีเมลไม่ถูกต้อง');
  const settings = branchSettings(branchId);
  const restaurantId = d.prepare('SELECT restaurant_id FROM branches WHERE id=?').get(branchId).restaurant_id;
  return d.transaction(() => {
    if (d.prepare('SELECT 1 FROM members WHERE phone=?').get(phone)) throw err(409, 'member_exists', 'เบอร์นี้เป็นสมาชิกอยู่แล้ว');
    const code = 'M' + String(db.nextSeq('member')).padStart(6, '0');
    const r = d.prepare('INSERT INTO members(restaurant_id, code, phone, first_name, last_name, birthday, email, extra, consent_at, verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(restaurantId, code, phone, String(input.first_name).trim().slice(0, 60), input.last_name ? String(input.last_name).trim().slice(0, 60) : null, input.birthday || null, input.email || null, JSON.stringify(input.extra || {}), now(), verified ? now() : null, now());
    const id = r.lastInsertRowid;
    if (settings.points.signup_bonus > 0) addLot(id, 'bonus_signup', settings.points.signup_bonus, { expiresDays: settings.points.expiry_days, reason: 'โบนัสสมัครสมาชิกใหม่', staff_id: staffId });
    recalcTier(id);
    if (sessionId) linkToSession(sessionId, id);
    require('../auth').audit({ branch_id: branchId, staff_id: staffId, action: 'member.register', entity: 'member', entity_id: id, data: { session_id: sessionId || null } });
    return d.prepare('SELECT * FROM members WHERE id=?').get(id);
  })();
}

function linkToSession(sessionId, memberId) {
  const d = db.get();
  const s = d.prepare('SELECT * FROM table_sessions WHERE id=?').get(sessionId);
  if (!s || !['active', 'billing'].includes(s.status)) throw err(409, 'session_not_active', 'รอบการใช้โต๊ะปิดแล้ว');
  if (s.member_id && s.member_id !== memberId) throw err(409, 'session_has_member', 'โต๊ะนี้ผูกกับสมาชิกอื่นแล้ว');
  d.prepare('UPDATE table_sessions SET member_id=? WHERE id=?').run(memberId, sessionId);
}

// Earn points after a successful payment (inside the closing transaction)
function earnForBill(bill) {
  if (!bill.member_id || bill.total <= 0) return 0;
  const d = db.get();
  const m = d.prepare('SELECT * FROM members WHERE id=? AND active=1').get(bill.member_id);
  if (!m) return 0;
  const settings = branchSettings(bill.branch_id);
  const tier = m.tier_id ? d.prepare('SELECT * FROM tiers WHERE id=?').get(m.tier_id) : null;
  const per = (tier ? tier.baht_per_point : 50) * 100;
  const pts = Math.floor(Math.floor(bill.total / per) * (tier ? tier.multiplier : 1));
  if (pts > 0) addLot(m.id, 'earn', pts, { expiresDays: settings.points.expiry_days, ref_type: 'bill', ref_id: bill.id, reason: `ยอดใช้จ่าย ${bill.bill_no}` });
  d.prepare('UPDATE members SET total_spent=total_spent+? WHERE id=?').run(bill.total, m.id);
  // Birthday bonus once per year during birthday month
  if (m.birthday && settings.points.birthday_bonus > 0) {
    const lp = localParts(now(), settings.timezone);
    const bm = Number(m.birthday.slice(5, 7));
    if (bm === lp.m && m.birthday_bonus_year !== lp.y) {
      addLot(m.id, 'bonus_birthday', settings.points.birthday_bonus, { expiresDays: settings.points.expiry_days, ref_type: 'bill', ref_id: bill.id, reason: 'โบนัสวันเกิด' });
      d.prepare('UPDATE members SET birthday_bonus_year=? WHERE id=?').run(lp.y, m.id);
    }
  }
  d.prepare('UPDATE bills SET points_earned=? WHERE id=?').run(pts, bill.id);
  recalcTier(m.id);
  return pts;
}

// Reverse points proportionally to a refund (never drives the balance below zero)
function reverseForRefund(bill, refundAmount, staffId, approverId) {
  if (!bill.member_id || !bill.points_earned || !bill.total) return 0;
  const d = db.get();
  const already = d.prepare("SELECT COALESCE(SUM(-points),0) p FROM point_transactions WHERE member_id=? AND type='reverse' AND ref_type='bill' AND ref_id=?").get(bill.member_id, bill.id).p;
  const target = Math.min(bill.points_earned, Math.round(bill.points_earned * (bill.refunded_total + refundAmount) / bill.total));
  const pts = Math.max(0, target - already);
  if (!pts) return 0;
  const used = consume(bill.member_id, 'reverse', pts, { ref_type: 'bill', ref_id: bill.id, reason: `คืนเงิน ${bill.bill_no}`, staff_id: staffId, approver_id: approverId, allowPartial: true });
  d.prepare('UPDATE members SET total_spent=MAX(0,total_spent-?) WHERE id=?').run(refundAmount, bill.member_id);
  recalcTier(bill.member_id);
  return used;
}

function adjustPoints(memberId, delta, reason, staffId, approverId, branchId) {
  const d = db.get();
  const n = parseInt(delta, 10);
  if (!n) throw err(400, 'invalid_points', 'จำนวนคะแนนไม่ถูกต้อง');
  if (!reason || String(reason).trim().length < 3) throw err(400, 'reason_required', 'กรุณาระบุเหตุผล');
  d.transaction(() => {
    if (!d.prepare('SELECT 1 FROM members WHERE id=?').get(memberId)) throw err(404, 'member_not_found', 'ไม่พบสมาชิก');
    if (n > 0) addLot(memberId, 'adjust', n, { expiresDays: branchSettings(branchId).points.expiry_days, reason, staff_id: staffId, approver_id: approverId });
    else consume(memberId, 'adjust', -n, { reason, staff_id: staffId, approver_id: approverId });
    recalcTier(memberId);
    require('../auth').audit({ branch_id: branchId, staff_id: staffId, approver_id: approverId, action: 'points.adjust', entity: 'member', entity_id: memberId, data: { delta: n, reason } });
  })();
  return d.prepare('SELECT * FROM members WHERE id=?').get(memberId);
}

function pointHistory(memberId) {
  return db.get().prepare('SELECT id, type, points, expires_at, ref_type, ref_id, reason, created_at FROM point_transactions WHERE member_id=? ORDER BY id DESC LIMIT 200').all(memberId);
}

// ---- promotions ----
function promoOut(p) {
  return { id: p.id, code: p.code, name: db.J(p.name, {}), description: db.J(p.description, {}), image: p.image_asset_id ? `/media/${p.image_asset_id}` : null, image_asset_id: p.image_asset_id, type: p.type, value: p.value,
    menu_item_id: p.menu_item_id, from_package_id: p.from_package_id, to_package_id: p.to_package_id, points_cost: p.points_cost, members_only: !!p.members_only,
    tier_ids: db.J(p.tier_ids, []), branch_ids: db.J(p.branch_ids, []), days: db.J(p.days, []), time_from: p.time_from, time_to: p.time_to, starts_at: p.starts_at, ends_at: p.ends_at,
    total_quota: p.total_quota, per_member_quota: p.per_member_quota, used_count: p.used_count, min_spend: p.min_spend, priority: p.priority, stackable: !!p.stackable, code_valid_days: p.code_valid_days, active: !!p.active };
}

// Returns null if eligible, otherwise the reason
function promoIneligible(p, member, branchId, at = now()) {
  const d = db.get();
  const settings = branchSettings(branchId);
  const lp = localParts(at, settings.timezone);
  if (!p.active) return 'โปรโมชั่นปิดใช้งาน';
  if (p.starts_at && at < p.starts_at) return 'โปรโมชั่นยังไม่เริ่ม';
  if (p.ends_at && at > p.ends_at) return 'โปรโมชั่นหมดอายุ';
  const branches = db.J(p.branch_ids, []); if (branches.length && !branches.includes(branchId)) return 'ไม่ร่วมรายการในสาขานี้';
  const days = db.J(p.days, []); if (days.length && !days.includes(lp.weekday)) return 'ไม่ร่วมรายการในวันนี้';
  if (p.time_from && p.time_to && !inWindow(lp.minutes, p.time_from, p.time_to)) return `ใช้ได้ช่วง ${p.time_from}-${p.time_to}`;
  if (p.total_quota > 0 && p.used_count >= p.total_quota) return 'สิทธิ์เต็มแล้ว';
  if (p.members_only && !member) return 'เฉพาะสมาชิก';
  if (member) {
    const tiers = db.J(p.tier_ids, []); if (tiers.length && !tiers.includes(member.tier_id)) return 'ระดับสมาชิกไม่ตรงเงื่อนไข';
    if (p.per_member_quota > 0) {
      const used = d.prepare("SELECT COUNT(*) c FROM redemptions WHERE promotion_id=? AND member_id=? AND status IN ('issued','applied','used')").get(p.id, member.id).c;
      if (used >= p.per_member_quota) return 'ใช้สิทธิ์ครบแล้ว';
    }
    if (p.points_cost > member.points) return `คะแนนไม่พอ (ต้องใช้ ${p.points_cost})`;
  }
  return null;
}

function availablePromotions(member, branchId) {
  const d = db.get();
  const rows = d.prepare('SELECT * FROM promotions WHERE active=1 ORDER BY priority DESC, id').all();
  return rows.map((p) => ({ ...promoOut(p), ineligible: promoIneligible(p, member, branchId) }));
}

// Member redeems points for a single-use code
function redeem(memberId, promotionId, branchId, { sessionId, staffId } = {}) {
  const d = db.get();
  return d.transaction(() => {
    const m = d.prepare('SELECT * FROM members WHERE id=? AND active=1').get(memberId);
    if (!m) throw err(404, 'member_not_found', 'ไม่พบสมาชิก');
    const p = d.prepare('SELECT * FROM promotions WHERE id=?').get(promotionId);
    if (!p) throw err(404, 'promotion_not_found', 'ไม่พบโปรโมชั่น');
    const why = promoIneligible(p, m, branchId);
    if (why) throw err(409, 'promotion_ineligible', why);
    const code = 'R' + randomCode(9);
    const r = d.prepare('INSERT INTO redemptions(promotion_id, member_id, code, status, points_spent, expires_at, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(p.id, m.id, code, 'issued', p.points_cost, now() + (p.code_valid_days || 30) * 86400e3, now());
    if (p.points_cost > 0) consume(m.id, 'redeem', p.points_cost, { ref_type: 'redemption', ref_id: r.lastInsertRowid, reason: `แลก ${tr(p.name)}`, staff_id: staffId });
    d.prepare('UPDATE promotions SET used_count=used_count+1 WHERE id=?').run(p.id);
    if (sessionId) applyRedemption(code, sessionId);
    return d.prepare('SELECT * FROM redemptions WHERE id=?').get(r.lastInsertRowid);
  })();
}

// Attach an issued code (member redemption) or a public promo code to a session
function applyRedemption(code, sessionId, { staffId } = {}) {
  const d = db.get();
  code = String(code || '').trim().toUpperCase();
  return d.transaction(() => {
    const s = d.prepare('SELECT * FROM table_sessions WHERE id=?').get(sessionId);
    if (!s || !['active', 'billing'].includes(s.status)) throw err(409, 'session_not_active', 'รอบการใช้โต๊ะปิดแล้ว');
    let r = d.prepare('SELECT * FROM redemptions WHERE code=?').get(code);
    if (!r) {
      // Public (non-member) promotion code
      const p = d.prepare('SELECT * FROM promotions WHERE code=? AND members_only=0 AND points_cost=0').get(code);
      if (!p) throw err(404, 'code_not_found', 'ไม่พบรหัสโปรโมชั่น');
      const member = s.member_id ? d.prepare('SELECT * FROM members WHERE id=?').get(s.member_id) : null;
      const why = promoIneligible(p, member, s.branch_id); if (why) throw err(409, 'promotion_ineligible', why);
      if (d.prepare("SELECT 1 FROM redemptions WHERE promotion_id=? AND session_id=? AND status IN ('applied','used')").get(p.id, s.id)) throw err(409, 'already_applied', 'ใช้โปรโมชั่นนี้กับโต๊ะนี้แล้ว');
      const id = d.prepare("INSERT INTO redemptions(promotion_id, member_id, code, status, session_id, created_at) VALUES(?,?,?,'applied',?,?)").run(p.id, s.member_id || null, 'P' + randomCode(10), s.id, now()).lastInsertRowid;
      d.prepare('UPDATE promotions SET used_count=used_count+1 WHERE id=?').run(p.id);
      return d.prepare('SELECT * FROM redemptions WHERE id=?').get(id);
    }
    if (r.status !== 'issued') throw err(409, 'code_used', r.status === 'applied' ? 'รหัสนี้ถูกใช้กับโต๊ะอื่นอยู่' : 'รหัสนี้ถูกใช้แล้วหรือถูกยกเลิก');
    if (r.expires_at && r.expires_at < now()) { d.prepare("UPDATE redemptions SET status='expired' WHERE id=?").run(r.id); throw err(409, 'code_expired', 'รหัสหมดอายุ'); }
    if (r.member_id && s.member_id && r.member_id !== s.member_id) throw err(409, 'member_mismatch', 'รหัสนี้เป็นของสมาชิกคนอื่น');
    if (r.member_id && !s.member_id) d.prepare('UPDATE table_sessions SET member_id=? WHERE id=?').run(r.member_id, s.id);
    const p = d.prepare('SELECT * FROM promotions WHERE id=?').get(r.promotion_id);
    if (p.type === 'package_upgrade') {
      const g = d.prepare('SELECT * FROM session_guests WHERE session_id=? AND package_id=? AND active=1 ORDER BY id LIMIT 1').get(s.id, p.from_package_id);
      if (!g) throw err(409, 'upgrade_not_applicable', 'ไม่มีลูกค้าในแพ็กเกจที่อัปเกรดได้');
      const price = require('./pricing').matchPrice(p.to_package_id, { code: g.price_code });
      if (!price) throw err(409, 'upgrade_not_applicable', 'แพ็กเกจปลายทางไม่มีราคาสำหรับลูกค้าประเภทนี้');
      d.prepare('UPDATE session_guests SET package_id=?, price_id=?, unit_price=? WHERE id=?').run(p.to_package_id, price.id, price.price, g.id);
    }
    d.prepare("UPDATE redemptions SET status='applied', session_id=? WHERE id=?").run(s.id, r.id);
    return d.prepare('SELECT * FROM redemptions WHERE id=?').get(r.id);
  })();
}

function unapplyRedemption(redemptionId, sessionId) {
  const d = db.get();
  d.transaction(() => {
    const r = d.prepare("SELECT r.*, p.type, p.from_package_id, p.to_package_id, p.members_only FROM redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE r.id=? AND r.session_id=? AND r.status='applied'").get(redemptionId, sessionId);
    if (!r) throw err(404, 'redemption_not_found', 'ไม่พบรายการ');
    if (r.type === 'package_upgrade') {
      const g = d.prepare('SELECT * FROM session_guests WHERE session_id=? AND package_id=? AND active=1 ORDER BY id DESC LIMIT 1').get(sessionId, r.to_package_id);
      if (g) { const price = require('./pricing').matchPrice(r.from_package_id, { code: g.price_code }); d.prepare('UPDATE session_guests SET package_id=?, price_id=?, unit_price=? WHERE id=?').run(r.from_package_id, price.id, price.price, g.id); }
    }
    if (r.member_id && r.code.startsWith('R')) d.prepare("UPDATE redemptions SET status='issued', session_id=NULL WHERE id=?").run(r.id);
    else { d.prepare("UPDATE redemptions SET status='cancelled', cancelled_at=? WHERE id=?").run(now(), r.id); d.prepare('UPDATE promotions SET used_count=MAX(0,used_count-1) WHERE id=?').run(r.promotion_id); }
  })();
}

// Cancel an issued (not yet used) code and return the points
function cancelRedemption(redemptionId, { staffId, branchId } = {}) {
  const d = db.get();
  return d.transaction(() => {
    const r = d.prepare('SELECT * FROM redemptions WHERE id=?').get(redemptionId);
    if (!r) throw err(404, 'redemption_not_found', 'ไม่พบรายการ');
    if (r.status !== 'issued') throw err(409, 'cannot_cancel', 'ยกเลิกได้เฉพาะสิทธิ์ที่ยังไม่ได้ใช้');
    d.prepare("UPDATE redemptions SET status='cancelled', cancelled_at=? WHERE id=?").run(now(), r.id);
    d.prepare('UPDATE promotions SET used_count=MAX(0,used_count-1) WHERE id=?').run(r.promotion_id);
    if (r.points_spent > 0 && r.member_id) addLot(r.member_id, 'redeem_refund', r.points_spent, { expiresDays: branchSettings(branchId).points.expiry_days, ref_type: 'redemption', ref_id: r.id, reason: 'คืนคะแนนจากการยกเลิกสิทธิ์', staff_id: staffId });
    return d.prepare('SELECT * FROM redemptions WHERE id=?').get(r.id);
  })();
}

module.exports = { normPhone, validPhone, memberOut, findMember, requestOtp, verifyOtp, register, linkToSession, earnForBill, reverseForRefund, adjustPoints, pointHistory, expirePoints, recalcTier, addLot, consume,
  promoOut, promoIneligible, availablePromotions, redeem, applyRedemption, unapplyRedemption, cancelRedemption };
