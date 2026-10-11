'use strict';
// Table sessions: one QR token per seating. Opening, resolving customer tokens, moving, merging,
// splitting, extending, changing packages and regenerating QR codes.
const db = require('../db');
const { err, now, randomToken, sha256, encrypt, decrypt, tr } = require('../lib/util');
const { branchSettings } = require('./settings');
const pricing = require('./pricing');
const rt = require('../realtime');
const config = require('../config');

const ACTIVE = ['active', 'billing'];

function guestLabel(i) {
  let s = ''; i++;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function orderUrl(token, req) {
  const base = config.publicUrl || (req ? `${req.protocol}://${req.get('host')}` : require('../lib/baseurl').get());
  return `${base}/t/${token}`;
}

// Derived status shown on floor plans
function displayStatus(table, session, at = now()) {
  if (!session || !ACTIVE.includes(session.status)) return table.status; // available | cleaning | disabled | reserved
  if (session.status === 'billing') return 'payment_pending';
  if (at >= session.end_at) return 'time_up';
  if (session.end_at - at <= 15 * 60000) return 'near_end';
  if (session.last_order_at) return 'dining';
  return 'occupied';
}

function getSession(id) {
  const s = db.get().prepare('SELECT * FROM table_sessions WHERE id=?').get(id);
  if (!s) throw err(404, 'session_not_found', 'ไม่พบรอบการใช้โต๊ะ');
  return s;
}

function sessionDetail(id, { includeToken = false, req } = {}) {
  const d = db.get();
  const s = getSession(id);
  const table = d.prepare('SELECT * FROM tables WHERE id=?').get(s.table_id);
  const guests = d.prepare(`SELECT g.id, g.label, g.display_name, g.package_id, g.price_code, g.unit_price, p.name package_name, p.code package_code, p.color package_color, pp.label price_label
     FROM session_guests g JOIN buffet_packages p ON p.id=g.package_id LEFT JOIN package_prices pp ON pp.id=g.price_id WHERE g.session_id=? AND g.active=1 ORDER BY g.id`).all(id)
    .map((g) => ({ ...g, package_name: db.J(g.package_name, {}), price_label: db.J(g.price_label, {}) }));
  const member = s.member_id ? d.prepare('SELECT m.id, m.code, m.phone, m.first_name, m.last_name, m.points, t.name tier_name FROM members m LEFT JOIN tiers t ON t.id=m.tier_id WHERE m.id=?').get(s.member_id) : null;
  if (member) { member.tier_name = db.J(member.tier_name, {}); member.phone = maskPhone(member.phone); }
  const out = {
    id: s.id, public_code: s.public_code, status: s.status, branch_id: s.branch_id,
    table: { id: table.id, code: table.code }, display_status: displayStatus(table, s),
    start_at: s.start_at, end_at: s.end_at, order_end_at: s.order_end_at, duration_min: s.duration_min,
    contact_name: s.contact_name, guests_count: guests.length, guests, member,
    manual_discount: db.J(s.manual_discount, null), adjustments: db.J(s.adjustments, []),
    opened_at: s.opened_at, closed_at: s.closed_at, merged_into: s.merged_into, token_version: s.token_version,
  };
  if (includeToken && ACTIVE.includes(s.status)) {
    const token = decrypt(s.token_enc);
    out.token = token; out.order_url = orderUrl(token, req);
  }
  return out;
}
const maskPhone = (p) => (p ? String(p).replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2') : p);

function newToken() { const token = randomToken(24); return { token, hash: sha256(token), enc: encrypt(token) }; }

function nextPublicCode(branchId) {
  const n = db.nextSeq(`session:${branchId}`);
  return `BF${String(n).padStart(5, '0')}`;
}

function buildGuests(branchId, groups, settings) {
  const d = db.get();
  if (!Array.isArray(groups) || !groups.length) throw err(400, 'guests_required', 'กรุณาระบุจำนวนลูกค้าและแพ็กเกจ');
  const guests = [];
  const pkgIds = new Set();
  for (const g of groups) {
    const count = parseInt(g.count, 10);
    if (!(count > 0)) continue;
    if (count > 200) throw err(400, 'too_many_guests', 'จำนวนลูกค้ามากเกินไป');
    const pkg = d.prepare('SELECT * FROM buffet_packages WHERE id=? AND (branch_id IS NULL OR branch_id=?)').get(g.package_id, branchId);
    if (!pkg) throw err(400, 'invalid_package', 'ไม่พบแพ็กเกจ');
    const reason = pricing.packageSellable(pkg, branchId);
    if (reason) throw err(400, 'package_unavailable', reason);
    const price = g.price_code ? pricing.matchPrice(pkg.id, { code: g.price_code }) : pricing.matchPrice(pkg.id, { age: g.age, height: g.height });
    if (!price) throw err(400, 'no_price', `แพ็กเกจ ${pkg.code} ยังไม่ได้ตั้งราคา`);
    pkgIds.add(pkg.id);
    for (let i = 0; i < count; i++) guests.push({ pkg, price });
  }
  if (!guests.length) throw err(400, 'guests_required', 'กรุณาระบุจำนวนลูกค้า');
  if (pkgIds.size > 1 && !settings.allow_mixed_packages) throw err(400, 'mixed_packages_disabled', 'ร้านไม่อนุญาตให้เลือกหลายแพ็กเกจในโต๊ะเดียว');
  return guests;
}

function insertGuests(sessionId, guests, startIndex = 0, displayNames = []) {
  const ins = db.get().prepare('INSERT INTO session_guests(session_id,label,display_name,package_id,price_id,price_code,unit_price) VALUES(?,?,?,?,?,?,?)');
  guests.forEach((g, i) => ins.run(sessionId, guestLabel(startIndex + i), displayNames[i] || null, g.pkg.id, g.price.id, g.price.code, g.price.price));
}

/**
 * Open a table. input: {table_id, groups:[{package_id, price_code, count}], member_id?, contact_name?, start_at?, duration_min?}
 */
function openTable(req, input) {
  const d = db.get();
  const branchId = req.branchId;
  const settings = branchSettings(branchId);
  const table = d.prepare('SELECT * FROM tables WHERE id=? AND branch_id=?').get(input.table_id, branchId);
  if (!table) throw err(404, 'table_not_found', 'ไม่พบโต๊ะ');
  if (table.status === 'disabled') throw err(409, 'table_disabled', 'โต๊ะนี้ปิดใช้งาน');
  if (table.current_session_id) {
    const cur = d.prepare('SELECT status FROM table_sessions WHERE id=?').get(table.current_session_id);
    if (cur && ACTIVE.includes(cur.status)) throw err(409, 'table_occupied', 'โต๊ะนี้มีลูกค้าอยู่แล้ว');
  }
  if (table.status === 'cleaning' && !input.force) throw err(409, 'table_cleaning', 'โต๊ะรอทำความสะอาด');
  const guests = buildGuests(branchId, input.groups, settings);
  let memberId = null;
  if (input.member_id) {
    const m = d.prepare('SELECT id FROM members WHERE id=? AND active=1').get(input.member_id);
    if (!m) throw err(400, 'invalid_member', 'ไม่พบสมาชิก');
    memberId = m.id;
  }
  const start = input.start_at ? Math.min(Number(input.start_at), now() + 3600e3) : now();
  const pkgMax = Math.max(...guests.map((g) => g.pkg.duration_min));
  const duration = input.duration_min ? Math.max(15, Math.min(24 * 60, parseInt(input.duration_min, 10))) : pkgMax;
  const cutoff = Math.max(...guests.map((g) => g.pkg.order_cutoff_min || 0));
  const end = start + duration * 60000;
  const tok = newToken();
  const result = d.transaction(() => {
    const r = d.prepare(`INSERT INTO table_sessions(branch_id, table_id, public_code, token_hash, token_enc, status, start_at, end_at, order_end_at, duration_min, contact_name, member_id, guests_count, opened_by, opened_at)
      VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`).run(branchId, table.id, nextPublicCode(branchId), tok.hash, tok.enc, start, end, end - cutoff * 60000, duration,
      input.contact_name ? String(input.contact_name).slice(0, 80) : null, memberId, guests.length, req.staff.id, now());
    const sid = r.lastInsertRowid;
    insertGuests(sid, guests);
    d.prepare("UPDATE tables SET status='occupied', current_session_id=?, reserved_note=NULL WHERE id=?").run(sid, table.id);
    require('../auth').auditReq(req, 'table.open', 'table_session', sid, { table: table.code, guests: guests.length, packages: [...new Set(guests.map((g) => g.pkg.code))], member_id: memberId });
    return sid;
  })();
  const detail = sessionDetail(result, { includeToken: true, req });
  detail.bill_preview = pricing.computeBill(result);
  // Printing: QR ticket + member sign-up slip for non-members
  const printing = require('./printing');
  detail.print_jobs = [];
  if (input.print !== false) {
    detail.print_jobs.push(...printing.enqueueDoc(branchId, 'qr_ticket', result, { auto: true }));
    if (!memberId && settings.member_signup_slip && input.print_member_slip !== false) detail.print_jobs.push(...printing.enqueueDoc(branchId, 'member_signup', result, { auto: true }));
  }
  rt.toStaff(branchId, 'tables:changed', { table_id: table.id });
  return detail;
}

// Resolve a customer QR token → active session. Merged sessions follow to their target.
function resolveCustomerToken(token, { allowClosed = false } = {}) {
  if (!token || typeof token !== 'string' || token.length > 100) throw err(404, 'invalid_token', 'QR Code ไม่ถูกต้อง');
  const d = db.get();
  let s = d.prepare('SELECT * FROM table_sessions WHERE token_hash=?').get(sha256(token));
  if (!s) throw err(404, 'invalid_token', 'QR Code ไม่ถูกต้องหรือถูกยกเลิกแล้ว');
  let hops = 0;
  while (s.status === 'merged' && s.merged_into && hops++ < 5) s = d.prepare('SELECT * FROM table_sessions WHERE id=?').get(s.merged_into);
  if (!ACTIVE.includes(s.status) && !allowClosed) throw err(410, 'session_ended', 'โต๊ะนี้สิ้นสุดการให้บริการแล้ว');
  return s;
}

function assertActive(s) { if (!ACTIVE.includes(s.status)) throw err(409, 'session_not_active', 'รอบการใช้โต๊ะนี้ปิดแล้ว'); }

function regenerateQr(req, sessionId) {
  const d = db.get();
  const s = getSession(sessionId); assertActive(s);
  if (s.branch_id !== req.branchId) throw err(404, 'session_not_found', 'ไม่พบรอบการใช้โต๊ะ');
  const tok = newToken();
  d.prepare('UPDATE table_sessions SET token_hash=?, token_enc=?, token_version=token_version+1 WHERE id=?').run(tok.hash, tok.enc, s.id);
  require('../auth').auditReq(req, 'table.qr_regenerate', 'table_session', s.id, { old_version: s.token_version });
  rt.toSession(s.id, 'session:revoked', { reason: 'qr_regenerated' });
  rt.kickSession(s.id);
  const jobs = require('./printing').enqueueDoc(s.branch_id, 'qr_ticket', s.id, { auto: false });
  return { ...sessionDetail(s.id, { includeToken: true, req }), print_jobs: jobs };
}

function extend(req, sessionId, minutes) {
  const m = parseInt(minutes, 10);
  if (!(m > 0 && m <= 600)) throw err(400, 'invalid_minutes', 'จำนวนนาทีไม่ถูกต้อง');
  const s = getSession(sessionId); assertActive(s);
  db.get().prepare("UPDATE table_sessions SET end_at=end_at+?, order_end_at=order_end_at+?, duration_min=duration_min+?, alerts_sent='[]' WHERE id=?").run(m * 60000, m * 60000, m, s.id);
  require('../auth').auditReq(req, 'table.extend', 'table_session', s.id, { minutes: m });
  notifySession(s.id);
  return sessionDetail(s.id);
}

function moveTable(req, sessionId, toTableId) {
  const d = db.get();
  const s = getSession(sessionId); assertActive(s);
  const to = d.prepare('SELECT * FROM tables WHERE id=? AND branch_id=?').get(toTableId, s.branch_id);
  if (!to) throw err(404, 'table_not_found', 'ไม่พบโต๊ะปลายทาง');
  if (to.current_session_id) { const c = d.prepare('SELECT status FROM table_sessions WHERE id=?').get(to.current_session_id); if (c && ACTIVE.includes(c.status)) throw err(409, 'table_occupied', 'โต๊ะปลายทางมีลูกค้าอยู่ (ใช้การรวมโต๊ะแทน)'); }
  if (['disabled'].includes(to.status)) throw err(409, 'table_disabled', 'โต๊ะปลายทางปิดใช้งาน');
  const settings = branchSettings(s.branch_id);
  d.transaction(() => {
    d.prepare('UPDATE tables SET status=?, current_session_id=NULL WHERE id=?').run(settings.after_payment_table_status === 'available' ? 'available' : 'cleaning', s.table_id);
    d.prepare("UPDATE tables SET status='occupied', current_session_id=? WHERE id=?").run(s.id, to.id);
    d.prepare('UPDATE table_sessions SET table_id=? WHERE id=?').run(to.id, s.id);
    d.prepare("UPDATE staff_calls SET table_id=? WHERE session_id=? AND status IN ('pending','accepted','in_progress')").run(to.id, s.id);
    require('../auth').auditReq(req, 'table.move', 'table_session', s.id, { from: s.table_id, to: to.id });
  })();
  notifySession(s.id);
  return sessionDetail(s.id);
}

// Merge session `fromId` into `intoId`: guests, orders, calls move; the source QR keeps working by following merged_into.
function mergeSessions(req, intoId, fromId) {
  const d = db.get();
  if (Number(intoId) === Number(fromId)) throw err(400, 'same_session', 'ไม่สามารถรวมโต๊ะเดียวกัน');
  const into = getSession(intoId), from = getSession(fromId);
  assertActive(into); assertActive(from);
  if (into.branch_id !== from.branch_id || into.branch_id !== req.branchId) throw err(400, 'branch_mismatch', 'ต่างสาขา');
  if (from.member_id && into.member_id && from.member_id !== into.member_id) throw err(409, 'member_conflict', 'ทั้งสองโต๊ะผูกสมาชิกคนละคน');
  const settings = branchSettings(into.branch_id);
  d.transaction(() => {
    const count = d.prepare('SELECT COUNT(*) c FROM session_guests WHERE session_id=?').get(into.id).c;
    const fg = d.prepare('SELECT id FROM session_guests WHERE session_id=? ORDER BY id').all(from.id);
    const relabel = d.prepare('UPDATE session_guests SET session_id=?, label=? WHERE id=?');
    const labelMap = {};
    const oldLabels = d.prepare('SELECT id,label FROM session_guests WHERE session_id=? ORDER BY id').all(from.id);
    fg.forEach((g, i) => { const nl = guestLabel(count + i); labelMap[oldLabels[i].label] = nl; relabel.run(into.id, nl, g.id); });
    // two-phase relabel so that e.g. A→B, B→C don't collide
    for (const [o, n] of Object.entries(labelMap)) {
      d.prepare('UPDATE order_items SET guest_label=? WHERE session_id=? AND guest_label=?').run('~' + n, from.id, o);
      d.prepare('UPDATE orders SET guest_label=? WHERE session_id=? AND guest_label=?').run('~' + n, from.id, o);
    }
    d.prepare("UPDATE order_items SET guest_label=substr(guest_label,2) WHERE session_id=? AND guest_label LIKE '~%'").run(from.id);
    d.prepare("UPDATE orders SET guest_label=substr(guest_label,2) WHERE session_id=? AND guest_label LIKE '~%'").run(from.id);
    d.prepare('UPDATE orders SET session_id=? WHERE session_id=?').run(into.id, from.id);
    d.prepare('UPDATE order_items SET session_id=? WHERE session_id=?').run(into.id, from.id);
    d.prepare('UPDATE kitchen_tickets SET session_id=? WHERE session_id=?').run(into.id, from.id);
    d.prepare('UPDATE staff_calls SET session_id=?, table_id=? WHERE session_id=?').run(into.id, into.table_id, from.id);
    d.prepare('UPDATE redemptions SET session_id=? WHERE session_id=? AND status=\'applied\'').run(into.id, from.id);
    const gc = d.prepare('SELECT COUNT(*) c FROM session_guests WHERE session_id=? AND active=1').get(into.id).c;
    d.prepare('UPDATE table_sessions SET guests_count=?, end_at=MAX(end_at,?), order_end_at=MAX(order_end_at,?), member_id=COALESCE(member_id,?) WHERE id=?').run(gc, from.end_at, from.order_end_at, from.member_id, into.id);
    d.prepare("UPDATE table_sessions SET status='merged', merged_into=?, closed_at=?, closed_by=? WHERE id=?").run(into.id, now(), req.staff.id, from.id);
    d.prepare('UPDATE tables SET status=?, current_session_id=NULL WHERE id=?').run(settings.after_payment_table_status === 'available' ? 'available' : 'cleaning', from.table_id);
    require('../auth').auditReq(req, 'table.merge', 'table_session', into.id, { from_session: from.id, from_table: from.table_id });
  })();
  rt.toSession(from.id, 'session:merged', { into: into.public_code });
  notifySession(into.id);
  return sessionDetail(into.id);
}

// Split guests (by label) of a session onto another free table → new session + new QR
function splitSession(req, sessionId, labels, toTableId) {
  const d = db.get();
  const s = getSession(sessionId); assertActive(s);
  if (!Array.isArray(labels) || !labels.length) throw err(400, 'labels_required', 'เลือกลูกค้าที่จะแยกโต๊ะ');
  const all = d.prepare('SELECT * FROM session_guests WHERE session_id=? AND active=1 ORDER BY id').all(s.id);
  const moving = all.filter((g) => labels.includes(g.label));
  if (!moving.length || moving.length >= all.length) throw err(400, 'invalid_split', 'ต้องเหลือลูกค้าอย่างน้อย 1 คนในโต๊ะเดิม');
  const to = d.prepare('SELECT * FROM tables WHERE id=? AND branch_id=?').get(toTableId, s.branch_id);
  if (!to) throw err(404, 'table_not_found', 'ไม่พบโต๊ะปลายทาง');
  if (to.current_session_id) { const c = d.prepare('SELECT status FROM table_sessions WHERE id=?').get(to.current_session_id); if (c && ACTIVE.includes(c.status)) throw err(409, 'table_occupied', 'โต๊ะปลายทางมีลูกค้าอยู่'); }
  const tok = newToken();
  const newId = d.transaction(() => {
    const r = d.prepare(`INSERT INTO table_sessions(branch_id, table_id, public_code, token_hash, token_enc, status, start_at, end_at, order_end_at, duration_min, contact_name, guests_count, opened_by, opened_at, last_order_at)
      VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`).run(s.branch_id, to.id, nextPublicCode(s.branch_id), tok.hash, tok.enc, s.start_at, s.end_at, s.order_end_at, s.duration_min, null, moving.length, req.staff.id, now(), s.last_order_at);
    const nid = r.lastInsertRowid;
    moving.forEach((g, i) => {
      const nl = guestLabel(i);
      d.prepare('UPDATE session_guests SET session_id=?, label=? WHERE id=?').run(nid, nl, g.id);
      d.prepare('UPDATE order_items SET session_id=?, guest_label=? WHERE session_id=? AND guest_label=?').run(nid, nl, s.id, g.label);
    });
    d.prepare('UPDATE table_sessions SET guests_count=? WHERE id=?').run(all.length - moving.length, s.id);
    d.prepare("UPDATE tables SET status='occupied', current_session_id=? WHERE id=?").run(nid, to.id);
    require('../auth').auditReq(req, 'table.split', 'table_session', s.id, { new_session: nid, labels, to_table: to.id });
    return nid;
  })();
  const jobs = require('./printing').enqueueDoc(s.branch_id, 'qr_ticket', newId, { auto: true });
  notifySession(s.id); notifySession(newId);
  return { from: sessionDetail(s.id), to: { ...sessionDetail(newId, { includeToken: true, req }), print_jobs: jobs } };
}

// Add guests or change packages. changes: {add:[{package_id, price_code, count}], change:[{label, package_id, price_code}], remove:[label]}
function changeGuests(req, sessionId, changes) {
  const d = db.get();
  const s = getSession(sessionId); assertActive(s);
  const settings = branchSettings(s.branch_id);
  d.transaction(() => {
    if (Array.isArray(changes.change)) for (const c of changes.change) {
      const g = d.prepare('SELECT * FROM session_guests WHERE session_id=? AND label=? AND active=1').get(s.id, c.label);
      if (!g) throw err(404, 'guest_not_found', `ไม่พบลูกค้า ${c.label}`);
      const [ng] = buildGuests(s.branch_id, [{ package_id: c.package_id || g.package_id, price_code: c.price_code || g.price_code, count: 1 }], { ...settings, allow_mixed_packages: true });
      d.prepare('UPDATE session_guests SET package_id=?, price_id=?, price_code=?, unit_price=? WHERE id=?').run(ng.pkg.id, ng.price.id, ng.price.code, ng.price.price, g.id);
    }
    if (Array.isArray(changes.remove) && changes.remove.length) {
      const ordered = d.prepare(`SELECT COUNT(*) c FROM order_items WHERE session_id=? AND guest_label IN (${changes.remove.map(() => '?').join(',')}) AND status NOT IN ('cancelled','unavailable')`).get(s.id, ...changes.remove).c;
      if (ordered) throw err(409, 'guest_has_orders', 'ลูกค้าที่มีรายการอาหารแล้วไม่สามารถลบได้');
      for (const l of changes.remove) d.prepare('UPDATE session_guests SET active=0 WHERE session_id=? AND label=?').run(s.id, l);
    }
    if (Array.isArray(changes.add) && changes.add.length) {
      const guests = buildGuests(s.branch_id, changes.add, settings);
      const count = d.prepare('SELECT COUNT(*) c FROM session_guests WHERE session_id=?').get(s.id).c;
      insertGuests(s.id, guests, count);
    }
    const active = d.prepare('SELECT COUNT(*) c FROM session_guests WHERE session_id=? AND active=1').get(s.id).c;
    if (!active) throw err(400, 'no_guests', 'ต้องมีลูกค้าอย่างน้อย 1 คน');
    const pk = d.prepare('SELECT MAX(p.order_cutoff_min) cutoff FROM session_guests g JOIN buffet_packages p ON p.id=g.package_id WHERE g.session_id=? AND g.active=1').get(s.id);
    d.prepare('UPDATE table_sessions SET guests_count=?, order_end_at=end_at-? WHERE id=?').run(active, (pk.cutoff || 0) * 60000, s.id);
    require('../auth').auditReq(req, 'table.guests_change', 'table_session', s.id, changes);
  })();
  notifySession(s.id);
  return sessionDetail(s.id);
}

function setGuestName(sessionId, label, name) {
  db.get().prepare('UPDATE session_guests SET display_name=? WHERE session_id=? AND label=? AND active=1').run(name ? String(name).slice(0, 40) : null, sessionId, label);
}

function notifySession(sessionId) {
  const s = getSession(sessionId);
  rt.toSession(s.id, 'session:updated', {});
  rt.toStaff(s.branch_id, 'tables:changed', { table_id: s.table_id, session_id: s.id });
}

module.exports = { ACTIVE, guestLabel, displayStatus, getSession, sessionDetail, openTable, resolveCustomerToken, regenerateQr, extend, moveTable, mergeSessions, splitSession, changeGuests, setGuestName, notifySession, orderUrl, assertActive, maskPhone };
