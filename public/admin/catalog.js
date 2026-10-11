// Admin: packages, menu, categories, stations, call buttons, payment methods, members, tiers, promotions, staff, roles.
(function () {
  'use strict';
  const { h, mount, api, tr, money, baht } = { ...BF, api: BF.api };
  const A = window.ADMIN;
  const DAYS = [[0, 'อา'], [1, 'จ'], [2, 'อ'], [3, 'พ'], [4, 'พฤ'], [5, 'ศ'], [6, 'ส']];

  // ---------- packages ----------
  A.sections.packages = async (c) => {
    const { packages } = await api.get('/api/admin/packages');
    mount(c, A.head('แพ็กเกจบุฟเฟต์', h('button.btn.primary', { onclick: () => pkgEditor() }, '+ เพิ่มแพ็กเกจ')),
      A.table([
        ['', (p) => h('span', { style: { display: 'inline-block', width: '14px', height: '14px', borderRadius: '4px', background: p.color } })],
        ['รหัส', (p) => p.code], ['ชื่อ', (p) => tr(p.name)], ['เวลา', (p) => `${p.duration_min} นาที`],
        ['ราคา', (p) => p.prices.map((x) => `${tr(x.label)} ${baht(x.price)}`).join(' • ')], ['เมนู', (p) => `${p.menu_count} รายการ`],
        ['ขาย', (p) => `${p.service_start || '—'}-${p.service_end || '—'} ${p.days.length === 7 ? 'ทุกวัน' : p.days.map((d) => DAYS[d][1]).join(',')}`],
        ['สถานะ', (p) => A.active(p.active)],
        ['', (p) => h('div.row', null, h('button.btn.sm', { onclick: () => pkgEditor(p) }, 'แก้ไข'), h('button.btn.sm', { onclick: () => pkgMenu(p) }, 'เมนูในแพ็กเกจ'), h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/packages/${p.id}`, p.code)) A.refresh(); } }, 'ลบ'))],
      ], packages, { empty: 'ยังไม่มีแพ็กเกจ' }));
  };
  function pricesEditor(prices) {
    const rows = (prices.length ? prices : [{ code: 'adult', label: { th: 'ผู้ใหญ่', en: 'Adult', zh: '成人' }, rule_type: 'none', price: 0, is_default: 1 }]).map((p) => ({ ...p }));
    const box = h('div'); const errs = h('div.err-list');
    const draw = () => mount(box, h('div.table-wrap', null, h('table.list.prices-table', null,
      h('thead', null, h('tr', null, ['รหัส', 'ชื่อ (ไทย)', 'ชื่อ (EN)', 'เงื่อนไข', 'ต่ำสุด', 'สูงสุด', 'ราคา (บาท)', 'Priority', 'ค่าเริ่มต้น', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((p, i) => h('tr', null,
        h('td', null, h('input', { value: p.code, style: { width: '90px' }, oninput: (e) => { p.code = e.target.value; } })),
        h('td', null, h('input', { value: tr(p.label, 'th'), oninput: (e) => { p.label = { ...(p.label || {}), th: e.target.value }; } })),
        h('td', null, h('input', { value: (p.label || {}).en || '', oninput: (e) => { p.label = { ...(p.label || {}), en: e.target.value }; } })),
        h('td', null, h('select', { onchange: (e) => { p.rule_type = e.target.value; } }, [['none', 'ไม่กำหนด'], ['age', 'อายุ (ปี)'], ['height', 'ส่วนสูง (ซม.)']].map(([v, l]) => h('option', { value: v, selected: p.rule_type === v }, l)))),
        h('td', null, h('input', { type: 'number', value: p.min_value ?? '', style: { width: '70px' }, oninput: (e) => { p.min_value = e.target.value === '' ? null : Number(e.target.value); } })),
        h('td', null, h('input', { type: 'number', value: p.max_value ?? '', style: { width: '70px' }, oninput: (e) => { p.max_value = e.target.value === '' ? null : Number(e.target.value); } })),
        h('td', null, h('input', { type: 'number', step: '0.01', value: (p.price / 100).toFixed(2), style: { width: '100px' }, oninput: (e) => { p.price = Math.round(Number(e.target.value || 0) * 100); } })),
        h('td', null, h('input', { type: 'number', value: p.priority || 0, style: { width: '60px' }, oninput: (e) => { p.priority = Number(e.target.value) || 0; } })),
        h('td', null, h('input', { type: 'radio', name: 'pdef', checked: !!p.is_default, onchange: () => { rows.forEach((x) => { x.is_default = x === p; }); } })),
        h('td', null, h('button.btn.sm.ghost', { type: 'button', onclick: () => { rows.splice(i, 1); draw(); } }, '✕'))))))),
      h('button.btn.sm', { type: 'button', onclick: () => { rows.push({ code: '', label: {}, rule_type: 'age', price: 0 }); draw(); } }, '+ เพิ่มประเภทราคา'),
      h('button.btn.sm.ghost', { type: 'button', onclick: async () => { const r = await api.post('/api/admin/packages/validate-prices', { prices: rows }); mount(errs, r.errors.length ? r.errors.map((x) => h('div', null, '• ' + x)) : h('div', { style: { color: 'var(--success)' } }, '✔ ไม่พบช่วงทับซ้อน')); } }, 'ตรวจสอบช่วงทับซ้อน'), errs);
    draw();
    return { el: h('div', null, h('h4', null, 'ราคาตามประเภทลูกค้า (อายุ / ส่วนสูง)'), h('p.muted.small', null, 'ระบบป้องกันช่วงทับซ้อน • ถ้าต้องการให้ช่วงซ้อนกัน ให้ตั้ง Priority ต่างกัน (ค่ามากชนะ) • ราคา 0 = ฟรี'), box), get: () => rows };
  }
  function pkgEditor(p) {
    const prices = pricesEditor(p ? p.prices : []);
    A.editor(p ? `แก้ไขแพ็กเกจ ${p.code}` : 'เพิ่มแพ็กเกจ', [
      { key: 'code', label: 'รหัสแพ็กเกจ' }, { key: 'name', label: 'ชื่อแพ็กเกจ', type: 'i18n' }, { key: 'description', label: 'คำอธิบาย', type: 'i18n-text' },
      { key: 'color', label: 'สีประจำแพ็กเกจ', type: 'color' }, { key: 'cover_asset_id', label: 'ภาพปก', type: 'media', kind: 'package' },
      { key: 'duration_min', label: 'ระยะเวลารับประทาน (นาที)', type: 'number' }, { key: 'order_cutoff_min', label: 'ปิดรับออเดอร์ก่อนหมดเวลา (นาที)', type: 'number' },
      { key: 'service_start', label: 'เริ่มจำหน่าย', type: 'time' }, { key: 'service_end', label: 'สิ้นสุดจำหน่าย', type: 'time' },
      { key: 'days', label: 'วันที่จำหน่าย', type: 'multi', options: DAYS, number: true },
      { key: 'max_per_round', label: 'จำนวนสูงสุดต่อรอบการสั่ง (0 = ไม่จำกัด)', type: 'number' }, { key: 'round_per_guest', label: 'คูณจำนวนต่อรอบตามจำนวนลูกค้า', type: 'check', default: true },
      { key: 'round_interval_min', label: 'ระยะห่างระหว่างรอบ (นาที)', type: 'number' }, { key: 'max_per_item_per_guest', label: 'สั่งได้ต่อรายการต่อคน (0 = ไม่จำกัด)', type: 'number' },
      { key: 'ot_block', label: 'ค่าปรับเกินเวลา: ทุก ๆ (นาที)', type: 'number' }, { key: 'ot_amount', label: 'ค่าปรับต่อคนต่อช่วง', type: 'money' },
      { key: 'leftover_text', label: 'เงื่อนไขอาหารเหลือ', type: 'i18n-text' },
      { key: 'service_charge_enabled', label: 'คิด Service Charge', type: 'check', default: true }, { key: 'active', label: 'เปิดขาย', type: 'check', default: true }, { key: 'sort', label: 'ลำดับ', type: 'number' },
      ...(p ? [] : [{ key: 'branch_scope', label: 'ใช้กับ', type: 'select', options: [['all', 'ทุกสาขา'], ['branch', 'เฉพาะสาขานี้']] }]),
    ], p ? { ...p, ot_block: p.overtime_fee.block_min, ot_amount: p.overtime_fee.amount_per_guest, leftover_text: (p.leftover_policy || {}).text } : { color: '#0b2a6f', duration_min: 120, days: [0, 1, 2, 3, 4, 5, 6], active: true }, async (v) => {
      const body = { ...v, prices: prices.get(), overtime_fee: { block_min: v.ot_block, amount_per_guest: v.ot_amount }, leftover_policy: { text: v.leftover_text } };
      if (p) await api.put(`/api/admin/packages/${p.id}`, body); else await api.post('/api/admin/packages', body);
      A.refresh();
    }, { extra: prices });
  }
  async function pkgMenu(p) {
    const [{ items }, cur, { categories }] = await Promise.all([api.get('/api/admin/menu-items'), api.get(`/api/admin/packages/${p.id}/menu`), api.get('/api/admin/categories')]);
    const sel = new Map(cur.items.map((x) => [x.menu_item_id, x.extra_price]));
    const body = h('div', null, categories.map((cat) => { const its = items.filter((i) => i.category_id === cat.id); return its.length ? h('div', null, h('h4', null, tr(cat.name), ' ', h('button.btn.sm.ghost', { onclick: (e) => { const all = its.every((i) => sel.has(i.id)); its.forEach((i) => (all ? sel.delete(i.id) : sel.set(i.id, sel.get(i.id) ?? null))); e.target.closest('div').querySelectorAll('input[type=checkbox]').forEach((x) => { x.checked = !all; }); } }, 'เลือกทั้งหมด')),
      its.map((i) => h('div.row', null, h('label.check.grow', null, h('input', { type: 'checkbox', checked: sel.has(i.id), onchange: (e) => (e.target.checked ? sel.set(i.id, null) : sel.delete(i.id)) }), tr(i.name), i.status !== 'available' ? h('span.badge', null, i.status) : null),
        h('input', { type: 'number', step: '0.01', placeholder: `ราคาเพิ่ม (ค่าเริ่มต้น ${money(i.extra_price)})`, style: { width: '210px' }, value: sel.get(i.id) != null ? (sel.get(i.id) / 100).toFixed(2) : '', oninput: (e) => { if (sel.has(i.id)) sel.set(i.id, e.target.value === '' ? null : Math.round(Number(e.target.value) * 100)); } })))) : null; }));
    const m = BF.modal(`เมนูใน ${p.code}`, body, { wide: true, actions: [h('button.btn.primary', { onclick: async () => { try { await api.put(`/api/admin/packages/${p.id}/menu`, { items: [...sel].map(([menu_item_id, extra_price]) => ({ menu_item_id, extra_price })) }); BF.toast('บันทึกแล้ว', 'success'); m.close(); A.refresh(); } catch (e) { BF.error(e); } } }, 'บันทึก')] });
  }

  // ---------- categories ----------
  A.sections.categories = async (c) => {
    const { categories } = await api.get('/api/admin/categories');
    const list = h('div.drag-list');
    let dragId = null;
    mount(list, categories.map((cat) => h('div.dl-row', { draggable: 'true', dataset: { id: cat.id },
      ondragstart: () => { dragId = cat.id; }, ondragover: (e) => e.preventDefault(),
      ondrop: async (e) => { e.preventDefault(); const ids = categories.map((x) => x.id); const from = ids.indexOf(dragId), to = ids.indexOf(cat.id); ids.splice(to, 0, ids.splice(from, 1)[0]); try { await api.put('/api/admin/categories-order', { ids }); A.refresh(); } catch (err) { BF.error(err); } } },
    h('span.dl-handle', null, '⋮⋮'), h('b.grow', null, tr(cat.name)), A.active(cat.active), h('button.btn.sm', { onclick: () => catEditor(cat) }, 'แก้ไข'), h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/categories/${cat.id}`, tr(cat.name))) A.refresh(); } }, 'ลบ'))));
    mount(c, A.head('หมวดหมู่เมนู', h('button.btn.primary', { onclick: () => catEditor() }, '+ เพิ่มหมวดหมู่')), h('p.muted', null, 'ลากเพื่อจัดลำดับการแสดงบนหน้าลูกค้า'), categories.length ? list : BF.states.empty('ยังไม่มีหมวดหมู่'));
  };
  function catEditor(cat) {
    A.editor(cat ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่', [{ key: 'name', label: 'ชื่อหมวดหมู่', type: 'i18n' }, { key: 'active', label: 'แสดง', type: 'check', default: true }], cat || { active: true }, async (v) => {
      if (cat) await api.put(`/api/admin/categories/${cat.id}`, { ...v, sort: cat.sort }); else await api.post('/api/admin/categories', v);
      A.refresh();
    }, { wide: false });
  }

  // ---------- menu ----------
  A.sections.menu = async (c) => {
    const [{ items }, { categories }, { packages }, { items: stations }, { printers }] = await Promise.all([api.get('/api/admin/menu-items'), api.get('/api/admin/categories'), api.get('/api/admin/packages'), api.get('/api/admin/stations'), api.get('/api/admin/printers')]);
    const ctx = { categories, packages, stations, printers };
    let q = '', cat = '';
    const listEl = h('div');
    const draw = () => {
      const rows = items.filter((i) => (!cat || i.category_id === Number(cat)) && (!q || `${i.name.th} ${i.name.en} ${i.code || ''}`.toLowerCase().includes(q)));
      mount(listEl, A.table([
        ['', (i) => (i.image ? h('img', { src: i.image, style: { width: '48px', height: '48px', objectFit: 'cover', borderRadius: '8px' } }) : '—')],
        ['ชื่อ', (i) => h('div', null, h('b', null, tr(i.name)), h('div.muted.small', null, i.name.en || ''))],
        ['หมวด', (i) => tr((categories.find((x) => x.id === i.category_id) || {}).name)],
        ['แพ็กเกจ', (i) => i.packages.map((p) => (packages.find((x) => x.id === p.package_id) || {}).code).join(', ')],
        ['ราคาเพิ่ม', (i) => (i.extra_price ? money(i.extra_price) : '—')],
        ['สถานี', (i) => (stations.find((s) => s.id === i.station_id) || {}).name || '—'],
        ['สถานะ', (i) => h('select', { style: { width: 'auto', height: '32px' }, onclick: (e) => e.stopPropagation(), onchange: async (e) => { try { await api.patch(`/api/admin/menu-items/${i.id}/status`, { status: e.target.value }); i.status = e.target.value; BF.toast('อัปเดตสถานะแล้ว', 'success'); } catch (err) { BF.error(err); } } }, [['available', 'พร้อมขาย'], ['out', 'หมดชั่วคราว'], ['stopped', 'หยุดขาย']].map(([v, l]) => h('option', { value: v, selected: i.status === v }, l)))],
        ['', (i) => h('div.row', null, h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); itemEditor(i, ctx); } }, 'แก้ไข'), h('button.btn.sm.ghost', { onclick: async (e) => { e.stopPropagation(); if (await A.del(`/api/admin/menu-items/${i.id}`, tr(i.name))) A.refresh(); } }, 'ลบ'))],
      ], rows, { empty: 'ยังไม่มีเมนู' }));
    };
    mount(c, A.head('เมนูอาหาร', h('button.btn.primary', { onclick: () => itemEditor(null, ctx) }, '+ เพิ่มเมนู')),
      h('div.row', { style: { marginBottom: '12px' } }, h('input', { placeholder: 'ค้นหา', style: { maxWidth: '280px' }, oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } }),
        h('select', { style: { maxWidth: '220px' }, onchange: (e) => { cat = e.target.value; draw(); } }, h('option', { value: '' }, 'ทุกหมวด'), categories.map((x) => h('option', { value: x.id }, tr(x.name))))), listEl);
    draw();
  };
  function optionsEditor(options) {
    const opts = (options || []).map((o) => ({ ...o, choices: o.choices.map((x) => ({ ...x })) }));
    const box = h('div');
    const draw = () => mount(box, opts.map((o, oi) => h('div.opt-block', null,
      h('div.row', null, h('input.grow', { placeholder: 'ชื่อตัวเลือก (ไทย) เช่น ระดับความสุก', value: tr(o.name, 'th'), oninput: (e) => { o.name = { ...(o.name || {}), th: e.target.value }; } }), h('input', { placeholder: 'EN', style: { width: '140px' }, value: (o.name || {}).en || '', oninput: (e) => { o.name = { ...(o.name || {}), en: e.target.value }; } }),
        h('select', { style: { width: '130px' }, onchange: (e) => { o.type = e.target.value; } }, h('option', { value: 'single', selected: o.type !== 'multi' }, 'เลือกได้ 1'), h('option', { value: 'multi', selected: o.type === 'multi' }, 'เลือกได้หลาย')),
        h('label.check', null, h('input', { type: 'checkbox', checked: !!o.required, onchange: (e) => { o.required = e.target.checked; } }), 'บังคับ'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => { opts.splice(oi, 1); draw(); } }, 'ลบ')),
      o.choices.map((ch, ci) => h('div.row', null, h('span.muted', null, '↳'), h('input.grow', { placeholder: 'ตัวเลือก (ไทย)', value: tr(ch.name, 'th'), oninput: (e) => { ch.name = { ...(ch.name || {}), th: e.target.value }; } }), h('input', { placeholder: 'EN', style: { width: '120px' }, value: (ch.name || {}).en || '', oninput: (e) => { ch.name = { ...(ch.name || {}), en: e.target.value }; } }),
        h('input', { type: 'number', step: '0.01', placeholder: '+ราคา', style: { width: '90px' }, value: ch.price ? (ch.price / 100).toFixed(2) : '', oninput: (e) => { ch.price = Math.round(Number(e.target.value || 0) * 100); } }), h('button.btn.sm.ghost', { type: 'button', onclick: () => { o.choices.splice(ci, 1); draw(); } }, '✕'))),
      h('button.btn.sm', { type: 'button', onclick: () => { o.choices.push({ id: `c${Date.now().toString(36)}`, name: {}, price: 0 }); draw(); } }, '+ ตัวเลือกย่อย'))),
      h('button.btn.sm', { type: 'button', onclick: () => { opts.push({ name: {}, type: 'single', required: false, choices: [{ id: 'c1', name: {}, price: 0 }] }); draw(); } }, '+ เพิ่มตัวเลือก (เช่น ซอส, ความสุก, เครื่องเคียง)'));
    draw();
    return { el: h('div', null, h('h4', null, 'ตัวเลือกสินค้า'), box), get: () => opts };
  }
  function itemEditor(i, ctx) {
    const opts = optionsEditor(i ? i.options : []);
    const pkgSel = new Map((i ? i.packages : []).map((p) => [p.package_id, p.extra_price]));
    const pkgBox = h('div.form', null, h('h4', null, 'แพ็กเกจที่มีสิทธิ์สั่ง'), h('div.row', null, ctx.packages.map((p) => h('label.check', null, h('input', { type: 'checkbox', checked: pkgSel.has(p.id), onchange: (e) => (e.target.checked ? pkgSel.set(p.id, null) : pkgSel.delete(p.id)) }), tr(p.name)))));
    const extra = { el: h('div', null, pkgBox, opts.el) };
    A.editor(i ? `แก้ไขเมนู` : 'เพิ่มเมนู', [
      { key: 'name', label: 'ชื่ออาหาร', type: 'i18n' }, { key: 'code', label: 'รหัสเมนู' }, { key: 'description', label: 'คำอธิบาย', type: 'i18n-text' }, { key: 'ingredients', label: 'วัตถุดิบ/ส่วนประกอบ', type: 'i18n-text' },
      { key: 'allergens', label: 'สารก่อภูมิแพ้ (คั่นด้วย ,)' }, { key: 'image_asset_id', label: 'รูปอาหาร', type: 'media', kind: 'food' },
      { key: 'category_id', label: 'หมวดหมู่', type: 'select', number: true, options: [['', '—'], ...ctx.categories.map((x) => [x.id, tr(x.name)])] },
      { key: 'sort', label: 'ลำดับการแสดง', type: 'number' }, { key: 'extra_price', label: 'ราคาเพิ่มเติม (บาท)', type: 'money' }, { key: 'cost', label: 'ต้นทุนต่อจาน (บาท)', type: 'money' },
      { key: 'max_per_order', label: 'สูงสุดต่อครั้ง (0 = ไม่จำกัด)', type: 'number' }, { key: 'max_per_guest', label: 'สูงสุดต่อคน', type: 'number' }, { key: 'max_per_table', label: 'สูงสุดต่อโต๊ะ', type: 'number' },
      { key: 'prep_minutes', label: 'เวลาเตรียมโดยประมาณ (นาที)', type: 'number' },
      { key: 'station_id', label: 'จุดครัวที่รับผิดชอบ', type: 'select', number: true, options: [['', '—'], ...ctx.stations.filter((s) => s.active).map((s) => [s.id, s.name])] },
      { key: 'printer_id', label: 'เครื่องพิมพ์ใบครัว (ว่าง = ตามสถานี/ค่าเริ่มต้น)', type: 'select', number: true, options: [['', '— ตามการตั้งค่า —'], ...ctx.printers.filter((p) => p.active).map((p) => [p.id, p.name])] },
      { key: 'status', label: 'สถานะ', type: 'select', options: [['available', 'พร้อมขาย'], ['out', 'หมดชั่วคราว'], ['stopped', 'หยุดขาย']] },
      { key: 'available_from', label: 'สั่งได้ตั้งแต่', type: 'time' }, { key: 'available_to', label: 'สั่งได้ถึง', type: 'time' },
      { key: 'tags', label: 'แท็ก', type: 'multi', options: [['special', 'Special'], ['recommended', 'Recommended']] },
    ], i ? { ...i, allergens: i.allergens.join(', ') } : { status: 'available', prep_minutes: 10 }, async (v) => {
      const body = { ...v, allergens: String(v.allergens || '').split(',').map((x) => x.trim()).filter(Boolean), packages: [...pkgSel].map(([package_id, extra_price]) => ({ package_id, extra_price })), options: opts.get() };
      if (i) await api.put(`/api/admin/menu-items/${i.id}`, body); else await api.post('/api/admin/menu-items', body);
      A.refresh();
    }, { extra });
  }

  // ---------- simple resources ----------
  function simple(id, title, url, cols, fields, defaults = {}, toBody = (v) => v, fromRow = (r) => r) {
    A.sections[id] = async (c) => {
      const { items } = await api.get(url);
      const edit = (r) => A.editor(r ? `แก้ไข${title}` : `เพิ่ม${title}`, typeof fields === 'function' ? fields(r) : fields, r ? fromRow(r) : defaults, async (v) => { if (r) await api.put(`${url}/${r.id}`, toBody(v)); else await api.post(url, toBody(v)); A.refresh(); });
      mount(c, A.head(title, h('button.btn.primary', { onclick: () => edit() }, `+ เพิ่ม`)),
        A.table([...cols, ['', (r) => h('div.row', null, h('button.btn.sm', { onclick: () => edit(r) }, 'แก้ไข'), h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`${url}/${r.id}`, title)) A.refresh(); } }, 'ลบ'))]], items));
    };
  }
  // stations (need the printer list)
  A.sections.stations = async (c) => {
    const [{ items }, { printers }] = await Promise.all([api.get('/api/admin/stations'), api.get('/api/admin/printers')]);
    const fields = [{ key: 'code', label: 'รหัส' }, { key: 'name', label: 'ชื่อสถานี (เช่น ครัวร้อน, ครัวเย็น, ซูชิ, บาร์)' }, { key: 'color', label: 'สี', type: 'color' },
      { key: 'printer_id', label: 'เครื่องพิมพ์ใบครัวของสถานี', type: 'select', number: true, options: [['', '— ตามค่าเริ่มต้น —'], ...printers.filter((p) => p.active).map((p) => [p.id, p.name])] }, { key: 'sort', label: 'ลำดับ', type: 'number' }, { key: 'active', label: 'ใช้งาน', type: 'check', default: true }];
    const edit = (r) => A.editor(r ? 'แก้ไขสถานี' : 'เพิ่มสถานี', fields, r || { color: '#334155', active: true }, async (v) => { if (r) await api.put(`/api/admin/stations/${r.id}`, v); else await api.post('/api/admin/stations', v); A.refresh(); }, { wide: false });
    mount(c, A.head('สถานีครัว (KDS)', h('button.btn.primary', { onclick: () => edit() }, '+ เพิ่มสถานี')),
      A.table([['รหัส', (s) => s.code], ['ชื่อ', (s) => h('span', null, h('span', { style: { display: 'inline-block', width: '12px', height: '12px', borderRadius: '3px', background: s.color, marginRight: '6px' } }), s.name)], ['เครื่องพิมพ์', (s) => (printers.find((p) => p.id === s.printer_id) || {}).name || '—'], ['สถานะ', (s) => A.active(s.active)],
        ['', (r) => h('div.row', null, h('button.btn.sm', { onclick: () => edit(r) }, 'แก้ไข'), h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/stations/${r.id}`, r.name)) A.refresh(); } }, 'ลบ'))]], items));
  };
  simple('calltypes', 'ปุ่มเรียกพนักงาน', '/api/admin/call-types',
    [['', (x) => (x.image ? h('img', { src: x.image, style: { width: '32px' } }) : h('span', { style: { fontSize: '24px' } }, x.icon))], ['ชื่อ', (x) => tr(x.name)], ['สี', (x) => h('span', { style: { display: 'inline-block', width: '20px', height: '20px', borderRadius: '6px', background: x.color } })], ['ลำดับ', (x) => x.sort], ['เรียกคิดเงิน', (x) => (x.is_bill ? '✔' : '')], ['สถานะ', (x) => A.active(x.active)]],
    [{ key: 'name', label: 'ชื่อปุ่ม', type: 'i18n' }, { key: 'icon', label: 'ไอคอน (Emoji)' }, { key: 'color', label: 'สี', type: 'color' }, { key: 'image_asset_id', label: 'รูปไอคอน (แทน Emoji)', type: 'media', kind: 'call_icon' }, { key: 'sort', label: 'ลำดับ', type: 'number' }, { key: 'is_bill', label: 'เป็นปุ่มเรียกคิดเงิน', type: 'check' }, { key: 'active', label: 'แสดง', type: 'check', default: true }],
    { icon: '🔔', color: '#0b2a6f', active: true });
  simple('payments', 'ช่องทางชำระเงิน', '/api/admin/payment-methods',
    [['ชื่อ', (x) => x.name], ['ประเภท', (x) => x.type], ['พร้อมเพย์', (x) => (x.config.promptpay_id || '')], ['สาขา', (x) => (x.branch_id ? 'เฉพาะสาขา' : 'ทุกสาขา')], ['สถานะ', (x) => A.active(x.active)]],
    [{ key: 'name', label: 'ชื่อที่แสดง' }, { key: 'code', label: 'รหัส' }, { key: 'type', label: 'ประเภท', type: 'select', options: [['cash', 'เงินสด'], ['promptpay', 'พร้อมเพย์ (สร้าง QR อัตโนมัติ)'], ['transfer', 'โอนเงิน'], ['card', 'บัตรเครดิต/เดบิต'], ['other', 'อื่น ๆ']] }, { key: 'promptpay_id', label: 'หมายเลขพร้อมเพย์ (เบอร์/เลขผู้เสียภาษี)' }, { key: 'sort', label: 'ลำดับ', type: 'number' }, { key: 'active', label: 'ใช้งาน', type: 'check', default: true }],
    { type: 'cash', active: true }, (v) => ({ ...v, config: { promptpay_id: v.promptpay_id } }), (r) => ({ ...r, promptpay_id: r.config.promptpay_id }));
  simple('tiers', 'ระดับสมาชิก', '/api/admin/tiers',
    [['รหัส', (t) => h('span.badge', { style: { background: t.color, color: '#fff' } }, t.code)], ['ชื่อ', (t) => tr(t.name)], ['ยอดสะสมขั้นต่ำ', (t) => baht(t.min_spent)], ['สะสม', (t) => `${t.baht_per_point} บาท = 1 คะแนน`], ['ตัวคูณ', (t) => `×${t.multiplier}`]],
    [{ key: 'code', label: 'รหัส' }, { key: 'name', label: 'ชื่อ Tier', type: 'i18n' }, { key: 'color', label: 'สี', type: 'color' }, { key: 'min_spent', label: 'ยอดใช้จ่ายสะสมเพื่อเลื่อนระดับ', type: 'money' }, { key: 'min_points', label: 'คะแนนสะสมขั้นต่ำ', type: 'number' }, { key: 'baht_per_point', label: 'กี่บาทได้ 1 คะแนน', type: 'number' }, { key: 'multiplier', label: 'ตัวคูณคะแนน', type: 'number', step: '0.05' }, { key: 'image_asset_id', label: 'รูป Tier', type: 'media', kind: 'tier' }, { key: 'benefits', label: 'สิทธิประโยชน์', type: 'i18n-text' }, { key: 'sort', label: 'ลำดับ', type: 'number' }],
    { color: '#b08d57', baht_per_point: 50, multiplier: 1 });

  A.sections.promotions = async (c) => {
    const [{ items }, { packages }, { items: menu }, { items: tiers }] = await Promise.all([api.get('/api/admin/promotions'), api.get('/api/admin/packages'), api.get('/api/admin/menu-items'), api.get('/api/admin/tiers')]);
    const TYPES = { discount_amount: 'ส่วนลดเป็นเงิน', discount_percent: 'ส่วนลด %', free_item: 'อาหารฟรี', package_upgrade: 'อัปเกรดแพ็กเกจ' };
    const fields = [
      { key: 'code', label: 'รหัสโปรโมชั่น (ใช้เป็นโค้ดหน้าร้านได้)' }, { key: 'name', label: 'ชื่อ', type: 'i18n' }, { key: 'description', label: 'รายละเอียด', type: 'i18n-text' }, { key: 'image_asset_id', label: 'รูปโปรโมชั่น', type: 'media', kind: 'promotion' },
      { key: 'type', label: 'ประเภท', type: 'select', options: Object.entries(TYPES) },
      { key: 'value_amount', label: 'มูลค่าส่วนลด (บาท)', type: 'money' }, { key: 'value_percent', label: 'ส่วนลด (%)', type: 'number', step: '0.01' },
      { key: 'menu_item_id', label: 'เมนูที่แจกฟรี', type: 'select', number: true, options: [['', '—'], ...menu.map((m) => [m.id, tr(m.name)])] },
      { key: 'from_package_id', label: 'อัปเกรดจากแพ็กเกจ', type: 'select', number: true, options: [['', '—'], ...packages.map((p) => [p.id, p.code])] }, { key: 'to_package_id', label: 'เป็นแพ็กเกจ', type: 'select', number: true, options: [['', '—'], ...packages.map((p) => [p.id, p.code])] },
      { key: 'points_cost', label: 'ใช้คะแนนแลก', type: 'number' }, { key: 'members_only', label: 'เฉพาะสมาชิก', type: 'check', default: true }, { key: 'min_spend', label: 'ยอดขั้นต่ำ', type: 'money' },
      { key: 'tier_ids', label: 'จำกัดเฉพาะ Tier', type: 'multi', number: true, options: tiers.map((t) => [t.id, tr(t.name)]) }, { key: 'branch_ids', label: 'จำกัดเฉพาะสาขา', type: 'multi', number: true, options: A.boot.branches.map((b) => [b.id, b.code]) },
      { key: 'days', label: 'วันที่ใช้ได้', type: 'multi', number: true, options: DAYS }, { key: 'time_from', label: 'ตั้งแต่เวลา', type: 'time' }, { key: 'time_to', label: 'ถึงเวลา', type: 'time' },
      { key: 'starts', label: 'เริ่มวันที่', type: 'date' }, { key: 'ends', label: 'สิ้นสุดวันที่', type: 'date' },
      { key: 'total_quota', label: 'จำนวนสิทธิ์รวม (0 = ไม่จำกัด)', type: 'number' }, { key: 'per_member_quota', label: 'สิทธิ์ต่อสมาชิก (0 = ไม่จำกัด)', type: 'number' }, { key: 'code_valid_days', label: 'รหัสแลกใช้ได้ (วัน)', type: 'number' },
      { key: 'priority', label: 'ลำดับความสำคัญ (มากก่อน)', type: 'number' }, { key: 'stackable', label: 'ใช้ร่วมกับโปรอื่นได้', type: 'check' }, { key: 'active', label: 'เปิดใช้งาน', type: 'check', default: true },
    ];
    const toDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');
    const edit = (r) => A.editor(r ? 'แก้ไขโปรโมชั่น' : 'เพิ่มโปรโมชั่น', fields, r ? { ...r, value_amount: r.type === 'discount_amount' ? r.value : 0, value_percent: r.type === 'discount_percent' ? r.value / 100 : '', starts: toDate(r.starts_at), ends: toDate(r.ends_at) } : { type: 'discount_amount', members_only: true, active: true, code_valid_days: 30 }, async (v) => {
      const body = { ...v, value: v.type === 'discount_amount' ? v.value_amount : v.type === 'discount_percent' ? Math.round(Number(v.value_percent || 0) * 100) : 0, starts_at: v.starts ? new Date(`${v.starts}T00:00:00`).getTime() : null, ends_at: v.ends ? new Date(`${v.ends}T23:59:59`).getTime() : null };
      if (r) await api.put(`/api/admin/promotions/${r.id}`, body); else await api.post('/api/admin/promotions', body);
      A.refresh();
    });
    mount(c, A.head('โปรโมชั่น & การแลกคะแนน', h('button.btn.primary', { onclick: () => edit() }, '+ เพิ่มโปรโมชั่น')),
      A.table([['รหัส', (p) => h('code', null, p.code)], ['ชื่อ', (p) => tr(p.name)], ['ประเภท', (p) => TYPES[p.type]], ['คะแนน', (p) => p.points_cost], ['ใช้ไป', (p) => `${p.used_count}${p.total_quota ? `/${p.total_quota}` : ''}`], ['เฉพาะสมาชิก', (p) => (p.members_only ? '✔' : '')], ['สถานะ', (p) => A.active(p.active)],
        ['', (r) => h('div.row', null, h('button.btn.sm', { onclick: () => edit(r) }, 'แก้ไข'), h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/promotions/${r.id}`, r.code)) A.refresh(); } }, 'ลบ'))]], items));
  };

  A.sections.members = async (c) => {
    let q = '', page = 0;
    const list = h('div');
    const load = async () => {
      const r = await api.get(`/api/admin/members?q=${encodeURIComponent(q)}&page=${page}`);
      mount(list, h('div.muted', null, `ทั้งหมด ${r.total} คน`), A.table([['รหัส', (m) => m.code], ['ชื่อ', (m) => `${m.first_name || ''} ${m.last_name || ''}`], ['โทร', (m) => m.phone], ['Tier', (m) => (m.tier ? h('span.badge', { style: { background: m.tier.color, color: '#fff' } }, tr(m.tier.name)) : '')], ['คะแนน', (m) => m.points], ['ยอดสะสม', (m) => money(m.total_spent)], ['สถานะ', (m) => A.active(m.active)],
        ['', (m) => h('button.btn.sm', { onclick: () => A.editor('แก้ไขสมาชิก', [{ key: 'phone', label: 'เบอร์โทร' }, { key: 'first_name', label: 'ชื่อ' }, { key: 'last_name', label: 'นามสกุล' }, { key: 'birthday', label: 'วันเกิด', type: 'date' }, { key: 'email', label: 'อีเมล' }, { key: 'active', label: 'ใช้งาน', type: 'check' }], m, async (v) => { await api.put(`/api/admin/members/${m.id}`, v); load(); }, { wide: false }) }, 'แก้ไข')]], r.members),
        h('div.row', { style: { marginTop: '10px' } }, page > 0 ? h('button.btn.sm', { onclick: () => { page--; load(); } }, '‹ ก่อนหน้า') : null, (page + 1) * r.size < r.total ? h('button.btn.sm', { onclick: () => { page++; load(); } }, 'ถัดไป ›') : null));
    };
    mount(c, A.head('สมาชิก', h('a.btn.sm', { href: '/pos/', target: '_blank' }, 'ปรับคะแนน/แลกสิทธิ์ที่ POS › สมาชิก')), h('input', { placeholder: 'ค้นหาเบอร์โทร / รหัส / ชื่อ', style: { maxWidth: '360px', marginBottom: '12px' }, oninput: BF.debounce((e) => { q = e.target.value; page = 0; load(); }, 300) }), list);
    await load();
  };

  // ---------- staff & roles ----------
  A.sections.staff = async (c) => {
    const [{ staff }, { roles }] = await Promise.all([api.get('/api/admin/staff'), api.get('/api/admin/roles')]);
    const fields = (r) => [...(r ? [] : [{ key: 'code', label: 'รหัสพนักงาน' }]), { key: 'name', label: 'ชื่อ' }, { key: 'phone', label: 'เบอร์โทร' }, { key: 'role_id', label: 'บทบาท', type: 'select', number: true, options: roles.map((x) => [x.id, x.name]) },
      { key: 'pin', label: r ? 'PIN ใหม่ (เว้นว่าง = ไม่เปลี่ยน)' : 'PIN (ตัวเลข 4-8 หลัก)', type: 'password' }, { key: 'branch_ids', label: 'สาขาที่เข้าถึงได้ (ไม่เลือก = ทุกสาขา)', type: 'multi', number: true, options: A.boot.branches.map((b) => [b.id, b.code]) }, ...(r ? [{ key: 'active', label: 'ใช้งาน', type: 'check' }] : [])];
    const edit = (r) => A.editor(r ? `แก้ไข ${r.code}` : 'เพิ่มพนักงาน', fields(r), r || { role_id: roles.find((x) => x.code === 'waiter')?.id }, async (v) => { if (!v.pin) delete v.pin; if (r) await api.put(`/api/admin/staff/${r.id}`, v); else await api.post('/api/admin/staff', v); A.refresh(); }, { wide: false });
    mount(c, A.head('พนักงาน', h('button.btn.primary', { onclick: () => edit() }, '+ เพิ่มพนักงาน')),
      A.table([['รหัส', (s) => s.code], ['ชื่อ', (s) => s.name], ['บทบาท', (s) => s.role_name], ['สาขา', (s) => (s.branch_ids.length ? s.branch_ids.map((id) => (A.boot.branches.find((b) => b.id === id) || {}).code).join(', ') : 'ทุกสาขา')], ['เข้าระบบล่าสุด', (s) => (s.last_login_at ? BF.dt(s.last_login_at) : '—')], ['สถานะ', (s) => A.active(s.active)], ['', (s) => h('button.btn.sm', { onclick: () => edit(s) }, 'แก้ไข')]], staff),
      h('p.muted.small', null, 'พนักงานเข้าสู่ระบบด้วยรหัสพนักงาน + PIN (เก็บแบบ bcrypt hash) • ใส่ PIN ผิด 5 ครั้งล็อก 5 นาที • ดูประวัติการทำงานได้ที่ Audit Log'));
  };
  A.sections.roles = async (c) => {
    const { roles } = await api.get('/api/admin/roles');
    const perms = A.boot.permissions;
    const edit = (r) => {
      const set = new Set(r ? r.permissions : []);
      const name = h('input', { value: r ? r.name : '' }); const code = h('input', { value: r ? r.code : '', disabled: !!r });
      const m = BF.modal(r ? `บทบาท ${r.name}` : 'เพิ่มบทบาท (Custom Role)', h('div.form', null, h('div.form-grid', null, h('label', null, 'รหัส', code), h('label', null, 'ชื่อ', name)),
        h('div.perm-grid', null, Object.entries(perms).map(([k, l]) => h('label.check', null, h('input', { type: 'checkbox', checked: set.has(k), onchange: (e) => (e.target.checked ? set.add(k) : set.delete(k)) }), l)))), {
        wide: true, actions: [h('button.btn.primary', { onclick: async () => { try { if (r) await api.put(`/api/admin/roles/${r.id}`, { name: name.value, permissions: [...set] }); else await api.post('/api/admin/roles', { code: code.value, name: name.value, permissions: [...set] }); m.close(); BF.toast('บันทึกแล้ว', 'success'); A.refresh(); } catch (e) { BF.error(e); } } }, 'บันทึก')] });
    };
    mount(c, A.head('บทบาท & สิทธิ์', h('button.btn.primary', { onclick: () => edit() }, '+ Custom Role')),
      A.table([['รหัส', (r) => r.code], ['ชื่อ', (r) => r.name], ['สิทธิ์', (r) => h('span.small', null, `${r.permissions.length} สิทธิ์`)], ['ระบบ', (r) => (r.is_system ? 'ระบบ' : 'กำหนดเอง')],
        ['', (r) => h('div.row', null, r.code !== 'owner' ? h('button.btn.sm', { onclick: () => edit(r) }, 'แก้ไขสิทธิ์') : h('span.muted.small', null, 'ทุกสิทธิ์'), !r.is_system ? h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/roles/${r.id}`, r.name)) A.refresh(); } }, 'ลบ') : null)]], roles));
  };
})();
