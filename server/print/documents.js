'use strict';
// Print documents: data snapshots (taken when the job is queued) and layouts (blocks) rendered with the branch's print template.
const db = require('../db');
const { fmtMoney, hhmm, ddmmyyyy, tr, decrypt } = require('../lib/util');
const { branchSettings } = require('../services/settings');

const DOC_TYPES = {
  qr_ticket: 'ใบ QR เปิดโต๊ะ',
  member_signup: 'ใบสมัครสมาชิก',
  kitchen: 'ใบครัว',
  receipt: 'ใบเสร็จลูกค้า',
  close_summary: 'ใบสรุปปิดโต๊ะ',
  tax_invoice: 'ใบกำกับภาษี',
  test: 'ทดสอบเครื่องพิมพ์',
};

const DEFAULT_TEMPLATE = {
  font: 'Sarabun', base_size: 0, margin: 8, line_height: 1.35, show_logo: true, logo_asset_id: null,
  qr_size_pct: 62, title_size_pct: 130, kitchen_size_pct: 135,
  header_text: { th: '', en: '', zh: '' },
};

function branchInfo(branchId) {
  const d = db.get();
  const b = d.prepare('SELECT b.*, r.name r_name, r.tax_id r_tax, r.phone r_phone, r.logo_asset_id r_logo FROM branches b JOIN restaurants r ON r.id=b.restaurant_id WHERE b.id=?').get(branchId);
  return { id: b.id, code: b.code, name: db.J(b.name, {}), restaurant: db.J(b.r_name, {}), address: db.J(b.address, {}), tax_id: b.tax_id || b.r_tax, phone: b.phone || b.r_phone, logo: b.logo_asset_id || b.r_logo };
}

function template(branchId) {
  const t = db.get().prepare('SELECT settings FROM themes WHERE branch_id=? AND is_active=1').get(branchId);
  const s = db.J(t && t.settings, {});
  return { ...DEFAULT_TEMPLATE, ...(s.print || {}) };
}

function sessionCore(sessionId) {
  const d = db.get();
  const s = d.prepare('SELECT s.*, t.code table_code FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=?').get(sessionId);
  const groups = d.prepare(`SELECT p.name pkg, g.price_code, pp.label, g.unit_price, COUNT(*) n FROM session_guests g JOIN buffet_packages p ON p.id=g.package_id LEFT JOIN package_prices pp ON pp.id=g.price_id
    WHERE g.session_id=? AND g.active=1 GROUP BY g.package_id, g.price_code, g.unit_price ORDER BY g.package_id`).all(sessionId)
    .map((g) => ({ package: db.J(g.pkg, {}), label: db.J(g.label, {}), unit: g.unit_price, count: g.n }));
  return { s, groups };
}

// ---------- snapshots ----------
function snapshot(docType, refId, branchId) {
  const d = db.get();
  const branch = branchInfo(branchId);
  if (docType === 'qr_ticket' || docType === 'member_signup' || docType === 'close_summary') {
    const { s, groups } = sessionCore(refId);
    const bill = require('../services/pricing').computeBill(refId);
    const base = { branch, session_id: s.id, public_code: s.public_code, table_code: s.table_code, start_at: s.start_at, end_at: s.end_at, duration_min: s.duration_min, guests: s.guests_count, groups,
      bill: { package_total: bill.package_total, extras_total: bill.extras_total, discount_total: bill.discount_total, subtotal: bill.subtotal, service_rate: bill.service_rate, service_charge: bill.service_charge, vat_rate: bill.vat_rate, vat: bill.vat, before_vat: bill.before_vat, total: bill.total, prices_include_vat: bill.prices_include_vat } };
    if (docType === 'close_summary') {
      base.closed_at = s.closed_at;
      base.items = d.prepare("SELECT COUNT(*) lines, COALESCE(SUM(qty),0) qty FROM order_items WHERE session_id=? AND status NOT IN ('cancelled','unavailable')").get(s.id);
      base.orders = d.prepare('SELECT COUNT(DISTINCT order_id) c FROM order_items WHERE session_id=?').get(s.id).c;
      base.bills = d.prepare("SELECT bill_no, total, paid_total FROM bills WHERE session_id=? AND status!='void'").all(s.id);
      base.payments = d.prepare('SELECT method_name, SUM(amount) amount FROM payments WHERE session_id=? GROUP BY method_name').all(s.id);
      base.staff = s.closed_by ? (d.prepare('SELECT name FROM staff WHERE id=?').get(s.closed_by) || {}).name : null;
    }
    return base;
  }
  if (docType === 'kitchen') {
    const k = d.prepare(`SELECT k.*, o.order_no, o.guest_label, o.source, t.code table_code, s.public_code, ks.name station, (SELECT COUNT(*) FROM kitchen_tickets k2 WHERE k2.session_id=k.session_id AND k2.id<k.id) prev
      FROM kitchen_tickets k JOIN orders o ON o.id=k.order_id JOIN table_sessions s ON s.id=k.session_id JOIN tables t ON t.id=s.table_id LEFT JOIN kitchen_stations ks ON ks.id=k.station_id WHERE k.id=?`).get(refId);
    const items = d.prepare('SELECT name, qty, options, note, guest_label FROM order_items WHERE ticket_id=? ORDER BY id').all(refId)
      .map((i) => ({ name: db.J(i.name, {}), qty: i.qty, options: db.J(i.options, []), note: i.note, guest: i.guest_label }));
    return { branch: { name: branch.name }, ticket_id: k.id, order_no: k.order_no, table_code: k.table_code, public_code: k.public_code, station: k.station, created_at: k.created_at, additional: k.prev > 0, items };
  }
  if (docType === 'receipt' || docType === 'tax_invoice') {
    const b = require('../services/payments').billOut(d.prepare('SELECT * FROM bills WHERE id=?').get(refId));
    const s = d.prepare('SELECT s.*, t.code table_code FROM table_sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=?').get(b.session_id);
    const member = b.member_id ? d.prepare('SELECT code, first_name, points FROM members WHERE id=?').get(b.member_id) : null;
    return { branch, bill: b, table_code: s.table_code, public_code: s.public_code, start_at: s.start_at, end_at: s.end_at, guests: s.guests_count, member, cashier: b.staff_id ? (d.prepare('SELECT name FROM staff WHERE id=?').get(b.staff_id) || {}).name : null };
  }
  if (docType === 'test') return { branch, ...refId };
  throw new Error('unknown doc type ' + docType);
}

// ---------- layouts ----------
function layout(docType, data, { tpl, settings, lang = 'th', paper = 80, qrUrl, joinUrl }) {
  const W = paper === 58 ? 384 : 576;
  const base = tpl.base_size || (W <= 384 ? 20 : 24);
  const title = Math.round(base * tpl.title_size_pct / 100);
  const tz = settings.timezone;
  const B = [];
  const logo = () => { if (tpl.show_logo && (tpl.logo_asset_id || (data.branch && data.branch.logo))) B.push({ t: 'image', src: `/media/${tpl.logo_asset_id || data.branch.logo}`, maxW: Math.round(W * 0.5), maxH: 130 }); };
  const header = (full = true) => {
    logo();
    B.push({ t: 'text', text: tr(data.branch.restaurant, lang) || tr(data.branch.name, lang), size: title, bold: true, align: 'center' });
    if (full) {
      B.push({ t: 'text', text: tr(data.branch.name, lang), size: Math.round(base * 0.85), align: 'center' });
      const addr = tr(data.branch.address, lang); if (addr) B.push({ t: 'text', text: addr, size: Math.round(base * 0.8), align: 'center' });
      if (data.branch.tax_id) B.push({ t: 'text', text: `TAX ID: ${data.branch.tax_id}`, size: Math.round(base * 0.85), align: 'center' });
      if (data.branch.phone) B.push({ t: 'text', text: `Tel: ${data.branch.phone}`, size: Math.round(base * 0.85), align: 'center' });
    }
    const ht = tr(tpl.header_text, lang); if (ht) B.push({ t: 'text', text: ht, size: Math.round(base * 0.85), align: 'center' });
  };
  const money = (v) => fmtMoney(v);
  const totals = (b) => {
    B.push({ t: 'row', left: 'SubTotal', right: money(b.subtotal) });
    if (b.service_charge) B.push({ t: 'row', left: `Service Charge(${b.service_rate}%)`, right: money(b.service_charge) });
    B.push({ t: 'row', left: b.prices_include_vat ? 'Before TAX (รวมใน)' : 'Before TAX', right: money(b.before_vat) });
    if (b.vat_rate) B.push({ t: 'row', left: `TAX(${b.vat_rate}%)`, right: money(b.vat) });
    B.push({ t: 'line', style: 'double' });
    B.push({ t: 'row', left: 'Total', right: money(b.total), bold: true, size: Math.round(base * 1.25) });
    B.push({ t: 'line', style: 'double' });
  };

  if (docType === 'qr_ticket') {
    header(false);
    B.push({ t: 'text', text: `เลขที่โต๊ะ ${data.table_code} • Session #${data.public_code}`, align: 'center', size: Math.round(base * 0.95) });
    B.push({ t: 'box', cols: [{ label: 'START', value: hhmm(data.start_at, tz) }, { label: 'END', value: hhmm(data.end_at, tz) }], size: Math.round(base * 1.7) });
    for (const g of data.groups) {
      B.push({ t: 'text', text: tr(g.package, 'en').toUpperCase() || tr(g.package, lang), bold: true, align: 'center', size: Math.round(base * 1.1) });
      B.push({ t: 'row', left: `${tr(g.label, lang) || 'ลูกค้า'} ${g.count} ท่าน`, right: `${money(g.unit)} บาท/ท่าน` });
    }
    B.push({ t: 'line' });
    const b = data.bill;
    B.push({ t: 'row', left: 'ค่าอาหาร', right: money(b.package_total) });
    if (b.discount_total) B.push({ t: 'row', left: 'ส่วนลด', right: '-' + money(b.discount_total) });
    if (b.service_charge) B.push({ t: 'row', left: `Service Charge ${b.service_rate}%`, right: money(b.service_charge) });
    if (b.vat_rate) B.push({ t: 'row', left: `VAT ${b.vat_rate}%${b.prices_include_vat ? ' (รวมใน)' : ''}`, right: money(b.vat) });
    B.push({ t: 'row', left: 'ยอดรวม', right: `${money(b.total)} บาท`, bold: true, size: Math.round(base * 1.15) });
    B.push({ t: 'line' });
    if (qrUrl) B.push({ t: 'qr', data: qrUrl, size: Math.round(W * tpl.qr_size_pct / 100) });
    else B.push({ t: 'invert', text: 'QR นี้สิ้นสุดการใช้งานแล้ว', size: base });
    B.push({ t: 'text', text: 'SCAN TO ORDER', bold: true, align: 'center', size: Math.round(base * 1.2) });
    B.push({ t: 'text', text: 'สแกนเพื่อสั่งอาหารได้ตลอดรอบการรับประทาน', align: 'center', size: Math.round(base * 0.9) });
    B.push({ t: 'text', text: `เวลาใช้บริการ ${data.duration_min} นาที`, align: 'center', size: Math.round(base * 0.9) });
    B.push({ t: 'text', text: 'QR Code จะสิ้นสุดการใช้งานทันทีเมื่อปิดโต๊ะ', align: 'center', size: Math.round(base * 0.8) });
    B.push({ t: 'line' });
    B.push({ t: 'text', text: tr(settings.qr_ticket_footer, lang), align: 'center', size: base });
  } else if (docType === 'member_signup') {
    logo();
    B.push({ t: 'text', text: tr(data.branch.restaurant, lang), size: title, bold: true, align: 'center' });
    B.push({ t: 'invert', text: 'สมัครสมาชิก • MEMBERSHIP', size: Math.round(base * 1.1) });
    B.push({ t: 'text', text: tr(settings.member_signup_text, lang), align: 'center', size: base });
    if (joinUrl) B.push({ t: 'qr', data: joinUrl, size: Math.round(W * 0.55) });
    B.push({ t: 'text', text: 'สแกนเพื่อสมัครสมาชิกด้วยเบอร์โทรศัพท์', align: 'center', size: Math.round(base * 0.9) });
    B.push({ t: 'text', text: `• รับโบนัสสมัครใหม่ ${settings.points.signup_bonus} คะแนน`, size: Math.round(base * 0.9) });
    B.push({ t: 'text', text: '• สะสมคะแนนทุกการใช้บริการ แลกส่วนลดและเมนูพิเศษ', size: Math.round(base * 0.9) });
    B.push({ t: 'text', text: '• สมัครระหว่างรับประทาน คะแนนของมื้อนี้จะเข้าบัญชีทันทีหลังชำระเงิน', size: Math.round(base * 0.9) });
    B.push({ t: 'line' });
    B.push({ t: 'text', text: `โต๊ะ ${data.table_code} • #${data.public_code}`, align: 'center', size: Math.round(base * 0.8) });
  } else if (docType === 'kitchen') {
    const big = Math.round(base * tpl.kitchen_size_pct / 100);
    B.push({ t: 'invert', text: `โต๊ะ ${data.table_code}${data.additional ? '  (เพิ่ม)' : ''}`, size: Math.round(big * 1.4) });
    B.push({ t: 'row', left: `${data.order_no}${data.station ? ' • ' + data.station : ''}`, right: hhmm(data.created_at, tz), size: base });
    B.push({ t: 'line', style: 'solid' });
    for (const it of data.items) {
      B.push({ t: 'row', left: `${it.qty} × ${tr(it.name, 'th')}`, right: it.guest ? `คุณ ${it.guest}` : '', size: big, bold: true });
      for (const o of it.options) B.push({ t: 'text', text: `   - ${tr(o.option, 'th')}: ${tr(o.choice, 'th')}`, size: base });
      if (it.note) B.push({ t: 'text', text: `   * ${it.note}`, size: base, bold: true });
    }
    B.push({ t: 'line', style: 'solid' });
    B.push({ t: 'text', text: `#${data.public_code}`, align: 'right', size: Math.round(base * 0.8) });
  } else if (docType === 'receipt' || docType === 'tax_invoice') {
    header(true);
    const b = data.bill;
    if (docType === 'tax_invoice' && b.tax_invoice) {
      B.push({ t: 'invert', text: 'ใบเสร็จรับเงิน/ใบกำกับภาษีเต็มรูป', size: base });
      B.push({ t: 'text', text: `เลขที่ ${b.tax_invoice.no}`, size: base });
      B.push({ t: 'text', text: `ผู้ซื้อ: ${b.tax_invoice.name}`, size: base });
      B.push({ t: 'text', text: `เลขประจำตัวผู้เสียภาษี: ${b.tax_invoice.tax_id} (${b.tax_invoice.branch_label})`, size: Math.round(base * 0.9) });
      if (b.tax_invoice.address) B.push({ t: 'text', text: `ที่อยู่: ${b.tax_invoice.address}`, size: Math.round(base * 0.9) });
    } else B.push({ t: 'text', text: 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ', align: 'center', size: Math.round(base * 0.9) });
    B.push({ t: 'box', cols: [{ label: 'Start', value: hhmm(data.start_at, tz) }, { label: 'End', value: hhmm(data.end_at, tz) }], size: Math.round(base * 1.6) });
    B.push({ t: 'line' });
    B.push({ t: 'text', text: `Table: ${data.table_code}`, size: base });
    B.push({ t: 'text', text: `Guest(s): ${data.guests}`, size: base });
    B.push({ t: 'text', text: `Date: ${ddmmyyyy(b.paid_at || b.created_at, tz)} ${hhmm(b.paid_at || b.created_at, tz)}`, size: base });
    B.push({ t: 'text', text: `Bill: ${b.bill_no}${b.split_label ? ' (' + b.split_label + ')' : ''}`, size: base });
    B.push({ t: 'line' });
    let count = 0;
    for (const l of b.lines) {
      if (l.kind === 'discount') { B.push({ t: 'row', left: l.name, right: money(l.amount) }); continue; }
      count += l.qty || 1;
      B.push({ t: 'row', left: `${l.qty || 1}  ${l.name}`, right: money(l.amount) });
    }
    B.push({ t: 'line' });
    B.push({ t: 'text', text: `Items: ${count}`, size: base });
    totals(b);
    for (const p of b.payments) {
      B.push({ t: 'row', left: p.method_name, right: money(p.received || p.amount) });
      if (p.change_amount) B.push({ t: 'row', left: 'เงินทอน', right: money(p.change_amount) });
    }
    if (data.member) {
      B.push({ t: 'line' });
      B.push({ t: 'text', text: `สมาชิก ${data.member.code} ${data.member.first_name || ''}`, size: base });
      B.push({ t: 'row', left: 'คะแนนที่ได้รับ', right: String(b.points_earned || 0) });
      B.push({ t: 'row', left: 'คะแนนคงเหลือ', right: String(data.member.points) });
    }
    if (data.cashier) B.push({ t: 'text', text: `Cashier: ${data.cashier}`, size: Math.round(base * 0.85) });
    B.push({ t: 'line' });
    const f = tr(settings.receipt_footer, lang); if (f) B.push({ t: 'text', text: f, size: Math.round(base * 0.85), align: 'center' });
  } else if (docType === 'close_summary') {
    B.push({ t: 'invert', text: `สรุปปิดโต๊ะ ${data.table_code}`, size: Math.round(base * 1.2) });
    B.push({ t: 'row', left: 'Session', right: '#' + data.public_code });
    B.push({ t: 'row', left: 'เวลา', right: `${hhmm(data.start_at, tz)} - ${hhmm(data.end_at, tz)}` });
    B.push({ t: 'row', left: 'ปิดโต๊ะ', right: data.closed_at ? `${ddmmyyyy(data.closed_at, tz)} ${hhmm(data.closed_at, tz)}` : '-' });
    B.push({ t: 'row', left: 'จำนวนลูกค้า', right: String(data.guests) });
    B.push({ t: 'row', left: 'จำนวนออเดอร์', right: String(data.orders) });
    B.push({ t: 'row', left: 'จำนวนอาหาร (จาน)', right: String(data.items.qty) });
    B.push({ t: 'line' });
    for (const b of data.bills) B.push({ t: 'row', left: b.bill_no, right: money(b.total) });
    for (const p of data.payments) B.push({ t: 'row', left: `ชำระ: ${p.method_name}`, right: money(p.amount) });
    B.push({ t: 'line' });
    B.push({ t: 'row', left: 'ยอดสุทธิ', right: money(data.bill.total), bold: true });
    if (data.staff) B.push({ t: 'text', text: `ปิดโดย ${data.staff}`, size: Math.round(base * 0.85) });
  } else if (docType === 'test') {
    header(false);
    B.push({ t: 'invert', text: 'ทดสอบเครื่องพิมพ์ • PRINT TEST', size: base });
    B.push({ t: 'text', text: `เครื่อง: ${data.printer_name}`, size: base });
    B.push({ t: 'text', text: `กระดาษ ${paper} มม. • ${W} dots`, size: base });
    B.push({ t: 'text', text: 'ภาษาไทย: กุ้งแม่น้ำเผา ซาชิมิแซลมอน ข้าวผัดปู', size: base });
    B.push({ t: 'text', text: 'English: Grilled river prawn', size: base });
    B.push({ t: 'text', text: '中文: 烤河虾 三文鱼刺身', size: base });
    B.push({ t: 'row', left: 'ตัวอย่างยอดเงิน', right: '5,879.12' });
    B.push({ t: 'qr', data: 'PRINT-TEST', size: Math.round(W * 0.35) });
    B.push({ t: 'text', text: new Date().toISOString(), align: 'center', size: Math.round(base * 0.7) });
  }
  return { paper, dots: W, font: tpl.font, baseSize: base, margin: tpl.margin, lineHeight: tpl.line_height, blocks: B };
}

// Build the renderable document for a job (live lookup of the session QR token; revoked sessions print no QR)
function buildDoc(job, printer, { tplOverride } = {}) {
  const payload = db.J(job.payload, {});
  const settings = branchSettings(job.branch_id);
  const tpl = { ...template(job.branch_id), ...(tplOverride || {}) };
  let qrUrl = null, joinUrl = null;
  if (['qr_ticket', 'member_signup'].includes(job.doc_type)) {
    const s = db.get().prepare('SELECT status, token_enc FROM table_sessions WHERE id=?').get(payload.data.session_id);
    if (s && ['active', 'billing'].includes(s.status) && s.token_enc) {
      const url = require('../services/sessions').orderUrl(decrypt(s.token_enc));
      qrUrl = url; joinUrl = url + '?join=1';
    }
  }
  return layout(job.doc_type, payload.data, { tpl, settings, lang: settings.default_language, paper: printer ? printer.paper_width : 80, qrUrl, joinUrl });
}

module.exports = { DOC_TYPES, DEFAULT_TEMPLATE, snapshot, layout, buildDoc, template, branchInfo };
