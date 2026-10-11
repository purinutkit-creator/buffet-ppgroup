'use strict';
// Checkout, split bills, payments, closing a table session (single DB transaction), refunds and tax invoices.
const db = require('../db');
const { err, now, localParts } = require('../lib/util');
const { branchSettings } = require('./settings');
const pricing = require('./pricing');
const members = require('./members');
const rt = require('../realtime');

function billOut(b) {
  if (!b) return null;
  return { ...b, lines: db.J(b.lines, []), tax_invoice: db.J(b.tax_invoice, null), payments: db.get().prepare('SELECT id, method_type, method_name, amount, received, change_amount, reference, refunded, created_at FROM payments WHERE bill_id=? ORDER BY id').all(b.id) };
}
function sessionBills(sessionId) { return db.get().prepare("SELECT * FROM bills WHERE session_id=? AND status!='void' ORDER BY id").all(sessionId).map(billOut); }

function nextBillNo(branchId, tz) {
  const p = localParts(now(), tz);
  const ym = `${p.y}${String(p.m).padStart(2, '0')}`;
  const code = db.get().prepare('SELECT code FROM branches WHERE id=?').get(branchId).code;
  return `${code}-${ym}-${String(db.nextSeq(`bill:${branchId}:${ym}`)).padStart(5, '0')}`;
}

/**
 * Create bills for a session and move it to "billing" (ordering is locked while billing).
 * split: {mode:'none'} | {mode:'equal', count} | {mode:'guests', groups:[["A","B"],["C"]]} | {mode:'amounts', amounts:[satang,...]}
 */
function startCheckout(req, sessionId, split = { mode: 'none' }) {
  const d = db.get();
  return d.transaction(() => {
    const s = d.prepare('SELECT * FROM table_sessions WHERE id=? AND branch_id=?').get(sessionId, req.branchId);
    if (!s) throw err(404, 'session_not_found', 'ไม่พบรอบการใช้โต๊ะ');
    if (!['active', 'billing'].includes(s.status)) throw err(409, 'session_not_active', 'รอบการใช้โต๊ะปิดแล้ว');
    const existing = d.prepare("SELECT * FROM bills WHERE session_id=? AND status!='void'").all(s.id);
    if (existing.some((b) => b.paid_total > 0)) throw err(409, 'payment_started', 'มีการชำระเงินบางส่วนแล้ว ไม่สามารถแบ่งบิลใหม่');
    d.prepare("UPDATE bills SET status='void' WHERE session_id=? AND status='open'").run(s.id);
    const bill = pricing.computeBill(s.id);
    const settings = branchSettings(s.branch_id);
    let parts, labels;
    const mode = split.mode || 'none';
    if (mode === 'none') { parts = [bill]; labels = [null]; }
    else if (mode === 'equal') {
      const n = parseInt(split.count, 10); if (!(n >= 2 && n <= 50)) throw err(400, 'invalid_split', 'จำนวนการแบ่งไม่ถูกต้อง');
      parts = pricing.splitBill(bill, Array(n).fill(1)); labels = parts.map((_, i) => `${i + 1}/${n}`);
    } else if (mode === 'guests') {
      const groups = split.groups || [];
      const all = Object.keys(bill.guest_shares);
      const flat = groups.flat();
      if (groups.length < 2 || flat.length !== all.length || !all.every((l) => flat.includes(l))) throw err(400, 'invalid_split', 'ต้องจัดลูกค้าทุกคนให้อยู่ในบิลใดบิลหนึ่ง');
      parts = pricing.splitBill(bill, groups.map((g) => g.reduce((a, l) => a + bill.guest_shares[l], 0))); labels = groups.map((g) => g.join(','));
    } else if (mode === 'amounts') {
      const a = (split.amounts || []).map(Number);
      if (a.length < 2 || a.some((x) => !(x > 0)) || a.reduce((x, y) => x + y, 0) !== bill.total) throw err(400, 'invalid_split', 'ยอดแบ่งรวมต้องเท่ากับยอดสุทธิ');
      parts = pricing.splitBill(bill, a); labels = a.map((_, i) => `${i + 1}/${a.length}`);
    } else throw err(400, 'invalid_split', 'รูปแบบการแบ่งบิลไม่ถูกต้อง');
    const ins = d.prepare(`INSERT INTO bills(branch_id, session_id, bill_no, split_label, status, lines, package_total, extras_total, adjustments_total, discount_total, subtotal, service_charge, before_vat, vat, total, member_id, staff_id, created_at)
      VALUES(?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    parts.forEach((p, i) => {
      const lines = mode === 'none' ? [...bill.lines, ...bill.discounts.filter((x) => x.amount > 0).map((x) => ({ kind: 'discount', name: x.name, amount: -x.amount }))] : [{ kind: 'split', name: `แบ่งชำระ ${labels[i]}`, amount: p.total }];
      ins.run(s.branch_id, s.id, nextBillNo(s.branch_id, settings.timezone), labels[i], JSON.stringify(lines), p.package_total, p.extras_total, p.adjustments_total, p.discount_total, p.subtotal, p.service_charge, p.before_vat, p.vat, p.total, s.member_id, req.staff.id, now());
    });
    d.prepare("UPDATE table_sessions SET status='billing' WHERE id=?").run(s.id);
    require('../auth').auditReq(req, 'checkout.start', 'table_session', s.id, { split: mode, total: bill.total, parts: parts.length });
    return { bill, bills: sessionBills(s.id) };
  })();
}

function cancelCheckout(req, sessionId) {
  const d = db.get();
  d.transaction(() => {
    const s = d.prepare('SELECT * FROM table_sessions WHERE id=? AND branch_id=?').get(sessionId, req.branchId);
    if (!s || s.status !== 'billing') throw err(409, 'not_billing', 'โต๊ะไม่ได้อยู่ระหว่างชำระเงิน');
    if (d.prepare("SELECT 1 FROM bills WHERE session_id=? AND status!='void' AND paid_total>0").get(s.id)) throw err(409, 'payment_started', 'มีการชำระเงินแล้ว ไม่สามารถยกเลิกได้');
    d.prepare("UPDATE bills SET status='void' WHERE session_id=? AND status='open'").run(s.id);
    d.prepare("UPDATE table_sessions SET status='active' WHERE id=?").run(s.id);
    require('../auth').auditReq(req, 'checkout.cancel', 'table_session', s.id);
  })();
  const sessions = require('./sessions'); sessions.notifySession(sessionId);
}

/**
 * Pay a bill: payments [{method_id, amount, received?, reference?}] (satang). Closes the session automatically in the
 * same transaction when every bill of the session is fully paid.
 */
function payBill(req, billId, { payments: list, idempotency_key, tax_invoice } = {}) {
  const d = db.get();
  if (!Array.isArray(list) || !list.length) throw err(400, 'payments_required', 'กรุณาระบุการชำระเงิน');
  const result = d.transaction(() => {
    if (idempotency_key) {
      const dup = d.prepare('SELECT bill_id FROM payments WHERE idempotency_key=?').get(String(idempotency_key));
      if (dup) return { duplicate: true, billId: dup.bill_id };
    }
    const b = d.prepare('SELECT * FROM bills WHERE id=? AND branch_id=?').get(billId, req.branchId);
    if (!b) throw err(404, 'bill_not_found', 'ไม่พบบิล');
    if (b.status !== 'open') throw err(409, 'bill_not_open', 'บิลนี้ชำระแล้วหรือถูกยกเลิก');
    let due = b.total - b.paid_total;
    list.forEach((p, i) => {
      const m = d.prepare('SELECT * FROM payment_methods WHERE id=? AND active=1 AND (branch_id IS NULL OR branch_id=?)').get(p.method_id, req.branchId);
      if (!m) throw err(400, 'invalid_method', 'ช่องทางชำระเงินไม่ถูกต้อง');
      let amount = parseInt(p.amount, 10);
      if (!(amount > 0)) throw err(400, 'invalid_amount', 'ยอดชำระไม่ถูกต้อง');
      let received = p.received != null ? parseInt(p.received, 10) : amount;
      let change = 0;
      if (m.type === 'cash') {
        if (amount > due) amount = due; // cash overpay → change
        if (received < amount) throw err(400, 'insufficient_cash', 'รับเงินไม่พอ');
        change = received - amount;
      } else {
        if (amount > due) throw err(400, 'overpay', 'ยอดชำระเกินยอดค้าง');
        received = amount;
      }
      d.prepare('INSERT INTO payments(branch_id, session_id, bill_id, method_id, method_type, method_name, amount, received, change_amount, reference, idempotency_key, staff_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(b.branch_id, b.session_id, b.id, m.id, m.type, m.name, amount, received, change, p.reference ? String(p.reference).slice(0, 80) : null, i === 0 && idempotency_key ? String(idempotency_key) : null, req.staff.id, now());
      due -= amount;
    });
    const paid = b.total - due;
    d.prepare('UPDATE bills SET paid_total=? WHERE id=?').run(paid, b.id);
    if (tax_invoice) issueTaxInvoiceTx(b.id, tax_invoice, b.branch_id);
    let closed = false;
    if (due <= 0) {
      d.prepare("UPDATE bills SET status='paid', paid_at=? WHERE id=?").run(now(), b.id);
      d.prepare("UPDATE redemptions SET bill_id=? WHERE session_id=? AND status='applied' AND bill_id IS NULL").run(b.id, b.session_id);
      members.earnForBill(d.prepare('SELECT * FROM bills WHERE id=?').get(b.id));
      const open = d.prepare("SELECT COUNT(*) c FROM bills WHERE session_id=? AND status='open'").get(b.session_id).c;
      if (!open) { closeSessionTx(req, b.session_id); closed = true; }
    }
    require('../auth').auditReq(req, 'payment.add', 'bill', b.id, { amount: list.reduce((a, p) => a + Number(p.amount), 0), paid, due: Math.max(0, due) });
    return { billId: b.id, closed, sessionId: b.session_id };
  })();
  const bill = billOut(d.prepare('SELECT * FROM bills WHERE id=?').get(result.billId));
  if (!result.duplicate) afterPayment(bill, result.closed);
  return { bill, session_closed: !!result.closed, duplicate: !!result.duplicate };
}

// Internal: must run inside a transaction. Closes the session, revokes its QR, frees the table.
function closeSessionTx(req, sessionId) {
  const d = db.get();
  const s = d.prepare('SELECT * FROM table_sessions WHERE id=?').get(sessionId);
  if (!['active', 'billing'].includes(s.status)) throw err(409, 'session_not_active', 'รอบการใช้โต๊ะปิดแล้ว');
  const unpaid = d.prepare("SELECT COUNT(*) c FROM bills WHERE session_id=? AND status='open'").get(s.id).c;
  const paidBills = d.prepare("SELECT COUNT(*) c FROM bills WHERE session_id=? AND status='paid'").get(s.id).c;
  if (unpaid || !paidBills) throw err(409, 'unpaid', 'ยังชำระเงินไม่ครบ');
  const settings = branchSettings(s.branch_id);
  // Revoke: the token row keeps its hash so a re-scan shows "service ended", but the session is no longer active
  d.prepare("UPDATE table_sessions SET status='closed', closed_at=?, closed_by=?, token_enc='' WHERE id=?").run(now(), req.staff.id, s.id);
  d.prepare("UPDATE redemptions SET status='used', used_at=? WHERE session_id=? AND status='applied'").run(now(), s.id);
  d.prepare("UPDATE staff_calls SET status='cancelled', done_at=? WHERE session_id=? AND status IN ('pending','accepted','in_progress')").run(now(), s.id);
  d.prepare('UPDATE tables SET status=?, current_session_id=NULL WHERE id=? AND current_session_id=?').run(settings.after_payment_table_status === 'available' ? 'available' : 'cleaning', s.table_id, s.id);
  require('../auth').auditReq(req, 'table.close', 'table_session', s.id, { table_id: s.table_id });
}

function afterPayment(bill, closed) {
  const printing = require('./printing');
  if (bill.status === 'paid') printing.enqueueDoc(bill.branch_id, 'receipt', bill.id, { auto: true });
  if (bill.tax_invoice) printing.enqueueDoc(bill.branch_id, 'tax_invoice', bill.id, { auto: true });
  if (closed) {
    printing.enqueueDoc(bill.branch_id, 'close_summary', bill.session_id, { auto: true });
    rt.toSession(bill.session_id, 'session:closed', {});
    rt.toStaff(bill.branch_id, 'calls:changed', {});
    rt.kickSession(bill.session_id);
  }
  rt.toStaff(bill.branch_id, 'tables:changed', { session_id: bill.session_id });
  rt.toStaff(bill.branch_id, 'bill:updated', { bill_id: bill.id, session_id: bill.session_id });
}

function issueTaxInvoiceTx(billId, info, branchId) {
  const d = db.get();
  if (!info || !info.name || !info.tax_id || !/^\d{13}$/.test(String(info.tax_id))) throw err(400, 'invalid_tax_invoice', 'ใบกำกับภาษีต้องมีชื่อและเลขประจำตัวผู้เสียภาษี 13 หลัก');
  const b = d.prepare('SELECT * FROM bills WHERE id=?').get(billId);
  const existing = db.J(b.tax_invoice, null);
  const p = localParts(now(), branchSettings(branchId).timezone);
  const no = existing ? existing.no : `TI${p.y}${String(p.m).padStart(2, '0')}-${String(db.nextSeq(`ti:${branchId}:${p.y}`)).padStart(5, '0')}`;
  const ti = { no, name: String(info.name).slice(0, 150), tax_id: String(info.tax_id), address: String(info.address || '').slice(0, 300), branch_label: String(info.branch_label || 'สำนักงานใหญ่').slice(0, 60), issued_at: now() };
  d.prepare('UPDATE bills SET tax_invoice=? WHERE id=?').run(JSON.stringify(ti), billId);
  return ti;
}
function issueTaxInvoice(req, billId, info) {
  const d = db.get();
  const b = d.prepare('SELECT * FROM bills WHERE id=? AND branch_id=?').get(billId, req.branchId);
  if (!b) throw err(404, 'bill_not_found', 'ไม่พบบิล');
  const ti = d.transaction(() => issueTaxInvoiceTx(b.id, info, b.branch_id))();
  require('../auth').auditReq(req, 'tax_invoice.issue', 'bill', b.id, { no: ti.no });
  if (b.status === 'paid') require('./printing').enqueueDoc(b.branch_id, 'tax_invoice', b.id, { auto: false });
  return billOut(d.prepare('SELECT * FROM bills WHERE id=?').get(b.id));
}

function refund(req, billId, { amount, reason, approval } = {}) {
  const d = db.get();
  const approver = require('../auth').requireApproval(req, 'refund', approval);
  const amt = parseInt(amount, 10);
  if (!(amt > 0)) throw err(400, 'invalid_amount', 'ยอดคืนเงินไม่ถูกต้อง');
  if (!reason || String(reason).trim().length < 3) throw err(400, 'reason_required', 'กรุณาระบุเหตุผล');
  const out = d.transaction(() => {
    const b = d.prepare('SELECT * FROM bills WHERE id=? AND branch_id=?').get(billId, req.branchId);
    if (!b) throw err(404, 'bill_not_found', 'ไม่พบบิล');
    if (!['paid', 'partially_refunded'].includes(b.status)) throw err(409, 'not_refundable', 'บิลนี้คืนเงินไม่ได้');
    if (amt > b.paid_total - b.refunded_total) throw err(400, 'refund_exceeds', 'ยอดคืนเกินยอดที่ชำระ');
    const pts = members.reverseForRefund(b, amt, req.staff.id, approver);
    d.prepare('INSERT INTO refunds(branch_id, bill_id, amount, reason, points_reversed, staff_id, approver_id, created_at) VALUES(?,?,?,?,?,?,?,?)').run(b.branch_id, b.id, amt, String(reason).slice(0, 200), pts, req.staff.id, approver, now());
    const total = b.refunded_total + amt;
    d.prepare('UPDATE bills SET refunded_total=?, status=? WHERE id=?').run(total, total >= b.paid_total ? 'refunded' : 'partially_refunded', b.id);
    require('../auth').auditReq(req, 'payment.refund', 'bill', b.id, { amount: amt, reason, points_reversed: pts }, approver);
    return { bill_id: b.id, points_reversed: pts };
  })();
  return { ...out, bill: billOut(d.prepare('SELECT * FROM bills WHERE id=?').get(billId)) };
}

// ---- PromptPay (EMVCo merchant-presented QR, Thai QR standard) ----
function crc16(s) {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) { crc ^= s.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1; crc &= 0xffff; }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function promptPayPayload(id, amountSatang) {
  const f = (tag, v) => tag + String(v.length).padStart(2, '0') + v;
  let target = String(id).replace(/\D/g, '');
  let sub;
  if (target.length >= 15) sub = f('03', target); // e-wallet
  else if (target.length >= 13) sub = f('02', target); // national id / tax id
  else sub = f('01', ('0000000000000' + target.replace(/^0/, '66')).slice(-13)); // phone
  const merchant = f('00', 'A000000677010111') + sub;
  let p = f('00', '01') + f('01', amountSatang ? '12' : '11') + f('29', merchant) + f('58', 'TH') + f('53', '764');
  if (amountSatang) p += f('54', (amountSatang / 100).toFixed(2));
  p += '6304';
  return p + crc16(p);
}

module.exports = { billOut, sessionBills, startCheckout, cancelCheckout, payBill, refund, issueTaxInvoice, promptPayPayload, closeSessionTx };
