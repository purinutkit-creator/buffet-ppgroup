'use strict';
// POS / cashier / waiter API (staff token required). Permission checks per action.
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const { err, now, tr } = require('../lib/util');
const auth = require('../auth');
const sessions = require('../services/sessions');
const orders = require('../services/orders');
const calls = require('../services/calls');
const pricing = require('../services/pricing');
const payments = require('../services/payments');
const members = require('../services/members');
const printing = require('../services/printing');
const menu = require('../services/menu');
const rt = require('../realtime');
const { branchSettings } = require('../services/settings');

const r = express.Router();
const P = auth.requireStaff;

function ownSession(req) {
  const s = sessions.getSession(Number(req.params.id));
  if (s.branch_id !== req.branchId) throw err(404, 'session_not_found', 'ไม่พบรอบการใช้โต๊ะ');
  return s;
}

function tablesView(branchId) {
  const d = db.get();
  const t = now();
  const zones = d.prepare('SELECT * FROM zones WHERE branch_id=? ORDER BY sort, id').all(branchId);
  const tables = d.prepare('SELECT * FROM tables WHERE branch_id=? ORDER BY zone_id, code').all(branchId).map((tb) => {
    const s = tb.current_session_id ? d.prepare('SELECT * FROM table_sessions WHERE id=?').get(tb.current_session_id) : null;
    const active = s && sessions.ACTIVE.includes(s.status) ? s : null;
    const pendingCalls = active ? d.prepare("SELECT COUNT(*) c FROM staff_calls WHERE session_id=? AND status IN ('pending','accepted','in_progress')").get(active.id).c : 0;
    return { ...tb, display_status: sessions.displayStatus(tb, active, t), session: active ? { id: active.id, public_code: active.public_code, status: active.status, start_at: active.start_at, end_at: active.end_at, order_end_at: active.order_end_at, guests_count: active.guests_count, member_id: active.member_id, contact_name: active.contact_name, pending_calls: pendingCalls } : null };
  });
  return { zones, tables, server_time: t };
}

r.get('/bootstrap', P(), (req, res) => {
  const d = db.get();
  const b = req.branchId;
  const pkgs = d.prepare('SELECT * FROM buffet_packages WHERE (branch_id IS NULL OR branch_id=?) ORDER BY sort, id').all(b).map((p) => ({
    id: p.id, code: p.code, name: db.J(p.name, {}), color: p.color, duration_min: p.duration_min, active: !!p.active, sellable: !pricing.packageSellable(p, b), unavailable_reason: pricing.packageSellable(p, b),
    prices: pricing.packagePrices(p.id).map((x) => ({ id: x.id, code: x.code, label: x.label, price: x.price, rule_type: x.rule_type, min_value: x.min_value, max_value: x.max_value, is_default: !!x.is_default })),
  }));
  const branch = d.prepare('SELECT id, code, name FROM branches WHERE id=?').get(b);
  res.json({
    staff: auth.publicStaff(req.staff), branch: { ...branch, name: db.J(branch.name, {}) }, branches: d.prepare('SELECT id, code, name FROM branches WHERE active=1').all().filter((x) => auth.canAccessBranch(req.staff, x.id)).map((x) => ({ ...x, name: db.J(x.name, {}) })),
    settings: branchSettings(b), packages: pkgs, ...tablesView(b),
    payment_methods: d.prepare('SELECT id, code, name, type, config FROM payment_methods WHERE active=1 AND (branch_id IS NULL OR branch_id=?) ORDER BY sort, id').all(b).map((m) => ({ ...m, config: m.type === 'promptpay' ? { has_promptpay: !!db.J(m.config, {}).promptpay_id } : {} })),
    call_types: calls.callTypes(b), stations: d.prepare('SELECT id, code, name, color FROM kitchen_stations WHERE branch_id=? AND active=1 ORDER BY sort').all(b),
    print_routes: printing.routes(b),
  });
});

r.get('/tables', P(), (req, res) => res.json(tablesView(req.branchId)));

r.post('/tables/:id/status', P('table.open', 'table.close'), (req, res) => {
  const st = String(req.body.status);
  if (!['available', 'cleaning', 'disabled', 'reserved'].includes(st)) throw err(400, 'invalid_status', 'สถานะไม่ถูกต้อง');
  const d = db.get();
  const t = d.prepare('SELECT * FROM tables WHERE id=? AND branch_id=?').get(req.params.id, req.branchId);
  if (!t) throw err(404, 'table_not_found', 'ไม่พบโต๊ะ');
  if (t.current_session_id) { const s = d.prepare('SELECT status FROM table_sessions WHERE id=?').get(t.current_session_id); if (s && sessions.ACTIVE.includes(s.status)) throw err(409, 'table_occupied', 'โต๊ะมีลูกค้าอยู่'); }
  d.prepare('UPDATE tables SET status=?, reserved_note=?, current_session_id=NULL WHERE id=?').run(st, st === 'reserved' ? String(req.body.note || '').slice(0, 120) : null, t.id);
  auth.auditReq(req, 'table.status', 'table', t.id, { from: t.status, to: st, note: req.body.note });
  rt.toStaff(req.branchId, 'tables:changed', { table_id: t.id });
  res.json({ ok: true });
});

// ---- sessions ----
r.post('/sessions', P('table.open'), (req, res) => {
  baseurl(req);
  res.status(201).json(sessions.openTable(req, req.body || {}));
});
function baseurl(req) { require('../lib/baseurl').remember(req); }

r.get('/sessions/:id', P(), (req, res) => {
  const s = ownSession(req);
  const showToken = auth.has(req.staff, 'table.qr') || auth.has(req.staff, 'table.open');
  const d = db.get();
  const detail = sessions.sessionDetail(s.id, { includeToken: showToken, req });
  detail.orders = orders.sessionOrders(s.id);
  detail.bill = sessions.ACTIVE.includes(s.status) ? pricing.computeBill(s.id) : null;
  detail.bills = payments.sessionBills(s.id);
  detail.calls = calls.sessionCalls(s.id);
  detail.redemptions = d.prepare('SELECT r.id, r.code, r.status, p.name, p.type FROM redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE r.session_id=?').all(s.id).map((x) => ({ ...x, name: db.J(x.name, {}) }));
  detail.print_jobs = d.prepare('SELECT * FROM print_jobs WHERE branch_id=? AND ((doc_type IN (\'qr_ticket\',\'member_signup\',\'close_summary\') AND ref_id=?) OR (doc_type=\'kitchen\' AND ref_id IN (SELECT id FROM kitchen_tickets WHERE session_id=?)) OR (doc_type IN (\'receipt\',\'tax_invoice\') AND ref_id IN (SELECT id FROM bills WHERE session_id=?))) ORDER BY id DESC LIMIT 30').all(s.branch_id, s.id, s.id, s.id).map(printing.jobOut);
  res.json(detail);
});

r.post('/sessions/:id/extend', P('table.extend'), (req, res) => { ownSession(req); res.json(sessions.extend(req, req.params.id, req.body.minutes)); });
r.post('/sessions/:id/move', P('table.move'), (req, res) => { ownSession(req); res.json(sessions.moveTable(req, Number(req.params.id), Number(req.body.table_id))); });
r.post('/sessions/:id/merge', P('table.move'), (req, res) => { ownSession(req); res.json(sessions.mergeSessions(req, Number(req.params.id), Number(req.body.from_session_id))); });
r.post('/sessions/:id/split', P('table.move'), (req, res) => { ownSession(req); baseurl(req); res.json(sessions.splitSession(req, Number(req.params.id), req.body.labels, Number(req.body.table_id))); });
r.post('/sessions/:id/guests', P('table.package'), (req, res) => { ownSession(req); res.json(sessions.changeGuests(req, Number(req.params.id), req.body || {})); });
r.post('/sessions/:id/qr/regenerate', P('table.qr'), (req, res) => { ownSession(req); baseurl(req); res.json(sessions.regenerateQr(req, Number(req.params.id))); });
r.get('/sessions/:id/qr.png', P('table.qr', 'table.open'), async (req, res) => {
  const d = sessions.sessionDetail(ownSession(req).id, { includeToken: true, req });
  if (!d.order_url) throw err(410, 'session_ended', 'โต๊ะปิดแล้ว');
  res.type('png').set('Cache-Control', 'no-store').send(await QRCode.toBuffer(d.order_url, { width: 480, margin: 1 }));
});
r.post('/sessions/:id/print', P('table.qr', 'table.close'), (req, res) => {
  const s = ownSession(req);
  const doc = String(req.body.doc || 'qr_ticket');
  if (!['qr_ticket', 'member_signup', 'close_summary'].includes(doc)) throw err(400, 'invalid_doc', 'เอกสารไม่ถูกต้อง');
  baseurl(req);
  const jobs = printing.enqueueDoc(s.branch_id, doc, s.id, { printerId: req.body.printer_id ? Number(req.body.printer_id) : undefined });
  auth.auditReq(req, 'print.manual', 'table_session', s.id, { doc });
  res.json({ jobs });
});

r.post('/sessions/:id/orders', P('order.create'), (req, res) => {
  const s = ownSession(req);
  const out = orders.placeOrder(s.id, req.body || {}, { source: 'staff', staff_id: req.staff.id });
  res.status(out.duplicate ? 200 : 201).json(out);
});
r.get('/sessions/:id/menu', P(), (req, res) => {
  const s = ownSession(req);
  const g = db.get().prepare('SELECT DISTINCT package_id FROM session_guests WHERE session_id=? AND active=1').all(s.id).map((x) => x.package_id);
  res.json(menu.customerMenu(s.branch_id, g));
});

r.post('/sessions/:id/member', P('member.manage', 'table.open'), (req, res) => {
  const s = ownSession(req);
  if (req.body.member_id === null) {
    db.get().prepare('UPDATE table_sessions SET member_id=NULL WHERE id=? AND status IN (\'active\',\'billing\')').run(s.id);
  } else members.linkToSession(s.id, Number(req.body.member_id));
  auth.auditReq(req, 'session.member', 'table_session', s.id, { member_id: req.body.member_id });
  sessions.notifySession(s.id);
  res.json(sessions.sessionDetail(s.id));
});
r.post('/sessions/:id/promo', P('discount.apply', 'member.manage'), (req, res) => {
  const s = ownSession(req);
  const red = members.applyRedemption(req.body.code, s.id, { staffId: req.staff.id });
  auth.auditReq(req, 'promotion.apply', 'table_session', s.id, { code: red.code });
  sessions.notifySession(s.id);
  res.json({ redemption: red, bill: pricing.computeBill(s.id) });
});
r.delete('/sessions/:id/promo/:rid', P('discount.apply'), (req, res) => {
  const s = ownSession(req);
  members.unapplyRedemption(Number(req.params.rid), s.id);
  auth.auditReq(req, 'promotion.remove', 'table_session', s.id, { redemption_id: req.params.rid });
  res.json({ bill: pricing.computeBill(s.id) });
});
r.post('/sessions/:id/discount', P('discount.apply'), (req, res) => {
  const s = ownSession(req); sessions.assertActive(s);
  const type = req.body.type === 'percent' ? 'percent' : 'amount';
  const value = parseInt(req.body.value, 10) || 0; // amount in satang, percent ×100
  if (value < 0 || (type === 'percent' && value > 10000)) throw err(400, 'invalid_discount', 'ส่วนลดไม่ถูกต้อง');
  const settings = branchSettings(s.branch_id);
  let approver = null;
  const gross = pricing.computeBill(s.id).gross;
  const pctValue = type === 'percent' ? value / 100 : (gross ? value / gross * 100 : 100);
  if (value > 0 && pctValue > settings.discount_approval_over_percent) approver = auth.requireApproval(req, 'discount_over', req.body.approval);
  db.get().prepare('UPDATE table_sessions SET manual_discount=? WHERE id=?').run(value > 0 ? JSON.stringify({ type, value, reason: String(req.body.reason || '').slice(0, 100), staff_id: req.staff.id }) : null, s.id);
  auth.auditReq(req, 'discount.apply', 'table_session', s.id, { type, value, reason: req.body.reason }, approver);
  res.json({ bill: pricing.computeBill(s.id) });
});
r.post('/sessions/:id/adjustments', P('table.close'), (req, res) => {
  const s = ownSession(req); sessions.assertActive(s);
  const list = db.J(s.adjustments, []);
  const code = String(req.body.code || 'custom');
  if (code === 'waive_overtime') {
    const approver = auth.requireApproval(req, 'discount_over', req.body.approval);
    if (!list.some((a) => a.code === 'waive_overtime')) list.push({ code: 'waive_overtime' });
    auth.auditReq(req, 'overtime.waive', 'table_session', s.id, {}, approver);
  } else if (req.body.remove != null) {
    list.splice(Number(req.body.remove), 1);
  } else {
    const amount = parseInt(req.body.amount, 10);
    if (!(amount > 0)) throw err(400, 'invalid_amount', 'จำนวนเงินไม่ถูกต้อง');
    list.push({ code, label: String(req.body.label || (code === 'leftover' ? 'ค่าปรับอาหารเหลือ' : 'รายการเพิ่มเติม')).slice(0, 60), amount });
    auth.auditReq(req, 'adjustment.add', 'table_session', s.id, { code, amount });
  }
  db.get().prepare('UPDATE table_sessions SET adjustments=? WHERE id=?').run(JSON.stringify(list), s.id);
  res.json({ bill: pricing.computeBill(s.id), adjustments: list });
});

r.get('/sessions/:id/bill', P(), (req, res) => { const s = ownSession(req); res.json(pricing.computeBill(s.id)); });
r.post('/sessions/:id/checkout', P('table.close'), (req, res) => {
  ownSession(req);
  const out = payments.startCheckout(req, Number(req.params.id), req.body.split || { mode: 'none' });
  sessions.notifySession(Number(req.params.id));
  res.json(out);
});
r.post('/sessions/:id/checkout/cancel', P('table.close'), (req, res) => { ownSession(req); payments.cancelCheckout(req, Number(req.params.id)); res.json({ ok: true }); });

// ---- bills ----
r.post('/bills/:id/pay', P('table.close'), (req, res) => res.json(payments.payBill(req, Number(req.params.id), req.body || {})));
r.post('/bills/:id/refund', P('payment.refund'), (req, res) => res.json(payments.refund(req, Number(req.params.id), req.body || {})));
r.post('/bills/:id/tax-invoice', P('table.close'), (req, res) => res.json(payments.issueTaxInvoice(req, Number(req.params.id), req.body || {})));
r.post('/bills/:id/print', P('table.close'), (req, res) => {
  const b = db.get().prepare('SELECT * FROM bills WHERE id=? AND branch_id=?').get(req.params.id, req.branchId);
  if (!b) throw err(404, 'bill_not_found', 'ไม่พบบิล');
  const doc = req.body.doc === 'tax_invoice' ? 'tax_invoice' : 'receipt';
  res.json({ jobs: printing.enqueueDoc(req.branchId, doc, b.id) });
});
r.get('/bills', P('table.close', 'payment.refund', 'report.view'), (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = db.get().prepare(`SELECT b.*, t.code table_code FROM bills b JOIN table_sessions s ON s.id=b.session_id JOIN tables t ON t.id=s.table_id WHERE b.branch_id=? AND b.status!='void' ${q ? 'AND (b.bill_no LIKE ? OR s.public_code LIKE ?)' : ''} ORDER BY b.id DESC LIMIT 50`)
    .all(req.branchId, ...(q ? [`%${q}%`, `%${q}%`] : []));
  res.json({ bills: rows.map((b) => ({ ...payments.billOut(b), table_code: b.table_code })) });
});
r.get('/bills/:id/promptpay', P('table.close'), async (req, res) => {
  const b = db.get().prepare('SELECT * FROM bills WHERE id=? AND branch_id=?').get(req.params.id, req.branchId);
  if (!b) throw err(404, 'bill_not_found', 'ไม่พบบิล');
  const m = db.get().prepare("SELECT * FROM payment_methods WHERE id=? AND type='promptpay'").get(req.query.method_id);
  const id = m && db.J(m.config, {}).promptpay_id;
  if (!id) throw err(400, 'promptpay_not_configured', 'ยังไม่ได้ตั้งค่าหมายเลขพร้อมเพย์');
  const amount = req.query.amount ? Number(req.query.amount) : b.total - b.paid_total;
  const payload = payments.promptPayPayload(id, amount);
  res.json({ payload, amount, qr: await QRCode.toDataURL(payload, { width: 360, margin: 1 }) });
});

// ---- order items (waiter/kitchen) ----
r.post('/items/status', P('kitchen.update', 'order.cancel', 'order.create'), (req, res) => {
  res.json({ orders: orders.updateItems(req, req.body.item_ids, req.body.status, { reason: req.body.reason }) });
});

// ---- members ----
r.get('/members', P('member.manage', 'table.open'), (req, res) => res.json({ members: members.findMember(req.query.q).map((m) => members.memberOut(m)) }));
r.post('/members', P('member.manage'), (req, res) => {
  const m = members.register({ ...req.body, consent: req.body.consent }, { branchId: req.branchId, sessionId: req.body.session_id || null, verified: !!req.body.verified, staffId: req.staff.id });
  if (req.body.session_id) sessions.notifySession(Number(req.body.session_id));
  res.status(201).json({ member: members.memberOut(m, { full: true }) });
});
r.get('/members/:id', P('member.manage'), (req, res) => {
  const d = db.get();
  const m = d.prepare('SELECT * FROM members WHERE id=?').get(req.params.id);
  if (!m) throw err(404, 'member_not_found', 'ไม่พบสมาชิก');
  res.json({ member: members.memberOut(m, { full: true }), history: members.pointHistory(m.id),
    redemptions: d.prepare('SELECT r.*, p.name FROM redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE r.member_id=? ORDER BY r.id DESC LIMIT 100').all(m.id).map((x) => ({ ...x, name: db.J(x.name, {}) })),
    promotions: members.availablePromotions(m, req.branchId),
    visits: d.prepare("SELECT s.public_code, s.closed_at, t.code table_code, (SELECT SUM(total) FROM bills b WHERE b.session_id=s.id AND b.status='paid') total FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.member_id=? AND s.status='closed' ORDER BY s.id DESC LIMIT 50").all(m.id) });
});
r.post('/members/:id/points', P('points.adjust'), (req, res) => {
  const approver = auth.requireApproval(req, 'adjust_points', req.body.approval);
  const m = members.adjustPoints(Number(req.params.id), req.body.points, req.body.reason, req.staff.id, approver, req.branchId);
  res.json({ member: members.memberOut(m, { full: true }) });
});
r.post('/members/:id/redeem', P('member.manage'), (req, res) => {
  const red = members.redeem(Number(req.params.id), Number(req.body.promotion_id), req.branchId, { sessionId: req.body.session_id ? Number(req.body.session_id) : null, staffId: req.staff.id });
  auth.auditReq(req, 'promotion.redeem', 'member', Number(req.params.id), { promotion_id: req.body.promotion_id, code: red.code });
  res.status(201).json({ redemption: red });
});
r.post('/redemptions/:id/cancel', P('member.manage'), (req, res) => {
  const red = members.cancelRedemption(Number(req.params.id), { staffId: req.staff.id, branchId: req.branchId });
  auth.auditReq(req, 'promotion.cancel', 'redemption', red.id, {});
  res.json({ redemption: red });
});

// ---- staff calls ----
r.get('/calls', P(), (req, res) => res.json({ calls: calls.openCalls(req.branchId), server_time: now() }));
r.post('/calls/:id', P('call.handle'), (req, res) => res.json({ call: calls.updateCall(req, Number(req.params.id), String(req.body.status)) }));

// ---- print jobs (visible to POS for reprint / status) ----
r.get('/print-jobs', P(), (req, res) => {
  res.json({ jobs: db.get().prepare('SELECT * FROM print_jobs WHERE branch_id=? ORDER BY id DESC LIMIT 100').all(req.branchId).map(printing.jobOut) });
});
r.post('/print-jobs/:id/retry', P('table.qr', 'table.close', 'settings.manage'), (req, res) => res.json({ job: printing.retry(req.branchId, Number(req.params.id)) }));

module.exports = r;
