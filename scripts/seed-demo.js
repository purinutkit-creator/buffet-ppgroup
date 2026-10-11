'use strict';
// Demo data for trying the system (tables, packages, menu with generated placeholder images, staff accounts).
// Usage: npm run seed:demo   — creates the restaurant too if "npm run setup" was not run.
// Remove/replace this data from the Admin before going live.
const db = require('../server/db');
const { setup } = require('../server/bootstrap');
const auth = require('../server/auth');
const media = require('../server/services/media');
const { createCanvas } = require('@napi-rs/canvas');
const { registerBundled } = require('../server/print/fonts');

const d = db.open();
registerBundled();
const now = Date.now();

if (!d.prepare('SELECT 1 FROM restaurants').get()) {
  setup({ restaurantName: { th: 'Papper international buffet Bangsaen', en: 'Papper international buffet Bangsaen', zh: 'Papper 国际自助餐 邦盛' }, branchCode: 'BS', branchName: { th: 'Papper international buffet Bangsaen', en: 'Papper international buffet Bangsaen' }, ownerCode: 'OWNER', ownerName: 'เจ้าของร้าน', ownerPin: process.env.SEED_OWNER_PIN || '123456', taxId: '0205565018968', phone: '061-441-1308' });
  console.log(`Created restaurant + owner OWNER / PIN ${process.env.SEED_OWNER_PIN ? '(from SEED_OWNER_PIN)' : '123456'}`);
}
if (d.prepare('SELECT 1 FROM buffet_packages').get()) { console.log('Demo data already present — skipping.'); process.exit(0); }
const rid = d.prepare('SELECT id FROM restaurants').get().id;
const bid = d.prepare('SELECT id FROM branches ORDER BY id').get().id;
d.prepare('UPDATE branches SET address=? WHERE id=?').run(JSON.stringify({ th: 'เลขที่ 7 ซอย 8 (ถนนบางแสนล่าง) ต.แสนสุข อ.เมืองชลบุรี จ.ชลบุรี 20130', en: '7 Soi 8 Bangsaen Lang Rd, Saen Suk, Mueang Chon Buri, Chon Buri 20130' }), bid);

function placeholder(w, h, title, sub, colors) {
  const c = createCanvas(w, h); const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.globalAlpha = 0.12; x.fillStyle = '#fff';
  for (let i = 0; i < 6; i++) { x.beginPath(); x.arc((i * 173) % w, (i * 97) % h, w / 5, 0, Math.PI * 2); x.fill(); }
  x.globalAlpha = 1; x.fillStyle = '#fff'; x.textAlign = 'center';
  x.font = `bold ${Math.round(w / 11)}px Sarabun`; x.fillText(title, w / 2, h / 2);
  if (sub) { x.font = `${Math.round(w / 22)}px Sarabun`; x.globalAlpha = 0.8; x.fillText(sub, w / 2, h / 2 + w / 12); }
  return c.toBuffer('image/png');
}
async function asset(kind, buf, name) { return (await media.save({ buffer: buf, originalname: name }, { kind, restaurantId: rid, staffId: null, maxMb: 10 })).id; }

(async () => {
  // Logo, banners
  const logoC = createCanvas(512, 512); const lx = logoC.getContext('2d');
  lx.fillStyle = '#0b2a6f'; lx.fillRect(0, 0, 512, 512); lx.fillStyle = '#d9c49a'; lx.textAlign = 'center';
  lx.font = 'bold 190px Sarabun'; lx.fillText('P', 256, 270); lx.font = '64px Sarabun'; lx.fillText('PAPPER', 256, 390);
  const logo = await asset('logo', logoC.toBuffer('image/png'), 'logo.png');
  const banner = await asset('banner', placeholder(1920, 800, 'Grand Prawn', 'The menu with the most • Starting price 999++', ['#2b2b2b', '#5a3a1a']), 'banner.png');
  const bannerM = await asset('banner_mobile', placeholder(1080, 600, 'Grand Prawn', 'Starting price 999++', ['#2b2b2b', '#5a3a1a']), 'banner-m.png');
  d.prepare('UPDATE restaurants SET logo_asset_id=? WHERE id=?').run(logo, rid);
  d.prepare('UPDATE branches SET logo_asset_id=?, banner_asset_id=?, banner_mobile_asset_id=? WHERE id=?').run(logo, banner, bannerM, bid);

  // Terms (reference screenshot 1)
  const s = JSON.parse(d.prepare('SELECT settings FROM branches WHERE id=?').get(bid).settings || '{}');
  s.terms = {
    th: '<p>ขอบคุณที่ใช้บริการ PAPPER BUFFET เพื่อให้ทุกท่านได้รับประสบการณ์ที่ดีที่สุด กรุณาปฏิบัติตามเงื่อนไขดังต่อไปนี้</p><ol><li>รับประทานอาหารได้ภายในเวลา 3 ชั่วโมง</li><li>ทะยอยสั่งอาหารได้ตลอดระยะเวลาการทาน</li><li>สามารถถ่ายรูปและเช็คอินเพื่อรับไวน์แดง (11.00-14.00 และ 17.00-22.00)</li><li>หากได้รับอาหารไม่ครบ สามารถแจ้งพนักงานได้ทันที</li><li>ชำระเงินที่เคาน์เตอร์และเก็บใบเสร็จไว้</li></ol><p>หากมีปัญหาหรือข้อสงสัยใดๆ กรุณาแจ้งพนักงานเพื่อรับการช่วยเหลือ หรือติดต่อไลน์ @papper</p>',
    en: '<p>Thank you for dining at PAPPER BUFFET.</p><ol><li>Dining time is 3 hours</li><li>Order as many rounds as you like during your dining time</li><li>Check in to receive a glass of red wine (11:00-14:00 and 17:00-22:00)</li><li>Let our staff know if any dish is missing</li><li>Please pay at the counter and keep your receipt</li></ol><p>Questions? Ask our staff or LINE @papper</p>',
    zh: '<p>感谢光临 PAPPER BUFFET。</p><ol><li>用餐时间为 3 小时</li><li>用餐期间可随时分批点餐</li><li>拍照打卡可获赠红酒 (11:00-14:00 及 17:00-22:00)</li><li>如有漏单请立即告知服务员</li><li>请在柜台付款并保留收据</li></ol>' };
  d.prepare('UPDATE branches SET settings=? WHERE id=?').run(JSON.stringify(s), bid);

  // Floor plan
  const z1 = d.prepare('INSERT INTO zones(branch_id, name, kind, sort) VALUES(?,?,?,?)').run(bid, 'Main Hall', 'normal', 0).lastInsertRowid;
  const z2 = d.prepare('INSERT INTO zones(branch_id, name, kind, sort) VALUES(?,?,?,?)').run(bid, 'VIP', 'vip', 1).lastInsertRowid;
  for (let i = 1; i <= 12; i++) d.prepare('INSERT INTO tables(branch_id, zone_id, code, shape, seats, x, y, w, h) VALUES(?,?,?,?,?,?,?,?,?)').run(bid, z1, String(i), i % 3 === 0 ? 'round' : 'square', i % 4 === 0 ? 6 : 4, 30 + ((i - 1) % 4) * 140, 30 + Math.floor((i - 1) / 4) * 140, 100, 100);
  for (let i = 20; i <= 23; i++) d.prepare('INSERT INTO tables(branch_id, zone_id, code, shape, seats, x, y, w, h) VALUES(?,?,?,?,?,?,?,?,?)').run(bid, z2, `V.${i}`, 'rect', 8, 30 + (i - 20) * 200, 40, 160, 100);

  // Packages
  const pk = {};
  const pkgs = [
    ['DELIGHT', 'DELIGHT COURSE', 'Delight Course', 999, '#0b2a6f', 180],
    ['HAPPINESS', 'HAPPINESS COURSE', 'Happiness Course', 999, '#a16207', 180],
    ['PREMIUM', 'PREMIUM COURSE', 'Premium Course', 1499, '#7c2d12', 150],
    ['GRAND', 'GRAND COURSE', 'Grand Course', 1999, '#111827', 150],
  ];
  pkgs.forEach(([code, th, en, price, color, dur], i) => {
    const id = d.prepare(`INSERT INTO buffet_packages(branch_id, code, name, description, color, duration_min, max_per_round, round_per_guest, round_interval_min, overtime_fee, leftover_policy, sort, created_at) VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(code, JSON.stringify({ th, en, zh: en }), JSON.stringify({ th: `บุฟเฟต์ ${th} ทานได้ ${dur} นาที`, en: `${en}, ${dur} minutes` }), color, dur, 6, 1, 0, JSON.stringify({ block_min: 15, amount_per_guest: 5000 }), JSON.stringify({ text: { th: 'กรณีที่ลูกค้าสั่งอาหารและทานไม่หมด ทางร้านขออนุญาตปรับตามราคา A la Carte' } }), i, now).lastInsertRowid;
    pk[code] = id;
    const rows = [['toddler', { th: 'เด็กเล็ก (0-3 ปี)', en: 'Toddler', zh: '幼儿' }, 'age', 0, 3, 0, 0], ['child', { th: 'เด็ก (4-10 ปี)', en: 'Child', zh: '儿童' }, 'age', 4, 10, Math.round(price * 0.3) * 100 - 100, 0], ['adult', { th: 'ผู้ใหญ่', en: 'Adult', zh: '成人' }, 'age', 11, 59, price * 100, 1], ['senior', { th: 'ผู้สูงอายุ (60+)', en: 'Senior', zh: '长者' }, 'age', 60, null, Math.round(price * 0.8) * 100, 0]];
    rows.forEach(([c, l, t, mn, mx, p, def], j) => d.prepare('INSERT INTO package_prices(package_id, code, label, rule_type, min_value, max_value, price, is_default, sort) VALUES(?,?,?,?,?,?,?,?,?)').run(id, c, JSON.stringify(l), t, mn, mx, Math.max(0, p), def, j));
  });

  // Categories & menu
  const st = Object.fromEntries(d.prepare('SELECT code, id FROM kitchen_stations WHERE branch_id=?').all(bid).map((x) => [x.code, x.id]));
  const cats = {};
  [['special', 'Special Menu', 'Special Menu', '特别推荐'], ['recommend', 'Recommend Menu', 'Recommend Menu', '推荐菜'], ['sushi', 'ซูชิ', 'Sushi', '寿司'], ['sashimi', 'ซาชิมิ', 'Sashimi', '刺身'], ['seafood', 'ซีฟู้ด', 'Seafood', '海鲜'], ['meat', 'เนื้อสัตว์', 'Meat', '肉类'], ['dessert', 'ของหวาน', 'Dessert', '甜点'], ['drink', 'เครื่องดื่ม', 'Beverage', '饮品']]
    .forEach(([k, th, en, zh], i) => { cats[k] = d.prepare('INSERT INTO categories(name, sort) VALUES(?,?)').run(JSON.stringify({ th, en, zh }), i).lastInsertRowid; });
  const ALL = ['DELIGHT', 'HAPPINESS', 'PREMIUM', 'GRAND'], PRE = ['PREMIUM', 'GRAND'];
  const items = [
    ['special', 'จตุรเทพห่อสาหร่าย', 'Four Kings Hand Roll', '四天王手卷', 'ข้าวซูชิห่อสาหร่ายพร้อมไข่กุ้ง อูนิ และแซลมอน', 'COLD', ALL, 0, ['#1e3a8a', '#0f172a'], { allergens: ['อาหารทะเล', 'ถั่วเหลือง'] }],
    ['special', 'เทมากิ พรีเมี่ยม', 'Premium Temaki', '高级手卷', 'เทมากิไข่กุ้ง อูนิ หอยเชลล์', 'COLD', PRE, 0, ['#9a3412', '#1f2937'], { allergens: ['อาหารทะเล'] }],
    ['special', 'กุ้งแม่น้ำเผา', 'Grilled River Prawn', '烤河虾', 'กุ้งแม่น้ำตัวโต เผามันเยิ้ม เสิร์ฟพร้อมน้ำจิ้มซีฟู้ด', 'HOT', ALL, 0, ['#c2410c', '#7c2d12'], { max_per_guest: 2, prep: 15, allergens: ['กุ้ง'] }],
    ['recommend', 'แซลมอนซาชิมิ', 'Salmon Sashimi', '三文鱼刺身', 'แซลมอนนอร์เวย์สด หั่นหนา', 'COLD', ALL, 0, ['#fb923c', '#be123c'], { options: [{ name: { th: 'ซอส', en: 'Sauce', zh: '酱料' }, type: 'single', required: 1, choices: [{ id: 'wasabi', name: { th: 'วาซาบิ', en: 'Wasabi', zh: '芥末' } }, { id: 'ponzu', name: { th: 'พอนสึ', en: 'Ponzu', zh: '柚子醋' } }] }] }],
    ['recommend', 'เนื้อวากิว A5 ย่าง', 'Grilled Wagyu A5', '烤和牛A5', 'วากิว A5 ย่างเตาถ่าน', 'HOT', PRE, 0, ['#7f1d1d', '#1c1917'], { max_per_guest: 2, options: [{ name: { th: 'ระดับความสุก', en: 'Doneness', zh: '熟度' }, type: 'single', required: 1, choices: [{ id: 'mr', name: { th: 'มีเดียมแรร์', en: 'Medium rare', zh: '三分熟' } }, { id: 'm', name: { th: 'มีเดียม', en: 'Medium', zh: '五分熟' } }, { id: 'wd', name: { th: 'สุกมาก', en: 'Well done', zh: '全熟' } }] }] }],
    ['sushi', 'ซูชิแซลมอน', 'Salmon Nigiri', '三文鱼寿司', '', 'COLD', ALL, 0, ['#f97316', '#9a3412'], {}],
    ['sushi', 'ซูชิไข่หวาน', 'Tamago Nigiri', '玉子寿司', '', 'COLD', ALL, 0, ['#facc15', '#a16207'], { allergens: ['ไข่'] }],
    ['sushi', 'ซูชิอูนิ', 'Uni Gunkan', '海胆军舰', 'อูนิฮอกไกโด', 'COLD', PRE, 0, ['#eab308', '#713f12'], { max_per_guest: 2 }],
    ['sashimi', 'ซาชิมิหอยเชลล์', 'Scallop Sashimi', '扇贝刺身', '', 'COLD', ALL, 0, ['#fde68a', '#b45309'], {}],
    ['sashimi', 'ซาชิมิทูน่า', 'Tuna Sashimi', '金枪鱼刺身', '', 'COLD', ALL, 0, ['#be123c', '#4c0519'], {}],
    ['seafood', 'ปูอลาสก้า', 'Alaskan King Crab', '帝王蟹', 'ขาปูอลาสก้านึ่ง', 'HOT', ['GRAND'], 0, ['#dc2626', '#450a0a'], { max_per_guest: 1, prep: 20 }],
    ['seafood', 'หอยนางรมสด', 'Fresh Oyster', '生蚝', 'หอยนางรมฝรั่งเศส', 'COLD', PRE, 0, ['#94a3b8', '#1e293b'], {}],
    ['seafood', 'กุ้งลายเสือย่างเนย', 'Butter Tiger Prawn', '黄油老虎虾', '', 'HOT', ALL, 9900, ['#ea580c', '#431407'], {}],
    ['meat', 'หมูคุโรบุตะย่าง', 'Kurobuta Pork', '黑猪肉', '', 'HOT', ALL, 0, ['#a16207', '#422006'], {}],
    ['meat', 'ซี่โครงแกะย่าง', 'Lamb Chop', '烤羊排', '', 'HOT', PRE, 0, ['#92400e', '#1c1917'], {}],
    ['dessert', 'ไอศกรีมชาเขียว', 'Matcha Ice Cream', '抹茶冰淇淋', '', 'DESSERT', ALL, 0, ['#65a30d', '#14532d'], { allergens: ['นม'] }],
    ['dessert', 'ครีมบรูเล่', 'Crème Brûlée', '焦糖布丁', '', 'DESSERT', ALL, 0, ['#f59e0b', '#78350f'], { allergens: ['นม', 'ไข่'], from: '17:00', to: '23:59' }],
    ['drink', 'ชาเขียวเย็น', 'Iced Green Tea', '冰绿茶', '', 'DRINK', ALL, 0, ['#16a34a', '#052e16'], {}],
    ['drink', 'ไวน์แดง (แก้ว)', 'Red Wine (glass)', '红酒(杯)', 'สำหรับลูกค้าที่เช็คอิน', 'DRINK', ALL, 0, ['#7f1d1d', '#18181b'], { max_per_guest: 1 }],
    ['drink', 'เบียร์สด', 'Draft Beer', '生啤', '', 'DRINK', ALL, 12000, ['#ca8a04', '#422006'], {}],
  ];
  let sort = 0;
  for (const [cat, th, en, zh, desc, station, packages, extra, colors, o] of items) {
    const img = await asset('food', placeholder(800, 800, en, th, colors), `${en}.png`);
    const id = d.prepare(`INSERT INTO menu_items(category_id, name, description, ingredients, allergens, image_asset_id, extra_price, cost, max_per_order, max_per_guest, prep_minutes, station_id, available_from, available_to, tags, sort, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(cats[cat], JSON.stringify({ th, en, zh }), JSON.stringify({ th: desc, en: desc ? en : '', zh: '' }), JSON.stringify({ th: '' }), JSON.stringify(o.allergens || []), img, extra, 2000 + (sort % 5) * 1500, 5, o.max_per_guest || 0, o.prep || 10, st[station], o.from || null, o.to || null, JSON.stringify(cat === 'special' ? ['special'] : cat === 'recommend' ? ['recommended'] : []), sort++, now).lastInsertRowid;
    for (const p of packages) d.prepare('INSERT INTO menu_item_packages(menu_item_id, package_id) VALUES(?,?)').run(id, pk[p]);
    (o.options || []).forEach((op, j) => d.prepare('INSERT INTO menu_options(menu_item_id, name, type, required, choices, sort) VALUES(?,?,?,?,?,?)').run(id, JSON.stringify(op.name), op.type, op.required, JSON.stringify(op.choices.map((c) => ({ ...c, price: 0 }))), j));
  }

  // Staff accounts for each role (demo PINs)
  const roles = Object.fromEntries(d.prepare('SELECT code, id FROM roles').all().map((r) => [r.code, r.id]));
  for (const [code, name, role, pin] of [['M01', 'ผู้จัดการ', 'manager', '1111'], ['C01', 'แคชเชียร์', 'cashier', '2222'], ['W01', 'พนักงานเสิร์ฟ', 'waiter', '3333'], ['K01', 'ครัว', 'kitchen', '4444']])
    if (!d.prepare('SELECT 1 FROM staff WHERE code=?').get(code)) d.prepare('INSERT INTO staff(restaurant_id, code, name, role_id, pin_hash, branch_ids, created_at) VALUES(?,?,?,?,?,?,?)').run(rid, code, name, roles[role], auth.hashPin(process.env.SEED_STAFF_PIN || pin), '[]', now);

  // A promotion
  d.prepare(`INSERT INTO promotions(restaurant_id, code, name, description, type, value, points_cost, members_only, priority, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(rid, 'MEMBER100', JSON.stringify({ th: 'ส่วนลด 100 บาท', en: '100 THB off', zh: '减100泰铢' }), JSON.stringify({ th: 'ใช้ 100 คะแนนแลกส่วนลด 100 บาท' }), 'discount_amount', 10000, 100, 1, 1, now);
  d.prepare(`INSERT INTO promotions(restaurant_id, code, name, description, type, value, from_package_id, to_package_id, points_cost, members_only, priority, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(rid, 'UPGRADE', JSON.stringify({ th: 'อัปเกรดเป็น PREMIUM 1 ท่าน', en: 'Upgrade 1 guest to PREMIUM' }), JSON.stringify({ th: 'ใช้ 300 คะแนน' }), 'package_upgrade', 0, pk.HAPPINESS, pk.PREMIUM, 300, 1, 0, now);
  d.prepare(`INSERT INTO promotions(restaurant_id, code, name, type, value, members_only, points_cost, priority, created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(rid, 'WELCOME10', JSON.stringify({ th: 'ส่วนลด 10% (โค้ดหน้าร้าน)', en: '10% off' }), 'discount_percent', 1000, 0, 0, 0, now);

  console.log(process.env.SEED_STAFF_PIN ? '✔ Demo data created. Staff logins: M01 (manager), C01 (cashier), W01 (waiter), K01 (kitchen) with SEED_STAFF_PIN' : '✔ Demo data created. Staff logins: OWNER/123456, M01/1111 (manager), C01/2222 (cashier), W01/3333 (waiter), K01/4444 (kitchen)');
})();
