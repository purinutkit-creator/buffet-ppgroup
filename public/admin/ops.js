// Admin: printers & routing, print queue, reports & exports, audit log, backups.
(function () {
  'use strict';
  const { h, mount, api, tr, money, dt } = { ...BF, api: BF.api };
  const A = window.ADMIN;
  const JOB_ST = { pending: 'รอพิมพ์', printing: 'กำลังพิมพ์', printed: 'พิมพ์แล้ว', failed: 'ล้มเหลว' };
  const CONN = { network: 'LAN / Network (TCP 9100)', bridge: 'Local Print Bridge (USB / Serial / CUPS / LAN อื่น)', browser: 'Browser Print Station (WebUSB / Bluetooth / Serial)' };

  A.sections.printers = async (c) => {
    const r = await api.get('/api/admin/printers');
    const printers = r.printers.filter((p) => p.active);
    const routes = r.routes.map((x) => ({ ...x }));
    const jobsBox = h('div');
    const routeTable = h('div.card.table-wrap', null, h('table.list', null, h('thead', null, h('tr', null, ['เอกสาร', 'เครื่องพิมพ์', 'สำเนา', 'พิมพ์อัตโนมัติ'].map((x) => h('th', null, x)))),
      h('tbody', null, routes.map((rt) => h('tr', null, h('td', null, rt.label),
        h('td', null, h('select', { onchange: (e) => { rt.printer_id = e.target.value ? Number(e.target.value) : null; } }, h('option', { value: '' }, '— ไม่พิมพ์ —'), printers.map((p) => h('option', { value: p.id, selected: rt.printer_id === p.id }, p.name)))),
        h('td', null, h('input', { type: 'number', min: 1, max: 5, value: rt.copies, style: { width: '70px' }, oninput: (e) => { rt.copies = Number(e.target.value) || 1; } })),
        h('td', null, h('input', { type: 'checkbox', checked: rt.auto, onchange: (e) => { rt.auto = e.target.checked; } })))))),
      h('div.row', { style: { padding: '12px' } }, h('button.btn.primary', { onclick: async () => { try { await api.put('/api/admin/print-routes', { routes }); BF.toast('บันทึกการกำหนดงานพิมพ์แล้ว', 'success'); } catch (e) { BF.error(e); } } }, 'บันทึกการกำหนดงานพิมพ์'),
        printers.length ? h('button.btn', { onclick: async () => { routes.forEach((x) => { x.printer_id = printers[0].id; }); try { await api.put('/api/admin/print-routes', { routes }); BF.toast(`ทุกเอกสารพิมพ์ที่ ${printers[0].name}`, 'success'); A.refresh(); } catch (e) { BF.error(e); } } }, `ใช้ ${printers[0].name} กับทุกเอกสาร`) : null));
    const loadJobs = async () => {
      const j = await api.get('/api/admin/print-jobs');
      mount(jobsBox, A.table([['#', (x) => x.id], ['เวลา', (x) => dt(x.created_at)], ['เครื่อง', (x) => (r.printers.find((p) => p.id === x.printer_id) || {}).name || '—'], ['เอกสาร', (x) => x.doc_label], ['สถานะ', (x) => h(`span.badge.st.st-${x.status}`, null, JOB_ST[x.status])], ['ลอง', (x) => x.attempts], ['ข้อผิดพลาด', (x) => h('span.small', null, x.error || '')],
        ['', (x) => h('div.row', null, h('button.btn.sm', { onclick: () => previewJob(x) }, 'ดูตัวอย่าง'), ['failed', 'printed', 'pending'].includes(x.status) ? h('button.btn.sm', { onclick: async () => { try { await api.post(`/api/admin/print-jobs/${x.id}/retry`); loadJobs(); } catch (e) { BF.error(e); } } }, x.status === 'printed' ? 'พิมพ์ซ้ำ' : 'ลองใหม่') : null)]], j.jobs, { empty: 'ยังไม่มีงานพิมพ์' }));
    };
    mount(c, A.head('เครื่องพิมพ์', h('button.btn.primary', { onclick: () => printerEditor() }, '+ เพิ่มเครื่องพิมพ์')),
      h('div.card.section', null, h('p.muted', null, 'รองรับ Thermal 58/80 มม. • ใบเสร็จและใบครัวใช้เครื่องเดียวกันได้ • ทุกใบพิมพ์แปลงเป็นภาพ (รองรับภาษาไทยทุกเครื่อง) • สถานะเครื่องพิมพ์มาจากการเชื่อมต่อจริงเท่านั้น'),
        A.table([['ชื่อ', (p) => p.name], ['การเชื่อมต่อ', (p) => CONN[p.connection]], ['ที่อยู่ / ปลายทาง', (p) => p.address || '—'], ['กระดาษ', (p) => `${p.paper_width} มม.`],
          ['สถานะ', (p) => h('span', null, h('span.badge', { style: { background: p.status === 'online' ? '#dcfce7' : p.status === 'unknown' ? '#f1f5f9' : '#fee2e2' } }, p.status), p.last_seen_at ? h('div.muted.small', null, `ล่าสุด ${dt(p.last_seen_at)}`) : null, p.last_error ? h('div.small', { style: { color: 'var(--danger)' } }, p.last_error) : null)],
          ['', (p) => h('div.row', null,
            h('button.btn.sm', { onclick: async () => { try { const x = await api.post(`/api/admin/printers/${p.id}/probe`); BF.toast(x.ok ? `เชื่อมต่อได้ ${x.latency_ms != null ? `(${x.latency_ms} ms)` : ''}` : `ไม่สามารถเชื่อมต่อ: ${x.error || x.status}`, x.ok ? 'success' : 'error', 5000); A.refresh(); } catch (e) { BF.error(e); } } }, 'ตรวจสอบการเชื่อมต่อ'),
            h('button.btn.sm', { onclick: async () => { try { await api.post(`/api/admin/printers/${p.id}/test`); BF.toast('ส่งงานทดสอบแล้ว — ดูสถานะในคิวด้านล่าง', 'success'); setTimeout(loadJobs, 1500); } catch (e) { BF.error(e); } } }, 'พิมพ์ทดสอบ'),
            p.connection === 'bridge' ? h('button.btn.sm', { onclick: () => bridgeKey(p) }, 'Bridge Key') : null,
            h('button.btn.sm', { onclick: () => printerEditor(p) }, 'แก้ไข'),
            h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/printers/${p.id}`, p.name)) A.refresh(); } }, 'ลบ'))]], printers, { empty: 'ยังไม่มีเครื่องพิมพ์' })),
      h('h3', null, 'กำหนดเอกสาร → เครื่องพิมพ์'), routeTable,
      h('p.muted.small', null, 'ใบครัวจะเลือกเครื่องพิมพ์ตามลำดับ: เครื่องที่กำหนดในเมนู → เครื่องของสถานีครัว → ค่าในตารางนี้ • ใบครัวพิมพ์เฉพาะรายการใหม่ของแต่ละออเดอร์และแยกตามสถานี'),
      h('div.row.between', null, h('h3', null, 'คิวงานพิมพ์'), h('button.btn.sm', { onclick: loadJobs }, '↻')), jobsBox,
      h('div.card', { style: { marginTop: '16px' } }, h('h3', null, 'วิธีเชื่อมต่อ'),
        h('p', null, h('b', null, 'LAN / Network: '), 'ใส่ IP:Port ของเครื่องพิมพ์ (ปกติพอร์ต 9100) เซิร์ฟเวอร์ส่งงานให้โดยตรง'),
        h('p', null, h('b', null, 'Local Print Bridge: '), 'สำหรับเครื่องพิมพ์ USB/Serial/CUPS ที่ต่อกับคอมพิวเตอร์ในร้าน — ติดตั้ง Node.js แล้วรัน ', h('code', null, 'node print-bridge/bridge.js --server <URL ระบบ> --key <Bridge Key> --target file:/dev/usb/lp0')),
        h('p', null, h('b', null, 'Browser Print Station: '), 'เปิด ', h('a', { href: '/print-station/', target: '_blank' }, '/print-station/'), ' ด้วย Chrome/Edge บนเครื่องที่ต่อเครื่องพิมพ์ (USB / Bluetooth) แล้วกดเชื่อมต่อ หน้านี้ต้องเปิดค้างไว้ระหว่างใช้งาน')));
    loadJobs();
  };
  function printerEditor(p) {
    A.editor(p ? `แก้ไข ${p.name}` : 'เพิ่มเครื่องพิมพ์', [
      { key: 'name', label: 'ชื่อเครื่องพิมพ์ เช่น Printer A' }, { key: 'connection', label: 'การเชื่อมต่อ', type: 'select', options: Object.entries(CONN) },
      { key: 'address', label: 'IP:Port (LAN) หรือปลายทางสำหรับ Bridge เช่น tcp://192.168.1.50:9100, file:/dev/usb/lp0, cups:EPSON' },
      { key: 'paper_width', label: 'ความกว้างกระดาษ', type: 'select', options: [[80, '80 มม. (576 dots)'], [58, '58 มม. (384 dots)']] },
      { key: 'cut', label: 'ตัดกระดาษอัตโนมัติ', type: 'check', default: true }, { key: 'beep', label: 'เสียงเตือนเมื่อพิมพ์ใบครัว', type: 'check' }, { key: 'drawer', label: 'เปิดลิ้นชักเงินเมื่อพิมพ์ใบเสร็จ', type: 'check' }, { key: 'active', label: 'ใช้งาน', type: 'check', default: true },
    ], p ? { ...p, ...p.config } : { connection: 'network', paper_width: 80, cut: true, active: true }, async (v) => {
      const body = { ...v, paper_width: Number(v.paper_width), config: { cut: v.cut, beep: v.beep, drawer: v.drawer } };
      if (p) await api.put(`/api/admin/printers/${p.id}`, body);
      else { const r = await api.post('/api/admin/printers', body); if (r.bridge_key) showKey(r.bridge_key); }
      A.refresh();
    }, { wide: false });
  }
  async function bridgeKey(p) {
    if (!await BF.confirm('สร้าง Bridge Key ใหม่? Key เดิมจะใช้งานไม่ได้ทันที')) return;
    try { const r = await api.post(`/api/admin/printers/${p.id}/bridge-key`); showKey(r.bridge_key); } catch (e) { BF.error(e); }
  }
  function showKey(key) {
    BF.modal('Print Bridge Key', h('div.form', null, h('p', null, 'คัดลอก Key นี้ไปใช้กับ Local Print Bridge (แสดงครั้งเดียว ระบบเก็บเฉพาะค่า hash):'), h('code', { style: { wordBreak: 'break-all', fontSize: '15px', background: 'var(--surface)', padding: '10px', borderRadius: '8px' } }, key),
      h('code.small', { style: { wordBreak: 'break-all' } }, `node print-bridge/bridge.js --server ${location.origin} --key ${key}`)));
  }
  async function previewJob(j) {
    try { const blob = await api.raw('GET', `/api/admin/print-jobs/${j.id}/preview.png`, undefined, { raw: true }); BF.modal(`ตัวอย่าง ${j.doc_label} #${j.id}`, h('div.print-prev', null, h('img', { src: URL.createObjectURL(blob), alt: '' }))); } catch (e) { BF.error(e); }
  }

  // ---------- reports ----------
  const REPORTS = {
    sales: 'ยอดขายตามช่วงเวลา', packages: 'แพ็กเกจยอดนิยม', branches: 'ยอดขายแยกสาขา', payment_methods: 'ยอดขายแยกช่องทางชำระเงิน', top_items: 'อาหารที่ถูกสั่งมากที่สุด', items_per_table: 'จำนวนอาหารต่อโต๊ะ',
    wait_times: 'ระยะเวลารออาหาร / รายการที่เตรียมนาน', staff_calls: 'การเรียกพนักงาน & เวลาตอบสนอง', table_usage: 'อัตราการใช้โต๊ะ & เวลาหมุนเวียน', points: 'คะแนนสะสม & คะแนนที่ใช้', profit: 'ต้นทุน & กำไรขั้นต้น', exceptions: 'ส่วนลด การยกเลิก การคืนเงิน', print_jobs: 'ประวัติการพิมพ์ & ข้อผิดพลาด',
  };
  A.sections.reports = async (c) => {
    const today = new Date().toISOString().slice(0, 10);
    const st = { name: 'sales', from: new Date(Date.now() - 29 * 86400e3).toISOString().slice(0, 10), to: today, branch: 'current', group: 'day', package_id: '', staff_id: '' };
    const [{ packages }, staffR] = await Promise.all([api.get('/api/admin/packages'), BF.auth.can('staff.manage') ? api.get('/api/admin/staff') : Promise.resolve({ staff: [] })]);
    const out = h('div');
    const qs = () => { const p = new URLSearchParams({ from: new Date(`${st.from}T00:00:00`).getTime(), to: new Date(`${st.to}T23:59:59`).getTime(), group: st.group }); if (st.branch) p.set('branch_id', st.branch); if (st.package_id) p.set('package_id', st.package_id); if (st.staff_id) p.set('staff_id', st.staff_id); return p.toString(); };
    const run = async () => {
      mount(out, BF.states.loading(3, 'sk-line'));
      try {
        const r = await api.get(`/api/admin/reports/${st.name}?${qs()}`);
        const fmt = (v, t) => (t === 'money' ? money(v) : v ?? '');
        mount(out,
          r.overall_avg_min != null ? h('div.card.stat', { style: { marginBottom: '12px' } }, h('div.l', null, 'ระยะเวลารออาหารเฉลี่ยทั้งหมด'), h('div.v', null, `${r.overall_avg_min} นาที`)) : null,
          A.table(r.columns.map(([k, l, t]) => [l, (row) => (typeof row[k] === 'object' && row[k] ? JSON.stringify(row[k]) : fmt(row[k], t))]), r.rows, { empty: 'ไม่มีข้อมูลในช่วงที่เลือก' }),
          r.byStaff && r.byStaff.length ? h('div', null, h('h3', null, 'แยกตามพนักงาน'), A.table([['พนักงาน', (x) => x.staff], ['จำนวนที่รับ', (x) => x.handled], ['ตอบรับเฉลี่ย (วินาที)', (x) => x.avg_response_sec]], r.byStaff)) : null);
      } catch (e) { mount(out, BF.states.error(e, run)); }
    };
    const exp = (f) => BF.download(`/api/admin/reports/${st.name}?${qs()}&format=${f}`, `${st.name}-${st.from}_${st.to}.${f}`).catch(BF.error);
    const sel = (opts, key) => h('select', { style: { width: 'auto' }, onchange: (e) => { st[key] = e.target.value; run(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(st[key]) === String(v) }, l)));
    mount(c, A.head('รายงาน', h('button.btn.sm', { onclick: () => exp('csv') }, 'CSV'), h('button.btn.sm', { onclick: () => exp('xlsx') }, 'Excel'), h('button.btn.sm', { onclick: () => exp('pdf') }, 'PDF')),
      h('div.card.section', null, h('div.row', null,
        sel(Object.entries(REPORTS), 'name'),
        h('input', { type: 'date', value: st.from, style: { width: 'auto' }, onchange: (e) => { st.from = e.target.value; run(); } }), '–', h('input', { type: 'date', value: st.to, style: { width: 'auto' }, onchange: (e) => { st.to = e.target.value; run(); } }),
        sel([['current', 'สาขาปัจจุบัน'], ['', 'ทุกสาขา'], ...A.boot.branches.map((b) => [b.id, b.code])], 'branch'),
        sel([['day', 'รายวัน'], ['month', 'รายเดือน'], ['year', 'รายปี']], 'group'),
        sel([['', 'ทุกแพ็กเกจ'], ...packages.map((p) => [p.id, p.code])], 'package_id'),
        staffR.staff.length ? sel([['', 'พนักงานทุกคน'], ...staffR.staff.map((s) => [s.id, s.name])], 'staff_id') : null),
      h('div.muted.small', null, 'ตัวกรองรายวัน/เดือน/ปี แพ็กเกจ และพนักงาน ใช้กับรายงานยอดขาย • รายงานอื่นกรองตามวันที่และสาขา')), out);
    run();
  };

  A.sections.audit = async (c) => {
    let action = '';
    const out = h('div');
    const load = async () => { const r = await api.get(`/api/admin/audit?action=${encodeURIComponent(action)}`); mount(out, A.table([['เวลา', (x) => dt(x.created_at)], ['การกระทำ', (x) => h('code', null, x.action)], ['พนักงาน', (x) => x.staff_name || '—'], ['ผู้อนุมัติ', (x) => x.approver_name || ''], ['อ้างอิง', (x) => (x.entity ? `${x.entity} #${x.entity_id}` : '')], ['รายละเอียด', (x) => h('span.small.mono', null, x.data ? JSON.stringify(x.data).slice(0, 160) : '')], ['IP', (x) => x.ip || '']], r.logs)); };
    mount(c, A.head('Audit Log'), h('input', { placeholder: 'กรองตาม action เช่น table. / payment.refund / points.', style: { maxWidth: '360px', marginBottom: '12px' }, oninput: BF.debounce((e) => { action = e.target.value; load(); }, 300) }), out);
    await load();
  };

  A.sections.backup = async (c) => {
    const r = await api.get('/api/admin/backups');
    mount(c, A.head('สำรองข้อมูล', h('button.btn.primary', { onclick: async () => { try { const x = await api.post('/api/admin/backups'); BF.toast(`สร้างไฟล์สำรอง ${x.file}`, 'success'); A.refresh(); } catch (e) { BF.error(e); } } }, 'สำรองข้อมูลตอนนี้')),
      h('div.card.section', null, h('p', null, 'ระบบสำรองฐานข้อมูลอัตโนมัติตามรอบ (AUTO_BACKUP_HOURS) ไว้ที่ data/backups และเก็บไว้ตามจำนวน BACKUP_KEEP • ไฟล์รูปอยู่ที่ data/uploads ควรสำรองควบคู่กัน'),
        h('p', null, 'กู้คืน: หยุดเซิร์ฟเวอร์ แล้วรัน ', h('code', null, 'npm run restore -- data/backups/<ไฟล์>.db'), ' (ระบบตรวจสอบความสมบูรณ์ของไฟล์และเก็บฐานข้อมูลเดิมไว้ก่อนแทนที่)')),
      A.table([['ไฟล์', (x) => x.file], ['ขนาด', (x) => `${(x.size / 1024 / 1024).toFixed(2)} MB`], ['', (x) => h('button.btn.sm', { onclick: () => BF.download(`/api/admin/backups/${encodeURIComponent(x.file)}`, x.file).catch(BF.error) }, 'ดาวน์โหลด')]], r.backups, { empty: 'ยังไม่มีไฟล์สำรอง' }));
  };
})();
