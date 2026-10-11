// Admin: Theme & Design Studio (fonts, sizes, colors, shapes, print templates, live preview) and the media/font library.
(function () {
  'use strict';
  const { h, mount, $, api, tr } = { ...BF, api: BF.api };
  const A = window.ADMIN;
  const SIZE_LABELS = { store_name: 'ชื่อร้าน', menu_name: 'ชื่อเมนู', description: 'รายละเอียด', body: 'ข้อความทั่วไป', price: 'ราคา', category: 'หมวดหมู่', button: 'ปุ่ม', heading: 'หัวข้อ' };
  const COLOR_LABELS = { bg: 'พื้นหลัง', surface: 'พื้นหลังการ์ด/กล่อง', text: 'ข้อความ', muted: 'ข้อความรอง', primary: 'สีหลัก / ปุ่ม', primary_text: 'ข้อความบนปุ่ม', accent: 'สีเน้น / ราคา', category_text: 'หมวดหมู่ (ปกติ)', category_active: 'หมวดหมู่ (เลือก)', nav_bg: 'แถบนำทาง', nav_text: 'ข้อความแถบนำทาง', badge: 'จุดแจ้งเตือน', success: 'สำเร็จ', warning: 'เตือน', danger: 'อันตราย', alert: 'แจ้งเตือน' };
  const STATUS_LABELS = { received: 'รับออเดอร์แล้ว', sent: 'ส่งเข้าครัว', preparing: 'กำลังเตรียม', cooking: 'กำลังปรุง', ready: 'พร้อมเสิร์ฟ', served: 'เสิร์ฟแล้ว', cancelled: 'ยกเลิก', unavailable: 'ทำไม่ได้' };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const merge = (a, b) => { if (typeof a !== 'object' || a === null || Array.isArray(a)) return b === undefined ? a : b; const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = k in a ? merge(a[k], b[k]) : b[k]; return o; };

  A.sections.studio = async (c) => {
    const [{ themes, active }, { items: menu }, { categories }, { packages }, { items: calls }, fontsR] = await Promise.all([api.get('/api/admin/themes'), api.get('/api/admin/menu-items'), api.get('/api/admin/categories'), api.get('/api/admin/packages'), api.get('/api/admin/call-types'), api.get('/api/admin/fonts/google')]);
    await A.reloadBoot();
    const st = { theme: themes.find((t) => t.is_active) || { id: null, name: 'Default' }, settings: clone(active.settings), scope: 'customer', panel: 'fonts', device: 'mobile', doc: 'qr_ticket', paper: 80, lang: 'th' };
    st.settings.print = merge(A.boot.default_print_template, st.settings.print || {});
    const panel = h('div.card.studio-panel');
    const preview = h('div.preview-box');
    const fontList = h('datalist#fontlist', null, fontsR.fonts.map((f) => h('option', { value: f.family }, f.uploaded ? 'อัปโหลด' : '')));
    let frame = null, frameReady = false;

    // ---------- preview ----------
    const previewData = () => {
      const b = A.boot.branches.find((x) => x.id === A.boot.branch_id) || {};
      const r = A.boot.restaurant;
      const now = Date.now();
      const pk = packages.filter((p) => p.active).slice(0, 1);
      return {
        info: {
          session: { public_code: 'PREVIEW', status: 'active', table_code: '7', start_at: now - 600000, end_at: now + 170 * 60000, order_end_at: now + 170 * 60000, duration_min: 180, guests: [{ label: 'A', display_name: null, package_id: pk[0] ? pk[0].id : 0 }], guests_count: 1 },
          packages: pk.map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, leftover: p.leftover_policy || {} })),
          restaurant: { name: r.name, branch_name: b.name, logo: (b.logo_asset_id || r.logo_asset_id) ? `/media/${b.logo_asset_id || r.logo_asset_id}` : null, banner: b.banner_asset_id ? `/media/${b.banner_asset_id}` : null, banner_mobile: b.banner_mobile_asset_id ? `/media/${b.banner_mobile_asset_id}` : null },
          terms: A.boot.settings.terms, languages: A.boot.settings.languages, call_types: calls.filter((x) => x.active), alerts_min: [], member: null,
        },
        menu: { categories: categories.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name })), items: menu.filter((i) => i.status !== 'stopped').map((i) => ({ ...i, packages: i.packages.map((p) => p.package_id), status: i.status === 'out' ? 'out' : 'available' })) },
      };
    };
    const sendPreview = BF.debounce(async () => {
      if (st.panel === 'print') return drawPrintPreview();
      let css = '';
      try { css = await api.raw('POST', '/api/admin/themes/preview.css', { settings: st.settings, scope: st.scope }); } catch (e) { return BF.error(e); }
      if (st.scope === 'customer') { if (frame && frameReady) frame.contentWindow.postMessage({ type: 'bf-preview', css, lang: st.lang, ...previewData() }, location.origin); }
      else if (frame) frame.srcdoc = sampleStaffPage(css);
    }, 250);
    window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.type === 'bf-preview-ready') { frameReady = true; sendPreview(); } });
    function sampleStaffPage(css) {
      const label = { pos: 'POS', admin: 'Admin', kds: 'Kitchen Display' }[st.scope];
      return `<!doctype html><html lang="th"><head><meta charset="utf-8"><link rel="stylesheet" href="/shared/base.css"><style>${css.replace(/<\//g, '<\\/')}</style></head><body style="padding:16px;background:var(--surface)">
        <div class="topbar" style="border-radius:12px"><b class="brand">${label}</b><span class="tab active" style="opacity:1">ผังโต๊ะ</span><span class="tab">เรียกพนักงาน</span></div>
        <h2 style="margin-top:16px;font-size:var(--fs-h)">ตัวอย่างหัวข้อ / Heading</h2><p style="font-size:var(--fs-body)">ข้อความทั่วไป ภาษาไทย English 中文 — ตัวอย่างการแสดงผล</p>
        <div class="card" style="display:grid;gap:8px"><div style="font-size:var(--fs-menu);font-weight:700">2× แซลมอนซาชิมิ</div><div class="muted" style="font-size:var(--fs-desc)">ซอส: วาซาบิ • คุณ A</div>
        <div class="row"><span class="badge st st-cooking">กำลังปรุง</span><span class="badge st st-ready">พร้อมเสิร์ฟ</span><span class="badge st st-sent">ส่งเข้าครัว</span></div>
        <div class="row"><button class="btn primary">ปุ่มหลัก</button><button class="btn">ปุ่มรอง</button><button class="btn danger">ลบ</button></div></div></body></html>`;
    }
    const drawPrintPreview = BF.debounce(async () => {
      try {
        const blob = await api.raw('POST', '/api/admin/print-preview.png', { doc_type: st.doc, paper: st.paper, template: st.settings.print }, { raw: true });
        mount(preview, deviceBar(), h('div.print-prev', null, h('img', { src: URL.createObjectURL(blob), alt: 'print preview', style: { width: `${st.paper === 58 ? 384 : 576}px` } })), h('div.muted.small', null, 'ตัวอย่างใบพิมพ์ (ข้อมูลตัวอย่าง • QR ในตัวอย่างสแกนไม่ได้) — ขนาดจริงตามจำนวนจุดของหัวพิมพ์'));
      } catch (e) { BF.error(e); }
    }, 300);
    function deviceBar() {
      if (st.panel === 'print') return h('div.row', null, Object.entries(A.boot.doc_types).filter(([k]) => k !== 'test').map(([k, l]) => h('button.chip', { class: st.doc === k ? 'active' : '', onclick: () => { st.doc = k; drawPrintPreview(); } }, l)), [58, 80].map((p) => h('button.chip', { class: st.paper === p ? 'active' : '', onclick: () => { st.paper = p; drawPrintPreview(); } }, `${p} มม.`)));
      return h('div.row', null, [['mobile', '📱 มือถือ'], ['tablet', '📲 แท็บเล็ต'], ['desktop', '🖥 คอมพิวเตอร์']].map(([k, l]) => h('button.chip', { class: st.device === k ? 'active' : '', onclick: () => { st.device = k; drawPreview(); } }, l)),
        st.scope === 'customer' ? A.boot.settings.languages.map((l) => h('button.chip', { class: st.lang === l ? 'active' : '', onclick: () => { st.lang = l; sendPreview(); } }, l.toUpperCase())) : null);
    }
    function drawPreview() {
      if (st.panel === 'print') return drawPrintPreview();
      const dims = { mobile: [390, 780, 1], tablet: [820, 1000, 0.62], desktop: [1280, 820, 0.48] }[st.device];
      frameReady = false;
      frame = h('iframe', { src: st.scope === 'customer' ? '/order/?preview=1' : 'about:blank', style: { width: `${dims[0]}px`, height: `${dims[1]}px`, transform: `scale(${dims[2]})`, transformOrigin: 'top left' } });
      const wrap = h('div', { style: { width: `${dims[0] * dims[2]}px`, height: `${dims[1] * dims[2]}px`, overflow: 'hidden' } }, frame);
      mount(preview, deviceBar(), h('div.device', null, wrap), h('div.muted.small', null, st.scope === 'customer' ? 'ตัวอย่างใช้เมนูจริงจากฐานข้อมูล (โหมดดูตัวอย่าง สั่งอาหารไม่ได้)' : `ตัวอย่างหน้าตา ${st.scope.toUpperCase()}`));
      if (st.scope !== 'customer') sendPreview();
    }

    // ---------- controls ----------
    const set = (path, value) => { let o = st.settings; const ks = path.split('.'); while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = value; sendPreview(); };
    const num = (label, path, value, { min = 8, max = 96, step = 1 } = {}) => h('div.size-row', null, h('label', null, label, h('input', { type: 'range', min, max, step, value, oninput: (e) => { e.target.closest('.size-row').querySelector('input[type=number]').value = e.target.value; set(path, Number(e.target.value)); } })), h('input', { type: 'number', min, max, step, value, oninput: (e) => set(path, Number(e.target.value)) }));
    const color = (label, path, value) => h('div.color-row', null, h('input', { type: 'color', value: value.length === 7 ? value : '#000000', oninput: (e) => { e.target.nextSibling.querySelector('input').value = e.target.value; set(path, e.target.value); } }), h('label', null, label, h('input', { value, oninput: (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) set(path, e.target.value); } })));
    const fontInput = (label, path, value) => h('label', null, label, h('input', { list: 'fontlist', value: value || '', placeholder: 'ค้นหา / พิมพ์ชื่อ Google Font', onchange: (e) => set(path, e.target.value.trim()) }));

    function drawPanel() {
      const s = st.settings; const sc = s.scopes[st.scope];
      const tabs = h('div.row', null, [['fonts', 'ฟอนต์ & ขนาด'], ['colors', 'สี'], ['shape', 'รูปทรง & ระยะ'], ['print', 'ใบพิมพ์']].map(([k, l]) => h('button.chip', { class: st.panel === k ? 'active' : '', onclick: () => { const wasPrint = st.panel === 'print'; st.panel = k; drawPanel(); if (wasPrint || k === 'print') drawPreview(); } }, l)));
      const scopeSel = h('div.row', null, h('span.muted', null, 'ใช้กับ:'), [['customer', 'เว็บลูกค้า'], ['pos', 'POS'], ['admin', 'Admin'], ['kds', 'KDS']].map(([k, l]) => h('button.chip', { class: st.scope === k ? 'active' : '', onclick: () => { st.scope = k; drawPanel(); drawPreview(); } }, l)));
      let body;
      if (st.panel === 'fonts') body = h('div.form', null, scopeSel,
        fontInput('ฟอนต์หลัก', `scopes.${st.scope}.font_family`, sc.font_family),
        h('div.form-grid', null, fontInput('ฟอนต์ภาษาไทย', `scopes.${st.scope}.font_by_lang.th`, sc.font_by_lang.th), fontInput('ฟอนต์อังกฤษ', `scopes.${st.scope}.font_by_lang.en`, sc.font_by_lang.en), fontInput('ฟอนต์จีน', `scopes.${st.scope}.font_by_lang.zh`, sc.font_by_lang.zh)),
        h('div.muted.small', null, fontsR.note || '', ' • อัปโหลดฟอนต์ .ttf/.otf/.woff/.woff2 ได้ที่ "คลังรูปภาพ & ฟอนต์"'),
        h('h4', null, 'ขนาดตัวอักษร (px)'), Object.entries(SIZE_LABELS).map(([k, l]) => num(l, `scopes.${st.scope}.sizes.${k}`, sc.sizes[k])),
        h('h4', null, 'น้ำหนัก & ระยะ'), num('น้ำหนักหัวข้อ', `scopes.${st.scope}.weights.heading`, sc.weights.heading, { min: 100, max: 900, step: 100 }), num('น้ำหนักข้อความ', `scopes.${st.scope}.weights.body`, sc.weights.body, { min: 100, max: 900, step: 100 }),
        num('ระยะห่างตัวอักษร (px)', `scopes.${st.scope}.letter_spacing`, sc.letter_spacing, { min: -2, max: 10, step: 0.1 }), num('ความสูงบรรทัด', `scopes.${st.scope}.line_height`, sc.line_height, { min: 1, max: 2.4, step: 0.05 }));
      else if (st.panel === 'colors') body = h('div.form', null, Object.entries(COLOR_LABELS).map(([k, l]) => color(l, `colors.${k}`, s.colors[k])), h('h4', null, 'สีสถานะออเดอร์'), Object.entries(STATUS_LABELS).map(([k, l]) => color(l, `colors.status.${k}`, s.colors.status[k])));
      else if (st.panel === 'shape') body = h('div.form', null, num('ความโค้งมุมรูปภาพ', 'radius.image', s.radius.image, { min: 0, max: 48 }), num('ความโค้งการ์ด', 'radius.card', s.radius.card, { min: 0, max: 40 }), num('ความโค้งปุ่ม', 'radius.button', s.radius.button, { min: 0, max: 40 }),
        h('label', null, 'เงา', h('select', { onchange: (e) => set('shadow', e.target.value) }, [['none', 'ไม่มี'], ['soft', 'บาง'], ['medium', 'กลาง'], ['strong', 'เข้ม']].map(([v, l]) => h('option', { value: v, selected: s.shadow === v }, l)))),
        num('ระยะขอบ (spacing)', 'spacing', s.spacing, { min: 4, max: 40 }), num('ระยะห่างระหว่างรูป (grid gap)', 'grid_gap', s.grid_gap, { min: 4, max: 40 }), num('ความสูงปุ่ม', 'button_height', s.button_height, { min: 32, max: 72 }));
      else {
        const p = s.print;
        const logoPick = A.mediaPicker('โลโก้บนใบเสร็จ (ว่าง = โลโก้ร้าน)', 'receipt_logo', p.logo_asset_id);
        const header = A.i18n('ข้อความหัวใบ', p.header_text);
        body = h('div.form', null,
          h('div.row', null, fontInput('ฟอนต์ใบพิมพ์', 'print.font', p.font), h('button.btn.sm', { onclick: async () => { try { await api.post('/api/admin/fonts/google/fetch', { family: p.font }); BF.toast(`ดาวน์โหลดฟอนต์ ${p.font} สำหรับเครื่องพิมพ์แล้ว`, 'success'); drawPrintPreview(); } catch (e) { BF.error(e); } } }, 'ดาวน์โหลดฟอนต์ไว้ใช้พิมพ์')),
          h('div.muted.small', null, 'ใบพิมพ์ทุกใบแปลงเป็นภาพ Bitmap ก่อนส่งเครื่องพิมพ์ จึงพิมพ์ภาษาไทย/จีนได้แม้เครื่องพิมพ์ไม่มีฟอนต์ไทย'),
          num('ขนาดตัวอักษรพื้นฐาน (px, 0 = อัตโนมัติ)', 'print.base_size', p.base_size, { min: 0, max: 48 }), num('ขนาดหัวข้อ (%)', 'print.title_size_pct', p.title_size_pct, { min: 80, max: 250 }), num('ขนาดตัวอักษรใบครัว (%)', 'print.kitchen_size_pct', p.kitchen_size_pct, { min: 80, max: 250 }),
          num('ระยะขอบ (dots)', 'print.margin', p.margin, { min: 0, max: 40 }), num('ความสูงบรรทัด', 'print.line_height', p.line_height, { min: 1, max: 2, step: 0.05 }), num('ขนาด QR (% ความกว้าง)', 'print.qr_size_pct', p.qr_size_pct, { min: 30, max: 95 }),
          h('label.check', null, h('input', { type: 'checkbox', checked: p.show_logo, onchange: (e) => set('print.show_logo', e.target.checked) }), 'แสดงโลโก้'),
          logoPick.el, header.el,
          h('button.btn.sm', { onclick: () => { st.settings.print.logo_asset_id = logoPick.get(); st.settings.print.header_text = header.get(); drawPrintPreview(); } }, 'อัปเดตตัวอย่าง'),
          h('div.muted.small', null, 'ข้อความท้ายใบ QR/ใบเสร็จ ตั้งค่าได้ที่ "ตั้งค่าระบบ" • จำนวนสำเนาตั้งที่ "เครื่องพิมพ์"'));
        st.printGetters = { logo: logoPick.get, header: header.get };
      }
      mount(panel, h('div.form', null,
        h('div.row', null, h('select', { style: { flex: 1 }, onchange: (e) => { const t = themes.find((x) => String(x.id) === e.target.value); if (t) { st.theme = t; st.settings = clone(t.settings); st.settings.print = merge(A.boot.default_print_template, st.settings.print || {}); drawPanel(); drawPreview(); } } }, themes.map((t) => h('option', { value: t.id, selected: t.id === st.theme.id }, `${t.name}${t.is_active ? ' (ใช้งานอยู่)' : ''}`))),
          h('button.btn.sm.ghost', { onclick: async () => { if (!await BF.confirm('คืนค่าเริ่มต้นทั้งหมดของธีมนี้?')) return; st.settings = clone(A.boot.default_theme); st.settings.print = clone(A.boot.default_print_template); drawPanel(); drawPreview(); } }, 'คืนค่าเริ่มต้น')),
        tabs, body));
    }
    async function save(activate, asNew) {
      if (st.printGetters) { st.settings.print.logo_asset_id = st.printGetters.logo(); st.settings.print.header_text = st.printGetters.header(); }
      let name = st.theme.name;
      if (asNew) { name = prompt('ชื่อธีมใหม่', `${name} copy`); if (!name) return; }
      try {
        const r = await api.post('/api/admin/themes', { id: asNew ? undefined : st.theme.id, name, settings: st.settings, activate });
        BF.toast(activate ? 'บันทึกและเปิดใช้ธีมแล้ว — หน้าที่เกี่ยวข้องจะใช้ธีมใหม่เมื่อโหลดใหม่' : 'บันทึกธีมแล้ว', 'success', 4500);
        location.hash = 'studio'; A.refresh(); return r;
      } catch (e) { BF.error(e); }
    }
    mount(c, fontList, A.head('Theme & Design Studio',
      h('button.btn', { onclick: () => save(false, true) }, 'บันทึกเป็นธีมใหม่'), h('button.btn', { onclick: () => save(false) }, 'บันทึก'), h('button.btn.primary', { onclick: () => save(true) }, 'บันทึก & ใช้งาน')),
      h('div.studio', null, panel, preview));
    drawPanel(); drawPreview();
  };

  // ---------- media & fonts library ----------
  A.sections.media = async (c) => {
    let kind = 'food';
    const grid = h('div');
    const load = async () => {
      const r = await api.get(`/api/admin/media?kind=${kind}`);
      const rec = r.recommended[kind] || {};
      mount(grid, h('div.row.between', { style: { marginBottom: '12px' } }, h('div.muted', null, rec.w ? `ขนาดแนะนำ ${rec.w}×${rec.h}px • ` : '', kind === 'font' ? 'รองรับ .ttf .otf .woff .woff2' : 'รองรับ JPG, PNG, WebP, SVG (ตรวจสอบความปลอดภัย)', ` • สูงสุด ${r.max_mb} MB`),
        kind === 'font' ? fontUpload(load) : A.uploadButton(kind, load)),
      r.assets.length ? h('div.media-grid', null, r.assets.map((a) => h('div.media-item', null,
        kind === 'font' ? h('div.mi-img', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', fontFamily: `'${a.font_family}'` } }, 'กขค Abc') : h('div.mi-img', { style: { backgroundImage: `url(${a.url})` } }),
        h('div.mi-meta', null, h('div', null, a.font_family || a.original_name || ''), `${a.width ? `${a.width}×${a.height} • ` : ''}${Math.round(a.size / 1024)}KB`, a.warning ? h('div', { style: { color: 'var(--warning)' } }, a.warning) : null,
          h('div.row', { style: { marginTop: '4px' } },
            kind !== 'font' ? replaceBtn(a, load) : null,
            h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/media/${a.id}`, 'ไฟล์นี้ (ระบบจะเอารูปออกจากทุกที่ที่ใช้อยู่)')) load(); } }, 'ลบ')))))) : BF.states.empty('ยังไม่มีไฟล์', '🖼'));
      if (kind === 'font') { const st = document.createElement('style'); st.textContent = r.assets.map((a) => `@font-face{font-family:'${a.font_family}';src:url(${a.url})}`).join(''); grid.appendChild(st); }
    };
    const kinds = A.boot.media_kinds;
    const tabs = h('div.row');
    const drawTabs = () => mount(tabs, Object.entries(kinds).map(([k, v]) => h('button.chip', { class: k === kind ? 'active' : '', onclick: () => { kind = k; drawTabs(); load(); } }, v.label)));
    mount(c, A.head('คลังรูปภาพ & ฟอนต์'),
      h('div.card.section', null, h('h4', null, 'ขนาดรูปที่แนะนำ'), h('div.table-wrap', null, h('table.list', null, h('tbody', null, Object.values(kinds).filter((x) => x.w).map((x) => h('tr', null, h('td', null, x.label), h('td', null, `${x.w} × ${x.h} px`))))))),
      tabs, h('div', { style: { marginTop: '12px' } }, grid));
    drawTabs(); await load();
  };
  function fontUpload(onDone) {
    const fam = h('input', { placeholder: 'ชื่อฟอนต์ (Font family)', style: { width: '200px' } });
    const input = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', style: { display: 'none' }, onchange: async () => { const f = input.files[0]; input.value = ''; if (!f) return; try { await A.upload('font', f, f.name, fam.value ? { font_family: fam.value } : {}); onDone(); } catch (e) { BF.error(e); } } });
    return h('div.row', null, fam, input, h('button.btn.primary.sm', { onclick: () => input.click() }, '⬆ อัปโหลดฟอนต์'));
  }
  function replaceBtn(a, onDone) {
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/svg+xml', style: { display: 'none' }, onchange: async () => {
      const f = input.files[0]; input.value = ''; if (!f) return;
      const send = async (blob, name) => { const fd = new FormData(); fd.append('file', blob, name); try { await api.put(`/api/admin/media/${a.id}`, fd); BF.toast('แทนที่รูปแล้ว', 'success'); onDone(); } catch (e) { BF.error(e); } };
      if (f.type === 'image/svg+xml') send(f, f.name); else A.cropper(a.kind, f, send);
    } });
    return h('span', null, input, h('button.btn.sm', { onclick: () => input.click() }, 'แทนที่'));
  }
})();
