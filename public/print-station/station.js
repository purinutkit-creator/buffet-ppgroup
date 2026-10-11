// Browser Print Station: prints queued jobs for printers of type "browser" through WebUSB, Web Serial or Web Bluetooth.
// Requires Chrome/Edge (desktop or Android) over HTTPS or localhost. Unsupported APIs are reported, never faked.
(function () {
  'use strict';
  const { h, mount, $, api } = { ...BF, api: BF.api };
  const app = $('#app');
  const support = { usb: !!navigator.usb, serial: !!navigator.serial, bluetooth: !!navigator.bluetooth };
  const conns = {}; // printerId -> {transport, write(bytes), close(), label}
  const busy = new Set();
  const logs = {};
  // Common BLE thermal-printer services (generic ESC/POS BLE modules)
  const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb'];
  let printers = [];

  async function start() {
    await BF.requireLogin('Print Station', { permission: ['settings.manage', 'table.close', 'kitchen.update'] });
    await load();
    const s = BF.socket({ staffToken: BF.auth.token() });
    s.on('connect', () => s.emit('join', 'printers'));
    s.on('print:available', ({ printer_id }) => drain(printer_id));
    setInterval(() => Object.keys(conns).forEach((id) => drain(Number(id))), 5000);
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  }
  async function load() {
    try { printers = (await api.get('/api/print/station/printers')).printers; } catch (e) { return mount(app, BF.states.error(e, load)); }
    render();
  }
  function log(id, msg) { (logs[id] ||= []).unshift(`${new Date().toLocaleTimeString()}  ${msg}`); logs[id].length = Math.min(logs[id].length, 50); const el = document.getElementById(`log-${id}`); if (el) el.textContent = logs[id].join('\n'); }
  function render() {
    mount(app,
      h('header.topbar', null, h('div.brand', null, '🖨 Print Station'), h('span.grow'), h('button.btn.sm', { onclick: BF.auth.logout }, 'ออก')),
      h('main.wrap', null,
        h('div.card.support', null, h('b', null, 'การรองรับของเบราว์เซอร์นี้: '),
          h('span', { class: support.usb ? 'ok' : 'bad' }, `WebUSB ${support.usb ? '✔' : '✘'}`),
          h('span', { class: support.serial ? 'ok' : 'bad' }, `Web Serial ${support.serial ? '✔' : '✘'}`),
          h('span', { class: support.bluetooth ? 'ok' : 'bad' }, `Web Bluetooth ${support.bluetooth ? '✔' : '✘'}`),
          !window.isSecureContext ? h('div.bad', null, 'ต้องเปิดผ่าน HTTPS หรือ localhost จึงจะใช้ USB/Bluetooth ได้') : null,
          !support.usb && !support.serial && !support.bluetooth ? h('p.muted', null, 'เบราว์เซอร์นี้ไม่รองรับการเชื่อมต่อเครื่องพิมพ์โดยตรง — ใช้ Chrome/Edge บนคอมพิวเตอร์หรือ Android หรือใช้ Local Print Bridge (npm run bridge) แทน') : null),
        printers.length ? printers.map(card) : BF.states.empty('ยังไม่มีเครื่องพิมพ์ชนิด "Browser" — เพิ่มได้ที่ Admin › เครื่องพิมพ์', '🖨')));
  }
  function card(p) {
    const c = conns[p.id];
    return h('div.card.pcard', null,
      h('div.row.between', null, h('div', null, h('b', null, p.name), h('div.muted.small', null, `${p.paper_width} มม.`)), h('span', { class: c ? 'ok' : 'bad' }, c ? `เชื่อมต่อแล้ว (${c.label})` : 'ยังไม่เชื่อมต่อ')),
      h('div.row', null,
        support.usb ? h('button.btn', { onclick: () => connectUsb(p) }, 'USB') : null,
        support.serial ? h('button.btn', { onclick: () => connectSerial(p) }, 'Serial / Bluetooth SPP') : null,
        support.bluetooth ? h('button.btn', { onclick: () => connectBle(p) }, 'Bluetooth (BLE)') : null,
        c ? h('button.btn.ghost', { onclick: async () => { await c.close().catch(() => {}); delete conns[p.id]; status(p.id, false); render(); } }, 'ตัดการเชื่อมต่อ') : null,
        c ? h('button.btn.primary', { onclick: () => drain(p.id) }, 'พิมพ์งานที่ค้าง') : null),
      h('div.log', { id: `log-${p.id}` }, (logs[p.id] || []).join('\n')));
  }
  async function status(id, online, error) { try { await api.post(`/api/print/station/${id}/status`, { online, error }); } catch { /* ignore */ } }

  async function connectUsb(p) {
    try {
      const dev = await navigator.usb.requestDevice({ filters: [] });
      await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);
      let iface, ep;
      for (const i of dev.configuration.interfaces) for (const alt of i.alternates) { const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk'); if (out) { iface = i; ep = out; break; } }
      if (!ep) throw new Error('ไม่พบ endpoint สำหรับส่งข้อมูล (bulk OUT)');
      await dev.claimInterface(iface.interfaceNumber);
      conns[p.id] = { label: `USB ${dev.productName || ''}`, write: async (b) => { for (let i = 0; i < b.length; i += 16384) await dev.transferOut(ep.endpointNumber, b.subarray(i, i + 16384)); }, close: () => dev.close() };
      done(p);
    } catch (e) { fail(p, e); }
  }
  async function connectSerial(p) {
    try {
      const port = await navigator.serial.requestPort();
      const baud = Number(prompt('Baud rate', '9600')) || 9600;
      await port.open({ baudRate: baud });
      const writer = port.writable.getWriter();
      conns[p.id] = { label: `Serial ${baud}`, write: async (b) => { for (let i = 0; i < b.length; i += 4096) await writer.write(b.subarray(i, i + 4096)); }, close: async () => { writer.releaseLock(); await port.close(); } };
      done(p);
    } catch (e) { fail(p, e); }
  }
  async function connectBle(p) {
    try {
      const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      const gatt = await dev.gatt.connect();
      let ch = null;
      for (const svc of await gatt.getPrimaryServices()) {
        for (const c of await svc.getCharacteristics()) if (c.properties.write || c.properties.writeWithoutResponse) { ch = c; break; }
        if (ch) break;
      }
      if (!ch) throw new Error('ไม่พบช่องทางเขียนข้อมูลของเครื่องพิมพ์ (BLE characteristic)');
      const chunk = 180;
      conns[p.id] = { label: `BLE ${dev.name || ''}`, write: async (b) => { for (let i = 0; i < b.length; i += chunk) { const part = b.subarray(i, i + chunk); if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(part); else await ch.writeValue(part); } }, close: async () => gatt.disconnect() };
      dev.addEventListener('gattserverdisconnected', () => { delete conns[p.id]; status(p.id, false, 'BLE disconnected'); log(p.id, 'Bluetooth หลุดการเชื่อมต่อ'); render(); });
      done(p);
    } catch (e) { fail(p, e); }
  }
  function done(p) { log(p.id, `เชื่อมต่อสำเร็จ: ${conns[p.id].label}`); status(p.id, true); render(); drain(p.id); }
  function fail(p, e) { if (e && e.name === 'NotFoundError') return log(p.id, 'ยกเลิกการเลือกอุปกรณ์'); log(p.id, `เชื่อมต่อไม่สำเร็จ: ${e.message}`); status(p.id, false, e.message); BF.error(e); }

  // Claim and print queued jobs one by one
  async function drain(id) {
    const c = conns[id];
    if (!c || busy.has(id)) return;
    busy.add(id);
    try {
      for (;;) {
        const r = await api.post(`/api/print/station/${id}/claim`);
        if (!r.job) break;
        const bytes = Uint8Array.from(atob(r.data), (x) => x.charCodeAt(0));
        try {
          await c.write(bytes);
          await api.post(`/api/print/station/${id}/jobs/${r.job.id}/result`, { ok: true });
          log(id, `พิมพ์ ${r.job.doc_label} #${r.job.id} (${bytes.length} bytes)`);
        } catch (e) {
          await api.post(`/api/print/station/${id}/jobs/${r.job.id}/result`, { ok: false, error: e.message });
          log(id, `ผิดพลาด ${r.job.doc_label} #${r.job.id}: ${e.message}`);
          break;
        }
      }
    } catch (e) { log(id, `ดึงงานพิมพ์ไม่สำเร็จ: ${e.message}`); } finally { busy.delete(id); }
  }
  start();
})();
