'use strict';
// Menu visibility per package and serialization for customer / staff views.
const db = require('../db');
const { localParts, inWindow } = require('../lib/util');
const { branchSettings } = require('./settings');

function assetUrl(id) { return id ? `/media/${id}` : null; }

function itemRow(m) {
  return {
    id: m.id, code: m.code, category_id: m.category_id, name: db.J(m.name, {}), description: db.J(m.description, {}),
    ingredients: db.J(m.ingredients, {}), allergens: db.J(m.allergens, []), image: assetUrl(m.image_asset_id), image_asset_id: m.image_asset_id,
    extra_price: m.extra_price, max_per_order: m.max_per_order, max_per_guest: m.max_per_guest, max_per_table: m.max_per_table,
    prep_minutes: m.prep_minutes, station_id: m.station_id, printer_id: m.printer_id, status: m.status,
    available_from: m.available_from, available_to: m.available_to, tags: db.J(m.tags, []), sort: m.sort, cost: m.cost, branch_id: m.branch_id,
  };
}

function optionsFor(itemIds) {
  if (!itemIds.length) return {};
  const rows = db.get().prepare(`SELECT * FROM menu_options WHERE menu_item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY sort, id`).all(...itemIds);
  const out = {};
  for (const r of rows) (out[r.menu_item_id] ||= []).push({ id: r.id, name: db.J(r.name, {}), type: r.type, required: !!r.required, max_select: r.max_select, choices: db.J(r.choices, []) });
  return out;
}

// Menu for a set of package ids (customer view). Each item lists which packages include it and the extra price.
function customerMenu(branchId, packageIds, at = Date.now()) {
  const d = db.get();
  const s = branchSettings(branchId);
  const lp = localParts(at, s.timezone);
  const cats = d.prepare('SELECT * FROM categories WHERE (branch_id IS NULL OR branch_id=?) AND active=1 ORDER BY sort, id').all(branchId)
    .map((c) => ({ id: c.id, name: db.J(c.name, {}) }));
  if (!packageIds.length) return { categories: cats, items: [] };
  const ph = packageIds.map(() => '?').join(',');
  const rows = d.prepare(`SELECT m.*, GROUP_CONCAT(mp.package_id) pkgs, MIN(COALESCE(mp.extra_price, m.extra_price)) eff_extra
    FROM menu_items m JOIN menu_item_packages mp ON mp.menu_item_id=m.id AND mp.package_id IN (${ph})
    WHERE (m.branch_id IS NULL OR m.branch_id=?) AND m.status != 'stopped'
    GROUP BY m.id ORDER BY m.sort, m.id`).all(...packageIds, branchId);
  const opts = optionsFor(rows.map((r) => r.id));
  const items = rows.map((m) => {
    const it = itemRow(m);
    const inTime = inWindow(lp.minutes, m.available_from, m.available_to);
    return {
      id: it.id, category_id: it.category_id, name: it.name, description: it.description, ingredients: it.ingredients, allergens: it.allergens,
      image: it.image, tags: it.tags, extra_price: m.eff_extra, max_per_order: it.max_per_order,
      packages: String(m.pkgs).split(',').map(Number),
      status: m.status === 'out' ? 'out' : inTime ? 'available' : 'not_now',
      available_from: it.available_from, available_to: it.available_to, options: opts[m.id] || [],
    };
  });
  return { categories: cats.filter((c) => items.some((i) => i.category_id === c.id)), items };
}

module.exports = { itemRow, optionsFor, customerMenu, assetUrl };
