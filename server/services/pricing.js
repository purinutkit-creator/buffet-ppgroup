'use strict';
// Package pricing rules, promotion application and bill calculation.
const db = require('../db');
const { err, now, pct, tr } = require('../lib/util');
const { branchSettings } = require('./settings');

// ---- package price rules ----
function packagePrices(packageId) {
  return db.get().prepare('SELECT * FROM package_prices WHERE package_id=? ORDER BY sort, id').all(packageId)
    .map((p) => ({ ...p, label: db.J(p.label, {}) }));
}

// Validate that age/height rules of a package don't overlap (same rule type, same priority).
function validatePriceRules(rules) {
  const errors = [];
  const codes = new Set();
  for (const r of rules) {
    if (!r.code) errors.push('ต้องระบุรหัสประเภทลูกค้า');
    if (codes.has(r.code)) errors.push(`รหัส ${r.code} ซ้ำ`);
    codes.add(r.code);
    if (!(Number.isInteger(r.price) && r.price >= 0)) errors.push(`ราคา ${r.code} ไม่ถูกต้อง`);
    if (r.rule_type !== 'none' && r.min_value != null && r.max_value != null && Number(r.min_value) > Number(r.max_value)) errors.push(`ช่วงของ ${r.code} ไม่ถูกต้อง (ต่ำสุดมากกว่าสูงสุด)`);
  }
  for (const type of ['age', 'height']) {
    const list = rules.filter((r) => r.rule_type === type);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (Number(a.priority || 0) !== Number(b.priority || 0)) continue; // explicit priority resolves overlap
      const aMin = a.min_value == null ? -Infinity : Number(a.min_value), aMax = a.max_value == null ? Infinity : Number(a.max_value);
      const bMin = b.min_value == null ? -Infinity : Number(b.min_value), bMax = b.max_value == null ? Infinity : Number(b.max_value);
      if (aMin <= bMax && bMin <= aMax) errors.push(`ช่วง${type === 'age' ? 'อายุ' : 'ส่วนสูง'}ของ "${a.code}" และ "${b.code}" ทับซ้อนกัน (กำหนด priority ต่างกันหากตั้งใจ)`);
    }
  }
  if (rules.filter((r) => r.is_default).length > 1) errors.push('กำหนดราคาเริ่มต้นได้เพียง 1 รายการ');
  return errors;
}

// Find the price rule that applies to an age or height. Higher priority wins.
function matchPrice(packageId, { age, height, code } = {}) {
  const rules = packagePrices(packageId);
  if (code) { const r = rules.find((x) => x.code === code); if (!r) throw err(400, 'invalid_price_code', `ไม่พบประเภทราคา ${code}`); return r; }
  const fits = rules.filter((r) => {
    const v = r.rule_type === 'age' ? age : r.rule_type === 'height' ? height : null;
    if (v == null) return false;
    return (r.min_value == null || v >= r.min_value) && (r.max_value == null || v <= r.max_value);
  }).sort((a, b) => b.priority - a.priority);
  return fits[0] || rules.find((r) => r.is_default) || rules[0] || null;
}

// Is the package sellable right now at this branch?
function packageSellable(pkg, branchId, at = now()) {
  const s = branchSettings(branchId);
  const { localParts, inWindow } = require('../lib/util');
  const p = localParts(at, s.timezone);
  if (!pkg.active) return 'หยุดขายแพ็กเกจนี้';
  const days = db.J(pkg.days, []);
  if (days.length && !days.includes(p.weekday)) return 'แพ็กเกจนี้ไม่จำหน่ายในวันนี้';
  if (pkg.service_start && pkg.service_end && !inWindow(p.minutes, pkg.service_start, pkg.service_end)) return `แพ็กเกจนี้จำหน่ายเวลา ${pkg.service_start}-${pkg.service_end}`;
  return null;
}

// ---- bill computation ----
function loadSessionForBill(sessionId) {
  const d = db.get();
  const session = d.prepare('SELECT * FROM table_sessions WHERE id=?').get(sessionId);
  if (!session) throw err(404, 'session_not_found', 'ไม่พบรอบการใช้โต๊ะ');
  const guests = d.prepare(`SELECT g.*, p.name pkg_name, p.code pkg_code, p.service_charge_enabled, p.overtime_fee, pp.label price_label
    FROM session_guests g JOIN buffet_packages p ON p.id=g.package_id LEFT JOIN package_prices pp ON pp.id=g.price_id
    WHERE g.session_id=? AND g.active=1 ORDER BY g.id`).all(sessionId);
  const items = d.prepare(`SELECT * FROM order_items WHERE session_id=? AND status NOT IN ('cancelled','unavailable')`).all(sessionId);
  const redemptions = d.prepare(`SELECT r.*, p.type, p.value, p.menu_item_id, p.from_package_id, p.to_package_id, p.priority, p.stackable, p.name promo_name, p.min_spend
    FROM redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE r.session_id=? AND r.status='applied' ORDER BY p.priority DESC, r.id`).all(sessionId);
  return { session, guests, items, redemptions };
}

function computeBill(sessionId, { at = now(), lang = 'th' } = {}) {
  const { session, guests, items, redemptions } = loadSessionForBill(sessionId);
  const s = branchSettings(session.branch_id);
  const lines = [];

  // Package lines grouped by package + price type
  const groups = new Map();
  for (const g of guests) {
    const k = `${g.package_id}|${g.price_code}|${g.unit_price}`;
    if (!groups.has(k)) groups.set(k, { kind: 'package', package_id: g.package_id, price_code: g.price_code, name: `${tr(g.pkg_name, 'en').toUpperCase()}${g.price_label ? ' - ' + tr(g.price_label, lang) : ''}`, name_i18n: db.J(g.pkg_name, {}), qty: 0, unit: g.unit_price, sc: !!g.service_charge_enabled, guests: [] });
    const grp = groups.get(k); grp.qty++; grp.guests.push(g.label);
  }
  for (const grp of groups.values()) lines.push({ ...grp, amount: grp.qty * grp.unit });

  // Extra-charge food
  const extras = new Map();
  for (const it of items) {
    if (!it.unit_extra) continue;
    const k = `${it.menu_item_id}|${it.unit_extra}|${it.guest_label || ''}`;
    if (!extras.has(k)) extras.set(k, { kind: 'extra', menu_item_id: it.menu_item_id, name: tr(it.name, lang), qty: 0, unit: it.unit_extra, sc: !!s.service_charge_on_extras, guest: it.guest_label || null });
    extras.get(k).qty += it.qty;
  }
  for (const e of extras.values()) lines.push({ ...e, amount: e.qty * e.unit });

  // Overtime fee (per guest per started block after end time) unless waived
  const adjustments = db.J(session.adjustments, []);
  const closeAt = session.closed_at || at;
  if (!adjustments.some((a) => a.code === 'waive_overtime') && closeAt > session.end_at) {
    const fee = db.J(guests[0] && guests[0].overtime_fee, {});
    if (fee.block_min > 0 && fee.amount_per_guest > 0) {
      const blocks = Math.ceil((closeAt - session.end_at) / (fee.block_min * 60000));
      lines.push({ kind: 'overtime', name: `ค่าปรับเกินเวลา ${blocks}×${fee.block_min} นาที`, qty: blocks * guests.length, unit: fee.amount_per_guest, amount: blocks * guests.length * fee.amount_per_guest, sc: true });
    }
  }
  for (const a of adjustments) {
    if (a.code === 'waive_overtime') continue;
    lines.push({ kind: 'adjustment', code: a.code, name: a.label || a.code, qty: 1, unit: a.amount, amount: a.amount, sc: true });
  }

  const package_total = lines.filter((l) => l.kind === 'package').reduce((t, l) => t + l.amount, 0);
  const extras_total = lines.filter((l) => l.kind === 'extra').reduce((t, l) => t + l.amount, 0);
  const adjustments_total = lines.filter((l) => l.kind === 'overtime' || l.kind === 'adjustment').reduce((t, l) => t + l.amount, 0);
  const gross = package_total + extras_total + adjustments_total;

  // Discounts: promotions in priority order (non-stackable promo stands alone), then manual discount.
  const discounts = [];
  let remaining = gross;
  let locked = false;
  for (const r of redemptions) {
    if (locked) { discounts.push({ redemption_id: r.id, name: tr(r.promo_name, lang), amount: 0, skipped: 'ไม่สามารถใช้ร่วมกับโปรโมชั่นอื่น' }); continue; }
    if (!r.stackable && discounts.some((x) => x.amount > 0)) { discounts.push({ redemption_id: r.id, name: tr(r.promo_name, lang), amount: 0, skipped: 'ไม่สามารถใช้ร่วมกับโปรโมชั่นอื่น' }); continue; }
    if (r.min_spend && gross < r.min_spend) { discounts.push({ redemption_id: r.id, name: tr(r.promo_name, lang), amount: 0, skipped: 'ยอดไม่ถึงขั้นต่ำ' }); continue; }
    let amt = 0;
    if (r.type === 'discount_amount') amt = r.value;
    else if (r.type === 'discount_percent') amt = Math.round(gross * r.value / 10000);
    else if (r.type === 'free_item') {
      const it = items.filter((i) => i.menu_item_id === r.menu_item_id && i.unit_extra > 0).sort((a, b) => b.unit_extra - a.unit_extra)[0];
      amt = it ? it.unit_extra : 0;
    } else if (r.type === 'package_upgrade') {
      // Guest upgraded from_package -> to_package; discount the price difference for one guest
      const g = guests.find((x) => x.package_id === r.to_package_id);
      if (g) {
        const base = matchPrice(r.from_package_id, { code: g.price_code });
        amt = base ? Math.max(0, g.unit_price - base.price) : 0;
      }
    }
    amt = Math.min(amt, remaining);
    remaining -= amt;
    discounts.push({ redemption_id: r.id, name: tr(r.promo_name, lang), amount: amt });
    if (!r.stackable && amt > 0) locked = true;
  }
  const md = db.J(session.manual_discount, null);
  if (md && md.value > 0) {
    let amt = md.type === 'percent' ? Math.round(gross * md.value / 10000) : md.value;
    amt = Math.min(amt, remaining); remaining -= amt;
    discounts.push({ manual: true, name: md.reason ? `ส่วนลด (${md.reason})` : 'ส่วนลด', amount: amt });
  }
  const discount_total = discounts.reduce((t, x) => t + x.amount, 0);
  const subtotal = gross - discount_total;

  // Service charge on eligible part (discount prorated)
  const eligible = lines.filter((l) => l.sc).reduce((t, l) => t + l.amount, 0);
  const scBase = gross > 0 ? Math.round(eligible * subtotal / gross) : 0;
  const service_charge = s.service_rate > 0 ? pct(scBase, s.service_rate) : 0;
  let before_vat, vat, total;
  if (s.prices_include_vat) {
    total = subtotal + service_charge;
    vat = s.vat_rate > 0 ? Math.round(total * s.vat_rate / (100 + s.vat_rate)) : 0;
    before_vat = total - vat;
  } else {
    before_vat = subtotal + service_charge;
    vat = s.vat_rate > 0 ? pct(before_vat, s.vat_rate) : 0;
    total = before_vat + vat;
  }
  return {
    session_id: session.id, lines, discounts,
    package_total, extras_total, adjustments_total, gross, discount_total, subtotal,
    service_rate: s.service_rate, service_charge, vat_rate: s.vat_rate, prices_include_vat: s.prices_include_vat,
    before_vat, vat, total, guests_count: guests.length,
    guest_shares: guestShares(guests, items, lines),
  };
}

// Weight of each guest for "split by guest": own package + own extras; shared extras split evenly.
function guestShares(guests, items, lines) {
  const w = {};
  for (const g of guests) w[g.label] = g.unit_price;
  const labels = Object.keys(w);
  for (const l of lines.filter((x) => x.kind === 'extra')) {
    if (l.guest && w[l.guest] != null) w[l.guest] += l.amount;
    else for (const k of labels) w[k] += l.amount / (labels.length || 1);
  }
  for (const l of lines.filter((x) => x.kind === 'overtime' || x.kind === 'adjustment')) for (const k of labels) w[k] += l.amount / (labels.length || 1);
  return w;
}

// Split a computed bill into parts by weights; every component is prorated and the remainder goes to the last part
function splitBill(bill, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw err(400, 'invalid_split', 'สัดส่วนการแบ่งบิลไม่ถูกต้อง');
  const keys = ['package_total', 'extras_total', 'adjustments_total', 'discount_total', 'subtotal', 'service_charge', 'before_vat', 'vat', 'total'];
  const parts = weights.map(() => ({}));
  for (const k of keys) {
    let acc = 0;
    weights.forEach((w, i) => {
      if (i === weights.length - 1) parts[i][k] = bill[k] - acc;
      else { parts[i][k] = Math.round(bill[k] * w / sum); acc += parts[i][k]; }
    });
  }
  return parts;
}

module.exports = { packagePrices, validatePriceRules, matchPrice, packageSellable, computeBill, splitBill };
