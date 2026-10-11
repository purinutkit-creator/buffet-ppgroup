'use strict';
// End-to-end acceptance workflow (section 20): open table 7 → QR print → order → kitchen → staff call →
// member signup + promotion → payment → close → old QR rejected → new session/QR on reopen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startAll, client, socket, until, key, server } = require('./helpers');

let env, staff, ids = {};

test.before(async () => {
  env = await startAll();
  staff = client(env.base);
  const login = await staff.post('/api/auth/login', { code: 'OWNER', pin: '123456' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  staff.setToken(login.data.token);
  ids.branch = login.data.branch_id;
});
test.after(async () => { await server.stop(env.srv); env.printer.close(); });

test('configure restaurant: floor, package, menu, printer, routes, promotion', async () => {
  let r = await staff.post('/api/admin/zones', { name: 'Main hall' }); assert.equal(r.status, 201); ids.zone = r.data.id;
  r = await staff.post('/api/admin/tables', { code: '7', zone_id: ids.zone, seats: 6 }); assert.equal(r.status, 201); ids.t7 = r.data.id;
  r = await staff.post('/api/admin/tables', { code: '8', zone_id: ids.zone, seats: 4 }); assert.equal(r.status, 201); ids.t8 = r.data.id;
  r = await staff.post('/api/admin/tables', { code: '7', zone_id: ids.zone }); assert.equal(r.status, 409, 'duplicate table code rejected');

  // overlapping age ranges are rejected
  r = await staff.post('/api/admin/packages', { code: 'BAD', name: { th: 'x' }, duration_min: 90, prices: [
    { code: 'adult', label: { th: 'ผู้ใหญ่' }, rule_type: 'age', min_value: 11, max_value: 59, price: 99900 },
    { code: 'child', label: { th: 'เด็ก' }, rule_type: 'age', min_value: 4, max_value: 11, price: 29900 }] });
  assert.equal(r.status, 400); assert.match(r.data.error.message, /ทับซ้อน/);

  r = await staff.post('/api/admin/packages', { code: 'HAPPINESS', name: { th: 'HAPPINESS COURSE', en: 'Happiness Course' }, duration_min: 180, max_per_round: 10, round_per_guest: true,
    overtime_fee: { block_min: 15, amount_per_guest: 5000 }, prices: [
      { code: 'toddler', label: { th: 'เด็กเล็ก' }, rule_type: 'age', min_value: 0, max_value: 3, price: 0 },
      { code: 'child', label: { th: 'เด็ก' }, rule_type: 'age', min_value: 4, max_value: 10, price: 29900 },
      { code: 'adult', label: { th: 'ผู้ใหญ่' }, rule_type: 'age', min_value: 11, max_value: 59, price: 99900, is_default: true },
      { code: 'senior', label: { th: 'ผู้สูงอายุ' }, rule_type: 'age', min_value: 60, price: 79900 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data)); ids.happy = r.data.package.id;
  r = await staff.post('/api/admin/packages', { code: 'PREMIUM', name: { th: 'PREMIUM COURSE' }, duration_min: 120, prices: [{ code: 'adult', label: { th: 'ผู้ใหญ่' }, rule_type: 'none', price: 149900, is_default: true }] });
  ids.premium = r.data.package.id;

  r = await staff.post('/api/admin/categories', { name: { th: 'Special Menu', en: 'Special Menu' } }); ids.cat = r.data.id;
  const st = (await staff.get('/api/admin/stations')).data.items; ids.hot = st.find((s) => s.code === 'HOT').id; ids.cold = st.find((s) => s.code === 'COLD').id;
  r = await staff.post('/api/admin/menu-items', { name: { th: 'แซลมอนซาชิมิ', en: 'Salmon sashimi' }, category_id: ids.cat, station_id: ids.cold, max_per_order: 5, cost: 4000, packages: [ids.happy, ids.premium],
    options: [{ name: { th: 'ซอส' }, type: 'single', required: true, choices: [{ id: 'wasabi', name: { th: 'วาซาบิ' } }, { id: 'soy', name: { th: 'โชยุ' } }] }] });
  assert.equal(r.status, 201); ids.salmon = r.data.id;
  r = await staff.post('/api/admin/menu-items', { name: { th: 'กุ้งแม่น้ำเผา' }, category_id: ids.cat, station_id: ids.hot, extra_price: 19900, max_per_guest: 1, packages: [ids.happy] }); ids.prawn = r.data.id;
  r = await staff.post('/api/admin/menu-items', { name: { th: 'เนื้อวากิว' }, category_id: ids.cat, station_id: ids.hot, packages: [ids.premium] }); ids.wagyu = r.data.id;

  r = await staff.post('/api/admin/printers', { name: 'Printer A', connection: 'network', address: env.printerAddr, paper_width: 80 });
  assert.equal(r.status, 201); ids.printer = r.data.id;
  r = await staff.put('/api/admin/print-routes', { routes: ['qr_ticket', 'member_signup', 'kitchen', 'receipt', 'close_summary', 'tax_invoice'].map((doc_type) => ({ doc_type, printer_id: ids.printer, copies: 1, auto: true })) });
  assert.equal(r.status, 200);
  r = await staff.post(`/api/admin/printers/${ids.printer}/probe`); assert.equal(r.data.ok, true);

  r = await staff.post('/api/admin/promotions', { code: 'FREEPRAWN', name: { th: 'กุ้งฟรี 1 ตัว' }, type: 'free_item', menu_item_id: ids.prawn, points_cost: 10, members_only: true });
  assert.equal(r.status, 201); ids.promo = r.data.id;
});

let session, token, cust, custSock, staffSock, kdsSock;

test('open table 7 for 5 adults with HAPPINESS COURSE: times, totals, QR + member slip printed', async () => {
  staffSock = socket(env.base, { staffToken: staff.token }); await staffSock.connected;
  const before = env.received.length;
  const r = await staff.post('/api/pos/sessions', { table_id: ids.t7, groups: [{ package_id: ids.happy, price_code: 'adult', count: 5 }], contact_name: 'คุณ A' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  session = r.data; token = session.token;
  assert.equal(session.guests_count, 5);
  assert.equal(session.end_at - session.start_at, 180 * 60000);
  assert.match(session.public_code, /^BF\d{5}$/);
  // 4,995.00 + SC 499.50 + VAT 384.62 = 5,879.12 (as on the sample receipt)
  assert.equal(session.bill_preview.package_total, 499500);
  assert.equal(session.bill_preview.service_charge, 49950);
  assert.equal(session.bill_preview.vat, 38462);
  assert.equal(session.bill_preview.total, 587912);
  assert.deepEqual(session.print_jobs.map((j) => j.doc_type).sort(), ['member_signup', 'qr_ticket']);
  await until(() => env.received.length >= before + 2);
  const bytes = env.received[env.received.length - 1];
  assert.ok(bytes.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])), 'ESC/POS raster image sent to printer');
  const occupied = await staff.post('/api/pos/sessions', { table_id: ids.t7, groups: [{ package_id: ids.happy, count: 1 }] });
  assert.equal(occupied.status, 409);
});

test('customer scans the QR: session info, menu limited to package', async () => {
  cust = client(env.base);
  const page = await fetch(`${env.base}/t/${token}`); assert.equal(page.status, 200);
  let r = await cust.get(`/api/c/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.session.table_code, '7');
  assert.equal(r.data.session.guests_count, 5);
  assert.ok(!JSON.stringify(r.data).includes(token), 'token is never echoed back');
  r = await cust.get(`/api/c/${token}/menu`);
  const names = r.data.items.map((i) => i.name.th);
  assert.ok(names.includes('แซลมอนซาชิมิ') && names.includes('กุ้งแม่น้ำเผา'));
  assert.ok(!names.includes('เนื้อวากิว'), 'premium-only item hidden');
  custSock = socket(env.base, { sessionToken: token }); await custSock.connected;
  kdsSock = socket(env.base, { staffToken: staff.token }); await kdsSock.connected; kdsSock.s.emit('join', 'kds');
});

let order;
test('customer orders → validation on server, idempotency, kitchen receives instantly', async () => {
  // not in package → 403
  let r = await cust.post(`/api/c/${token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.wagyu, qty: 1 }] });
  assert.equal(r.status, 403);
  // missing required option
  r = await cust.post(`/api/c/${token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.salmon, qty: 1 }] });
  assert.equal(r.status, 400);
  // over max per order
  r = await cust.post(`/api/c/${token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.salmon, qty: 6, options: [{ option_id: 0, choice_ids: [] }] }] });
  assert.ok([400, 409].includes(r.status));
  const menuR = await cust.get(`/api/c/${token}/menu`);
  const opt = menuR.data.items.find((i) => i.id === ids.salmon).options[0];
  const k = key();
  const body = { idempotency_key: k, items: [{ menu_item_id: ids.salmon, qty: 2, options: [{ option_id: opt.id, choice_ids: ['wasabi'] }], note: 'ไม่ใส่หัวหอม' }, { menu_item_id: ids.prawn, qty: 1 }] };
  const before = env.received.length;
  const [a, b] = await Promise.all([cust.post(`/api/c/${token}/orders`, body), cust.post(`/api/c/${token}/orders`, body)]);
  assert.ok([a.status, b.status].includes(201));
  assert.equal(a.data.order.id, b.data.order.id, 'double submit creates a single order');
  order = a.data.order;
  assert.equal(order.items.length, 2);
  const kds = await kdsSock.waitFor('kds:new', (p) => p.order.id === order.id);
  assert.equal(kds.order.table_code, '7');
  const t = await staff.get('/api/kds/tickets');
  assert.equal(t.data.tickets.filter((x) => x.order_id === order.id).length, 2, 'one ticket per station');
  await until(() => env.received.length >= before + 2); // kitchen slips per station (same printer A)
  // per-guest cap on prawn: 1 per guest × 5 guests = 5 for the table (no guest selected)
  r = await cust.post(`/api/c/${token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.prawn, qty: 5 }] });
  assert.equal(r.status, 409); assert.equal(r.data.error.code, 'max_per_guest');
});

test('kitchen updates item status → customer sees it in real time', async () => {
  const item = order.items.find((i) => i.name.th === 'แซลมอนซาชิมิ');
  let r = await staff.post('/api/kds/items', { item_ids: [item.id], status: 'cooking' });
  assert.equal(r.status, 200);
  const ev = await custSock.waitFor('order:updated', (p) => p.order.items.some((i) => i.id === item.id && i.status === 'cooking'));
  assert.equal(ev.order.status, 'sent', 'order status = least progressed item');
  r = await staff.post('/api/kds/items', { item_ids: [item.id], status: 'ready' });
  await custSock.waitFor('order:updated', (p) => p.order.items.some((i) => i.id === item.id && i.status === 'ready'));
  const h = await cust.get(`/api/c/${token}/orders`);
  assert.equal(h.data.orders[0].items.find((i) => i.id === item.id).status, 'ready');
  r = await staff.post('/api/kds/items', { item_ids: [item.id], status: 'received' });
  assert.equal(r.status, 409, 'invalid transition rejected');
});

test('customer calls staff → staff dashboard notified, cooldown prevents spam', async () => {
  const types = (await cust.get(`/api/c/${token}`)).data.call_types;
  const water = types.find((t) => t.name.th === 'ขอน้ำดื่ม');
  let r = await cust.post(`/api/c/${token}/calls`, { type_id: water.id });
  assert.equal(r.status, 201);
  const ev = await staffSock.waitFor('call:new', (p) => p.call.id === r.data.call.id);
  assert.equal(ev.call.table_code, '7');
  const again = await cust.post(`/api/c/${token}/calls`, { type_id: water.id });
  assert.equal(again.status, 429);
  r = await staff.post(`/api/pos/calls/${ev.call.id}`, { status: 'accepted' });
  assert.equal(r.data.call.status, 'accepted');
  await custSock.waitFor('call:updated', (p) => p.call.id === ev.call.id && p.call.status === 'accepted');
  r = await staff.post(`/api/pos/calls/${ev.call.id}`, { status: 'done' });
  assert.equal(r.data.call.status, 'done');
});

let memberToken;
test('customer signs up as member during the meal and redeems a promotion', async () => {
  let r = await cust.post(`/api/c/${token}/member/otp`, { phone: '0812345678' });
  assert.equal(r.status, 200); assert.match(r.data.dev_code, /^\d{6}$/);
  const bad = await cust.post(`/api/c/${token}/member/verify`, { phone: '0812345678', code: '000000' === r.data.dev_code ? '111111' : '000000' });
  assert.equal(bad.status, 400);
  r = await cust.post(`/api/c/${token}/member/verify`, { phone: '0812345678', code: r.data.dev_code, first_name: 'สมชาย', consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  memberToken = r.data.member_token;
  assert.equal(r.data.member.points, 50, 'sign-up bonus');
  r = await cust.get(`/api/c/${token}/member`);
  assert.equal(r.status, 403, 'member data requires the member token');
  r = await cust.get(`/api/c/${token}/member`, { 'x-member-token': memberToken });
  const promo = r.data.promotions.find((p) => p.id === ids.promo);
  assert.equal(promo.ineligible, null);
  r = await cust.post(`/api/c/${token}/member/redeem`, { promotion_id: ids.promo }, { 'x-member-token': memberToken });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.member.points, 40);
  const bill = (await staff.get(`/api/pos/sessions/${session.id}/bill`)).data;
  assert.equal(bill.extras_total, 19900);
  assert.equal(bill.discount_total, 19900, 'free prawn discount applied');
  assert.equal(bill.total, 587912);
});

let paidBill;
test('payment in one DB transaction closes the table, revokes QR, prints receipt, earns points', async () => {
  let r = await staff.post(`/api/pos/sessions/${session.id}/checkout`, { split: { mode: 'none' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const bill = r.data.bills[0];
  assert.equal(bill.total, 587912);
  const blocked = await cust.post(`/api/c/${token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.prawn, qty: 1 }] });
  assert.equal(blocked.status, 409, 'ordering locked while billing');
  const methods = (await staff.get('/api/pos/bootstrap')).data.payment_methods;
  const cash = methods.find((m) => m.type === 'cash');
  const before = env.received.length;
  r = await staff.post(`/api/pos/bills/${bill.id}/pay`, { idempotency_key: key(), payments: [{ method_id: cash.id, amount: 587912, received: 600000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.session_closed, true);
  assert.equal(r.data.bill.payments[0].change_amount, 12088);
  paidBill = r.data.bill;
  await custSock.waitFor('session:closed');
  await until(() => env.received.length >= before + 2); // receipt + close summary
  const m = await staff.get('/api/pos/members?q=0812345678');
  assert.equal(m.data.members[0].points, 40 + Math.floor(587912 / 5000), 'points earned after payment (50 THB = 1 pt)');
  const tables = (await staff.get('/api/pos/tables')).data.tables;
  assert.equal(tables.find((t) => t.id === ids.t7).display_status, 'cleaning');
});

test('re-scanning the old QR cannot order; reopening table 7 gives a brand new session & QR', async () => {
  let r = await cust.get(`/api/c/${token}`);
  assert.equal(r.status, 410); assert.equal(r.data.error.code, 'session_ended');
  r = await cust.post(`/api/c/${token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.salmon, qty: 1 }] });
  assert.equal(r.status, 410);
  r = await cust.post(`/api/c/${token}/calls`, {});
  assert.equal(r.status, 410);
  r = await staff.post(`/api/pos/tables/${ids.t7}/status`, { status: 'available' });
  assert.equal(r.status, 200);
  r = await staff.post('/api/pos/sessions', { table_id: ids.t7, groups: [{ package_id: ids.happy, count: 2 }, { package_id: ids.happy, age: 7, count: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.notEqual(r.data.id, session.id);
  assert.notEqual(r.data.public_code, session.public_code);
  assert.notEqual(r.data.token, token);
  assert.equal(r.data.bill_preview.package_total, 99900 * 2 + 29900, 'age 7 → child price');
  const old = await cust.get(`/api/c/${token}`);
  assert.equal(old.status, 410, 'old QR still dead after reopen');
  const fresh = await cust.get(`/api/c/${r.data.token}`);
  assert.equal(fresh.status, 200);
  ids.session2 = r.data.id; ids.token2 = r.data.token;
});

test('refund needs manager approval and reverses points proportionally', async () => {
  let r = await staff.post(`/api/pos/bills/${paidBill.id}/refund`, { amount: 100000, reason: 'อาหารไม่ครบ' });
  assert.equal(r.status, 428, 'approval required');
  r = await staff.post(`/api/pos/bills/${paidBill.id}/refund`, { amount: 100000, reason: 'อาหารไม่ครบ', approval: { code: 'OWNER', pin: '123456' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.bill.status, 'partially_refunded');
  assert.equal(r.data.points_reversed, Math.round(117 * 100000 / 587912));
  const audit = await staff.get('/api/admin/audit?action=payment.refund');
  assert.equal(audit.data.logs[0].approver_id != null, true);
});

test('regenerating a QR revokes the previous one immediately; move & extend work', async () => {
  let r = await staff.post(`/api/pos/sessions/${ids.session2}/qr/regenerate`);
  assert.equal(r.status, 200);
  assert.equal((await cust.get(`/api/c/${ids.token2}`)).status, 404);
  assert.equal((await cust.get(`/api/c/${r.data.token}`)).status, 200);
  const before = r.data.end_at;
  r = await staff.post(`/api/pos/sessions/${ids.session2}/extend`, { minutes: 30 });
  assert.equal(r.data.end_at, before + 30 * 60000);
  r = await staff.post(`/api/pos/sessions/${ids.session2}/move`, { table_id: ids.t8 });
  assert.equal(r.status, 200); assert.equal(r.data.table.code, '8');
});

test('theme settings render to CSS and are validated', async () => {
  let r = await staff.post('/api/admin/themes', { name: 'Navy', activate: true, settings: { colors: { primary: '#112233' }, scopes: { customer: { font_family: 'Prompt', sizes: { store_name: 34 } } } } });
  assert.equal(r.status, 200);
  const css = await (await fetch(`${env.base}/theme.css?scope=customer`)).text();
  assert.match(css, /--primary:#112233/); assert.match(css, /--fs-store:34px/); assert.match(css, /family=Prompt/);
  r = await staff.post('/api/admin/themes', { name: 'Evil', settings: { colors: { primary: 'red;}body{display:none' } } });
  assert.equal(r.status, 400);
});

test('reports and exports', async () => {
  let r = await staff.get('/api/admin/reports/summary');
  assert.equal(r.status, 200); assert.ok(r.data.totals.total >= 587912);
  r = await staff.get('/api/admin/reports/top_items');
  assert.equal(r.data.rows[0].name, 'แซลมอนซาชิมิ');
  for (const f of ['csv', 'xlsx', 'pdf']) { r = await staff.get(`/api/admin/reports/sales?format=${f}`); assert.equal(r.status, 200, f); assert.ok(r.data.length > 50); }
});
