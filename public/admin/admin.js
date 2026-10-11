// Admin back-office shell + shared form helpers. Sections live in catalog.js, floor.js, studio.js, ops.js.
(function () {
  'use strict';
  const { h, mount, $, api, tr, money, baht, toSatang } = { ...BF, api: BF.api };
  const A = window.ADMIN = { sections: {}, boot: null };

  const NAV = [
    ['ภาพรวม', [['dashboard', '📊 แดชบอร์ด', 'report.view']]],
    ['ร้านอาหาร', [['restaurant', '🏪 ร้าน & สาขา', 'settings.manage'], ['settings', '⚙️ ตั้งค่าระบบ', 'settings.manage'], ['terms', '📜 เงื่อนไขการใช้บริการ', 'settings.manage'], ['floor', '🪑 ผังร้าน & โต๊ะ', 'settings.manage']]],
    ['เมนู & แพ็กเกจ', [['packages', '🎫 แพ็กเกจบุฟเฟต์', 'menu.manage'], ['menu', '🍣 เมนูอาหาร', 'menu.manage'], ['categories', '🗂 หมวดหมู่', 'menu.manage'], ['stations', '🔥 สถานีครัว', 'settings.manage']]],
    ['ลูกค้า', [['members', '👤 สมาชิก', 'member.manage'], ['tiers', '🏅 ระดับสมาชิก (Tier)', 'member.manage'], ['promotions', '🎁 โปรโมชั่น', 'member.manage'], ['calltypes', '🔔 ปุ่มเรียกพนักงาน', 'settings.manage']]],
    ['การขาย', [['payments', '💳 ช่องทางชำระเงิน', 'settings.manage'], ['printers', '🖨 เครื่องพิมพ์', 'settings.manage'], ['reports', '📈 รายงาน', 'report.view']]],
    ['ดีไซน์', [['studio', '🎨 Theme & Design Studio', 'settings.manage'], ['media', '🖼 คลังรูปภาพ & ฟอนต์', 'settings.manage']]],
    ['ระบบ', [['staff', '🧑‍💼 พนักงาน', 'staff.manage'], ['roles', '🔐 บทบาท & สิทธิ์', 'staff.manage'], ['audit', '🧾 Audit Log', 'audit.view'], ['backup', '💾 สำรองข้อมูล', 'backup.manage']]],
  ];

  A.start = async () => {
    await BF.requireLogin('Admin • หลังร้าน');
    try { A.boot = await api.get('/api/admin/bootstrap'); } catch (e) { return mount($('#app'), BF.states.error(e, A.start)); }
    BF.printing.start(BF.socket({ staffToken: BF.auth.token() }));
    shell();
  };
  A.reloadBoot = async () => { A.boot = await api.get('/api/admin/bootstrap'); };

  function shell() {
    const st = BF.auth.staff();
    const first = NAV.flatMap(([, x]) => x).find(([, , p]) => BF.auth.can(p));
    const cur = (location.hash.slice(1) || (first && first[0]) || 'dashboard');
    mount($('#app'), h('div.admin', null,
      h('aside.side#side', null, h('div.brand', null, '🍽 Buffet Admin'),
        h('div.small', { style: { padding: '0 10px 6px' } }, tr(A.boot.branches.find((b) => b.id === A.boot.branch_id)?.name || {})),
        NAV.map(([g, items]) => { const vis = items.filter(([, , p]) => BF.auth.can(p)); return vis.length ? [h('div.grp', null, g), vis.map(([id, label]) => h('button', { class: id === cur ? 'active' : '', onclick: () => { location.hash = id; } }, label))] : null; }),
        h('div.grp', null, 'แอปอื่น'), h('button', { onclick: () => window.open('/pos/') }, '🧾 POS'), h('button', { onclick: () => window.open('/kds/') }, '👨‍🍳 KDS'), h('button', { onclick: () => window.open('/staff/') }, '🔔 Staff'), h('button', { onclick: () => window.open('/print-station/') }, '🖨 Print Station'),
        h('div.grp', null, st.name), h('button', { onclick: BF.auth.logout }, '↩ ออกจากระบบ')),
      h('main.content#content')));
    route(cur);
  }
  window.addEventListener('hashchange', () => { if (A.boot) shell(); });
  async function route(id) {
    const c = $('#content');
    const fn = A.sections[id];
    if (!fn) return mount(c, BF.states.empty('ไม่พบหน้า'));
    mount(c, BF.states.loading(4, 'sk-line'));
    try { await fn(c); } catch (e) { mount(c, BF.states.error(e, () => route(id))); }
  }
  A.refresh = () => route(location.hash.slice(1) || 'dashboard');
  A.head = (title, ...right) => h('div.page-head', null, h('div.row', null, h('button.btn.sm.menu-toggle', { onclick: () => $('#side').classList.toggle('open') }, '☰'), h('h2', null, title)), h('div.row', null, right));

  // ---------- form helpers ----------
  const LANGS = [['th', 'ไทย'], ['en', 'EN'], ['zh', '中文']];
  A.i18n = (label, value = {}, { textarea = false, rows = 2 } = {}) => {
    const v = typeof value === 'string' ? { th: value } : { th: '', en: '', zh: '', ...(value || {}) };
    let cur = 'th';
    const input = textarea ? h('textarea', { rows }) : h('input');
    const tabs = h('div.i18n-tabs');
    const draw = () => { input.value = v[cur] || ''; mount(tabs, LANGS.map(([l, n]) => h('button', { type: 'button', class: `${l === cur ? 'active' : ''} ${v[l] ? 'filled' : ''}`, onclick: () => { cur = l; draw(); } }, n))); };
    input.oninput = () => { v[cur] = input.value; };
    draw();
    const el = h('label.i18n', null, h('div.row.between', null, h('span', null, label), tabs), input);
    return { el, get: () => ({ ...v }) };
  };
  A.mediaPicker = (label, kind, assetId) => {
    let id = assetId || null;
    const thumb = h('div.thumb');
    const rec = A.boot.media_kinds[kind];
    const draw = () => { thumb.style.backgroundImage = id ? `url(/media/${id})` : ''; thumb.textContent = id ? '' : 'ไม่มีรูป'; };
    const el = h('div.form', null, h('span.muted.small', null, label, rec && rec.w ? ` (แนะนำ ${rec.w}×${rec.h}px)` : ''),
      h('div.media-pick', null, thumb, h('div.row', null, h('button.btn.sm', { type: 'button', onclick: () => A.mediaLibrary(kind, (a) => { id = a.id; draw(); }) }, 'เลือก / อัปโหลด'), h('button.btn.sm.ghost', { type: 'button', onclick: () => { id = null; draw(); } }, 'ลบรูป'))));
    draw();
    return { el, get: () => id };
  };
  // Generic form builder. fields: [{key,label,type,options,step,placeholder,kind,full}]
  A.form = (fields, data = {}) => {
    const getters = {};
    const els = fields.map((f) => {
      const v = data[f.key];
      if (f.type === 'i18n' || f.type === 'i18n-text') { const x = A.i18n(f.label, v, { textarea: f.type === 'i18n-text' }); getters[f.key] = x.get; return x.el; }
      if (f.type === 'media') { const x = A.mediaPicker(f.label, f.kind, v); getters[f.key] = x.get; return x.el; }
      if (f.type === 'check') { const i = h('input', { type: 'checkbox', checked: v === undefined ? !!f.default : !!v }); getters[f.key] = () => i.checked; return h('label.check', null, i, f.label); }
      if (f.type === 'select') { const s = h('select', null, f.options.map(([val, lab]) => h('option', { value: val, selected: String(v ?? f.default ?? '') === String(val) }, lab))); getters[f.key] = () => (f.number ? (s.value === '' ? null : Number(s.value)) : s.value); return h('label', null, f.label, s); }
      if (f.type === 'multi') { const set = new Set((v || []).map(String)); const box = h('div.row', null, f.options.map(([val, lab]) => h('label.check', null, h('input', { type: 'checkbox', checked: set.has(String(val)), onchange: (e) => (e.target.checked ? set.add(String(val)) : set.delete(String(val))) }), lab))); getters[f.key] = () => [...set].map((x) => (f.number ? Number(x) : x)); return h('label', null, f.label, box); }
      if (f.type === 'money') { const i = h('input', { type: 'number', step: '0.01', min: 0, value: v != null ? (v / 100).toFixed(2) : '', placeholder: f.placeholder || '' }); getters[f.key] = () => (i.value === '' ? (f.nullable ? null : 0) : toSatang(i.value)); return h('label', null, f.label, i); }
      if (f.type === 'percent100') { const i = h('input', { type: 'number', step: '0.01', min: 0, value: v != null ? v / 100 : '' }); getters[f.key] = () => Math.round(Number(i.value || 0) * 100); return h('label', null, f.label, i); }
      if (f.type === 'textarea') { const i = h('textarea', { rows: f.rows || 3 }); i.value = v ?? ''; getters[f.key] = () => i.value; return h('label', null, f.label, i); }
      const i = h('input', { type: f.type || 'text', value: v ?? f.default ?? '', step: f.step, min: f.min, max: f.max, placeholder: f.placeholder || '' });
      getters[f.key] = () => (f.type === 'number' ? (i.value === '' ? (f.nullable ? null : 0) : Number(i.value)) : i.value);
      return h('label', null, f.label, i);
    });
    return { el: h('div.form-grid', null, els), values: () => Object.fromEntries(Object.entries(getters).map(([k, g]) => [k, g()])) };
  };
  // Modal editor wrapper
  A.editor = (title, fields, data, onSave, { wide = true, extra } = {}) => {
    const f = A.form(fields, data);
    const save = h('button.btn.primary', { onclick: async () => { save.disabled = true; try { await onSave(f.values(), extra); m.close(); BF.toast('บันทึกแล้ว', 'success'); } catch (e) { BF.error(e); save.disabled = false; } } }, 'บันทึก');
    const m = BF.modal(title, h('div.form', null, f.el, extra ? extra.el : null), { wide, actions: [h('button.btn', { onclick: () => m.close() }, 'ยกเลิก'), save] });
    return m;
  };
  A.table = (cols, rows, { empty = 'ยังไม่มีข้อมูล', onRow } = {}) => rows.length
    ? h('div.card.table-wrap', { style: { padding: 0 } }, h('table.list', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c[0])))), h('tbody', null, rows.map((r) => h('tr', { style: onRow ? { cursor: 'pointer' } : null, onclick: onRow ? () => onRow(r) : null }, cols.map((c) => h('td', null, c[1](r))))))))
    : BF.states.empty(empty, '📭');
  A.del = async (url, label) => { if (!await BF.confirm(`ลบ ${label}?`, { danger: true, ok: 'ลบ' })) return false; try { const r = await api.del(url); BF.toast(r.message || 'ลบแล้ว', r.message ? 'warn' : 'success', 4000); return true; } catch (e) { BF.error(e); return false; } };
  A.active = (v) => h('span.badge', { style: { background: v ? '#dcfce7' : '#f1f5f9', color: v ? '#166534' : '#64748b' } }, v ? 'ใช้งาน' : 'ปิด');
  A.money = money; A.baht = baht;

  // ---------- media library (with crop + compress) ----------
  A.mediaLibrary = async (kind, onPick) => {
    const body = h('div');
    const m = BF.modal(`คลังรูปภาพ • ${A.boot.media_kinds[kind] ? A.boot.media_kinds[kind].label : kind}`, body, { wide: true });
    const load = async () => {
      const r = await api.get(`/api/admin/media?kind=${kind}`);
      const rec = r.recommended[kind] || {};
      mount(body,
        h('div.row.between', null, h('div.muted', null, rec.w ? `ขนาดแนะนำ ${rec.w}×${rec.h}px • ` : '', `รองรับ JPG, PNG, WebP, SVG • ไม่เกิน ${r.max_mb} MB`), A.uploadButton(kind, async (a) => { await load(); if (onPick) { onPick(a); m.close(); } })),
        r.assets.length ? h('div.media-grid', { style: { marginTop: '12px' } }, r.assets.map((a) => h('div.media-item', { onclick: () => { if (onPick) { onPick(a); m.close(); } } }, h('div.mi-img', { style: { backgroundImage: `url(${a.url})` } }), h('div.mi-meta', null, `${a.width || '?'}×${a.height || '?'} • ${Math.round(a.size / 1024)}KB`, a.warning ? h('div', { style: { color: 'var(--warning)' } }, a.warning) : null)))) : BF.states.empty('ยังไม่มีรูป', '🖼'));
    };
    await load();
  };
  A.uploadButton = (kind, onDone, label = '⬆ อัปโหลด') => {
    const input = h('input', { type: 'file', accept: kind === 'font' ? '.ttf,.otf,.woff,.woff2' : 'image/jpeg,image/png,image/webp,image/svg+xml', style: { display: 'none' }, onchange: async () => {
      const file = input.files[0]; input.value = '';
      if (!file) return;
      if (kind === 'font' || file.type === 'image/svg+xml') return A.upload(kind, file, file.name).then(onDone).catch(BF.error);
      A.cropper(kind, file, async (blob, name) => { try { onDone(await A.upload(kind, blob, name)); } catch (e) { BF.error(e); } });
    } });
    return h('span', null, input, h('button.btn.primary.sm', { type: 'button', onclick: () => input.click() }, label));
  };
  A.upload = async (kind, blob, name, extra = {}) => {
    const fd = new FormData(); fd.append('kind', kind); for (const [k, v] of Object.entries(extra)) fd.append(k, v); fd.append('file', blob, name);
    const r = await api.post('/api/admin/media', fd);
    if (r.asset.warning) BF.toast(r.asset.warning, 'warn'); else BF.toast('อัปโหลดแล้ว', 'success');
    return r.asset;
  };
  // Crop (fixed aspect of the recommended size), zoom/pan, output WebP/JPEG with quality → compressed upload
  A.cropper = (kind, file, onDone) => {
    const rec = A.boot.media_kinds[kind] || {};
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ratio = rec.w ? rec.w / rec.h : img.width / img.height;
      const outW = rec.w ? Math.min(rec.w, Math.round(Math.max(img.width, img.height * ratio))) : img.width;
      const outH = Math.round(outW / ratio);
      const viewW = Math.min(560, window.innerWidth - 80), viewH = Math.round(viewW / ratio);
      const cv = h('canvas', { width: viewW, height: viewH });
      const ctx = cv.getContext('2d');
      const minScale = Math.max(viewW / img.width, viewH / img.height);
      const st = { scale: minScale, x: (viewW - img.width * minScale) / 2, y: (viewH - img.height * minScale) / 2, q: 0.85, fmt: 'image/webp' };
      const clamp = () => { st.x = Math.min(0, Math.max(viewW - img.width * st.scale, st.x)); st.y = Math.min(0, Math.max(viewH - img.height * st.scale, st.y)); };
      const draw = () => { clamp(); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, viewW, viewH); ctx.drawImage(img, st.x, st.y, img.width * st.scale, img.height * st.scale); };
      let drag = null;
      cv.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y }; cv.setPointerCapture(e.pointerId); };
      cv.onpointermove = (e) => { if (!drag) return; const k = viewW / cv.getBoundingClientRect().width; st.x = drag.sx + (e.clientX - drag.x) * k; st.y = drag.sy + (e.clientY - drag.y) * k; draw(); };
      cv.onpointerup = () => { drag = null; };
      const zoom = h('input', { type: 'range', min: 100, max: 400, value: 100, oninput: () => { const cx = viewW / 2, cy = viewH / 2; const ns = minScale * zoom.value / 100; st.x = cx - (cx - st.x) * ns / st.scale; st.y = cy - (cy - st.y) * ns / st.scale; st.scale = ns; draw(); } });
      const quality = h('input', { type: 'range', min: 40, max: 100, value: 85, oninput: () => { st.q = quality.value / 100; } });
      const fmt = h('select', { onchange: () => { st.fmt = fmt.value; } }, h('option', { value: 'image/webp' }, 'WebP (เล็กที่สุด)'), h('option', { value: 'image/jpeg' }, 'JPEG'), h('option', { value: 'image/png' }, 'PNG (โปร่งใส)'));
      const info = h('div.muted.small', null, `ต้นฉบับ ${img.width}×${img.height}px • ${Math.round(file.size / 1024)}KB → ผลลัพธ์ ${outW}×${outH}px`);
      const exportBlob = () => new Promise((res) => {
        const out = document.createElement('canvas'); out.width = outW; out.height = outH;
        const o = out.getContext('2d'); const k = outW / viewW;
        if (st.fmt !== 'image/png') { o.fillStyle = '#fff'; o.fillRect(0, 0, outW, outH); }
        o.imageSmoothingQuality = 'high';
        o.drawImage(img, st.x * k, st.y * k, img.width * st.scale * k, img.height * st.scale * k);
        out.toBlob(res, st.fmt, st.q);
      });
      const m = BF.modal('ครอบตัด & บีบอัดรูป', h('div.cropper', null, h('div.crop-stage', null, cv), h('label', null, 'ซูม', zoom), h('div.form-grid', null, h('label', null, 'รูปแบบไฟล์', fmt), h('label', null, 'คุณภาพ / การบีบอัด', quality)), info), {
        wide: true, onClose: () => URL.revokeObjectURL(url),
        actions: [
          h('button.btn', { onclick: () => { m.close(); onDone(file, file.name); } }, 'ใช้ไฟล์ต้นฉบับ'),
          h('button.btn.primary', { onclick: async () => { const b = await exportBlob(); m.close(); const ext = st.fmt.split('/')[1]; onDone(b, file.name.replace(/\.[^.]+$/, '') + '.' + ext); } }, 'ครอบตัดและอัปโหลด')] });
      draw();
    };
    img.onerror = () => BF.toast('เปิดรูปไม่ได้', 'error');
    img.src = url;
  };

  // ---------- rich text editor ----------
  A.richText = (value = {}) => {
    const v = { th: '', en: '', zh: '', ...value };
    let cur = 'th';
    const ed = h('div.rte', { contenteditable: 'true' });
    const tabs = h('div.i18n-tabs');
    const sync = () => { v[cur] = ed.innerHTML; };
    ed.oninput = sync;
    const drawTabs = () => mount(tabs, LANGS.map(([l, n]) => h('button', { type: 'button', class: l === cur ? 'active' : '', onclick: () => { sync(); cur = l; ed.innerHTML = v[cur] || ''; drawTabs(); } }, n)));
    const cmd = (c, arg) => () => { ed.focus(); document.execCommand(c, false, arg); sync(); };
    const bar = h('div.rte-bar', null,
      h('button', { type: 'button', onclick: cmd('bold'), title: 'ตัวหนา' }, h('b', null, 'B')), h('button', { type: 'button', onclick: cmd('italic') }, h('i', null, 'I')), h('button', { type: 'button', onclick: cmd('underline') }, h('u', null, 'U')),
      h('button', { type: 'button', onclick: cmd('formatBlock', 'h3') }, 'H'), h('button', { type: 'button', onclick: cmd('formatBlock', 'p') }, '¶'),
      h('button', { type: 'button', onclick: cmd('insertUnorderedList') }, '•'), h('button', { type: 'button', onclick: cmd('insertOrderedList') }, '1.'),
      h('button', { type: 'button', onclick: () => { const u = prompt('ลิงก์ (https://...)'); if (u) cmd('createLink', u)(); } }, '🔗'), h('button', { type: 'button', onclick: cmd('removeFormat') }, '⨯'));
    ed.innerHTML = v.th; drawTabs();
    return { el: h('div', null, tabs, bar, ed), get: () => { sync(); return { ...v }; } };
  };

  // ---------- dashboard ----------
  A.sections.dashboard = async (c) => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const [today, sales] = await Promise.all([api.get(`/api/admin/reports/summary?from=${from.getTime()}&to=${Date.now()}&branch_id=current`), api.get(`/api/admin/reports/sales?from=${Date.now() - 13 * 86400e3}&to=${Date.now()}&group=day&branch_id=current`)]);
    const t = today.totals;
    mount(c, A.head('แดชบอร์ดวันนี้', h('button.btn.sm', { onclick: A.refresh }, '↻')),
      h('div.cards', null,
        stat('ยอดขายวันนี้', baht(t.total)), stat('จำนวนโต๊ะ (ปิดแล้ว)', t.tables), stat('จำนวนลูกค้า', t.guests), stat('โต๊ะที่เปิดอยู่', t.open_tables), stat('ส่วนลด', baht(t.discount)), stat('คืนเงิน', baht(t.refunded))),
      h('div.card.section', null, h('h3', null, 'ยอดขายรายวัน (14 วัน)'), barChart(sales.rows.map((r) => ({ label: r.period.slice(5), value: r.total || 0 })))),
      h('div.grid2', null,
        h('div.card', null, h('h3', null, 'แพ็กเกจยอดนิยมวันนี้'), A.table([['แพ็กเกจ', (r) => r.name], ['ลูกค้า', (r) => r.guests], ['รายได้', (r) => money(r.revenue)]], today.packages, { empty: 'ยังไม่มีข้อมูลวันนี้' })),
        h('div.card', null, h('h3', null, 'ช่องทางชำระเงินวันนี้'), A.table([['ช่องทาง', (r) => r.method], ['รายการ', (r) => r.count], ['ยอด', (r) => money(r.amount)]], today.byMethod, { empty: 'ยังไม่มีการชำระเงินวันนี้' }))));
  };
  function stat(l, v) { return h('div.card.stat', null, h('div.l', null, l), h('div.v', null, v)); }
  // Single-series bar chart (one hue, rounded data-ends, hover tooltip). Table view: Reports page.
  function barChart(data) {
    if (!data.length || !data.some((d) => d.value)) return BF.states.empty('ยังไม่มียอดขายในช่วงนี้', '📉');
    const W = 700, H = 220, pad = { l: 56, r: 8, t: 10, b: 26 };
    const max = Math.max(...data.map((d) => d.value)) * 1.1;
    const bw = (W - pad.l - pad.r) / data.length;
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'ยอดขายรายวัน');
    const el = (n, a) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); svg.appendChild(e); return e; };
    for (let i = 0; i <= 4; i++) { const v = max * i / 4; el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: '#e5e7eb', 'stroke-width': 1 }); el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#6b7280' }).textContent = Math.round(v / 100).toLocaleString(); }
    const tip = h('div.tip');
    data.forEach((d, i) => {
      const x = pad.l + i * bw + 2, w = Math.max(2, bw - 4), top = y(d.value), hgt = H - pad.b - top;
      const r = Math.min(4, w / 2, hgt);
      el('path', { d: `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - pad.b} Z`, fill: 'var(--primary)' });
      el('text', { x: x + w / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#6b7280' }).textContent = d.label;
      const hit = el('rect', { x: pad.l + i * bw, y: pad.t, width: bw, height: H - pad.t - pad.b, fill: 'transparent' });
      hit.addEventListener('mousemove', () => { const box = svg.getBoundingClientRect(); tip.style.display = 'block'; tip.style.left = `${(x + w / 2) / W * box.width}px`; tip.style.top = `${top / H * box.height}px`; tip.textContent = `${d.label}: ฿${money(d.value)}`; });
      hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
    return h('div.chart', null, svg, tip);
  }

  // ---------- restaurant & branches ----------
  A.sections.restaurant = async (c) => {
    await A.reloadBoot();
    const r = A.boot.restaurant;
    const rf = A.form([
      { key: 'name', label: 'ชื่อร้าน', type: 'i18n' }, { key: 'tax_id', label: 'เลขประจำตัวผู้เสียภาษี' }, { key: 'phone', label: 'เบอร์โทรศัพท์' }, { key: 'logo_asset_id', label: 'โลโก้ร้าน', type: 'media', kind: 'logo' },
    ], r);
    const contact = A.form([{ key: 'line', label: 'LINE' }, { key: 'facebook', label: 'Facebook' }, { key: 'instagram', label: 'Instagram' }, { key: 'website', label: 'เว็บไซต์' }, { key: 'email', label: 'อีเมล' }], r.contact || {});
    mount(c, A.head('ร้าน & สาขา'),
      h('div.card.section', null, h('h3', null, 'ข้อมูลร้าน'), rf.el, h('h4', null, 'ช่องทางติดต่อ'), contact.el,
        h('div.row', { style: { marginTop: '12px' } }, h('button.btn.primary', { onclick: async () => { try { await api.put('/api/admin/restaurant', { ...rf.values(), contact: contact.values() }); BF.toast('บันทึกแล้ว', 'success'); } catch (e) { BF.error(e); } } }, 'บันทึกข้อมูลร้าน'))),
      h('div.card', null, h('div.row.between', null, h('h3', null, 'สาขา'), BF.auth.can('staff.manage') ? h('button.btn.primary.sm', { onclick: () => branchEditor() }, '+ เพิ่มสาขา') : null),
        A.table([['รหัส', (b) => b.code], ['ชื่อ', (b) => tr(b.name)], ['โทร', (b) => b.phone || ''], ['สถานะ', (b) => A.active(b.active)], ['', (b) => h('button.btn.sm', { onclick: () => branchEditor(b) }, 'แก้ไข')]], A.boot.branches),
        h('p.muted.small', null, 'การตั้งค่าแยกตามสาขา (โต๊ะ, ราคาแพ็กเกจเฉพาะสาขา, เครื่องพิมพ์, ธีม, การตั้งค่าระบบ) ใช้กับสาขาที่เข้าสู่ระบบอยู่ — เปลี่ยนสาขาได้จากหน้าเข้าสู่ระบบหรือ POS')));
  };
  const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  function branchEditor(b) {
    const hours = h('div.form', null, DAYS.map((d, i) => { const oh = (b && b.open_hours || []).find((x) => x.day === i) || {}; return h('div.row', { dataset: { day: i } }, h('b', { style: { width: '32px' } }, d), h('input', { type: 'time', value: oh.open || '', 'data-k': 'open', style: { width: '130px' } }), '–', h('input', { type: 'time', value: oh.close || '', 'data-k': 'close', style: { width: '130px' } })); }));
    const extra = { el: h('div.form', null, h('h4', null, 'เวลาเปิด-ปิด (เว้นว่าง = ปิด)'), hours) };
    A.editor(b ? `แก้ไขสาขา ${b.code}` : 'เพิ่มสาขา', [
      ...(b ? [] : [{ key: 'code', label: 'รหัสสาขา (A-Z, 0-9)' }]), { key: 'name', label: 'ชื่อสาขา', type: 'i18n' }, { key: 'address', label: 'ที่อยู่', type: 'i18n-text' }, { key: 'phone', label: 'โทรศัพท์' }, { key: 'tax_id', label: 'เลขผู้เสียภาษี (สาขา)' },
      { key: 'holidays', label: 'วันหยุด (YYYY-MM-DD คั่นด้วย ,)' }, { key: 'logo_asset_id', label: 'โลโก้สาขา', type: 'media', kind: 'logo' }, { key: 'banner_asset_id', label: 'แบนเนอร์', type: 'media', kind: 'banner' }, { key: 'banner_mobile_asset_id', label: 'แบนเนอร์มือถือ', type: 'media', kind: 'banner_mobile' }, { key: 'active', label: 'เปิดใช้งาน', type: 'check', default: true },
    ], b ? { ...b, holidays: (b.holidays || []).join(', ') } : { active: true }, async (v) => {
      const open_hours = [...hours.children].map((row) => ({ day: Number(row.dataset.day), open: row.querySelector('[data-k=open]').value, close: row.querySelector('[data-k=close]').value })).filter((x) => x.open && x.close);
      const body = { ...v, open_hours, holidays: String(v.holidays || '').split(',').map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) };
      if (b) await api.put(`/api/admin/branches/${b.id}`, body); else await api.post('/api/admin/branches', body);
      A.refresh();
    }, { extra });
  }

  // ---------- settings ----------
  A.sections.settings = async (c) => {
    await A.reloadBoot();
    const s = A.boot.settings;
    const approvals = [['refund', 'คืนเงิน'], ['void_bill', 'ยกเลิกบิล'], ['adjust_points', 'ปรับคะแนน'], ['discount_over', 'ส่วนลดเกินเกณฑ์ / ยกเว้นค่าปรับ'], ['cancel_served_item', 'ยกเลิกรายการที่เสิร์ฟแล้ว'], ['reopen_session', 'เปิดโต๊ะที่ปิดแล้ว']];
    const f = A.form([
      { key: 'vat_rate', label: 'VAT (%)', type: 'number', step: '0.01' }, { key: 'service_rate', label: 'Service Charge (%)', type: 'number', step: '0.01' },
      { key: 'prices_include_vat', label: 'ราคาแพ็กเกจรวม VAT แล้ว', type: 'check' }, { key: 'service_charge_on_extras', label: 'คิด Service Charge กับอาหารเพิ่มเติม', type: 'check' },
      { key: 'after_payment_table_status', label: 'หลังชำระเงิน โต๊ะเปลี่ยนเป็น', type: 'select', options: [['cleaning', 'รอทำความสะอาด'], ['available', 'ว่างทันที']] },
      { key: 'time_alerts_min', label: 'แจ้งเตือนก่อนหมดเวลา (นาที, คั่นด้วย ,)' }, { key: 'lock_orders_after_time_up', label: 'ล็อกการสั่งอาหารเมื่อหมดเวลาสั่ง', type: 'check' },
      { key: 'allow_mixed_packages', label: 'อนุญาตลูกค้าโต๊ะเดียวกันเลือกต่างแพ็กเกจ', type: 'check' }, { key: 'member_signup_slip', label: 'พิมพ์ใบสมัครสมาชิกอัตโนมัติเมื่อลูกค้าไม่เป็นสมาชิก', type: 'check' },
      { key: 'kds_warn', label: 'KDS สีเหลืองเมื่อรอ (นาที)', type: 'number' }, { key: 'kds_danger', label: 'KDS สีแดงเมื่อรอ (นาที)', type: 'number' }, { key: 'kds_sound', label: 'เสียงแจ้งเตือนครัว', type: 'check' },
      { key: 'call_cooldown_sec', label: 'กันกดเรียกพนักงานซ้ำ (วินาที)', type: 'number' }, { key: 'discount_approval_over_percent', label: 'ส่วนลดเกินกี่ % ต้องอนุมัติ', type: 'number' },
      { key: 'max_upload_mb', label: 'ขนาดไฟล์อัปโหลดสูงสุด (MB)', type: 'number' }, { key: 'timezone', label: 'Timezone' },
      { key: 'languages', label: 'ภาษาที่เปิดให้ลูกค้า', type: 'multi', options: [['th', 'ไทย'], ['en', 'English'], ['zh', '中文']] }, { key: 'default_language', label: 'ภาษาเริ่มต้น', type: 'select', options: [['th', 'ไทย'], ['en', 'English'], ['zh', '中文']] },
      { key: 'require_manager_approval', label: 'รายการที่ต้อง Manager Approval', type: 'multi', options: approvals },
      { key: 'points_expiry', label: 'อายุคะแนน (วัน)', type: 'number' }, { key: 'points_signup', label: 'โบนัสสมัครใหม่ (คะแนน)', type: 'number' }, { key: 'points_birthday', label: 'โบนัสวันเกิด (คะแนน)', type: 'number' },
      { key: 'qr_ticket_footer', label: 'ข้อความท้ายใบ QR', type: 'i18n' }, { key: 'receipt_footer', label: 'ข้อความท้ายใบเสร็จ', type: 'i18n-text' }, { key: 'member_signup_text', label: 'ข้อความเชิญชวนบนใบสมัครสมาชิก', type: 'i18n-text' },
    ], { ...s, time_alerts_min: s.time_alerts_min.join(', '), kds_warn: s.kds_thresholds.warn, kds_danger: s.kds_thresholds.danger, points_expiry: s.points.expiry_days, points_signup: s.points.signup_bonus, points_birthday: s.points.birthday_bonus });
    mount(c, A.head('ตั้งค่าระบบ (สาขาปัจจุบัน)'), h('div.card', null, f.el, h('div.row', { style: { marginTop: '16px' } }, h('button.btn.primary', { onclick: async () => {
      const v = f.values();
      const body = { ...v, time_alerts_min: String(v.time_alerts_min).split(',').map((x) => Number(x.trim())).filter((x) => x > 0), kds_thresholds: { warn: v.kds_warn, danger: v.kds_danger }, points: { expiry_days: v.points_expiry, signup_bonus: v.points_signup, birthday_bonus: v.points_birthday } };
      for (const k of ['kds_warn', 'kds_danger', 'points_expiry', 'points_signup', 'points_birthday']) delete body[k];
      try { await api.put('/api/admin/settings', body); BF.toast('บันทึกการตั้งค่าแล้ว', 'success'); } catch (e) { BF.error(e); }
    } }, 'บันทึกการตั้งค่า'))));
  };

  A.sections.terms = async (c) => {
    await A.reloadBoot();
    const ed = A.richText(A.boot.settings.terms);
    mount(c, A.head('เงื่อนไขการใช้บริการ', h('button.btn.primary', { onclick: async () => { try { await api.put('/api/admin/settings', { terms: ed.get() }); BF.toast('บันทึกแล้ว (ระบบกรอง HTML ที่ไม่ปลอดภัยออกอัตโนมัติ)', 'success'); } catch (e) { BF.error(e); } } }, 'บันทึก')),
      h('div.card', null, h('p.muted', null, 'แสดงในหน้าข้อมูลโต๊ะของลูกค้า (หน้าแพ็กเกจ / เวลา / เงื่อนไข / แชร์ QR) • รองรับหัวข้อ รายการ ลิงก์ และหลายภาษา'), ed.el));
  };
})();
