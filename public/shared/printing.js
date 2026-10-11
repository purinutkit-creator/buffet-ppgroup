// Browser printing: USB (WebUSB), Bluetooth BLE (Web Bluetooth) and Serial / Bluetooth SPP (Web Serial).
// Printers found with "ค้นหาเครื่องพิมพ์" are bound to this device; any staff page that loads this file
// (POS, Admin, KDS, Print Station) reconnects to them automatically and prints their queued jobs.
(function () {
  'use strict';
  const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
  const hex = (n) => Number(n || 0).toString(16).padStart(4, '0');
  const support = { usb: !!navigator.usb, ble: !!navigator.bluetooth, serial: !!navigator.serial, secure: window.isSecureContext };

  const usbKey = (d) => `${hex(d.vendorId)}:${hex(d.productId)}${d.serialNumber ? ':' + d.serialNumber : ''}`;
  const serialKey = (p) => { const i = (p.getInfo && p.getInfo()) || {}; return `serial:${hex(i.usbVendorId)}:${hex(i.usbProductId)}`; };

  // ---------- transports ----------
  class UsbT {
    constructor(key) { this.key = key; this.dev = null; this.ep = 1; }
    async connect() {
      if (this.dev && this.dev.opened) return;
      const list = await navigator.usb.getDevices();
      const d = list.find((x) => usbKey(x) === this.key) || list.find((x) => usbKey(x).startsWith(this.key.split(':').slice(0, 2).join(':')));
      if (!d) throw new Error('ยังไม่ได้อนุญาตเครื่องพิมพ์ USB นี้ในเบราว์เซอร์นี้ — กด "ค้นหาเครื่องพิมพ์" แล้วเลือกอีกครั้ง');
      if (!d.opened) await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      let iface = null;
      for (const i of d.configuration.interfaces) { const out = i.alternates[0].endpoints.find((e) => e.direction === 'out' && e.type === 'bulk'); if (out) { iface = i.interfaceNumber; this.ep = out.endpointNumber; break; } }
      if (iface == null) throw new Error('อุปกรณ์ USB นี้ไม่ใช่เครื่องพิมพ์ (ไม่พบช่องส่งข้อมูล)');
      try { await d.claimInterface(iface); } catch (e) { throw new Error('เครื่องพิมพ์ถูกไดรเวอร์ของระบบใช้งานอยู่ (Windows: ใช้ Print Bridge หรือเปลี่ยนไดรเวอร์เป็น WinUSB)'); }
      this.dev = d;
    }
    async write(b) { await this.connect(); for (let i = 0; i < b.length; i += 16384) { const r = await this.dev.transferOut(this.ep, b.subarray(i, i + 16384)); if (r.status !== 'ok') throw new Error(`USB ${r.status}`); } }
    get connected() { return !!(this.dev && this.dev.opened); }
    async close() { try { if (this.dev) await this.dev.close(); } finally { this.dev = null; } }
  }
  class BleT {
    constructor(key, device) { this.key = key; this.dev = device || null; this.ch = null; }
    async connect() {
      if (this.ch && this.dev && this.dev.gatt.connected) return;
      if (!this.dev) {
        const list = navigator.bluetooth.getDevices ? await navigator.bluetooth.getDevices() : [];
        this.dev = list.find((d) => d.id === this.key) || null;
        if (!this.dev) throw new Error('ต้องกด "เชื่อมต่อ" เครื่องพิมพ์ Bluetooth ใหม่หลังเปิดหน้านี้');
      }
      const gatt = await this.dev.gatt.connect();
      for (const svc of await gatt.getPrimaryServices()) {
        for (const c of await svc.getCharacteristics()) if (c.properties.write || c.properties.writeWithoutResponse) { this.ch = c; return; }
      }
      throw new Error('ไม่พบช่องส่งข้อมูลของเครื่องพิมพ์ Bluetooth');
    }
    async write(b) { await this.connect(); for (let i = 0; i < b.length; i += 180) { const p = b.subarray(i, i + 180); if (this.ch.properties.writeWithoutResponse) await this.ch.writeValueWithoutResponse(p); else await this.ch.writeValue(p); } }
    get connected() { return !!(this.ch && this.dev && this.dev.gatt.connected); }
    async close() { if (this.dev) this.dev.gatt.disconnect(); this.ch = null; }
  }
  class SerialT {
    constructor(key, baud) { this.key = key; this.baud = baud || 9600; this.port = null; }
    async connect() {
      if (this.port && this.port.writable) return;
      const ports = await navigator.serial.getPorts();
      const p = ports.find((x) => serialKey(x) === this.key) || (ports.length === 1 ? ports[0] : null);
      if (!p) throw new Error('ยังไม่ได้อนุญาตพอร์ต Serial/Bluetooth นี้ — กด "ค้นหาเครื่องพิมพ์" แล้วเลือกอีกครั้ง');
      if (!p.writable) await p.open({ baudRate: this.baud });
      this.port = p;
    }
    async write(b) { await this.connect(); const w = this.port.writable.getWriter(); try { await w.write(b); } finally { w.releaseLock(); } }
    get connected() { return !!(this.port && this.port.writable); }
    async close() { if (this.port) await this.port.close().catch(() => {}); this.port = null; }
  }

  // ---------- discovery (needs a user click) ----------
  async function search(kind) {
    if (!support.secure) throw new Error('ต้องเปิดผ่าน HTTPS จึงจะค้นหาเครื่องพิมพ์ได้');
    if (kind === 'usb') {
      if (!support.usb) throw new Error('เบราว์เซอร์นี้ไม่รองรับ USB (ใช้ Chrome / Edge บนคอมพิวเตอร์หรือ Android)');
      const d = await navigator.usb.requestDevice({ filters: [] });
      return { transport: 'usb', device_id: usbKey(d), device_name: d.productName || `USB ${hex(d.vendorId)}:${hex(d.productId)}`, manufacturer: d.manufacturerName || '' };
    }
    if (kind === 'ble') {
      if (!support.ble) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Bluetooth (ใช้ Chrome / Edge)');
      const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
      liveBle[d.id] = d;
      return { transport: 'ble', device_id: d.id, device_name: d.name || 'Bluetooth printer' };
    }
    if (!support.serial) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Serial (ใช้ Chrome / Edge บนคอมพิวเตอร์)');
    const p = await navigator.serial.requestPort();
    const i = (p.getInfo && p.getInfo()) || {};
    return { transport: 'serial', device_id: serialKey(p), device_name: i.usbVendorId ? `Serial ${hex(i.usbVendorId)}:${hex(i.usbProductId)}` : 'Serial / Bluetooth SPP' };
  }
  // Devices this browser already has permission for (no chooser needed)
  async function known() {
    const out = [];
    if (support.usb) for (const d of await navigator.usb.getDevices()) out.push({ transport: 'usb', device_id: usbKey(d), device_name: d.productName || `USB ${usbKey(d)}`, manufacturer: d.manufacturerName || '' });
    if (support.serial) for (const p of await navigator.serial.getPorts()) out.push({ transport: 'serial', device_id: serialKey(p), device_name: 'Serial / Bluetooth SPP' });
    if (support.ble && navigator.bluetooth.getDevices) for (const d of await navigator.bluetooth.getDevices()) out.push({ transport: 'ble', device_id: d.id, device_name: d.name || 'Bluetooth printer' });
    return out;
  }

  // ---------- executor ----------
  const liveBle = {};
  const transports = {};
  const state = {}; // printerId -> {status, error}
  let printers = [], busy = false, again = false, started = false;
  const listeners = new Set();
  const notify = () => listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });

  function transportFor(p) {
    const c = p.config || {};
    const k = `${p.id}|${c.transport}|${c.device_id}`;
    if (!transports[k]) transports[k] = c.transport === 'usb' ? new UsbT(c.device_id) : c.transport === 'ble' ? new BleT(c.device_id, liveBle[c.device_id]) : new SerialT(c.device_id, c.baud);
    return transports[k];
  }
  const mine = () => printers.filter((p) => p.config && p.config.device_id && p.config.host_device_id === BF.deviceId());
  async function setStatus(p, online, error) {
    state[p.id] = { status: online ? 'online' : 'error', error: error || null };
    notify();
    try { await BF.api.post(`/api/print/station/${p.id}/status`, { online, error }); } catch { /* ignore */ }
  }
  async function load() {
    try { printers = (await BF.api.get('/api/print/station/printers', { noLogout: true })).printers; } catch { printers = []; }
    notify();
    return printers;
  }
  async function connect(p, { prompt = false } = {}) {
    const c = p.config || {};
    // Bluetooth permission does not survive a browser restart everywhere → re-pick the device on a user click
    if (prompt && c.transport === 'ble' && !liveBle[c.device_id] && !(transportFor(p).connected)) {
      const found = await search('ble');
      if (found.device_id !== c.device_id) { liveBle[c.device_id] = liveBle[found.device_id]; }
      for (const k of Object.keys(transports)) if (k.startsWith(`${p.id}|`)) delete transports[k];
    }
    try { await transportFor(p).connect(); await setStatus(p, true); drain(); return true; } catch (e) { await setStatus(p, false, e.message); throw e; }
  }
  async function drain() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        for (const p of mine()) {
          for (;;) {
            let r;
            try { r = (await BF.api.post(`/api/print/station/${p.id}/claim`, {}, { noLogout: true })).job; } catch { break; }
            if (!r) break;
            const bytes = Uint8Array.from(atob(r.data), (x) => x.charCodeAt(0));
            try {
              await transportFor(p).write(bytes);
              await BF.api.post(`/api/print/station/${p.id}/jobs/${r.job.id}/result`, { ok: true });
              state[p.id] = { status: 'online', error: null, last: Date.now() }; notify();
            } catch (e) {
              await BF.api.post(`/api/print/station/${p.id}/jobs/${r.job.id}/result`, { ok: false, error: e.message }).catch(() => {});
              await setStatus(p, false, e.message);
              break;
            }
          }
        }
      } while (again);
    } finally { busy = false; }
  }
  // Start the executor on a staff page (requires a logged-in staff token)
  async function start(socket) {
    if (started || !BF.auth.token()) return;
    started = true;
    await load();
    for (const p of mine()) connect(p).catch(() => {});
    if (socket) {
      socket.on('connect', () => socket.emit('join', 'printers'));
      socket.emit('join', 'printers');
      socket.on('print:available', ({ printer_id }) => { if (mine().some((p) => p.id === printer_id)) drain(); });
    }
    setInterval(() => { if (mine().length) drain(); }, 5000);
    if (navigator.usb) {
      navigator.usb.addEventListener('connect', () => mine().forEach((p) => connect(p).catch(() => {})));
      navigator.usb.addEventListener('disconnect', () => mine().forEach((p) => { if (p.config.transport === 'usb') setStatus(p, false, 'ถอดสาย USB'); }));
    }
  }

  BF.printing = { support, search, known, start, load, connect, drain, mine, state, onChange: (f) => { listeners.add(f); return () => listeners.delete(f); }, get printers() { return printers; } };
})();
