'use strict';
// Feature tests: permissions, split bills, merge, print bridge, browser station, media validation, kitchen-ticket reprint rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startAll, client, until, key, server } = require('./helpers');

let env, owner, ids = {};
async function login(code, pin) { const c = client(env.base); const r = await c.post('/api/auth/login', { code, pin }); assert.equal(r.status, 200, JSON.stringify(r.data)); c.setToken(r.data.token); return c; }

test.before(async () => {
  env = await startAll();
  owner = await login('OWNER', '123456');
  let r = await owner.post('/api/admin/tables', { code: 'A1' }); ids.a1 = r.data.id;
  r = await owner.post('/api/admin/tables', { code: 'A2' }); ids.a2 = r.data.id;
  r = await owner.post('/api/admin/tables', { code: 'A3' }); ids.a3 = r.data.id;
  r = await owner.post('/api/admin/packages', { code: 'STD', name: { th: 'STANDARD' }, duration_min: 90, prices: [{ code: 'adult', label: { th: 'ผู้ใหญ่' }, rule_type: 'none', price: 50000, is_default: true }] }); ids.pkg = r.data.package.id;
  r = await owner.post('/api/admin/menu-items', { name: { th: 'ข้าวผัด' }, packages: [ids.pkg] }); ids.rice = r.data.id;
  r = await owner.post('/api/admin/menu-items', { name: { th: 'เบียร์' }, extra_price: 10000, packages: [ids.pkg] }); ids.beer = r.data.id;
  const roles = (await owner.get('/api/admin/roles')).data.roles;
  await owner.post('/api/admin/staff', { code: 'W1', name: 'Waiter', role_id: roles.find((x) => x.code === 'waiter').id, pin: '1111' });
  await owner.post('/api/admin/staff', { code: 'K1', name: 'Kitchen', role_id: roles.find((x) => x.code === 'kitchen').id, pin: '2222' });
});
test.after(async () => { await server.stop(env.srv); env.printer.close(); });

test('role permissions are enforced on the server', async () => {
  const waiter = await login('W1', '1111');
  const kitchen = await login('K1', '2222');
  assert.equal((await waiter.post('/api/admin/packages', { code: 'X1', name: { th: 'x' } })).status, 403);
  assert.equal((await kitchen.post('/api/pos/sessions', { table_id: ids.a1, groups: [{ package_id: ids.pkg, count: 1 }] })).status, 403);
  assert.equal((await waiter.get('/api/admin/reports/summary')).status, 403);
  const bad = await client(env.base).post('/api/auth/login', { code: 'W1', pin: '9999' });
  assert.equal(bad.status, 401);
  assert.equal((await client(env.base).get('/api/pos/tables')).status, 401);
});

test('split bill equally: each part is paid separately; table closes after the last one', async () => {
  let r = await owner.post('/api/pos/sessions', { table_id: ids.a1, groups: [{ package_id: ids.pkg, count: 3 }] });
  const s = r.data;
  await owner.post(`/api/pos/sessions/${s.id}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.beer, qty: 2 }] });
  r = await owner.post(`/api/pos/sessions/${s.id}/checkout`, { split: { mode: 'equal', count: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const bills = r.data.bills;
  assert.equal(bills.length, 3);
  assert.equal(bills.reduce((a, b) => a + b.total, 0), r.data.bill.total, 'parts add up exactly');
  assert.equal(bills.reduce((a, b) => a + b.vat, 0), r.data.bill.vat);
  const cash = (await owner.get('/api/pos/bootstrap')).data.payment_methods.find((m) => m.type === 'cash');
  const card = (await owner.get('/api/pos/bootstrap')).data.payment_methods.find((m) => m.type === 'card');
  for (let i = 0; i < 3; i++) {
    const b = bills[i];
    // split payment on the first bill: card + cash
    const pays = i === 0 ? [{ method_id: card.id, amount: 10000 }, { method_id: cash.id, amount: b.total - 10000, received: b.total }] : [{ method_id: cash.id, amount: b.total }];
    r = await owner.post(`/api/pos/bills/${b.id}/pay`, { idempotency_key: key(), payments: pays });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.session_closed, i === 2);
  }
  const t = (await owner.get('/api/pos/tables')).data.tables.find((x) => x.id === ids.a1);
  assert.equal(t.session, null);
});

test('merge tables keeps orders and the merged QR follows to the target session', async () => {
  let r = await owner.post('/api/pos/tables/' + ids.a1 + '/status', { status: 'available' });
  const s1 = (await owner.post('/api/pos/sessions', { table_id: ids.a2, groups: [{ package_id: ids.pkg, count: 2 }] })).data;
  const s2 = (await owner.post('/api/pos/sessions', { table_id: ids.a3, groups: [{ package_id: ids.pkg, count: 1 }] })).data;
  const cust = client(env.base);
  r = await cust.post(`/api/c/${s2.token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.rice, qty: 1 }] });
  assert.equal(r.status, 201);
  r = await owner.post(`/api/pos/sessions/${s1.id}/merge`, { from_session_id: s2.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.guests_count, 3);
  assert.deepEqual(r.data.guests.map((g) => g.label), ['A', 'B', 'C']);
  const viaOld = await cust.get(`/api/c/${s2.token}`);
  assert.equal(viaOld.status, 200);
  assert.equal(viaOld.data.session.table_code, 'A2');
  const orders = await cust.get(`/api/c/${s1.token}/orders`);
  assert.equal(orders.data.orders.length, 1);
  ids.s1 = s1;
});

test('kitchen slips print only new items; same printer may serve every document', async () => {
  let r = await owner.post('/api/admin/printers', { name: 'Bridge printer', connection: 'bridge', address: 'file:/dev/null', paper_width: 58 });
  assert.equal(r.status, 201); assert.match(r.data.bridge_key, /^pb_/);
  ids.bridge = r.data.id; ids.bridgeKey = r.data.bridge_key;
  r = await owner.put('/api/admin/print-routes', { routes: ['qr_ticket', 'member_signup', 'kitchen', 'receipt', 'close_summary', 'tax_invoice'].map((doc_type) => ({ doc_type, printer_id: ids.bridge, copies: 1, auto: true })) });
  const cust = client(env.base);
  await cust.post(`/api/c/${ids.s1.token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.rice, qty: 2 }] });
  await cust.post(`/api/c/${ids.s1.token}/orders`, { idempotency_key: key(), items: [{ menu_item_id: ids.beer, qty: 1 }] });
  const jobs = (await owner.get('/api/admin/print-jobs?status=pending')).data.jobs.filter((j) => j.doc_type === 'kitchen');
  assert.equal(jobs.length, 2, 'one kitchen slip per new order');
  // Bridge claims ESC/POS bytes and reports the result
  const h = { 'x-bridge-key': ids.bridgeKey };
  const bridge = client(env.base);
  r = await bridge.get('/api/print/bridge/hello', h); assert.equal(r.status, 200); assert.equal(r.data.printer.name, 'Bridge printer');
  r = await bridge.post('/api/print/bridge/claim', {}, h);
  assert.ok(r.data.job, 'job claimed');
  const bytes = Buffer.from(r.data.job.data, 'base64');
  assert.equal(bytes[0], 0x1b); assert.ok(bytes.includes(Buffer.from([0x1d, 0x76, 0x30])));
  // 58mm = 384 dots = 48 bytes per raster row
  const i = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])); assert.equal(bytes[i + 4], 48);
  r = await bridge.post(`/api/print/bridge/jobs/${r.data.job.job.id}/result`, { ok: true }, h); assert.equal(r.status, 200);
  r = await bridge.post('/api/print/bridge/claim', {}, h);
  await bridge.post(`/api/print/bridge/jobs/${r.data.job.job.id}/result`, { ok: false, error: 'paper out' }, h);
  const all = (await owner.get('/api/admin/print-jobs')).data.jobs;
  assert.ok(all.some((j) => j.status === 'printed'));
  assert.ok(all.some((j) => j.error === 'paper out'));
  assert.equal((await bridge.post('/api/print/bridge/claim', {}, { 'x-bridge-key': 'pb_wrong' })).status, 401);
});

test('browser print station claims jobs only for browser printers', async () => {
  let r = await owner.post('/api/admin/printers', { name: 'Tablet BT', connection: 'browser', paper_width: 80 });
  const pid = r.data.id;
  r = await owner.post(`/api/admin/printers/${pid}/test`);
  assert.equal(r.data.jobs.length, 1);
  r = await owner.post(`/api/print/station/${pid}/claim`);
  assert.equal(r.data.job.job.doc_type, 'test');
  r = await owner.post(`/api/print/station/${pid}/jobs/${r.data.job.job.id}/result`, { ok: true });
  assert.equal(r.status, 200);
  assert.equal((await owner.post(`/api/print/station/${ids.bridge}/claim`)).status, 404);
});

test('network printer that is offline: job fails honestly after retries (no fake success)', async () => {
  let r = await owner.post('/api/admin/printers', { name: 'Offline LAN', connection: 'network', address: '127.0.0.1:1', paper_width: 80 });
  const pid = r.data.id;
  r = await owner.post(`/api/admin/printers/${pid}/probe`);
  assert.equal(r.data.ok, false);
  r = await owner.post(`/api/admin/printers/${pid}/test`);
  const jobId = r.data.jobs[0].id;
  await until(async () => (await owner.get('/api/admin/print-jobs')).data.jobs.find((j) => j.id === jobId).status === 'failed', 20000, 300);
});

test('media upload validates file type and rejects unsafe SVG', async () => {
  const upload = async (buf, name, kind = 'food') => {
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', new Blob([buf]), name);
    const res = await fetch(`${env.base}/api/admin/media`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: fd });
    return { status: res.status, data: await res.json() };
  };
  const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
  assert.equal((await upload(evil, 'x.svg')).status, 400);
  const ok = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><rect width="800" height="800" fill="#123"/></svg>');
  const r = await upload(ok, 'ok.svg');
  assert.equal(r.status, 201); assert.equal(r.data.asset.width, 800);
  assert.equal((await upload(Buffer.from('MZ\x90\x00 not an image'), 'x.exe')).status, 415);
  const media = await fetch(`${env.base}${r.data.asset.url}`);
  assert.match(media.headers.get('content-security-policy'), /default-src 'none'/);
});

test('terms HTML is sanitized', async () => {
  const r = await owner.put('/api/admin/settings', { terms: { th: '<p onclick="x()">ok<script>alert(1)</script><a href="javascript:x">l</a></p>' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.terms.th, '<p>ok<a>l</a></p>');
});
