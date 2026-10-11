// Admin: floor plan editor — zones, drag & drop tables, resize, shapes, seats.
(function () {
  'use strict';
  const { h, mount, api } = { ...BF, api: BF.api };
  const A = window.ADMIN;
  const SNAP = 10;
  const snap = (v) => Math.round(v / SNAP) * SNAP;

  A.sections.floor = async (c) => {
    const data = await api.get('/api/admin/floor');
    const st = { zones: data.zones, tables: data.tables.map((t) => ({ ...t })), zone: data.zones[0] ? data.zones[0].id : null, sel: null, dirty: false };
    const canvas = h('div.fe-canvas');
    const side = h('div.card.form');
    const saveBtn = h('button.btn.primary', { onclick: saveLayout }, 'บันทึกผัง');

    function zoneTables() { return st.tables.filter((t) => (st.zone ? t.zone_id === st.zone : !t.zone_id)); }
    function drawCanvas() {
      const z = st.zones.find((x) => x.id === st.zone) || { width: 1000, height: 600 };
      canvas.style.width = `${z.width}px`; canvas.style.height = `${z.height}px`;
      mount(canvas, zoneTables().map((t) => {
        const el = h(`div.fe-t.${t.shape}`, { class: st.sel === t.id ? 'sel' : '', style: { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px`, transform: t.rotation ? `rotate(${t.rotation}deg)` : '' } }, t.code, h('small', null, `${t.seats} ที่นั่ง`), t.status === 'disabled' ? h('small', null, 'ปิดใช้งาน') : null);
        const rs = h('div.fe-rs');
        el.appendChild(rs);
        el.onpointerdown = (e) => {
          e.preventDefault(); st.sel = t.id; drawSide();
          canvas.querySelectorAll('.fe-t').forEach((x) => x.classList.remove('sel')); el.classList.add('sel');
          const resize = e.target === rs;
          const start = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, tw: t.w, th: t.h };
          el.setPointerCapture(e.pointerId);
          el.onpointermove = (ev) => {
            const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
            if (resize) { t.w = Math.max(40, snap(start.tw + dx)); t.h = Math.max(40, snap(start.th + dy)); if (t.shape === 'round') t.h = t.w; el.style.width = `${t.w}px`; el.style.height = `${t.h}px`; }
            else { t.x = Math.max(0, snap(start.tx + dx)); t.y = Math.max(0, snap(start.ty + dy)); el.style.left = `${t.x}px`; el.style.top = `${t.y}px`; }
            st.dirty = true; saveBtn.textContent = 'บันทึกผัง •';
          };
          el.onpointerup = () => { el.onpointermove = null; drawSide(); };
        };
        return el;
      }));
    }
    function drawSide() {
      const t = st.tables.find((x) => x.id === st.sel);
      if (!t) return mount(side, h('h4', null, 'เลือกโต๊ะเพื่อแก้ไข'), h('p.muted.small', null, 'ลากเพื่อย้ายตำแหน่ง • ลากมุมขวาล่างเพื่อปรับขนาด • ตำแหน่งจะถูกจัดให้ตรงตาราง 10px'));
      const f = A.form([{ key: 'code', label: 'หมายเลขโต๊ะ' }, { key: 'seats', label: 'จำนวนที่นั่ง', type: 'number' }, { key: 'shape', label: 'รูปทรง', type: 'select', options: [['square', 'สี่เหลี่ยมจัตุรัส'], ['rect', 'สี่เหลี่ยมผืนผ้า'], ['round', 'โต๊ะกลม']] },
        { key: 'zone_id', label: 'โซน / ห้อง', type: 'select', number: true, options: [['', '—'], ...st.zones.map((z) => [z.id, z.name])] }, { key: 'w', label: 'กว้าง', type: 'number' }, { key: 'h', label: 'สูง', type: 'number' }, { key: 'rotation', label: 'หมุน (องศา)', type: 'number' }], t);
      mount(side, h('h4', null, `โต๊ะ ${t.code}`), f.el,
        h('div.row', null, h('button.btn.primary.sm', { onclick: async () => { try { const v = f.values(); await api.put(`/api/admin/tables/${t.id}`, { ...t, ...v }); Object.assign(t, v); BF.toast('บันทึกโต๊ะแล้ว', 'success'); drawCanvas(); } catch (e) { BF.error(e); } } }, 'บันทึกโต๊ะ'),
          h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/tables/${t.id}`, `โต๊ะ ${t.code}`)) A.refresh(); } }, 'ลบโต๊ะ')));
    }
    async function saveLayout() {
      try { await api.put('/api/admin/tables/layout', { tables: st.tables.map(({ id, x, y, w, h: hh, rotation, zone_id }) => ({ id, x, y, w, h: hh, rotation, zone_id })) }); st.dirty = false; saveBtn.textContent = 'บันทึกผัง'; BF.toast('บันทึกผังแล้ว', 'success'); } catch (e) { BF.error(e); }
    }
    function addTable() {
      A.editor('เพิ่มโต๊ะ', [{ key: 'code', label: 'หมายเลขโต๊ะ (เช่น 7, T07, V.22)' }, { key: 'seats', label: 'จำนวนที่นั่ง', type: 'number' }, { key: 'shape', label: 'รูปทรง', type: 'select', options: [['square', 'สี่เหลี่ยม'], ['rect', 'ผืนผ้า'], ['round', 'กลม']] }, { key: 'count', label: 'จำนวนโต๊ะที่จะสร้าง (เลขต่อเนื่อง)', type: 'number' }],
        { seats: 4, shape: 'square', count: 1 }, async (v) => {
          const n = Math.max(1, Math.min(50, v.count || 1));
          const m = /^(.*?)(\d+)$/.exec(v.code);
          for (let i = 0; i < n; i++) {
            const code = n > 1 && m ? `${m[1]}${Number(m[2]) + i}` : v.code;
            await api.post('/api/admin/tables', { code, seats: v.seats, shape: v.shape, zone_id: st.zone, x: 20 + (i % 6) * 130, y: 20 + Math.floor(i / 6) * 130, w: v.shape === 'rect' ? 150 : 100, h: 100 });
          }
          A.refresh();
        }, { wide: false });
    }
    function zoneEditor(z) {
      A.editor(z ? 'แก้ไขโซน' : 'เพิ่มโซน / ห้อง', [{ key: 'name', label: 'ชื่อโซน' }, { key: 'kind', label: 'ประเภท', type: 'select', options: [['normal', 'ทั่วไป'], ['vip', 'ห้อง VIP'], ['outdoor', 'กลางแจ้ง']] }, { key: 'width', label: 'ความกว้างผัง (px)', type: 'number' }, { key: 'height', label: 'ความสูงผัง (px)', type: 'number' }, { key: 'sort', label: 'ลำดับ', type: 'number' }],
        z || { kind: 'normal', width: 1000, height: 600 }, async (v) => { if (z) await api.put(`/api/admin/zones/${z.id}`, v); else await api.post('/api/admin/zones', v); A.refresh(); }, { wide: false });
    }
    const zoneBar = h('div.row');
    const drawZones = () => mount(zoneBar, st.zones.map((z) => h('button.chip', { class: st.zone === z.id ? 'active' : '', onclick: () => { st.zone = z.id; st.sel = null; drawZones(); drawCanvas(); drawSide(); }, ondblclick: () => zoneEditor(z) }, `${z.name}${z.kind === 'vip' ? ' ⭐' : ''}`)),
      st.tables.some((t) => !t.zone_id) ? h('button.chip', { class: st.zone === null ? 'active' : '', onclick: () => { st.zone = null; drawZones(); drawCanvas(); } }, 'ไม่ระบุโซน') : null,
      h('button.btn.sm', { onclick: () => zoneEditor() }, '+ โซน'), st.zone ? h('button.btn.sm.ghost', { onclick: () => zoneEditor(st.zones.find((z) => z.id === st.zone)) }, 'แก้ไขโซน') : null,
      st.zone ? h('button.btn.sm.ghost', { onclick: async () => { if (await A.del(`/api/admin/zones/${st.zone}`, 'โซน')) A.refresh(); } }, 'ลบโซน') : null);
    mount(c, A.head('ผังร้าน & โต๊ะ', h('button.btn', { onclick: addTable }, '+ เพิ่มโต๊ะ'), saveBtn), zoneBar,
      h('div.fe', { style: { marginTop: '12px' } }, h('div.fe-canvas-wrap', null, canvas), side));
    drawZones(); drawCanvas(); drawSide();
  };
})();
