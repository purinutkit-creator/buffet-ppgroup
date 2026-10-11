'use strict';
// First-time setup: restaurant, first branch, system roles, owner account and sensible defaults (configuration, not sample data).
const db = require('./db');
const auth = require('./auth');
const theme = require('./services/theme');
const { now, i18nInput } = require('./lib/util');

function setup({ restaurantName, branchCode = 'MAIN', branchName, ownerCode, ownerName = 'Owner', ownerPin, taxId = null, phone = null }) {
  const d = db.open();
  if (d.prepare('SELECT 1 FROM restaurants').get()) throw new Error('ระบบถูกตั้งค่าไปแล้ว (restaurant exists)');
  if (!auth.validPin(ownerPin)) throw new Error('PIN ต้องเป็นตัวเลข 4-8 หลัก');
  if (!/^[A-Za-z0-9]{2,20}$/.test(ownerCode || '')) throw new Error('รหัสพนักงานไม่ถูกต้อง');
  return d.transaction(() => {
    const rid = d.prepare('INSERT INTO restaurants(name, tax_id, phone, contact, created_at) VALUES(?,?,?,?,?)').run(JSON.stringify(i18nInput(restaurantName)), taxId, phone, '{}', now()).lastInsertRowid;
    const bid = d.prepare('INSERT INTO branches(restaurant_id, code, name, address, phone, tax_id, settings, created_at) VALUES(?,?,?,?,?,?,?,?)').run(rid, branchCode, JSON.stringify(i18nInput(branchName || restaurantName)), '{}', phone, taxId, '{}', now()).lastInsertRowid;
    const roleIds = {};
    for (const r of auth.DEFAULT_ROLES) roleIds[r.code] = d.prepare('INSERT INTO roles(restaurant_id, code, name, permissions, is_system) VALUES(?,?,?,?,1)').run(rid, r.code, r.name, JSON.stringify(r.permissions)).lastInsertRowid;
    const sid = d.prepare('INSERT INTO staff(restaurant_id, code, name, role_id, pin_hash, branch_ids, created_at) VALUES(?,?,?,?,?,?,?)').run(rid, ownerCode, ownerName, roleIds.owner, auth.hashPin(ownerPin), '[]', now()).lastInsertRowid;
    d.prepare("INSERT INTO payment_methods(branch_id, code, name, type, config, sort) VALUES(NULL,'cash','เงินสด','cash','{}',0)").run();
    d.prepare("INSERT INTO payment_methods(branch_id, code, name, type, config, sort) VALUES(NULL,'card','บัตรเครดิต/เดบิต','card','{}',2)").run();
    d.prepare("INSERT INTO payment_methods(branch_id, code, name, type, config, sort) VALUES(NULL,'transfer','โอนเงิน','transfer','{}',3)").run();
    const calls = [
      [{ th: 'เรียกพนักงาน', en: 'Call staff', zh: '呼叫服务员' }, '🙋', '#0b2a6f', 0],
      [{ th: 'ขอน้ำดื่ม', en: 'Water please', zh: '要一杯水' }, '💧', '#0ea5e9', 0],
      [{ th: 'ขอช้อนส้อม', en: 'Cutlery', zh: '餐具' }, '🍴', '#64748b', 0],
      [{ th: 'ทำความสะอาด', en: 'Clean table', zh: '清理桌子' }, '🧽', '#16a34a', 0],
      [{ th: 'เรียกคิดเงิน', en: 'Request bill', zh: '买单' }, '🧾', '#c9a45c', 1],
      [{ th: 'แจ้งปัญหา', en: 'Report a problem', zh: '反映问题' }, '⚠️', '#dc2626', 0],
    ];
    calls.forEach(([n, i, c, bill], idx) => d.prepare('INSERT INTO staff_call_types(branch_id, name, icon, color, sort, is_bill) VALUES(NULL,?,?,?,?,?)').run(JSON.stringify(n), i, c, idx, bill));
    const tiers = [['BRONZE', { th: 'Bronze', en: 'Bronze', zh: '铜卡' }, '#a97142', 0], ['SILVER', { th: 'Silver', en: 'Silver', zh: '银卡' }, '#9ca3af', 1000000], ['GOLD', { th: 'Gold', en: 'Gold', zh: '金卡' }, '#c9a45c', 3000000], ['PLATINUM', { th: 'Platinum', en: 'Platinum', zh: '白金卡' }, '#334155', 8000000]];
    tiers.forEach(([code, n, c, min], i) => d.prepare('INSERT INTO tiers(restaurant_id, code, name, color, min_spent, baht_per_point, multiplier, sort) VALUES(?,?,?,?,?,?,?,?)').run(rid, code, JSON.stringify(n), c, min, 50, 1 + i * 0.25, i));
    for (const [code, name, color] of [['HOT', 'ครัวร้อน', '#dc2626'], ['COLD', 'ครัวเย็น / ซูชิ', '#0ea5e9'], ['DRINK', 'เครื่องดื่ม / บาร์', '#16a34a'], ['DESSERT', 'ของหวาน', '#db2777']])
      d.prepare('INSERT INTO kitchen_stations(branch_id, code, name, color) VALUES(?,?,?,?)').run(bid, code, name, color);
    theme.saveTheme(bid, { name: 'Default', settings: {}, activate: true });
    return { restaurant_id: rid, branch_id: bid, owner_id: sid };
  })();
}

module.exports = { setup };
