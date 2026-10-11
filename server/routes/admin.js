'use strict';
// Back-office API: restaurant, branches, floor plan, packages, menu, members, promotions, staff, themes, media, printers, reports.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const { err, now, i18nInput, tr, int } = require('../lib/util');
const { sanitizeHtml } = require('../lib/sanitize');
const auth = require('../auth');
const pricing = require('../services/pricing');
const menu = require('../services/menu');
const members = require('../services/members');
const calls = require('../services/calls');
const theme = require('../services/theme');
const media = require('../services/media');
const printing = require('../services/printing');
const reports = require('../services/reports');
const docs = require('../print/documents');
const { renderDoc } = require('../print/render');
const fonts = require('../print/fonts');
const { branchSettings, DEFAULT_SETTINGS, merge } = require('../services/settings');
const rt = require('../realtime');

const r = express.Router();
const P = auth.requireStaff;
const SET = P('settings.manage');
const MENU = P('menu.manage');
const d = () => db.get();
const restaurantId = () => d().prepare('SELECT id FROM restaurants ORDER BY id LIMIT 1').get().id;
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const nint = (v) => (v === '' || v == null ? null : int(v, null));
const timeStr = (v) => (v && /^\d{2}:\d{2}$/.test(v) ? v : null);
const audit = (req, action, entity, id, data) => auth.auditReq(req, action, entity, id, data);
function exists(table, id, branchScoped = false, req = null) {
  const row = d().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!row) throw err(404, 'not_found', 'ไม่พบข้อมูล');
  if (branchScoped && row.branch_id != null && req && row.branch_id !== req.branchId) throw err(404, 'not_found', 'ไม่พบข้อมูล');
  return row;
}

r.get('/bootstrap', P(), (req, res) => {
  const rest = d().prepare('SELECT * FROM restaurants ORDER BY id LIMIT 1').get();
  res.json({
    staff: auth.publicStaff(req.staff), branch_id: req.branchId,
    restaurant: { ...rest, name: db.J(rest.name, {}), contact: db.J(rest.contact, {}) },
    branches: d().prepare('SELECT * FROM branches ORDER BY id').all().map(branchOut),
    settings: branchSettings(req.branchId), default_settings: DEFAULT_SETTINGS,
    permissions: auth.PERMISSIONS, doc_types: docs.DOC_TYPES, media_kinds: media.RECOMMENDED,
    default_theme: theme.DEFAULT_THEME, default_print_template: docs.DEFAULT_TEMPLATE, reports: Object.keys(reports.REPORTS),
  });
});

// ---------- restaurant & branches ----------
function branchOut(b) { return { ...b, name: db.J(b.name, {}), address: db.J(b.address, {}), open_hours: db.J(b.open_hours, []), holidays: db.J(b.holidays, []), settings: undefined, active: !!b.active }; }
r.put('/restaurant', SET, (req, res) => {
  const b = req.body;
  d().prepare('UPDATE restaurants SET name=?, tax_id=?, phone=?, contact=?, logo_asset_id=? WHERE id=?').run(JSON.stringify(i18nInput(b.name)), b.tax_id || null, b.phone || null, JSON.stringify(b.contact || {}), nint(b.logo_asset_id), restaurantId());
  audit(req, 'restaurant.update', 'restaurant', restaurantId());
  res.json({ ok: true });
});
function branchFields(b) {
  return [JSON.stringify(i18nInput(b.name)), JSON.stringify(i18nInput(b.address)), b.phone || null, b.tax_id || null, JSON.stringify(Array.isArray(b.open_hours) ? b.open_hours : []), JSON.stringify(Array.isArray(b.holidays) ? b.holidays : []), nint(b.banner_asset_id), nint(b.banner_mobile_asset_id), nint(b.logo_asset_id), b.active === undefined ? 1 : bool(b.active)];
}
r.post('/branches', P('settings.manage', 'staff.manage'), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(code)) throw err(400, 'invalid_code', 'รหัสสาขาต้องเป็น A-Z, 0-9 (2-12 ตัว)');
  const id = d().prepare('INSERT INTO branches(restaurant_id, code, name, address, phone, tax_id, open_hours, holidays, banner_asset_id, banner_mobile_asset_id, logo_asset_id, active, settings, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(restaurantId(), code, ...branchFields(req.body), '{}', now()).lastInsertRowid;
  // copy defaults: payment methods & call types are global (branch_id NULL); theme per branch
  theme.saveTheme(id, { name: 'Default', settings: {}, activate: true });
  audit(req, 'branch.create', 'branch', id, { code });
  res.status(201).json({ id });
});
r.put('/branches/:id', SET, (req, res) => {
  exists('branches', req.params.id);
  d().prepare('UPDATE branches SET name=?, address=?, phone=?, tax_id=?, open_hours=?, holidays=?, banner_asset_id=?, banner_mobile_asset_id=?, logo_asset_id=?, active=? WHERE id=?').run(...branchFields(req.body), req.params.id);
  audit(req, 'branch.update', 'branch', Number(req.params.id));
  res.json({ ok: true });
});
r.put('/settings', SET, (req, res) => {
  const cur = branchSettings(req.branchId);
  const inc = req.body || {};
  const next = merge(cur, inc);
  // validation
  const num = (v, a, b, n) => { if (!(Number(v) >= a && Number(v) <= b)) throw err(400, 'invalid_setting', `${n} ไม่ถูกต้อง`); return Number(v); };
  next.vat_rate = num(next.vat_rate, 0, 30, 'VAT'); next.service_rate = num(next.service_rate, 0, 30, 'Service Charge');
  next.call_cooldown_sec = num(next.call_cooldown_sec, 0, 3600, 'ระยะห่างการเรียกพนักงาน');
  next.max_upload_mb = num(next.max_upload_mb, 1, 50, 'ขนาดไฟล์สูงสุด');
  next.discount_approval_over_percent = num(next.discount_approval_over_percent, 0, 100, 'เกณฑ์อนุมัติส่วนลด');
  if (!Array.isArray(inc.time_alerts_min) && inc.time_alerts_min !== undefined) throw err(400, 'invalid_setting', 'การแจ้งเตือนเวลาไม่ถูกต้อง');
  if (inc.time_alerts_min) next.time_alerts_min = inc.time_alerts_min.map(Number).filter((x) => x > 0 && x <= 600);
  if (inc.require_manager_approval) next.require_manager_approval = inc.require_manager_approval.filter((x) => DEFAULT_SETTINGS.require_manager_approval.includes(x));
  if (inc.languages) next.languages = inc.languages.filter((x) => ['th', 'en', 'zh'].includes(x));
  next.kds_thresholds = { warn: num(next.kds_thresholds.warn, 1, 240, 'เกณฑ์สีเหลือง'), danger: num(next.kds_thresholds.danger, 1, 480, 'เกณฑ์สีแดง') };
  if (next.kds_thresholds.danger <= next.kds_thresholds.warn) throw err(400, 'invalid_setting', 'เกณฑ์สีแดงต้องมากกว่าสีเหลือง');
  next.points = { expiry_days: num(next.points.expiry_days, 0, 3650, 'อายุคะแนน'), signup_bonus: num(next.points.signup_bonus, 0, 100000, 'โบนัสสมัคร'), birthday_bonus: num(next.points.birthday_bonus, 0, 100000, 'โบนัสวันเกิด') };
  next.terms = Object.fromEntries(['th', 'en', 'zh'].map((l) => [l, sanitizeHtml(next.terms[l] || '')]));
  for (const k of ['qr_ticket_footer', 'receipt_footer', 'member_signup_text']) next[k] = i18nInput(next[k]);
  if (!['cleaning', 'available'].includes(next.after_payment_table_status)) next.after_payment_table_status = 'cleaning';
  try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw err(400, 'invalid_setting', 'Timezone ไม่ถูกต้อง'); }
  d().prepare('UPDATE branches SET settings=? WHERE id=?').run(JSON.stringify(next), req.branchId);
  audit(req, 'settings.update', 'branch', req.branchId, { keys: Object.keys(inc) });
  res.json({ settings: branchSettings(req.branchId) });
});

// ---------- zones & tables (floor plan) ----------
r.get('/floor', P(), (req, res) => res.json({ zones: d().prepare('SELECT * FROM zones WHERE branch_id=? ORDER BY sort, id').all(req.branchId), tables: d().prepare('SELECT * FROM tables WHERE branch_id=? ORDER BY code').all(req.branchId) }));
r.post('/zones', SET, (req, res) => {
  const id = d().prepare('INSERT INTO zones(branch_id, name, kind, sort, width, height) VALUES(?,?,?,?,?,?)').run(req.branchId, String(req.body.name || 'โซนใหม่').slice(0, 40), ['normal', 'vip', 'outdoor'].includes(req.body.kind) ? req.body.kind : 'normal', int(req.body.sort), int(req.body.width, 1000), int(req.body.height, 600)).lastInsertRowid;
  res.status(201).json({ id });
});
r.put('/zones/:id', SET, (req, res) => {
  exists('zones', req.params.id, true, req);
  d().prepare('UPDATE zones SET name=?, kind=?, sort=?, width=?, height=? WHERE id=?').run(String(req.body.name).slice(0, 40), ['normal', 'vip', 'outdoor'].includes(req.body.kind) ? req.body.kind : 'normal', int(req.body.sort), int(req.body.width, 1000), int(req.body.height, 600), req.params.id);
  res.json({ ok: true });
});
r.delete('/zones/:id', SET, (req, res) => {
  exists('zones', req.params.id, true, req);
  if (d().prepare('SELECT 1 FROM tables WHERE zone_id=?').get(req.params.id)) throw err(409, 'zone_has_tables', 'ย้ายหรือลบโต๊ะในโซนก่อน');
  d().prepare('DELETE FROM zones WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
function tableFields(b) {
  const code = String(b.code || '').trim();
  if (!code || code.length > 12) throw err(400, 'invalid_code', 'กรุณาระบุหมายเลขโต๊ะ (ไม่เกิน 12 ตัวอักษร)');
  return [nint(b.zone_id), code, ['square', 'rect', 'round'].includes(b.shape) ? b.shape : 'square', Math.max(1, Math.min(50, int(b.seats, 4))), int(b.x, 20), int(b.y, 20), Math.max(40, int(b.w, 90)), Math.max(40, int(b.h, 90)), int(b.rotation, 0)];
}
r.post('/tables', SET, (req, res) => {
  try {
    const id = d().prepare('INSERT INTO tables(branch_id, zone_id, code, shape, seats, x, y, w, h, rotation) VALUES(?,?,?,?,?,?,?,?,?,?)').run(req.branchId, ...tableFields(req.body)).lastInsertRowid;
    audit(req, 'table.create', 'table', id, { code: req.body.code });
    rt.toStaff(req.branchId, 'tables:changed', {});
    res.status(201).json({ id });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'หมายเลขโต๊ะซ้ำ'); throw e; }
});
r.put('/tables/layout', SET, (req, res) => {
  const list = Array.isArray(req.body.tables) ? req.body.tables : [];
  const up = d().prepare('UPDATE tables SET x=?, y=?, w=?, h=?, rotation=?, zone_id=? WHERE id=? AND branch_id=?');
  d().transaction(() => { for (const t of list) up.run(int(t.x), int(t.y), Math.max(40, int(t.w, 90)), Math.max(40, int(t.h, 90)), int(t.rotation), nint(t.zone_id), t.id, req.branchId); })();
  audit(req, 'floor.layout', 'branch', req.branchId, { count: list.length });
  rt.toStaff(req.branchId, 'tables:changed', {});
  res.json({ ok: true });
});
r.put('/tables/:id', SET, (req, res) => {
  exists('tables', req.params.id, true, req);
  try { d().prepare('UPDATE tables SET zone_id=?, code=?, shape=?, seats=?, x=?, y=?, w=?, h=?, rotation=? WHERE id=?').run(...tableFields(req.body), req.params.id); } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'หมายเลขโต๊ะซ้ำ'); throw e; }
  rt.toStaff(req.branchId, 'tables:changed', {});
  res.json({ ok: true });
});
r.delete('/tables/:id', SET, (req, res) => {
  const t = exists('tables', req.params.id, true, req);
  if (d().prepare('SELECT 1 FROM table_sessions WHERE table_id=?').get(t.id)) { d().prepare("UPDATE tables SET status='disabled' WHERE id=?").run(t.id); audit(req, 'table.disable', 'table', t.id); return res.json({ ok: true, disabled: true, message: 'โต๊ะมีประวัติการใช้งาน จึงปิดใช้งานแทนการลบ' }); }
  d().prepare('DELETE FROM tables WHERE id=?').run(t.id);
  audit(req, 'table.delete', 'table', t.id, { code: t.code });
  rt.toStaff(req.branchId, 'tables:changed', {});
  res.json({ ok: true });
});

// ---------- packages ----------
function packageOut(p) {
  return { ...p, name: db.J(p.name, {}), description: db.J(p.description, {}), days: db.J(p.days, []), leftover_policy: db.J(p.leftover_policy, {}), overtime_fee: db.J(p.overtime_fee, {}), active: !!p.active, service_charge_enabled: !!p.service_charge_enabled, vat_enabled: !!p.vat_enabled, round_per_guest: !!p.round_per_guest,
    cover: p.cover_asset_id ? `/media/${p.cover_asset_id}` : null, prices: pricing.packagePrices(p.id), menu_count: d().prepare('SELECT COUNT(*) c FROM menu_item_packages WHERE package_id=?').get(p.id).c };
}
r.get('/packages', P(), (req, res) => res.json({ packages: d().prepare('SELECT * FROM buffet_packages WHERE branch_id IS NULL OR branch_id=? ORDER BY sort, id').all(req.branchId).map(packageOut) }));
function packageFields(b) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) throw err(400, 'invalid_code', 'รหัสแพ็กเกจไม่ถูกต้อง');
  const dur = int(b.duration_min, 120); if (!(dur >= 15 && dur <= 1440)) throw err(400, 'invalid_duration', 'ระยะเวลาไม่ถูกต้อง');
  const days = Array.isArray(b.days) ? b.days.map(Number).filter((x) => x >= 0 && x <= 6) : [0, 1, 2, 3, 4, 5, 6];
  const ot = b.overtime_fee || {};
  const lo = b.leftover_policy || {};
  return [b.branch_scope === 'all' ? null : undefined, code, JSON.stringify(i18nInput(b.name)), JSON.stringify(i18nInput(b.description)), nint(b.cover_asset_id), /^#[0-9a-fA-F]{3,8}$/.test(b.color || '') ? b.color : '#0b2a6f',
    dur, Math.max(0, int(b.order_cutoff_min)), timeStr(b.service_start), timeStr(b.service_end), JSON.stringify(days), Math.max(0, int(b.max_per_round)), bool(b.round_per_guest ?? 1), Math.max(0, int(b.round_interval_min)), Math.max(0, int(b.max_per_item_per_guest)),
    JSON.stringify({ text: i18nInput(lo.text), fee_per_unit: Math.max(0, int(lo.fee_per_unit)), unit: String(lo.unit || '').slice(0, 20) }), JSON.stringify({ block_min: Math.max(0, int(ot.block_min)), amount_per_guest: Math.max(0, int(ot.amount_per_guest)) }),
    bool(b.service_charge_enabled ?? 1), bool(b.vat_enabled ?? 1), bool(b.active ?? 1), int(b.sort)];
}
r.post('/packages', MENU, (req, res) => {
  const f = packageFields(req.body); f[0] = req.body.branch_scope === 'all' ? null : req.branchId;
  try {
    const id = d().prepare(`INSERT INTO buffet_packages(branch_id, code, name, description, cover_asset_id, color, duration_min, order_cutoff_min, service_start, service_end, days, max_per_round, round_per_guest, round_interval_min, max_per_item_per_guest, leftover_policy, overtime_fee, service_charge_enabled, vat_enabled, active, sort, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...f, now()).lastInsertRowid;
    if (Array.isArray(req.body.prices)) savePrices(id, req.body.prices);
    audit(req, 'package.create', 'package', id, { code: f[1] });
    res.status(201).json({ package: packageOut(d().prepare('SELECT * FROM buffet_packages WHERE id=?').get(id)) });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'รหัสซ้ำ'); throw e; }
});
r.put('/packages/:id', MENU, (req, res) => {
  exists('buffet_packages', req.params.id, true, req);
  const f = packageFields(req.body); f.shift();
  d().prepare(`UPDATE buffet_packages SET code=?, name=?, description=?, cover_asset_id=?, color=?, duration_min=?, order_cutoff_min=?, service_start=?, service_end=?, days=?, max_per_round=?, round_per_guest=?, round_interval_min=?, max_per_item_per_guest=?, leftover_policy=?, overtime_fee=?, service_charge_enabled=?, vat_enabled=?, active=?, sort=? WHERE id=?`).run(...f, req.params.id);
  if (Array.isArray(req.body.prices)) savePrices(Number(req.params.id), req.body.prices);
  audit(req, 'package.update', 'package', Number(req.params.id));
  res.json({ package: packageOut(d().prepare('SELECT * FROM buffet_packages WHERE id=?').get(req.params.id)) });
});
function savePrices(packageId, list) {
  const rules = list.map((p, i) => ({ id: p.id ? Number(p.id) : null, code: String(p.code || '').trim().toLowerCase(), label: i18nInput(p.label), rule_type: ['age', 'height', 'none'].includes(p.rule_type) ? p.rule_type : 'none',
    min_value: p.min_value === '' || p.min_value == null ? null : Number(p.min_value), max_value: p.max_value === '' || p.max_value == null ? null : Number(p.max_value), price: int(p.price, -1), priority: int(p.priority), is_default: !!p.is_default, sort: i }));
  const errors = pricing.validatePriceRules(rules);
  if (!rules.length) errors.push('ต้องมีราคาอย่างน้อย 1 รายการ');
  if (errors.length) throw err(400, 'invalid_prices', errors.join(' • '), { errors });
  d().transaction(() => {
    const keep = [];
    for (const p of rules) {
      const vals = [p.code, JSON.stringify(p.label), p.rule_type, p.min_value, p.max_value, p.price, p.priority, p.is_default ? 1 : 0, p.sort];
      if (p.id && d().prepare('SELECT 1 FROM package_prices WHERE id=? AND package_id=?').get(p.id, packageId)) { d().prepare('UPDATE package_prices SET code=?, label=?, rule_type=?, min_value=?, max_value=?, price=?, priority=?, is_default=?, sort=? WHERE id=?').run(...vals, p.id); keep.push(p.id); }
      else keep.push(d().prepare('INSERT INTO package_prices(package_id, code, label, rule_type, min_value, max_value, price, priority, is_default, sort) VALUES(?,?,?,?,?,?,?,?,?,?)').run(packageId, ...vals).lastInsertRowid);
    }
    // existing guests keep their snapshot unit_price; price_id references are cleared for removed rules
    const removed = d().prepare(`SELECT id FROM package_prices WHERE package_id=? AND id NOT IN (${keep.map(() => '?').join(',')})`).all(packageId, ...keep);
    for (const x of removed) { d().prepare('UPDATE session_guests SET price_id=NULL WHERE price_id=?').run(x.id); d().prepare('DELETE FROM package_prices WHERE id=?').run(x.id); }
  })();
}
r.post('/packages/validate-prices', MENU, (req, res) => res.json({ errors: pricing.validatePriceRules(req.body.prices || []) }));
r.delete('/packages/:id', MENU, (req, res) => {
  const p = exists('buffet_packages', req.params.id, true, req);
  if (d().prepare('SELECT 1 FROM session_guests WHERE package_id=?').get(p.id)) { d().prepare('UPDATE buffet_packages SET active=0 WHERE id=?').run(p.id); return res.json({ ok: true, deactivated: true, message: 'แพ็กเกจมีประวัติการขาย จึงหยุดขายแทนการลบ' }); }
  d().prepare('DELETE FROM buffet_packages WHERE id=?').run(p.id);
  audit(req, 'package.delete', 'package', p.id, { code: p.code });
  res.json({ ok: true });
});
r.get('/packages/:id/menu', P(), (req, res) => res.json({ items: d().prepare('SELECT menu_item_id, extra_price FROM menu_item_packages WHERE package_id=?').all(req.params.id) }));
r.put('/packages/:id/menu', MENU, (req, res) => {
  exists('buffet_packages', req.params.id, true, req);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  d().transaction(() => {
    d().prepare('DELETE FROM menu_item_packages WHERE package_id=?').run(req.params.id);
    const ins = d().prepare('INSERT OR IGNORE INTO menu_item_packages(menu_item_id, package_id, extra_price) VALUES(?,?,?)');
    for (const i of items) ins.run(Number(i.menu_item_id), Number(req.params.id), i.extra_price === '' || i.extra_price == null ? null : int(i.extra_price));
  })();
  audit(req, 'package.menu', 'package', Number(req.params.id), { count: items.length });
  res.json({ ok: true });
});

// ---------- categories ----------
r.get('/categories', P(), (req, res) => res.json({ categories: d().prepare('SELECT * FROM categories WHERE branch_id IS NULL OR branch_id=? ORDER BY sort, id').all(req.branchId).map((c) => ({ ...c, name: db.J(c.name, {}), active: !!c.active })) }));
r.post('/categories', MENU, (req, res) => res.status(201).json({ id: d().prepare('INSERT INTO categories(branch_id, name, sort, active) VALUES(?,?,?,?)').run(req.body.branch_scope === 'branch' ? req.branchId : null, JSON.stringify(i18nInput(req.body.name)), int(req.body.sort), bool(req.body.active ?? 1)).lastInsertRowid }));
r.put('/categories/:id', MENU, (req, res) => { exists('categories', req.params.id, true, req); d().prepare('UPDATE categories SET name=?, sort=?, active=? WHERE id=?').run(JSON.stringify(i18nInput(req.body.name)), int(req.body.sort), bool(req.body.active ?? 1), req.params.id); res.json({ ok: true }); });
r.put('/categories-order', MENU, (req, res) => { const up = d().prepare('UPDATE categories SET sort=? WHERE id=?'); d().transaction(() => (req.body.ids || []).forEach((id, i) => up.run(i, id)))(); res.json({ ok: true }); });
r.delete('/categories/:id', MENU, (req, res) => {
  exists('categories', req.params.id, true, req);
  if (d().prepare('SELECT 1 FROM menu_items WHERE category_id=?').get(req.params.id)) throw err(409, 'category_in_use', 'ย้ายเมนูออกจากหมวดหมู่ก่อนลบ');
  d().prepare('DELETE FROM categories WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// ---------- menu items ----------
r.get('/menu-items', P(), (req, res) => {
  const rows = d().prepare('SELECT * FROM menu_items WHERE branch_id IS NULL OR branch_id=? ORDER BY category_id, sort, id').all(req.branchId);
  const opts = menu.optionsFor(rows.map((x) => x.id));
  const pk = d().prepare('SELECT * FROM menu_item_packages').all();
  res.json({ items: rows.map((m) => ({ ...menu.itemRow(m), options: opts[m.id] || [], packages: pk.filter((x) => x.menu_item_id === m.id).map((x) => ({ package_id: x.package_id, extra_price: x.extra_price })) })) });
});
function itemFields(b) {
  const name = i18nInput(b.name);
  if (!name.th && !name.en) throw err(400, 'name_required', 'กรุณาระบุชื่อเมนู');
  return [nint(b.category_id), b.code ? String(b.code).slice(0, 20) : null, JSON.stringify(name), JSON.stringify(i18nInput(b.description)), JSON.stringify(i18nInput(b.ingredients)), JSON.stringify(Array.isArray(b.allergens) ? b.allergens.map((x) => String(x).slice(0, 30)).slice(0, 20) : []),
    nint(b.image_asset_id), Math.max(0, int(b.extra_price)), Math.max(0, int(b.cost)), Math.max(0, int(b.max_per_order)), Math.max(0, int(b.max_per_guest)), Math.max(0, int(b.max_per_table)), Math.max(0, int(b.prep_minutes, 10)),
    nint(b.station_id), nint(b.printer_id), ['available', 'out', 'stopped'].includes(b.status) ? b.status : 'available', timeStr(b.available_from), timeStr(b.available_to), JSON.stringify(Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string').slice(0, 10) : []), int(b.sort)];
}
function saveItemRelations(id, b) {
  if (Array.isArray(b.packages)) {
    d().prepare('DELETE FROM menu_item_packages WHERE menu_item_id=?').run(id);
    for (const p of b.packages) d().prepare('INSERT OR IGNORE INTO menu_item_packages(menu_item_id, package_id, extra_price) VALUES(?,?,?)').run(id, Number(p.package_id ?? p), p.extra_price === '' || p.extra_price == null ? null : int(p.extra_price));
  }
  if (Array.isArray(b.options)) {
    d().prepare('DELETE FROM menu_options WHERE menu_item_id=?').run(id);
    b.options.forEach((o, i) => {
      const choices = (o.choices || []).map((c, j) => ({ id: String(c.id || `c${j + 1}`).slice(0, 20), name: i18nInput(c.name), price: Math.max(0, int(c.price)) }));
      if (!choices.length) throw err(400, 'option_choices', 'ตัวเลือกต้องมีอย่างน้อย 1 รายการ');
      d().prepare('INSERT INTO menu_options(menu_item_id, name, type, required, max_select, choices, sort) VALUES(?,?,?,?,?,?,?)').run(id, JSON.stringify(i18nInput(o.name)), o.type === 'multi' ? 'multi' : 'single', bool(o.required), Math.max(0, int(o.max_select)), JSON.stringify(choices), i);
    });
  }
}
r.post('/menu-items', MENU, (req, res) => {
  const id = d().transaction(() => {
    const nid = d().prepare(`INSERT INTO menu_items(branch_id, category_id, code, name, description, ingredients, allergens, image_asset_id, extra_price, cost, max_per_order, max_per_guest, max_per_table, prep_minutes, station_id, printer_id, status, available_from, available_to, tags, sort, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.body.branch_scope === 'branch' ? req.branchId : null, ...itemFields(req.body), now()).lastInsertRowid;
    saveItemRelations(nid, req.body);
    return nid;
  })();
  audit(req, 'menu.create', 'menu_item', id);
  res.status(201).json({ id });
});
r.put('/menu-items/:id', MENU, (req, res) => {
  exists('menu_items', req.params.id, true, req);
  d().transaction(() => {
    d().prepare(`UPDATE menu_items SET category_id=?, code=?, name=?, description=?, ingredients=?, allergens=?, image_asset_id=?, extra_price=?, cost=?, max_per_order=?, max_per_guest=?, max_per_table=?, prep_minutes=?, station_id=?, printer_id=?, status=?, available_from=?, available_to=?, tags=?, sort=? WHERE id=?`).run(...itemFields(req.body), req.params.id);
    saveItemRelations(Number(req.params.id), req.body);
  })();
  audit(req, 'menu.update', 'menu_item', Number(req.params.id));
  rt.toStaff(req.branchId, 'menu:changed', { id: Number(req.params.id) });
  res.json({ ok: true });
});
r.patch('/menu-items/:id/status', P('menu.manage', 'kitchen.update'), (req, res) => {
  const st = req.body.status; if (!['available', 'out', 'stopped'].includes(st)) throw err(400, 'invalid_status', 'สถานะไม่ถูกต้อง');
  exists('menu_items', req.params.id, true, req);
  d().prepare('UPDATE menu_items SET status=? WHERE id=?').run(st, req.params.id);
  audit(req, 'menu.status', 'menu_item', Number(req.params.id), { status: st });
  rt.toStaff(req.branchId, 'menu:changed', { id: Number(req.params.id) });
  res.json({ ok: true });
});
r.delete('/menu-items/:id', MENU, (req, res) => {
  exists('menu_items', req.params.id, true, req);
  if (d().prepare('SELECT 1 FROM order_items WHERE menu_item_id=?').get(req.params.id)) { d().prepare("UPDATE menu_items SET status='stopped' WHERE id=?").run(req.params.id); return res.json({ ok: true, stopped: true, message: 'เมนูมีประวัติการสั่ง จึงหยุดขายแทนการลบ' }); }
  d().prepare('DELETE FROM menu_items WHERE id=?').run(req.params.id);
  audit(req, 'menu.delete', 'menu_item', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- simple CRUD resources ----------
function crud(pathName, table, perm, { fields, out = (x) => x, branch = true, order = 'sort, id', onDelete }) {
  r.get(`/${pathName}`, P(), (req, res) => res.json({ items: d().prepare(`SELECT * FROM ${table} ${branch ? 'WHERE branch_id IS NULL OR branch_id=?' : ''} ORDER BY ${order}`).all(...(branch ? [req.branchId] : [])).map(out) }));
  r.post(`/${pathName}`, perm, (req, res) => {
    const f = fields(req.body, req);
    const cols = Object.keys(f);
    try {
      const id = d().prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(f)).lastInsertRowid;
      audit(req, `${pathName}.create`, table, id);
      res.status(201).json({ id });
    } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'รหัสซ้ำ'); throw e; }
  });
  r.put(`/${pathName}/:id`, perm, (req, res) => {
    exists(table, req.params.id, branch, req);
    const f = fields(req.body, req, true);
    delete f.branch_id; delete f.restaurant_id; delete f.created_at;
    try { d().prepare(`UPDATE ${table} SET ${Object.keys(f).map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(f), req.params.id); } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'รหัสซ้ำ'); throw e; }
    audit(req, `${pathName}.update`, table, Number(req.params.id));
    res.json({ ok: true });
  });
  r.delete(`/${pathName}/:id`, perm, (req, res) => {
    const row = exists(table, req.params.id, branch, req);
    if (onDelete && onDelete(row) === false) return res.json({ ok: true, deactivated: true, message: 'มีการใช้งานแล้ว จึงปิดใช้งานแทนการลบ' });
    d().prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    audit(req, `${pathName}.delete`, table, Number(req.params.id));
    res.json({ ok: true });
  });
}
crud('stations', 'kitchen_stations', SET, {
  fields: (b, req) => ({ branch_id: req.branchId, code: String(b.code || '').slice(0, 20) || 'ST', name: String(b.name || 'สถานี').slice(0, 40), color: /^#[0-9a-f]{3,8}$/i.test(b.color || '') ? b.color : '#334155', printer_id: nint(b.printer_id), sort: int(b.sort), active: bool(b.active ?? 1) }),
  onDelete: (row) => { if (d().prepare('SELECT 1 FROM order_items WHERE station_id=?').get(row.id)) { d().prepare('UPDATE kitchen_stations SET active=0 WHERE id=?').run(row.id); d().prepare('UPDATE menu_items SET station_id=NULL WHERE station_id=?').run(row.id); return false; } d().prepare('UPDATE menu_items SET station_id=NULL WHERE station_id=?').run(row.id); return true; },
});
crud('call-types', 'staff_call_types', SET, {
  fields: (b, req) => ({ branch_id: b.branch_scope === 'branch' ? req.branchId : null, name: JSON.stringify(i18nInput(b.name)), icon: String(b.icon || '🔔').slice(0, 8), color: /^#[0-9a-f]{3,8}$/i.test(b.color || '') ? b.color : '#0b2a6f', image_asset_id: nint(b.image_asset_id), sort: int(b.sort), active: bool(b.active ?? 1), is_bill: bool(b.is_bill) }),
  out: (c) => ({ ...c, name: db.J(c.name, {}), active: !!c.active, is_bill: !!c.is_bill, image: c.image_asset_id ? `/media/${c.image_asset_id}` : null }),
  onDelete: (row) => { if (d().prepare('SELECT 1 FROM staff_calls WHERE type_id=?').get(row.id)) { d().prepare('UPDATE staff_call_types SET active=0 WHERE id=?').run(row.id); return false; } return true; },
});
crud('payment-methods', 'payment_methods', SET, {
  fields: (b, req) => {
    if (!['cash', 'promptpay', 'transfer', 'card', 'other'].includes(b.type)) throw err(400, 'invalid_type', 'ประเภทไม่ถูกต้อง');
    const cfg = {}; if (b.type === 'promptpay') { const id = String((b.config || {}).promptpay_id || '').replace(/\D/g, ''); if (!/^(\d{10}|\d{13}|\d{15})$/.test(id)) throw err(400, 'invalid_promptpay', 'หมายเลขพร้อมเพย์ต้องเป็นเบอร์โทร 10 หลัก / เลขบัตร 13 หลัก / e-wallet 15 หลัก'); cfg.promptpay_id = id; }
    return { branch_id: b.branch_scope === 'branch' ? req.branchId : null, code: String(b.code || b.type).slice(0, 20), name: String(b.name || b.type).slice(0, 40), type: b.type, config: JSON.stringify(cfg), active: bool(b.active ?? 1), sort: int(b.sort) };
  },
  out: (m) => ({ ...m, config: db.J(m.config, {}), active: !!m.active }),
  onDelete: (row) => { if (d().prepare('SELECT 1 FROM payments WHERE method_id=?').get(row.id)) { d().prepare('UPDATE payment_methods SET active=0 WHERE id=?').run(row.id); return false; } return true; },
});
crud('tiers', 'tiers', P('member.manage', 'settings.manage'), {
  branch: false, order: 'min_spent, sort',
  fields: (b) => ({ restaurant_id: restaurantId(), code: String(b.code || '').toUpperCase().slice(0, 20) || 'TIER', name: JSON.stringify(i18nInput(b.name)), color: /^#[0-9a-f]{3,8}$/i.test(b.color || '') ? b.color : '#b08d57', min_spent: Math.max(0, int(b.min_spent)), min_points: Math.max(0, int(b.min_points)), baht_per_point: Math.max(1, int(b.baht_per_point, 50)), multiplier: Math.max(0, Number(b.multiplier) || 1), image_asset_id: nint(b.image_asset_id), benefits: JSON.stringify(i18nInput(b.benefits)), sort: int(b.sort) }),
  out: (t) => ({ ...t, name: db.J(t.name, {}), benefits: db.J(t.benefits, {}), image: t.image_asset_id ? `/media/${t.image_asset_id}` : null }),
  onDelete: (row) => { if (d().prepare('SELECT 1 FROM members WHERE tier_id=?').get(row.id)) throw err(409, 'tier_in_use', 'มีสมาชิกอยู่ในระดับนี้'); return true; },
});
crud('promotions', 'promotions', P('member.manage', 'settings.manage'), {
  branch: false, order: 'priority DESC, id',
  fields: (b, req, update) => {
    if (!['discount_amount', 'discount_percent', 'free_item', 'package_upgrade'].includes(b.type)) throw err(400, 'invalid_type', 'ประเภทโปรโมชั่นไม่ถูกต้อง');
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw err(400, 'invalid_code', 'รหัสโปรโมชั่นต้องเป็น A-Z, 0-9 (3-20 ตัว)');
    if (b.type === 'discount_percent' && !(int(b.value) > 0 && int(b.value) <= 10000)) throw err(400, 'invalid_value', 'เปอร์เซ็นต์ส่วนลดไม่ถูกต้อง');
    if (b.type === 'free_item' && !nint(b.menu_item_id)) throw err(400, 'menu_required', 'เลือกเมนูที่แจกฟรี');
    if (b.type === 'package_upgrade' && !(nint(b.from_package_id) && nint(b.to_package_id))) throw err(400, 'package_required', 'เลือกแพ็กเกจต้นทาง/ปลายทาง');
    const f = { restaurant_id: restaurantId(), code, name: JSON.stringify(i18nInput(b.name)), description: JSON.stringify(i18nInput(b.description)), image_asset_id: nint(b.image_asset_id), type: b.type, value: Math.max(0, int(b.value)), menu_item_id: nint(b.menu_item_id), from_package_id: nint(b.from_package_id), to_package_id: nint(b.to_package_id),
      points_cost: Math.max(0, int(b.points_cost)), members_only: bool(b.members_only ?? 1), tier_ids: JSON.stringify((b.tier_ids || []).map(Number)), branch_ids: JSON.stringify((b.branch_ids || []).map(Number)), days: JSON.stringify((b.days || []).map(Number)), time_from: timeStr(b.time_from), time_to: timeStr(b.time_to),
      starts_at: b.starts_at ? Number(b.starts_at) : null, ends_at: b.ends_at ? Number(b.ends_at) : null, total_quota: Math.max(0, int(b.total_quota)), per_member_quota: Math.max(0, int(b.per_member_quota)), min_spend: Math.max(0, int(b.min_spend)), priority: int(b.priority), stackable: bool(b.stackable), code_valid_days: Math.max(1, int(b.code_valid_days, 30)), active: bool(b.active ?? 1) };
    if (!update) f.created_at = now();
    return f;
  },
  out: members.promoOut,
  onDelete: (row) => { if (d().prepare('SELECT 1 FROM redemptions WHERE promotion_id=?').get(row.id)) { d().prepare('UPDATE promotions SET active=0 WHERE id=?').run(row.id); return false; } return true; },
});

// ---------- members (admin list) ----------
r.get('/members', P('member.manage'), (req, res) => {
  const q = String(req.query.q || '').trim(); const page = Math.max(0, int(req.query.page)); const size = 50;
  const where = q ? 'WHERE phone LIKE ? OR code LIKE ? OR first_name LIKE ? OR last_name LIKE ?' : '';
  const args = q ? [`%${q}%`, `%${q.toUpperCase()}%`, `%${q}%`, `%${q}%`] : [];
  const rows = d().prepare(`SELECT * FROM members ${where} ORDER BY id DESC LIMIT ${size} OFFSET ${page * size}`).all(...args);
  res.json({ members: rows.map((m) => members.memberOut(m, { full: true })), total: d().prepare(`SELECT COUNT(*) c FROM members ${where}`).get(...args).c, page, size });
});
r.put('/members/:id', P('member.manage'), (req, res) => {
  exists('members', req.params.id);
  const b = req.body;
  const phone = members.normPhone(b.phone);
  if (!members.validPhone(phone)) throw err(400, 'invalid_phone', 'เบอร์โทรศัพท์ไม่ถูกต้อง');
  try { d().prepare('UPDATE members SET phone=?, first_name=?, last_name=?, birthday=?, email=?, active=? WHERE id=?').run(phone, String(b.first_name || '').slice(0, 60), String(b.last_name || '').slice(0, 60), /^\d{4}-\d{2}-\d{2}$/.test(b.birthday || '') ? b.birthday : null, b.email || null, bool(b.active ?? 1), req.params.id); } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'เบอร์โทรซ้ำ'); throw e; }
  audit(req, 'member.update', 'member', Number(req.params.id));
  res.json({ ok: true });
});

// ---------- staff & roles ----------
r.get('/staff', P('staff.manage'), (req, res) => res.json({ staff: d().prepare('SELECT s.id, s.code, s.name, s.phone, s.role_id, s.branch_ids, s.active, s.last_login_at, s.created_at, r.name role_name FROM staff s JOIN roles r ON r.id=s.role_id ORDER BY s.id').all().map((s) => ({ ...s, branch_ids: db.J(s.branch_ids, []), active: !!s.active })) }));
r.post('/staff', P('staff.manage'), (req, res) => {
  const b = req.body;
  const code = String(b.code || '').trim();
  if (!/^[A-Za-z0-9]{2,20}$/.test(code)) throw err(400, 'invalid_code', 'รหัสพนักงานต้องเป็นตัวอักษร/ตัวเลข 2-20 ตัว');
  if (!auth.validPin(b.pin)) throw err(400, 'invalid_pin', 'PIN ต้องเป็นตัวเลข 4-8 หลัก');
  const role = exists('roles', b.role_id);
  if (role.code === 'owner' && req.staff.role !== 'owner') throw err(403, 'forbidden', 'เฉพาะ Owner ที่สร้าง Owner ได้');
  try {
    const id = d().prepare('INSERT INTO staff(restaurant_id, code, name, phone, role_id, pin_hash, branch_ids, active, created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(restaurantId(), code, String(b.name || code).slice(0, 60), b.phone || null, role.id, auth.hashPin(b.pin), JSON.stringify((b.branch_ids || []).map(Number)), 1, now()).lastInsertRowid;
    audit(req, 'staff.create', 'staff', id, { code, role: role.code });
    res.status(201).json({ id });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'รหัสพนักงานซ้ำ'); throw e; }
});
r.put('/staff/:id', P('staff.manage'), (req, res) => {
  const s = exists('staff', req.params.id);
  const b = req.body;
  const role = exists('roles', b.role_id || s.role_id);
  const cur = d().prepare('SELECT r.code FROM roles r WHERE r.id=?').get(s.role_id).code;
  if ((role.code === 'owner' || cur === 'owner') && req.staff.role !== 'owner') throw err(403, 'forbidden', 'เฉพาะ Owner ที่แก้ไข Owner ได้');
  if (Number(req.params.id) === req.staff.id && b.active === false) throw err(400, 'self_disable', 'ไม่สามารถปิดบัญชีตัวเอง');
  d().prepare('UPDATE staff SET name=?, phone=?, role_id=?, branch_ids=?, active=? WHERE id=?').run(String(b.name || s.name).slice(0, 60), b.phone || null, role.id, JSON.stringify((b.branch_ids || []).map(Number)), bool(b.active ?? 1), s.id);
  if (b.pin) { if (!auth.validPin(b.pin)) throw err(400, 'invalid_pin', 'PIN ต้องเป็นตัวเลข 4-8 หลัก'); d().prepare('UPDATE staff SET pin_hash=?, failed_attempts=0, locked_until=NULL WHERE id=?').run(auth.hashPin(b.pin), s.id); }
  if (b.active === false || b.pin) d().prepare('UPDATE staff_tokens SET revoked=1 WHERE staff_id=?').run(s.id);
  audit(req, 'staff.update', 'staff', s.id, { role: role.code, pin_changed: !!b.pin, active: b.active });
  res.json({ ok: true });
});
r.get('/roles', P('staff.manage'), (req, res) => res.json({ roles: d().prepare('SELECT * FROM roles ORDER BY id').all().map((x) => ({ ...x, permissions: db.J(x.permissions, []), is_system: !!x.is_system })) }));
r.post('/roles', P('staff.manage'), (req, res) => {
  const code = String(req.body.code || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(code)) throw err(400, 'invalid_code', 'รหัสบทบาทไม่ถูกต้อง');
  const perms = (req.body.permissions || []).filter((p) => auth.ALL.includes(p));
  try { const id = d().prepare('INSERT INTO roles(restaurant_id, code, name, permissions, is_system) VALUES(?,?,?,?,0)').run(restaurantId(), code, String(req.body.name || code).slice(0, 40), JSON.stringify(perms)).lastInsertRowid; audit(req, 'role.create', 'role', id, { perms }); res.status(201).json({ id }); } catch (e) { if (/UNIQUE/.test(e.message)) throw err(409, 'duplicate', 'รหัสซ้ำ'); throw e; }
});
r.put('/roles/:id', P('staff.manage'), (req, res) => {
  const role = exists('roles', req.params.id);
  if (role.code === 'owner') throw err(403, 'forbidden', 'ไม่สามารถแก้ไขสิทธิ์ Owner');
  const perms = (req.body.permissions || []).filter((p) => auth.ALL.includes(p));
  d().prepare('UPDATE roles SET name=?, permissions=? WHERE id=?').run(String(req.body.name || role.name).slice(0, 40), JSON.stringify(perms), role.id);
  audit(req, 'role.update', 'role', role.id, { perms });
  res.json({ ok: true });
});
r.delete('/roles/:id', P('staff.manage'), (req, res) => {
  const role = exists('roles', req.params.id);
  if (role.is_system) throw err(403, 'forbidden', 'ไม่สามารถลบบทบาทของระบบ');
  if (d().prepare('SELECT 1 FROM staff WHERE role_id=?').get(role.id)) throw err(409, 'role_in_use', 'มีพนักงานใช้บทบาทนี้');
  d().prepare('DELETE FROM roles WHERE id=?').run(role.id); res.json({ ok: true });
});

// ---------- themes ----------
r.get('/themes', P(), (req, res) => res.json({ themes: d().prepare('SELECT * FROM themes WHERE branch_id=? ORDER BY id').all(req.branchId).map((t) => ({ id: t.id, name: t.name, is_active: !!t.is_active, updated_at: t.updated_at, settings: theme.normalize(db.J(t.settings, {})) })), active: theme.activeTheme(req.branchId) }));
r.post('/themes', SET, (req, res) => { const id = theme.saveTheme(req.branchId, req.body); audit(req, 'theme.save', 'theme', id, { activate: !!req.body.activate }); res.json({ id }); });
r.post('/themes/:id/activate', SET, (req, res) => {
  exists('themes', req.params.id, true, req);
  d().transaction(() => { d().prepare('UPDATE themes SET is_active=0 WHERE branch_id=?').run(req.branchId); d().prepare('UPDATE themes SET is_active=1 WHERE id=?').run(req.params.id); })();
  audit(req, 'theme.activate', 'theme', Number(req.params.id)); res.json({ ok: true });
});
r.delete('/themes/:id', SET, (req, res) => { const t = exists('themes', req.params.id, true, req); if (t.is_active) throw err(409, 'theme_active', 'ไม่สามารถลบธีมที่ใช้งานอยู่'); d().prepare('DELETE FROM themes WHERE id=?').run(t.id); res.json({ ok: true }); });
r.post('/themes/preview.css', SET, (req, res) => res.type('css').send(theme.css(theme.validate(req.body.settings), String(req.body.scope || 'customer'))));

// ---------- fonts ----------
const CURATED_FONTS = ['Sarabun', 'Prompt', 'Kanit', 'Mitr', 'Noto Sans Thai', 'Noto Serif Thai', 'IBM Plex Sans Thai', 'Anuphan', 'Bai Jamjuree', 'Chakra Petch', 'Pridi', 'Taviraj', 'Trirong', 'Athiti', 'Chonburi', 'Itim', 'K2D', 'Krub', 'Mali', 'Niramit', 'Thasadith', 'Charm', 'Charmonman', 'Srisakdi', 'Fahkwang', 'Kodchasan', 'KoHo', 'Maitree', 'Pattaya', 'Sriracha', 'Playfair Display', 'Cormorant Garamond', 'Montserrat', 'Poppins', 'Inter', 'Roboto', 'Lato', 'Open Sans', 'Noto Sans SC', 'Noto Serif SC', 'ZCOOL XiaoWei', 'Ma Shan Zheng'];
let googleCache = null;
r.get('/fonts/google', P(), async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  let list = CURATED_FONTS.map((f) => ({ family: f }));
  if (config.googleFontsApiKey) {
    if (!googleCache) { try { const g = await fetch(`https://www.googleapis.com/webfonts/v1/webfonts?key=${config.googleFontsApiKey}&sort=popularity`).then((x) => x.json()); googleCache = (g.items || []).map((i) => ({ family: i.family, subsets: i.subsets, category: i.category })); } catch { googleCache = null; } }
    if (googleCache) list = googleCache;
  }
  const uploaded = d().prepare("SELECT DISTINCT font_family family FROM media_assets WHERE kind='font'").all().map((x) => ({ ...x, uploaded: true }));
  res.json({ fonts: [...uploaded, ...list.filter((f) => !q || f.family.toLowerCase().includes(q))].slice(0, 200), full_catalog: !!(config.googleFontsApiKey && googleCache), note: config.googleFontsApiKey ? null : 'แสดงรายการแนะนำ — ตั้งค่า GOOGLE_FONTS_API_KEY เพื่อค้นหาทั้งหมด หรือพิมพ์ชื่อฟอนต์จาก fonts.google.com ได้โดยตรง' });
});
r.post('/fonts/google/fetch', SET, async (req, res) => {
  const fam = fonts.safeName(req.body.family);
  try { await fonts.fetchGoogleFont(fam); res.json({ ok: true, family: fam }); } catch (e) { throw err(502, 'font_download_failed', `ดาวน์โหลดฟอนต์ไม่สำเร็จ: ${e.message}`); }
});

// ---------- media ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
r.get('/media', P(), (req, res) => {
  const kind = req.query.kind;
  res.json({ assets: d().prepare(`SELECT * FROM media_assets ${kind ? 'WHERE kind=?' : ''} ORDER BY id DESC LIMIT 500`).all(...(kind ? [kind] : [])).map(media.assetOut), recommended: media.RECOMMENDED, max_mb: branchSettings(req.branchId).max_upload_mb });
});
r.post('/media', P('settings.manage', 'menu.manage'), upload.single('file'), async (req, res) => {
  if (!req.file) throw err(400, 'file_required', 'ไม่พบไฟล์');
  const a = await media.save(req.file, { kind: req.body.kind || 'other', restaurantId: restaurantId(), staffId: req.staff.id, maxMb: branchSettings(req.branchId).max_upload_mb, fontFamily: req.body.font_family });
  audit(req, 'media.upload', 'media', a.id, { kind: a.kind, size: a.size });
  res.status(201).json({ asset: a });
});
r.put('/media/:id', P('settings.manage', 'menu.manage'), upload.single('file'), async (req, res) => {
  if (!req.file) throw err(400, 'file_required', 'ไม่พบไฟล์');
  const a = await media.replace(Number(req.params.id), req.file, { restaurantId: restaurantId(), staffId: req.staff.id, maxMb: branchSettings(req.branchId).max_upload_mb });
  audit(req, 'media.replace', 'media', a.id);
  res.json({ asset: a });
});
r.delete('/media/:id', P('settings.manage', 'menu.manage'), (req, res) => { media.remove(Number(req.params.id)); audit(req, 'media.delete', 'media', Number(req.params.id)); res.json({ ok: true }); });

// ---------- printers ----------
r.get('/printers', P(), (req, res) => res.json({ printers: d().prepare('SELECT * FROM printers WHERE branch_id=? ORDER BY id').all(req.branchId).map(printing.printerOut), routes: printing.routes(req.branchId), doc_types: docs.DOC_TYPES }));
function printerFields(b) {
  if (!['network', 'bridge', 'browser'].includes(b.connection)) throw err(400, 'invalid_connection', 'ชนิดการเชื่อมต่อไม่ถูกต้อง');
  const paper = Number(b.paper_width) === 58 ? 58 : 80;
  if (b.connection === 'network' && !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(String(b.address || ''))) throw err(400, 'invalid_address', 'ระบุ IP:Port ของเครื่องพิมพ์ เช่น 192.168.1.50:9100');
  const cfg = b.config || {};
  return [String(b.name || 'Printer').slice(0, 40), b.connection, b.address ? String(b.address).slice(0, 200) : null, paper, paper === 58 ? 384 : 576, JSON.stringify({ cut: cfg.cut !== false, beep: !!cfg.beep, drawer: !!cfg.drawer, transport: ['usb', 'serial', 'bluetooth', 'ble', 'file', 'cups', 'tcp'].includes(cfg.transport) ? cfg.transport : undefined }), bool(b.active ?? 1)];
}
r.post('/printers', SET, (req, res) => {
  const id = d().prepare('INSERT INTO printers(branch_id, name, connection, address, paper_width, dots, config, active) VALUES(?,?,?,?,?,?,?,?)').run(req.branchId, ...printerFields(req.body)).lastInsertRowid;
  const key = req.body.connection === 'bridge' ? printing.newBridgeKey(id) : null;
  audit(req, 'printer.create', 'printer', id);
  res.status(201).json({ id, bridge_key: key });
});
r.put('/printers/:id', SET, (req, res) => {
  exists('printers', req.params.id, true, req);
  d().prepare('UPDATE printers SET name=?, connection=?, address=?, paper_width=?, dots=?, config=?, active=? WHERE id=?').run(...printerFields(req.body), req.params.id);
  audit(req, 'printer.update', 'printer', Number(req.params.id));
  res.json({ ok: true });
});
r.delete('/printers/:id', SET, (req, res) => {
  exists('printers', req.params.id, true, req);
  d().transaction(() => {
    d().prepare('UPDATE print_routes SET printer_id=NULL WHERE printer_id=?').run(req.params.id);
    d().prepare('UPDATE kitchen_stations SET printer_id=NULL WHERE printer_id=?').run(req.params.id);
    d().prepare('UPDATE menu_items SET printer_id=NULL WHERE printer_id=?').run(req.params.id);
    d().prepare("UPDATE print_jobs SET status='failed', error='printer deleted' WHERE printer_id=? AND status IN ('pending','printing')").run(req.params.id);
    d().prepare('UPDATE printers SET active=0 WHERE id=?').run(req.params.id);
  })();
  audit(req, 'printer.delete', 'printer', Number(req.params.id));
  res.json({ ok: true });
});
r.post('/printers/:id/bridge-key', SET, (req, res) => {
  const p = exists('printers', req.params.id, true, req);
  if (p.connection !== 'bridge') throw err(400, 'not_bridge', 'เครื่องพิมพ์นี้ไม่ได้ใช้ Print Bridge');
  audit(req, 'printer.bridge_key', 'printer', p.id);
  res.json({ bridge_key: printing.newBridgeKey(p.id) });
});
r.post('/printers/:id/probe', SET, async (req, res) => {
  const p = exists('printers', req.params.id, true, req);
  if (p.connection !== 'network') return res.json({ ok: p.status === 'online', status: p.status, last_seen_at: p.last_seen_at, note: p.connection === 'bridge' ? 'สถานะมาจาก Print Bridge ล่าสุด' : 'สถานะมาจากหน้า Print Station ล่าสุด' });
  const out = await printing.probeTcp(p.address);
  printing.markPrinter(p.id, out.ok ? 'online' : 'offline', out.ok ? null : out.error);
  res.json(out);
});
r.post('/printers/:id/test', SET, (req, res) => {
  const p = exists('printers', req.params.id, true, req);
  res.json({ jobs: printing.enqueueDoc(req.branchId, 'test', { printer_name: p.name }, { printerId: p.id }) });
});
r.put('/print-routes', SET, (req, res) => {
  const list = Array.isArray(req.body.routes) ? req.body.routes : [];
  d().transaction(() => {
    for (const x of list) {
      if (!docs.DOC_TYPES[x.doc_type] || x.doc_type === 'test') continue;
      if (x.printer_id) exists('printers', x.printer_id, true, req);
      d().prepare('INSERT INTO print_routes(branch_id, doc_type, printer_id, copies, auto) VALUES(?,?,?,?,?) ON CONFLICT(branch_id, doc_type) DO UPDATE SET printer_id=excluded.printer_id, copies=excluded.copies, auto=excluded.auto')
        .run(req.branchId, x.doc_type, nint(x.printer_id), Math.max(1, Math.min(5, int(x.copies, 1))), bool(x.auto ?? 1));
    }
  })();
  audit(req, 'print.routes', 'branch', req.branchId);
  res.json({ routes: printing.routes(req.branchId) });
});
r.get('/print-jobs', P(), (req, res) => {
  const st = req.query.status;
  res.json({ jobs: d().prepare(`SELECT * FROM print_jobs WHERE branch_id=? ${st ? 'AND status=?' : ''} ORDER BY id DESC LIMIT 200`).all(req.branchId, ...(st ? [st] : [])).map(printing.jobOut) });
});
r.post('/print-jobs/:id/retry', SET, (req, res) => res.json({ job: printing.retry(req.branchId, Number(req.params.id)) }));
r.get('/print-jobs/:id/preview.png', P(), async (req, res) => {
  const j = d().prepare('SELECT * FROM print_jobs WHERE id=? AND branch_id=?').get(req.params.id, req.branchId);
  if (!j) throw err(404, 'job_not_found', 'ไม่พบงานพิมพ์');
  const p = d().prepare('SELECT * FROM printers WHERE id=?').get(j.printer_id);
  res.type('png').set('Cache-Control', 'no-store').send(await printing.jobPng(j, p));
});

// Template preview for the Theme Studio (labelled sample data — never stored)
function sampleData(docType, branchId) {
  const branch = docs.branchInfo(branchId);
  const t = now();
  const groups = [{ package: { th: 'HAPPINESS COURSE', en: 'HAPPINESS COURSE' }, label: { th: 'ผู้ใหญ่' }, unit: 99900, count: 5 }];
  const bill = { package_total: 499500, extras_total: 0, discount_total: 0, subtotal: 499500, service_rate: 10, service_charge: 49950, vat_rate: 7, vat: 38462, before_vat: 549450, total: 587912, prices_include_vat: false };
  if (docType === 'kitchen') return { branch, order_no: 'ORD001', table_code: 'T07', public_code: 'BF00128', station: 'ครัวร้อน', created_at: t, additional: false, items: [{ name: { th: 'แซลมอนซาชิมิ' }, qty: 2, options: [{ option: { th: 'ซอส' }, choice: { th: 'วาซาบิ' } }], note: 'ไม่ใส่หัวหอม', guest: 'A' }, { name: { th: 'กุ้งแม่น้ำเผา' }, qty: 1, options: [], note: null }] };
  if (docType === 'receipt' || docType === 'tax_invoice') return { branch, table_code: 'V.22', public_code: 'BF00128', start_at: t - 3 * 3600e3, end_at: t, guests: 5, member: null, cashier: 'ตัวอย่าง',
    bill: { ...bill, bill_no: 'SAMPLE-0001', split_label: null, created_at: t, paid_at: t, points_earned: 0, lines: [{ kind: 'package', name: 'HAPPINESS COURSE - ผู้ใหญ่', qty: 5, amount: 499500 }], payments: [{ method_name: 'เงินสด', amount: 587912, received: 600000, change_amount: 12088 }], tax_invoice: docType === 'tax_invoice' ? { no: 'TI-SAMPLE', name: 'บริษัท ตัวอย่าง จำกัด', tax_id: '0000000000000', branch_label: 'สำนักงานใหญ่', address: '-' } : null } };
  return { branch, session_id: 0, public_code: 'BF00128', table_code: 'T07', start_at: t, end_at: t + 3 * 3600e3, duration_min: 180, guests: 5, groups, bill, closed_at: t, items: { qty: 24 }, orders: 6, bills: [{ bill_no: 'SAMPLE-0001', total: 587912 }], payments: [{ method_name: 'เงินสด', amount: 587912 }], staff: 'ตัวอย่าง' };
}
r.post('/print-preview.png', P(), async (req, res) => {
  const docType = String(req.body.doc_type || 'qr_ticket');
  if (!docs.DOC_TYPES[docType] || docType === 'test') throw err(400, 'invalid_doc', 'เอกสารไม่ถูกต้อง');
  const tpl = { ...docs.template(req.branchId), ...(req.body.template || {}) };
  const doc = docs.layout(docType, sampleData(docType, req.branchId), { tpl, settings: branchSettings(req.branchId), paper: Number(req.body.paper) === 58 ? 58 : 80, qrUrl: 'PREVIEW-ONLY', joinUrl: 'PREVIEW-ONLY' });
  const canvas = await renderDoc(doc);
  res.type('png').set('Cache-Control', 'no-store').send(canvas.toBuffer('image/png'));
});

// ---------- audit log ----------
r.get('/audit', P('audit.view'), (req, res) => {
  const where = ['1=1']; const args = [];
  if (req.query.action) { where.push('a.action LIKE ?'); args.push(`${req.query.action}%`); }
  if (req.query.staff_id) { where.push('a.staff_id=?'); args.push(Number(req.query.staff_id)); }
  if (req.query.from) { where.push('a.created_at>=?'); args.push(Number(req.query.from)); }
  if (req.query.to) { where.push('a.created_at<=?'); args.push(Number(req.query.to)); }
  res.json({ logs: d().prepare(`SELECT a.*, s.name staff_name, ap.name approver_name FROM audit_logs a LEFT JOIN staff s ON s.id=a.staff_id LEFT JOIN staff ap ON ap.id=a.approver_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 500`).all(...args).map((x) => ({ ...x, data: db.J(x.data, null) })) });
});

// ---------- backup ----------
r.get('/backups', P('backup.manage'), (req, res) => {
  fs.mkdirSync(config.backupDir, { recursive: true });
  res.json({ backups: fs.readdirSync(config.backupDir).filter((f) => f.endsWith('.db')).sort().reverse().map((f) => ({ file: f, size: fs.statSync(path.join(config.backupDir, f)).size })) });
});
r.post('/backups', P('backup.manage'), async (req, res) => {
  const file = await require('../services/scheduler').backup('manual');
  audit(req, 'backup.create', null, null, { file: path.basename(file) });
  res.json({ file: path.basename(file) });
});
r.get('/backups/:file', P('backup.manage'), (req, res) => {
  const f = path.basename(req.params.file);
  if (!/^buffet-[\w.-]+\.db$/.test(f)) throw err(400, 'invalid_file', 'ไฟล์ไม่ถูกต้อง');
  const full = path.join(config.backupDir, f);
  if (!fs.existsSync(full)) throw err(404, 'not_found', 'ไม่พบไฟล์');
  audit(req, 'backup.download', null, null, { file: f });
  res.download(full);
});

// ---------- reports ----------
r.get('/reports/:name', P('report.view'), async (req, res) => {
  const q = { ...req.query, tz: branchSettings(req.branchId).timezone };
  if (q.branch_id === 'current') q.branch_id = req.branchId;
  const rep = reports.run(req.params.name, q);
  const fmt = req.query.format;
  const title = `รายงาน ${req.params.name}`;
  const fname = `${req.params.name}-${new Date().toISOString().slice(0, 10)}`;
  if (!fmt || fmt === 'json') return res.json(rep);
  if (!rep.columns) throw err(400, 'not_exportable', 'รายงานนี้ไม่รองรับการส่งออก');
  if (fmt === 'csv') return res.type('text/csv; charset=utf-8').attachment(`${fname}.csv`).send(reports.toCsv(rep));
  if (fmt === 'xlsx') return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${fname}.xlsx`).send(await reports.toXlsx(rep, req.params.name));
  if (fmt === 'pdf') {
    const from = new Date(Number(q.from) || Date.now() - 30 * 86400e3).toLocaleDateString('th-TH'); const to = new Date(Number(q.to) || Date.now()).toLocaleDateString('th-TH');
    return res.type('application/pdf').attachment(`${fname}.pdf`).send(await reports.toPdf(rep, title, `ช่วงวันที่ ${from} - ${to}`));
  }
  throw err(400, 'invalid_format', 'รูปแบบไฟล์ไม่ถูกต้อง');
});

module.exports = r;
