'use strict';
// Reports & analytics with CSV / Excel / PDF export.
const path = require('path');
const db = require('../db');
const { err, fromSatang } = require('../lib/util');

// Local-time offset for grouping by day (uses the branch timezone's current offset)
function tzOffsetMin(tz = 'Asia/Bangkok') {
  const d = new Date();
  const loc = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((loc - utc) / 60000);
}

function filters(q, alias = 's') {
  const where = []; const args = [];
  const from = Number(q.from) || Date.now() - 30 * 86400e3, to = Number(q.to) || Date.now();
  if (q.branch_id) { where.push(`${alias}.branch_id=?`); args.push(Number(q.branch_id)); }
  return { where, args, from, to };
}

const money = (v) => fromSatang(v || 0);

const REPORTS = {
  // Sales by period (day | month | year)
  sales(q) {
    const { where, args, from, to } = filters(q, 'b');
    const off = tzOffsetMin(q.tz) * 60000;
    const fmt = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' }[q.group || 'day'] || '%Y-%m-%d';
    if (q.staff_id) { where.push('b.staff_id=?'); args.push(Number(q.staff_id)); }
    if (q.package_id) { where.push('EXISTS (SELECT 1 FROM session_guests g WHERE g.session_id=b.session_id AND g.package_id=?)'); args.push(Number(q.package_id)); }
    const rows = db.get().prepare(`SELECT strftime('${fmt}', (b.paid_at+${off})/1000, 'unixepoch') period, COUNT(DISTINCT b.session_id) tables, SUM(b.total) total, SUM(b.subtotal) subtotal,
      SUM(b.service_charge) service_charge, SUM(b.vat) vat, SUM(b.discount_total) discount, SUM(b.refunded_total) refunded,
      (SELECT SUM(s.guests_count) FROM table_sessions s WHERE s.id IN (SELECT session_id FROM bills b2 WHERE strftime('${fmt}', (b2.paid_at+${off})/1000, 'unixepoch')=strftime('${fmt}', (b.paid_at+${off})/1000, 'unixepoch') AND b2.status IN ('paid','partially_refunded','refunded'))) guests
      FROM bills b WHERE b.status IN ('paid','partially_refunded','refunded') AND b.paid_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY period ORDER BY period`).all(from, to, ...args);
    return { columns: [['period', 'ช่วงเวลา'], ['tables', 'จำนวนโต๊ะ'], ['guests', 'จำนวนลูกค้า'], ['subtotal', 'ยอดก่อน SC/VAT', 'money'], ['discount', 'ส่วนลด', 'money'], ['service_charge', 'Service Charge', 'money'], ['vat', 'VAT', 'money'], ['total', 'ยอดขายสุทธิ', 'money'], ['refunded', 'คืนเงิน', 'money']], rows };
  },
  summary(q) {
    const { where, args, from, to } = filters(q, 'b');
    const w = where.length ? 'AND ' + where.join(' AND ') : '';
    const d = db.get();
    const totals = d.prepare(`SELECT COUNT(DISTINCT b.session_id) tables, COALESCE(SUM(b.total),0) total, COALESCE(SUM(b.refunded_total),0) refunded, COALESCE(SUM(b.discount_total),0) discount FROM bills b WHERE b.status IN ('paid','partially_refunded','refunded') AND b.paid_at BETWEEN ? AND ? ${w}`).get(from, to, ...args);
    totals.guests = d.prepare(`SELECT COALESCE(SUM(s.guests_count),0) g FROM table_sessions s WHERE s.status='closed' AND s.closed_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ').replace(/b\./g, 's.') : ''}`).get(from, to, ...args).g;
    totals.open_tables = d.prepare(`SELECT COUNT(*) c FROM table_sessions s WHERE s.status IN ('active','billing') ${where.length ? 'AND ' + where.join(' AND ').replace(/b\./g, 's.') : ''}`).get(...args).c;
    const byMethod = d.prepare(`SELECT p.method_name method, COUNT(*) count, SUM(p.amount) amount FROM payments p JOIN bills b ON b.id=p.bill_id WHERE p.created_at BETWEEN ? AND ? ${w} GROUP BY p.method_name ORDER BY amount DESC`).all(from, to, ...args);
    const byBranch = d.prepare(`SELECT br.code branch, COUNT(DISTINCT b.session_id) tables, SUM(b.total) total FROM bills b JOIN branches br ON br.id=b.branch_id WHERE b.status IN ('paid','partially_refunded','refunded') AND b.paid_at BETWEEN ? AND ? GROUP BY b.branch_id`).all(from, to);
    const packages = REPORTS.packages(q).rows;
    return { totals, byMethod, byBranch, packages };
  },
  packages(q) {
    const { where, args, from, to } = filters(q);
    const rows = db.get().prepare(`SELECT p.code, p.name, COUNT(*) guests, COUNT(DISTINCT g.session_id) tables, SUM(g.unit_price) revenue FROM session_guests g JOIN table_sessions s ON s.id=g.session_id JOIN buffet_packages p ON p.id=g.package_id
      WHERE g.active=1 AND s.status='closed' AND s.closed_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY p.id ORDER BY guests DESC`).all(from, to, ...args)
      .map((r) => ({ ...r, name: db.J(r.name, {}).th || r.code }));
    return { columns: [['code', 'รหัส'], ['name', 'แพ็กเกจ'], ['tables', 'โต๊ะ'], ['guests', 'ลูกค้า'], ['revenue', 'รายได้ค่าแพ็กเกจ', 'money']], rows };
  },
  payment_methods(q) {
    const { where, args, from, to } = filters(q, 'p');
    const rows = db.get().prepare(`SELECT p.method_name method, p.method_type type, COUNT(*) count, SUM(p.amount) amount FROM payments p WHERE p.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY p.method_name ORDER BY amount DESC`).all(from, to, ...args);
    return { columns: [['method', 'ช่องทาง'], ['type', 'ประเภท'], ['count', 'จำนวนรายการ'], ['amount', 'ยอดเงิน', 'money']], rows };
  },
  branches(q) {
    const { from, to } = filters(q);
    const rows = db.get().prepare(`SELECT br.code, br.name, COUNT(DISTINCT b.session_id) tables, COALESCE(SUM(b.total),0) total FROM branches br LEFT JOIN bills b ON b.branch_id=br.id AND b.status IN ('paid','partially_refunded','refunded') AND b.paid_at BETWEEN ? AND ? GROUP BY br.id`).all(from, to)
      .map((r) => ({ ...r, name: db.J(r.name, {}).th }));
    return { columns: [['code', 'รหัสสาขา'], ['name', 'สาขา'], ['tables', 'จำนวนโต๊ะ'], ['total', 'ยอดขาย', 'money']], rows };
  },
  top_items(q) {
    const { where, args, from, to } = filters(q, 'o');
    const rows = db.get().prepare(`SELECT m.code, i.name, SUM(i.qty) qty, COUNT(DISTINCT i.session_id) tables, SUM(i.qty*i.unit_extra) extra_revenue, SUM(i.qty*i.unit_cost) cost
      FROM order_items i JOIN orders o ON o.id=i.order_id JOIN menu_items m ON m.id=i.menu_item_id WHERE i.status NOT IN ('cancelled','unavailable') AND i.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      GROUP BY i.menu_item_id ORDER BY qty DESC LIMIT ${Math.min(500, Number(q.limit) || 50)}`).all(from, to, ...args).map((r) => ({ ...r, name: db.J(r.name, {}).th }));
    return { columns: [['code', 'รหัส'], ['name', 'เมนู'], ['qty', 'จำนวนที่สั่ง'], ['tables', 'จำนวนโต๊ะ'], ['extra_revenue', 'รายได้เพิ่มเติม', 'money'], ['cost', 'ต้นทุน', 'money']], rows };
  },
  items_per_table(q) {
    const { where, args, from, to } = filters(q);
    const rows = db.get().prepare(`SELECT s.public_code, t.code table_code, s.guests_count guests, COUNT(DISTINCT i.order_id) orders, COALESCE(SUM(i.qty),0) items, ROUND(COALESCE(SUM(i.qty),0)*1.0/s.guests_count,2) per_guest
      FROM table_sessions s JOIN tables t ON t.id=s.table_id LEFT JOIN order_items i ON i.session_id=s.id AND i.status NOT IN ('cancelled','unavailable')
      WHERE s.status='closed' AND s.closed_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY s.id ORDER BY s.closed_at DESC`).all(from, to, ...args);
    return { columns: [['public_code', 'Session'], ['table_code', 'โต๊ะ'], ['guests', 'ลูกค้า'], ['orders', 'รอบสั่ง'], ['items', 'จำนวนจาน'], ['per_guest', 'จาน/คน']], rows };
  },
  wait_times(q) {
    const { where, args, from, to } = filters(q, 'o');
    const rows = db.get().prepare(`SELECT m.code, i.name, COUNT(*) samples, ROUND(AVG((i.ready_at-i.created_at)/60000.0),1) avg_wait_min, ROUND(MAX((i.ready_at-i.created_at)/60000.0),1) max_wait_min, m.prep_minutes target_min
      FROM order_items i JOIN orders o ON o.id=i.order_id JOIN menu_items m ON m.id=i.menu_item_id WHERE i.ready_at IS NOT NULL AND i.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      GROUP BY i.menu_item_id ORDER BY avg_wait_min DESC`).all(from, to, ...args).map((r) => ({ ...r, name: db.J(r.name, {}).th }));
    const overall = db.get().prepare(`SELECT ROUND(AVG((i.ready_at-i.created_at)/60000.0),1) avg FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.ready_at IS NOT NULL AND i.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}`).get(from, to, ...args).avg;
    return { columns: [['code', 'รหัส'], ['name', 'เมนู'], ['samples', 'จำนวน'], ['avg_wait_min', 'รอเฉลี่ย (นาที)'], ['max_wait_min', 'รอนานสุด (นาที)'], ['target_min', 'เป้าหมาย (นาที)']], rows, overall_avg_min: overall };
  },
  staff_calls(q) {
    const { where, args, from, to } = filters(q, 'c');
    const d = db.get();
    const rows = d.prepare(`SELECT c.label, COUNT(*) calls, SUM(c.status='done') done, ROUND(AVG(CASE WHEN c.accepted_at IS NOT NULL THEN (c.accepted_at-c.created_at)/1000.0 END),0) avg_response_sec,
      ROUND(AVG(CASE WHEN c.done_at IS NOT NULL AND c.status='done' THEN (c.done_at-c.created_at)/1000.0 END),0) avg_done_sec
      FROM staff_calls c WHERE c.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY c.label ORDER BY calls DESC`).all(from, to, ...args).map((r) => ({ ...r, label: db.J(r.label, {}).th }));
    const byStaff = d.prepare(`SELECT st.name staff, COUNT(*) handled, ROUND(AVG((c.accepted_at-c.created_at)/1000.0),0) avg_response_sec FROM staff_calls c JOIN staff st ON st.id=c.accepted_by
      WHERE c.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY c.accepted_by ORDER BY handled DESC`).all(from, to, ...args);
    return { columns: [['label', 'ประเภทคำขอ'], ['calls', 'จำนวนครั้ง'], ['done', 'เสร็จสิ้น'], ['avg_response_sec', 'เวลาตอบรับเฉลี่ย (วินาที)'], ['avg_done_sec', 'เวลาจนเสร็จเฉลี่ย (วินาที)']], rows, byStaff };
  },
  table_usage(q) {
    const { where, args, from, to } = filters(q);
    const d = db.get();
    const rows = d.prepare(`SELECT t.code table_code, t.seats, COUNT(s.id) sessions, COALESCE(SUM(s.guests_count),0) guests, ROUND(COALESCE(SUM((MIN(COALESCE(s.closed_at,?),?)-MAX(s.opened_at,?))/60000.0),0),0) used_min,
      ROUND(AVG((s.closed_at-s.opened_at)/60000.0),0) avg_turn_min
      FROM tables t LEFT JOIN table_sessions s ON s.table_id=t.id AND s.status='closed' AND s.closed_at BETWEEN ? AND ? WHERE 1=1 ${q.branch_id ? 'AND t.branch_id=?' : ''} GROUP BY t.id ORDER BY t.code`).all(to, to, from, from, to, ...(q.branch_id ? [Number(q.branch_id)] : []));
    const periodMin = (to - from) / 60000;
    for (const r of rows) r.utilization_pct = periodMin > 0 ? Math.round(r.used_min / periodMin * 1000) / 10 : 0;
    return { columns: [['table_code', 'โต๊ะ'], ['seats', 'ที่นั่ง'], ['sessions', 'จำนวนรอบ'], ['guests', 'ลูกค้า'], ['used_min', 'เวลาใช้งาน (นาที)'], ['avg_turn_min', 'เวลาหมุนเวียนเฉลี่ย (นาที)'], ['utilization_pct', 'อัตราการใช้โต๊ะ (%)']], rows };
  },
  points(q) {
    const { from, to } = filters(q);
    const rows = db.get().prepare(`SELECT type, COUNT(*) count, SUM(points) points FROM point_transactions WHERE created_at BETWEEN ? AND ? GROUP BY type ORDER BY type`).all(from, to);
    return { columns: [['type', 'ประเภท'], ['count', 'จำนวนรายการ'], ['points', 'คะแนน']], rows };
  },
  profit(q) {
    const { where, args, from, to } = filters(q, 'b');
    const d = db.get();
    const rev = d.prepare(`SELECT COALESCE(SUM(b.subtotal),0) revenue FROM bills b WHERE b.status IN ('paid','partially_refunded','refunded') AND b.paid_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}`).get(from, to, ...args).revenue;
    const cost = d.prepare(`SELECT COALESCE(SUM(i.qty*i.unit_cost),0) cost, SUM(i.unit_cost=0) no_cost_lines FROM order_items i JOIN bills b ON b.session_id=i.session_id AND b.status IN ('paid','partially_refunded','refunded')
      WHERE i.status NOT IN ('cancelled','unavailable') AND b.paid_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''}`).get(from, to, ...args);
    const rows = [{ revenue: rev, cost: cost.cost, gross_profit: rev - cost.cost, margin_pct: rev ? Math.round((rev - cost.cost) / rev * 1000) / 10 : 0, lines_without_cost: cost.no_cost_lines || 0 }];
    return { columns: [['revenue', 'รายได้ (ก่อน SC/VAT)', 'money'], ['cost', 'ต้นทุนอาหาร', 'money'], ['gross_profit', 'กำไรขั้นต้น', 'money'], ['margin_pct', 'อัตรากำไร (%)'], ['lines_without_cost', 'รายการที่ยังไม่มีต้นทุน']], rows };
  },
  exceptions(q) {
    const { where, args, from, to } = filters(q, 'a');
    const rows = db.get().prepare(`SELECT a.created_at, a.action, st.name staff, ap.name approver, a.entity, a.entity_id, a.data FROM audit_logs a LEFT JOIN staff st ON st.id=a.staff_id LEFT JOIN staff ap ON ap.id=a.approver_id
      WHERE a.action IN ('order_item.cancelled','order_item.unavailable','payment.refund','discount.apply','checkout.cancel','points.adjust','table.qr_regenerate','bill.void') AND a.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 2000`).all(from, to, ...args)
      .map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    return { columns: [['created_at', 'เวลา'], ['action', 'รายการ'], ['staff', 'พนักงาน'], ['approver', 'ผู้อนุมัติ'], ['entity', 'อ้างอิง'], ['entity_id', 'ID'], ['data', 'รายละเอียด']], rows };
  },
  print_jobs(q) {
    const { where, args, from, to } = filters(q, 'j');
    const rows = db.get().prepare(`SELECT j.id, j.created_at, p.name printer, j.doc_type, j.status, j.attempts, j.error FROM print_jobs j LEFT JOIN printers p ON p.id=j.printer_id WHERE j.created_at BETWEEN ? AND ? ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY j.id DESC LIMIT 2000`).all(from, to, ...args)
      .map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
    return { columns: [['id', 'Job'], ['created_at', 'เวลา'], ['printer', 'เครื่องพิมพ์'], ['doc_type', 'เอกสาร'], ['status', 'สถานะ'], ['attempts', 'ครั้งที่ลอง'], ['error', 'ข้อผิดพลาด']], rows };
  },
};

function run(name, q) {
  const fn = REPORTS[name];
  if (!fn) throw err(404, 'report_not_found', 'ไม่พบรายงาน');
  return fn(q);
}

function cell(row, [key, , type]) { const v = row[key]; return type === 'money' ? money(v) : v; }

function toCsv(rep) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [rep.columns.map((c) => esc(c[1])).join(',')];
  for (const r of rep.rows) lines.push(rep.columns.map((c) => esc(cell(r, c))).join(','));
  return '﻿' + lines.join('\r\n');
}

async function toXlsx(rep, title) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(title).slice(0, 30));
  ws.columns = rep.columns.map((c) => ({ header: c[1], key: c[0], width: Math.max(12, c[1].length + 4), style: c[2] === 'money' ? { numFmt: '#,##0.00' } : {} }));
  ws.getRow(1).font = { bold: true };
  for (const r of rep.rows) ws.addRow(Object.fromEntries(rep.columns.map((c) => [c[0], cell(r, c)])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function toPdf(rep, title, subtitle) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', layout: rep.columns.length > 5 ? 'landscape' : 'portrait', margin: 36 });
  const fontDir = path.join(__dirname, '..', 'assets', 'fonts');
  doc.registerFont('th', path.join(fontDir, 'Sarabun-Regular.ttf'));
  doc.registerFont('thb', path.join(fontDir, 'Sarabun-Bold.ttf'));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  doc.font('thb').fontSize(16).text(title);
  doc.font('th').fontSize(10).fillColor('#555').text(subtitle).moveDown(0.6).fillColor('#000');
  const W = doc.page.width - 72;
  const cw = W / rep.columns.length;
  const row = (vals, bold) => {
    if (doc.y > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    let h = 0;
    vals.forEach((v, i) => { const t = String(v ?? ''); h = Math.max(h, doc.font(bold ? 'thb' : 'th').fontSize(9).heightOfString(t, { width: cw - 6 })); });
    vals.forEach((v, i) => doc.font(bold ? 'thb' : 'th').fontSize(9).text(String(v ?? ''), 36 + i * cw + 3, y, { width: cw - 6, align: typeof v === 'number' ? 'right' : 'left' }));
    doc.y = y + h + 4; doc.x = 36;
    doc.moveTo(36, doc.y - 2).lineTo(36 + W, doc.y - 2).strokeColor('#ddd').stroke();
  };
  row(rep.columns.map((c) => c[1]), true);
  for (const r of rep.rows) row(rep.columns.map((c) => { const v = cell(r, c); return c[2] === 'money' ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 }) : v; }), false);
  if (!rep.rows.length) doc.font('th').text('ไม่มีข้อมูลในช่วงเวลาที่เลือก');
  doc.end();
  return done;
}

module.exports = { REPORTS, run, toCsv, toXlsx, toPdf, tzOffsetMin };
